/**
 * Materialized-view maintenance — **delta apply**. The per-row / per-flush appliers that
 * take a compiled {@link MaintenancePlan} plus a source {@link BackingRowChange}, compute the
 * bounded backing delta (or the full-rebuild diff), and write it through the backing table's
 * coordinated transaction connection — plus the residual runners, backing-host / connection
 * resolvers, derived-row and parent-side referential enforcement, and the small key-compare
 * helpers they share. Extracted from database-materialized-views.ts as free functions over
 * {@link MaterializedViewManagerContext}; the manager's orchestration methods
 * (`maintainRowTime`, `flushDeferredMaintenance`, `lookupCoveringConflicts`) call in.
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { Scheduler } from '../runtime/scheduler.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { isAsyncIterable } from '../runtime/utils.js';
import type { RuntimeContext } from '../runtime/types.js';
import { resolveBackingHost, nullInNotNullSeededPkError } from '../runtime/emit/materialized-view-helpers.js';
import { assertTransitiveRestrictsForParentMutation, executeForeignKeyActionsAndLens } from '../runtime/foreign-key-actions.js';
import { validateDerivedRowImage, type DerivedRowConstraintValidator } from './derived-row-validator.js';
import { buildPrimaryKeyFromValues } from '../vtab/memory/utils/primary-key.js';
import type { BTreeKeyForPrimary } from '../vtab/memory/types.js';
import type { BackingHost, BackingRowChange, MaintenanceOp } from '../vtab/backing-host.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { compareSqlValuesFast, rowsValueIdentical } from '../util/comparison.js';
import type { TableSchema } from '../schema/table.js';
import type { Database } from './database.js';
import { canonKeyValues } from './database-materialized-views-analysis.js';
import { cloneInitialValue, type AggValue } from '../func/registration.js';
import type {
	MaterializedViewManagerContext,
	MaintenancePlan,
	InverseProjectionPlan,
	ForwardResidualPlan,
	JoinResidualPlan,
	PrefixDeletePlan,
	ResidualMaintenancePlan,
	ResidualRecomputePlan,
	ForwardResidualKey,
	PrefixDeleteKey,
	ResidualKeyBatch,
	ResidualKeyBatchEntry,
	BackingConnectionCache,
	BackingPkColumn,
	DeltaGroupState,
} from './database-materialized-views-plans.js';

/**
 * Resolve a plan's backing table to its {@link BackingHost} + coordinated
 * {@link VirtualTableConnection} — the two handles every apply path writes through.
 * Shared by the per-row appliers, the batched residual flush, and the full-rebuild
 * `'replace-all'` diff; throws INTERNAL when the backing table has vanished (an MV in a
 * broken state).
 */
