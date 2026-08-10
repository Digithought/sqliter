import type { Row, SqlValue, OutputValue } from '../common/types.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import type { RuntimeContext } from './types.js';
import type { Database } from '../core/database.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createRowSlot } from './context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from './strict-fork.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { composeCombinedDescriptor } from './descriptor-helpers.js';
import { isTruthy } from '../util/comparison.js';

export interface DeferredConstraintRow {
	row: Row;
	descriptor: RowDescriptor;
	evaluator: (ctx: RuntimeContext) => OutputValue;
	constraintName: string;
	connectionId?: string;
	contextRow?: Row; // Mutation context values
	contextDescriptor?: RowDescriptor; // Mutation context row descriptor
	/**
	 * Lowercase `<schema>.<name>` as this entry's frozen evaluator names a table →
	 * the name that table carries now. Populated by {@link DeferredConstraintQueue.notifyTableRename}
	 * for renames that happen AFTER this entry was queued, and handed to the scan
	 * leaf via `RuntimeContext.tableNameRemap` at evaluation time. Per-entry rather
	 * than queue-wide because a freed name may be reused by a fresh table in the
	 * same transaction — only entries queued before the rename may be redirected.
	 */
	tableRenames?: Map<string, string>;
}

type DeferredConstraintBuckets = Map<string, Map<string, DeferredConstraintRow[]>>;

export class DeferredConstraintQueue {
	private readonly entries: DeferredConstraintBuckets = new Map();
	private layers: DeferredConstraintBuckets[] = [];

	constructor(private readonly db: Database) { }

	enqueue(baseTable: string, constraintName: string, row: Row, descriptor: RowDescriptor, evaluator: (ctx: RuntimeContext) => OutputValue, connectionId?: string, contextRow?: Row, contextDescriptor?: RowDescriptor): void {
		const store = this.getActiveStore();
		const tableKey = baseTable.toLowerCase();
		if (!store.has(tableKey)) store.set(tableKey, new Map());
		const constraints = store.get(tableKey)!;
		if (!constraints.has(constraintName)) constraints.set(constraintName, []);
		constraints.get(constraintName)!.push({
			row: row.slice() as Row,
			descriptor,
			evaluator,
			constraintName,
			connectionId,
			contextRow: contextRow ? contextRow.slice() as Row : undefined,
			contextDescriptor
		});
	}

	/**
	 * Records an `ALTER TABLE ... RENAME TO` against every entry already queued, so a
	 * check parked before the rename still finds its tables at commit.
	 *
	 * Two halves:
	 *  - every pending entry learns `<schema>.<oldName>` → `newName`, composing across
	 *    repeated renames (`pp → pp2 → pp3` leaves `main.pp` → `pp3`). Composition is
	 *    confined to keys in the renamed table's own schema — map VALUES are bare names,
	 *    so a same-named table in another schema must not follow this rename. An entry
	 *    that already maps `<schema>.<oldName>` is left alone on that key: its emit-time
	 *    table has moved on, and this rename is about whichever table holds the freed
	 *    name now.
	 *  - the bucket keyed by the write-time table name moves with the table, so
	 *    {@link findConnection}'s name fallback keys off the CURRENT name.
	 *
	 * NOTE: stamps every pending entry, including entries below the current savepoint
	 * layer, and `rollbackLayer` does not unstamp them. Correct today because a catalog
	 * rename is not rolled back either — the built-in modules declare the
	 * `'non-transactional'` DDL tier, so `rollback to <savepoint>` (and a whole
	 * `rollback`) leave the rename applied. If transactional DDL ever lands for the
	 * native backends, this remap has to become layer-scoped alongside the catalog.
	 *
	 * NOTE: walks every queued entry per rename, and each entry owns its own map — so a
	 * bulk load that parks a very large number of deferred rows and then renames pays
	 * O(entries) per rename plus one Map per entry. Fine at today's scale (renames inside
	 * a write transaction are rare); if that combination ever shows up hot, share one
	 * copy-on-write rename map across the entries queued between two renames.
	 */
	notifyTableRename(schemaName: string, oldName: string, newName: string): void {
		const oldKey = `${schemaName}.${oldName}`.toLowerCase();
		const newKey = `${schemaName}.${newName}`.toLowerCase();
		const oldLower = oldName.toLowerCase();
		const schemaPrefix = `${schemaName.toLowerCase()}.`;

		const stampStore = (store: DeferredConstraintBuckets): void => {
			for (const constraints of store.values()) {
				for (const rows of constraints.values()) {
					for (const entry of rows) {
						const renames = entry.tableRenames ?? new Map<string, string>();
						for (const [key, current] of renames) {
							if (key.startsWith(schemaPrefix) && current.toLowerCase() === oldLower) {
								renames.set(key, newName);
							}
						}
						if (!renames.has(oldKey)) renames.set(oldKey, newName);
						entry.tableRenames = renames;
					}
				}
			}
			this.rekeyBucket(store, oldKey, newKey);
		};

		stampStore(this.entries);
		for (const layer of this.layers) stampStore(layer);
	}

