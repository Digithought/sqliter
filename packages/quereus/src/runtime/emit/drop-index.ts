import type { DropIndexNode } from '../../planner/nodes/drop-index-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import type { SqlValue } from '../../common/types.js';
import { requireVtabModule } from '../../schema/table.js';
import { isImplicitCoveringIndex } from '../../schema/catalog.js';
import { assertDdlTransactionPolicy, isDdlPolicyStrict } from './ddl-transaction-policy.js';

export function emitDropIndex(plan: DropIndexNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). Locating the owning table
		// needs a read-only scan (the same one SchemaManager.dropIndex does), so guard
		// it behind the cheap policy check — the default permissive path pays nothing.
		// If nothing owns the index, skip the gate and let dropIndex handle IF EXISTS /
		// not-found.
		if (isDdlPolicyStrict(rctx.db)) {
			const schema = rctx.db.schemaManager.getSchema(plan.schemaName);
			const lowerIndexName = plan.indexName.toLowerCase();
			// Skip implicit covering structures for the same reason SchemaManager.dropIndex
			// does — otherwise the policy gate fires against a table whose index is not
			// the one dropIndex will resolve (or against no droppable index at all).
			const owner = schema && Array.from(schema.getAllTables()).find(t => {
				const matched = t.indexes?.find(idx => idx.name.toLowerCase() === lowerIndexName);
				return matched !== undefined && !isImplicitCoveringIndex(t, matched.name);
			});
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
