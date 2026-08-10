import type { LogicalType } from './logical-type.js';
import { PhysicalType } from './logical-type.js';
import { NULL_TYPE, NUMERIC_TYPE } from './builtin-types.js';

/**
 * THE type-level decision behind every comparison-site coercion: given the
 * declared types of the operands, which of them must be converted, and to what.
 * Purely about `LogicalType` — no plan nodes, no values — so both consumers read
 * the same rule and cannot drift:
 *
 * - **Plan-time** (`planner/building/coercion.ts`) maps the answer onto synthetic
 *   `CastNode` wrappers, for `=` and friends, BETWEEN, IN value lists and simple
 *   CASE.
 * - **Emit-time** (`runtime/emit/operand-comparator.ts` `makeComparisonGroup`)
 *   maps the same answer onto per-row {@link import('./cast-semantics.js').lenientCast}
 *   calls, for the comparison builtins that *return* one of their arguments
 *   (`nullif`, `greatest`, `least`) and therefore cannot have that argument
 *   replaced by its cast.
 *
 * Both paths convert identically: a plan-time `CastNode` runs `lenientCast` per
 * row too (`runtime/emit/cast.ts`), so "compare the converted copy" and "compare
 * the cast operand" are the same comparison.
 */

/**
 * The argument positions a function's `comparesArgs` declaration
 * ({@link import('../schema/function.js').BaseFunctionSchema.comparesArgs}) names,
 * clamped to the call's actual arity. Index 0 of the result is the group's probe.
 * Shared by the plan-time rewrite and the emit-time group builder so they cannot
 * disagree about which positions form the group.
 */
export function comparisonGroupIndices(
	comparesArgs: 'all' | readonly number[],
	argCount: number,
): readonly number[] {
	return comparesArgs === 'all'
		? Array.from({ length: argCount }, (_, i) => i)
		: comparesArgs.filter(i => i >= 0 && i < argCount);
}

/** Which side of a pairwise comparison converts, and to what. */
export interface CrossTypeCoercion {
	readonly side: 'left' | 'right';
	readonly target: LogicalType;
}

const isObject = (type: LogicalType): boolean => type.physicalType === PhysicalType.OBJECT;

/**
 * Reconcile two operand types that cannot be compared meaningfully as-is.
 * Returns `null` when neither side converts.
 *
 * Two pairings are handled, in this order:
 *
 * 1. **Object-physical vs anything else.** JSON is the engine's only logical type
 *    whose `physicalType` is `PhysicalType.OBJECT`: its runtime values are native
 *    JS objects/arrays, which `compareSqlValuesFast` short-circuits against any
 *    other storage class — so `json_col = '{"a":1}'` was unconditionally false,
 *    even for byte-identical text. The non-object side converts to the object
 *    side's type, never the reverse: converting the JSON side to text would make
 *    equality depend on spelling and put `=` out of step with the index, which
 *    compares structurally.
 *
 *    The gate is deliberately `physicalType === OBJECT`, **not**
 *    `semanticOrdering`. DATE/TIME/DATETIME/TIMESPAN also carry semantic ordering
 *    but are physically text, and the runtime's `tryTemporalComparison` already
 *    reconciles them; routing them through a conversion would change behavior for
 *    no gain.
 *
 *    A conversion to JSON is lenient (see `types/cast-semantics.ts`): text that
 *    does not parse comes back unchanged, so `json_col = 'not json'` is false
 *    rather than an error. Note the consequence for JSON *string scalars*, which
 *    are stored as plain JS strings: a column holding `"hello"` matches BOTH the
 *    SQL literal `'"hello"'` (parses to the JSON string `hello`) and the bare
 *    `'hello'` (does not parse, falls back to the raw string `hello`, which
 *    `JSON_TYPE.compare` then compares as text). Only the first form generalizes —
 *    `'[1,2]'` matches the JSON array while a bare `[1,2]` is not SQL text at all.
 *
 *    A NULL-typed operand is left alone: the comparison is UNKNOWN regardless, so
 *    the conversion would only add a runtime hop.
 *
 * 2. **Numeric vs textual.** The textual operand converts to the numeric side's
 *    type (e.g. INTEGER or REAL) so the runtime can take the fast path.
 */
