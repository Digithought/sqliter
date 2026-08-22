/**
 * Auto-analyze staleness bookkeeping.
 *
 * Tracks, per base table, how many distinct rows committed transactions have
 * changed since statistics were last collected for that table, and decides when
 * that drift is large enough to call the table's statistics stale.
 *
 * This module deliberately performs **no statistics collection** — crossing the
 * threshold only writes a debug log line. Turning that signal into a background
 * refresh is the job of the scheduled-refresh work that builds on this file.
 *
 * The counts come from the transaction change log (`TransactionManager`), read
 * post-commit while the log is still alive. That log is maintained
 * unconditionally on every write path already, so counting costs one `Map.size`
 * read per table per savepoint layer and nothing on the write path itself.
 */

import { createLogger } from '../common/logger.js';
import { catalogRowCount } from '../planner/stats/table-cardinality.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { splitBaseKey } from '../util/qualified-name.js';
import type { Database } from './database.js';

const log = createLogger('core:auto-analyze');
const debugLog = log.extend('debug');

/**
 * Database internals the auto-analyze manager needs. Mirrors
 * `WatcherManagerContext` — keeps the manager constructible without the full
 * `Database`.
 */
export interface AutoAnalyzeManagerContext {
	readonly schemaManager: Database['schemaManager'];
	readonly options: Database['options'];

	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
}

/** Per-table staleness bookkeeping. Keyed by lowercased `schema.table`. */
export interface TableStalenessEntry {
	/** Distinct rows changed by committed transactions since the last successful
	 *  statistics refresh. */
	changedSinceAnalyze: number;
	/** rowCount recorded by the last refresh this process observed; undefined = never. */
	analyzedRowCount: number | undefined;
	/** True once this crossing has been logged; cleared when the counter resets. */
	staleLogged: boolean;
}

/**
 * The staleness threshold in changed rows:
 *
 * ```
 * stale  ⟺  changedSinceAnalyze >= max(minMutations, ratio × knownRowCount)
 * ```
 *
 * `knownRowCount` is 0 for a never-analyzed table (`SchemaManager` hardcodes
 * `estimatedRows` to 0 at create), so the absolute floor governs exactly the
 * case that matters most: bulk-loading rows into a fresh table trips
 * `minMutations` long before any percentage of zero could.
 *
 * Precedent for the defaults: SQL Server's auto-update-stats uses 500 + 20% of
 * rows; PostgreSQL's autoanalyze uses 50 + 10%.
 */
export function stalenessThreshold(minMutations: number, ratio: number, knownRowCount: number): number {
	return Math.max(minMutations, ratio * knownRowCount);
}

/** Pure form of the staleness predicate — see {@link stalenessThreshold}. */
export function isStaleCount(
	changedSinceAnalyze: number,
	minMutations: number,
	ratio: number,
	knownRowCount: number,
): boolean {
	return changedSinceAnalyze >= stalenessThreshold(minMutations, ratio, knownRowCount);
}

/**
 * Tracks committed-mutation drift per base table for a single `Database`.
 */
export class AutoAnalyzeManager {
	/**
	 * Lowercased `schema.table` → staleness bookkeeping. Same key convention the
	 * change log uses, so no re-derivation and no second key convention.
	 *
	 * NOTE: nothing here is persisted. After a restart the store backend's saved
	 * statistics still exist, but staleness accumulation restarts from zero — a
	 * table that drifted while the process was down looks fresh until it drifts
	 * again. Accepted for v1 (a restart is rare relative to the mutation
	 * threshold). If it ever matters, persist `changedSinceAnalyze` beside the
	 * table's statistics entry and reload it when the catalog loads.
	 */
	private readonly entries = new Map<string, TableStalenessEntry>();
	private unsubscribeSchemaChanges: (() => void) | null = null;

