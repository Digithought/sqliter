import type { Row, SqlValue } from '../common/types.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { LogicalType } from './logical-type.js';
import type { ColumnSchema } from '../schema/column.js';
import type { Expression } from '../parser/ast.js';
import { tryFoldLiteral } from '../parser/utils.js';
import { inferType } from './registry.js';
import { buildConformanceCheck } from './representation.js';

/**
 * Validate a value against a logical type.
 * Throws an error if the value is invalid.
 *
 * @param value The value to validate
 * @param type The logical type to validate against
 * @param columnName Optional column name for better error messages
 * @returns The validated value
 * @throws QuereusError if validation fails
 */
export function validateValue(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// NULL is always valid
	if (value === null) return null;

	// Type-specific validation
	if (type.validate && !type.validate(value)) {
		const colInfo = columnName ? ` for column '${columnName}'` : '';
		throw new QuereusError(
			`Type mismatch${colInfo}: expected ${type.name}, got ${typeof value}`,
			StatusCode.MISMATCH
		);
	}

	return value;
}

/**
 * Parse/convert a value to match a logical type.
 * This performs type conversion and normalization.
 *
 * @param value The value to parse
 * @param type The logical type to convert to
 * @param columnName Optional column name for better error messages
 * @returns The parsed/converted value
 * @throws QuereusError if conversion fails
 */
export function parseValue(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// NULL is always valid
	if (value === null) return null;

	// Type-specific parsing
	if (type.parse) {
		try {
			return type.parse(value);
		} catch (error) {
			const colInfo = columnName ? ` for column '${columnName}'` : '';
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(
				`Type conversion failed${colInfo}: ${message}`,
				StatusCode.MISMATCH
			);
		}
	}

	return value;
}

/**
 * Validate and parse a value in one step.
 * This is the main entry point for type checking at INSERT/UPDATE boundaries.
 *
 * @param value The value to validate and parse
 * @param type The logical type
 * @param columnName Optional column name for better error messages
 * @returns The validated and parsed value
 * @throws QuereusError if validation or parsing fails
 */
export function validateAndParse(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// Parse first (which may convert the value)
	const parsed = parseValue(value, type, columnName);

	// Then validate the parsed result
	return validateValue(parsed, type, columnName);
}

/**
 * Coerce each cell in `row` to its declared column's logical type via
 * {@link validateAndParse} (INTEGER/REAL affinity, JSON parsing, etc.) — the
 * shared step every write path (memory tables, the KV store backend, the
 * isolation overlay) applies before PK extraction, serialization, and index-key
 * construction. `label` identifies the target for the "too many values" error
 * (e.g. `` `${schemaName}.${tableName}` `` or `` `INSERT into ${tableName}` ``)
 * so each call site keeps its own wording.
 *
 * @throws QuereusError if `row` has more cells than `columns`, or a cell fails validation/parsing
 */
export function coerceRowToSchema(row: Row, columns: readonly ColumnSchema[], label: string): Row {
	if (row.length > columns.length) {
		throw new QuereusError(
			`Too many values for ${label}: expected ${columns.length}, got ${row.length}`,
			StatusCode.ERROR,
		);
	}
	return row.map((value, i) => validateAndParse(value, columns[i].logicalType, columns[i].name)) as Row;
}

