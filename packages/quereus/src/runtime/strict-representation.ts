import { QuereusError } from '../common/errors.js';
import { StatusCode, type Row, type SqlValue } from '../common/types.js';
import { PhysicalType } from '../types/logical-type.js';
import { conformsToType, type DeclaredType } from '../types/representation.js';
import { isCanonicalNumeric } from '../util/numeric-canonical.js';
import { valueToText } from '../util/value-text.js';

/**
 * Off-by-default physical-representation assertions (`QUEREUS_REPR_STRICT`).
 *
 * The engine canonicalizes every value it MINTS itself (see
 * `util/numeric-canonical.ts` and docs/types.md § Physical representation). Two
 * ingress boundaries are deliberately left uncoerced because coercing them costs
 * per row where there is nothing to win:
 *
 * - rows returned by a virtual-table module's `query()`, including third-party
 *   modules the engine cannot vet;
 * - values returned by user-defined functions.
 *
 * For those the contract is **declared and checked, not enforced**: a module or UDF
 * is obliged to return canonical values, and this harness verifies it when the flag
 * is on. Same shape as the parallel-fork (`QUEREUS_FORK_STRICT`) and stale-context
 * (`QUEREUS_CONTEXT_STRICT`) harnesses in `strict-fork.ts`.
 *
 * The two rules checked here, restated from docs/types.md § Physical representation:
 *
 * - **R1 — canonical numeric form.** A `SqlValue` is a JS `bigint` only when its
 *   magnitude is outside the safe-integer range. Applies to every value, whatever its
 *   declared type, including `ANY` positions.
 * - **R2 — per-declared-type value space.** A value in a position of a declared type
 *   inhabits that type's JS value space (INTEGER → safe-integer `number` or `bigint`,
 *   TEXT → `string`, BLOB → `Uint8Array`, …). Implies R1.
 *
 * `null` is always admissible: nullability is `not null` constraint enforcement's
 * job and lives elsewhere.
 *
 * R2's predicate itself lives one layer down, in `types/representation.ts`
 * ({@link conformsToType}), because the DML write path needs the same answer: its
 * static-type skip is guarded by "does the value actually inhabit the column's type"
 * (see `buildCellCoercion` in `types/validation.ts`). This checker and that guard must
 * never come to disagree about what conforms, so there is one definition.
 *
 * **No capability flag.** A `representationFidelity` declaration on
 * `VirtualTableModule` was considered and rejected — nothing would BEHAVE differently
 * based on it, since the engine tolerates both numeric forms everywhere and will
 * continue to. The obligation lives in the module contract prose (`vtab/module.ts`)
 * and is enforced here in tests.
 *
 * Every call site is guarded by `if (REPR_STRICT)` read from the module-level const in
 * `strict-flags.ts`, so with the flag off each seam is one already-false branch and
 * nothing is built at emit time on this module's behalf.
 */

/**
 * A declared type as this checker reads it. Defined alongside the R2 predicate in
 * `types/representation.ts` and re-exported here for the checker's existing importers.
 */
export type { DeclaredType };

/** A violation of R1/R2. Distinct class so a seam inside a re-wrapping `catch`
 *  (the vtab scan) can rethrow it unchanged instead of burying it in a generic
 *  "error during query" message. */
export class RepresentationError extends QuereusError {
	constructor(message: string) {
		super(message, StatusCode.INTERNAL);
		this.name = 'RepresentationError';
		Object.setPrototypeOf(this, RepresentationError.prototype);
	}
}

/** Longest value rendering included in a violation message before truncation. */
const MAX_RENDERED_VALUE = 80;

/**
 * Render a value for a diagnostic. Routes through {@link valueToText}, which is total
 * over `SqlValue` — deliberately NOT `JSON.stringify`, whose BigInt arm throws
 * ("Do not know how to serialize a BigInt") on exactly the values this checker exists
 * to catch.
 *
 * `valueToText` still stringifies a JSON *document*, so a document holding a value
 * outside `JsonSqlValue` (a nested `bigint`) can throw here. That is itself
 * representation drift, so the failure is folded into the message rather than
 * allowed to replace the violation with a serializer error.
 */
