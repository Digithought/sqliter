/**
 * Cross-database schema equivalence helpers.
 *
 * Guards the implicit contract that
 *
 *   direct  = freshDb(); direct.exec(canonicalDDL(S))
 *   applied = freshDb(); applied.exec(declarative_form(S))
 *
 * yield indistinguishable catalogs and runtime behaviour. These helpers
 * compare the live `TableSchema` / `ViewSchema` / `IntegrityAssertionSchema`
 * surface as it exists on `db.schemaManager` after each path applies, and
 * provide a probe runner that asserts row sets / error classes line up
 * between two databases plus the test author's expectation.
 *
 * Structural expression compares reuse `assertAstEquivalent` from the AST
 * round-trip property test so the surface this comparator covers stays in
 * lock-step with the parser/stringifier guarantees.
 */

import { expect } from 'chai';
import type { Database } from '../../src/core/database.js';
import type { TableSchema, RowConstraintSchema, IndexSchema, ForeignKeyConstraintSchema, UniqueConstraintSchema, PrimaryKeyColumnDefinition, IndexColumnSchema } from '../../src/schema/table.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { ViewSchema } from '../../src/schema/view.js';
import type { MaintainedTableSchema } from '../../src/schema/derivation.js';
import { generateMaintainedTableDDL } from '../../src/schema/ddl-generator.js';
import type { IntegrityAssertionSchema } from '../../src/schema/assertion.js';
import type * as AST from '../../src/parser/ast.js';
import type { SqlValue } from '../../src/common/types.js';
import { StatusCode } from '../../src/common/types.js';
import { QuereusError } from '../../src/common/errors.js';
import { safeJsonStringify } from '../../src/util/serialization.js';
import { assertAstEquivalent } from '../emit-roundtrip-comparator.js';

// ============================================================================
// TableSchema equivalence
// ============================================================================

/**
 * Compare two `TableSchema` instances field-by-field on the constraint-bearing
 * fields. `path` is the dot-separated locator used in failure messages
 * (default: `<root>`). On the first divergence, throws a chai assertion with
 * an exact path so fast-check shrinkers can minimize.
 *
 * Fields compared (per ticket spec):
 *   - columns[*]: name, logicalType.name, notNull, defaultValue (structural),
 *     collation, generated, generatedStored, generatedExpr (structural),
 *     primaryKey, pkOrder, pkDirection, defaultConflict, tags
 *   - primaryKeyDefinition
 *   - primaryKeyDefaultConflict
 *   - checkConstraints[*]: name, expr (structural), operations mask,
 *     deferrable, initiallyDeferred, defaultConflict, tags
 *   - foreignKeys[*]: referencedTable + child/parent column lists in order,
 *     onDelete, onUpdate, deferred, defaultConflict, tags
 *   - uniqueConstraints[*]: columns, defaultConflict, predicate (structural), tags
 *   - indexes[*]: columns + directions, unique, partial `where` predicate
 *     (structural), tags
 *   - vtabModuleName + vtabArgs
 *   - isView, isReadOnly
 *   - tags at table level
 *
 * Not compared (deliberately):
 *   - estimatedRows, statistics, generatedColumnDependencies,
 *     generatedColumnTopoOrder, mutationContext (those last two are
 *     derived from the columns array — comparing columns covers them
 *     transitively, and re-computing here would just duplicate the
 *     planner's work).
 */
