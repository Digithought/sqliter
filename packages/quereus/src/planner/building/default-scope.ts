import type * as AST from '../../parser/ast.js';
import type { Scope, ReferenceCallback } from '../scopes/scope.js';
import type { Attribute } from '../nodes/plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Build the row-scoped scope that exposes a mutation's source-supplied ("populated")
 * columns to a DEFAULT expression, so a default can derive from a sibling the write
 * actually supplies — e.g. `slug text default (lower(new.title))`.
 *
 * Each supplied column at position `index` (positionally aligned with
 * `sourceAttributes`) is registered under the `new.<col>` form and, unless shadowed,
 * the bare `<col>` form. The bare form is skipped when a same-named mutation-context
 * variable shadows it, preserving WITH CONTEXT precedence. Columns the write omitted
 * are intentionally NOT passed in by callers: they have no value yet, so a default
 * cannot depend on another column's default (which would impose an evaluation-order
 * race).
 *
 * Shared by the single-source INSERT row-expansion (`insert.ts`) and the shared-key
 * view-write envelope (`view-mutation-builder.ts`) so `new.<col>` resolves the same
 * way on both paths.
 */
export function buildRowDefaultScope(
	parentScope: Scope,
	targetColumns: ReadonlyArray<{ readonly name: string; readonly type?: ScalarType }>,
	sourceAttributes: ReadonlyArray<Attribute>,
	mutationContextVarNames?: ReadonlySet<string>,
): RegisteredScope {
	const scope = new RegisteredScope(parentScope);
	targetColumns.forEach((targetCol, index) => {
		if (index >= sourceAttributes.length) return;
		const sourceAttr = sourceAttributes[index];
		const colNameLower = targetCol.name.toLowerCase();
		// Resolve against the target column's *declared* type when available (it
		// carries the declared collation), so a DEFAULT comparing a supplied sibling
		// resolves collations identically to a read-path query — the source
		// attribute's type reflects the supplied expression (e.g. a VALUES literal),
		// which is collation-blind.
		const refType = targetCol.type ?? sourceAttr.type;
		const makeRef: ReferenceCallback = (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, refType, sourceAttr.id, index);
		scope.registerSymbol(`new.${colNameLower}`, makeRef);
		if (!mutationContextVarNames?.has(colNameLower)) {
			scope.registerSymbol(colNameLower, makeRef);
		}
	});
	return scope;
}