function renderValue(value: SqlValue): string {
	let text: string;
	try {
		text = valueToText(value) ?? 'null';
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return `<unrenderable ${jsTypeOf(value)}: ${reason}>`;
	}
	return text.length > MAX_RENDERED_VALUE ? `${text.slice(0, MAX_RENDERED_VALUE)}…` : text;
}

/** The JS form of a value, named the way a plugin author would recognize it. */
function jsTypeOf(value: SqlValue): string {
	if (value === null) return 'null';
	if (value instanceof Uint8Array) return 'Uint8Array';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

/** The JS forms a declared type admits, for the "expected" half of a message. */
function admissibleForms(type: DeclaredType): string {
	switch (type.physicalType) {
		case PhysicalType.INTEGER: return 'a safe-integer number, or a bigint outside the safe-integer range';
		case PhysicalType.REAL: return type.name === 'NUMERIC'
			? 'a number, or a bigint outside the safe-integer range'
			: 'a number';
		case PhysicalType.TEXT: return 'a string';
		case PhysicalType.BLOB: return 'a Uint8Array';
		case PhysicalType.BOOLEAN: return 'a boolean';
		case PhysicalType.OBJECT: return 'a JSON object/array, or a JSON scalar (string/number/boolean)';
		default: return 'any value in canonical form';
	}
}

const DOC_POINTER = 'See docs/types.md § Physical representation.';

/**
 * R1 for one value: no `bigint` may hold a safe-range integer. Needs no declared type,
 * so this is the check for `ANY` and untyped positions.
 *
 * `where` names the seam and the position (column / argument) and is quoted verbatim
 * into the message — make it something a plugin author who has never read this code
 * can act on, e.g. `` `module 'memory' scan of main.t column 2 (id)` ``.
 */
export function assertCanonicalValue(value: SqlValue, where: string): void {
	if (value === null || isCanonicalNumeric(value)) return;
	throw new RepresentationError(
		`repr-strict: non-canonical numeric at ${where}: the bigint ${renderValue(value)} is inside the ` +
		`safe-integer range and must be a JS number (rule R1). Return the canonical form — ` +
		`\`canonicalizeInteger\` / \`canonicalizeSqlValue\` in util/numeric-canonical.ts do this. ${DOC_POINTER}`,
	);
}

/**
 * R2 for one value in a position of declared type `type` (implies R1).
 * See {@link assertCanonicalValue} for what `where` should say.
 */
export function assertConformsToType(value: SqlValue, type: DeclaredType, where: string): void {
	if (value === null) return;
	assertCanonicalValue(value, where);
	if (conformsToType(value, type)) return;
	throw new RepresentationError(
		`repr-strict: representation mismatch at ${where}: declared type ${type.name} admits ` +
		`${admissibleForms(type)}, but the value is a JS ${jsTypeOf(value)} (${renderValue(value)}) ` +
		`(rule R2). ${DOC_POINTER}`,
	);
}

/**
 * Row form of {@link assertConformsToType}. `types[i]` may be `undefined` — an ANY /
 * untyped position, which is normal and gets R1 only, never a reported violation.
 * A cell past the end of `types` is treated the same way.
 *
 * `columnNames[i]`, when supplied, is folded into the `where` text so the message
 * names the column a plugin author declared rather than an ordinal.
 */
export function assertRowConforms(
	row: Row,
	types: readonly (DeclaredType | undefined)[],
	where: string,
	columnNames?: readonly (string | undefined)[],
): void {
	for (let i = 0; i < row.length; i++) {
		const name = columnNames?.[i];
		const at = name ? `${where} column ${i} (${name})` : `${where} column ${i}`;
		const type = types[i];
		if (type === undefined) {
			assertCanonicalValue(row[i], at);
		} else {
			assertConformsToType(row[i], type, at);
		}
	}
}