export function assertTableSchemaEqual(direct: TableSchema, applied: TableSchema, label?: string): void {
	const root = label ? `[${label}] ` : '';
	const at = (p: string) => `${root}${p}`;

	// Basic identity
	eq(direct.name.toLowerCase(), applied.name.toLowerCase(), at('name'));
	eq(direct.schemaName.toLowerCase(), applied.schemaName.toLowerCase(), at('schemaName'));
	eq(direct.isView, applied.isView, at('isView'));
	eq(direct.isReadOnly ?? false, applied.isReadOnly ?? false, at('isReadOnly'));
	eq(direct.vtabModuleName, applied.vtabModuleName, at('vtabModuleName'));
	eqRecord(direct.vtabArgs ?? {}, applied.vtabArgs ?? {}, at('vtabArgs'));
	eqRecord(direct.tags ?? {}, applied.tags ?? {}, at('tags'));

	// Columns (order matters)
	eq(direct.columns.length, applied.columns.length, at('columns.length'));
	for (let i = 0; i < direct.columns.length; i++) {
		assertColumnEqual(direct.columns[i], applied.columns[i], at(`columns[${i}]`));
	}

	// Primary key
	assertPkDefEqual(direct.primaryKeyDefinition, applied.primaryKeyDefinition, at('primaryKeyDefinition'));
	eqOptional(direct.primaryKeyDefaultConflict, applied.primaryKeyDefaultConflict, at('primaryKeyDefaultConflict'));

	// CHECK constraints (order matters — constraint application order is observable)
	assertConstraintListEqual(direct.checkConstraints, applied.checkConstraints, at('checkConstraints'));

	// Foreign keys
	assertFkListEqual(direct.foreignKeys ?? [], applied.foreignKeys ?? [], at('foreignKeys'));

	// Unique constraints
	assertUniqueListEqual(direct.uniqueConstraints ?? [], applied.uniqueConstraints ?? [], at('uniqueConstraints'));

	// Indexes
	assertIndexListEqual(direct.indexes ?? [], applied.indexes ?? [], at('indexes'));
}

function assertColumnEqual(direct: ColumnSchema, applied: ColumnSchema, path: string): void {
	eq(direct.name.toLowerCase(), applied.name.toLowerCase(), `${path}.name`);
	eq(direct.logicalType?.name, applied.logicalType?.name, `${path}.logicalType.name`);
	eq(direct.notNull, applied.notNull, `${path}.notNull`);
	eq(direct.primaryKey, applied.primaryKey, `${path}.primaryKey`);
	eq(direct.pkOrder, applied.pkOrder, `${path}.pkOrder`);
	eqOptional(direct.pkDirection, applied.pkDirection, `${path}.pkDirection`);
	eq((direct.collation ?? 'BINARY').toUpperCase(), (applied.collation ?? 'BINARY').toUpperCase(), `${path}.collation`);
	eq(direct.generated, applied.generated, `${path}.generated`);
	eqOptional(direct.generatedStored, applied.generatedStored, `${path}.generatedStored`);
	eqOptional(direct.defaultConflict, applied.defaultConflict, `${path}.defaultConflict`);
	eqRecord(direct.tags ?? {}, applied.tags ?? {}, `${path}.tags`);

	// Default expression (structural)
	eqExpr(direct.defaultValue, applied.defaultValue, `${path}.defaultValue`);

	// Generated expression (structural)
	eqExpr(direct.generatedExpr ?? null, applied.generatedExpr ?? null, `${path}.generatedExpr`);
}

function assertPkDefEqual(direct: ReadonlyArray<PrimaryKeyColumnDefinition>, applied: ReadonlyArray<PrimaryKeyColumnDefinition>, path: string): void {
	eq(direct.length, applied.length, `${path}.length`);
	for (let i = 0; i < direct.length; i++) {
		eq(direct[i].index, applied[i].index, `${path}[${i}].index`);
		eq(direct[i].desc ?? false, applied[i].desc ?? false, `${path}[${i}].desc`);
		eq((direct[i].collation ?? 'BINARY').toUpperCase(), (applied[i].collation ?? 'BINARY').toUpperCase(), `${path}[${i}].collation`);
	}
}

function assertConstraintListEqual(direct: ReadonlyArray<RowConstraintSchema>, applied: ReadonlyArray<RowConstraintSchema>, path: string): void {
	eq(direct.length, applied.length, `${path}.length`);
	for (let i = 0; i < direct.length; i++) {
		const a = direct[i];
		const b = applied[i];
		eqOptional(lowercase(a.name), lowercase(b.name), `${path}[${i}].name`);
		eq(a.operations, b.operations, `${path}[${i}].operations`);
		eq(a.deferrable ?? false, b.deferrable ?? false, `${path}[${i}].deferrable`);
		eq(a.initiallyDeferred ?? false, b.initiallyDeferred ?? false, `${path}[${i}].initiallyDeferred`);
		eqOptional(a.defaultConflict, b.defaultConflict, `${path}[${i}].defaultConflict`);
		eqRecord(a.tags ?? {}, b.tags ?? {}, `${path}[${i}].tags`);
		eqExpr(a.expr, b.expr, `${path}[${i}].expr`);
	}
}

