import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DropViewNode } from '../nodes/drop-view-node.js';

/**
 * Builds a plan node for DROP VIEW statements.
 */
export function buildDropViewStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropViewNode {
	// Canonical schemaName, unqualified names landing in the current schema —
	// symmetric with buildCreateViewStmt and the other DDL builders.
	const sm = ctx.db.schemaManager;
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	const viewName = stmt.name.name;

	return new DropViewNode(
		ctx.scope,
		viewName,
		schemaName,
		stmt.ifExists
	);
}
