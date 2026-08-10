/**
 * Database.watch infrastructure — registration, post-commit firing,
 * schema-change invalidation, and txn-id minting.
 *
 * Watchers are the second consumer of `DeltaExecutor`. Unlike assertions,
 * they run **after** commit (the change log is still alive, the
 * connections have all committed), and handler errors are logged but
 * never roll the commit back.
 */

import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import {
	DeltaExecutor,
	subscriptionFromChangeScope,
	type DeltaExecutorContext,
	type SubscriptionFromChangeScopeContext,
	type ChangeScopeTableInfo,
	type DeltaSubscription,
	type DeltaApplyInput,
} from '../runtime/delta-executor.js';
import type {
	ChangeScope,
	QualifiedName,
	Subscription,
	WatchHandler,
} from '../planner/analysis/change-scope.js';
import type { Database } from './database.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { splitBaseKey } from '../util/qualified-name.js';

const log = createLogger('core:watchers');
const warnLog = log.extend('warn');

/**
 * Database internals the watcher manager needs. Mirrors
 * `AssertionEvaluatorContext` — keeps the manager testable without the
 * full `Database`.
 */
export interface WatcherManagerContext {
	readonly schemaManager: Database['schemaManager'];
	readonly optimizer: Database['optimizer'];

	getChangedBaseTables(): Set<string>;
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][];
	registerCaptureSpec(baseTable: string, spec: { extraColumns: ReadonlySet<number> }): () => void;
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
}

interface ActiveSubscription {
	readonly id: string;
	/** Tables this subscription watches (lowercased `schema.table`). */
	readonly tables: ReadonlySet<string>;
	/** The underlying kernel subscription. Retained so external-change
	 *  invalidation can synthesize a global `apply` directly, bypassing the
	 *  commit change-log dependency. */
	readonly delta: DeltaSubscription;
	/** Removes the subscription from the kernel. */
	disposeFromExecutor(): void;
	/** Disposes capture-spec demand registered for this subscription. */
	captureDisposers: Array<() => void>;
	/** Marks the subscription disposed so further `unsubscribe()` calls are no-ops. */
	disposed: boolean;
}

/**
 * Manages all `Database.watch` subscriptions for a single `Database`.
 */
export class WatcherManager {
	private readonly executor: DeltaExecutor;
	private readonly active = new Map<string, ActiveSubscription>();
	private nextTxnIdCounter = 0;
	private currentTxnId = '';
	private unsubscribeSchemaChanges: (() => void) | null = null;

