import type { SqlValue } from '../common/types.js';

/**
 * Canonical numeric representation — the one-JavaScript-form-per-integer-value rule.
 * Full contract in docs/types.md § "Physical representation"; the short form:
 *
 * R1 (every `SqlValue`, whatever its declared type): a value is a JS `bigint` only
 * when its magnitude is outside the safe-integer range (|v| > 2^53 − 1). Every
 * integer value inside that range is a JS `number`.
 *
 * R2 (per declared type): INTEGER holds a safe-integer `number` or an out-of-range
 * `bigint`; REAL holds `number` only; NUMERIC holds either under R1. A whole-valued
 * `number` outside the safe range (e.g. `1e20` in a REAL position) does NOT violate
 * R1 — R1 constrains which values may be `bigint`, not which `number`s may be whole.
 *
 * The boundary is `Number.isSafeInteger`, not "exactly representable as a double":
 * 2^53 itself is representable but 2^53 + 1 is not, so arithmetic at the boundary
 * stops round-tripping. 9007199254740992 is therefore a `bigint`.
 *
 * Canonicalization happens where values are BORN (literal lexing, type parse,
 * parameter bind, bigint arithmetic/aggregation results) — not per-row on read
 * paths. Rows from virtual-table `query()` and UDF return values are held to R1 by
 * contract, not by coercion here.
 */

// Compare against bigint constants, never via Number(v): Number(hugeBigint) is
// lossy and can be Infinity.
const MAX_SAFE_INTEGER_BIGINT = 9007199254740991n;
const MIN_SAFE_INTEGER_BIGINT = -9007199254740991n;

/**
 * Canonicalize an integer-domain value: narrow a safe-range `bigint` to `number`,
 * widen a finite whole `number` past the safe boundary to an exact `bigint`.
 *
 * Non-integer numbers pass through untouched — fractional values, `NaN` and
 * `±Infinity` are the caller's business (`BigInt()` would throw on all three;
 * INTEGER's `validate` keeps rejecting the non-finites with its MISMATCH message).
 * `-0` is a safe integer and stays the `number` `-0`.
 */
export function canonicalizeInteger(v: number | bigint): number | bigint {
	if (typeof v === 'bigint') {
		return v >= MIN_SAFE_INTEGER_BIGINT && v <= MAX_SAFE_INTEGER_BIGINT ? Number(v) : v;
	}
	if (!Number.isSafeInteger(v) && Number.isInteger(v)) {
		return BigInt(v);
	}
	return v;
}

/**
 * Canonicalize a value of unknown storage class at an ingress seam (parameter
 * bind): a safe-range `bigint` narrows to `number`, everything else passes
 * through. Deliberately does NOT widen whole `number`s — a bound `1e20` may be a
 * REAL parameter, and R1 permits it as a `number`; widening belongs to
 * INTEGER/NUMERIC `parse`, which knows the declared type.
 */
export function canonicalizeSqlValue(v: SqlValue): SqlValue {
	return typeof v === 'bigint' ? canonicalizeInteger(v) : v;
}

/**
 * R1 check for assertions/tests (and the follow-on strict checker): a `bigint`
 * must be outside the safe-integer range; every other storage class is trivially
 * canonical.
 */
export function isCanonicalNumeric(v: SqlValue): boolean {
	if (typeof v === 'bigint') {
		return v > MAX_SAFE_INTEGER_BIGINT || v < MIN_SAFE_INTEGER_BIGINT;
	}
	return true;
}
