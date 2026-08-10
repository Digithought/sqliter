/**
 * Structural AST equivalence comparator used by the parse→stringify→parse
 * property test (`emit-roundtrip-property.spec.ts`).
 *
 * Goal: catch fields that the stringifier silently drops. The previous
 * string-based round-trip (`emit-roundtrip.spec.ts`) passed when the
 * stringifier emitted *its own* impoverished output identically — this
 * comparator walks the AST instead, so any field that disappears between
 * `ast` and `parse(stringify(ast))` fails loudly with a path report.
 *
 * Normalizations applied before structural compare:
 *   - Positional metadata (`loc`) dropped on every node.
 *   - Identifier-shaped strings (`name`, `table`, `schema`, `alias`,
 *     `collation`, `tableName`, `schemaName`, `columnName`, `oldName`,
 *     `newName`, `savepoint`) compared case-insensitively. The DDL emitter
 *     lowercases keyword-derived identifiers (and the lexer treats
 *     identifiers as case-insensitive), so bracket/double-quoted vs
 *     unquoted forms with the same fold compare equal.
 *   - `lexeme` on literals dropped from compare — the parser fills it in
 *     conditionally (FLOAT always, INTEGER only when ≠ String(value),
 *     NULL/TRUE/FALSE always), so generators can't easily mirror it.
 *     Storage-class distinctions (1 vs '1' vs 1.0) are preserved because
 *     `value`'s typeof differs.
 *   - `comments` dropped on every node (parser doesn't currently emit
 *     them, but listed for forward-compat).
 *   - Parser-default-equivalences applied via `DEFAULT_EQUIVALENCES` —
 *     a missing/undefined field equals the documented default. Centralized
 *     in one table so a future agent adding a default touches one place.
 *
 * Positional metadata fields on `AstNode` extensions (from `parser/ast.ts`):
 *   - `loc: { start: { line, column, offset }, end: { line, column, offset } }`
 *
 * Comparator output on mismatch is thrown via `expect(...).to.deep.equal(...)`
 * with a contextual message that includes the AST path and JSON-serialized
 * (BigInt-safe) snapshots of both sides.
 */

import { expect } from 'chai';
import { safeJsonStringify } from '../src/util/serialization.js';
import { ConflictResolution } from '../src/common/constants.js';

/**
 * Defaults the parser sometimes fills in but the stringifier may omit.
 * If a field at the given dotted path on the given node `type` is missing
 * on one side and equals `defaultValue` on the other, treat them as equal.
 *
 * Lookup is tried `<type>.<subType>.<field>` first, then `<type>.<field>`.
 * Each entry should cite the stringifier line that skips emission and a
 * one-line justification.
 */
const DEFAULT_EQUIVALENCES: Record<string, unknown> = {
	// Column constraint PK: direction omitted ≡ 'asc' (ast-stringify.ts:907 emits ` desc` only)
	'columnConstraint.primaryKey.direction': 'asc',
	// Generated column: stored omitted ≡ false → VIRTUAL (ast-stringify.ts:950 emits ' stored' only)
	'columnConstraint.generated.stored': false,
	// Per-column direction inside PK/index column lists: omitted ≡ 'asc'.
	// Applies anywhere a `{name, direction?}` shape appears.
	'pkColumn.direction': 'asc',
	'indexedColumn.direction': 'asc',
	// Conflict resolution: undefined ≡ ABORT (ast-stringify.ts:893). For column/table
	// constraints we look up by `<type>.onConflict` after the discriminator-specific
	// lookup misses, so a single entry per parent suffices.
	'columnConstraint.onConflict': ConflictResolution.ABORT,
	'tableConstraint.onConflict': ConflictResolution.ABORT,
	'insert.onConflict': ConflictResolution.ABORT,
	// CHECK operations: empty array ≡ undefined (the parser uses parseRowOpList which
	// always returns RowOp[]; the stringifier emits the `on <ops>` clause only when
	// the list is non-empty).
	'columnConstraint.check.operations.empty': true,
	'tableConstraint.check.operations.empty': true,
};

/**
 * Booleans the parser always materializes as `false` when absent in the source.
 * Generators don't have to set these explicitly — missing ≡ false. Truthy values
 * still compare distinctly (`true` ≠ missing).
 *
 * Listed per `<type>.<field>` (parent discriminator); applied only when one side
 * is undefined and the other is exactly `false`.
 */
