/**
 * Delta executor kernel.
 *
 * A reusable dispatcher that any change-driven consumer (assertions today;
 * materialized views, reactive signals, triggers tomorrow) can register
 * subscriptions against. The kernel inspects per-subscription bindings
 * (`BindingMode`), collects the relevant changed binding tuples from the
 * TransactionManager's change capture, applies a cost-based fallback to
 * global re-evaluation when too many tuples would need per-binding dispatch,
 * and invokes the subscription's `apply` once with the resulting batches.
 *
 * The kernel itself is stateless across runs; subscriptions own their own
 * residual plan cache (no shared cache, since plan-shape generation is
 * consumer-specific).
 */

import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';
import type {
	ChangeScope,
	MatchedWatch,
	QualifiedName,
	ScopeValue,
	TableWatch,
	WatchHandler,
} from '../planner/analysis/change-scope.js';

const log = createLogger('runtime:delta-executor');

/**
 * The slice of `Database` the kernel needs. Decoupled so subscriptions can
 * be unit-tested against a minimal mock.
 */
export interface DeltaExecutorContext {
	/** Changed base tables for the current commit. */
	getChangedBaseTables(): Set<string>;
	/** Projected tuples for a changed base table. PK columns are always
	 *  available; non-PK columns must be registered via `registerCaptureSpec`
	 *  before any DML records changes. */
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][];
	/** Heuristic row count for cost fallback. Optional — when omitted the
	 *  kernel does not demote any bindings to global. */
	getRowCount?(base: string): number | undefined;
	/** Optional: report a base whose entire contents changed opaquely this pass
	 *  (e.g. a wholesale rebuild whose per-row deltas weren't captured). When this
	 *  returns true for a relation's base, the kernel flags that relation for
	 *  global re-evaluation instead of fetching per-tuple deltas. Consumers that
	 *  never rebuild opaquely (assertions, watchers) omit it. */
	isGloballyChanged?(base: string): boolean;
	/** Tuning parameter: ratio of changed-distinct-tuples to table row count
	 *  above which the kernel demotes a 'row'/'group' binding to 'global'. */
	readonly deltaPerRowFallbackRatio: number;
}

/**
 * Input to a subscription's `apply`. Carries per-relation tuple batches plus
 * a set of relations that should be re-evaluated globally (either because
 * the binding is 'global' or because the cost-fallback fired).
 */
export interface DeltaApplyInput {
	/** RelationKey → tuples to bind for that relation. Tuple order matches
	 *  the BindingMode's `keyColumns`/`groupColumns`. */
	readonly perRelationTuples: ReadonlyMap<string, readonly SqlValue[][]>;
	/** RelationKeys flagged for global re-evaluation. */
	readonly globalRelations: ReadonlySet<string>;
}

/**
 * Optional knobs for a single {@link DeltaExecutor.runAll} pass. Defaults keep
 * the kernel consumer-neutral — assertions and watchers call `runAll()` with no
 * options and behave exactly as before. The materialized-view manager uses both
 * seams to converge cascading MV-over-MV chains in one post-commit pass: it
 * reorders subscriptions into dependency-topological order and rescans the
 * change source between subscriptions so a producer MV's backing-table write
 * (exposed via the context overlay) is visible to its dependents.
 */
export interface RunAllOptions {
	/** Reorder the subscription snapshot before dispatch. Receives a fresh array
	 *  (safe to sort in place); the returned order is used. Default: insertion order. */
	order?: (subs: DeltaSubscription[]) => DeltaSubscription[];
	/** Recompute `ctx.getChangedBaseTables()` before each `runOne`, so an `apply`
	 *  that grows the change source via the context (e.g. records a backing-table
	 *  delta) is visible to later subscriptions in the same pass. Default: false. */
	rescanPerSubscription?: boolean;
}

/**
 * A single change-driven consumer registered with the executor.
 */
