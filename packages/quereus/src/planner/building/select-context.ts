import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import { buildWithClause } from './with.js';

/**
 * Builds context with CTEs if present.
 *
 * `stmt` is narrowed to just the `withClause`-bearing shape this reads, so UPDATE /
 * DELETE (which also carry a leading WITH) can thread their CTEs into scope through
 * the same path SELECT uses — closing the read gap where a CTE referenced in an
 * UPDATE/DELETE `where` / `set` subquery previously failed to resolve, and giving a
 * CTE-name DML target its sibling CTEs.
 *
 * The WITH clause contributes CTE *definitions* (`cteNodes`), not scope symbols. A
 * `cteName.column` symbol is published by `buildFrom`'s CTE branch, against the
 * attribute ids the `CTEReferenceNode` for that FROM entry republishes. This used to
 * also register `cteName.column` here, bound to the CTE **body's** attribute ids —
 * ids no `CTEReferenceNode` ever publishes, so any reference resolving through them
 * could only fail at runtime with "No row context found for column ...".
 */
export function buildWithContext(
	ctx: PlanningContext,
	stmt: { readonly withClause?: AST.WithClause },
	parentCTEs: Map<string, CTEScopeNode> = new Map()
): {
	contextWithCTEs: PlanningContext;
	cteNodes: Map<string, CTEScopeNode>;
} {
	// Start with parent CTEs - either from parameter or from context
	const cteNodes: Map<string, CTEScopeNode> = new Map(parentCTEs.size > 0 ? parentCTEs : (ctx.cteNodes ?? new Map()));
	let contextWithCTEs = ctx;

	if (stmt.withClause) {
		const newCteNodes = buildWithClause(ctx, stmt.withClause);
		// Merge parent CTEs with new ones (new ones take precedence)
		for (const [name, node] of newCteNodes) {
			cteNodes.set(name, node);
		}

		contextWithCTEs = { ...ctx, cteNodes, cteReferenceCache: ctx.cteReferenceCache };
	} else if (cteNodes.size > 0) {
		// No WITH clause but we have parent CTEs — thread them through unchanged.
		contextWithCTEs = { ...ctx, cteNodes, cteReferenceCache: ctx.cteReferenceCache };
	}

	return { contextWithCTEs, cteNodes };
}