/**
 * Build the write-path conversion for ONE cell: the shared decision every DML write site
 * makes about a value on its way into a declared column. Returns `undefined` when there
 * is provably nothing to do, so the caller can skip the cell entirely.
 *
 * Two dispositions, and which one applies is decided at emit/plan time:
 *
 * - **Always convert** — `sourceType` is not (by object identity) `target`, or is
 *   `undefined` (unknown provenance). The type registry hands out one shared
 *   `LogicalType` instance per type, so a differing object means a differing type.
 * - **Convert only if the value does not already inhabit `target`** — `sourceType` IS
 *   `target`. Values reaching such a cell are *claimed* to be in declared form already,
 *   and re-converting them would be destructive: JSON's `parse` reads a plain JS string
 *   as JSON *source*, so re-converting a stored JSON text value either changes it (the
 *   text `9` becomes the number 9) or throws (`abc` is not valid JSON source). But the
 *   claim is a static INFERENCE the engine does not otherwise enforce — `sum()` announces
 *   REAL and can produce a `bigint`; an untyped positional `?` announces TEXT and can be
 *   bound to anything — so it is checked against the value in hand rather than trusted.
 *   `conformsToType` (`types/representation.ts`) answers "does this value inhabit this
 *   type" — the same predicate
 *   the `QUEREUS_REPR_STRICT` checker enforces (rule R2 of docs/types.md § Physical
 *   representation), so the guard and the checker cannot drift apart. A value read out of
 *   a JSON column — native object/array, or a JSON scalar such as the string `abc` or the
 *   number 9 — conforms, so the JSON case that motivates the skip still never re-parses.
 *
 * The guard is a *conjunction*, not a replacement for the identity test: a TEXT-announced
 * expression feeding a DATE column produces a string, which conforms to DATE's TEXT
 * physical type, yet still needs converting so the spelling is canonicalized. The static
 * difference stays the primary trigger.
 *
 * Conversion goes through {@link validateAndParse}, so failures carry the same message
 * text the storage layer used to produce.
 *
 * NOTE: the guard is R2-level — it asks which JS storage class the value is, NOT the
 * target type's own `validate`. So it catches "a number reached a TEXT column" but not
 * "a badly-spelled string reached a DATE column" (a DATE-announced expression producing a
 * non-canonical date string still passes through: a string DOES inhabit DATE's TEXT
 * physical type). That is deliberate — it keeps this predicate identical to the one the
 * strict checker enforces — and the known instance of the spelling hole is the variadic
 * `date`/`time`/`datetime` functions, which declare TEXT for exactly this reason (see the
 * NOTE on `dateFunc` in `func/builtins/datetime.ts` and docs/types.md § Special Types —
 * an accepted tradeoff, not open work). If that class needs closing at this seam,
 * switching the guard to `target.validate` is the change to weigh; JSON survives it
 * (`JSON_TYPE.validate` accepts any string, so a JSON string scalar still passes), but
 * every temporal announcement would then have to be exact or writes would start failing.
 *
 * NOTE: rule R1 (canonical numeric form — a `bigint` only outside the safe-integer range)
 * is deliberately NOT part of the guard, even though the strict checker asserts R1 and R2
 * at the same seam. R1 is upheld where values are BORN (literal lexing, parameter bind,
 * bigint arithmetic — see util/numeric-canonical.ts); silently re-canonicalizing here
 * would repair an upstream contract violation instead of letting `QUEREUS_REPR_STRICT`
 * report the seam that caused it. Consequence, accepted: a safe-range `bigint` from a
 * source announcing INTEGER/NUMERIC still passes the guard and reaches storage as-is.
 * Revisit if such a value is ever observed in storage from an in-tree path — that would
 * mean a birth site is missing its canonicalization, and the fix belongs there.
 */
export function buildCellCoercion(
	sourceType: LogicalType | undefined,
	target: LogicalType,
	columnName: string,
): ((value: SqlValue) => SqlValue) | undefined {
	if (sourceType !== target) {
		return (value: SqlValue): SqlValue => validateAndParse(value, target, columnName);
	}
	// Identity match: guard rather than skip. A type imposing no value-space constraint
	// (ANY / NULL) has nothing to guard, so that cell really is free.
	const conforms = buildConformanceCheck(target);
	if (conforms === undefined) return undefined;
	return (value: SqlValue): SqlValue =>
		value === null || conforms(value) ? value : validateAndParse(value, target, columnName);
}

/**
 * Build the per-statement conversion step for a DML write. Given the static logical type
 * of the expression producing each cell (index-aligned with `columns`) and the target
 * columns, returns a closure applying {@link buildCellCoercion}'s decision to every cell
 * that needs one — or `undefined` when no cell does (no column needs converting AND none
 * needs guarding), so the caller can skip the per-row work entirely. A row of all-`ANY`
 * columns fed from `ANY` expressions therefore still allocates nothing.
 *
 * The returned closure copies the row ONLY when a cell actually changes, and returns the
 * caller's own row otherwise — so a bulk copy whose cells all conform (`insert into b
 * select * from a` between same-typed tables) still allocates nothing per row, as it did
 * before every constrained column started carrying a guard. Callers must therefore treat
 * the result as the input row unless they own it; both do today (`emitInsert` reads cells
 * out of it, `emitUpdate` hands in a row it just copied). Cells at or beyond the row's
 * length are left for the storage width guard, mirroring {@link coerceRowToSchema}'s
 * map-over-present-cells behavior.
 *
 * NOTE: a guarded cell costs one pre-selected `typeof`/`instanceof` per row where it used
 * to cost nothing. Unmeasured; if it ever shows up in `test/performance-sentinels.spec.ts`,
 * note it there rather than reverting the guard — the skip is unsound without it.
 */
export function buildRowCoercion(
	sourceTypes: ReadonlyArray<LogicalType | undefined>,
	columns: readonly ColumnSchema[],
): ((row: Row) => Row) | undefined {
	const indices: number[] = [];
	const converters: Array<(value: SqlValue) => SqlValue> = [];
	for (let i = 0; i < columns.length; i++) {
		const convert = buildCellCoercion(sourceTypes[i], columns[i].logicalType, columns[i].name);
		if (convert) {
			indices.push(i);
			converters.push(convert);
		}
	}
	if (indices.length === 0) return undefined;
	return (row: Row): Row => {
		let out: Row | undefined;
		for (let k = 0; k < indices.length; k++) {
			const i = indices[k];
			// Indices ascend, so the first out-of-range one ends the pass.
			if (i >= row.length) break;
			// Each index is visited once, so the copy (if any) still holds the input's cell.
			const original = row[i] as SqlValue;
			const converted = converters[k](original);
			// Identity, not equality: a conversion that returns the value it was given
			// changed nothing, and anything else (including a fresh object holding the
			// same content, or NaN) copies — conservative in the safe direction.
			if (converted !== original) {
				out ??= row.slice() as Row;
				out[i] = converted;
			}
		}
		return out ?? row;
	};
}