	/** Moves the `oldKey` bucket to `newKey`, merging per-constraint row lists into an existing destination. */
	private rekeyBucket(store: DeferredConstraintBuckets, oldKey: string, newKey: string): void {
		if (oldKey === newKey) return;
		const bucket = store.get(oldKey);
		if (!bucket) return;
		store.delete(oldKey);
		const dest = store.get(newKey);
		if (!dest) {
			store.set(newKey, bucket);
			return;
		}
		for (const [constraintName, rows] of bucket) {
			if (!dest.has(constraintName)) dest.set(constraintName, []);
			dest.get(constraintName)!.push(...rows);
		}
	}

	beginLayer(): void {
		this.layers.push(new Map());
	}

	rollbackLayer(): void {
		this.layers.pop();
	}

	releaseLayer(): void {
		const top = this.layers.pop();
		if (!top) return;
		const target = this.getActiveStore();
		this.merge(target, top);
	}

	clear(): void {
		this.entries.clear();
		this.layers = [];
	}

	async runDeferredRows(): Promise<void> {
		if (!this.hasPending()) return;
		const activeConnections = this.db.getAllConnections();
		const runtimeCtx: RuntimeContext = {
			db: this.db,
			stmt: undefined,
			params: {},
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			tracer: this.db.getInstructionTracer(),
			enableMetrics: this.db.options.getBooleanOption('runtime_stats'),
		};
		const store = this.cloneAll();
		for (const [table, constraints] of store) {
			for (const [_, rows] of constraints) {
				for (const entry of rows) {
					const connection = this.findConnection(activeConnections, table, entry.connectionId);
					runtimeCtx.activeConnection = connection;
					// Per entry: the evaluator was frozen at row-write time, so any table it
					// names by the pre-rename name resolves through this map in the scan leaf.
					runtimeCtx.tableNameRemap = entry.tableRenames;
					await this.evaluateEntry(runtimeCtx, entry);
				}
			}
		}
		this.clear();
	}

	private async evaluateEntry(runtimeCtx: RuntimeContext, entry: DeferredConstraintRow): Promise<void> {
		// Compose context row with the flat row if context is present
		const evaluationRow = entry.contextRow ? [...entry.contextRow, ...entry.row] : entry.row;
		const evaluationDescriptor = entry.contextRow && entry.contextDescriptor
			? composeCombinedDescriptor(entry.contextDescriptor, entry.descriptor)
			: entry.descriptor;


		const slot = createRowSlot(runtimeCtx, evaluationDescriptor);
		try {
			slot.set(evaluationRow);
			const value = await entry.evaluator(runtimeCtx) as SqlValue;
			// NOTE: unreachable from today's two enqueue sites (runtime/row-constraints.ts,
			// shared by the ConstraintCheckNode emitter and the `on conflict … do update`
			// arm, and core/derived-row-validator.ts) — both wrap their evaluator so it throws its
			// own message, attributed identically to the immediate path. This stays as the
			// safety net for any future caller that queues a raw evaluator; if that never
			// happens, it can go, and if it does, prefer teaching the caller to self-attribute
			// over enriching this generic (name-only) message.
			if (value !== null && !isTruthy(value)) {
				throw new QuereusError(`CHECK constraint failed: ${entry.constraintName}`, StatusCode.CONSTRAINT);
			}
		} finally {
			slot.close();
		}
	}