function assertFkListEqual(direct: ReadonlyArray<ForeignKeyConstraintSchema>, applied: ReadonlyArray<ForeignKeyConstraintSchema>, path: string): void {
	eq(direct.length, applied.length, `${path}.length`);
	for (let i = 0; i < direct.length; i++) {
		const a = direct[i];
		const b = applied[i];
		eqOptional(lowercase(a.name), lowercase(b.name), `${path}[${i}].name`);
		eq(a.referencedTable.toLowerCase(), b.referencedTable.toLowerCase(), `${path}[${i}].referencedTable`);
		eqOptional(lowercase(a.referencedSchema), lowercase(b.referencedSchema), `${path}[${i}].referencedSchema`);
		// Compare child column indices in order
		eqArray(a.columns, b.columns, `${path}[${i}].columns`);
		// Parent column resolution may happen at enforcement time — compare what's stored
		eqArray(a.referencedColumns ?? [], b.referencedColumns ?? [], `${path}[${i}].referencedColumns`);
		eqArray(
			(a.referencedColumnNames ?? []).map(n => n.toLowerCase()),
			(b.referencedColumnNames ?? []).map(n => n.toLowerCase()),
			`${path}[${i}].referencedColumnNames`,
		);
		eq(a.onDelete, b.onDelete, `${path}[${i}].onDelete`);
		eq(a.onUpdate, b.onUpdate, `${path}[${i}].onUpdate`);
		eq(a.deferred, b.deferred, `${path}[${i}].deferred`);
		eqOptional(a.defaultConflict, b.defaultConflict, `${path}[${i}].defaultConflict`);
		eqRecord(a.tags ?? {}, b.tags ?? {}, `${path}[${i}].tags`);
	}
}

function assertUniqueListEqual(direct: ReadonlyArray<UniqueConstraintSchema>, applied: ReadonlyArray<UniqueConstraintSchema>, path: string): void {
	eq(direct.length, applied.length, `${path}.length`);
	for (let i = 0; i < direct.length; i++) {
		const a = direct[i];
		const b = applied[i];
		eqOptional(lowercase(a.name), lowercase(b.name), `${path}[${i}].name`);
		eqArray(a.columns, b.columns, `${path}[${i}].columns`);
		eqOptional(a.defaultConflict, b.defaultConflict, `${path}[${i}].defaultConflict`);
		eqRecord(a.tags ?? {}, b.tags ?? {}, `${path}[${i}].tags`);
		eqExpr(a.predicate ?? null, b.predicate ?? null, `${path}[${i}].predicate`);
	}
}

function assertIndexListEqual(direct: ReadonlyArray<IndexSchema>, applied: ReadonlyArray<IndexSchema>, path: string): void {
	eq(direct.length, applied.length, `${path}.length`);
	for (let i = 0; i < direct.length; i++) {
		const a = direct[i];
		const b = applied[i];
		eq(a.name.toLowerCase(), b.name.toLowerCase(), `${path}[${i}].name`);
		eq(a.unique ?? false, b.unique ?? false, `${path}[${i}].unique`);
		eqRecord(a.tags ?? {}, b.tags ?? {}, `${path}[${i}].tags`);
		assertIndexColsEqual(a.columns, b.columns, `${path}[${i}].columns`);
		eqExpr(a.predicate ?? null, b.predicate ?? null, `${path}[${i}].predicate`);
	}
}

function assertIndexColsEqual(direct: ReadonlyArray<IndexColumnSchema>, applied: ReadonlyArray<IndexColumnSchema>, path: string): void {
	eq(direct.length, applied.length, `${path}.length`);
	for (let i = 0; i < direct.length; i++) {
		eq(direct[i].index, applied[i].index, `${path}[${i}].index`);
		eq(direct[i].desc ?? false, applied[i].desc ?? false, `${path}[${i}].desc`);
		eq((direct[i].collation ?? 'BINARY').toUpperCase(), (applied[i].collation ?? 'BINARY').toUpperCase(), `${path}[${i}].collation`);
	}
}

// ============================================================================
// ViewSchema equivalence
// ============================================================================

/**
 * Compare two `ViewSchema` instances. The view body AST is compared
 * structurally so first-leg-only regressions in compound selects (issue #21)
 * surface here.
 */