const FALSE_DEFAULT_FIELDS: Record<string, Set<string>> = {
	select: new Set(['distinct', 'all']),
	createTable: new Set(['ifNotExists']),
	createView: new Set(['ifNotExists']),
	createIndex: new Set(['ifNotExists', 'isUnique']),
	drop: new Set(['ifExists']),
};

/**
 * Records the parser materializes as `{}` even when no value-bearing syntax
 * was present (e.g. `moduleArgs` on a CREATE TABLE without USING). Treat
 * missing ≡ {}.
 */
const EMPTY_RECORD_DEFAULT_FIELDS: Record<string, Set<string>> = {
	createTable: new Set(['moduleArgs']),
};

const POSITIONAL_KEYS = new Set(['loc', 'start', 'end', 'line', 'column', 'offset', 'pos', 'span', 'comments']);

/**
 * True when `key` holds positional metadata on this node. `column` doubles as a
 * data field (UPDATE SET assignments, view insert-default entries) — only its
 * numeric form (loc.start.column) is positional, so string-valued `column`
 * survives the compare.
 */
function isPositionalKey(key: string, value: unknown): boolean {
	if (!POSITIONAL_KEYS.has(key)) return false;
	return key !== 'column' || typeof value !== 'string';
}

const CASE_INSENSITIVE_STRING_KEYS = new Set([
	'name', 'table', 'schema', 'alias', 'collation',
	'tableName', 'schemaName', 'columnName', 'column',
	'oldName', 'newName', 'savepoint',
	'moduleName',
	'targetType',
]);

/** Normalize a value before structural compare. Returns undefined to mean "drop". */
function normalize(value: unknown, key: string, parentType?: string): unknown {
	if (value === null || value === undefined) return value;

	if (isPositionalKey(key, value)) return undefined;
	// Drop lexeme on literals — parser sets it conditionally; storage class is captured by `value`'s typeof.
	if (key === 'lexeme' && parentType === 'literal') return undefined;

	if (typeof value === 'string' && CASE_INSENSITIVE_STRING_KEYS.has(key)) {
		return value.toLowerCase();
	}

	return value;
}

/** Returns true if `arr` is an empty array, or undefined / null. */
function isEmptyOrMissing(arr: unknown): boolean {
	if (arr === undefined || arr === null) return true;
	return Array.isArray(arr) && arr.length === 0;
}

/**
 * Resolve context-sensitive default keys from the parent node's discriminator.
 * Returns both the specific (`<type>.<subType>.<field>`) and generic
 * (`<type>.<field>`) keys, in lookup order. Callers walk this list and use the
 * first hit.
 */
function defaultKeysFor(parentType: string | undefined, parentSubType: string | undefined, field: string): string[] {
	if (!parentType) return [];
	const out: string[] = [];
	if (parentSubType) out.push(`${parentType}.${parentSubType}.${field}`);
	out.push(`${parentType}.${field}`);
	return out;
}

function lookupDefault(parentType: string | undefined, parentSubType: string | undefined, field: string): unknown {
	for (const k of defaultKeysFor(parentType, parentSubType, field)) {
		if (k in DEFAULT_EQUIVALENCES) return DEFAULT_EQUIVALENCES[k];
	}
	return undefined;
}

function lookupEmptyDefault(parentType: string | undefined, parentSubType: string | undefined, field: string): boolean {
	for (const k of defaultKeysFor(parentType, parentSubType, field)) {
		if (DEFAULT_EQUIVALENCES[`${k}.empty`] === true) return true;
	}
	return false;
}

function isFalseDefaultField(parentType: string | undefined, field: string): boolean {
	if (!parentType) return false;
	return FALSE_DEFAULT_FIELDS[parentType]?.has(field) ?? false;
}

function isEmptyRecordDefaultField(parentType: string | undefined, field: string): boolean {
	if (!parentType) return false;
	return EMPTY_RECORD_DEFAULT_FIELDS[parentType]?.has(field) ?? false;
}

