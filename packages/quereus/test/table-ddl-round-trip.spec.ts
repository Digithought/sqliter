/**
 * Canonical `CREATE TABLE` DDL is a **fixed point**: emit → re-parse → emit again must
 * reproduce both the schema and the text byte-for-byte. This file pins that across the
 * primary-key shapes, which is where the generator is least uniform.
 *
 * For each shape it asserts:
 *   - the emitted DDL contains exactly one `PRIMARY KEY` clause,
 *   - re-parsing it in a fresh `Database` yields the same key (index + desc + collation)
 *     and the same per-column nullability, and
 *   - emitting the re-parsed schema reproduces the identical text.
 *
 * The no-`db` form of `generateTableDDL` is used throughout: it is the persistence form
 * (fully qualified, every column's nullability annotated), and it is what `@quereus/store`
 * writes to its catalog and re-parses on reopen.
 *
 * ## The rule: every key emits its clause
 *
 * There is no exception. A table that declares no `PRIMARY KEY` is keyed by all its
 * columns, and that key is named in the emitted DDL exactly like a declared one — inline
 * when it is a single column, table-level otherwise. Declaring a key changes nothing about
 * its columns (in particular it does not tighten their nullability), so the two spellings
 * are one key and emit identical text; asserted directly below the shape table.
 *
 * The clause used to be omitted for that key, because a declared `PRIMARY KEY` did promote
 * its columns to NOT NULL and naming a synthesized key would have silently tightened a
 * nullable column on every persistence round-trip. That promotion is gone. The omission
 * also left a column-declared `ON CONFLICT` on an all-columns key with nowhere to ride, so
 * the action decayed to `ABORT` on every round-trip — two shapes below pin that it now
 * survives.
 *
 * `expectedNullability` pins the absolute answer for the shapes that need it: the ones
 * running under `pragma default_column_nullability = 'nullable'`, where naming the key is
 * the thing that used to tighten the column. Shapes without it run under the shipped
 * `not_null` default, where the re-parse-equals-original assertion is the whole check.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateTableDDL } from '../src/schema/ddl-generator.js';
import { resolvePkDefaultConflict, type TableSchema } from '../src/schema/table.js';
import { ConflictResolution } from '../src/common/constants.js';

/** Key as `(name[ desc][ collate X], …)` in definition order — the comparison form. */
function keySpelling(schema: TableSchema): string[] {
	return schema.primaryKeyDefinition.map(pk => {
		const col = schema.columns[pk.index];
		return col.name + (pk.desc ? ' desc' : '') + (pk.collation ? ` collate ${pk.collation.toLowerCase()}` : '');
	});
}

/**
 * The key's effective conflict action, named, or `'(none)'`. Read through
 * `resolvePkDefaultConflict` rather than `primaryKeyDefaultConflict` because a
 * table-level action re-parses onto the column — comparing the raw field would report a
 * difference where the resolved behaviour is identical.
 *
 * A declared ABORT reads as `'(none)'`: every consumer resolves the action as
 * `statementOnConflict ?? perConstraint ?? ABORT` (memory `layer/manager.ts`, store
 * `store-table.ts`, `quereus-isolation`), so a declared ABORT and an absent action behave
 * identically — which is why the emitter elides it.
 */
function conflictSpelling(schema: TableSchema): string {
	const action = resolvePkDefaultConflict(schema);
	return action === undefined || action === ConflictResolution.ABORT ? '(none)' : ConflictResolution[action];
}

/** `name: notNull` for every column, in declaration order. */
function nullabilitySpelling(schema: TableSchema): string[] {
	return schema.columns.map(col => `${col.name}: ${col.notNull ? 'not null' : 'null'}`);
}

function countPrimaryKeyClauses(ddl: string): number {
	return (ddl.match(/PRIMARY KEY/gi) ?? []).length;
}

/**
 * Runs `statements` against a fresh `Database`, then hands the resulting schema for
 * table `t` to `inspect`. Each call gets its own connection so a session pragma set by
 * one case cannot leak into another.
 */