export async function resolveBackingApplyTarget(
	ctx: MaterializedViewManagerContext,
	// Structural (not the MaintenancePlan union) so the shared ForwardResidualPlan
	// subset the join arm reuses resolves through it too.
	plan: Pick<MaintenancePlan, 'mv' | 'backingSchema' | 'backingTableName'>,
	cache?: BackingConnectionCache,
): Promise<{ host: BackingHost; connection: VirtualTableConnection }> {
	const backing = ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${plan.backingTableName}' for materialized view '${plan.mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}
	const host = backingHost(ctx, backing);
	const connection = await getBackingConnection(ctx, host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
	return { host, connection };
}

/**
 * Compute an `'inverse-projection'` plan's per-row backing delta, apply it, and
 * return the **effective** {@link BackingRowChange}(s) the backing layer realized.
 * An out-of-scope row (or a delete of an absent backing key) yields no change. This
 * body is the shipped covering-index maintenance, lifted verbatim from the former
 * `applyRowTimeChange`, plus the equal-image short-circuit: an UPDATE whose old and
 * new projected images are value-identical (both in scope) projects to NO backing
 * delta — the dominant no-op echo (a source update touching only unprojected columns,
 * or rewriting a projected column to its existing value) is suppressed before any
 * backing-connection work. Accurate by the maintenance invariant (the backing row IS
 * the old image's projection), so nothing would have changed; the host's
 * value-identical upsert skip (vtab/backing-host.ts) remains the effective-state
 * backstop for the paths that do emit ops.
 */
export async function applyInverseProjection(
	ctx: MaterializedViewManagerContext,
	plan: InverseProjectionPlan,
	change: BackingRowChange,
	cache?: BackingConnectionCache,
): Promise<BackingRowChange[]> {
	const inScope = (row: Row): boolean => plan.predicate === undefined || plan.predicate.evaluate(row) === true;
	const project = (row: Row): Row =>
		plan.projectors.map(p => p.kind === 'passthrough' ? row[p.sourceCol] : p.eval(row));
	const keyOf = (backingRow: Row): BTreeKeyForPrimary =>
		buildPrimaryKeyFromValues(plan.backingPkDefinition.map(d => backingRow[d.index]), plan.backingPkDefinition);

	const ops: MaintenanceOp[] = [];
	if (change.op === 'insert') {
		if (inScope(change.newRow)) ops.push({ kind: 'upsert', row: project(change.newRow) });
	} else if (change.op === 'delete') {
		if (inScope(change.oldRow)) ops.push({ kind: 'delete-key', key: keyOf(project(change.oldRow)) });
	} else {
		// UPDATE: a both-in-scope, same-backing-key change is one upsert (the host
		// reports a single `update`); otherwise delete the old image if it was in
		// scope and upsert the new image if it is — predicate-scope transitions and
		// key-changing updates are genuinely two-sided. The scope check reads the
		// SOURCE row (the predicate may reference unprojected columns), so both
		// images must be in scope for the equal-image short-circuit.
		const oldIn = inScope(change.oldRow);
		const newIn = inScope(change.newRow);
		if (oldIn && newIn) {
			const oldImage = project(change.oldRow);
			const newImage = project(change.newRow);
			// Byte-faithful identity (rowsValueIdentical): subsumes key equality, and a
			// collation-equal / byte-different image is NOT suppressed (it must re-key
			// the stored bytes) — the same discipline as the host-level upsert skip.
			if (rowsValueIdentical(oldImage, newImage)) return [];
			if (backingPkEqual(plan.backingPkDefinition, oldImage, newImage)) {
				// Same backing key (collation-aware — a collation-equal / byte-different
				// key is the SAME btree identity, and the upsert re-keys the stored
				// bytes): one upsert replaces the row wholesale, so the host reports
				// a single `update` — matching the residual arms' post-suppression
				// shape (one cascade dispatch, one change-log entry, no secondary-index
				// churn from a delete+insert at an unchanged key).
				ops.push({ kind: 'upsert', row: newImage });
			} else {
				ops.push({ kind: 'delete-key', key: keyOf(oldImage) });
				ops.push({ kind: 'upsert', row: newImage });
			}
		} else {
			if (oldIn) ops.push({ kind: 'delete-key', key: keyOf(project(change.oldRow)) });
			if (newIn) ops.push({ kind: 'upsert', row: project(change.newRow) });
		}
	}
	if (ops.length === 0) return [];

	const { host, connection } = await resolveBackingApplyTarget(ctx, plan, cache);
	return host.applyMaintenance(connection, ops);
}

/**
 * Validate the row images a maintenance apply WROTE (insert/update
 * {@link BackingRowChange}s — a delete writes no image) against the plan's
 * compiled {@link DerivedRowConstraintValidator}. Inline checks abort the
 * writing statement with the maintained-table-attributed CONSTRAINT error;
 * auto-deferred checks (subquery CHECK, every child-side FK) queue to the
 * deferred-constraint queue and validate at commit. Deferred entries are
 * pinned to the backing connection the maintenance write used (resolved from
 * the per-statement cache, or re-resolved deterministically — the same
 * connection either way) so commit-time evaluation reads the same pending
 * state, mirroring the DML pipeline's active-connection capture.
 */
export async function validateDerivedChanges(
	ctx: MaterializedViewManagerContext,
	plan: MaintenancePlan,
	validator: DerivedRowConstraintValidator,
	changes: readonly BackingRowChange[],
	cache?: BackingConnectionCache,
): Promise<void> {
	let connectionId: string | undefined;
	if (validator.checks.some(c => c.needsDeferred)) {
		const backing = ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (backing) {
			const host = backingHost(ctx, backing);
			const conn = await getBackingConnection(ctx, host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
			connectionId = conn.connectionId;
		}
	}
	for (const change of changes) {
		if (change.op === 'delete') continue;
		await validateDerivedRowImage(ctx as unknown as Database, validator, change.newRow, connectionId);
	}
}

/**
 * Row-time guard: reject a maintenance write that would store a NULL into a backing column
 * the schema declares NOT NULL *and* that is a physical-PK member whose re-derived body
 * output turned nullable — the row-time analogue of the refresh-path
 * `assertNoNullInNotNullSeededPk` (runtime/emit/materialized-view-helpers.ts). Row-time
 * maintenance is the PRIMARY silent-corruption vector: it fires at the source
 * insert/update, before any refresh, so without this guard a NULL lands in a
 * declared-NOT-NULL PK column with no error.
 *
 * The offending skew (a NOT-NULL ordering-seeded PK column over a loosened source) is
 * precomputed once at plan build into {@link MaintenancePlanCommon.nullGuardColumns}
 * (`undefined` for nearly every MV — the zero-overhead gate), so the common path pays a
 * single boolean check per maintained write and only the rare skewed MV scans its guarded
 * columns per change. A `delete` writes no image and is skipped. The throw unwinds the source
 * statement with nothing committed — the backing write rides the pending layer, discarded on
 * a throw before commit, exactly like {@link validateDerivedChanges}. Called BEFORE the
 * MV-over-MV cascade so a NULL row never reaches a consumer. See
 * fix/bug-mv-rowtime-null-into-notnull-seeded-pk.
 */
export function assertNoNullInNotNullSeededPkRowTime(
	plan: MaintenancePlan,
	changes: readonly BackingRowChange[],
): void {
	const guard = plan.nullGuardColumns;
	if (!guard) return;
	for (const change of changes) {
		if (change.op === 'delete') continue; // a delete writes no image
		for (const g of guard) {
			const v = change.newRow[g.index];
			if (v === null || v === undefined) {
				throw nullInNotNullSeededPkError(plan.mv.schemaName, plan.mv.name, g.name);
			}
		}
	}
}

/**
 * Fire **parent-side** referential enforcement over the backing rows a maintenance
 * apply REMOVED or re-keyed (delete / key-update {@link BackingRowChange}s — an insert
 * has no parent-side action). When the maintained table `M` is the PARENT (FK target)
 * of an FK declared on an ordinary table `C` (`create table C (… references M(col) …)`),
 * a maintenance-driven delete/key-update of the referenced `M` row would silently orphan
 * `C`'s rows, bypassing the declared RESTRICT / referential action. This is the
 * **dual** of {@link validateDerivedChanges} (constraints declared *on* `M`); the FK here
 * lives on `C` and references `M`, so it is invisible to `M`'s own plan/validator.
 *
 * It reuses the SAME shared referential-action engine the DML executor and the
 * external-change ingestion seam use — no third copy — applying its two functions over
 * each backing change exactly as `database-external-changes.ts` does:
 *  - {@link assertTransitiveRestrictsForParentMutation} — pre-walk the transitive cascade
 *    closure and throw a CONSTRAINT error naming `M` on any surviving RESTRICT child;
 *  - {@link executeForeignKeyActionsAndLens} — run declared CASCADE / SET NULL / SET DEFAULT,
 *    re-entering the DML executor (the already-holding-the-mutex variant) for each cascaded
 *    child write, so `C`'s own constraints, watches, nested cascades, and (if `C` is itself
 *    an MV source) its own maintenance all fire.
 *
 * Ordering: called AFTER the backing delta has landed in the pending layer (the RESTRICT
 * walk runs POST-application — the child rows it keys off still exist because the cascade
 * has not run yet) and AFTER `M`'s own image is validated, matching the DML executor's
 * per-change order (capture → MV maintenance → FK actions) and the external-changes seam.
 * `lensRouted = false`: a maintenance backing write is a physical basis write (maintained
 * tables are not lens basis spines). A surviving RESTRICT throws up through
 * {@link maintainRowTime} → the DML executor → the statement, rolling back the source write
 * attributed to `M`.
 *
 * Gate: a cheap `foreign_keys`-pragma early-return keeps the pragma-off path free (the
 * engine also early-returns, but skipping the `getTable` + loop avoids all per-change work).
 * NOT gated on `plan.derivedRowValidator` — that gate is child-side (constraints *on* `M`);
 * an inbound FK lives on `C` and leaves `M`'s plan untouched. Beyond the gate it fires
 * unconditionally per delete/update change, but the engine no longer pays an `O(catalog)`
 * scan: both calls route through `SchemaManager.getReferencingForeignKeys`, the precomputed
 * reverse-FK index, so an `M` that nothing references resolves to the shared empty bucket and
 * each call early-returns in O(1) — a maintained table with no inbound FK (the common case)
 * pays only the pragma check plus one map lookup per delete/key-update change.
 */
export async function enforceParentSideReferentialActions(
	ctx: MaterializedViewManagerContext,
	plan: MaintenancePlan,
	changes: readonly BackingRowChange[],
): Promise<void> {
	const db = ctx as unknown as Database;
	if (!db.options.getBooleanOption('foreign_keys')) return; // cheap gate; engine early-returns too
	// The backing `TableSchema` — same object validateDerivedChanges resolves; its `.name`
	// equals `M`'s, so an FK on `C` (`references M`) matches the engine's referencing scan.
	const parent = ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
	if (!parent) return; // backing gone ⇒ MV already broken
	for (const change of changes) {
		if (change.op === 'insert') continue; // inserts have no parent-side actions
		await assertTransitiveRestrictsForParentMutation(db, parent, change.op, change.oldRow, change.newRow);
		await executeForeignKeyActionsAndLens(db, parent, change.op, change.oldRow, change.newRow);
	}
}

/**
 * Resolve the {@link BackingHost} capability surface for a backing table —
 * see `vtab/backing-host.ts` for the contract. The host is resolved fresh per
 * use (a map lookup on the owning module), so a drop+recreate of the backing
 * always yields the new incarnation's host.
 */
export function backingHost(ctx: MaterializedViewManagerContext, backing: TableSchema): BackingHost {
	// The ctx IS the Database (same construction as buildMaintenancePlan's cast).
	return resolveBackingHost(ctx as unknown as Database, backing);
}

/**
 * Obtain (lazily create + register) the backing table's
 * {@link VirtualTableConnection} for the current transaction. Reuses the same
 * connection a `select` from the MV resolves to (so reads-own-writes holds) —
 * matched among the Database's registered connections by
 * {@link BackingHost.ownsConnection}, which is pinned to the live backing
 * incarnation; a freshly created connection is registered with the Database so
 * the coordinated commit/rollback covers its pending state in lockstep with the
 * source write.
 *
 * When an optional per-statement {@link BackingConnectionCache} is supplied, the
 * scan over the Database's active connections (the dominant per-row cost on a bulk
 * write) is paid once per (statement, backing): a hit returns the cached connection
 * directly, and a miss caches whichever connection the scan resolves — or the one it
 * lazily creates + registers. Caching the resolved/created connection is sound
 * because the scan is deterministic within a statement (nothing interleaves between
 * a statement's rows to change which connection a `select` from the MV picks), so the
 * cache holds exactly what an uncached re-resolution would return.
 */
export async function getBackingConnection(
	ctx: MaterializedViewManagerContext,
	host: BackingHost,
	qualifiedName: string,
	cache?: BackingConnectionCache,
): Promise<VirtualTableConnection> {
	const cacheKey = qualifiedName.toLowerCase();
	const cached = cache?.get(cacheKey);
	if (cached) return cached;
	for (const c of ctx.getConnectionsForTable(qualifiedName)) {
		if (host.ownsConnection(c)) {
			cache?.set(cacheKey, c);
			return c;
		}
	}
	const conn = host.connect();
	await ctx.registerConnection(conn);
	cache?.set(cacheKey, conn);
	return conn;
}

/**
 * Execute a cached key-filtered residual for one affected key tuple, returning its
 * result rows (0 or 1 for the aggregate shape; 0..N for the lateral-TVF fan-out shape).
 * Bound through a fresh {@link RuntimeContext} on the live `db` so the residual's source
 * scan reuses `T`'s transaction connection and reads this statement's pending writes
 * (reads-own-writes) — the synchronous analogue of
 * `database-assertions.ts:executeResidualPerTuple`. Shared by the residual-recompute
 * (`'gk'`) and prefix-delete (`'pk'`) arms.
 */
export async function runResidual(
	ctx: MaterializedViewManagerContext,
	residualScheduler: Scheduler,
	bindParamPrefix: 'gk' | 'pk',
	keyTuple: readonly SqlValue[],
): Promise<Row[]> {
	const params: Record<string, SqlValue> = {};
	for (let i = 0; i < keyTuple.length; i++) {
		params[`${bindParamPrefix}${i}`] = keyTuple[i];
	}
	return runScheduler(ctx, residualScheduler, params);
}

/**
 * Run a cached maintenance scheduler to completion against **live mid-transaction source
 * state** and collect its result rows. Bound through a fresh strict {@link RuntimeContext}
 * on the live `db` so the scan reuses the source's transaction connection and reads this
 * statement's pending writes (reads-own-writes). The no-`stmt`, fresh-context shape is the
 * synchronous analogue of `database-assertions.ts:executeResidualPerTuple`. Shared by the
 * key-filtered residual arms ({@link runResidual}, parameterized) and the whole-body
 * full-rebuild arm ({@link applyFullRebuild}, no params).
 */
export async function runScheduler(ctx: MaterializedViewManagerContext, scheduler: Scheduler, params: Record<string, SqlValue>): Promise<Row[]> {
	const rctx: RuntimeContext = {
		db: ctx as unknown as Database,
		stmt: undefined,
		params,
		context: createStrictRowContextMap(),
		tableContexts: wrapTableContextsStrict(new Map()),
		enableMetrics: false,
	};
	const result = await scheduler.run(rctx);
	const rows: Row[] = [];
	if (isAsyncIterable(result)) {
		for await (const r of result as AsyncIterable<Row>) rows.push(r);
	}
	return rows;
}

/**
 * Compute a **forward** key-filtered residual plan's per-row backing delta and apply it:
 * derive the affected binding key(s) from the changed row (OLD ∪ NEW, deduped), re-run
 * the key-filtered residual against live source state for each, and apply the **keyed
 * diff**: a non-empty recomputed slice is upserted (the backing key IS the affected key,
 * so the upsert replaces the old row wholesale — no delete-first — and the host's
 * value-identical upsert skip turns a no-op recompute into ZERO effective changes
 * instead of delete+insert churn); an emptied slice (residual returns nothing) emits the
 * point delete, removing the stale backing row (nothing reported if it was already
 * absent). Returns the effective {@link BackingRowChange}(s) the backing layer realized,
 * for the MV-over-MV cascade — a real same-key change now reports one `update`.
 *
 * Shared by the single-source aggregate (`'residual-recompute'`, group key, ≤1 row per
 * key) and the 1:1-join (`'join-residual'`, the driving table `T`'s PK, exactly the one
 * joined row per key) arms — both bind on the forward driving source via
 * {@link ForwardResidualPlan}; the only difference is the binding (group vs PK).
 *
 * This is the **cold** (no statement batch in scope) inline path. A statement-batched
 * caller instead accumulates the same deduped keys via
 * {@link collectForwardResidualKeys} and recomputes each distinct key once at the
 * end-of-statement flush ({@link computeForwardResidualOps}) — sound for the same
 * last-write-wins reason: every recompute reads live (reads-own-writes) state, so
 * running it once at flush produces exactly what the last per-row run would have.
 */
export async function applyForwardResidual(
	ctx: MaterializedViewManagerContext,
	plan: ForwardResidualPlan,
	change: BackingRowChange,
	cache?: BackingConnectionCache,
): Promise<BackingRowChange[]> {
	const affected = new Map<string, ForwardResidualKey>();
	collectForwardResidualKeys(plan, change, affected);
	const ops = await computeForwardResidualOps(ctx, plan, affected.values());
	if (ops.length === 0) return [];

	const { host, connection } = await resolveBackingApplyTarget(ctx, plan, cache);
	return host.applyMaintenance(connection, ops);
}

/**
 * Derive one changed source row's affected forward binding key(s) (OLD ∪ NEW) and add
 * them to `into`, deduped on the canonical backing-key values: a non-key-changing update
 * recomputes the group once; a key-changing update recomputes both the old and the new
 * group. `into` may span a whole statement (the per-statement {@link ResidualKeyBatch})
 * or a single change (the cold inline path) — the dedup is identical either way.
 */
export function collectForwardResidualKeys(
	plan: ForwardResidualPlan,
	change: BackingRowChange,
	into: Map<string, ForwardResidualKey>,
): void {
	const addFrom = (row: Row): void => {
		const keyVals = plan.backingPkSourceCols.map(sc => row[sc]);
		const dedupKey = canonKeyValues(keyVals);
		if (into.has(dedupKey)) return;
		into.set(dedupKey, {
			keyTuple: plan.bindColumns.map(c => row[c]),
			keyVals,
			deleteKey: buildPrimaryKeyFromValues(keyVals, plan.backingPkDefinition),
		});
	};
	if (change.op === 'insert') addFrom(change.newRow);
	else if (change.op === 'delete') addFrom(change.oldRow);
	else { addFrom(change.oldRow); addFrom(change.newRow); }
}

/**
 * Run the forward key-filtered residual once per affected key and build the keyed-diff
 * ops: upsert the recomputed slice, or point-delete an emptied key. Pure op computation —
 * the caller owns connection resolution and the single {@link BackingHost.applyMaintenance}
 * call, so a statement flush can batch many keys' ops into one host call.
 */
export async function computeForwardResidualOps(
	ctx: MaterializedViewManagerContext,
	plan: ForwardResidualPlan,
	keys: Iterable<ForwardResidualKey>,
): Promise<MaintenanceOp[]> {
	const ops: MaintenanceOp[] = [];
	for (const { keyTuple, keyVals, deleteKey } of keys) {
		const recomputed = await runResidual(ctx, plan.residualScheduler, plan.bindParamPrefix, keyTuple);
		// Keep only the recomputed rows whose backing key equals the affected key.
		// The residual for key K must only contribute K's slice; any other row is
		// spurious and is dropped. This is the soundness net for an emptied group: when
		// no source row matches the key, a *correct* grouped residual returns zero rows,
		// but a constant-pinned multi-column grouped aggregate is mis-collapsed by the
		// optimizer into a *scalar* aggregate that emits one all-NULL `count=0` row over
		// the empty input (a pre-existing optimizer bug, filed separately as
		// `fix/optimizer-constant-group-aggregate-empty-input-spurious-row`). That row's
		// key ≠ K, so it is filtered here and the delete-without-upsert correctly removes
		// the emptied group's backing row.
		const slice = recomputed.filter(row => residualRowMatchesKey(plan, row, keyVals));
		if (slice.length === 0) {
			// Emptied slice: delete-without-upsert removes the stale backing row (the
			// host reports nothing if the key was already absent).
			ops.push({ kind: 'delete-key', key: deleteKey });
		} else {
			// The slice shares the affected backing key, so each upsert REPLACES the old
			// backing row — no delete-first — and the host's value-identical skip
			// (vtab/backing-host.ts) suppresses a recompute that changed nothing.
			for (const row of slice) ops.push({ kind: 'upsert', row });
		}
	}
	return ops;
}

/**
 * True iff `row`'s backing primary-key columns equal `keyVals` (the affected binding
 * key, in `backingPkDefinition` order), under each column's collation. Used to keep
 * only the residual row(s) belonging to the recomputed key — see
 * {@link applyForwardResidual}.
 */
export function residualRowMatchesKey(plan: ForwardResidualPlan, row: Row, keyVals: readonly SqlValue[]): boolean {
	for (let i = 0; i < plan.backingPkDefinition.length; i++) {
		const d = plan.backingPkDefinition[i];
		if (compareSqlValuesFast(row[d.index], keyVals[i], d.collationFn) !== 0) return false;
	}
	return true;
}

/**
 * Dispatch a `'join-residual'` plan on **which source changed**. A write to the driving
 * table `T` (`changedBase === plan.sourceBase`) is the forward case — recompute the one
 * joined row keyed on `T`'s PK, identical to a size-1 `'row'`-binding residual — so it
 * delegates straight to {@link applyForwardResidual} (delete old backing slice → run the
 * `T`-keyed residual → upsert). A write to the lookup table `P` is the reverse case,
 * handled by {@link applyLookupResidual}.
 */
export async function applyJoinResidual(
	ctx: MaterializedViewManagerContext,
	plan: JoinResidualPlan,
	change: BackingRowChange,
	changedBase: string,
	cache?: BackingConnectionCache,
): Promise<BackingRowChange[]> {
	if (changedBase === plan.sourceBase) {
		return applyForwardResidual(ctx, plan, change, cache);
	}
	return applyLookupResidual(ctx, plan, change, cache);
}

/**
 * Maintain a `'join-residual'` MV for a **lookup-side (`P`)** change: refresh the joined
 * rows referencing each affected `P` key. Derive the affected `P` key(s) from the changed
 * row (OLD ∪ NEW, deduped on `P`'s PK), and for each run the in-scope lookup-keyed residual
 * (`… where P.pk = :pk0`, the body's WHERE retained) against live source state — returning
 * every currently in-scope joined row, each carrying its `T.pk` backing key — and **upsert**
 * each.
 *
 * **Upsert-only is sound for a no-WHERE / `T`-only-WHERE body.** For an inner/cross join with
 * enforced RI and a predicate that cannot reference `P`, the *set* of backing rows referencing
 * a given `P` row is `{ T : T.fk = P.pk }`, determined entirely by `T.fk` (a `T` column the
 * `P` write cannot change), and the WHERE — over `T` only — cannot flip on a `P` write. So a
 * `P` change can only re-derive the lookup-projected columns of those existing backing rows
 * (an upsert at the unchanged `T.pk` key), never add or remove one: a `P` insert with no
 * referencing `T` rows yields an empty residual (no-op); a `P` delete is only admissible (RI)
 * when no `T` references it (empty residual); a `P` payload update upserts the affected rows
 * with the new value.
 *
 * **A `P`-referencing WHERE needs the delete-capable pass.** When the body WHERE references
 * `P`, a `P` write can flip a joined row's WHERE truth and so add or remove its backing row —
 * which the in-scope upsert above (it returns *only* in-scope rows) could never delete. The
 * builder then supplies `lookupMembershipResidualScheduler` (the body with the WHERE stripped,
 * keyed on `P`). Per affected `P` key this runs both residuals against the same live state and
 * applies the **keyed diff**: it **deletes** only the membership keys the in-scope recompute no
 * longer produces (rows that left scope — the delete keys come from live `T` via the join, so
 * they match existing backing keys and touch nothing belonging to another `P`; membership and
 * in-scope rows read the same live state, so their key bytes match exactly), and **upserts**
 * every in-scope row. A row leaving scope is deleted (removed); a row entering scope is
 * upserted (added); an unchanged in-scope row's upsert is suppressed by the host's
 * value-identical skip (vtab/backing-host.ts) — ZERO effective changes instead of the former
 * delete+insert refresh churn; a changed in-scope row reports one `update`. The membership
 * residual MUST ignore the WHERE — else a row leaving scope would never be deleted.
 *
 * A `T`-side membership change (insert/delete/FK-move) is the *forward* path's job and fires
 * its own maintenance. Returns the effective {@link BackingRowChange}(s) for the MV-over-MV
 * cascade. This is the cold inline path; a statement-batched caller accumulates via
 * {@link collectLookupResidualKeys} and recomputes at flush ({@link computeLookupResidualOps})
 * — sound for the same last-write-wins-against-live-state reason as
 * {@link applyForwardResidual}.
 */
export async function applyLookupResidual(
	ctx: MaterializedViewManagerContext,
	plan: JoinResidualPlan,
	change: BackingRowChange,
	cache?: BackingConnectionCache,
): Promise<BackingRowChange[]> {
	const affected = new Map<string, SqlValue[]>();
	collectLookupResidualKeys(plan, change, affected);
	const ops = await computeLookupResidualOps(ctx, plan, affected.values());
	if (ops.length === 0) return [];

	const { host, connection } = await resolveBackingApplyTarget(ctx, plan, cache);
	return host.applyMaintenance(connection, ops);
}

/**
 * Derive one changed lookup-side (`P`) row's affected lookup key(s) (OLD ∪ NEW) and add
 * them to `into`, deduped on `P`'s canonical PK values. The statement-batch counterpart
 * of the derivation inside {@link applyLookupResidual}.
 */
export function collectLookupResidualKeys(
	plan: JoinResidualPlan,
	change: BackingRowChange,
	into: Map<string, SqlValue[]>,
): void {
	const addFrom = (row: Row): void => {
		const keyTuple = plan.lookupBindColumns.map(c => row[c]);
		const dedupKey = canonKeyValues(keyTuple);
		if (!into.has(dedupKey)) into.set(dedupKey, keyTuple);
	};
	if (change.op === 'insert') addFrom(change.newRow);
	else if (change.op === 'delete') addFrom(change.oldRow);
	else { addFrom(change.oldRow); addFrom(change.newRow); }
}

/**
 * Run the lookup-keyed residual variant once per affected `P` key and build the ops —
 * the delete-capable membership diff when the plan carries
 * `lookupMembershipResidualScheduler`, upsert-only otherwise (see
 * {@link applyLookupResidual} for the soundness argument). Pure op computation; the
 * caller owns connection resolution and the single applyMaintenance call.
 */
export async function computeLookupResidualOps(
	ctx: MaterializedViewManagerContext,
	plan: JoinResidualPlan,
	keys: Iterable<SqlValue[]>,
): Promise<MaintenanceOp[]> {
	const ops: MaintenanceOp[] = [];
	for (const keyTuple of keys) {
		const recomputed = await runResidual(ctx, plan.lookupResidualScheduler, plan.lookupBindParamPrefix, keyTuple);
		// Delete-capable (P-referencing WHERE): keyed diff of the membership residual
		// (WHERE stripped) against the in-scope recompute — delete ONLY the membership
		// keys the recompute no longer produces (rows that left the WHERE scope), not
		// every member. Both residuals read the same live state, so a surviving row's
		// key bytes match exactly (the byte-canonical set lookup is exact). Deletes
		// precede upserts, preserving the prior arm's ordering discipline.
		if (plan.lookupMembershipResidualScheduler) {
			const produced = new Set(recomputed.map(row =>
				canonKeyValues(plan.backingPkDefinition.map(d => row[d.index]))));
			const members = await runResidual(ctx, plan.lookupMembershipResidualScheduler, plan.lookupBindParamPrefix, keyTuple);
			for (const row of members) {
				const keyVals = plan.backingPkDefinition.map(d => row[d.index]);
				if (produced.has(canonKeyValues(keyVals))) continue; // still in scope — upserted below
				ops.push({ kind: 'delete-key', key: buildPrimaryKeyFromValues(keyVals, plan.backingPkDefinition) });
			}
		}
		// Upsert every in-scope row; the host's value-identical skip suppresses the
		// unchanged ones (an in-scope refresh that changed nothing reports nothing).
		for (const row of recomputed) ops.push({ kind: 'upsert', row });
	}
	return ops;
}

/**
 * Compute a `'prefix-delete'` plan's per-row backing delta and apply it: derive the
 * affected base key(s) from the changed row (OLD ∪ NEW, deduped on the base key), and
 * for each — re-run the base-PK-keyed residual against live source state and apply the
 * **keyed diff against the existing effective fan-out slice** (read via the host's
 * `scanEffective` with the base prefix, pending over committed — the same contiguous
 * range the former wholesale `'delete-by-prefix'` removed): delete ONLY the existing
 * keys the recompute no longer produces, upsert every recomputed row (the host's
 * value-identical skip suppresses the unchanged ones). A base-PK-changing UPDATE
 * recomputes both the OLD base key (slice diffs to all-deletes; the residual returns
 * nothing for the now-absent old PK) and the NEW base key (new fan-out upserted); a
 * DELETE diffs the old slice to all-deletes; an INSERT diffs against an empty slice
 * (all upserts). An emptied/shrunk fan-out keeps the delete-without-upsert exactly —
 * a disappearance is never "skipped". Returns the effective
 * {@link BackingRowChange}(s) the backing layer realized, for the MV-over-MV cascade.
 *
 * Prefix-scan soundness is unchanged from the wholesale arm: the diff's slice read
 * uses the same binary `equalityPrefix` scan `'delete-by-prefix'` used, sound under
 * the build-time collation gate (the backing base-PK prefix inherits the source PK
 * collation, and source-PK uniqueness collapses each collation class to one binary
 * value). The stored slice's prefix bytes always equal the OLD image's (the slice was
 * projected from that very source row), and OLD ∪ NEW both iterate, so a case-only
 * base-PK rewrite still converges: the OLD-prefix pass pairs the slice with the
 * recomputed rows (key pairing is collation-aware — the btree's identity — so a
 * collation-equal key is REPLACED by its upsert, never also deleted) and the byte
 * change surfaces as `update`s that re-key the stored bytes.
 *
 * Structurally the same as {@link applyForwardResidual}, differing only in the
 * **prefix-slice** diff (one base row owns N backing rows sharing the prefix) and the
 * **N-row** residual. This is the cold inline path; a statement-batched caller
 * accumulates the same deduped base keys via {@link collectPrefixDeleteKeys} and diffs
 * each distinct key once at flush ({@link computePrefixDeleteOps}) — sound because the
 * residual and the effective-slice read both see live (reads-own-writes) state, so the
 * flush-time diff is exactly what the last per-row diff would have produced.
 */
export async function applyPrefixDelete(
	ctx: MaterializedViewManagerContext,
	plan: PrefixDeletePlan,
	change: BackingRowChange,
	cache?: BackingConnectionCache,
): Promise<BackingRowChange[]> {
	const affected = new Map<string, PrefixDeleteKey>();
	collectPrefixDeleteKeys(plan, change, affected);

	// Resolved up front (unlike the point-op arms): the keyed diff reads the existing
	// effective slice before any op exists. The former wholesale arm always emitted ops,
	// so this resolves no more connections than it did.
	const { host, connection } = await resolveBackingApplyTarget(ctx, plan, cache);
	const ops = await computePrefixDeleteOps(ctx, plan, affected.values(), host, connection);
	if (ops.length === 0) return [];
	return host.applyMaintenance(connection, ops);
}

/**
 * Derive one changed base row's affected base key(s) (OLD ∪ NEW) and add them to
 * `into`, deduped on the canonical base-PK values. `keyTuple` binds the residual
 * (`pk{i}`); `prefix` is the slice's leading-PK equality key (the base-PK values in
 * backing-PK order — identical here since the base PK leads the backing PK, but kept
 * distinct for clarity). The statement-batch counterpart of the derivation inside
 * {@link applyPrefixDelete}.
 */
export function collectPrefixDeleteKeys(
	plan: PrefixDeletePlan,
	change: BackingRowChange,
	into: Map<string, PrefixDeleteKey>,
): void {
	const addFrom = (row: Row): void => {
		const keyTuple = plan.bindColumns.map(c => row[c]);
		const dedupKey = canonKeyValues(keyTuple);
		if (into.has(dedupKey)) return;
		into.set(dedupKey, { keyTuple, prefix: plan.backingPrefixSourceCols.map(sc => row[sc]) });
	};
	if (change.op === 'insert') addFrom(change.newRow);
	else if (change.op === 'delete') addFrom(change.oldRow);
	else { addFrom(change.oldRow); addFrom(change.newRow); }
}

/**
 * Per affected base key: run the fan-out residual, read the existing effective slice for
 * the base prefix, and build the keyed-diff ops (delete disappeared keys, upsert the
 * recomputed rows). Pure op computation over the supplied host/connection; the caller
 * owns the single applyMaintenance call, so a statement flush batches many base keys'
 * ops into one host call.
 */
export async function computePrefixDeleteOps(
	ctx: MaterializedViewManagerContext,
	plan: PrefixDeletePlan,
	keys: Iterable<PrefixDeleteKey>,
	host: BackingHost,
	connection: VirtualTableConnection,
): Promise<MaintenanceOp[]> {
	const ops: MaintenanceOp[] = [];
	for (const { keyTuple, prefix } of keys) {
		const recomputed = await runResidual(ctx, plan.residualScheduler, plan.bindParamPrefix, keyTuple);
		// The residual for base key K filters T to K, so every row it returns shares K's
		// base-PK prefix; the prefix-match guard is a defensive soundness net (mirrors
		// the aggregate arm's `residualRowMatchesKey`).
		const slice = recomputed.filter(row => residualRowMatchesBasePrefix(plan, row, prefix));
		// Existing effective fan-out rows for this base prefix (pending over committed).
		const existing: Row[] = [];
		for await (const row of host.scanEffective(connection, { equalityPrefix: prefix })) {
			existing.push(row);
		}
		// Keyed diff. Key pairing is collation-aware over the full backing PK (the btree's
		// identity): a recomputed row whose key is collation-equal to an existing row
		// REPLACES it via the upsert below, so it must not also be deleted. Deletes precede
		// upserts (the wholesale arm's ordering discipline). The delete keys are built from
		// the EXISTING rows' stored values, so the host's collation-aware point lookup
		// always finds them.
		for (const ex of existing) {
			if (slice.some(row => backingPkEqual(plan.backingPkDefinition, row, ex))) continue;
			ops.push({
				kind: 'delete-key',
				key: buildPrimaryKeyFromValues(plan.backingPkDefinition.map(d => ex[d.index]), plan.backingPkDefinition),
			});
		}
		for (const row of slice) ops.push({ kind: 'upsert', row });
	}
	return ops;
}

/**
 * True iff two backing rows agree on every backing-PK column under that column's
 * collation — the btree's key identity. Pairs an existing slice row with the
 * recomputed row that replaces it in {@link applyPrefixDelete}'s keyed diff.
 */
export function backingPkEqual(
	pkDef: ReadonlyArray<BackingPkColumn>,
	a: Row,
	b: Row,
): boolean {
	for (const d of pkDef) {
		if (compareSqlValuesFast(a[d.index], b[d.index], d.collationFn) !== 0) return false;
	}
	return true;
}

/**
 * True iff `row`'s **leading** (base-prefix) backing-PK columns equal `prefixVals` (the
 * affected base key, in backing-PK order), under each column's collation. Keeps only the
 * residual fan-out row(s) belonging to the recomputed base key — see
 * {@link applyPrefixDelete}.
 */
export function residualRowMatchesBasePrefix(plan: PrefixDeletePlan, row: Row, prefixVals: readonly SqlValue[]): boolean {
	for (let i = 0; i < plan.basePrefixLength; i++) {
		const d = plan.backingPkDefinition[i];
		if (compareSqlValuesFast(row[d.index], prefixVals[i], d.collationFn) !== 0) return false;
	}
	return true;
}

/**
 * Accumulate one source change's affected binding key(s) for a residual-arm plan into
 * the per-statement {@link ResidualKeyBatch}, deduped across the whole statement —
 * the deferred-accumulate counterpart of the cold per-row appliers above. Which
 * variant map receives the keys follows the plan kind; a `'join-residual'` change
 * routes on **which source changed** (forward for the driving `T`, lookup for `P`),
 * exactly as {@link applyJoinResidual} dispatches. `planKey` is the MV key
 * (lowercased `schema.name`) the manager indexes the plan under.
 */
export function accumulateResidualKeys(
	plan: ResidualMaintenancePlan,
	change: BackingRowChange,
	changedBase: string,
	batch: ResidualKeyBatch,
	planKey: string,
): void {
	let entry = batch.get(planKey);
	if (!entry) {
		entry = { forward: new Map(), lookup: new Map(), prefix: new Map() };
		batch.set(planKey, entry);
	}
	switch (plan.kind) {
		case 'residual-recompute':
			// Residual keys FIRST, always — they are the delta path's per-group fallback
			// (retraction-unsafe groups, poisoned accumulations), so the delta map is
			// strictly an optimization layered on top, never the only record.
			collectForwardResidualKeys(plan, change, entry.forward);
			if (plan.delta && !entry.deltaPoisoned) {
				accumulateDeltaAggregates(plan, change, entry);
			}
			break;
		case 'prefix-delete':
			collectPrefixDeleteKeys(plan, change, entry.prefix);
			break;
		case 'join-residual': {
			if (changedBase === plan.sourceBase) collectForwardResidualKeys(plan, change, entry.forward);
			else collectLookupResidualKeys(plan, change, entry.lookup);
			break;
		}
	}
}

/**
 * Compute the flush-time ops for one residual-arm MV's accumulated statement keys: run
 * the appropriate residual variant once per distinct key against live post-statement
 * state and concatenate the keyed-diff ops. Distinct keys touch disjoint backing slices
 * — except a `'join-residual'` statement that accumulated both forward and lookup keys,
 * where an overlapping backing row is recomputed twice from the SAME live state, so the
 * duplicate upsert is value-identical and the host suppresses it. The caller owns the
 * single {@link BackingHost.applyMaintenance} call over the combined array — one host
 * round-trip per (MV, flush round) instead of one per source row.
 */
export async function computeResidualBatchOps(
	ctx: MaterializedViewManagerContext,
	plan: ResidualMaintenancePlan,
	entry: ResidualKeyBatchEntry,
	host: BackingHost,
	connection: VirtualTableConnection,
): Promise<MaintenanceOp[]> {
	if (plan.kind === 'prefix-delete') {
		return computePrefixDeleteOps(ctx, plan, entry.prefix.values(), host, connection);
	}
	const ops = await computeForwardResidualOps(ctx, plan, entry.forward.values());
	if (plan.kind === 'join-residual' && entry.lookup.size > 0) {
		ops.push(...await computeLookupResidualOps(ctx, plan, entry.lookup.values()));
	}
	return ops;
}

/**
 * Fold one source change's per-column aggregate contributions into the statement's
 * delta accumulation ({@link ResidualKeyBatchEntry.delta}) — the delta-aggregate
 * counterpart of {@link collectForwardResidualKeys}, called right after it (the
 * residual keys remain the fallback record). Per contributing row image:
 * `step(identity, row[arg])` (zero-arg → `step(identity)`) is the row's contribution;
 * an insert `merge`s it in, a delete `merge`s its `negate`, an update retracts the OLD
 * image into its group and inserts the NEW into its (possibly different) group. A row
 * whose body-WHERE predicate is not unambiguously TRUE contributes nothing — but the
 * raw column value (including NULL) IS fed to `step`, never pre-filtered: NULL-handling
 * is the aggregate's own (law 2), and the row still counts toward the zero-arg
 * multiplicity witness.
 */
export function accumulateDeltaAggregates(
	plan: ResidualRecomputePlan,
	change: BackingRowChange,
	entry: ResidualKeyBatchEntry,
): void {
	const d = plan.delta;
	if (!d) return;
	const delta = entry.delta ?? (entry.delta = new Map<string, DeltaGroupState>());
	const contribute = (row: Row, retract: boolean): void => {
		if (d.predicate && d.predicate.evaluate(row) !== true) return; // out of body scope
		const keyVals = plan.backingPkSourceCols.map(sc => row[sc]);
		const dedupKey = canonKeyValues(keyVals);
		let g = delta.get(dedupKey);
		if (!g) {
			g = {
				keyVals,
				deleteKey: buildPrimaryKeyFromValues(keyVals, plan.backingPkDefinition),
				accs: d.aggColumns.map(c => cloneInitialValue(c.schema.initialValue)),
				retracted: false,
			};
			delta.set(dedupKey, g);
		}
		if (retract) g.retracted = true;
		for (let i = 0; i < d.aggColumns.length; i++) {
			const c = d.aggColumns[i];
			// A tighten-only column (min/max — merge, no negate) cannot retract arithmetically.
			// `g.retracted` was set above, so a retracted group with a tighten column re-derives
			// wholesale from the residual at flush (descriptor.hasTighten) and this accumulator is
			// discarded — so skip the retraction contribution entirely (there is no negate to
			// apply). Its INSERT contributions still fold via merge on the non-retract path below.
			if (retract && c.deltaClass === 'tighten') continue;
			let contrib: AggValue = c.argSourceCol === undefined
				? c.schema.stepFunction(cloneInitialValue(c.schema.initialValue))
				: c.schema.stepFunction(cloneInitialValue(c.schema.initialValue), row[c.argSourceCol]);
			if (retract) contrib = c.algebra.negate!(contrib);
			g.accs[i] = c.algebra.merge(g.accs[i], contrib);
		}
	};
	if (change.op === 'insert') contribute(change.newRow, false);
	else if (change.op === 'delete') contribute(change.oldRow, true);
	else { contribute(change.oldRow, true); contribute(change.newRow, false); }
}

/**
 * Flush-time op computation for a delta-aggregate MV's accumulated statement deltas —
 * the arithmetic read-modify-write that replaces the per-group residual re-execution.
 * Per affected group:
 *  1. read the group's current EFFECTIVE backing row by its full PK (the host's
 *     `scanEffective` equality-prefix point read — pending over committed, so a group
 *     written by an earlier statement of this transaction folds correctly);
 *  2. per aggregate column: base = stored ? `decode(stored[col])` : a fresh identity
 *     accumulator; finalized = `finalize(merge(base, delta))`;
 *  3. the multiplicity witness finalizing to 0 ⇔ the group emptied → `delete-key`
 *     (skipped when no row was stored); otherwise upsert the rebuilt row (group-key
 *     values + finalized aggregates) — the host's value-identical skip suppresses a
 *     net-identity delta (MV-016).
 *
 * **Retraction fallback.** A group that accumulated a retraction re-derives from its
 * residual key (always accumulated alongside, same canonical map key) instead of the
 * arithmetic, in two cases:
 *  - the descriptor has a **tighten** column (min/max — merge, no negate): a retraction
 *    cannot be undone by merge, so the whole group re-derives from live source state
 *    **whether or not a row is stored** (an intra-statement delete of the extreme poisons
 *    even a from-identity net-fold). The residual recomputes every column of the row
 *    (count/sum included), so a mixed group+tighten row is maintained by ONE path — no
 *    double-maintenance;
 *  - otherwise the descriptor is not retraction-safe (an abelian column whose decode is
 *    only an insert-observational witness — a nullable-argument sum) AND a stored row
 *    exists: the stored value cannot prove the true contribution count survives the
 *    retraction, so decoding it is unsound. A group with no stored row needs no fallback
 *    here — a pure abelian net-fold from identity is exact.
 *
 * Zero source reads, no residual execution on the arithmetic path — this is why the
 * delta path also BYPASSES the per-statement degrade-to-rebuild crossover (it is
 * already O(affected groups)).
 */
export async function computeDeltaAggregateOps(
	ctx: MaterializedViewManagerContext,
	plan: ResidualRecomputePlan,
	entry: ResidualKeyBatchEntry,
	host: BackingHost,
	connection: VirtualTableConnection,
): Promise<MaintenanceOp[]> {
	const d = plan.delta;
	if (!d || !entry.delta) return [];
	const ops: MaintenanceOp[] = [];
	const residualFallbackKeys: ForwardResidualKey[] = [];
	for (const [dedupKey, g] of entry.delta) {
		// Effective point read: the full-PK equality prefix selects at most one row
		// (BINARY collations on every PK column are a descriptor gate, so the binary
		// prefix compare in the host's scan is exact).
		let stored: Row | undefined;
		for await (const row of host.scanEffective(connection, { equalityPrefix: [...g.keyVals] })) {
			stored = row;
			break;
		}
		// Residual fallback for a group whose arithmetic cannot be trusted under retraction:
		//  - a **tighten** column (min/max) can never retract arithmetically — a retracted
		//    group re-derives from live state whether or not a row is stored (an intra-statement
		//    delete of the extreme cannot be undone by merge, even from a fresh identity);
		//  - otherwise a not-retraction-safe abelian column (a sum whose decode forgets the true
		//    contribution count) only needs the residual when a stored row must be decoded — its
		//    no-stored net-fold stays exact, so that case keeps the pure arithmetic path.
		// NOTE: the tighten fallback is conservative — ANY retraction rescans the group, even a
		// delete of a provably-non-extreme value. Correct, not minimal. If min/max MVs ever show
		// this rescan as hot, a secondary-index "is this the current extreme?" probe could keep
		// non-extreme deletes on the arithmetic path. Not built now (see docs/mv-maintenance.md
		// § Tighten-only columns).
		if (g.retracted && (d.hasTighten || (stored && !d.retractionSafe))) {
			const fk = entry.forward.get(dedupKey);
			if (!fk) {
				// Impossible: accumulateResidualKeys collects the forward key for every
				// change before the delta contribution, over the same canonical key.
				throw new QuereusError(
					`Internal error: delta-aggregate group of materialized view '${plan.mv.name}' has no forward residual key`,
					StatusCode.INTERNAL,
				);
			}
			residualFallbackKeys.push(fk);
			continue;
		}
		const finals: SqlValue[] = new Array(d.aggColumns.length);
		for (let i = 0; i < d.aggColumns.length; i++) {
			const c = d.aggColumns[i];
			const base: AggValue = stored
				? c.algebra.decode!(stored[c.backingCol])
				: cloneInitialValue(c.schema.initialValue);
			finals[i] = c.schema.finalizeFunction(c.algebra.merge(base, g.accs[i]));
		}
		const mult = finals[d.multiplicityIndex];
		if (mult === 0 || mult === 0n) {
			// Group emptied. The delete is emitted only when a row is stored (a group
			// created and emptied within one statement writes nothing).
			if (stored) ops.push({ kind: 'delete-key', key: g.deleteKey });
			continue;
		}
		const row: Row = new Array(d.backingColumnCount).fill(null);
		for (const gc of d.groupColumns) row[gc.backingCol] = g.keyVals[gc.pkPos];
		for (let i = 0; i < d.aggColumns.length; i++) row[d.aggColumns[i].backingCol] = finals[i];
		// Decomposition-maintained columns (the avg class): derived from the finalized
		// partials, never accumulated. `combine` reproduces the aggregate's own finalize —
		// incl. the empty-group / divide-by-zero case (avg → count 0/NULL ⇒ NULL). The group
		// is non-empty here (multiplicity > 0), so a fully-emptied group is deleted above
		// before combine could divide by zero; a non-empty all-NULL group finalizes count(x)
		// = 0 and combine yields NULL, matching native avg.
		// NOTE: byte-exactness vs a live re-fold holds while a group's integer sum stays
		// ≤ 2^53. `avg`'s live finalize accumulates its own sum as a float, whereas this
		// recombine reads the exact (bigint-capable) stored `sum` partial; the two round
		// differently only once a group sum exceeds the double safe-integer range. If that
		// regime ever becomes reachable, avg's finalize would need bigint accumulation (a
		// change in aggregate.ts), not a change here.
		for (const dc of d.decomposeColumns) {
			row[dc.backingCol] = dc.combine(dc.partialIndices.map(pi => finals[pi]));
		}
		ops.push({ kind: 'upsert', row });
	}
	if (residualFallbackKeys.length > 0) {
		ops.push(...await computeForwardResidualOps(ctx, plan, residualFallbackKeys));
	}
	return ops;
}

/**
 * Invalidate every accumulated delta in the per-statement batch — called by the DML
 * executor when an OR FAIL per-row savepoint ROLLS BACK: the savepoint undoes the
 * failing row's source (and backing) writes, but the JS-side accumulation cannot be
 * unwound, so the folded deltas may carry the reverted row's contribution. The residual
 * keys are unaffected (a reverted key's recompute reads surviving live state and is
 * value-identical → suppressed), so poisoning simply drops the fast path: the flush in
 * the executor's catch routes those entries through the plain residual. One-way for the
 * statement — `deltaPoisoned` also stops later (cascade-driven) delta re-accumulation
 * into the same entry from mixing with an already-flushed-around state.
 */
export function poisonResidualDeltaAccumulations(batch: ResidualKeyBatch): void {
	for (const entry of batch.values()) {
		entry.delta = undefined;
		entry.deltaPoisoned = true;
	}
}
