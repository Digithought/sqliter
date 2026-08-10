import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DropIndexNode } from '../nodes/drop-index-node.js';

/**
 * Builds a plan node for DROP INDEX statements.
 */
export function buildDropIndexStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropIndexNode {
	// Canonical schemaName, unqualified names landing in the current schema —
	// symmetric with createIndex's resolution and the other DDL builders.
	const sm = ctx.db.schemaManager;
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	const indexName = stmt.name.name;

	return new DropIndexNode(
		ctx.scope,
		indexName,
		schemaName,
		stmt.ifExists
	);
}