export interface DeltaSubscription {
	/** Diagnostic id (e.g. 'assertion:no_negative_balance'). */
	readonly id: string;
	/** Base table dependencies (lowercased 'schema.table'). */
	readonly dependencies: ReadonlySet<string>;
	/** BindingMode per relationKey (one per TableReferenceNode instance). */
	readonly bindings: ReadonlyMap<string, BindingMode>;
	/** relationKey → base table (from PlanBindings). */
	readonly relationToBase: ReadonlyMap<string, string>;
	/** PK indices per base table; used to retrieve changed tuples. */
	readonly pkIndicesByBase: ReadonlyMap<string, readonly number[]>;
	/** Invoked once with the per-relation batches for this commit. */
	apply(input: DeltaApplyInput): Promise<void>;
	/** Release any external resources this subscription holds. */
	dispose(): void;
}

/**
 * Coordinates delta dispatch across all registered subscriptions.
 */
export class DeltaExecutor {
	private subscriptions = new Set<DeltaSubscription>();

	constructor(private readonly ctx: DeltaExecutorContext) {}

	/**
	 * Register a subscription. Returns a dispose handle that removes the
	 * subscription and calls its `dispose()`.
	 */
	register(sub: DeltaSubscription): () => void {
		this.subscriptions.add(sub);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.subscriptions.delete(sub);
			sub.dispose();
		};
	}

	/** Dispose all subscriptions. */
	disposeAll(): void {
		for (const sub of this.subscriptions) {
			sub.dispose();
		}
		this.subscriptions.clear();
	}

	/**
	 * Run all impacted subscriptions. Throws on the first subscription's
	 * `apply` rejection — exceptions are surfaced unchanged so the COMMIT
	 * path can roll back.
	 *
	 * With no options this is insertion-order, single-scan dispatch (the
	 * assertion/watcher contract). {@link RunAllOptions} lets a consumer reorder
	 * the snapshot and rescan the change source per subscription — see the
	 * materialized-view manager's cascading-convergence pass.
	 */
	async runAll(opts?: RunAllOptions): Promise<void> {
		if (this.subscriptions.size === 0) return;
		let changedBases = this.ctx.getChangedBaseTables();
		if (changedBases.size === 0) return;

		// Snapshot subscriptions before iterating: a handler that registers a
		// new subscription mid-fire must not see the current commit, and one
		// that unsubscribes a peer must still see in-flight apply complete.
		let snapshot = [...this.subscriptions];
		if (opts?.order) snapshot = opts.order(snapshot);
		for (const sub of snapshot) {
			if (!this.subscriptions.has(sub)) continue;
			// Rescan so a prior subscription's apply that grew the change source
			// (e.g. a producer MV's backing-table delta) is visible here.
			if (opts?.rescanPerSubscription) changedBases = this.ctx.getChangedBaseTables();
			await this.runOne(sub, changedBases);
		}
	}

	private async runOne(sub: DeltaSubscription, changedBases: Set<string>): Promise<void> {
		// Quick skip: if no dependency of the subscription changed at all.
		let any = false;
		for (const dep of sub.dependencies) {
			if (changedBases.has(dep)) { any = true; break; }
		}
		if (!any) return;

		const perRelationTuples = new Map<string, SqlValue[][]>();
		const globalRelations = new Set<string>();

		for (const [relKey, binding] of sub.bindings) {
			const base = sub.relationToBase.get(relKey);
			if (!base || !changedBases.has(base)) continue;

			// The base's entire contents changed opaquely (e.g. a producer MV was
			// rebuilt wholesale, so no per-row deltas were captured). The only
			// correct response is to re-evaluate this relation globally.
			if (this.ctx.isGloballyChanged?.(base)) {
				globalRelations.add(relKey);
				continue;
			}

			if (binding.kind === 'global') {
				globalRelations.add(relKey);
				continue;
			}

			const cols = binding.kind === 'row' ? binding.keyColumns : binding.groupColumns;

			// An empty 'row' key means the reference is provably ≤1-row (keysOf
			// returned the empty key). There are no key columns to fetch tuples
			// for, and a per-tuple seek with cols=[] is ill-defined; re-evaluate
			// this relation globally instead. Sound and equivalent for a ≤1-row
			// table (scanning it whole is the same as seeking its single row).
			if (binding.kind === 'row' && cols.length === 0) {
				globalRelations.add(relKey);
				continue;
			}

			const pkIndices = sub.pkIndicesByBase.get(base);
			if (!pkIndices) {
				// No PK known for this base — can't fetch tuples; fall back to global.
				log('No PK for base %s; falling back to global for %s', base, sub.id);
				globalRelations.add(relKey);
				continue;
			}

			let tuples: SqlValue[][];
			try {
				tuples = this.ctx.getChangedTuples(base, cols, pkIndices);
			} catch (e) {
				// The requested columns aren't registered. Fall back to global
				// for safety — the subscription forgot to register a CaptureSpec.
				log('getChangedTuples failed for %s on %s (%s); falling back to global', sub.id, base, (e as Error).message);
				globalRelations.add(relKey);
				continue;
			}

			if (tuples.length === 0) {
				// Dependency changed but no captured tuples touched this binding —
				// nothing to dispatch for this relation.
				continue;
			}

			// Cost fallback: if the number of distinct binding tuples is a large
			// fraction of the base table size, doing N per-binding runs is likely
			// worse than one global run.
			const rowCount = this.ctx.getRowCount?.(base);
			if (rowCount !== undefined && rowCount > 0) {
				const ratio = tuples.length / rowCount;
				if (ratio >= this.ctx.deltaPerRowFallbackRatio) {
					log('Cost fallback for %s on %s: %d/%d ≥ %s — running global',
						sub.id, base, tuples.length, rowCount, this.ctx.deltaPerRowFallbackRatio);
					globalRelations.add(relKey);
					continue;
				}
			}

			perRelationTuples.set(relKey, tuples);
		}

		if (perRelationTuples.size === 0 && globalRelations.size === 0) {
			return;
		}

		const input: DeltaApplyInput = { perRelationTuples, globalRelations };
		await sub.apply(input);
	}
}