export function crossTypeCoercion(left: LogicalType, right: LogicalType): CrossTypeCoercion | null {
	const leftObject = isObject(left);
	const rightObject = isObject(right);

	// NOTE: two object-physical operands of DIFFERENT logical types fall through both
	// arms onto the generic runtime path. Unreachable while JSON is the only
	// PhysicalType.OBJECT type; adding a second one means deciding which side converts.
	if (leftObject !== rightObject) {
		if (leftObject && right !== NULL_TYPE) return { side: 'right', target: left };
		if (rightObject && left !== NULL_TYPE) return { side: 'left', target: right };
		return null;
	}

	if (left.isNumeric && right.isTextual) return { side: 'right', target: left };
	if (right.isNumeric && left.isTextual) return { side: 'left', target: right };
	return null;
}

/**
 * Per-operand conversion target for a "one probe against many values" comparison
 * group — an IN value list, a simple CASE, or a comparison builtin's argument
 * group. Index 0 is the probe, the rest the value list. The result is aligned with
 * the input array; `null` at a position means "leave that operand alone".
 *
 * This is more than a `map` over {@link crossTypeCoercion} because the probe is a
 * SINGLE operand shared by every value, so it can convert at most once:
 *
 * - **A value-side conversion is per value** and never conflicts: an
 *   object-physical or numeric probe leaves the probe alone and converts each
 *   value independently, so a mixed list (`case i when '1' when 2 …`) gets a
 *   per-clause decision for free.
 * - **A probe-side conversion is hoisted** and therefore has to be unambiguous.
 *   For the object arm it always is: a conversion to JSON is lenient, so a textual
 *   value that is not JSON source survives as itself and still compares as text.
 *   For the numeric arm it is NOT — `cast('abc' as real)` is `0`, so hoisting a
 *   probe conversion over a MIXED list would make `t in (1, 'abc')` true for the
 *   stored text `'0'`, which `t = 1 or t = 'abc'` is not. So the numeric probe
 *   conversion applies only when every non-NULL value is numeric.
 *
 * NOTE: the leftover gap is a textual probe against a list mixing numeric and
 * textual values (`text_col in (1, 'abc')`), which stays unconverted and so still
 * disagrees with the `=` disjunction on the numeric member. Closing it needs a
 * per-value probe, which `IN` cannot express — its members live in ONE key space
 * (a BTree keyed under one collation, `runtime/emit/subquery.ts`). If that shape
 * ever matters, desugar a mixed `IN` list into an `OR` of `=` comparisons at build
 * time rather than widening the hoist here.
 */
export function comparisonGroupCoercions(
	logicals: readonly LogicalType[],
): readonly (LogicalType | null)[] {
	const none = logicals.map(() => null);
	if (logicals.length < 2) return none;

	const probe = logicals[0];
	const values = logicals.slice(1);

	/** The value-side half of a pairwise decision against an already-settled probe type. */
	const valueTarget = (probeType: LogicalType, value: LogicalType): LogicalType | null => {
		const coercion = crossTypeCoercion(probeType, value);
		return coercion?.side === 'right' ? coercion.target : null;
	};

	// Object arm: the non-object side converts, exactly as the pairwise function decides.
	const objectValue = values.find(isObject);
	if (isObject(probe) || objectValue) {
		const effectiveProbe = isObject(probe) ? probe : objectValue!;
		return [
			isObject(probe) ? null : effectiveProbe,
			...values.map(value => valueTarget(effectiveProbe, value)),
		];
	}

	// Numeric probe: every textual value converts to the probe's numeric type, independently.
	if (probe.isNumeric) {
		return [null, ...values.map(value => valueTarget(probe, value))];
	}

	// Textual probe: one hoisted conversion, but only over an all-numeric value list.
	if (probe.isTextual) {
		const nonNull = values.filter(type => type !== NULL_TYPE);
		if (nonNull.length > 0 && nonNull.every(type => type.isNumeric)) {
			return [commonNumericType(nonNull), ...values.map(() => null)];
		}
	}

	return none;
}

/**
 * The conversion target for a hoisted probe over an all-numeric value list. One
 * shared type means one key space; NUMERIC is the fallback because its value
 * space (`number | bigint`) covers INTEGER and REAL together, so a list mixing a
 * bigint literal with a real one does not have to pick a lossy winner.
 */
function commonNumericType(valueTypes: readonly LogicalType[]): LogicalType {
	const first = valueTypes[0];
	return valueTypes.every(type => type === first) ? first : NUMERIC_TYPE;
}
