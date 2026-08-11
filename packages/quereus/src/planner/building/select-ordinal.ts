import type * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Attribute, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';

/**
 * One output column of a SELECT list, in source order (stars expanded).
 *
 * `expr` is the AST that produced the column — the authored expression for a
 * normal result column, or a synthesized `{type:'column', name}` for a column a
 * star expanded to. That synthesized name is NOT a reliable handle: it is
 * unqualified, so two same-named columns from different join sides collapse onto
 * it. `sourceAttribute` therefore carries the exact input attribute a
 * star-expanded column came from, so a positional reference can bind to it
 * directly instead of re-resolving the name.
 */
export interface SelectListEntry {
	/** The AST that produced this output column (authored, or synthesized for a star). */
	readonly expr: AST.Expression;
	/** Star-expanded entries only: the exact input attribute this column came from. */
	readonly sourceAttribute?: { readonly attr: Attribute; readonly index: number };
	/**
	 * The `as` alias this column was written with, if any. Star-expanded entries
	 * never carry one, so a star column's name cannot shadow a source column when
	 * a caller matches ORDER BY names against select-list aliases.
	 */
	readonly alias?: string;
}

/**
 * Builds the source-order list of SELECT-list output columns, with
 * SELECT * / table.* expanded against the input relation's attributes.
 * Each entry corresponds to one output column, in source order. Used so that
 * GROUP BY / ORDER BY ordinal references (1-based) can resolve back to the
 * column that produced the Nth output column.
 */
export function buildSelectListEntries(
	columns: AST.ResultColumn[],
	input: RelationalPlanNode,
): SelectListEntry[] {
	const result: SelectListEntry[] = [];
	for (const column of columns) {
		if (column.type === 'all') {
			const allAttrs = input.getAttributes();
			allAttrs.forEach((attr, index) => {
				if (column.table && attr.relationName?.toLowerCase() !== column.table.toLowerCase()) return;
				const colExpr: AST.ColumnExpr = { type: 'column', name: attr.name };
				result.push({ expr: colExpr, sourceAttribute: { attr, index } });
			});
		} else if (column.type === 'column') {
			result.push({ expr: column.expr, alias: column.alias });
		}
	}
	return result;
}

/**
 * If `expr` is a bare integer literal (or a unary `+`/`-` applied to one), treats
 * it as a 1-based positional reference into `selectList` and returns the
 * corresponding entry. Out-of-range / zero / negative ordinals raise an error.
 * Any other expression shape returns null so the caller can fall through to
 * normal expression building (e.g., `group by 1 + 0` keeps its
 * constant-expression semantics).
 */
export function resolveOrdinalReference(
	expr: AST.Expression,
	selectList: readonly SelectListEntry[],
	clauseName: 'GROUP BY' | 'ORDER BY',
): SelectListEntry | null {
	const value = extractOrdinalValue(expr);
	if (value === null) return null;
	if (value < 1 || value > selectList.length) {
		throw new QuereusError(
			`${clauseName} position ${value} is not in the SELECT list (1..${selectList.length})`,
			StatusCode.ERROR,
			undefined,
			expr.loc?.start.line,
			expr.loc?.start.column,
		);
	}
	return selectList[value - 1];
}

/**
 * Builds one GROUP BY / ORDER BY term that sits *below* (or beside) the
 * projection producing the SELECT list, so there are no output attributes to
 * bind a positional reference to yet.
 *
 * A positional reference still must not go through a NAME: for a star-expanded
 * column the synthesized name is unqualified, so `select * from t1 join t2 …
 * group by 4` would re-resolve `v` to whichever side happens to be first in
 * scope. When the resolved entry carries its source attribute, reference that
 * attribute directly; otherwise re-plan the authored expression, which is what
 * the ordinal literally stands for.
 */
export function buildOrdinalAwareExpression(
	context: PlanningContext,
	expr: AST.Expression,
	selectList: readonly SelectListEntry[],
	clauseName: 'GROUP BY' | 'ORDER BY',
	allowAggregates: boolean = false,
): ScalarPlanNode {
	const entry = resolveOrdinalReference(expr, selectList, clauseName);
	if (!entry) {
		return buildExpression(context, expr, allowAggregates);
	}
	const sourceRef = buildSourceAttributeReference(entry, context.scope);
	return sourceRef ?? buildExpression(context, entry.expr, allowAggregates);
}

