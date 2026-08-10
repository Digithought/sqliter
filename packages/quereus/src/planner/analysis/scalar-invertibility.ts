import { type ScalarPlanNode } from '../nodes/plan-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { BinaryOpNode, CastNode, CollateNode, LiteralNode } from '../nodes/scalar.js';
import type * as AST from '../../parser/ast.js';

/**
 * Invertibility profile of a scalar transformation on an update path, per
 * `docs/vu-inverses.md` § Scalar Invertibility.
 *
 * - `passthrough` — the named argument is returned with a non-data-altering
 *   transformation; lineage threads through `arg` as if the call were absent
 *   (identity / column-rename / `collate` / a no-op `cast`).
 * - `inverse` — the function has a deterministic inverse `fn` (maps a written
 *   value back to the operand's value), optionally restricted to a `domain`
 *   predicate that the backward walk conjoins into the row-identifying
 *   predicate. Example: `x + k` (k a constant integer) has inverse `w => w - k`.
 * - `opaque` — no inverse known; the column becomes `computed` (read-only).
 *
 * **Law-gated registry.** A profile is only added once the round-trip law in
 * `test/property.spec.ts` (§ View Round-Trip Laws) covers it — see
 * `classifyInvertibility` for the current small registry.
 */
export type InvertibilityProfile =
	| { readonly kind: 'passthrough'; readonly arg: number }
	| { readonly kind: 'inverse'; readonly fn: (written: AST.Expression) => AST.Expression; readonly domain?: AST.Expression }
	| { readonly kind: 'opaque' };

/**
 * One step in the trace from a projection output back to a base column: the
 * underlying input attribute plus the composed inverse / domain accumulated
 * through the chain of invertible transforms above it.
 */
export interface ColumnTrace {
	readonly attrId: number;
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	readonly domain?: AST.Expression;
}

/** Build a binary AST expression node. */
function binExpr(operator: string, left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return { type: 'binary', operator, left, right };
}

/** Conjoin two optional domain predicates with AND. */
function conjoinDomain(a: AST.Expression | undefined, b: AST.Expression | undefined): AST.Expression | undefined {
	if (a && b) return binExpr('AND', a, b);
	return a ?? b;
}

/** The integer value of a constant `LiteralNode`, or `null` when not an integer literal. */
function asIntegerLiteral(node: ScalarPlanNode): { expr: AST.LiteralExpr; value: number } | null {
	if (!(node instanceof LiteralNode)) return null;
	const v = node.expression.value;
	if (typeof v === 'number' && Number.isInteger(v)) return { expr: node.expression, value: v };
	if (typeof v === 'bigint') return { expr: node.expression, value: Number(v) };
	return null;
}

/** True for a `cast(x as T)` whose target logical type equals the operand's (a value-preserving no-op).
 *  Exported as the single definition of "value-preserving cast" for every analysis whose unwrap
 *  discards the wrapper — `coarsened-key.ts`, `sat-checker.ts` and `constraint-extractor.ts` —
 *  so all of them agree with this registry's passthrough classification.
 *
 *  NOTE: logical types compare by identity (registry singletons). A plugin-registered type that
 *  duplicates a builtin's name as a distinct object would read as *converting*, costing pushdown
 *  but never soundness. If duplicate-name types become common, compare by name instead.
 *
 *  NOTE: "no-op" holds only because stored values are coerced to their column's declared type on
 *  write, so a TEXT column never holds a number. If Quereus ever adopts SQLite-style loose column
 *  typing, `cast(x as text)` stops being value-preserving and every caller here becomes unsound. */
export function isNoOpCast(node: CastNode): boolean {
	return node.operand.getType().logicalType === node.getType().logicalType;
}

/**
 * Constant-integer `+` / `-` profile. Returns the column-bearing operand and the
 * inverse `fn` for `x op k` / `k op x`, or `null` when the node is not a
 * constant-integer add/sub over a numeric operand.
 */
