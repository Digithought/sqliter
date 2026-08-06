import type {
	CreateMaterializedViewNode,
	RefreshMaterializedViewNode,
	DropMaterializedViewNode,
} from '../../planner/nodes/materialized-view-nodes.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { astToString } from '../../emit/ast-stringify.js';
import type { Database } from '../../core/database.js';
import type { MaintainedTableSchema } from '../../schema/derivation.js';
import { requireVtabModule } from '../../schema/table.js';
import { normalizeBackingModuleName } from '../../schema/view.js';
import { assertDdlTransactionPolicy, isDdlPolicyStrict } from './ddl-transaction-policy.js';
import { assertNoAssertionDependsOn } from './assertion-drop-guard.js';
import { assertNoExpressionDependsOn } from './expression-drop-guard.js';
import {
	materializeView,
	deriveBackingShape,
	rebuildBacking,
	reshapeBacking,
	backingShapeMatches,
	revalidateBody,
	unlinkCoveredUniqueConstraints,
} from './materialized-view-helpers.js';

/**
 * Strict-policy gate (see ddl-transaction-policy.ts) for a verb that operates on an
 * EXISTING maintained table — REFRESH and DROP. Both drive the backing module table
 * in ways that escape rollback, so both are refused inside an explicit transaction on
 * a non-`transactional` module.
 *
 * Resolving the owning module needs the MV lookup, so it is guarded behind the cheap
 * policy check (the `emitDropIndex` pattern): the default permissive path pays nothing
 * and keeps its statement ordering byte-for-byte. An unresolvable name skips the gate
 * and falls through to the caller's IF EXISTS / not-found diagnostics.
 */
function assertMaintainedTableDdlPolicy(db: Database, schemaName: string, viewName: string, statementLabel: string): void {
	if (!isDdlPolicyStrict(db)) return;
	const target = db.schemaManager.getMaintainedTable(schemaName, viewName);
	if (!target) return;
	assertDdlTransactionPolicy(db, requireVtabModule(target), target.vtabModuleName, statementLabel);
}

export function emitCreateMaterializedView(plan: CreateMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). The MV's backing is a real
		// module (memory/store) table, so creating one escapes rollback exactly like
		// CREATE TABLE. The owning module is the `using <module>(...)` backing host, else
		// the memory default — the one normalizeBackingModuleName decision
		// buildBackingTableSchema also resolves through (NOT the session default module,
		// which MV backing deliberately ignores). The plan builder already rejects an
		// unregistered module; if one was unregistered after the plan was built, skip the
		// gate and let materializeView raise the natural "no virtual table module named
		// ..." error.
		const backingModuleName = normalizeBackingModuleName(plan.backingModuleName);
		const backingModule = rctx.db.schemaManager.getModule(backingModuleName);
		if (backingModule?.module) {
			assertDdlTransactionPolicy(
				rctx.db, backingModule.module, backingModuleName,
				`CREATE MATERIALIZED VIEW ${plan.viewName}`,
			);
		}

		await rctx.db._ensureTransaction();
		const db = rctx.db;
		const sm = db.schemaManager;

		const existing = sm.getMaintainedTable(plan.schemaName, plan.viewName);
		if (existing) {
			if (plan.ifNotExists) return null;
			throw new QuereusError(
				`Materialized view '${plan.schemaName}.${plan.viewName}' already exists`,
				StatusCode.ERROR,
			);
		}
		// One namespace now: a plain table occupies the same name a maintained
		// table would. Keep the dedicated diagnostic for both directions.
		if (sm.getTable(plan.schemaName, plan.viewName) || sm.getView(plan.schemaName, plan.viewName)) {
			throw new QuereusError(
				`Cannot create materialized view '${plan.schemaName}.${plan.viewName}': a table or view with the same name already exists`,
				StatusCode.CONSTRAINT,
			);
		}

		// The materialize core (derive backing shape → create + fill the
		// maintained table under the MV's own name in the declared host module →
		// attach derivation + register row-time maintenance, rolling back on any
		// throw) is shared with the catalog-import path — see materializeView.
		const mv = await materializeView(db, {
			schemaName: plan.schemaName,
			viewName: plan.viewName,
			// Any `with defaults (…)` rides inside plan.selectStmt (→ selectAst).
			selectAst: plan.selectStmt,
			bodySql: plan.bodySql,
			columns: plan.columns,
			tags: plan.tags,
			backingModuleName: plan.backingModuleName,
			backingModuleArgs: plan.backingModuleArgs,
		});

		sm.getChangeNotifier().notifyChange({
			type: 'materialized_view_added',
			// Stored names of the registered MV — see
			// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
			schemaName: mv.schemaName,
			objectName: mv.name,
			newObject: mv,
		});
		return null;
	}

	return { params: [], run, note: `createMaterializedView(${plan.schemaName}.${plan.viewName})` };
}

