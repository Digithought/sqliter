/**
 * Symmetric per-column LOGICAL-type merge for set operations (UNION / UNION ALL /
 * INTERSECT / EXCEPT / DIFF) — the type half of set-op output-column resolution;
 * the collation half is `resolveSetOpColumnCollation` in `comparison-collation.ts`.
 *
 * A set operation's output column carries rows from BOTH operands, so the type it
 * advertises must describe both — everything downstream trusts it (the DML write
 * pass `buildRowCoercion` skips conversion on an identity match, the set-op dedup
 * comparator keys off it, predicate coercion decides casts from it). The merge is
 * order-independent: swapping the operands can never change the result.
 *
 * Rules, first match wins (see docs/types.md § Where coercion happens):
 *  1. Identical logical types → that type (registry singletons, identity compare).
 *  2. Either side is NULL → the other side's type (a `select null` branch is a
 *     valid member of every type and must not poison a well-typed union).
 *  3. Both builtin numeric (and differing) → NUMERIC, whose value space
 *     (`number | bigint`) covers both branches as they actually are — no branch
 *     conversion needed. NOT the CASE rule ("arms differ ⇒ TEXT") — `1 union all
 *     2.5` must stay numeric; and NOT arithmetic's INTEGER + REAL → REAL, which
 *     describes one value, not a stream mixing both forms.
 *  4. Exactly one side object-physical (JSON today) → the object side's type,
 *     with the other operand marked `convert` — the same rule and direction
 *     `insertCrossTypeCoercion` applies to comparisons (casting the JSON side to
 *     text would make identity depend on spelling and diverge from the index's
 *     structural compare). The caller is responsible for actually converting the
 *     marked operand (a lenient CAST); a caller that cannot must advertise ANY
 *     instead ({@link mergeSetOpAdvertisedType}).
 *  5. Otherwise → ANY. The honest answer for a pair with no principled common
 *     type (DATE ∪ TEXT, BLOB ∪ TEXT, …): ANY's `parse` is pass-through and its
 *     `compare` is storage-class + BINARY ordering, and at a DML it is never
 *     identical to a declared column type, so every consumer converts — correct
 *     precisely because no branch is guaranteed to already be in target form.
 */

import type { LogicalType } from '../../types/logical-type.js';
import { PhysicalType } from '../../types/logical-type.js';
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, NUMERIC_TYPE, ANY_TYPE } from '../../types/builtin-types.js';

/** Outcome of merging one set-op output column's two operand logical types. */
export interface SetOpColumnTypeMerge {
	/** The merged (advertised) logical type, assuming `convert` (if set) is honored. */
	readonly logicalType: LogicalType;
	/**
	 * The operand whose values must be CAST (leniently) to `logicalType` for the
	 * merge to hold — set only by rule 4 (object-physical vs other). Absent means
	 * both operands already produce `logicalType`-compatible values as-is.
	 */
	readonly convert?: 'left' | 'right';
}

/** The three builtin numeric types rule 3 accepts; any other numeric falls to ANY. */
function isBuiltinNumeric(t: LogicalType): boolean {
	return t === INTEGER_TYPE || t === REAL_TYPE || t === NUMERIC_TYPE;
}

/**
 * Merge two set-op operand column logical types under rules 1–5 above.
 * Symmetric: `merge(a, b).logicalType === merge(b, a).logicalType`, with
 * `convert` flipping sides accordingly.
 */
export function mergeSetOpColumnType(left: LogicalType, right: LogicalType): SetOpColumnTypeMerge {
	// 1. Identical (the registry hands out one instance per type).
	// NOTE: a schema that round-trips through persistence (observed once on the
	// store module's rename path) can hold a NON-singleton LogicalType, which this
	// identity compare — and rule 3's isBuiltinNumeric — then miss; the merge
	// degrades to NUMERIC/ANY (over-wide, never wrong). If store-backed columns
	// ever visibly advertise ANY where the types match, switch these to
	// name-based comparison.
	if (left === right) return { logicalType: left };

	// 2. NULL is a member of every type; the other side's claim stands.
	if (left === NULL_TYPE) return { logicalType: right };
	if (right === NULL_TYPE) return { logicalType: left };

	// 3. Any DIFFERING pair of builtin numerics → NUMERIC (rule 1 already consumed
	// the identical pairs): `number | bigint` is the only builtin numeric value
	// space the unconverted mixed stream inhabits. A non-builtin numeric type has
	// no principled promotion — fall through to ANY (rule 5) rather than guess.
	//
	// Do NOT "restore consistency" with `BinaryOpNode.generateType` / `findCommonType`,
	// which promote INTEGER + REAL to REAL — correct there (one value in one form),
	// wrong here (a stream mixing both). Advertising REAL used to land a bigint
	// unconverted in a REAL-declared column, because `buildRowCoercion` skipped the
	// identity match outright (ticket `set-op-numeric-promotion-skips-conversion`).
	// Its conformance guard now catches that, but the merge still must not claim
	// REAL: the guard would convert the INTEGER branch's bigints to doubles, trading
	// a representation violation for silent precision loss.
	if (left.isNumeric && right.isNumeric) {
		if (isBuiltinNumeric(left) && isBuiltinNumeric(right)) return { logicalType: NUMERIC_TYPE };
		return { logicalType: ANY_TYPE };
	}

	// 4. Object-physical vs anything else: the object side wins and the other
	// side converts. NULL was consumed by rule 2, so `convert` never targets a
	// NULL-typed operand.
	const leftObject = left.physicalType === PhysicalType.OBJECT;
	const rightObject = right.physicalType === PhysicalType.OBJECT;
	if (leftObject !== rightObject) {
		return leftObject
			? { logicalType: left, convert: 'right' }
			: { logicalType: right, convert: 'left' };
	}

	// 5. No principled common type.
	return { logicalType: ANY_TYPE };
}

/**
 * The logical type a set operation may HONESTLY advertise for a column pair
 * when no operand conversion will be performed: the merge result, except a
 * rule-4 pair collapses to ANY (advertising the object side's type over an
 * unconverted text operand is exactly the defect this module exists to fix).
 *
 * `SetOperationNode` reads its output types through this: its factory aligns
 * rule-4 operands with a lenient CAST up front, so an aligned tree hits rule 1
 * here and the ANY collapse only fires for a pair the factory could not align
 * (a flag-surfacing branch) or a hand-built unaligned tree.
 */
export function mergeSetOpAdvertisedType(left: LogicalType, right: LogicalType): LogicalType {
	const merged = mergeSetOpColumnType(left, right);
	return merged.convert ? ANY_TYPE : merged.logicalType;
}
