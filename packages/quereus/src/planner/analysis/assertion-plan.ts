/**
 * The one recipe for planning an assertion's stored violation query for
 * analysis, shared by every caller that needs to look at the plan rather than
 * run it: `CREATE ASSERTION`'s dependency discovery, the commit-time evaluator,
 * and `explain_assertion()`.
 *
 * All three need the same three ingredients, and each one is easy to forget:
 * the home-schema path, analysis-stage optimization, and hoist suppression.
 */

import type { Database } from '../../core/database.js';
import type * as AST from '../../parser/ast.js';
import { Parser } from '../../parser/parser.js';
import type { PlanNode } from '../nodes/plan-node.js';

/**
 * Builds and analysis-optimizes an assertion body.
 *
 * - Planned under `_homeSchemaPath(schemaName)` so unqualified table names in
 *   the stored body resolve against the assertion's own schema first, whatever
 *   the session's search path is.
 * - Stopped at `optimizeForAnalysis` — the structural prefix of the pass
 *   pipeline, before physical access-path selection. Physical optimization
 *   leaves several `TableReferenceNode` instances per table, which would make
 *   any per-reference analysis over the result double-count.
 * - Run under `withSuppressedAssertionHoist`, so another assertion's hoisted
 *   premises (or this one's own) cannot fold a base reference — or the whole
 *   violation query — out of the plan. The suppression counter is re-entrant,
 *   so a caller already inside a wider suppressed region can call this freely.
 *
 * `body` may be the stored SQL text or an already-parsed statement; callers
 * that want to report a parse failure in their own words parse first and pass
 * the AST.
 */
export function planAssertionBodyForAnalysis(
	db: Database,
	body: string | AST.Statement,
	schemaName: string,
): PlanNode {
	const ast = typeof body === 'string'
		? new Parser().parse(body) as AST.Statement
		: body;
	return db.schemaManager.withSuppressedAssertionHoist(() => {
		const { plan } = db._buildPlan([ast], undefined, db._homeSchemaPath(schemaName));
		return db.optimizer.optimizeForAnalysis(plan, db);
	});
}
