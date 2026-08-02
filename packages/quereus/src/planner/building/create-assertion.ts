import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import { CreateAssertionNode } from '../nodes/create-assertion-node.js';

export function buildCreateAssertionStmt(ctx: PlanningContext, stmt: AST.CreateAssertionStmt): CreateAssertionNode {
	const sm = ctx.schemaManager;
	// Canonical schemaName (see SchemaManager.canonicalSchemaName) — it becomes
	// the assertion's stored home schema.
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	return new CreateAssertionNode(ctx.scope, schemaName, stmt.name.name, stmt.check);
}
