import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import { DropAssertionNode } from '../nodes/drop-assertion-node.js';
import { quereusError } from '../../common/errors.js';

export function buildDropAssertionStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropAssertionNode {
	if (stmt.objectType !== 'assertion') {
		quereusError('Expected DROP ASSERTION statement', undefined, undefined, stmt);
	}

	const sm = ctx.schemaManager;
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	return new DropAssertionNode(ctx.scope, schemaName, stmt.name.name, stmt.ifExists);
}