	constructor(private readonly ctx: WatcherManagerContext) {
		const executorCtx: DeltaExecutorContext = {
			getChangedBaseTables: () => ctx.getChangedBaseTables(),
			getChangedTuples: (base, cols, pk) => ctx.getChangedTuples(base, cols, pk),
			getRowCount: (base) => {
				const [schemaName, tableName] = splitBaseKey(base);
				const table = ctx._findTable(tableName, schemaName);
				return table?.estimatedRows;
			},
			deltaPerRowFallbackRatio: ctx.optimizer.tuning.deltaPerRowFallbackRatio,
		};
		this.executor = new DeltaExecutor(executorCtx);
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			if (event.type === 'table_removed' || event.type === 'table_modified') {
				const fqName = `${event.schemaName}.${event.objectName}`.toLowerCase();
				this.invalidateForTable(fqName);
			}
		});
	}

	/**
	 * Register a watcher. Validates the scope synchronously, registers
	 * capture demand, and produces a `Subscription` handle whose
	 * `unsubscribe()` releases all resources.
	 */
	watch(scope: ChangeScope, handler: WatchHandler): Subscription {
		if (scope.unboundParameters.length > 0) {
			throw new QuereusError(
				`watch: scope has unbound parameters [${scope.unboundParameters.join(', ')}]; call bindParameters(scope, params) first`,
				StatusCode.MISUSE,
			);
		}

		const id = mintSubscriptionId(scope, this.nextNonce());
		const tables = new Set<string>();
		for (const w of scope.watches) {
			tables.add(`${w.table.schema}.${w.table.table}`.toLowerCase());
		}

		const helperCtx: SubscriptionFromChangeScopeContext = {
			resolveTable: (qname: QualifiedName): ChangeScopeTableInfo | undefined => {
				const table = this.ctx._findTable(qname.table, qname.schema);
				if (!table) return undefined;
				return {
					columnIndexMap: table.columnIndexMap,
					pkIndices: table.primaryKeyDefinition.map(d => d.index),
				};
			},
			registerCaptureSpec: (base, spec) => this.ctx.registerCaptureSpec(base, spec),
			getCurrentTxnId: () => this.currentTxnId,
		};

		const { subscription, captureDisposers } = subscriptionFromChangeScope(scope, handler, id, helperCtx);
		const disposeFromExecutor = this.executor.register(subscription);

		const entry: ActiveSubscription = {
			id,
			tables,
			delta: subscription,
			disposeFromExecutor,
			captureDisposers,
			disposed: false,
		};
		this.active.set(id, entry);

		const isDead = scope.watches.length === 0
			&& scope.nonDeterministicSources.length === 0;
		if (isDead) {
			warnLog('Registered dead subscription %s (no watches and no non-deterministic sources)', id);
		}

		return {
			id,
			unsubscribe: () => this.disposeActive(entry),
		};
	}

	/** Fire all subscriptions impacted by the current commit. Errors from
	 *  any single subscription's apply are logged and swallowed.
	 *
	 *  Must be called by the TransactionManager after a successful commit
	 *  but before the change log is cleared. */
	async runPostCommit(): Promise<void> {
		if (this.active.size === 0) return;
		this.currentTxnId = this.mintTxnId();
		try {
			await this.executor.runAll();
		} catch (err) {
			// subscriptionFromChangeScope swallows handler errors; this catch
			// is defensive — if the kernel itself throws (e.g. a missing PK
			// triggers a fallback log), don't propagate into the commit path.
			log('Post-commit watcher run threw: %O', err);
		} finally {
			this.currentTxnId = '';
		}
	}

	/**
	 * Fire every active subscription whose scope includes `fqName` (lowercased
	 * `schema.table`), treating the whole table as changed, WITHOUT a local
	 * commit. For hosts whose tables are backed by an external/replicated store
	 * (e.g. the optimystic vtab) that learns of remote writes out-of-band.
	 *
	 * Coarse by design: for each matching subscription, every relation that maps
	 * to `fqName` is flagged for global re-evaluation with empty per-relation
	 * tuples, reusing the same `apply` logic the post-commit path drives. A
	 * `full` watch fires with empty hits; a `rows`/`rowsByGroup` watch surfaces
	 * all its registered literal values as possibly-changed; `groups` fires with
	 * empty hits. No-op when no subscription matches. Per-subscription `apply`
	 * errors are logged and swallowed — same contract as {@link runPostCommit}.
	 */
	async notifyExternalTableChange(fqName: string): Promise<void> {
		if (this.active.size === 0) return;

		// Snapshot the matching subscriptions before firing: a handler that
		// (un)subscribes a peer must not perturb this pass.
		const matching = this.subscriptionsForTable(fqName);
		if (matching.length === 0) return;

		this.currentTxnId = this.mintTxnId();
		try {
			for (const entry of matching) {
				if (entry.disposed) continue;

				const globalRelations = new Set<string>();
				for (const [relKey, base] of entry.delta.relationToBase) {
					if (base === fqName) globalRelations.add(relKey);
				}
				if (globalRelations.size === 0) continue;

				const input: DeltaApplyInput = {
					perRelationTuples: new Map(),
					globalRelations,
				};
				try {
					await entry.delta.apply(input);
				} catch (err) {
					// Mirror runPostCommit: a single subscription's apply must never
					// reject into the external caller.
					log('External-change apply for %s threw: %O', entry.id, err);
				}
			}
		} finally {
			this.currentTxnId = '';
		}
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		for (const entry of [...this.active.values()]) {
			this.disposeActive(entry);
		}
		this.executor.disposeAll();
	}

	private disposeActive(entry: ActiveSubscription): void {
		if (entry.disposed) return;
		entry.disposed = true;
		this.active.delete(entry.id);
		entry.disposeFromExecutor();
		for (const d of entry.captureDisposers) {
			try { d(); } catch (err) { log('Capture-spec disposer for %s threw: %O', entry.id, err); }
		}
		entry.captureDisposers.length = 0;
	}

	/** Snapshot of every active subscription whose scope includes `fqName`
	 *  (lowercased `schema.table`). Snapshotting decouples the caller's
	 *  iteration from mutations a handler/disposer may make to `active`. */
	private subscriptionsForTable(fqName: string): ActiveSubscription[] {
		const out: ActiveSubscription[] = [];
		for (const entry of this.active.values()) {
			if (entry.tables.has(fqName)) out.push(entry);
		}
		return out;
	}

	private invalidateForTable(fqName: string): void {
		const toDispose = this.subscriptionsForTable(fqName);
		for (const entry of toDispose) {
			warnLog('Invalidating subscription %s due to schema change on %s', entry.id, fqName);
			this.disposeActive(entry);
		}
	}

	private mintTxnId(): string {
		this.nextTxnIdCounter += 1;
		return `txn:${this.nextTxnIdCounter}`;
	}

	private nextNonce(): string {
		// Plain Math.random is fine here — we only need uniqueness within a
		// process, not crypto-grade entropy.
		return Math.random().toString(36).slice(2, 10);
	}
}

/**
 * Hash a scope into a stable id. The id mixes a canonical serialization
 * of the watch shape (so two subscriptions for the same scope hash to
 * the same prefix) with a random nonce (so the id is unique per
 * registration). Format: `watch:<base32-hash>:<nonce>`.
 */
function mintSubscriptionId(scope: ChangeScope, nonce: string): string {
	const canonical = canonicalizeScope(scope);
	const hash = djb2Base32(canonical);
	return `watch:${hash}:${nonce}`;
}

function canonicalizeScope(scope: ChangeScope): string {
	const parts: string[] = [];
	for (const w of scope.watches) {
		parts.push(`${w.table.schema}.${w.table.table}`);
		parts.push(w.columns === 'all' ? '*' : [...w.columns].sort().join(','));
		parts.push(JSON.stringify(w.scope));
	}
	for (const n of scope.nonDeterministicSources) parts.push(JSON.stringify(n));
	for (const p of scope.unboundParameters) parts.push(String(p));
	return parts.join('|');
}

/** djb2 hash → 6 base32 chars. Fast, no crypto guarantees needed. */
function djb2Base32(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	const u = h >>> 0;
	const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
	let out = '';
	let n = u;
	for (let i = 0; i < 6; i++) {
		out = alphabet[n & 31] + out;
		n = n >>> 5;
	}
	return out;
}
