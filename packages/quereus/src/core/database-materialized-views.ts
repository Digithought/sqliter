/**
 * Materialized-view maintenance: schema-change staleness tracking plus row-time
 * write-through maintenance.
 *
 * Two responsibilities:
 *
 *  1. **Staleness** — a *schema* change to a source table (drop / alter) can break
 *     an MV's body. This manager subscribes to schema-change events and marks any
 *     MV whose body reads a modified/removed source `stale`. The next reference
 *     re-validates the body (erroring with the staleness diagnostic on an
 *     incompatible change); the next successful refresh clears the flag. One
 *     carve-out: a **body-irrelevant** `table_modified` (constraint/stats/tags-only —
 *     columns and physical PK identical, see `isBodyIrrelevantTableChange`) instead
 *     RECOMPILES each live dependent's row-time plan in place
 *     (`tryRecompileMaterializedViewLive`, gated by shape re-derivation), falling
 *     back to mark-stale on any failure — so DROP/ADD/RENAME CONSTRAINT and ANALYZE
 *     no longer de-liven dependents whose backing shape is unaffected. The SAME
 *     subscription also rebuilds a maintained table's compiled **derived-row
 *     constraint validator** when a *constraint-only* dependency — an FK parent or a
 *     subquery-CHECK target, neither a derivation source — is renamed/dropped/re-created
 *     (see {@link MaterializedViewManager.rebuildConstraintValidatorsFor}); without
 *     this the validator, compiled once at registration, would keep resolving against
 *     the dead/renamed incarnation and fail maintenance writes with an internal
 *     module-connect error.
 *
 *  2. **Row-time write-through** (`maintainRowTime`) — the backing table is kept
 *     consistent *synchronously* with each source row-write, driven from the
 *     runtime DML boundary (not at COMMIT). Each MV's maintenance is **cost-gated with a
 *     floor**: the builder matches the body to a bounded-delta arm (the covering-index
 *     inverse projection, an aggregate / lateral-TVF / 1:1-join residual) when one fits —
 *     each source row then maps to a bounded backing delta, no full scan — and otherwise
 *     falls through to the always-correct **full-rebuild floor** (re-evaluate the whole
 *     body, replace the backing). **No body is rejected for its shape;** the only
 *     create-time rejections are non-shape (non-determinism, bag/no-key, no relational
 *     output, and a full-rebuild-only body over a source past the size threshold). The
 *     write targets the backing table's *pending* transaction layer through the same
 *     connection a `select` from the MV uses, so the change is visible mid-transaction
 *     (reads-own-writes) and is committed/rolled-back in lockstep with the source write by
 *     the coordinated commit (see {@link MaterializedViewManager.buildMaintenancePlan}).
 */

import type { SchemaChangeEvent } from '../schema/change-events.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { buildSourceUnionScope } from '../planner/analysis/change-scope.js';
import { isBodyIrrelevantTableChange, tryRecompileMaterializedViewLive } from '../runtime/emit/materialized-view-helpers.js';
import { buildDerivedRowValidator, makePoisonedDerivedRowValidator } from './derived-row-validator.js';
import type { BackingRowChange } from '../vtab/backing-host.js';
import { compareSqlValuesFast, resolveCollationFunctions } from '../util/comparison.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { TableSchema, UniqueConstraintSchema } from '../schema/table.js';
import { coveringMvHonorsIndexCollation, uniqueEnforcementComparators } from '../schema/unique-enforcement.js';
import type { Database } from './database.js';
import type { MaintenanceCollisionEvent } from './database-events.js';
import { splitBaseKey } from '../util/qualified-name.js';
import {
	mvKey,
	planSourceBases,
	isBinaryCollation,
} from './database-materialized-views-analysis.js';
import { Scheduler } from '../runtime/scheduler.js';
import { shouldDegradeToRebuild } from '../planner/cost/index.js';
import type {
	MaterializedViewManagerContext,
	MaintenancePlan,
	InverseProjectionPlan,
	FullRebuildPlan,
	ResidualMaintenancePlan,
	ResidualKeyBatch,
	ResidualKeyBatchEntry,
	CoarseningWatchColumn,
	BackingConnectionCache,
} from './database-materialized-views-plans.js';
import { buildMaintenancePlan } from './database-materialized-views-plan-builders.js';
import {
	applyInverseProjection,
	applyForwardResidual,
	applyJoinResidual,
	applyPrefixDelete,
	accumulateResidualKeys,
	computeResidualBatchOps,
	computeDeltaAggregateOps,
	resolveBackingApplyTarget,
	runScheduler,
	validateDerivedChanges,
	assertNoNullInNotNullSeededPkRowTime,
	enforceParentSideReferentialActions,
} from './database-materialized-views-apply.js';

// Re-exported so existing importers (database.ts, database-external-changes.ts,
// runtime/emit/dml-executor.ts) keep resolving the per-statement maintenance
// structures from this module.
export type { BackingConnectionCache, ResidualKeyBatch } from './database-materialized-views-plans.js';

const log = createLogger('core:materialized-views');

export class MaterializedViewManager {
	private unsubscribeSchemaChanges: (() => void) | null = null;

	/** Compiled maintenance plans keyed by MV `schema.name` (lowercase). */
	private readonly rowTime = new Map<string, MaintenancePlan>();

	/** Source base (lowercased `schema.table`) → set of MV keys with a row-time plan
	 *  reading it. The per-row DML maintenance hook looks plans up by source base. */
	private readonly rowTimeBySource = new Map<string, Set<string>>();

