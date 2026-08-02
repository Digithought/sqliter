import type { DropViewNode } from '../../planner/nodes/drop-view-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { assertNoAssertionDependsOn } from './assertion-drop-guard.js';

export function emitDropView(plan: DropViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// A materialized view must be dropped with DROP MATERIALIZED VIEW.
		if (rctx.db.schemaManager.getMaintainedTable(plan.schemaName, plan.viewName)) {
			throw new QuereusError(
				`'${plan.viewName}' is a materialized view — use DROP MATERIALIZED VIEW`,
				StatusCode.ERROR
			);
		}

		// Check if view exists
		const existingView = rctx.db.schemaManager.getView(plan.schemaName, plan.viewName);

		if (!existingView && !plan.ifExists) {
			throw new QuereusError(
				`View '${plan.schemaName}.${plan.viewName}' does not exist`,
				StatusCode.ERROR
			);
		}

		if (!existingView && plan.ifExists) {
			// View doesn't exist but IF EXISTS was specified, so this is a no-op
			return null;
		}

		// An assertion body may name a view exactly as it names a base table, and
		// dropping it out from under one breaks every write to the database.
		assertNoAssertionDependsOn(rctx.db, plan.schemaName, plan.viewName, 'view');

		// Remove the view from the schema manager
		const schema = rctx.db.schemaManager.getSchema(plan.schemaName);
		if (!schema) {
			throw new QuereusError(
				`Schema '${plan.schemaName}' does not exist`,
				StatusCode.ERROR
			);
		}

		const removed = schema.removeView(plan.viewName);
		if (!removed && !plan.ifExists) {
			throw new QuereusError(
				`View '${plan.schemaName}.${plan.viewName}' does not exist`,
				StatusCode.ERROR
			);
		}

		// Fire view_removed so a store-backed catalog can forget this view. Fired
		// here (not from Schema.removeView) to mirror create-view's emitter-scoped
		// view_added. Not reached on the IF EXISTS no-op above.
		if (removed && existingView) {
			rctx.db.schemaManager.getChangeNotifier().notifyChange({
				type: 'view_removed',
				// Stored names of the dropped view — see
				// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
				schemaName: existingView.schemaName,
				objectName: existingView.name,
				oldObject: existingView,
			});
		}

		return null; // Explicitly return null for successful void operations
	}

	return {
		params: [],
		run,
		note: `dropView(${plan.schemaName}.${plan.viewName})`
	};
}
