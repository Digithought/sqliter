import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { AnalyzePlanNode } from '../nodes/analyze-node.js';
import { resolveTableSchema } from './schema-resolution.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { isViewSchema } from '../../schema/view.js';

export function buildAnalyzeStmt(ctx: PlanningContext, stmt: AST.AnalyzeStmt): PlanNode {
	if (stmt.tableName) {
		// A plain view has no stored rows to analyze — reject it by name before
		// resolveTableSchema (table-only) turns it into a misleading "not found".
		const item = ctx.schemaManager.findSchemaItem(stmt.tableName, stmt.schemaName, ctx.schemaPath);
		if (isViewSchema(item)) {
			throw new QuereusError(
				`Cannot ANALYZE view '${item.schemaName}.${item.name}': a view has no stored rows to collect statistics from.`,
				StatusCode.ERROR
			);
		}

		const tableSchema = resolveTableSchema(ctx, stmt.tableName, stmt.schemaName);
		return new AnalyzePlanNode(ctx.scope, stmt, tableSchema.name, tableSchema.schemaName);
	}

	if (stmt.schemaName && !ctx.schemaManager.getSchema(stmt.schemaName)) {
		throw new QuereusError(`Schema not found: ${stmt.schemaName}`, StatusCode.ERROR);
	}
	return new AnalyzePlanNode(ctx.scope, stmt, stmt.tableName, stmt.schemaName);
}