export function assertViewSchemaEqual(direct: ViewSchema, applied: ViewSchema, label?: string): void {
	const root = label ? `[${label}] ` : '';
	eq(direct.name.toLowerCase(), applied.name.toLowerCase(), `${root}name`);
	eq(direct.schemaName.toLowerCase(), applied.schemaName.toLowerCase(), `${root}schemaName`);
	eqRecord(direct.tags ?? {}, applied.tags ?? {}, `${root}tags`);
	// Explicit column list (e.g. CREATE VIEW v(a,b) AS ...) — case-insensitive.
	const dCols = (direct.columns ?? []).map(c => c.toLowerCase());
	const aCols = (applied.columns ?? []).map(c => c.toLowerCase());
	eqArray(dCols, aCols, `${root}columns`);
	// View body — structural compare via assertAstEquivalent.
	try {
		// The body AST compare covers the trailing `with defaults (col = expr, …)`
		// clause too — it now rides inside `selectAst` (SelectStmt.defaults).
		assertAstEquivalent(direct.selectAst, applied.selectAst, `${root}selectAst`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		expect.fail(msg);
	}
}

/**
 * Compare two maintained tables (a `TableSchema` carrying a `derivation` —
 * what `create materialized view` produces). The body AST is compared
 * structurally (so a divergent body surfaces here), and `derivation.bodyHash`
 * is compared directly — it is the value the declarative differ keys rebuild
 * detection on, so a re-emit/re-parse round-trip that perturbs the canonical
 * body SQL would fail here even if the AST still compared equal. The canonical
 * `create materialized view` DDL — rendered on demand from the unified record
 * — is also compared, covering the backing-module clause and tag rendering.
 */
export function assertMaterializedViewSchemaEqual(direct: MaintainedTableSchema, applied: MaintainedTableSchema, label?: string): void {
	const root = label ? `[${label}] ` : '';
	eq(direct.name.toLowerCase(), applied.name.toLowerCase(), `${root}name`);
	eq(direct.schemaName.toLowerCase(), applied.schemaName.toLowerCase(), `${root}schemaName`);
	eqRecord(direct.tags ?? {}, applied.tags ?? {}, `${root}tags`);
	const dCols = (direct.derivation.columns ?? []).map(c => c.toLowerCase());
	const aCols = (applied.derivation.columns ?? []).map(c => c.toLowerCase());
	eqArray(dCols, aCols, `${root}derivation.columns`);
	eq(direct.derivation.bodyHash, applied.derivation.bodyHash, `${root}derivation.bodyHash`);
	eq(generateMaintainedTableDDL(direct), generateMaintainedTableDDL(applied), `${root}generatedDDL`);
	try {
		// The body AST compare covers the trailing `with defaults (…)` clause too.
		assertAstEquivalent(direct.derivation.selectAst, applied.derivation.selectAst, `${root}derivation.selectAst`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		expect.fail(msg);
	}
}

/**
 * Compare two assertion schemas. Reuses structural expression compare when
 * both sides carry `checkExpression` (created via `CREATE ASSERTION`);
 * otherwise falls back to comparing the materialized `violationSql` text.
 */
export function assertAssertionSchemaEqual(direct: IntegrityAssertionSchema, applied: IntegrityAssertionSchema, label?: string): void {
	const root = label ? `[${label}] ` : '';
	eq(direct.name.toLowerCase(), applied.name.toLowerCase(), `${root}name`);
	eq(direct.deferrable, applied.deferrable, `${root}deferrable`);
	eq(direct.initiallyDeferred, applied.initiallyDeferred, `${root}initiallyDeferred`);
	if (direct.checkExpression && applied.checkExpression) {
		try {
			assertAstEquivalent(direct.checkExpression, applied.checkExpression, `${root}checkExpression`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect.fail(msg);
		}
	} else {
		// One side missing AST → compare the canonicalized violation SQL as a fallback.
		eq(direct.violationSql.trim(), applied.violationSql.trim(), `${root}violationSql`);
	}
}

// ============================================================================
// Probe runner
// ============================================================================

export type Probe =
	| { sql: string; params?: SqlValue[]; expect: { rows: Array<Record<string, unknown>>; ordered?: boolean } }
	| { sql: string; params?: SqlValue[]; expect: { error: { status?: StatusCode; messageIncludes?: string } } };

/**
 * Run `p.sql` against `direct` and `applied`, then check that the outcomes
 * (rows vs error class) match each other AND match the author's expectation.
 *
 * The "third oracle" — the test author's `expect` block — guards against a
 * regression that lands identically in both paths (both wrong, but agreeing).
 */
export async function assertProbeEquivalent(direct: Database, applied: Database, p: Probe, label?: string): Promise<void> {
	const root = label ? `[${label}] ` : '';
	const directOutcome = await runProbe(direct, p);
	const appliedOutcome = await runProbe(applied, p);

	// Cross-DB outcome class must agree first (rows vs error).
	if (directOutcome.kind !== appliedOutcome.kind) {
		expect.fail(
			`${root}probe outcome class differs: direct=${directOutcome.kind}, applied=${appliedOutcome.kind}\n` +
			`  sql:    ${p.sql}\n` +
			`  direct: ${describeOutcome(directOutcome)}\n` +
			`  applied:${describeOutcome(appliedOutcome)}`
		);
	}

	if ('rows' in p.expect) {
		// Author expects rows.
		if (directOutcome.kind === 'error') {
			expect.fail(
				`${root}expected rows but both DBs threw\n` +
				`  sql:   ${p.sql}\n` +
				`  error: ${describeOutcome(directOutcome)}`
			);
		}
		const direct_ = (directOutcome as { kind: 'rows'; rows: Array<Record<string, unknown>> }).rows;
		const applied_ = (appliedOutcome as { kind: 'rows'; rows: Array<Record<string, unknown>> }).rows;
		const expected = p.expect.rows;
		const ordered = p.expect.ordered !== false;
		assertRowsMatch(direct_, expected, ordered, `${root}direct rows mismatch  sql: ${p.sql}`);
		assertRowsMatch(applied_, expected, ordered, `${root}applied rows mismatch  sql: ${p.sql}`);
	} else {
		// Author expects an error.
		if (directOutcome.kind === 'rows') {
			expect.fail(
				`${root}expected error but both DBs returned rows\n` +
				`  sql:  ${p.sql}\n` +
				`  rows: ${safeJsonStringify((directOutcome as { kind: 'rows'; rows: unknown[] }).rows)}`
			);
		}
		const direct_ = directOutcome as { kind: 'error'; error: Error; status?: StatusCode };
		const applied_ = appliedOutcome as { kind: 'error'; error: Error; status?: StatusCode };

		// Status code agreement (between the two DBs, and with expectation if specified).
		if (direct_.status !== applied_.status) {
			expect.fail(
				`${root}error status differs between DBs: direct=${direct_.status}, applied=${applied_.status}\n` +
				`  sql:    ${p.sql}\n` +
				`  direct: ${direct_.error.message}\n` +
				`  applied:${applied_.error.message}`
			);
		}
		if (p.expect.error.status !== undefined) {
			eq(direct_.status, p.expect.error.status, `${root}expected error.status  sql: ${p.sql}`);
		}
		if (p.expect.error.messageIncludes !== undefined) {
			const needle = p.expect.error.messageIncludes;
			if (!direct_.error.message.includes(needle)) {
				expect.fail(`${root}direct error message did not include ${JSON.stringify(needle)}: ${direct_.error.message}`);
			}
			if (!applied_.error.message.includes(needle)) {
				expect.fail(`${root}applied error message did not include ${JSON.stringify(needle)}: ${applied_.error.message}`);
			}
		}
	}
}

type ProbeOutcome =
	| { kind: 'rows'; rows: Array<Record<string, unknown>> }
	| { kind: 'error'; error: Error; status?: StatusCode };

async function runProbe(db: Database, p: Probe): Promise<ProbeOutcome> {
	try {
		const rows: Array<Record<string, unknown>> = [];
		for await (const row of db.eval(p.sql, p.params)) {
			rows.push(row);
		}
		return { kind: 'rows', rows };
	} catch (e) {
		if (e instanceof QuereusError) {
			return { kind: 'error', error: e, status: e.code as StatusCode };
		}
		return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) };
	}
}

function describeOutcome(o: ProbeOutcome): string {
	if (o.kind === 'rows') return `rows(${o.rows.length}): ${safeJsonStringify(o.rows.slice(0, 4))}`;
	return `error(status=${o.status}): ${o.error.message}`;
}

function assertRowsMatch(actual: Array<Record<string, unknown>>, expected: Array<Record<string, unknown>>, ordered: boolean, msg: string): void {
	const a = ordered ? actual : sortRows(actual);
	const e = ordered ? expected : sortRows(expected);
	if (!deepEqualIgnoringZeroSign(a, e)) {
		expect.fail(`${msg}\n  expected: ${safeJsonStringify(e)}\n  actual:   ${safeJsonStringify(a)}`);
	}
}

function sortRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return [...rows].sort((x, y) => {
		const xs = safeJsonStringify(x);
		const ys = safeJsonStringify(y);
		return xs < ys ? -1 : xs > ys ? 1 : 0;
	});
}