/**
 * Fold a DEFAULT expression to a literal AND convert it to the column's declared
 * logical type — the value a fresh INSERT under the same DEFAULT would store. Every
 * ALTER backfill site (ADD COLUMN literal default, SET NOT NULL backfill, and their
 * event-image remaps, across the memory module, the store module and the isolation
 * overlay) goes through here, so a backfilled cell is indistinguishable from an
 * inserted one and the sites cannot drift apart.
 *
 * Returns `undefined` when the expression does not fold to a literal (the caller's
 * per-row evaluator path owns that case) and `null` when it folds to NULL. An AST
 * literal is always raw source form (a TEXT literal `'"abc"'`, never an already-parsed
 * JSON value), so unlike {@link buildRowCoercion} this needs no identity guard — the
 * conversion is always the first one applied to the value.
 *
 * NOTE: that "raw source form" invariant holds because every DEFAULT expression here comes
 * from the parser (schema round-trips re-stringify and re-parse it). If a path ever
 * synthesizes a DEFAULT AST node from an already-stored value, this becomes a second
 * conversion and needs the same identity guard `buildRowCoercion` carries.
 *
 * @throws QuereusError (MISMATCH) when the literal cannot be converted, carrying the
 *   same message text the INSERT path produces.
 */
export function foldDefaultToType(
	expr: Expression | null | undefined,
	logicalType: LogicalType,
	columnName: string,
): SqlValue | undefined {
	if (!expr) return undefined;
	const folded = tryFoldLiteral(expr);
	if (folded === undefined) return undefined;
	return validateAndParse(folded, logicalType, columnName);
}

/** What {@link planRetypeConversion} decided for one `alter column … set data type`. */
export interface RetypeConversion {
	/** The target's logical type, resolved via {@link inferType}. */
	readonly newLogicalType: LogicalType;
	/**
	 * `null` for a metadata-only (alias) retype — nothing to rewrite. Otherwise converts one
	 * non-NULL value; callers route NULLs around it themselves (`set data type` leaves them
	 * untouched, a NOT NULL backfill maps them to DEFAULT before this ever sees them).
	 */
	readonly convert: ((value: SqlValue) => SqlValue) | null;
}

/**
 * Decide whether `alter column … set data type` rewrites stored values, and if so, build the
 * per-value converter. Shared by every backend that implements SET DATA TYPE (the memory
 * module, the KV store module, and the isolation overlay's staged-row migration) so the
 * "does this retype touch anything" gate and the conversion failure's message/status code
 * cannot drift between them — the isolation layer keys its own error routing off that status
 * code, deciding whether another connection's staged rows are marked unusable rather than
 * aborting the ALTER outright.
 *
 * Gated on logical-type IDENTITY, not physical storage class: {@link inferType} flattens
 * aliases to the shared type object (`varchar(50)` IS `TEXT_TYPE`), so an alias retype
 * returns a `null` converter. Any other retype — including a same-storage-class move like
 * text → date — returns one that validates AND normalizes to the new type's canonical
 * spelling, rethrowing a parse/validate failure as `QuereusError(MISMATCH)`.
 *
 * @param dataType The target type name as written in the ALTER statement (echoed into the
 *   failure message verbatim)
 * @param oldLogicalType The column's CURRENT logical type
 * @param columnName The column name (echoed into the failure message)
 */
export function planRetypeConversion(
	dataType: string,
	oldLogicalType: LogicalType,
	columnName: string,
): RetypeConversion {
	const newLogicalType = inferType(dataType);
	if (newLogicalType === oldLogicalType) return { newLogicalType, convert: null };
	return {
		newLogicalType,
		convert: (value: SqlValue): SqlValue => {
			try {
				return validateAndParse(value, newLogicalType, columnName);
			} catch {
				throw new QuereusError(
					`Cannot convert value in '${columnName}' to ${dataType}`,
					StatusCode.MISMATCH,
				);
			}
		},
	};
}

/**
 * Check if a value is compatible with a logical type without throwing.
 *
 * @param value The value to check
 * @param type The logical type
 * @returns True if the value is valid for the type
 */
export function isValidForType(value: SqlValue, type: LogicalType): boolean {
	if (value === null) return true;
	if (!type.validate) return true;
	return type.validate(value);
}

/**
 * Try to parse a value, returning null if parsing fails.
 *
 * @param value The value to parse
 * @param type The logical type
 * @returns The parsed value, or null if parsing fails
 */
export function tryParse(value: SqlValue, type: LogicalType): SqlValue | null {
	try {
		return parseValue(value, type);
	} catch {
		return null;
	}
}

