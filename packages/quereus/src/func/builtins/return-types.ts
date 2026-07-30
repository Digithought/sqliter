import type { ScalarType } from '../../common/datatype.js';
import type { LogicalType } from '../../types/logical-type.js';
import { ANY_TYPE, BLOB_TYPE, BOOLEAN_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';
import { JSON_TYPE } from '../../types/json-type.js';

/**
 * Shared `returnType` declarations for the built-in functions.
 *
 * A function that declares nothing reports ANY (unknown) — safe, but it forfeits
 * comparison specialization, cross-type coercion and write-path convert-once
 * detection (see the note on `createScalarFunction`). Declaring the truth is
 * always better, so these constants exist to make declaring it a one-token edit
 * instead of a repeated four-field object literal.
 *
 * Most built-ins return SQL NULL for input they cannot use, so the plain
 * constants are nullable; the `_NOT_NULL` variants are for the handful whose
 * implementation provably cannot return null on any path.
 */

/** Build a scalar return-type declaration. */
export function scalarReturn(logicalType: LogicalType, nullable = true): ScalarType {
	return { typeClass: 'scalar', logicalType, nullable, isReadOnly: true };
}

export const TEXT_RETURN = scalarReturn(TEXT_TYPE);
export const INTEGER_RETURN = scalarReturn(INTEGER_TYPE);
export const INTEGER_RETURN_NOT_NULL = scalarReturn(INTEGER_TYPE, false);
export const REAL_RETURN = scalarReturn(REAL_TYPE);
export const BOOLEAN_RETURN = scalarReturn(BOOLEAN_TYPE);
export const BOOLEAN_RETURN_NOT_NULL = scalarReturn(BOOLEAN_TYPE, false);
export const BLOB_RETURN = scalarReturn(BLOB_TYPE);
export const JSON_RETURN = scalarReturn(JSON_TYPE);

/**
 * For a genuinely polymorphic function whose result shape depends on the data,
 * not on the argument types — declaring this explicitly says "unknown on
 * purpose" so a reader does not have to wonder whether the declaration was
 * forgotten. Equivalent to omitting `returnType`.
 */
export const ANY_RETURN = scalarReturn(ANY_TYPE);