export function emitRefreshMaterializedView(plan: RefreshMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// REFRESH is gated even though it mostly rewrites rows rather than the catalog
		// shape, for two reasons: (1) its reshape arm reconciles a shifted body shape onto
		// the live table with module `alterTable` ops — a genuine escaping schema change,
		// and one that fires only on some inputs, so gating it data-dependently would make
		// strict unpredictable; and (2) both arms are commit-first (`begin; refresh;
		// rollback` does NOT undo the refresh today — see rebuildBacking), so the effect
		// escapes the enclosing transaction exactly as the gated DDL statements do.
		assertMaintainedTableDdlPolicy(
			rctx.db, plan.schemaName, plan.viewName,
			`REFRESH MATERIALIZED VIEW ${plan.viewName}`,
		);

		await rctx.db._ensureTransaction();
		const db = rctx.db;
		const sm = db.schemaManager;

		const mv = sm.getMaintainedTable(plan.schemaName, plan.viewName);
		if (!mv) {
			if (sm.getTable(plan.schemaName, plan.viewName)) {
				throw new QuereusError(
					`'${plan.viewName}' is a table, not a materialized view`,
					StatusCode.ERROR,
				);
			}
			throw new QuereusError(`no such materialized view: ${plan.viewName}`, StatusCode.ERROR);
		}

		await refreshMaintainedTable(db, mv);
		return null;
	}

	return { params: [], run, note: `refreshMaterializedView(${plan.schemaName}.${plan.viewName})` };
}

/**
 * The per-MV refresh core — the always-correct full-rebuild convergence point a
 * `refresh materialized view` runs through, factored out of
 * {@link emitRefreshMaterializedView} so the engine-level convergence sweep
 * ({@link Database.refreshAllMaterializedViews}) drives the IDENTICAL path
 * without a second copy of the rebuild logic. The caller has already looked the
 * MV up and ensured a transaction (the swap below is commit-first per the
 * helpers in `materialized-view-helpers.ts`); this runs everything after that:
 * stale revalidation → shape re-derivation → reshape/rebuild → row-time
 * re-registration → `stale` clear → `materialized_view_refreshed` notify.
 * Returns the live (possibly reshaped) maintained-table record.
 */
export async function refreshMaintainedTable(db: Database, mv: MaintainedTableSchema): Promise<MaintainedTableSchema> {
	const sm = db.schemaManager;
	const d = mv.derivation;

	const bodySql = astToString(d.selectAst);

	// A stale MV re-validates its body against current source schemas first.
	if (d.stale) {
		revalidateBody(db, mv.schemaName, mv.name, bodySql);
	}

	// Re-derive the canonical backing shape from the (re-planned) body. A source
	// `alter` can shift the body's output shape (columns/types/PK/ordering) — most
	// visibly for a `select *` body, whose new source column interleaves into the
	// output while the create-time backing does not. Only `replaceContents`-ing the
	// new rows into the stale backing schema would surface body values under the wrong
	// column labels (a latent direct-read corruption) and break the positional
	// backing↔body alignment the join read-rewrite relies on. So compare the derived
	// shape to the live table and rebuild it when the shape shifted.
	const shape = deriveBackingShape(db, mv.schemaName, bodySql, d.columns);

	// An explicit column list is a declared interface. A body whose output count
	// shifted under it (a source column add behind `mv(a, b, c)`) would silently
	// widen/narrow that list — error instead of reshaping it. The MV stays stale, so
	// the next read re-validates/errors rather than serving a reshaped interface.
	if (d.columns && d.columns.length !== shape.columns.length) {
		throw new QuereusError(
			`materialized view '${mv.schemaName}.${mv.name}' was declared with ${d.columns.length} columns `
				+ `but its body now produces ${shape.columns.length} after a source change — drop and recreate`,
			StatusCode.ERROR,
		);
	}

	let live: MaintainedTableSchema = mv;
	if (backingShapeMatches(mv, shape)) {
		// FAST PATH: shape unchanged — data-only swap, table identity + caches preserved.
		await rebuildBacking(db, mv);
	} else {
		// RESHAPE: the shape shifted — reconcile the live table to the re-planned
		// body IN PLACE (module alterTable ops + data reconcile), preserving the
		// table incarnation. An interleaving reorder or a physical-PK change is
		// inexpressible in place and raises a sited error (table left untouched,
		// MV stays stale). The helper returns the reshaped (shape-updated) record.
		live = await reshapeBacking(db, mv, shape);
	}

	// Re-register row-time write-through maintenance. A source schema change that
	// marked this MV stale also detached its row-time plan; the rebuild above only
	// fixes the snapshot, so without re-registering, subsequent source writes would
	// silently not propagate. Registration runs AFTER the (re)build so the maintenance
	// plan binds to the new backing's shape (`backingPkDefinition`/projectors).
	// Registration is idempotent (it releases any existing plan first), so a refresh of
	// a never-stale MV is a harmless no-op re-attach. Re-register BEFORE clearing
	// `stale`: if registration ever threw (the eligibility gate re-runs here), leaving
	// the MV stale makes the next read re-validate/error rather than silently serve an
	// unmaintained snapshot.
	db.registerMaterializedView(live);
	live.derivation.stale = false;
	sm.getChangeNotifier().notifyChange({
		type: 'materialized_view_refreshed',
		// Stored names of the refreshed MV, not the raw statement spelling — see
		// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
		schemaName: live.schemaName,
		objectName: live.name,
		object: live,
	});
	return live;
}

