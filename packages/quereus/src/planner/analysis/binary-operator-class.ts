/**
 * The single operator vocabulary for `AST.BinaryExpr` / `BinaryOpNode`.
 *
 * Consumers used to each restate which operator spellings they recognize, and drifted. They
 * now all dispatch on {@link classifyBinaryOperator}:
 *  - `BinaryOpNode.generateType` (planner/nodes/scalar.ts) — the announced result type,
 *  - `buildBinaryOpSpec` (runtime/emit/binary.ts) — the evaluator body,
 *  - {@link isComparisonOperator} (analysis/comparison-collation.ts) — collation validation,
 *  - `needsComparisonCoercion` (building/expression.ts) — cross-type coercion insertion,
 *  - `isScalarComparisonOperator` (analysis/scalar-param-usage.ts) — the object-valued
 *    parameter guard.
 *
 * So a newly added operator is either classified for everyone or unknown to everyone — it
 * cannot be evaluated as a comparison while being announced as its left operand's type
 * (which is exactly what `==`, `XOR` and `LIKE` did).
 *
 * Operator spellings are matched case-insensitively. That matters: the parser emits keyword
 * operators uppercased, but internally synthesized ASTs do not always
 * (`util/mutation-statement.ts` builds `operator: 'and'`), and a case-sensitive `switch`
 * silently misclassified those.
 */

/**
 * How a binary operator behaves — the classification both the type announcement and the
 * runtime body key off.
 *
 * `is` and `in` are classified even though `buildBinaryOpSpec` has no body for them: the
 * planner still has to announce their result type, and `IN` in particular reaches the
 * planner as its own `InNode` rather than a `BinaryOpNode`. Classifying them keeps the
 * vocabulary complete rather than leaving them to fall into "unknown".
 */
export type BinaryOperatorClass =
	/** `+ - * / %` — result type from the temporal operation table, numeric promotion, or ANY. */
	| 'arithmetic'
	/** `= == != <> < <= > >=` — BOOLEAN, and the class that resolves one collation across both operands. */
	| 'comparison'
	/** `IS` / `IS NOT` — null-safe comparison: BOOLEAN and never NULL. */
	| 'is'
	/** `IN` — BOOLEAN membership test. */
	| 'in'
	/** `AND OR XOR` — three-valued logic over SQL truthiness; BOOLEAN. */
	| 'logical'
	/** `||` — TEXT concatenation. */
	| 'concat'
	/** `LIKE` — BOOLEAN pattern match. */
	| 'like';

const CLASS_BY_OPERATOR = new Map<string, BinaryOperatorClass>([
	['+', 'arithmetic'],
	['-', 'arithmetic'],
	['*', 'arithmetic'],
	['/', 'arithmetic'],
	['%', 'arithmetic'],
	['=', 'comparison'],
	['==', 'comparison'],
	['!=', 'comparison'],
	['<>', 'comparison'],
	['<', 'comparison'],
	['<=', 'comparison'],
	['>', 'comparison'],
	['>=', 'comparison'],
	['IS', 'is'],
	['IS NOT', 'is'],
	['IN', 'in'],
	['AND', 'logical'],
	['OR', 'logical'],
	['XOR', 'logical'],
	['||', 'concat'],
	['LIKE', 'like'],
	// TODO: bitwise operators (& | << >> ) — the parser does not produce them yet.
]);

/**
 * The class of `operator`, or `undefined` for a spelling no consumer implements.
 * Case-insensitive.
 *
 * Callers must handle `undefined` explicitly rather than assuming a default: the planner
 * announces ANY (it cannot describe values it cannot produce) and the emitter raises
 * `UNSUPPORTED`.
 */
export function classifyBinaryOperator(operator: string): BinaryOperatorClass | undefined {
	return CLASS_BY_OPERATOR.get(operator.toUpperCase());
}