	constructor(private readonly ctx: MaterializedViewManagerContext) {
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			if (event.type === 'table_removed' || event.type === 'table_modified') {
				const changed = `${event.schemaName}.${event.objectName}`.toLowerCase();
				// A **genuine** source `table_modified` (distinct old/new objects). Live
				// dependents are routed through an in-place RECOMPILE that keeps them live
				// when provably unaffected, instead of marked stale — covering BOTH a
				// body-irrelevant change (constraint/stats/tags/default-only — columns + PK
				// identical: DROP/RENAME/ADD CONSTRAINT, declarative FK retargets, ANALYZE,
				// rename propagation's constraint-AST rewrites) AND a structural ALTER
				// (ADD/DROP/ALTER COLUMN) the body provably never reads. The recompile is
				// shape-gated, and for a structural value-semantics ALTER (type/collation)
				// additionally content-stability-gated (see tryRecompileMaterializedViewLive).
				// The synthetic backing-invalidation event emitBackingInvalidation fires with
				// the SAME object as old/new is deliberately NOT genuine (the
				// `oldObject !== newObject` guard) — it must cascade staleness down MV-over-MV
				// chains, never trigger a keep-live recompile.
				const modified = event.type === 'table_modified' && event.oldObject !== event.newObject
					? event
					: undefined;
				// Body-irrelevant is retained ONLY to decide the already-stale skip below,
				// whose semantics differ between the constraint-only and structural cases.
				const bodyIrrelevant = modified !== undefined
					&& isBodyIrrelevantTableChange(modified.oldObject, modified.newObject);
				for (const mv of this.ctx.schemaManager.getAllMaintainedTables()) {
					if (!mv.derivation.sourceTables.includes(changed)) continue;
					// CONSTRAINT-ONLY change on an already-stale dependent: skip entirely.
					// There is no live plan to recompile, only REFRESH may clear a pre-existing
					// flag (the backing may be behind), and re-releasing the (absent) plan /
					// re-emitting invalidation would be pointless churn. A STRUCTURAL change on
					// an already-stale dependent instead FALLS THROUGH to re-emit below — the
					// backing shape may now differ, so cached plans must recompile.
					if (bodyIrrelevant && mv.derivation.stale) continue;
					// Genuine source change on a LIVE dependent: try to keep it live. On success
					// `stale` is untouched, the plan is rebuilt against the new catalog, and NO
					// emitBackingInvalidation fires — the backing stays maintained, so cached plans
					// reading it remain correct (a plan reading the *source* invalidates via its own
					// direct statement dependency on the source table). Any failure (shape mismatch,
					// content not provably stable, ineligible re-plan) falls through to the stale
					// path below, verbatim.
					if (modified !== undefined && !mv.derivation.stale
						&& tryRecompileMaterializedViewLive(this.ctx as unknown as Database, mv, modified.oldObject, modified.newObject)) continue;
					if (!mv.derivation.stale) {
						mv.derivation.stale = true;
						log('Marked materialized view %s.%s stale due to %s on %s', mv.schemaName, mv.name, event.type, changed);
					}
					// A source schema change invalidates the compiled row-time plan;
					// detach it. The MV reads "stale" until refreshed or recreated,
					// which re-registers it.
					this.releaseRowTime(mvKey(mv.schemaName, mv.name));
					// Invalidate any cached prepared-statement plan reading this MV's
					// backing table so it recompiles and re-hits the build-time `stale`
					// guard (see emitBackingInvalidation). This is load-bearing for a plan
					// compiled while the MV was NOT stale: its only schema dependency is the
					// backing table, which the source event never names. (A plan compiled
					// while already stale instead carries a direct dependency on the source —
					// the while-stale build-time re-validation resolves and records it — so
					// the emit is defensive redundancy there, not a correctness requirement.)
					// Emitting per qualifying event (rather than only on the false→true
					// transition) also re-propagates the cascade down an MV-over-MV chain.
					this.emitBackingInvalidation(mv);
				}
				// Rebuild any derived-row validator that depends on the changed table as a
				// CONSTRAINT-ONLY dependency (FK parent / subquery-CHECK target — never a
				// derivation source, handled above). Runs AFTER the source loop so a plan
				// the source path just released is naturally skipped (it is gone from
				// `rowTime`). `matchOwnName` covers the rename: an FK-parent / CHECK-target
				// rename rewrites THIS maintained table's own FK/CHECK in place and fires
				// `table_modified` on the maintained table itself (the original dependency
				// name is gone from the catalog), so the dependency-set match alone misses it.
				// Runs for body-irrelevant events too — this IS the constraint-only-
				// dependency rebuild path; a just-recompiled dependent's validator was
				// already rebuilt fresh inside registerMaterializedView, so the second
				// rebuild here is idempotent.
				this.rebuildConstraintValidatorsFor(changed, /*matchOwnName*/ true);
			} else if (event.type === 'table_added') {
				// A re-created dependency (previously dropped → poisoned or absent-parent
				// fallback validator) self-heals: rebuild any validator that named it. No
				// own-name match — a maintained table's own creation registers its validator
				// directly. The table is already in the catalog when this fires.
				const changed = `${event.schemaName}.${event.objectName}`.toLowerCase();
				this.rebuildConstraintValidatorsFor(changed, /*matchOwnName*/ false);
			} else if (event.type === 'materialized_view_removed') {
				this.releaseRowTime(mvKey(event.schemaName, event.objectName));
			}
		});
	}

	/**
	 * Rebuild the derived-row constraint validator of every registered plan whose
	 * validator depends on `changed` (lowercased `schema.table`): it names `changed`
	 * in {@link DerivedRowConstraintValidator.dependencyTables} (FK parent /
	 * subquery-CHECK target), or — when `matchOwnName` — `changed` IS the maintained
	 * table itself (the rename signal; see {@link subscribeToSchemaChanges}).
	 *
	 * The derivation is unaffected by a constraint-only dependency's DDL, so this
	 * rebuilds the validator ONLY — no {@link releaseRowTime}, no staleness, no
	 * maintenance interruption. The rebuild reads the CURRENT catalog record
	 * (`getMaintainedTable`) so a rename re-resolves against the new name, and
	 * replacing the validator also refreshes its `dependencyTables` (a rename re-keys
	 * `{main.parent}` → `{main.parent2}`, so a later drop of `parent2` is caught too).
	 *
	 * Rebuild-failure handling: a rebuild THROWS when the subquery-CHECK target was
	 * dropped (`buildConstraintChecks` → optimize raises a sited "table not found").
	 * The throw is caught and a {@link makePoisonedDerivedRowValidator} installed, so
	 * (a) this listener never propagates an exception — a schema-change event must not
	 * fail the unrelated DDL that triggered it — and (b) the next derivation write
	 * surfaces the clear sited planning error instead of the stale validator's internal
	 * module-connect failure. The FK-parent-dropped case does NOT throw: the
	 * absent-parent null-guards-only fallback (`buildChildSideFKChecks`) builds cleanly,
	 * so the rebuilt validator is healthy (a non-NULL ref fails with the maintained-table
	 * FK attribution; a NULL ref is admitted under MATCH SIMPLE).
	 */
	private rebuildConstraintValidatorsFor(changed: string, matchOwnName: boolean): void {
		for (const plan of this.rowTime.values()) {
			const validator = plan.derivedRowValidator;
			if (!validator) continue;
			const ownName = `${validator.schemaName}.${validator.tableName}`.toLowerCase();
			if (!validator.dependencyTables.has(changed) && !(matchOwnName && changed === ownName)) continue;
			const currentMv = this.ctx.schemaManager.getMaintainedTable(validator.schemaName, validator.tableName);
			// MV gone (dropped) — `materialized_view_removed` releases the plan separately.
			if (!currentMv) continue;
			try {
				plan.derivedRowValidator = buildDerivedRowValidator(this.ctx as unknown as Database, currentMv);
				log('Rebuilt derived-row validator for %s after schema change on %s', ownName, changed);
			} catch (err) {
				const error = err instanceof QuereusError
					? err
					: new QuereusError(
						`rebuilding derived-row validator for '${ownName}' failed: ${(err as Error).message}`,
						StatusCode.ERROR,
					);
				log('Derived-row validator rebuild for %s failed after schema change on %s (%s); installing poisoned validator',
					ownName, changed, error.message);
				plan.derivedRowValidator = makePoisonedDerivedRowValidator(validator, error);
			}
		}
	}

	/**
	 * Emit a synthetic `table_modified` event for `mv`'s backing table so any cached
	 * prepared-statement plan that reads the backing table directly invalidates →
	 * recompiles → re-hits the build-time `stale` guard in `building/select.ts`.
	 *
	 * A `select … from mv` compiled while the MV was NOT stale resolves to a
	 * `TableReference` against the maintained table itself, so its only schema
	 * dependency is that table. The *source* change event that marks the MV stale never
	 * names the maintained table, so without this emit the cached plan would re-run the
	 * scan and serve stale rows against a structurally-changed source — bypassing the
	 * guard a fresh prepare would hit. (A plan compiled while the MV is *already* stale
	 * is separately safe: the while-stale build-time re-validation resolves the body's
	 * source tables and records them as direct statement dependencies, so a later source
	 * change invalidates it without this emit — verified by the regression suite, which
	 * stays green even with the emit removed for that case.) The `Statement` listener
	 * maps `table_*` → `'table'` and matches on type + objectName (+ optional schemaName)
	 * only, ignoring the payload, so the maintained `TableSchema` is passed as both old/new.
	 *
	 * **Same-object payload contract (load-bearing coupling).** Passing the SAME object
	 * as `oldObject` and `newObject` is what keeps this synthetic event body-RELEVANT to
	 * `isBodyIrrelevantTableChange` (its reference-equality guard) — so it cascades
	 * staleness down an MV-over-MV chain instead of triggering the consumers'
	 * recompile-in-place path. Every genuine `table_modified` emitter passes distinct
	 * old/new objects. If this payload ever changes, change the classifier's guard with
	 * it (see the matching comment in runtime/emit/materialized-view-helpers.ts).
	 *
	 * Safety: the event names the maintained table itself, which is never in its OWN
	 * `sourceTables` (self-reference is rejected at create), so this manager's listener
	 * treats it as a no-op for a plain MV; for an MV-over-MV chain it conservatively
	 * cascades staleness down the producer→consumer DAG (acyclic — a consumer requires
	 * its producer to pre-exist), so the nested notification terminates. If the table
	 * lookup unexpectedly fails the MV is already in a broken state — skip the emit
	 * rather than fabricate a partial event.
	 */
	private emitBackingInvalidation(mv: MaintainedTableSchema): void {
		const backing = this.ctx.schemaManager.getTable(mv.schemaName, mv.name);
		if (!backing) {
			log('Skipping backing invalidation for %s.%s: backing table %s not found (MV already broken)',
				mv.schemaName, mv.name, mv.name);
			return;
		}
		this.ctx.schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName: mv.schemaName,
			objectName: mv.name,
			oldObject: backing,
			newObject: backing,
		});
	}

	/**
	 * Compile + register an MV for row-time write-through maintenance. Always
	 * builds the maintenance plan via {@link buildMaintenancePlan}, which throws on a
	 * body that is not row-time maintainable — the create emitter rolls the MV back on
	 * throw, so an ineligible body errors cleanly at create time.
	 */
	registerMaterializedView(mv: MaintainedTableSchema): void {
		const key = mvKey(mv.schemaName, mv.name);
		// Cache the source-union change-scope so a `select` from this MV projects to
		// its sources in `analyzeChangeScope`: the backing table is maintained off the
		// user change log (synchronously at the DML boundary), so a `Database.watch`
		// on this MV must project to its sources rather than the never-change-logged
		// backing table. v1 is the conservative union of a `full` watch per source.
		mv.derivation.sourceScope = buildSourceUnionScope(mv.derivation.sourceTables);
		this.releaseRowTime(key);
		const plan = buildMaintenancePlan(this.ctx, mv); // throws on ineligible shape
		// Compile the declared-CHECK/FK derived-row validator (undefined when the
		// table declares nothing — the zero-overhead gate). Built here, inside the
		// registration the create/attach paths roll back on throw, so a constraint
		// that cannot compile (e.g. a non-deterministic CHECK without the pragma)
		// errors cleanly at create time.
		plan.derivedRowValidator = buildDerivedRowValidator(this.ctx as unknown as Database, mv);
		// Precompute the weakened-K′-column watch for row-time collision telemetry.
		// `undefined` unless this MV carries a coarsened backing key — the zero-overhead
		// gate that keeps a non-coarsened MV's maintenance path untouched (see
		// {@link detectAndReportCoarseningCollisions}).
		plan.coarseningWatch = this.buildCoarseningWatch(mv);
		this.rowTime.set(key, plan);
		// Index the plan under every source base it reads. Single-source arms index
		// under `sourceBase` only; the 1:1-join arm also indexes under the lookup base
		// so a write to `P` fires maintenance too (handled by the reverse residual).
		for (const base of planSourceBases(plan)) {
			let set = this.rowTimeBySource.get(base);
			if (!set) { set = new Set(); this.rowTimeBySource.set(base, set); }
			set.add(key);
		}
		log('Registered row-time materialized view %s.%s', mv.schemaName, mv.name);
	}

	/** Detach an MV's row-time plan + its source-base index entry (DROP path). */
	unregisterMaterializedView(schemaName: string, name: string): void {
		this.releaseRowTime(mvKey(schemaName, name));
	}

	/**
	 * Force-mark an MV stale: set the flag, detach its row-time plan, and invalidate
	 * cached prepared-statement plans reading its backing so the next reference
	 * re-hits the build-time stale guard. Mirrors the schema-change listener's stale
	 * transition exactly; exposed for the ALTER … RENAME propagation failure path
	 * (a dependent MV whose in-place body rewrite / backing rename / re-registration
	 * failed mid-way must not keep serving its backing as if live).
	 */
	markMaterializedViewStale(mv: MaintainedTableSchema): void {
		if (!mv.derivation.stale) {
			mv.derivation.stale = true;
			log('Marked materialized view %s.%s stale (forced)', mv.schemaName, mv.name);
		}
		this.releaseRowTime(mvKey(mv.schemaName, mv.name));
		this.emitBackingInvalidation(mv);
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		for (const key of [...this.rowTime.keys()]) {
			this.releaseRowTime(key);
		}
	}

	/** Drop a row-time plan and its source-base index entry (DROP / schema-change / re-register). */
	private releaseRowTime(key: string): void {
		const plan = this.rowTime.get(key);
		if (!plan) return;
		this.rowTime.delete(key);
		for (const base of planSourceBases(plan)) {
			const set = this.rowTimeBySource.get(base);
			if (set) {
				set.delete(key);
				if (set.size === 0) this.rowTimeBySource.delete(base);
			}
		}
	}

	/* ──────────────────── convergence ordering ──────────────────── */

	/**
	 * The source bases (lowercased `schema.table`) an MV's body reads — the
	 * dependency edges {@link Database.refreshAllMaterializedViews} orders the
	 * convergence sweep on. A registered (live) MV reports its compiled plan's
	 * bases ({@link planSourceBases} — the same set `rowTimeBySource` indexes it
	 * under). A **stale** MV has no live plan (a body-relevant source change
	 * released it), so its bases come from the recorded
	 * {@link import('../schema/derivation.js').TableDerivation.sourceTables} — the
	 * body's source-table set captured at (re)registration and kept current
	 * through every reshape. That recorded set is identical to what re-planning
	 * the body would derive (the create/refresh path fills it from the same
	 * analysis), but never re-plans a stale body that may no longer plan — so the
	 * ordering pass cannot throw a planning error before the per-MV refresh
	 * surfaces the real staleness diagnostic.
	 */
	sourceBasesFor(mv: MaintainedTableSchema): readonly string[] {
		const plan = this.rowTime.get(mvKey(mv.schemaName, mv.name));
		return plan ? planSourceBases(plan) : mv.derivation.sourceTables;
	}

	/**
	 * All maintained tables in **source-dependency order**: a base MV precedes
	 * every MV whose body reads it (MV-over-MV — in the unified model a base MV's
	 * backing is a table under its own name, so a dependent's
	 * {@link sourceBasesFor} contains that qualified name). A sequential refresh
	 * sweep over this order is correct because refresh is commit-first per MV: a
	 * base MV's backing commits before a dependent's body re-reads it
	 * ({@link Database.refreshAllMaterializedViews}).
	 *
	 * Edges are `sourceBasesFor(mv)` intersected with the MV-key set (a non-MV
	 * source is no ordering constraint); Kahn's algorithm produces the order.
	 * Throws {@link StatusCode.INTERNAL} on a cycle — the create-time gates
	 * (`assertNoSelfReference` / `assertNoDerivationCycle`) reject recursive MVs,
	 * so a cycle here is an impossible-state backstop, never a silently dropped MV.
	 */
	materializedViewRefreshOrder(): MaintainedTableSchema[] {
		const mvs = this.ctx.schemaManager.getAllMaintainedTables();
		const byKey = new Map<string, MaintainedTableSchema>();
		for (const mv of mvs) byKey.set(mvKey(mv.schemaName, mv.name), mv);

		// Prerequisite count (in-degree) + reverse adjacency (base → consumers).
		const indegree = new Map<string, number>();
		const consumers = new Map<string, string[]>();
		for (const key of byKey.keys()) { indegree.set(key, 0); consumers.set(key, []); }

		for (const mv of mvs) {
			const key = mvKey(mv.schemaName, mv.name);
			const prereqs = new Set<string>();
			for (const base of this.sourceBasesFor(mv)) {
				const baseKey = base.toLowerCase();
				// A non-MV source is no ordering constraint; a self-edge is impossible
				// (create-time gate) — skip both, and dedup so a body reading a base
				// twice adds one edge.
				if (baseKey === key || !byKey.has(baseKey) || prereqs.has(baseKey)) continue;
				prereqs.add(baseKey);
				consumers.get(baseKey)!.push(key);
				indegree.set(key, indegree.get(key)! + 1);
			}
		}

		// Kahn: drain zero-in-degree keys in catalog-enumeration order (stable).
		const order: MaintainedTableSchema[] = [];
		const ready: string[] = [];
		for (const key of byKey.keys()) if (indegree.get(key) === 0) ready.push(key);
		while (ready.length > 0) {
			const key = ready.shift()!;
			order.push(byKey.get(key)!);
			for (const dep of consumers.get(key)!) {
				const next = indegree.get(dep)! - 1;
				indegree.set(dep, next);
				if (next === 0) ready.push(dep);
			}
		}

		if (order.length !== mvs.length) {
			throw new QuereusError(
				`materialized-view convergence ordering found a dependency cycle among maintained tables `
					+ `(ordered ${order.length} of ${mvs.length}) — recursive materialized views are rejected at create time`,
				StatusCode.INTERNAL,
			);
		}
		return order;
	}

	/* ──────────────────── coarsening collision telemetry ──────────────────── */

	/**
	 * Precompute the weakened-K′-column watch list for row-time collision telemetry —
	 * one entry per coarsening column of the MV's coarsened backing key. Returns
	 * `undefined` (the zero-overhead gate) unless `mv.derivation.coarsenedKey` is
	 * stamped with ≥1 weakened column: a provable-key or refining-lineage-key MV builds
	 * no watch, so {@link detectAndReportCoarseningCollisions} short-circuits and the
	 * maintenance path is untouched. Each weakened column name resolves to its backing
	 * column index via `mv.columnIndexMap` (the maintained table IS the backing table),
	 * carrying the source → output collations the divergence test needs.
	 */
	private buildCoarseningWatch(mv: MaintainedTableSchema): ReadonlyArray<CoarseningWatchColumn> | undefined {
		const coarsened = mv.derivation.coarsenedKey;
		if (!coarsened || coarsened.weakened.length === 0) return undefined;
		const resolver = this.ctx.getCollationResolver();
		const watch: CoarseningWatchColumn[] = [];
		for (const w of coarsened.weakened) {
			const index = mv.columnIndexMap.get(w.column.toLowerCase());
			// Defensive: a weakened name that does not resolve to a backing column would
			// be a derivation/stamp inconsistency — skip it rather than mis-key the read.
			if (index === undefined) {
				log("Coarsening watch: weakened column '%s' not found on backing %s.%s; skipping",
					w.column, mv.schemaName, mv.name);
				continue;
			}
			watch.push({
				index,
				sourceCollation: w.sourceCollation,
				sourceCollationFn: resolver(w.sourceCollation),
				outputCollation: w.outputCollation,
				column: w.column,
			});
		}
		return watch.length > 0 ? watch : undefined;
	}

	/**
	 * Observe-only row-time collision telemetry: scan the **realized**
	 * {@link BackingRowChange}s a maintenance apply produced and queue a
	 * {@link MaintenanceCollisionEvent} for each one that is a key-coarsening collision —
	 * an `update` whose replaced backing row came from a **distinct source identity**
	 * than the incoming row's, merged under the coarsened backing key K′ (last-writer-win).
	 *
	 * **Zero-overhead gate.** Returns immediately unless `plan.coarseningWatch` is present
	 * (only a coarsened-key MV builds one). A non-coarsened MV never scans `backingChanges`.
	 *
	 * **Criterion.** For each `'update'` change, a weakened K′ column is *diverged* when its
	 * old/new backing values differ under the **source** (pre-coarsening, stricter) collation.
	 * An `update` here means the incoming row landed on an existing backing row sharing K′
	 * under the **output** collation (that is what made the upsert replacing, not inserting);
	 * if those rows are equal under the source collation it is the same source row's value
	 * being updated (e.g. an `email` change — not reported), and if they differ under the
	 * source collation two distinct source identities (`'Bob'`/`'bob'`) collapsed onto one
	 * backing key (reported). `insert`/`delete` changes are never collisions (new key / removal).
	 *
	 * Runs **independently** of the cascade — it neither consumes nor reorders the
	 * `backingChanges` routed onward (observe-only), so an MV-over-MV chain is unperturbed.
	 * The queued event rides the emitter's transaction batching, so a collision inside a
	 * rolled-back transaction reports nothing and does not increment the counter.
	 */
	private detectAndReportCoarseningCollisions(
		plan: MaintenancePlan,
		backingChanges: readonly BackingRowChange[],
	): void {
		const watch = plan.coarseningWatch;
		if (!watch) return;
		const coarsened = plan.mv.derivation.coarsenedKey;
		if (!coarsened) return; // defensive — a watch implies a stamped coarsenedKey
		// K′ key column indices (ALL key columns, in key order) for the event payload's `key`.
		// Resolved once for the whole batch; collisions are rare so this is off the hot path.
		const keyIndices = coarsened.columns.map(name => plan.mv.columnIndexMap.get(name.toLowerCase()) ?? -1);
		const emitter = this.ctx.getEventEmitter();
		for (const change of backingChanges) {
			if (change.op !== 'update') continue;
			const weakenedColumns: string[] = [];
			for (const w of watch) {
				if (compareSqlValuesFast(change.oldRow[w.index], change.newRow[w.index], w.sourceCollationFn) !== 0) {
					weakenedColumns.push(w.column);
				}
			}
			if (weakenedColumns.length === 0) continue;
			const event: MaintenanceCollisionEvent = {
				schemaName: plan.backingSchema,
				tableName: plan.backingTableName,
				key: keyIndices.map(i => change.newRow[i]),
				weakenedColumns,
				oldRow: change.oldRow,
				newRow: change.newRow,
			};
			emitter.queueCollision(event);
		}
	}

	/* ──────────────────── row-time write-through ──────────────────── */

	/**
	 * True iff a row-time covering structure reads `sourceBase` (lowercased
	 * `schema.table`). The DML write boundary consults this synchronously so the
	 * per-row maintenance hook is a zero-allocation no-op when nothing depends on
	 * the written table.
	 */
	hasRowTimePlanFor(sourceBase: string): boolean {
		const set = this.rowTimeBySource.get(sourceBase.toLowerCase());
		return set !== undefined && set.size > 0;
	}

	/**
	 * Synchronously maintain every row-time covering structure on `sourceBase` for
	 * one source row-write. Each plan computes the per-row backing delta (a pure
	 * projection of the changed row) and applies it to the backing table's pending
	 * transaction layer through the connection a `select` from the MV would use —
	 * so the write is visible mid-transaction and rides the coordinated commit.
	 *
	 * **MV-over-MV cascade.** A backing write is itself a row-write that every MV
	 * reading *that backing table* must see. When a plan's backing base has its own
	 * dependents (`rowTimeBySource[backingBase]` non-empty), each effective
	 * {@link BackingRowChange} the write produced is routed back through this method,
	 * recursively. The dependency graph is acyclic (a consumer MV requires its
	 * producer MV to already exist at create time), so this synchronous depth-first
	 * recursion is DAG-ordered — a producer's backing is fully written before its
	 * consumers run — and the whole chain commits/rolls-back atomically on the live
	 * transaction. The leaf fast path (`!rowTimeBySource.has(backingBase)`) keeps a
	 * non-chained MV at exactly today's cost (one map lookup, no recursion). `depth`
	 * feeds the structural-cycle backstop in {@link assertCascadeDepth}.
	 *
	 * `cache` is the optional per-statement {@link BackingConnectionCache}: when the
	 * DML boundary supplies one, every backing (this plan's and each cascade level's)
	 * resolves its connection at most once for the whole statement. The cascade threads
	 * the same cache through, so a multi-level chain amortizes each level's resolution
	 * too. Omitted by the cold enforcement/eviction callers, which re-resolve the same
	 * connection deterministically.
	 *
	 * `deferred` is the optional per-statement deferred-rebuild set (MV keys) and
	 * `residualBatch` the optional per-statement residual key batch. A `'full-rebuild'`
	 * plan re-evaluates the WHOLE body, so applying it per source row is O(rows × body) —
	 * pathological; when the DML boundary supplies a `deferred` set it is instead marked
	 * dirty here (no per-row apply) and rebuilt exactly once at the end-of-statement
	 * {@link flushDeferredMaintenance} boundary. The three **residual** arms
	 * (`'residual-recompute'`, `'prefix-delete'`, `'join-residual'`) are likewise per-key
	 * recomputes whose per-row apply costs a scheduler run each; when the DML boundary
	 * supplies a `residualBatch`, they accumulate their affected binding keys (deduped
	 * across the statement) and recompute once per distinct key at the same flush.
	 * `'inverse-projection'` alone stays per-row-immediate: its delta is a cheap pure
	 * projection AND the covering-UNIQUE enforcement scan depends on its per-row backing
	 * visibility ({@link lookupCoveringConflicts} reads only inverse-projection backings,
	 * so deferring the other arms cannot starve that scan —
	 * {@link findRowTimeCoveringStructure} declines them). A cold caller without the
	 * per-statement structures falls through to the inline per-change apply — a safe,
	 * unamortized fallback (the enforcement/eviction callers only ever name
	 * inverse-projection MVs, but the fallback stays correct for every arm).
	 */
	async maintainRowTime(
		sourceBase: string,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
		deferred?: Set<string>,
		residualBatch?: ResidualKeyBatch,
		depth = 0,
	): Promise<void> {
		const changedBase = sourceBase.toLowerCase();
		const keys = this.rowTimeBySource.get(changedBase);
		if (!keys || keys.size === 0) return;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (!plan) continue;
			// Full-rebuild defers as a dirty mark; the residual arms defer as accumulated
			// binding keys. Both drain at the end-of-statement flush.
			if (plan.kind === 'full-rebuild' && deferred) {
				deferred.add(key);
				continue;
			}
			if (residualBatch && plan.kind !== 'inverse-projection' && plan.kind !== 'full-rebuild') {
				accumulateResidualKeys(plan, change, changedBase, residualBatch, key);
				continue;
			}
			const backingChanges = await this.applyMaintenancePlan(plan, change, changedBase, cache);
			await this.postApplyBackingChanges(plan, backingChanges, cache, deferred, residualBatch, depth + 1);
		}
	}

	/**
	 * The invariant pipeline every realized maintenance delta runs, in order: coarsening
	 * collision telemetry (observe-only; gated on `coarseningWatch`), the NOT-NULL
	 * ordering-seeded-PK guard (no-op unless the MV carries the skew), derived-row
	 * CHECK/FK validation (no-op for a constraint-less table; BEFORE the cascade so a
	 * consumer never consumes an invalid producer row), parent-side referential
	 * enforcement (RESTRICT-walk then declared actions, after `M`'s own image is
	 * validated), then the MV-over-MV cascade — each effective {@link BackingRowChange}
	 * routed back through {@link maintainRowTime} with the SAME per-statement structures,
	 * so a residual consumer accumulates into the batch and a full-rebuild consumer
	 * re-dirties the deferred set. Shared verbatim by the per-row inline path and the
	 * end-of-statement flush ({@link flushDeferredMaintenance}, which calls with
	 * `depth = 0` — its own round bound {@link assertFlushRounds} replaces the recursion
	 * bound {@link assertCascadeDepth} there).
	 */
	private async postApplyBackingChanges(
		plan: MaintenancePlan,
		backingChanges: readonly BackingRowChange[],
		cache: BackingConnectionCache | undefined,
		deferred: Set<string> | undefined,
		residualBatch: ResidualKeyBatch | undefined,
		depth: number,
	): Promise<void> {
		if (backingChanges.length === 0) return;
		this.detectAndReportCoarseningCollisions(plan, backingChanges);
		assertNoNullInNotNullSeededPkRowTime(plan, backingChanges);
		if (plan.derivedRowValidator) {
			await validateDerivedChanges(this.ctx, plan, plan.derivedRowValidator, backingChanges, cache);
		}
		await enforceParentSideReferentialActions(this.ctx, plan, backingChanges);
		const backingBase = `${plan.backingSchema}.${plan.backingTableName}`.toLowerCase();
		if (!this.rowTimeBySource.has(backingBase)) return; // leaf — no dependents
		if (depth > 0) this.assertCascadeDepth(depth, backingBase);
		for (const bc of backingChanges) {
			await this.maintainRowTime(backingBase, bc, cache, deferred, residualBatch, depth);
		}
	}

	/**
	 * Flush the per-statement deferred maintenance at the end-of-statement boundary:
	 * recompute every accumulated residual key exactly once per distinct key
	 * ({@link applyResidualBatch}) and rebuild every dirtied full-rebuild MV exactly once
	 * (not once per source row), cascading each apply's effective
	 * {@link BackingRowChange}(s) onward so MV-over-MV consumers converge.
	 *
	 * Drained as a worklist over the producer→consumer DAG. Each apply routes its realized
	 * delta back through {@link maintainRowTime} with the SAME `deferred` set and
	 * `residualBatch`: an inverse-projection consumer applies inline; a residual consumer
	 * accumulates its keys into the batch and a full-rebuild consumer re-dirties into the
	 * drain (recomputed in a later round, after its producer's delta has landed). The drain
	 * proceeds in **rounds** — each round snapshots both structures, clears them, and
	 * applies each member, collecting the next round's re-accumulations — so a consumer is
	 * never permanently stale (a producer flushed in the same round re-accumulates it for
	 * the next), and convergence takes at most one round per level of the deferred sub-DAG.
	 * Residual entries drain before rebuilds within a round (arbitrary for correctness —
	 * every apply reads live state — but it lets a same-round rebuild read its residual
	 * producers' already-flushed backings, saving a round in mixed chains).
	 *
	 * Termination: the dependency DAG is acyclic (a consumer MV requires its producer to
	 * pre-exist), so the longest deferred chain — hence the round count — is bounded by
	 * the registered-row-time-MV count. Exceeding it signals a structurally-impossible cycle
	 * and fails loud ({@link assertFlushRounds}) — the worklist analogue of
	 * {@link assertCascadeDepth}. This should never fire.
	 *
	 * The DML executor calls this INSIDE the statement-atomicity savepoint (after the row
	 * loop, before the savepoint release), so a failed recompute/rebuild — including a
	 * derived-row validation failure or parent-side RESTRICT over the flushed delta — rolls
	 * the whole statement back with the same attribution as the per-row path. Empty
	 * structures are a no-op (no overhead on statements touching no deferred MV).
	 */
	async flushDeferredMaintenance(
		deferred: Set<string>,
		residualBatch: ResidualKeyBatch,
		cache?: BackingConnectionCache,
	): Promise<void> {
		let round = 0;
		while (deferred.size > 0 || residualBatch.size > 0) {
			this.assertFlushRounds(++round);
			const residuals = [...residualBatch.entries()];
			residualBatch.clear();
			const rebuilds = [...deferred];
			deferred.clear();
			for (const [key, entry] of residuals) {
				const plan = this.rowTime.get(key);
				// Only residual-arm plans ever accumulate keys; a plan released (or
				// re-registered as a different arm) mid-statement is a no-op here.
				if (!plan || plan.kind === 'inverse-projection' || plan.kind === 'full-rebuild') continue;
				const backingChanges = await this.applyResidualBatch(plan, entry, cache);
				await this.postApplyBackingChanges(plan, backingChanges, cache, deferred, residualBatch, 0);
			}
			for (const key of rebuilds) {
				const plan = this.rowTime.get(key);
				// Only full-rebuild plans are ever deferred; a non-full-rebuild key (or a
				// plan released mid-flush) is a no-op. Defensive — `maintainRowTime` only
				// ever adds `'full-rebuild'` keys.
				if (!plan || plan.kind !== 'full-rebuild') continue;
				const backingChanges = await this.applyFullRebuild(plan, cache);
				await this.postApplyBackingChanges(plan, backingChanges, cache, deferred, residualBatch, 0);
			}
		}
	}

	/**
	 * Flush one residual-arm MV's accumulated statement keys: run the residual variant
	 * once per distinct key against live post-statement state and apply all resulting ops
	 * in one {@link BackingHost.applyMaintenance} call (upsert recomputed slices, delete
	 * emptied keys — the same keyed diff the per-row path applies, evaluated once per key
	 * instead of once per touching row).
	 *
	 * **Per-statement rebuild demotion** ({@link shouldDegradeToRebuild}, re-costed here
	 * against the statement's ACTUAL distinct-key count and the plan's create-time
	 * {@link MaintenancePlanCommon.sourceStats}): when k residual runs cost more than one
	 * whole-body rebuild — a statement touching most groups — run the plan's
	 * {@link ResidualArmCommon.fullRebuildScheduler} and apply a single `'replace-all'`
	 * keyed diff instead. Stateless: the stored strategy is unchanged, so a later
	 * low-cardinality statement reverts to per-key residuals. Kept on the manager
	 * (delegating op computation to the apply-module free helpers) so the statement-flush
	 * suites can instrument it alongside {@link applyFullRebuild}.
	 */
	private async applyResidualBatch(
		plan: ResidualMaintenancePlan,
		entry: ResidualKeyBatchEntry,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		const distinctKeys = entry.forward.size + entry.lookup.size + entry.prefix.size;
		if (distinctKeys === 0) return [];
		// Delta-aggregate fast path: an eligible aggregate MV's accumulated per-group
		// deltas are applied by arithmetic read-modify-write on the stored group rows
		// (computeDeltaAggregateOps) — zero source reads. It BYPASSES the
		// degrade-to-rebuild crossover below: that crossover trades k residual
		// re-executions against one whole-body rebuild, and the delta path already
		// costs O(affected groups) with no residual runs, so the rebuild can never win.
		// A poisoned accumulation (OR FAIL per-row revert — see
		// poisonResidualDeltaAccumulations) has `delta` dropped and falls through to
		// the plain residual over the always-accumulated forward keys.
		if (plan.kind === 'residual-recompute' && plan.delta && entry.delta && !entry.deltaPoisoned) {
			const { host, connection } = await resolveBackingApplyTarget(this.ctx, plan, cache);
			const ops = await computeDeltaAggregateOps(this.ctx, plan, entry, host, connection);
			if (ops.length === 0) return [];
			return host.applyMaintenance(connection, ops);
		}
		if (plan.fullRebuildScheduler && shouldDegradeToRebuild(distinctKeys, plan.sourceStats)) {
			return this.applyReplaceAll(plan, plan.fullRebuildScheduler, cache);
		}
		const { host, connection } = await resolveBackingApplyTarget(this.ctx, plan, cache);
		const ops = await computeResidualBatchOps(this.ctx, plan, entry, host, connection);
		if (ops.length === 0) return [];
		return host.applyMaintenance(connection, ops);
	}

	/**
	 * Round backstop for {@link flushDeferredMaintenance}. The full-rebuild sub-DAG is acyclic,
	 * so the drain converges in at most one round per chain level — bounded by the row-time
	 * MV count. A round count beyond that (`+1` slack for an initial dirty set already
	 * spanning multiple levels) signals a structural impossibility (a cycle) — fail loud
	 * rather than spin. This should never fire.
	 */
	private assertFlushRounds(round: number): void {
		if (round > this.rowTime.size + 1) {
			throw new QuereusError(
				`materialized-view deferred-rebuild flush exceeded maximum rounds (${this.rowTime.size + 1}) — `
					+ `a row-time dependency cycle should be structurally impossible`,
				StatusCode.INTERNAL,
			);
		}
	}

	/**
	 * Defense-in-depth backstop for the cascade. Cycles are structurally impossible
	 * (a consumer MV can only be created once its producer exists, and an MV's source
	 * set is fixed at create), so a valid chain descends at most once per registered
	 * row-time MV. A depth beyond that count signals a structural impossibility (a
	 * cycle) — fail loud with `INTERNAL` naming the backing base rather than overflow
	 * the stack. This should never fire.
	 */
	private assertCascadeDepth(depth: number, backingBase: string): void {
		if (depth > this.rowTime.size) {
			throw new QuereusError(
				`materialized-view cascade exceeded maximum depth (${this.rowTime.size}) at backing `
					+ `'${backingBase}' — a row-time dependency cycle should be structurally impossible`,
				StatusCode.INTERNAL,
			);
		}
	}

	/* ──────────────────── maintenance dispatch ──────────────────── */

	/**
	 * Dispatch a maintenance plan on its `kind`, compute the per-row backing delta,
	 * apply it, and return the **effective** {@link BackingRowChange}(s) the backing
	 * layer realized (so the cascade can drive this plan's own dependents). The builder
	 * yields `'inverse-projection'` (covering-index shape), `'residual-recompute'`
	 * (single-source aggregate), `'prefix-delete'` (single-source lateral-TVF fan-out), and
	 * `'full-rebuild'` (the floor — re-evaluate the whole body and replace the backing). The
	 * floor ignores the specific `change` (it rebuilds wholesale); the others derive a
	 * bounded per-row delta from it.
	 *
	 * The dispatch stays on the manager (the per-arm appliers live in
	 * database-materialized-views-apply.ts as free functions over the manager context); it
	 * is the seam the row-time equivalence suite instruments to observe the effective
	 * changes a maintenance apply realizes.
	 */
	private async applyMaintenancePlan(
		plan: MaintenancePlan,
		change: BackingRowChange,
		changedBase: string,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		switch (plan.kind) {
			case 'inverse-projection':
				return applyInverseProjection(this.ctx, plan, change, cache);
			case 'residual-recompute':
				return applyForwardResidual(this.ctx, plan, change, cache);
			case 'prefix-delete':
				return applyPrefixDelete(this.ctx, plan, change, cache);
			case 'join-residual':
				return applyJoinResidual(this.ctx, plan, change, changedBase, cache);
			case 'full-rebuild':
				return this.applyFullRebuild(plan, cache);
			default: {
				// A new arm added to MaintenancePlan must extend this dispatch; the
				// never-assignment makes that a compile error rather than a silent
				// fall-through (noImplicitReturns is off in this package).
				const exhaustiveCheck: never = plan;
				throw new QuereusError(
					`unknown maintenance plan kind: ${(exhaustiveCheck as MaintenancePlan).kind}`,
					StatusCode.INTERNAL,
				);
			}
		}
	}

	/**
	 * Maintain a `'full-rebuild'` MV: re-evaluate the **whole** body against live
	 * mid-transaction source state and replace the backing transactionally. Run the cached
	 * {@link FullRebuildPlan.bodyScheduler} to completion (no params — reads-own-writes via
	 * the same fresh-context path the residual arms use), collect every recomputed row, and
	 * apply a single `'replace-all'` MaintenanceOp: a keyed diff (by backing PK) of
	 * the recomputed rows against the backing's current pending-layer contents (insert/
	 * update/delete, identical rows skipped). The diff rides the backing's **pending**
	 * `TransactionLayer`, so it commits/rolls-back in lockstep with the source write, and the
	 * returned effective {@link BackingRowChange}(s) drive the MV-over-MV cascade unchanged.
	 *
	 * Unlike the bounded-delta arms this ignores the specific changed row — the floor
	 * rebuilds wholesale. It is therefore deferred to a single end-of-statement flush
	 * ({@link flushDeferredMaintenance}) rather than run per source row, so a bulk statement
	 * rebuilds exactly once; this is that one rebuild. An empty body (zero rows) yields a
	 * `'replace-all' []`, which empties the backing. Kept on the manager (delegating the
	 * scan / backing write to the apply-module free helpers) so the per-statement-flush
	 * deferral suite can instrument it to count rebuilds.
	 */
	private async applyFullRebuild(
		plan: FullRebuildPlan,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		return this.applyReplaceAll(plan, plan.bodyScheduler, cache);
	}

	/**
	 * Run a whole-body scheduler to completion against live mid-transaction source state
	 * and apply the single `'replace-all'` keyed diff. The shared kernel of the
	 * full-rebuild floor ({@link applyFullRebuild}) and the residual arms' per-statement
	 * rebuild demotion ({@link applyResidualBatch}).
	 */
	private async applyReplaceAll(
		plan: MaintenancePlan,
		bodyScheduler: Scheduler,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		const rows = await runScheduler(this.ctx, bodyScheduler, {});
		const { host, connection } = await resolveBackingApplyTarget(this.ctx, plan, cache);
		return host.applyMaintenance(connection, [{ kind: 'replace-all', rows }]);
	}

	/* ──────────────── row-time covering enforcement ──────────────── */

	/**
	 * Resolve the linked, enforcement-ready covering MV for a UNIQUE constraint on
	 * `schema.table`, or `undefined`. The constraint's `coveringStructureName`
	 * forward pointer (set by the eager prove-and-link) is the source of truth;
	 * this confirms a live row-time plan exists for the source, the MV is not
	 * `stale` (structural breakage), and the plan is **per-row maintained** — only
	 * then is its backing table row-time consistent enough to answer conflict
	 * resolution. Only the `'inverse-projection'` arm qualifies: every other arm —
	 * the `'full-rebuild'` floor and the residual arms — is deferred to the
	 * end-of-statement flush (its backing lags the source mid-statement), so it can
	 * never serve as a covering structure for a synchronous per-row UNIQUE probe —
	 * all are skipped here regardless of any (informational) `coveringStructureName`
	 * link, which keeps an eligibility flip from opening a stale-read enforcement
	 * path. O(1) negative fast path off {@link rowTimeBySource} so a source table
	 * with no row-time covering MV pays a single map lookup and stays on the
	 * synchronous index/scan path.
	 *
	 * **Collation eligibility gate.** A covering MV generates its conflict candidates
	 * by re-comparing each backing row under the SOURCE column's DECLARED collation
	 * ({@link lookupCoveringConflicts} / {@link tryBuildCoveringPrefix}), while the
	 * re-validators (store `findUniqueConflictViaCoveringMv`, memory
	 * `checkUniqueViaMaterializedView`) filter under the index per-column collation. The
	 * candidate set is a sound *superset* of the index-collation matches — safe to filter
	 * down — only when the index collation is coarser-or-equal to the declared collation
	 * per constrained column (see {@link coveringMvHonorsIndexCollation}). For a
	 * finer/incomparable index-derived UNIQUE (e.g. a coarser NOCASE index over a BINARY
	 * column) the candidate set may be a *subset* that silently misses conflicts, so the
	 * MV is declined here and enforcement falls back to the per-scan / auto-index path
	 * (already correct under the index collation). All three callers (store, memory,
	 * lens-prover) consult this resolver, so they decline the same MV in lockstep and
	 * candidate generation never runs for a declined MV. This gate is load-bearing, not
	 * mere defense-in-depth: the covering-link prover's own collation gate compares the
	 * OUTPUT column collation against the DECLARED base-column collation (not the index
	 * collation), so it DOES link a coarser-index covering MV — confirmed by the
	 * premise-check test in `covering-structure.spec.ts`.
	 */
	findRowTimeCoveringStructure(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): MaintainedTableSchema | undefined {
		const sourceBase = `${schemaName}.${tableName}`.toLowerCase();
		const keys = this.rowTimeBySource.get(sourceBase);
		if (!keys || keys.size === 0) return undefined; // O(1) negative fast path
		const mvName = this.resolveCoveringStructureName(schemaName, tableName, uc);
		if (!mvName) return undefined;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (!plan) continue;
			const mv = plan.mv;
			if (mv.name !== mvName) continue; // must be THE linked covering MV
			// Only the inverse-projection arm is per-row maintained; every other arm —
			// the full-rebuild floor AND the residual arms — is reconciled at the
			// end-of-statement flush, so its backing lags the source mid-statement and
			// cannot answer a synchronous per-row UNIQUE probe.
			if (plan.kind !== 'inverse-projection') return undefined;
			if (mv.derivation.stale) return undefined; // not row-time consistent
			// Decline the MV when its declared-collation candidate set is not a sound
			// superset of the index-collation matches (finer/incomparable index-derived
			// UNIQUE). Resolve the source schema for the declared/index collations; if it
			// cannot be resolved, fall through to the existing behavior rather than throw
			// (mirrors the `if (!index) …` tolerance elsewhere).
			const sourceSchema = this.ctx._findTable(tableName, schemaName);
			if (sourceSchema && !coveringMvHonorsIndexCollation(sourceSchema, uc)) return undefined;
			return mv;
		}
		return undefined;
	}

	/**
	 * Resolve a constraint's `coveringStructureName` forward pointer. Prefers the
	 * pointer already on the passed `uc` (the memory source shares the
	 * schema-manager's frozen constraint, so the eager link's mutation is visible).
	 * A store source holds a *copied* schema whose constraint never received the
	 * mutation, so fall back to the authoritative schema-manager constraint matched
	 * by column set — keeping the covering-structure lookup module-agnostic.
	 */
	private resolveCoveringStructureName(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): string | undefined {
		if (uc.coveringStructureName) return uc.coveringStructureName;
		const table = this.ctx._findTable(tableName, schemaName);
		const live = table?.uniqueConstraints?.find(c =>
			c.columns.length === uc.columns.length
			&& c.columns.every((col, i) => col === uc.columns[i]));
		return live?.coveringStructureName;
	}

	/**
	 * Point-look up the covering MV's backing table for rows whose backing columns
	 * equal `newRow`'s UNIQUE-constraint values, recover each conflicting **source**
	 * PK from the projected PK columns, and exclude the row being written
	 * (`newSourcePk`). Returns the conflicting source PK(s) — the caller resolves
	 * IGNORE/ABORT/REPLACE against its own source storage (recovering the live
	 * source row and validating the candidate against it, since the backing entry
	 * for an internally-deleted/updated source row can lag within a statement).
	 *
	 * Reads-own-writes: the scan resolves to the backing table's coordinated
	 * connection (the same one {@link maintainRowTime} writes), so the backing
	 * reflects all prior rows of the statement. The backing is hosted by whatever
	 * backing-host-capable module the MV declared (`memory` by default, the store
	 * module under `using store`), independent of the source module — the host's
	 * `scanEffective` abstracts the storage.
	 *
	 * The conflict check is a **backing-PK prefix scan** keyed on `newRow`'s UC
	 * values — O(log n + matches) rather than the former O(n) full backing scan.
	 * Soundness rests on the covering-index shape: the body's `order by` columns are
	 * a permutation of the UC columns ({@link buildMaintenancePlan} eligibility +
	 * the coverage prover), and they seed the leading backing-PK columns
	 * (`computeBackingPrimaryKey`), so the leading `k = uc.columns.length` backing-PK
	 * columns are exactly the UC columns. {@link tryBuildCoveringPrefix} builds the
	 * equality prefix in backing-PK column order; the scan seeks to it and
	 * early-terminates when the leading columns stop matching. It falls back to a
	 * full scan whenever the fast-path gate fails (non-BINARY collation, or a
	 * leading-prefix shape that does not lead with exactly the UC columns) — the
	 * full scan re-compares with the source collation, so the fallback is
	 * collation-correct. Either way the result is only a *candidate* set: the caller
	 * validates each against the live source row.
	 */
	async lookupCoveringConflicts(
		mv: MaintainedTableSchema,
		uc: UniqueConstraintSchema,
		newRow: Row,
		newSourcePk: readonly SqlValue[],
	): Promise<Array<{ pk: SqlValue[]; row?: Row }>> {
		const plan = this.rowTime.get(mvKey(mv.schemaName, mv.name));
		if (!plan) return [];
		// Covering-conflict resolution reads the inverse projection (source↔backing
		// column map). Only the `'inverse-projection'` arm carries it; the other arms do
		// not cover a source UNIQUE constraint in the covering sense, so a covering
		// structure is never linked to one — defensively skip if reached.
		if (plan.kind !== 'inverse-projection') return [];

		const [srcSchemaName, srcTableName] = splitBaseKey(plan.sourceBase);
		const sourceSchema = this.ctx._findTable(srcTableName, srcSchemaName);
		if (!sourceSchema) return [];

		// Inverse projection: source column index → backing column index (first
		// occurrence). Only the passthrough projectors carry a source-column identity
		// (a computed `'expr'` column has no inverse), and the eligibility gate forces
		// every PK / UNIQUE-covered column to be passthrough, so conflict resolution is
		// unaffected by any extra computed columns the body also projects.
		const sourceColToBacking = new Map<number, number>();
		plan.projectors.forEach((p, backingCol) => {
			if (p.kind === 'passthrough' && !sourceColToBacking.has(p.sourceCol)) {
				sourceColToBacking.set(p.sourceCol, backingCol);
			}
		});

		const ucBackingCols: number[] = [];
		for (const c of uc.columns) {
			const b = sourceColToBacking.get(c);
			if (b === undefined) return []; // the prover guarantees this; defensive
			ucBackingCols.push(b);
		}
		const pkDef = sourceSchema.primaryKeyDefinition;
		const pkBackingCols: number[] = [];
		for (const d of pkDef) {
			const b = sourceColToBacking.get(d.index);
			if (b === undefined) return [];
			pkBackingCols.push(b);
		}

		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) return [];
		const { host, connection } = await resolveBackingApplyTarget(this.ctx, plan);

		// Both comparisons below run per scanned backing row, so resolve their collations
		// once here, against this database (a redefined NOCASE must be honored).
		//
		// These are the source column's **declared** collations, NOT the constraint's
		// enforcement collation (`uniqueEnforcementCollations`, which prefers the index's
		// per-column collation). That is deliberate: this method generates conflict
		// *candidates* which the re-validators then filter under the index collation, and
		// the declared-collation candidate set is a sound superset only because
		// `findRowTimeCoveringStructure` declines any MV whose index collation is finer or
		// incomparable (`coveringMvHonorsIndexCollation`). Swapping in the enforcement
		// collation here would break that pairing — do not "DRY" these together.
		const resolver = this.ctx.getCollationResolver();
		const ucCollationFns = resolveCollationFunctions(
			resolver, uc.columns.map(c => sourceSchema.columns[c]?.collation));
		const pkCollationFns = resolveCollationFunctions(
			resolver, pkDef.map(d => d.collation));

		// Collation alone is not the whole identity notion: a semantic-ordering column
		// (`docs/types.md` § Semantic ordering — TIMESPAN's 'PT1H' == 'PT60M') calls two
		// different spellings one value, and both backends key such a column through the
		// type's `compare`. Route both comparisons through the shared constructor so a
		// candidate that is semantically equal but textually different is not dropped here
		// before the re-validators ever see it. Orthogonal to the declared-vs-enforcement
		// collation choice above: the two spellings are one value at EVERY site, so
		// admitting them keeps the candidate set a superset either way.
		const ucComparators = uniqueEnforcementComparators(sourceSchema.columns, uc.columns, ucCollationFns);
		const pkComparators = uniqueEnforcementComparators(
			sourceSchema.columns, pkDef.map(d => d.index), pkCollationFns);

		const conflicts: Array<{ pk: SqlValue[]; row?: Row }> = [];
		// Fast path: a backing-PK prefix scan keyed on `newRow`'s UC values. The
		// covering-index shape guarantees the leading backing-PK columns are the UC
		// columns, so this seeks to the matching block and early-terminates instead of
		// scanning the whole backing. `undefined` ⇒ the gate failed (non-binary
		// collation / unexpected shape) and we fall back to the full effective scan,
		// which re-compares with the source collation and is therefore
		// collation-correct. The host executes the scan over the connection's
		// effective (reads-own-writes) state; the binary-collation soundness gate
		// stays engine-side in {@link tryBuildCoveringPrefix}.
		const equalityPrefix = this.tryBuildCoveringPrefix(plan, uc, sourceSchema, newRow);
		for await (const backingRow of host.scanEffective(connection, { equalityPrefix })) {
			let match = true;
			for (let k = 0; k < uc.columns.length; k++) {
				if (ucComparators[k](newRow[uc.columns[k]], backingRow[ucBackingCols[k]]) !== 0) {
					match = false;
					break;
				}
			}
			if (!match) continue;

			const sourcePk = pkBackingCols.map(b => backingRow[b]);
			// Exclude the row currently being written (its own source PK).
			let isSelf = sourcePk.length === newSourcePk.length;
			for (let i = 0; isSelf && i < sourcePk.length; i++) {
				if (pkComparators[i](sourcePk[i], newSourcePk[i]) !== 0) isSelf = false;
			}
			if (isSelf) continue;

			conflicts.push({ pk: sourcePk });
		}
		return conflicts;
	}

	/**
	 * Build the backing-PK equality prefix for a covering-conflict scan, or
	 * `undefined` to fall back to the full backing scan.
	 *
	 * The covering-index shape guarantees the body's `order by` columns are a
	 * permutation of the UC columns and that they seed the leading backing-PK columns
	 * (`computeBackingPrimaryKey`). So the leading `k = uc.columns.length` backing-PK
	 * columns are exactly the UC columns (as a set, possibly reordered by `order by`).
	 * The returned prefix is keyed in **backing-PK column order** (not `uc.columns`
	 * order), so a permuting `order by` still seeks to the right block:
	 * `prefix[i] = newRow[ sourceCol(backingPkDefinition[i]) ]`.
	 *
	 * Returns `undefined` (full-scan fallback) when any holds:
	 *  - fewer than `k` backing-PK columns, or a leading column is not a passthrough
	 *    of a source column (defensive — the covering shape guarantees passthrough);
	 *  - the leading `k` backing-PK columns do not map to **exactly** the UC
	 *    source-column set (defensive guard against a non-UC-leading structure);
	 *  - any leading backing-PK column, or its source UC column, has a **non-BINARY**
	 *    collation. This is a *soundness* gate, not a perf choice: the scan request
	 *    carries no collation names, so the prefix seek's early-termination resolves its
	 *    comparators at the BINARY floor (`resolveScanComparators`), while the
	 *    backing btree orders the PK by its declared collation and the UNIQUE
	 *    constraint conflicts by the source collation. Under a non-binary collation
	 *    the binary early-termination could `break` before a collated-equal /
	 *    binary-different conflict, missing it. The full-scan fallback re-compares
	 *    with the source collation, so it stays collation-correct.
	 *
	 * DESC-leading prefixes are admitted: equality on a column makes its order
	 * direction irrelevant to *grouping* (the binary-equal rows stay contiguous), and
	 * `scanLayer`'s `equalityPrefix` seek + ascending walk lands at the group start
	 * for either direction (verified by the `order by … desc` enforcement test).
	 */
	private tryBuildCoveringPrefix(
		plan: InverseProjectionPlan,
		uc: UniqueConstraintSchema,
		sourceSchema: TableSchema,
		newRow: Row,
	): SqlValue[] | undefined {
		const k = uc.columns.length;
		const backingPk = plan.backingPkDefinition;
		if (backingPk.length < k) return undefined;

		const ucSourceCols = new Set(uc.columns);
		const leadingSourceCols = new Set<number>();
		const prefix: SqlValue[] = [];
		for (let i = 0; i < k; i++) {
			const d = backingPk[i];
			const projector = plan.projectors[d.index];
			if (!projector || projector.kind !== 'passthrough') return undefined;
			// Soundness: both the backing-PK column (btree ordering / early-termination)
			// and its source UC column (UNIQUE semantics) must be BINARY for the binary
			// prefix-equality scan to neither over- nor under-match.
			//
			// NOTE: a semantic-ordering column (TIMESPAN — 'PT1H' == 'PT60M') declares no
			// collation, so `isBinaryCollation` returns true and it PASSES this gate. That is
			// correct, not an oversight: both backings key such a column through the type
			// (memory via `createTypedComparator` in `resolveScanComparators`, the store via
			// `storeSemanticKeyTransform` — TIMESPAN's `groupKey`, JSON's structural byte
			// encoder), so equal-value rows are physically contiguous and the seek lands on
			// the whole group regardless of spelling — the early-termination cannot `break`
			// before a semantically-equal conflict. Do not "fix" the gate to decline these
			// columns; it would silently lose the fast path.
			if (!isBinaryCollation(d.collation)) return undefined;
			const sourceCol = projector.sourceCol;
			if (!isBinaryCollation(sourceSchema.columns[sourceCol]?.collation)) return undefined;
			leadingSourceCols.add(sourceCol);
			prefix.push(newRow[sourceCol]);
		}

		// The leading `k` backing-PK columns must be exactly the UC source columns.
		if (leadingSourceCols.size !== ucSourceCols.size) return undefined;
		for (const c of ucSourceCols) {
			if (!leadingSourceCols.has(c)) return undefined;
		}
		return prefix;
	}
}