/* ─────────────────────────── ChangeScope → Subscription ─────────────────────────── */

/**
 * Minimal table-info shape used by `subscriptionFromChangeScope` for column
 * resolution and PK lookup. Kept generic so the helper does not import the
 * schema module directly.
 */
export interface ChangeScopeTableInfo {
	/** Lowercased column name → column index. */
	readonly columnIndexMap: ReadonlyMap<string, number>;
	/** Primary-key column indices, in PK order. */
	readonly pkIndices: readonly number[];
}

/** Context provided by `Database.watch` to the helper. */
export interface SubscriptionFromChangeScopeContext {
	/** Resolve a qualified base table. Used for column-index lookup and as
	 *  the existence gate (returns `undefined` if the table is missing). */
	resolveTable(qname: QualifiedName): ChangeScopeTableInfo | undefined;
	/** Register a column-capture spec; returns a dispose handle. Called once
	 *  per base table that needs extra columns captured (i.e. row/group key
	 *  columns outside the PK, and `full` watches with a non-`'all'` column
	 *  set). */
	registerCaptureSpec(baseTable: string, spec: { extraColumns: ReadonlySet<number> }): () => void;
	/** Return a stable transaction id for the current commit. The watcher
	 *  subscription includes this on every emitted `WatchEvent`. */
	getCurrentTxnId(): string;
}

export interface SubscriptionFromChangeScopeResult {
	subscription: DeltaSubscription;
	/** Capture-spec dispose handles to release on `unsubscribe`. */
	captureDisposers: Array<() => void>;
}

/** Synthetic relation key for the i-th watch in a scope. */
function relKeyForWatch(table: QualifiedName, watchIndex: number): string {
	return `${baseKeyFor(table)}#watch_${watchIndex}`;
}

function baseKeyFor(table: QualifiedName): string {
	// Defensive: the contract on `QualifiedName` says lowercased, but
	// hand-built `ChangeScope` values may not honor it. The change log is
	// keyed lowercased, so non-lowercased deps would never match.
	return `${table.schema}.${table.table}`.toLowerCase();
}

/**
 * Stable string key for an SqlValue tuple, used to intersect kernel-emitted
 * tuples against a watch's literal `values`.
 */
function tupleKey(tuple: readonly SqlValue[]): string {
	const parts: string[] = [];
	for (const v of tuple) {
		if (v === null) parts.push('null');
		else if (typeof v === 'bigint') parts.push(`b:${v.toString()}`);
		else if (typeof v === 'number') parts.push(`n:${v}`);
		else if (typeof v === 'string') parts.push(`s:${v}`);
		else if (typeof v === 'boolean') parts.push(`B:${v}`);
		else if (v instanceof Uint8Array) parts.push(`x:${Array.from(v).map(b => b.toString(16).padStart(2, '0')).join('')}`);
		else parts.push(`j:${JSON.stringify(v)}`);
	}
	return parts.join('|');
}

