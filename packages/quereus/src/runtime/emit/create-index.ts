import type { CreateIndexNode } from '../../planner/nodes/create-index-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { requireVtabModule } from '../../schema/table.js';
import { assertDdlTransactionPolicy } from './ddl-transaction-policy.js';

export function emitCreateIndex(plan: CreateIndexNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate: refuse module-dispatching DDL inside an explicit
		// transaction on a non-transactional module. Runs BEFORE _ensureTransaction()
		// (see ddl-transaction-policy.ts). If the target table can't be resolved, skip
		// the gate and let SchemaManager.createIndex raise the natural not-found error.
		const target = rctx.db.schemaManager.getTable(plan.statementAst.table.schema, plan.statementAst.table.name);
		if (target) {
			assertDdlTransactionPolicy(
				rctx.db, requireVtabModule(target), target.vtabModuleName,
				`CREATE INDEX ${plan.statementAst.index.name}`,
			);
		}

		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		await rctx.db.schemaManager.createIndex(plan.statementAst);
		// The specific error handling for IF NOT EXISTS is within SchemaManager.createIndex.

		return null; // Explicitly return null for successful void operations
	}

	return { params: [], run: asRun(run), note: `createIndex(${plan.statementAst.index.name})` };
}