/** Determine the "parent type" tag used by DEFAULT_EQUIVALENCES for `node`. */
function parentTypeTagOf(node: Record<string, unknown>): { parent?: string; sub?: string } {
	const t = node['type'];
	if (typeof t !== 'string') {
		// PK column entries are `{name, direction?}` shapes without a `type` field —
		// tag them so `pkColumn.direction` resolves.
		if ('name' in node && Object.keys(node).every(k => k === 'name' || k === 'direction')) {
			return { parent: 'pkColumn' };
		}
		// IndexedColumn — `{name?, expr?, direction?, collation?}`.
		if (('name' in node || 'expr' in node) && ('direction' in node || 'collation' in node)) {
			return { parent: 'indexedColumn' };
		}
		return {};
	}
	const constraintTypes = new Set(['primaryKey', 'notNull', 'null', 'unique', 'check', 'default', 'foreignKey', 'collate', 'generated']);
	if (constraintTypes.has(t)) {
		// Differentiate by structural cue: TableConstraint carries `{ columns: {name,...}[] }`,
		// ColumnConstraint never does. Keeps `columnConstraint.*` / `tableConstraint.*` keys
		// readable without forcing the AST to expose a discriminator field.
		const hasTableColumns = Array.isArray(node['columns']);
		const isTableConstraint = hasTableColumns && (t === 'primaryKey' || t === 'unique' || t === 'check' || t === 'foreignKey');
		if (isTableConstraint) return { parent: 'tableConstraint', sub: t };
		return { parent: 'columnConstraint', sub: t };
	}
	return { parent: t };
}

/** Throw a chai assertion with a path-annotated message. */
function failAt(path: string[], left: unknown, right: unknown, msg: string): never {
	const where = path.length ? path.join('.') : '<root>';
	const ls = safeJsonStringify(left);
	const rs = safeJsonStringify(right);
	expect.fail(`AST mismatch at ${where}: ${msg}\n  expected: ${ls}\n  actual:   ${rs}`);
}

/**
 * Deep structural equality between two AST subtrees after normalization.
 *
 * `path` carries the dotted accessor (`columns[2].constraints[0]`) used for
 * the failure message. `parentTag` / `parentSubTag` thread the parent node's
 * discriminator down so DEFAULT_EQUIVALENCES can resolve context-sensitive
 * defaults (`columnConstraint.primaryKey.direction`).
 */
