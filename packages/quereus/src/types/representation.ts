import type { DeepReadonly, SqlValue } from '../common/types.js';
import { PhysicalType, type LogicalType } from './logical-type.js';

/**
 * "Does this value inhabit this declared type's JS value space" — rule R2 of
 * docs/types.md § Physical representation, as a pure predicate with no assertion or
 * diagnostic machinery attached.
 *
 * Two consumers share it and MUST NOT be allowed to disagree about what conforms:
 *
 * - the off-by-default representation checker (`runtime/strict-representation.ts`),
 *   which turns a violation into a `RepresentationError`;
 * - the DML write path (`buildRowCoercion` / `buildCellCoercion` in `validation.ts`),
 *   which converts a cell whose statically-announced type is contradicted by the value
 *   actually in hand.
 *
 * Lives in `types/` rather than `runtime/` for that second consumer: the `types/` layer
 * must not import from `runtime/`.
 */

/**
 * A declared type as this predicate reads it. Only `name` and `physicalType` are
 * consulted, and the parameter is `DeepReadonly` so both a raw `LogicalType` (column
 * schema) and the frozen one a `ScalarType` carries are accepted without a cast.
 */
export type DeclaredType = DeepReadonly<LogicalType>;

/**
 * Tests one non-null value against one declared type. Pre-selected per `physicalType` by
 * {@link buildConformanceCheck} so a per-row caller pays a `typeof`/`instanceof` rather
 * than a switch.
 */
export type ConformanceCheck = (value: Exclude<SqlValue, null>) => boolean;

const INTEGER_CONFORMS: ConformanceCheck = value =>
	typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value));

const REAL_CONFORMS: ConformanceCheck = value => typeof value === 'number';

/** REAL's physical type plus `bigint` — see the NUMERIC note on {@link buildConformanceCheck}. */
const NUMERIC_CONFORMS: ConformanceCheck = value =>
	typeof value === 'number' || typeof value === 'bigint';

const TEXT_CONFORMS: ConformanceCheck = value => typeof value === 'string';

const BLOB_CONFORMS: ConformanceCheck = value => value instanceof Uint8Array;

const BOOLEAN_CONFORMS: ConformanceCheck = value => typeof value === 'boolean';

/**
 * Mirrors `JSON_TYPE.validate`: a native object/array (a blob is not one), or a JSON
 * scalar — a JSON string scalar is physically a plain `string`, a JSON number scalar a
 * plain `number`.
 */
const OBJECT_CONFORMS: ConformanceCheck = value =>
	(typeof value === 'object' && !(value instanceof Uint8Array))
	|| typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/**
 * Pre-select the R2 arm for a declared type once, for a caller that will test many values
 * against it (the write-path guard, per row). Returns `undefined` when the type imposes no
 * R2 constraint at all — `PhysicalType.NULL` (`ANY` / `NULL`) and any unrecognized
 * plugin physical code — so such a caller can skip the check entirely rather than call a
 * closure that always returns true.
 *
 * Keyed on `physicalType` rather than the type's identity so plugin-registered types are
 * covered too. Two arms need the type NAME as well:
 *
 * - **NUMERIC** shares REAL's `physicalType` (see the NOTE on `NUMERIC_TYPE` in
 *   `types/builtin-types.ts`) but its value space includes `bigint`.
 *   NOTE: matched by NAME, not by identity against the `NUMERIC_TYPE` singleton the way
 *   `isSeekKeySpaceNumeric` matches, because the surrounding switch is deliberately keyed
 *   on `physicalType` so plugin-registered types are covered. The cost is that a
 *   plugin-registered REAL-physical type *named* `NUMERIC` would silently inherit
 *   bigint admission. No such type exists in tree; if one is ever registered, give
 *   `LogicalType` an explicit "admits bigint" property and switch on that instead.
 * - **`ANY`/NULL** (`PhysicalType.NULL`) impose no R2 constraint at all — an `ANY`
 *   position may legitimately hold any storage class.
 *
 * TIMESTAMP needs no special case: it declares `physicalType` INTEGER because it IS an
 * integer instant, so it takes INTEGER's rule. The string temporals (DATE / TIME /
 * DATETIME / TIMESPAN) declare TEXT and take TEXT's — R2 must not demand a `Temporal`
 * object for them.
 */
export function buildConformanceCheck(type: DeclaredType): ConformanceCheck | undefined {
	switch (type.physicalType) {
		case PhysicalType.INTEGER: return INTEGER_CONFORMS;
		case PhysicalType.REAL: return type.name === 'NUMERIC' ? NUMERIC_CONFORMS : REAL_CONFORMS;
		case PhysicalType.TEXT: return TEXT_CONFORMS;
		case PhysicalType.BLOB: return BLOB_CONFORMS;
		case PhysicalType.BOOLEAN: return BOOLEAN_CONFORMS;
		case PhysicalType.OBJECT: return OBJECT_CONFORMS;
		default: return undefined;
	}
}

/**
 * R2 for one non-null value that has already passed R1 (canonical numeric form): does the
 * value inhabit `type`'s JS value space? A type with no R2 constraint admits everything.
 *
 * One-shot form of {@link buildConformanceCheck} — same arms, no closure retained.
 */
export function conformsToType(value: Exclude<SqlValue, null>, type: DeclaredType): boolean {
	const check = buildConformanceCheck(type);
	return check === undefined || check(value);
}