/**
 * Shared maintained-table teardown: detach the row-time maintenance plan,
 * clear any constraint↔structure link, drop the table (fires `table_removed`),
 * and fire `materialized_view_removed` so store catalog persistence forgets
 * the `create materialized view` entry. Used by DROP MATERIALIZED VIEW and by
 * DROP TABLE on a maintained table — in the unified model both drop the one
 * record (table + derivation).
 */
export async function dropMaintainedTable(db: Database, mv: MaintainedTableSchema): Promise<void> {
	const sm = db.schemaManager;

	// Detach the row-time maintenance plan. The manager also reacts to the
	// `materialized_view_removed` event below, but detaching first keeps the
	// stale plan from firing on the table drop.
	db.unregisterMaterializedView(mv.schemaName, mv.name);

	// Clear any constraint↔structure link this MV established. No enforcement
	// demotion: physical schemas still enforce via the implicit auto-index.
	unlinkCoveredUniqueConstraints(db, mv);

	// Drop the table (fires table_removed), then notify the MV channel.
	await sm.dropTable(mv.schemaName, mv.name, /*ifExists*/ true);
	sm.getChangeNotifier().notifyChange({
		type: 'materialized_view_removed',
		// Stored names of the dropped MV, not the raw statement spelling — see
		// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
		schemaName: mv.schemaName,
		objectName: mv.name,
		oldObject: mv,
	});
}

export function emitDropMaterializedView(plan: DropMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Dropping an MV drops its backing module table, escaping rollback exactly like
		// DROP TABLE.
		assertMaintainedTableDdlPolicy(
			rctx.db, plan.schemaName, plan.viewName,
			`DROP MATERIALIZED VIEW ${plan.viewName}`,
		);

		await rctx.db._ensureTransaction();
		const db = rctx.db;
		const sm = db.schemaManager;

		const mv = sm.getMaintainedTable(plan.schemaName, plan.viewName);
		if (!mv) {
			if (plan.ifExists) return null;
			if (sm.getTable(plan.schemaName, plan.viewName)) {
				throw new QuereusError(
					`'${plan.viewName}' is a table, not a materialized view — use DROP TABLE`,
					StatusCode.ERROR,
				);
			}
			if (sm.getView(plan.schemaName, plan.viewName)) {
				throw new QuereusError(
					`'${plan.viewName}' is a view, not a materialized view — use DROP VIEW`,
					StatusCode.ERROR,
				);
			}
			throw new QuereusError(`no such materialized view: ${plan.viewName}`, StatusCode.ERROR);
		}

		// Same guard DROP TABLE applies — a maintained table is a table to an
		// assertion body. `dropMaintainedTable` itself stays unguarded: internal
		// rollback / catalog-cleanup paths call it and must not be vetoed.
		assertNoAssertionDependsOn(db, plan.schemaName, plan.viewName, 'materialized view');
		// …and a table to another table's CHECK / DEFAULT / generated subquery too.
		assertNoExpressionDependsOn(db, plan.schemaName, plan.viewName, 'materialized view');

		await dropMaintainedTable(db, mv);
		return null;
	}

	return { params: [], run, note: `dropMaterializedView(${plan.schemaName}.${plan.viewName})` };
}