export function astEquivalent(
	left: unknown,
	right: unknown,
	path: string[] = [],
	parentTag?: string,
	parentSubTag?: string,
): void {
	// Reference equality / primitive identity
	if (left === right) return;

	// One null, the other not → potentially a default equivalence
	if (left === null || right === null || left === undefined || right === undefined) {
		const fieldName = path[path.length - 1];
		if (fieldName && parentTag) {
			const def = lookupDefault(parentTag, parentSubTag, fieldName);
			if (def !== undefined) {
				if (left === undefined && right === def) return;
				if (right === undefined && left === def) return;
				if (left === null && right === def) return;
				if (right === null && left === def) return;
			}
			// Generic false-default for boolean fields.
			if (isFalseDefaultField(parentTag, fieldName)) {
				if ((left === undefined || left === null) && right === false) return;
				if ((right === undefined || right === null) && left === false) return;
			}
		}
		failAt(path, left, right, 'one side is null/undefined');
	}

	// Primitives
	if (typeof left !== 'object' || typeof right !== 'object') {
		if (typeof left === 'string' && typeof right === 'string') {
			// Case-fold compare if this field is identifier-shaped
			const fieldName = path[path.length - 1];
			if (fieldName && CASE_INSENSITIVE_STRING_KEYS.has(fieldName)) {
				if (left.toLowerCase() === right.toLowerCase()) return;
			}
		}
		// BigInt support
		if (typeof left === 'bigint' && typeof right === 'bigint') {
			if (left === right) return;
		}
		failAt(path, left, right, `primitive mismatch (typeof ${typeof left} vs ${typeof right})`);
	}

	// Uint8Array
	if (left instanceof Uint8Array || right instanceof Uint8Array) {
		if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
			failAt(path, left, right, 'Uint8Array vs non-Uint8Array');
		}
		if (left.length !== right.length) failAt(path, left, right, 'Uint8Array length mismatch');
		for (let i = 0; i < left.length; i++) {
			if (left[i] !== right[i]) failAt(path, left, right, `Uint8Array byte mismatch at ${i}`);
		}
		return;
	}

	// Arrays
	if (Array.isArray(left) || Array.isArray(right)) {
		// Empty-array vs undefined equivalence already handled in the null-branch above;
		// here both must be arrays.
		if (!Array.isArray(left) || !Array.isArray(right)) {
			failAt(path, left, right, 'array vs non-array');
		}
		if (left.length !== right.length) {
			failAt(path, left, right, `array length mismatch (${left.length} vs ${right.length})`);
		}
		for (let i = 0; i < left.length; i++) {
			astEquivalent(left[i], right[i], [...path, `[${i}]`], parentTag, parentSubTag);
		}
		return;
	}

	// Plain objects → structural compare after dropping positional metadata
	const leftObj = left as Record<string, unknown>;
	const rightObj = right as Record<string, unknown>;

	const { parent: lTag, sub: lSub } = parentTypeTagOf(leftObj);
	const { parent: rTag, sub: rSub } = parentTypeTagOf(rightObj);
	const childTag = lTag ?? rTag;
	const childSub = lSub ?? rSub;

	// Build the union of meaningful keys (post-normalization).
	const meaningfulKeys = (obj: Record<string, unknown>): Set<string> => {
		const out = new Set<string>();
		for (const k of Object.keys(obj)) {
			if (isPositionalKey(k, obj[k])) continue;
			if (k === 'lexeme' && obj['type'] === 'literal') continue;
			// Drop tags if it's an empty record — emitter omits empty WITH TAGS.
			if (k === 'tags' && obj[k] && typeof obj[k] === 'object' && Object.keys(obj[k] as object).length === 0) continue;
			out.add(k);
		}
		return out;
	};
	const leftKeys = meaningfulKeys(leftObj);
	const rightKeys = meaningfulKeys(rightObj);
	const allKeys = new Set<string>([...leftKeys, ...rightKeys]);

	for (const k of allKeys) {
		const lv = normalize(leftObj[k], k, leftObj['type'] as string | undefined);
		const rv = normalize(rightObj[k], k, rightObj['type'] as string | undefined);

		// undefined ≡ undefined
		if (lv === undefined && rv === undefined) continue;

		// Default-equivalence: missing on one side, equals canonical default on the other.
		if (lv === undefined || rv === undefined) {
			const present = lv === undefined ? rv : lv;

			// Documented default value (e.g. PK direction ≡ 'asc', onConflict ≡ ABORT).
			const def = lookupDefault(childTag, childSub, k);
			if (def !== undefined && present === def) continue;

			// Documented "empty-list ≡ missing" (e.g. CHECK operations).
			if (lookupEmptyDefault(childTag, childSub, k) && isEmptyOrMissing(present)) continue;

			// Generic boolean false-default (distinct, ifNotExists, isUnique, ...).
			if (isFalseDefaultField(childTag, k) && present === false) continue;

			// Records the parser always materializes as `{}` even when no value-bearing
			// syntax was present (e.g. moduleArgs on a USING-less CREATE TABLE).
			if (isEmptyRecordDefaultField(childTag, k)
				&& present && typeof present === 'object'
				&& !Array.isArray(present)
				&& Object.keys(present as object).length === 0) continue;

			// Generic "empty array ≡ missing" — safe because the stringifier emits
			// `[...]` only when non-empty. Lift this if any emitter distinguishes
			// empty-from-missing and rely on the table instead.
			if (isEmptyOrMissing(lv) && isEmptyOrMissing(rv)) continue;

			// Tags compared as records — empty ≡ missing.
			if (k === 'tags' && present && typeof present === 'object' && Object.keys(present as object).length === 0) continue;

			failAt([...path, k], lv, rv, 'one side missing this field');
		}

		// Special handling for `tags` (record): compare by key-set + value (order-insensitive).
		if (k === 'tags' && typeof lv === 'object' && typeof rv === 'object' && !Array.isArray(lv) && !Array.isArray(rv)) {
			const lr = lv as Record<string, unknown>;
			const rr = rv as Record<string, unknown>;
			const lk = Object.keys(lr).sort();
			const rk = Object.keys(rr).sort();
			if (lk.length !== rk.length || lk.some((kk, i) => kk !== rk[i])) {
				failAt([...path, k], lv, rv, 'tags key-set differs');
			}
			for (const kk of lk) {
				astEquivalent(lr[kk], rr[kk], [...path, k, kk], childTag, childSub);
			}
			continue;
		}

		astEquivalent(lv, rv, [...path, k], childTag, childSub);
	}
}

/**
 * Top-level entry point: assert two AST subtrees are structurally equivalent.
 * Wraps `astEquivalent` so callers don't have to thread the empty path / parent
 * tags. Use this from spec files.
 */
// Accepts `unknown` (not just `AstNode`): the internal comparator walks any
// structural value — including AST-bearing arrays like `ViewInsertDefault[]`.
export function assertAstEquivalent(a: unknown, b: unknown, label?: string): void {
	try {
		astEquivalent(a, b, []);
	} catch (e) {
		if (label) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`${label}\n${msg}`);
		}
		throw e;
	}
}
