import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { TableSchema } from '../../schema/table.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { ReturningProjection } from '../nodes/returning-node.js';
import { buildExpression } from './expression.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Expand a base-table `RETURNING *` / `RETURNING <table>.*` into one projection
 * per target column, in declaration order.
 *
 * Rather than hand-build types, each synthesized unqualified column ref is
 * resolved through the SAME `returningScope` the named RETURNING path uses — so
 * the star automatically inherits the statement's default image (NEW for
 * INSERT/UPDATE, OLD for DELETE) and each column's declared type/collation. The
 * output column name is the bare column name regardless of any qualifier
 * (SELECT `t.*` parity).
 *
 * A qualifier (`t.*`) must name the target table — or its alias when one is set
 * (ordinary base-table UPDATE/DELETE never set one; an inline-subquery target
 * routes through the view path before reaching here). Any other qualifier raises
 * the same "not found" diagnostic shape as a SELECT qualified-`*` over a table
 * absent from the FROM clause, rather than falling through to a generic failure.
 */
export function expandReturningStar(
	ctx: PlanningContext,
	rc: { type: 'all'; table?: string },
	returningScope: Scope,
	tableSchema: TableSchema,
	tableAlias: string | undefined,
	/**
	 * UPDATE only: per-column NEW attribute ids, coordinating each expanded
	 * projection's attribute with the named path's NEW-attr handling. Omit for
	 * INSERT/DELETE (which mint fresh ids for the projected columns).
	 */
	newColumnAttributeIds?: readonly number[],
): ReturningProjection[] {
	if (rc.table) {
		const qualifier = rc.table.toLowerCase();
		const matchesTable = qualifier === tableSchema.name.toLowerCase();
		const matchesAlias = tableAlias !== undefined && qualifier === tableAlias.toLowerCase();
		if (!matchesTable && !matchesAlias) {
			throw new QuereusError(
				`Table '${rc.table}' not found in FROM clause for qualified RETURNING *`,
				StatusCode.ERROR,
			);
		}
	}

	return tableSchema.columns.map((tableColumn, columnIndex): ReturningProjection => {
		const colExpr: AST.ColumnExpr = { type: 'column', name: tableColumn.name };
		return {
			node: buildExpression({ ...ctx, scope: returningScope }, colExpr) as ScalarPlanNode,
			alias: tableColumn.name,
			...(newColumnAttributeIds ? { attributeId: newColumnAttributeIds[columnIndex] } : {}),
		};
	});
}
