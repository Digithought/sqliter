import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { CastNode } from '../nodes/scalar.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { LogicalType } from '../../types/logical-type.js';
import { PhysicalType } from '../../types/logical-type.js';
import { NULL_TYPE, NUMERIC_TYPE } from '../../types/builtin-types.js';

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
 * Apply {@link insertCrossTypeCoercion} across the one-probe-against-many-values
 * shape shared by an IN value list, a simple CASE and a scalar builtin's
 * comparison group, so `json_col in ('{"a":1}')`, `int_col in ('1')` and
 * `case int_col when '1' …` all agree with the `=` spelling of the same
 * comparison.
 *
 * The probe is a single plan node shared by every value, so it can be wrapped at
 * most once — which is what makes this more than a `map` over the pairwise
 * function:
 *
 * - **A value-side cast is per value** and never conflicts: an object-physical or
 *   numeric probe leaves the probe alone and casts each value independently, so a
 *   mixed list (`case i when '1' when 2 …`) gets a per-clause decision for free.
 * - **A probe-side cast is hoisted** and therefore has to be unambiguous. For the
 *   object arm it always is: a cast to JSON is lenient, so a textual value that is
 *   not JSON source survives as itself and still compares as text. For the numeric
 *   arm it is NOT — `cast('abc' as real)` is `0`, so hoisting a probe cast over a
 *   MIXED list would make `t in (1, 'abc')` true for the stored text `'0'`, which
 *   `t = 1 or t = 'abc'` is not. So the numeric probe cast is applied only when
 *   every non-NULL value is numeric.
 *
 * NOTE: the leftover gap is a textual probe against a list mixing numeric and
 * textual values (`text_col in (1, 'abc')`), which stays uncoerced and so still
 * disagrees with the `=` disjunction on the numeric member. Closing it needs a
 * per-value probe, which `IN` cannot express — its members live in ONE key space
 * (a BTree keyed under one collation, `runtime/emit/subquery.ts`). If that shape
 * ever matters, desugar a mixed `IN` list into an `OR` of `=` comparisons at build
 * time rather than widening the hoist here.
 */
export function coerceComparisonSet(
	scope: Scope,
	probe: ScalarPlanNode,
	values: ScalarPlanNode[],
): [ScalarPlanNode, ScalarPlanNode[]] {
	const probeType = probe.getType().logicalType;
	const isObject = (type: LogicalType): boolean => type.physicalType === PhysicalType.OBJECT;

	// Object arm: cast the non-object side, exactly as the pairwise function does.
	const objectValue = values.find(val => isObject(val.getType().logicalType));
	if (isObject(probeType) || objectValue) {
		const coercedProbe = isObject(probeType)
			? probe
			: wrapInCast(scope, probe, objectValue!.getType().logicalType.name);
		return [coercedProbe, values.map(val => insertCrossTypeCoercion(scope, coercedProbe, val)[1])];
	}

	// Numeric probe: every textual value casts to the probe's numeric type, independently.
	if (probeType.isNumeric) {
		return [probe, values.map(val => insertCrossTypeCoercion(scope, probe, val)[1])];
	}

	// Textual probe: one hoisted cast, but only over an all-numeric value list.
	if (probeType.isTextual) {
		const valueTypes = values.map(val => val.getType().logicalType).filter(type => type !== NULL_TYPE);
		if (valueTypes.length > 0 && valueTypes.every(type => type.isNumeric)) {
			return [wrapInCast(scope, probe, commonNumericTypeName(valueTypes)), values];
		}
	}

	return [probe, values];
}

/**
 * The cast target for a hoisted probe cast over an all-numeric value list. One
 * shared type name means one key space; NUMERIC is the fallback because its value
 * space (`number | bigint`) covers INTEGER and REAL together, so a list mixing a
 * bigint literal with a real one does not have to pick a lossy winner.
 */
function commonNumericTypeName(valueTypes: readonly LogicalType[]): string {
	const first = valueTypes[0];
	return valueTypes.every(type => type === first) ? first.name : NUMERIC_TYPE.name;
}

/**
 * Apply {@link coerceComparisonSet} across the argument positions a scalar
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
	const [probe, values] = coerceComparisonSet(scope, args[probeIdx], valueIdx.map(i => args[i]));
	args[probeIdx] = probe;
	valueIdx.forEach((argIdx, j) => { args[argIdx] = values[j]; });
}

/** Create a synthetic CastNode wrapping `operand` with the given target type name. */
export function wrapInCast(
	scope: Scope,
	operand: ScalarPlanNode,
	targetType: string,
): CastNode {
	// Synthesise an AST.CastExpr. `targetType` is the only field CastNode itself
	// reads, but `formatExpression` renders a node from its AST rather than from
	// its children — a `literal null` placeholder here made every coerced operand
	// print as `cast(null as integer)` in EXPLAIN while the real operand child was
	// intact. Carrying the operand's own AST keeps the rendering truthful.
	const syntheticExpr: AST.CastExpr = {
		type: 'cast',
		expr: operand.expression,
		targetType,
	};
	return new CastNode(scope, syntheticExpr, operand);
}
