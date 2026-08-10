import type { DropIndexNode } from '../../planner/nodes/drop-index-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import type { SqlValue } from '../../common/types.js';
import { requireVtabModule } from '../../schema/table.js';
import { assertDdlTransactionPolicy, isDdlPolicyStrict } from './ddl-transaction-policy.js';

export function emitDropIndex(plan: DropIndexNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). Locating the owning table
		// needs a read-only scan (the same one SchemaManager.dropIndex does), so guard
		// it behind the cheap policy check — the default permissive path pays nothing.
		// If nothing owns the index, skip the gate and let dropIndex handle IF EXISTS /
		// not-found.
		if (isDdlPolicyStrict(rctx.db)) {
			// Same resolver, same default scope, as the drop itself — so the policy gate
			// can never fire against a table whose index is not the one dropIndex will
			// resolve (or against no droppable index at all).
			const owner = rctx.db.schemaManager.findIndexOwner(plan.schemaName, plan.indexName)?.table;
			if (owner) {
				assertDdlTransactionPolicy(
					rctx.db, requireVtabModule(owner), owner.vtabModuleName,
					`DROP INDEX ${plan.indexName}`,
				);
			}
		}

		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		await rctx.db.schemaManager.dropIndex(plan.schemaName, plan.indexName, plan.ifExists);

		return null;
	}

	return {
		params: [],
		run: asRun(run),
		note: `dropIndex(${plan.schemaName}.${plan.indexName})`
	};
}
