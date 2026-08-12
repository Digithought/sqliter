import type { DropAssertionNode } from '../../planner/nodes/drop-assertion-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { withStatementScopedSchemaEvents } from './ddl-event-scope.js';

const log = createLogger('runtime:emit:drop-assertion');

export function emitDropAssertion(plan: DropAssertionNode, _ctx: EmissionContext): Instruction {

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// Statement-scoped schema-event scope. Assertions raise nothing on the public
		// schema channel today, so the scope is a no-op — it is here so the invariant
		// holds by construction: see ddl-event-scope.ts.
		return withStatementScopedSchemaEvents(rctx, async () => {
			const schemaManager = rctx.db.schemaManager;
			const schema = schemaManager.getSchema(plan.schemaName);

			const existing = schema?.getAssertion(plan.name);
			if (!existing) {
				if (plan.ifExists) {
					log('Assertion %s.%s not found, but IF EXISTS specified', plan.schemaName, plan.name);
					return null;
				}
				throw new QuereusError(
					`Assertion ${plan.name} not found in schema ${plan.schemaName}`,
					StatusCode.NOTFOUND
				);
			}

			const removed = schemaManager.removeAssertion(plan.schemaName, plan.name);
			if (!removed && !plan.ifExists) {
				throw new QuereusError(
					`Failed to remove assertion ${plan.name}`,
					StatusCode.INTERNAL
				);
			}

			// Invalidate cached plan for this assertion
			rctx.db.invalidateAssertionCache(plan.schemaName, plan.name);

			log('Dropped assertion %s.%s', plan.schemaName, plan.name);
			return null;
		});
	}

	return {
		params: [],
		run: asRun(run),
		note: `dropAssertion(${plan.schemaName}.${plan.name})`
	};
}