// ============================================================================
// Generic comparators (kept local — failures throw chai assertions with path)
// ============================================================================

function eq<T>(direct: T, applied: T, path: string): void {
	if (direct === applied) return;
	if (typeof direct === 'object' && typeof applied === 'object') {
		// Deep equality fallback for things like arrays of primitives.
		if (safeJsonStringify(direct) === safeJsonStringify(applied)) return;
	}
	expect.fail(`Schema mismatch at ${path}: direct=${safeJsonStringify(direct)}, applied=${safeJsonStringify(applied)}`);
}

function eqOptional<T>(direct: T | undefined, applied: T | undefined, path: string): void {
	if (direct === undefined && applied === undefined) return;
	eq(direct, applied, path);
}

function eqArray<T>(direct: ReadonlyArray<T>, applied: ReadonlyArray<T>, path: string): void {
	if (direct.length !== applied.length) {
		expect.fail(`Schema mismatch at ${path}.length: direct=${direct.length}, applied=${applied.length}`);
	}
	for (let i = 0; i < direct.length; i++) {
		eq(direct[i], applied[i], `${path}[${i}]`);
	}
}

function eqRecord(direct: Readonly<Record<string, unknown>>, applied: Readonly<Record<string, unknown>>, path: string): void {
	const dk = Object.keys(direct).sort();
	const ak = Object.keys(applied).sort();
	if (dk.length !== ak.length || dk.some((k, i) => k !== ak[i])) {
		expect.fail(`Schema mismatch at ${path} (keys): direct=${safeJsonStringify(dk)}, applied=${safeJsonStringify(ak)}`);
	}
	for (const k of dk) {
		eq(direct[k], applied[k], `${path}.${k}`);
	}
}