async function withTable<T>(statements: readonly string[], inspect: (schema: TableSchema) => T): Promise<T> {
	const db = new Database();
	try {
		for (const sql of statements) await db.exec(sql);
		return inspect(db.schemaManager.findTable('t')!);
	} finally {
		await db.close();
	}
}

interface Shape {
	label: string;
	/** Statements to build the table; the CREATE need not be the last one. */
	statements: string[];
	/** Expected key, as `keySpelling` renders it. */
	expectedKey: string[];
	/** Expected live conflict action, as `conflictSpelling` renders it. Default `'(none)'`. */
	expectedConflict?: string;
	/**
	 * Expected per-column nullability, as `nullabilitySpelling` renders it. Set it for the
	 * shapes where the absolute answer is the point (a nullable key emitted, re-parsed
	 * under a different session default); omit it elsewhere, where re-parse-equals-original
	 * is the real assertion.
	 */
	expectedNullability?: string[];
	/**
	 * Substring the emitted DDL must contain, for shapes whose point is a clause that
	 * used to be dropped. Absent = no text assertion beyond the clause count.
	 */
	expectedText?: string;
}

const SHAPES: Shape[] = [
	{
		// The lone column IS the whole key, so this lands on the INLINE branch. Exactly one
		// clause: an inline plus a table-level one would re-parse to a merged key.
		label: 'no-PK single column (synthesized key, inline clause)',
		statements: [`create table t (a integer)`],
		expectedKey: ['a collate binary'],
		expectedText: '"a" INTEGER NOT NULL PRIMARY KEY',
	},
	{
		label: 'no-PK composite (synthesized key, table-level clause)',
		statements: [`create table t (a integer, b text)`],
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedText: 'PRIMARY KEY ("a", "b")',
	},
	{
		// The declared spelling of the shape above. The two are the same key and no test over
		// the schema can tell them apart, so they must emit the same text (asserted directly
		// below the shape table).
		label: 'declared all-columns PK (shape-equal to synthesized, same clause)',
		statements: [`create table t (a integer, b text, primary key (a, b))`],
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedText: 'PRIMARY KEY ("a", "b")',
	},
	{
		// The case the harness could not assert while the clause was omitted: naming a
		// synthesized key over NULLABLE columns. The emitted text annotates each column
		// explicitly, and the re-parse runs under the stock `not_null` default — so if
		// naming the key still tightened anything, both columns would come back NOT NULL.
		label: 'no-PK composite over nullable columns (key named, nullability preserved)',
		statements: [
			`pragma default_column_nullability = 'nullable'`,
			`create table t (a integer, b text)`,
		],
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedNullability: ['a: null', 'b: null'],
		expectedText: 'PRIMARY KEY ("a", "b")',
	},
	{
		// Single-column spelling of the same thing, on the inline branch.
		label: 'no-PK single nullable column (inline key named, nullability preserved)',
		statements: [
			`pragma default_column_nullability = 'nullable'`,
			`create table t (a integer)`,
		],
		expectedKey: ['a collate binary'],
		expectedNullability: ['a: null'],
		expectedText: '"a" INTEGER NULL PRIMARY KEY',
	},
	{
		label: 'declared narrow PK (subset of columns)',
		statements: [`create table t (a integer, b text, v integer, primary key (a))`],
		expectedKey: ['a collate binary'],
	},
	{
		label: 'declared single-column inline PK',
		statements: [`create table t (id integer primary key, v text)`],
		expectedKey: ['id collate binary'],
	},
	{
		// ALTER TABLE … ADD COLUMN leaves the key at its original width, so the key is no
		// longer all-columns and the omission does not apply. The emitted clause must name
		// the ORIGINAL narrow key rather than re-deriving across the new column.
		label: 'post-ADD COLUMN narrowed synthesized key',
		statements: [
			`create table t (a integer, b text)`,
			`alter table t add column c integer not null default 0`,
		],
		expectedKey: ['a collate binary', 'b collate binary'],
	},
	{
		// The empty-key singleton has its own emission path (`PRIMARY KEY ()`) and must stay
		// on it — folding it into the composite branch (`length > 1`) would render an empty
		// column list, and dropping it entirely would re-parse as the all-columns key.
		label: 'empty-key singleton `primary key ()`',
		statements: [`create table t (a integer, b text, primary key ())`],
		expectedKey: [],
	},
	{
		// An all-columns key WITH a table-level conflict action; the clause carries it.
		label: 'all-columns PK with ON CONFLICT',
		statements: [`create table t (a integer, b text, primary key (a, b) on conflict replace)`],
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: 'PRIMARY KEY ("a", "b") ON CONFLICT REPLACE',
	},
	{
		// The action declared on a PK COLUMN rather than on the table-level clause. It is
		// still the key's action (resolvePkDefaultConflict reads either), so the table-level
		// clause has to carry it — emitting from `primaryKeyDefaultConflict` alone dropped it
		// here while the inline branch kept it.
		label: 'narrow composite PK, action declared on a key column',
		statements: [`create table t (a integer not null on conflict replace, b text, c text, primary key (a, b))`],
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: 'PRIMARY KEY ("a", "b") ON CONFLICT REPLACE',
	},
	{
		// An all-columns key whose action is declared on a key COLUMN. This used to emit no
		// clause, so the action had nowhere to ride and decayed to ABORT on reopen — stably,
		// so the fixed-point assertion could not see it. The clause now carries it.
		label: 'all-columns PK, action declared on a key column (clause carries the action)',
		statements: [`create table t (a integer not null on conflict replace, b text, primary key (a, b))`],
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: 'PRIMARY KEY ("a", "b") ON CONFLICT REPLACE',
	},
	{
		// Same, single-column spelling: the lone column IS the whole key, so the inline
		// clause is what carries the action.
		label: 'single-column table, inline PK with ON CONFLICT (inline clause carries it)',
		statements: [`create table t (a integer primary key on conflict replace)`],
		expectedKey: ['a collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: '"a" INTEGER NOT NULL PRIMARY KEY ON CONFLICT REPLACE',
	},
	{
		// The empty-key singleton emits its own clause, so its action rides that.
		label: 'empty-key singleton with ON CONFLICT',
		statements: [`create table t (a integer, b text, primary key () on conflict replace)`],
		expectedKey: [],
		expectedConflict: 'REPLACE',
		expectedText: 'PRIMARY KEY () ON CONFLICT REPLACE',
	},
	{
		// A narrow table-level key with a conflict action lands on the INLINE branch, so
		// the action has to ride the column clause. Dropping it there downgraded the table
		// to ABORT on reopen just as silently as on the table-level branch.
		label: 'narrow table-level PK with ON CONFLICT (inline branch carries the action)',
		statements: [`create table t (a integer, b text, v integer, primary key (a) on conflict replace)`],
		expectedKey: ['a collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: '"a" INTEGER NOT NULL PRIMARY KEY ON CONFLICT REPLACE',
	},
	{
		// The column-declared spelling — and the shape a table-level action re-parses INTO,
		// so this is what makes the emission a fixed point rather than losing the action on
		// the second write.
		label: 'column-declared PK with ON CONFLICT',
		statements: [`create table t (a integer primary key on conflict replace, b text)`],
		expectedKey: ['a collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: '"a" INTEGER NOT NULL PRIMARY KEY ON CONFLICT REPLACE',
	},
	{
		// ABORT is the parser's default for an absent clause, so it must NOT be emitted —
		// otherwise the text differs from an equivalent table that never named it.
		label: 'PK with ON CONFLICT ABORT emits no ON CONFLICT (the default)',
		statements: [`create table t (a integer, b text, v integer, primary key (a) on conflict abort)`],
		expectedKey: ['a collate binary'],
	},
	{
		// A descending component is part of the key and must be spelled in the clause, or the
		// re-parse silently re-keys ascending. (Reachable via ALTER PRIMARY KEY, and used by
		// ordering-seeded maintained-table backing keys.)
		label: 'all-columns PK with a DESC component',
		statements: [`create table t (a integer, b text, primary key (a, b desc))`],
		expectedKey: ['a collate binary', 'b desc collate binary'],
		expectedText: 'PRIMARY KEY ("a", "b" DESC)',
	},
	{
		// Same length as the column list but not in declaration order: the clause is emitted
		// in the DECLARED order, which is the key's order.
		label: 'all-columns PK in non-declaration order',
		statements: [`create table t (a integer, b text, primary key (b, a))`],
		expectedKey: ['b collate binary', 'a collate binary'],
		expectedText: 'PRIMARY KEY ("b", "a")',
	},
	{
		// A non-BINARY collation on a synthesized key member: findPKDefinition copies the
		// column collation onto the key definition, so the re-parse must resolve to the same
		// collation via the emitted column-level `COLLATE`.
		label: 'no-PK table with a NOCASE column',
		statements: [`create table t (a text collate nocase, b integer)`],
		expectedKey: ['a collate nocase', 'b collate binary'],
	},
];

describe('CREATE TABLE canonical DDL — primary-key round-trip is a fixed point', () => {
	for (const shape of SHAPES) {
		it(shape.label, async () => {
			const original = await withTable(shape.statements, schema => ({
				ddl: generateTableDDL(schema),
				key: keySpelling(schema),
				conflict: conflictSpelling(schema),
				nullability: nullabilitySpelling(schema),
			}));

			expect(original.key, 'live key').to.deep.equal(shape.expectedKey);
			expect(original.conflict, 'live conflict action').to.equal(shape.expectedConflict ?? '(none)');
			// Exactly one clause for every shape: the inline and table-level branches are
			// separate, and a shape landing on both would emit an inline clause AND a
			// table-level one, which the parser silently merges rather than rejecting.
			expect(countPrimaryKeyClauses(original.ddl), `PRIMARY KEY clause count in: ${original.ddl}`)
				.to.equal(1);
			if (shape.expectedText) {
				expect(original.ddl, 'emitted DDL carries the declared clause').to.contain(shape.expectedText);
			}
			if (shape.expectedConflict === undefined) {
				expect(original.ddl, 'no ON CONFLICT expected').to.not.contain('ON CONFLICT');
			}
			if (shape.expectedNullability) {
				expect(original.nullability, 'live nullability').to.deep.equal(shape.expectedNullability);
			}

			// Re-parse equivalence: key, conflict action and nullability survive the emitted text.
			const reparsed = await withTable([original.ddl], schema => ({
				ddl: generateTableDDL(schema),
				key: keySpelling(schema),
				conflict: conflictSpelling(schema),
				nullability: nullabilitySpelling(schema),
			}));

			expect(reparsed.key, `re-parsed key from: ${original.ddl}`).to.deep.equal(original.key);
			expect(reparsed.conflict, `re-parsed conflict action from: ${original.ddl}`)
				.to.equal(original.conflict);
			expect(reparsed.nullability, `re-parsed nullability from: ${original.ddl}`)
				.to.deep.equal(original.nullability);
			// Emit twice: the second emission must be byte-identical, so the persisted text
			// is a genuine fixed point rather than converging after N reopens.
			expect(reparsed.ddl, 'emit → parse → emit is byte-stable').to.equal(original.ddl);
		});
	}

	it('an omitted PRIMARY KEY and a declared all-columns PRIMARY KEY produce identical DDL', async () => {
		// The two spellings are one table: both name the key in the emitted text, and neither
		// is recoverable from the other. (This held under the old omission too, for the
		// opposite reason — neither emitted a clause.)
		const omitted = await withTable([`create table t (a integer, b text)`], generateTableDDL);
		const declared = await withTable([`create table t (a integer, b text, primary key (a, b))`], generateTableDDL);
		expect(omitted).to.equal(declared);
	});

	it('persisted DDL with no PRIMARY KEY clause rehydrates to the all-columns key', async () => {
		// The store's catalog holds exactly this text for a no-PK table. Re-parsing it must
		// re-synthesize the all-columns key. This assertion outlives the emitter change:
		// databases written before it will still carry this clause-free form.
		const persisted = `CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NOT NULL)`;
		const rehydrated = await withTable([persisted], schema => ({
			key: keySpelling(schema),
			nullability: nullabilitySpelling(schema),
		}));
		expect(rehydrated.key).to.deep.equal(['a collate binary', 'b collate binary']);
		expect(rehydrated.nullability).to.deep.equal(['a: not null', 'b: not null']);
	});

	// The assertions above are about the schema; these two are about what a duplicate-key
	// write actually DOES after a table has been persisted and re-parsed, which is the
	// behaviour the emitted `ON CONFLICT` exists to preserve.
	for (const [label, create] of [
		['table-level', `create table t (a integer, b text, v integer, primary key (a) on conflict replace)`],
		['column-declared', `create table t (a integer primary key on conflict replace, b text, v integer)`],
	] as const) {
		it(`a ${label} REPLACE key still replaces after its DDL round-trips`, async () => {
			const ddl = await withTable([create], generateTableDDL);

			const db = new Database();
			try {
				await db.exec(ddl);
				await db.exec(`insert into t values (1, 'first', 10)`);
				// Second write collides on the key. REPLACE overwrites the row; ABORT — the
				// default the action used to decay to — throws a constraint error instead.
				await db.exec(`insert into t values (1, 'second', 20)`);
				const rows = [];
				for await (const row of db.eval(`select b, v from t`)) rows.push(row);
				expect(rows).to.deep.equal([{ b: 'second', v: 20 }]);
			} finally {
				await db.close();
			}
		});
	}

	it('an all-columns key\'s column-declared REPLACE survives its DDL round-trip', async () => {
		// The live bug the omission caused: this key spans every column, so it used to emit
		// no clause and its REPLACE had nowhere to ride. After a reopen the key was ABORT and
		// the second insert below threw instead of replacing.
		const ddl = await withTable(
			[`create table t (a integer not null on conflict replace, b text, primary key (a, b))`],
			generateTableDDL);

		const db = new Database();
		try {
			await db.exec(ddl);
			await db.exec(`insert into t values (1, 'x')`);
			// Same key ⇒ a collision. REPLACE overwrites; ABORT throws a constraint error.
			await db.exec(`insert into t values (1, 'x')`);
			const rows = [];
			for await (const row of db.eval(`select a, b from t`)) rows.push(row);
			expect(rows).to.deep.equal([{ a: 1, b: 'x' }]);
		} finally {
			await db.close();
		}
	});

	it('applying a declaration with no PRIMARY KEY twice is a no-op', async () => {
		// The declarative differ compares the DECLARED key (which falls back to all columns
		// when a declaration names none) against the LIVE key. Now that a live no-PK table's
		// emitted DDL carries an explicit clause the declared side omits, a churning
		// `ALTER PRIMARY KEY` on every apply is the regression to guard against.
		const db = new Database();
		try {
			await db.exec(`declare schema main { table t { a integer, b text } }`);
			await db.exec('apply schema main');
			expect(keySpelling(db.schemaManager.findTable('t')!), 'declared-side fallback key')
				.to.deep.equal(['a collate binary', 'b collate binary']);

			const events: unknown[] = [];
			const unsubscribe = db.onSchemaChange(e => { events.push(e); });
			try {
				await db.exec('apply schema main');
			} finally {
				unsubscribe();
			}
			expect(events, 'the second apply of an unchanged declaration mutates nothing')
				.to.have.lengthOf(0);
		} finally {
			await db.close();
		}
	});
});