	private getActiveStore(): DeferredConstraintBuckets {
		return this.layers.length > 0 ? this.layers[this.layers.length - 1] : this.entries;
	}

	private hasPending(): boolean {
		if (this.entries.size > 0) return true;
		return this.layers.some(layer => layer.size > 0);
	}

	private cloneAll(): DeferredConstraintBuckets {
		const clone: DeferredConstraintBuckets = new Map();
		const append = (source: DeferredConstraintBuckets) => {
			for (const [table, constraints] of source) {
				const lowerTable = table.toLowerCase();
				if (!clone.has(lowerTable)) clone.set(lowerTable, new Map());
				const targetConstraints = clone.get(lowerTable)!;
				for (const [constraintName, rows] of constraints) {
					if (!targetConstraints.has(constraintName)) targetConstraints.set(constraintName, []);
					targetConstraints.get(constraintName)!.push(...rows.map(entry => ({
						row: entry.row.slice() as Row,
						descriptor: entry.descriptor,
						evaluator: entry.evaluator,
						constraintName: entry.constraintName,
						connectionId: entry.connectionId,
						contextRow: entry.contextRow ? entry.contextRow.slice() as Row : undefined,
						contextDescriptor: entry.contextDescriptor,
						tableRenames: entry.tableRenames,
					})));
				}
			}
		};

		append(this.entries);
		for (const layer of this.layers) append(layer);
		return clone;
	}

	private merge(target: DeferredConstraintBuckets, source: DeferredConstraintBuckets): void {
		for (const [table, constraints] of source) {
			const lowerTable = table.toLowerCase();
			if (!target.has(lowerTable)) target.set(lowerTable, new Map());
			const destConstraints = target.get(lowerTable)!;
			for (const [constraintName, rows] of constraints) {
				if (!destConstraints.has(constraintName)) destConstraints.set(constraintName, []);
				destConstraints.get(constraintName)!.push(...rows);
			}
		}
	}

	private findConnection(connections: VirtualTableConnection[], tableKey: string, preferredId?: string): VirtualTableConnection | undefined {
		if (preferredId) {
			const direct = connections.find(conn => conn.connectionId === preferredId);
			if (direct) {
				return direct;
			}
			throw new QuereusError(
				`Deferred constraint execution could not find connectionId=${preferredId} for table ${tableKey}`,
				StatusCode.INTERNAL
			);
		}
		// NOTE: this name fallback is only reached when the enqueue site had no
		// `activeConnection` to stamp. `tableKey` is the table's CURRENT name, not the
		// write-time one: `notifyTableRename` moves the bucket whenever an
		// `ALTER TABLE ... RENAME TO` lands mid-transaction, matching the modules that
		// re-key their connections on rename (see MemoryTableManager.rekeyRegisteredConnections).
		// Were the two to drift apart, the entry would evaluate with no active connection and
		// read committed state instead of the transaction's own writes.
		const normalized = tableKey.toLowerCase();
		const simple = normalized.includes('.') ? normalized.substring(normalized.lastIndexOf('.') + 1) : normalized;
		const matches = connections.filter(conn => {
			const connName = conn.tableName.toLowerCase();
			return connName === normalized || connName === simple;
		});
		if (matches.length > 1) {
			const covering = matches.filter(c => c.isCovering);
			if (covering.length === 1) return covering[0];
			throw new QuereusError(
				`Deferred constraint execution found multiple candidate connections for table ${tableKey}`,
				StatusCode.INTERNAL
			);
		}
		return matches[0];
	}
}

