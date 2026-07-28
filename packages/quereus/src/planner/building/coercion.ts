import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { CastNode } from '../nodes/scalar.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { PhysicalType } from '../../types/logical-type.js';
import { NULL_TYPE } from '../../types/builtin-types.js';

/**
 * Plan-build cross-type coercion for comparison sites. Every construct that
 * compares operands — `=` and friends, BETWEEN, IN value lists, simple CASE,
 * and scalar builtins that declare a comparison group
 * ({@link import('../../schema/function.js').BaseFunctionSchema.comparesArgs}) —
 * reconciles its operands through this one module so none of them can drift
 * from the others.
 */

/**
 * Reconcile operands of a comparison whose plan-time types cannot be compared
 * meaningfully as-is, by wrapping one side in a synthetic CastNode.
 * Returns `[left, right]` — possibly with one side replaced by a CastNode.
 *
 * Two pairings are handled, in this order:
 *
 * 1. **Object-physical vs anything else.** JSON is the engine's only logical type
 *    whose `physicalType` is `PhysicalType.OBJECT`: its runtime values are native
 *    JS objects/arrays, which `compareSqlValuesFast` short-circuits against any
 *    other storage class — so `json_col = '{"a":1}'` was unconditionally false,
 *    even for byte-identical text. The non-object side is cast to the object
 *    side's type, never the reverse: casting the JSON side to text would make
 *    equality depend on spelling and put `=` out of step with the index, which
 *    compares structurally.
 *
 *    The gate is deliberately `physicalType === OBJECT`, **not**
 *    `semanticOrdering`. DATE/TIME/DATETIME/TIMESPAN also carry semantic ordering
 *    but are physically text, and the runtime's `tryTemporalComparison` already
 *    reconciles them; routing them through a cast would change behavior for no
 *    gain.
 *
 *    A cast to JSON is lenient (see `runtime/emit/cast.ts`): text that does not
 *    parse comes back unchanged, so `json_col = 'not json'` is false rather than
 *    an error. Note the consequence for JSON *string scalars*, which are stored
 *    as plain JS strings: a column holding `"hello"` matches BOTH the SQL literal
 *    `'"hello"'` (parses to the JSON string `hello`) and the bare `'hello'` (does
 *    not parse, falls back to the raw string `hello`, which `JSON_TYPE.compare`
 *    then compares as text). Only the first form generalizes — `'[1,2]'` matches
 *    the JSON array while a bare `[1,2]` is not SQL text at all.
 *
 * 2. **Numeric vs textual.** The textual operand is cast to the numeric side's
 *    type name (e.g. 'INTEGER' or 'REAL') so the runtime can take the fast path.
 */
export function insertCrossTypeCoercion(
	scope: Scope,
	left: ScalarPlanNode,
	right: ScalarPlanNode,
): [ScalarPlanNode, ScalarPlanNode] {
	const leftLogical = left.getType().logicalType;
	const rightLogical = right.getType().logicalType;

	const leftObject = leftLogical.physicalType === PhysicalType.OBJECT;
	const rightObject = rightLogical.physicalType === PhysicalType.OBJECT;
	// NOTE: two object-physical operands of DIFFERENT logical types fall through both
	// arms onto the generic runtime path. Unreachable while JSON is the only
	// PhysicalType.OBJECT type; adding a second one means deciding which side converts.
	// Exactly one side is object-physical. A NULL-typed operand is left alone: the
	// comparison is UNKNOWN regardless, so the cast would only add a runtime hop.
	if (leftObject !== rightObject) {
		if (leftObject && rightLogical !== NULL_TYPE) {
			return [left, wrapInCast(scope, right, leftLogical.name)];
		}
		if (rightObject && leftLogical !== NULL_TYPE) {
			return [wrapInCast(scope, left, rightLogical.name), right];
		}
		return [left, right];
	}

	const leftNumeric = !!leftLogical.isNumeric;
	const rightNumeric = !!rightLogical.isNumeric;
	const leftTextual = !!leftLogical.isTextual;
	const rightTextual = !!rightLogical.isTextual;

	if (leftNumeric && rightTextual) {
		// Wrap right (textual) in a cast to the left's numeric type
		return [left, wrapInCast(scope, right, leftLogical.name)];
	}
	if (rightNumeric && leftTextual) {
		// Wrap left (textual) in a cast to the right's numeric type
		return [wrapInCast(scope, left, rightLogical.name), right];
	}
	return [left, right];
}