function classifyArithmetic(node: BinaryOpNode): { columnChild: ScalarPlanNode; fn: (w: AST.Expression) => AST.Expression } | null {
	const op = node.expression.operator;
	if (op !== '+' && op !== '-') return null;
	const leftLit = asIntegerLiteral(node.left);
	const rightLit = asIntegerLiteral(node.right);

	// Exactly one operand is a constant integer literal; the other is the column.
	if (rightLit && !leftLit) {
		if (!node.left.getType().logicalType.isNumeric) return null;
		const k = rightLit.expr;
		// `x + k` → x = w - k ;  `x - k` → x = w + k
		const inv = op === '+' ? '-' : '+';
		return { columnChild: node.left, fn: (w) => binExpr(inv, w, k) };
	}
	if (leftLit && !rightLit) {
		if (!node.right.getType().logicalType.isNumeric) return null;
		const k = leftLit.expr;
		// `k + x` → x = w - k ;  `k - x` → x = k - w
		if (op === '+') return { columnChild: node.right, fn: (w) => binExpr('-', w, k) };
		return { columnChild: node.right, fn: (w) => binExpr('-', k, w) };
	}
	return null;
}

/**
 * Classify a scalar plan node's invertibility on the update path against the
 * law-gated registry (`docs/vu-inverses.md` § Scalar Invertibility):
 *
 * - a column reference (with or without an alias) → `passthrough` (identity / rename),
 * - `collate(x, _)` → `passthrough` (collation does not alter the stored value),
 * - a no-op `cast` (target logical type === operand's) → `passthrough`,
 * - `x ± k` / `k ± x` over a numeric operand with a constant integer `k` → `inverse`,
 * - everything else (lossy cast, string functions, …) → `opaque`.
 *
 * Top-level classifier only; {@link traceInvertibleColumn} composes the chain.
 */
export function classifyInvertibility(node: ScalarPlanNode): InvertibilityProfile {
	if (node instanceof ColumnReferenceNode) return { kind: 'passthrough', arg: 0 };
	if (node instanceof CollateNode) return { kind: 'passthrough', arg: 0 };
	if (node instanceof CastNode) return isNoOpCast(node) ? { kind: 'passthrough', arg: 0 } : { kind: 'opaque' };
	if (node instanceof BinaryOpNode) {
		const arith = classifyArithmetic(node);
		if (arith) return { kind: 'inverse', fn: arith.fn };
	}
	return { kind: 'opaque' };
}

/**
 * Trace a projection output expression back to a single base input attribute,
 * descending through the chain of invertible transforms the registry classifies
 * and composing their inverses (outer-most applied first to a written value).
 * Returns `null` when the expression is opaque, references more than one column,
 * or bottoms out at a non-column leaf — the caller then marks the output
 * `computed`.
 *
 * Composition: for `out = f(child)` with `child = g⁻¹(base)` (the inner trace's
 * inverse `g⁻¹`), a written `out` value `w` binds `base = g⁻¹(f⁻¹(w))`, i.e. the
 * inner inverse wraps the outer one.
 */
export function traceInvertibleColumn(node: ScalarPlanNode): ColumnTrace | null {
	if (node instanceof ColumnReferenceNode) return { attrId: node.attributeId };
	if (node instanceof CollateNode) return traceInvertibleColumn(node.operand);
	if (node instanceof CastNode) return isNoOpCast(node) ? traceInvertibleColumn(node.operand) : null;
	if (node instanceof BinaryOpNode) {
		const arith = classifyArithmetic(node);
		if (!arith) return null;
		const inner = traceInvertibleColumn(arith.columnChild);
		if (!inner) return null;
		const innerInv = inner.inverse;
		const inverse = innerInv ? (w: AST.Expression) => innerInv(arith.fn(w)) : arith.fn;
		return { attrId: inner.attrId, inverse, domain: inner.domain };
	}
	return null;
}

/** Conjoin a base site's existing domain with one accumulated from an outer transform. */
export function composeDomain(a: AST.Expression | undefined, b: AST.Expression | undefined): AST.Expression | undefined {
	return conjoinDomain(a, b);
}

/**
 * AST-level companion used by the view-mutation rewrite, which works on the
 * view body's `selectAst` projection list rather than the planned tree. A
 * projection that is a bare column reference is an invertible (identity/rename)
 * mapping onto that base column; anything else is a computed (read-only) column.
 *
 * Intentionally narrower than {@link classifyInvertibility}: this AST-level
 * classifier stays identity-only so `deriveViewColumns` keeps its shipped
 * Phase-1 behavior. The richer transform chain lives on the planned tree
 * (`PhysicalProperties.updateLineage`), which the view-mutation orchestrator
 * consumes directly.
 */
export type ProjectionLineage =
	| { readonly kind: 'base'; readonly baseColumnName: string }
	| { readonly kind: 'computed' };

export function classifyProjectionExpr(expr: AST.Expression): ProjectionLineage {
	if (expr.type === 'column') {
		return { kind: 'base', baseColumnName: expr.name };
	}
	return { kind: 'computed' };
}