/**
 * A direct reference to a star-expanded entry's source attribute, or null when
 * the entry is an authored expression (which must be re-planned instead).
 */
function buildSourceAttributeReference(entry: SelectListEntry, scope: Scope): ColumnReferenceNode | null {
	if (!entry.sourceAttribute) return null;
	const { attr, index } = entry.sourceAttribute;
	const colExpr: AST.ColumnExpr = attr.relationName
		? { type: 'column', name: attr.name, table: attr.relationName }
		: { type: 'column', name: attr.name };
	return new ColumnReferenceNode(scope, colExpr, attr.type, attr.id, index);
}

/**
 * Resolves a 1-based positional ORDER BY ordinal against a relation whose output
 * attributes ARE the SELECT list — the final `ProjectNode` of a single SELECT, or
 * a `SetOperationNode` for a compound. The ordinal maps directly to the Nth
 * OUTPUT column (index `n-1`), returning a `ColumnReferenceNode` over that
 * column's attribute/type.
 *
 * Binding by attribute rather than by name is what makes a positional reference
 * mean "the Nth result column" rather than "re-resolve the text that produced it":
 * a SELECT-list alias cannot shadow the target (`select b as a, a as z … order by
 * 2`), two same-named columns under a star cannot be confused (`select * from t1
 * join t2 … order by 4`), and a computed column (window function, aggregate) is
 * READ from the output rather than recomputed in a scope that cannot evaluate it.
 * The reference also inherits the column's RESOLVED type — including a compound's
 * cross-input `collationName`/`collationSource` — so an ordinal ORDER BY stays in
 * lockstep with dedup, exactly like the column-name form.
 *
 * ORDER BY only: GROUP BY always runs BELOW the projection that produces the
 * select list, so it has no output attributes to bind to (see
 * {@link buildOrdinalAwareExpression}).
 *
 * Returns null for any non-ordinal expression shape (mirrors
 * `extractOrdinalValue`) so the caller falls through to normal expression
 * building. Out-of-range / zero / negative ordinals raise the same prepare-time
 * error as `resolveOrdinalReference`.
 */
export function resolveOrdinalOutputColumn(
	expr: AST.Expression,
	outputRelation: RelationalPlanNode,
	scope: Scope,
): ColumnReferenceNode | null {
	const value = extractOrdinalValue(expr);
	if (value === null) return null;
	// NOTE: the range is the relation's full output arity. A `SetOperationNode` that
	// surfaces membership flag columns advertises them here too, so an ordinal could
	// address one; harmless today because flags are introduced by optimizer rewrites,
	// long after this runs at build time. If a flagged set-op ever reaches ORDER BY
	// building, bound the range to the compound's data arity instead.
	const columns = outputRelation.getType().columns;
	if (value < 1 || value > columns.length) {
		throw new QuereusError(
			`ORDER BY position ${value} is not in the SELECT list (1..${columns.length})`,
			StatusCode.ERROR,
			undefined,
			expr.loc?.start.line,
			expr.loc?.start.column,
		);
	}
	const index = value - 1;
	const column = columns[index];
	const attr = outputRelation.getAttributes()[index];
	const colExpr: AST.ColumnExpr = { type: 'column', name: column.name || attr.name };
	return new ColumnReferenceNode(scope, colExpr, column.type, attr.id, index);
}

function extractOrdinalValue(expr: AST.Expression): number | null {
	if (expr.type === 'literal') {
		const v = expr.value;
		if (typeof v === 'number' && Number.isInteger(v)) return v;
		return null;
	}
	// Unary `-N` parses as UnaryExpr(-, Literal(N)). Likewise `+N`.
	if (expr.type === 'unary' && (expr.operator === '-' || expr.operator === '+') && expr.expr.type === 'literal') {
		const v = expr.expr.value;
		if (typeof v === 'number' && Number.isInteger(v)) {
			return expr.operator === '-' ? -v : v;
		}
	}
	return null;
}