/**
 * Apply the object-physical arm of {@link insertCrossTypeCoercion} across the
 * one-probe-against-many-values shape shared by an IN value list and a simple
 * CASE, so `json_col in ('{"a":1}')` and `case json_col when '{"a":1}' …` agree
 * with `json_col = '{"a":1}'`.
 *
 * Scoped to the object-physical pairing on purpose. The numeric ↔ textual arm has
 * never been applied to either site (`int_col in ('1')` is false today for the same
 * underlying reason), and turning it on here would change unrelated behavior; that
 * case is tracked by `bug-numeric-text-coercion-skips-in-and-case`. Note `=` and
 * BETWEEN DO apply it, so those two forms currently disagree with IN / simple CASE
 * on a numeric column compared against a numeric-looking string.
 *
 * The probe is shared by every value, so it is wrapped at most once — if any value
 * is object-physical while the probe is not, the probe is cast first and the values
 * are then reconciled against it.
 */
export function coerceObjectPhysicalSet(
	scope: Scope,
	probe: ScalarPlanNode,
	values: ScalarPlanNode[],
): [ScalarPlanNode, ScalarPlanNode[]] {
	const isObject = (node: ScalarPlanNode): boolean =>
		node.getType().logicalType.physicalType === PhysicalType.OBJECT;

	const objectValue = values.find(isObject);
	if (!isObject(probe) && !objectValue) return [probe, values];

	const coercedProbe = isObject(probe)
		? probe
		: wrapInCast(scope, probe, objectValue!.getType().logicalType.name);
	return [coercedProbe, values.map(val => insertCrossTypeCoercion(scope, coercedProbe, val)[1])];
}

/**
 * Apply {@link coerceObjectPhysicalSet} across the argument positions a scalar
 * function declares as one comparison group
 * ({@link import('../../schema/function.js').BaseFunctionSchema.comparesArgs}),
 * so `nullif(json_col, '{"a":1}')` reconciles its operands exactly as
 * `json_col = '{"a":1}'` does. The group's first member plays the probe role and
 * the rest the value-list role; positions outside the argument list are ignored
 * (defensive — a well-formed declaration never names one). Mutates `args` in
 * place, replacing coerced members with their CastNode wrappers.
 */
export function coerceComparisonGroup(
	scope: Scope,
	comparesArgs: 'all' | readonly number[],
	args: ScalarPlanNode[],
): void {
	const indices = comparesArgs === 'all'
		? args.map((_, i) => i)
		: comparesArgs.filter(i => i >= 0 && i < args.length);
	if (indices.length < 2) return;

	const [probeIdx, ...valueIdx] = indices;
	const [probe, values] = coerceObjectPhysicalSet(scope, args[probeIdx], valueIdx.map(i => args[i]));
	args[probeIdx] = probe;
	valueIdx.forEach((argIdx, j) => { args[argIdx] = values[j]; });
}

/** Create a synthetic CastNode wrapping `operand` with the given target type name. */
export function wrapInCast(
	scope: Scope,
	operand: ScalarPlanNode,
	targetType: string,
): CastNode {
	// Synthesise a minimal AST.CastExpr — `targetType` is the only field CastNode reads.
	const syntheticExpr: AST.CastExpr = {
		type: 'cast',
		expr: { type: 'literal', value: null } as AST.LiteralExpr, // placeholder
		targetType,
	};
	return new CastNode(scope, syntheticExpr, operand);
}
