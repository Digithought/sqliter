import type { DropTableNode } from '../../planner/nodes/drop-table-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { dropMaintainedTable } from './materialized-view.js';
import { requireVtabModule } from '../../schema/table.js';
import { assertDdlTransactionPolicy } from './ddl-transaction-policy.js';
import { assertNoAssertionDependsOn } from './assertion-drop-guard.js';

export function emitDropTable(plan: DropTableNode, ctx: EmissionContext): Instruction {
	const schemaManager = ctx.db.schemaManager;
	const stmt = plan.statementAst; // AST.DropStmt

	const targetSchemaName = stmt.name.schema || schemaManager.getCurrentSchemaName();
	const objectName = stmt.name.name;

	if (stmt.objectType !== 'table') {
		// This emitter is specifically for DROP TABLE.
		// DROP VIEW, DROP INDEX would need their own PlanNodes and emitters, or a more generic DDL DropNode.
		throw new QuereusError(`DROP for object type '${stmt.objectType}' is not supported by emitDropTable.`, StatusCode.UNSUPPORTED);
	}

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). Consult the target
		// table's module tier; if the table doesn't exist, skip the gate and let
		// SchemaManager.dropTable handle IF EXISTS / not-found.
		const target = rctx.db.schemaManager.getTable(targetSchemaName, objectName);
		if (target) {
			assertDdlTransactionPolicy(
				rctx.db, requireVtabModule(target), target.vtabModuleName,
				`DROP TABLE ${objectName}`,
			);
			// Before the maintained-table branch below, so DROP TABLE on a
			// materialized view is guarded too. Gated on the table existing: an
			// `IF EXISTS` drop of an absent name is a no-op with nothing to protect
			// (and any assertion naming that name is already broken).
			assertNoAssertionDependsOn(rctx.db, targetSchemaName, objectName, 'table');
		}

		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// A maintained table (materialized view) is one record: DROP TABLE drops
		// the table AND its derivation — detach maintenance, unlink any covering
		// link, and fire materialized_view_removed so persisted catalogs forget
		// the `create materialized view` entry.
		const maintained = rctx.db.schemaManager.getMaintainedTable(targetSchemaName, objectName);
		if (maintained) {
			await dropMaintainedTable(rctx.db, maintained);
			return null;
		}

		await rctx.db.schemaManager.dropTable(targetSchemaName, objectName, stmt.ifExists);

		return null;
	}

	return { params: [], run: asRun(run), note: `dropTable(${targetSchemaName}.${objectName})` };
}