/**
 * Resolve a column name on a base table or throw a clear error.
 */
function resolveColumn(qname: QualifiedName, info: ChangeScopeTableInfo, name: string): number {
	const idx = info.columnIndexMap.get(name.toLowerCase());
	if (idx === undefined) {
		throw new QuereusError(
			`watch: column '${name}' does not exist on ${qname.schema}.${qname.table}`,
			StatusCode.ERROR,
		);
	}
	return idx;
}

/**
 * Translate a public `ChangeScope` into a `DeltaSubscription` plus its
 * capture-spec dispose handles. Pure shape-translation: callers (i.e.
 * `Database.watch`) own validation of unbound parameters, schema-change
 * invalidation, and registration with the executor.
 *
 * Throws synchronously if:
 * - any referenced table no longer exists in the schema;
 * - any column referenced in `key` / `groupBy` / `columns` does not exist
 *   on its table.
 */
export function subscriptionFromChangeScope(
	scope: ChangeScope,
	handler: WatchHandler,
	id: string,
	ctx: SubscriptionFromChangeScopeContext,
): SubscriptionFromChangeScopeResult {
	const bindings = new Map<string, BindingMode>();
	const relationToBase = new Map<string, string>();
	const pkIndicesByBase = new Map<string, readonly number[]>();
	const dependencies = new Set<string>();
	const captureDisposers: Array<() => void> = [];

	// Per-watch metadata for the apply path. Aligned 1:1 with scope.watches.
	interface WatchPlan {
		readonly watch: TableWatch;
		readonly relKey: string;
		readonly base: string;
		/** Literal-only key/group values, pre-filtered. Empty array for
		 *  watches that don't carry literal values (`full`, `groups`). */
		readonly literalValues: ReadonlyArray<ReadonlyArray<SqlValue>>;
	}
	const plans: WatchPlan[] = [];

	scope.watches.forEach((watch, i) => {
		const info = ctx.resolveTable(watch.table);
		if (!info) {
			throw new QuereusError(
				`watch: table ${watch.table.schema}.${watch.table.table} does not exist`,
				StatusCode.ERROR,
			);
		}
		const base = baseKeyFor(watch.table);
		const relKey = relKeyForWatch(watch.table, i);
		dependencies.add(base);
		relationToBase.set(relKey, base);
		if (!pkIndicesByBase.has(base)) {
			pkIndicesByBase.set(base, info.pkIndices);
		}

		const extras = new Set<number>();
		const pkSet = new Set<number>(info.pkIndices);
		const recordExtras = (cols: readonly number[]): void => {
			for (const c of cols) {
				if (!pkSet.has(c)) extras.add(c);
			}
		};

		let mode: BindingMode;
		let literalValues: ReadonlyArray<ReadonlyArray<SqlValue>> = [];

		switch (watch.scope.kind) {
			case 'full': {
				mode = { kind: 'global' };
				if (watch.columns !== 'all') {
					for (const name of watch.columns) {
						const idx = resolveColumn(watch.table, info, name);
						if (!pkSet.has(idx)) extras.add(idx);
					}
				}
				break;
			}
			case 'rows': {
				const keyCols = watch.scope.key.map(n => resolveColumn(watch.table, info, n));
				literalValues = literalValuesOnly(watch.scope.values);
				recordExtras(keyCols);
				mode = { kind: 'row', keyColumns: keyCols };
				break;
			}
			case 'groups': {
				const groupCols = watch.scope.groupBy.map(n => resolveColumn(watch.table, info, n));
				recordExtras(groupCols);
				mode = { kind: 'group', groupColumns: groupCols };
				break;
			}
			case 'rowsByGroup': {
				const groupCols = watch.scope.groupBy.map(n => resolveColumn(watch.table, info, n));
				literalValues = literalValuesOnly(watch.scope.values);
				recordExtras(groupCols);
				mode = { kind: 'group', groupColumns: groupCols };
				break;
			}
		}

		bindings.set(relKey, mode);
		if (extras.size > 0) {
			captureDisposers.push(ctx.registerCaptureSpec(base, { extraColumns: extras }));
		}
		plans.push({ watch, relKey, base, literalValues });
	});

	const apply = async (input: DeltaApplyInput): Promise<void> => {
		const matched: MatchedWatch[] = [];

		for (const plan of plans) {
			const { watch, relKey, literalValues } = plan;
			const isGlobal = input.globalRelations.has(relKey);
			const kernelTuples = input.perRelationTuples.get(relKey);

			if (!isGlobal && !kernelTuples) {
				// No change for this watch's base; skip.
				continue;
			}

			let hits: ReadonlyArray<ReadonlyArray<SqlValue>>;
			let observable: boolean;
			switch (watch.scope.kind) {
				case 'full': {
					// Column-narrowing for `full + columns` is best-effort in v1:
					// we register a capture spec but always fire on any change.
					hits = [];
					// Fire whenever the table was touched (kernel signals via
					// globalRelations for 'global' bindings).
					observable = isGlobal;
					break;
				}
				case 'rows': {
					if (isGlobal) {
						// Kernel fell back to global; we can't narrow precisely.
						// Surface every literal value the watch was registered
						// for so the handler treats them all as possibly-changed.
						hits = literalValues;
						observable = hits.length > 0;
					} else {
						hits = intersectTuples(kernelTuples ?? [], literalValues);
						observable = hits.length > 0;
					}
					break;
				}
				case 'groups': {
					// A `groups` watch carries no literal values to surface, so on a
					// global re-evaluation (kernel fell back to whole-relation, or an
					// external/out-of-band change marked the relation global) we fire
					// with empty hits — "some group changed, re-query" — exactly as the
					// `full` case does. Without this, a `groups` watch would silently
					// miss every global change (commit-path fallbacks and the entire
					// external-change path), violating the never-miss-a-change contract.
					hits = isGlobal ? [] : (kernelTuples ?? []);
					observable = isGlobal || hits.length > 0;
					break;
				}
				case 'rowsByGroup': {
					if (isGlobal) {
						hits = literalValues;
					} else {
						hits = intersectTuples(kernelTuples ?? [], literalValues);
					}
					observable = hits.length > 0;
					break;
				}
			}

			if (observable) matched.push({ watch, hits });
		}

		if (matched.length === 0) return;

		const event = { matched, txnId: ctx.getCurrentTxnId() };
		try {
			const r = handler(event);
			if (r && typeof (r as Promise<void>).then === 'function') {
				await r;
			}
		} catch (err) {
			log('Watch handler %s threw: %O', id, err);
		}
	};

	const subscription: DeltaSubscription = {
		id,
		dependencies,
		bindings,
		relationToBase,
		pkIndicesByBase,
		apply,
		dispose: () => { /* capture disposers handled by caller */ },
	};
	return { subscription, captureDisposers };
}

