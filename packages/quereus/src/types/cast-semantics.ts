import type { SqlValue } from '../common/types.js';
import type { LogicalType } from './logical-type.js';
import { TEXT_TYPE, BLOB_TYPE } from './builtin-types.js';

/**
 * What a CAST produces when the target type's `parse` rejects the operand.
 *
 * CAST stays lenient and never throws, but every arm must yield a value that
 * actually inhabits the target type — otherwise the cast advertises a logical
 * type it does not produce and 'junk' ends up stored in a DATE column.
 *
 * The SQLite-compatible arms below (0 / 0.0 / String(v) / UTF-8 bytes) each
 * satisfy their own type's `validate`. Everything else falls to the default,
 * where the type itself is asked. `parse` reads its input as *source text*, so
 * it can reject a value that already IS a valid member of the target type — a
 * bare JS string is a legitimate JSON string scalar even though
 * `JSON_TYPE.parse('hello')` throws on it as invalid JSON syntax. Keeping the
 * operand only when `validate` vouches for it preserves that case (and with it
 * `json_col = 'not json'` evaluating to false rather than erroring), while a
 * value that inhabits no part of the target type yields NULL — the cast has no
 * result.
 *
 * NOTE: `validate` is optional on LogicalType, so a custom registered type that
 * omits it makes every parse failure NULL. Every built-in defines one; if a
 * plugin type ever needs the operand preserved, give it a `validate` rather than
 * loosening this to "no validate ⇒ keep".
 */
export function castFallback(value: SqlValue, type: LogicalType): SqlValue {
	switch (type.name) {
		case 'INTEGER':
			return 0;
		case 'REAL':
			return 0.0;
		case 'NUMERIC':
			return 0;
		case 'TEXT':
			return String(value);
		case 'BLOB':
			return new TextEncoder().encode(String(value));
		default:
			return type.validate?.(value) === true ? value : null;
	}
}

/**
 * Can `cast(<non-null operand> as type)` produce NULL? Answers the static
 * nullability of a converting CAST ({@link import('../planner/nodes/scalar.js').CastNode}).
 *
 * TEXT and BLOB are total over non-null operands: `parse` converts every storage
 * class it accepts and throws otherwise, and {@link castFallback}'s arms for them
 * (`String(v)` / UTF-8 bytes) always yield a value. Every other target can reach
 * NULL — INTEGER / REAL / NUMERIC `parse` map the empty string to null, and
 * `castFallback`'s default arm nulls any operand the target will not validate.
 *
 * Identity comparison, so a plugin type registered under a TEXT-ish alias is
 * treated as nullable-producing. That is the safe direction: over-reporting
 * nullability only costs a not-null-dependent optimization or a rejected NOT NULL
 * declaration, while under-reporting it would let a NULL reach a NOT NULL column.
 */
export function castCanYieldNull(type: LogicalType): boolean {
	return type !== TEXT_TYPE && type !== BLOB_TYPE;
}
