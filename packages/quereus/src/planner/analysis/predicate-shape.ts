/**
 * Shape recognizers for declared-predicate AST trees (CHECK constraints,
 * partial-index WHERE clauses). Shared by `check-extraction.ts` and
 * `partial-unique-extraction.ts`; both pull `col`-style references, literal
 * values, and "which columns are mentioned anywhere" out of small AST shapes.
 *
 * These helpers are intentionally syntactic — they do not interpret types,
 * collations, or coercions. Callers wanting semantic equivalence should layer
 * that on top.
 */

import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';

/**
 * Resolves an AST column/identifier expression to a base-table column index, or
 * `undefined` when it is not a (recognized) column of the frame. The default
 * realization is bare-name resolution — `columnIndexFromExpr` bound to a column
 * index map, ignoring any table/alias qualifier. The coverage prover injects a
 * qualifier-aware variant for join bodies, so `alias.col` resolves only against
 * the source `alias` actually denotes (see `coverage-prover.ts`).
 */
export type ColumnIndexResolver = (expr: AST.Expression) => number | undefined;

/**
 * Return the column index for an `AST.ColumnExpr` or unqualified
 * `AST.IdentifierExpr` that names a column in `columnIndexMap`; undefined
 * otherwise. Schema-qualified identifiers (`other.foo`) are rejected. The
 * table/alias qualifier on a `ColumnExpr` (`alias.col`) is **ignored** — bare
 * name resolution only; callers needing qualifier-awareness compose a
 * {@link ColumnIndexResolver}.
 *
 * The qualifier-blindness is load-bearing for CHECK extraction: `new.<col>`
 * row-image references resolve to the bare column, which is deliberate — NEW
 * is the stored row image, so NEW-qualified references are same-row facts.
 * Self-table qualifiers (`t.col` on the owning table) resolve the same way.
 * `old.<col>` references are NOT same-row; check-extraction screens those out
 * wholesale (`containsOldRowImageRef`) before this resolver ever sees them.
 */
export function columnIndexFromExpr(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): number | undefined {
	if (expr.type === 'column') {
		const ref = expr as AST.ColumnExpr;
		return columnIndexMap.get(ref.name.toLowerCase());
	}
	if (expr.type === 'identifier') {
		const ref = expr as AST.IdentifierExpr;
		if (ref.schema) return undefined;
		return columnIndexMap.get(ref.name.toLowerCase());
	}
	return undefined;
}

/**
 * Return the literal `SqlValue` for an `AST.LiteralExpr`, or undefined for any
 * other expression shape (functions, casts, casts-of-literals, etc.). Only
 * compile-time literals count for binding/domain purposes.
 */
export function literalValue(expr: AST.Expression): SqlValue | undefined {
	if (expr.type !== 'literal') return undefined;
	const lit = expr as AST.LiteralExpr;
	const v = lit.value;
	if (v instanceof Promise) return undefined;
	return v;
}

/**
 * Flip a comparison operator across its operands: if you rewrite `b op a` as
 * `a flipComparison(op) b`, the truth value is preserved. Unrecognized
 * operators (including `=`/`==`) round-trip unchanged.
 *
 * Used by `partial-unique-extraction.ts`, `check-extraction.ts`, and
 * `fd-utils.ts` to normalize `lit op col` into `col flipped lit`. Distinct
 * from predicate negation (the same-named `flipComparison` in
 * `predicate-normalizer.ts` returns `NOT op` instead of `swap-operands op`).
 */
export function flipComparison(op: string): string {
	switch (op) {
		case '<': return '>';
		case '<=': return '>=';
		case '>': return '<';
		case '>=': return '<=';
		default: return op;
	}
}

/**
 * Flatten a top-level `OR` chain into an array of disjunct expressions.
 * Non-OR roots return as a single-element array. Textual order is preserved.
 *
 * Shared by `check-extraction.ts` (implication-form CHECK recognition) and
 * `partial-unique-extraction.ts` (top-level OR guard recognition).
 */
export function flattenDisjunction(expr: AST.Expression): AST.Expression[] {
	const out: AST.Expression[] = [];
	const stack: AST.Expression[] = [expr];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur.type === 'binary' && (cur as AST.BinaryExpr).operator === 'OR') {
			const b = cur as AST.BinaryExpr;
			// Preserve textual order: push right then left so left is popped first.
			stack.push(b.right, b.left);
			continue;
		}
		out.push(cur);
	}
	return out;
}

/**
 * Depth-first iteration over every AST node in `expr`'s subtree. Children are
 * discovered reflectively (any object/array property carrying a `type` field)
 * rather than via a typed visitor table, so soundness-sensitive walkers (the
 * collation gate, the non-determinism screen) cannot silently miss node kinds
 * a visitor enumeration forgot.
 */
export function* walkAstNodes(expr: AST.Expression): IterableIterator<AST.AstNode> {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		yield node;
		for (const key of Object.keys(node)) {
			const v = (node as unknown as Record<string, unknown>)[key];
			if (!v) continue;
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === 'object' && 'type' in item) {
						stack.push(item as AST.AstNode);
					}
				}
			} else if (typeof v === 'object' && 'type' in (v as object)) {
				stack.push(v as AST.AstNode);
			}
		}
	}
}

/**
 * Collect the collation name of every COLLATE node anywhere in `expr`'s
 * subtree, as written (uninterpreted — no normalization). Empty array when the
 * subtree contains none. Used by the schema-level value-discrimination gate
 * (`comparison-collation.ts`) to detect non-BINARY wrappers inside compound
 * comparison operands.
 */
export function collectCollateNames(expr: AST.Expression): string[] {
	const out: string[] = [];
	for (const node of walkAstNodes(expr)) {
		if (node.type === 'collate') {
			out.push((node as AST.CollateExpr).collation);
		}
	}
	return out;
}

/**
 * Collect the set of column indices referenced by `expr`. Only column /
 * identifier nodes naming columns in `columnIndexMap` count. Returns an empty
 * set when the expression references zero recognized columns; the caller can
 * distinguish "no columns" (constant expression) from "exactly one column"
 * by inspecting the size.
 */
export function collectColumnNames(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): Set<number> {
	const out = new Set<number>();
	for (const node of walkAstNodes(expr)) {
		const idx = node.type === 'column' || node.type === 'identifier'
			? columnIndexFromExpr(node as AST.Expression, columnIndexMap)
			: undefined;
		if (idx !== undefined) out.add(idx);
	}
	return out;
}