/**
 * Filter a ScopeValue-tuple list to literal-only tuples.
 *
 * `Database.watch` rejects scopes with `unboundParameters.length > 0` up
 * front, so by the time we reach here, any surviving `ParamScopeValue`
 * placeholders represent a caller-side bug; we drop them defensively
 * rather than throw deep in the runtime path.
 */
function literalValuesOnly(
	values: ReadonlyArray<ReadonlyArray<ScopeValue>>,
): ReadonlyArray<ReadonlyArray<SqlValue>> {
	const out: SqlValue[][] = [];
	for (const tuple of values) {
		let allLiteral = true;
		const lit: SqlValue[] = [];
		for (const v of tuple) {
			if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v) && (v as { kind?: unknown }).kind === 'param') {
				allLiteral = false;
				break;
			}
			lit.push(v as SqlValue);
		}
		if (allLiteral) out.push(lit);
	}
	return out;
}

function intersectTuples(
	kernel: readonly SqlValue[][],
	watch: ReadonlyArray<ReadonlyArray<SqlValue>>,
): ReadonlyArray<ReadonlyArray<SqlValue>> {
	if (watch.length === 0) return [];
	const watchKeys = new Set<string>();
	for (const t of watch) watchKeys.add(tupleKey(t));
	const out: SqlValue[][] = [];
	const seen = new Set<string>();
	for (const kt of kernel) {
		const k = tupleKey(kt);
		if (!watchKeys.has(k) || seen.has(k)) continue;
		seen.add(k);
		out.push([...kt]);
	}
	return out;
}