function eqExpr(direct: AST.Expression | null | undefined, applied: AST.Expression | null | undefined, path: string): void {
	if (direct == null && applied == null) return;
	if (direct == null || applied == null) {
		expect.fail(`Schema mismatch at ${path}: direct=${direct == null ? 'null' : '<expr>'}, applied=${applied == null ? 'null' : '<expr>'}`);
	}
	try {
		assertAstEquivalent(direct as AST.AstNode, applied as AST.AstNode, path);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		expect.fail(`Schema mismatch at ${path}: ${msg}`);
	}
}

function lowercase(s: string | undefined): string | undefined {
	return s === undefined ? undefined : s.toLowerCase();
}

/**
 * -0 and +0 are equal for our purposes (JSON erases the distinction).
 * Promoted from `test/property.spec.ts` (the only other in-tree user) so the
 * probe runner can share the same row-comparison semantics.
 */
function deepEqualIgnoringZeroSign(actual: unknown, expected: unknown): boolean {
	if (actual === expected) return true;
	if (typeof actual === 'number' && typeof expected === 'number' && actual === 0 && expected === 0) return true;
	if (Array.isArray(actual) && Array.isArray(expected)) {
		if (actual.length !== expected.length) return false;
		for (let i = 0; i < actual.length; i++) {
			if (!deepEqualIgnoringZeroSign(actual[i], expected[i])) return false;
		}
		return true;
	}
	if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
		const ak = Object.keys(actual as Record<string, unknown>);
		const ek = Object.keys(expected as Record<string, unknown>);
		if (ak.length !== ek.length) return false;
		for (const k of ak) {
			if (!ek.includes(k)) return false;
			if (!deepEqualIgnoringZeroSign((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k])) return false;
		}
		return true;
	}
	return false;
}
