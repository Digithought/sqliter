import type { CreateViewNode } from '../../planner/nodes/create-view-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { ViewSchema } from '../../schema/view.js';
import { assertCatalogObjectPersistable } from '../../schema/catalog-persistability.js';
import { withStatementScopedSchemaEvents } from './ddl-event-scope.js';

export function emitCreateView(plan: CreateViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// Statement-scoped schema-event scope. This statement raises nothing on the public
		// schema channel today (`view_added` is an internal catalog notification), so the
		// scope is a no-op — it is here so the invariant holds by construction: see
		// ddl-event-scope.ts.
		return withStatementScopedSchemaEvents(rctx, async () => {
			// Check if view already exists
			const existingView = rctx.db.schemaManager.getView(plan.schemaName, plan.viewName);

			if (existingView && !plan.ifNotExists) {
				throw new QuereusError(
					`View '${plan.schemaName}.${plan.viewName}' already exists`,
					StatusCode.ERROR
				);
			}

			if (existingView && plan.ifNotExists) {
				// View exists but IF NOT EXISTS was specified, so this is a no-op
				return null;
			}

			// Create the view schema. Any `with defaults (…)` rides inside
			// plan.selectStmt (→ selectAst), so there is no separate field to thread.
			const viewSchema: ViewSchema = {
				name: plan.viewName,
				schemaName: plan.schemaName,
				sql: plan.sql,
				selectAst: plan.selectStmt,
				columns: plan.columns,
				tags: plan.tags,
			};

			// Add the view to the schema manager
			const schema = rctx.db.schemaManager.getSchema(plan.schemaName);
			if (!schema) {
				throw new QuereusError(
					`Schema '${plan.schemaName}' does not exist`,
					StatusCode.ERROR
				);
			}

			// Refuse up front if a registered module could not durably persist this
			// definition — the persistence itself is fire-and-forget (see
			// assertCatalogObjectPersistable), so this is the only place the failure can
			// reach the statement. Nothing has been mutated yet, so a throw is a clean no-op.
			assertCatalogObjectPersistable(rctx.db, 'view', viewSchema);

			schema.addView(viewSchema);

			// Fire view_added so a store-backed catalog can persist this view. Fired
			// here (not from Schema.addView) so only user/declarative DDL views are
			// persisted; internal views (lens bodies, etc.) register via schema.addView
			// directly and are deliberately excluded. Not reached on the IF NOT EXISTS
			// no-op above.
			rctx.db.schemaManager.getChangeNotifier().notifyChange({
				type: 'view_added',
				// Stored names of the registered ViewSchema — see
				// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant
				// (plan.schemaName is already canonical via the builder, so they coincide).
				schemaName: viewSchema.schemaName,
				objectName: viewSchema.name,
				newObject: viewSchema,
			});
			return null; // Explicitly return null for successful void operations
		});
	}

	return {
		params: [],
		run,
		note: `createView(${plan.schemaName}.${plan.viewName})`
	};
}