	constructor(private readonly ctx: AutoAnalyzeManagerContext) {
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			// Only `table_removed`, so a table re-created under a dropped name starts
			// clean. Deliberately NOT `table_modified`: a statistics refresh fires that
			// event itself (runtime/emit/analyze.ts), so reacting to it would couple
			// this manager to its own future output.
			//
			// NOTE: `DETACH` removes a whole schema WITHOUT firing per-table events
			// (`SchemaManager.removeSchema`), so entries for a detached schema's tables
			// outlive it. Harmless today — each is three numbers, and
			// `knownRowCountOrDrop` evicts one the next time it is consulted — but if a
			// host ever attaches and detaches schemas in a loop, drop entries whose
			// schema segment matches the detached name.
			if (event.type === 'table_removed') {
				const key = `${event.schemaName}.${event.objectName}`.toLowerCase();
				this.entries.delete(key);
			}
		});
	}

	/**
	 * Fold one committed transaction's per-table changed-row counts into the
	 * staleness map and re-evaluate the threshold for every table it touched.
	 * Entries are created lazily on first touch.
	 */
	recordCommit(counts: Map<string, number>): void {
		for (const [key, count] of counts) {
			if (count <= 0) continue;
			let entry = this.entries.get(key);
			if (!entry) {
				entry = { changedSinceAnalyze: 0, analyzedRowCount: undefined, staleLogged: false };
				this.entries.set(key, entry);
			}
			entry.changedSinceAnalyze += count;
			this.evaluate(key, entry);
		}
	}

	/**
	 * Whether the named table (lowercased `schema.table`) has drifted past the
	 * threshold. Not a pure predicate: a table that has since disappeared answers
	 * `false` and has its entry dropped — see {@link knownRowCountOrDrop}.
	 */
	isStale(key: string): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;
		const known = this.knownRowCountOrDrop(key, entry);
		if (known === undefined) return false;
		return isStaleCount(entry.changedSinceAnalyze, this.minMutations(), this.ratio(), known);
	}

	/** @internal Current bookkeeping for a table; `undefined` when untracked. */
	getEntry(key: string): Readonly<TableStalenessEntry> | undefined {
		return this.entries.get(key);
	}

	/** @internal Every table currently tracked (lowercased `schema.table`). */
	trackedTables(): string[] {
		return [...this.entries.keys()];
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		this.entries.clear();
	}

	/**
	 * Row count the ratio arm of the threshold applies to: what the last refresh
	 * this process observed reported, else whatever the catalog knows.
	 *
	 * Named for its side effect: a table that is gone (dropped between the commit
	 * and this lookup, or carried in from a detached schema) answers `undefined`
	 * AND has its entry evicted here, so every consumer of a row count doubles as
	 * the eviction path for stale keys. That is why {@link isStale} mutates.
	 */
	private knownRowCountOrDrop(key: string, entry: TableStalenessEntry): number | undefined {
		if (entry.analyzedRowCount !== undefined) return entry.analyzedRowCount;
		const [schemaName, tableName] = splitBaseKey(key);
		const table = this.ctx._findTable(tableName, schemaName);
		if (!table) {
			this.entries.delete(key);
			return undefined;
		}
		return catalogRowCount(table) ?? 0;
	}

	/** Log the first crossing of the threshold; a busy table must not flood the log. */
	private evaluate(key: string, entry: TableStalenessEntry): void {
		if (entry.staleLogged) return;
		const known = this.knownRowCountOrDrop(key, entry);
		if (known === undefined) return;
		const threshold = stalenessThreshold(this.minMutations(), this.ratio(), known);
		if (entry.changedSinceAnalyze < threshold) return;
		entry.staleLogged = true;
		debugLog(
			'Statistics for %s are stale: %d rows changed since last analyze (threshold %d over %d known rows)',
			key, entry.changedSinceAnalyze, threshold, known,
		);
	}

	private minMutations(): number {
		return this.ctx.options.getNumberOption('auto_analyze_min_mutations');
	}

	private ratio(): number {
		return this.ctx.options.getNumberOption('auto_analyze_ratio');
	}
}
