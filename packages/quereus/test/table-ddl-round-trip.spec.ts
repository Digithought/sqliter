/**
 * Canonical `CREATE TABLE` DDL is a **fixed point**: emit → re-parse → emit again must
 * reproduce both the schema and the text byte-for-byte. This file pins that across the
 * primary-key shapes, which is where the generator is least uniform.
 *
 * For each shape it asserts:
 *   - the emitted DDL contains exactly the expected number of `PRIMARY KEY` clauses,
 *   - re-parsing it in a fresh `Database` yields the same key (index + desc + collation)
 *     and the same per-column nullability, and
 *   - emitting the re-parsed schema reproduces the identical text.
 *
 * The no-`db` form of `generateTableDDL` is used throughout: it is the persistence form
 * (fully qualified, every column's nullability annotated), and it is what `@quereus/store`
 * writes to its catalog and re-parses on reopen.
 *
 * ## The one non-uniform case, and what will change
 *
 * A **synthesized all-columns key** — the key a table gets when it declares no
 * `PRIMARY KEY` — emits *no clause at all* (`expectedClauses: 0` below). So does a
 * *declared* all-columns key, which `isSynthesizedAllColumnsKey` cannot tell apart by
 * shape. The omission exists for exactly one reason: a declared `PRIMARY KEY` promotes
 * its columns to NOT NULL (`schema/manager.ts` `buildColumnSchemas`, `schema/table.ts`
 * `columnDefToSchema`) while a synthesized one does not, so naming a synthesized key
 * would silently tighten a nullable column on every persistence round-trip.
 *
 * When that promotion is removed, the two spellings become one key and every key emits
 * its clause. This file is the harness for that change: flip the `expectedClauses: 0`
 * entries to `1`, and add the case this file cannot assert today —
 *
 *   pragma default_column_nullability = 'nullable';
 *   create table t (a integer, b text);   -- emit → re-parse → both columns still NULL
 *
 * — which currently comes back NOT NULL because the re-parse reads the emitted
 * `PRIMARY KEY ("a", "b")` as declared. Every shape below runs under the shipped
 * `default_column_nullability = 'not_null'`, where each column is non-nullable either
 * way, so the nullability leg is only pinned for non-nullable columns until then.
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
	/**
	 * Expected count of `PRIMARY KEY` occurrences in the emitted DDL: 1 for a key that
	 * emits a clause, 0 for an all-columns key (which is deliberately omitted — see the
	 * file header; these are the entries that become 1 once `PRIMARY KEY` stops implying
	 * NOT NULL).
	 */
	expectedClauses: number;
	/** Expected key, as `keySpelling` renders it. */
	expectedKey: string[];
	/** Expected live conflict action, as `conflictSpelling` renders it. Default `'(none)'`. */
	expectedConflict?: string;
	/**
	 * Conflict action expected AFTER the round-trip, when it differs from the live one —
	 * i.e. a shape whose action the emitter still drops. Only the all-columns keys are in
	 * this state, and only because they emit no clause for the action to ride; the loss is
	 * stable (identical on the second emission), so the fixed-point assertion cannot see it
	 * and this field is what pins it. These entries clear when
	 * `tickets/implement/3-debt-retire-synthesized-primary-key-distinction` lands and every
	 * key emits its clause.
	 */
	expectedConflictAfterRoundTrip?: string;
	/**
	 * Substring the emitted DDL must contain, for shapes whose point is a clause that
	 * used to be dropped. Absent = no text assertion beyond the clause count.
	 */
	expectedText?: string;
}

const SHAPES: Shape[] = [
	{
		label: 'no-PK single column (synthesized key, clause omitted)',
		statements: [`create table t (a integer)`],
		expectedClauses: 0,
		expectedKey: ['a collate binary'],
	},
	{
		label: 'no-PK composite (synthesized key, clause omitted)',
		statements: [`create table t (a integer, b text)`],
		expectedClauses: 0,
		expectedKey: ['a collate binary', 'b collate binary'],
	},
	{
		// The declared spelling of the shape above. `isSynthesizedAllColumnsKey` matches it
		// by shape, so it takes the same omission path — the two forms already emit
		// identical DDL today (asserted separately below).
		label: 'declared all-columns PK (shape-equal to synthesized, clause omitted)',
		statements: [`create table t (a integer, b text, primary key (a, b))`],
		expectedClauses: 0,
		expectedKey: ['a collate binary', 'b collate binary'],
	},
	{
		label: 'declared narrow PK (subset of columns)',
		statements: [`create table t (a integer, b text, v integer, primary key (a))`],
		expectedClauses: 1,
		expectedKey: ['a collate binary'],
	},
	{
		label: 'declared single-column inline PK',
		statements: [`create table t (id integer primary key, v text)`],
		expectedClauses: 1,
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
		expectedClauses: 1,
		expectedKey: ['a collate binary', 'b collate binary'],
	},
	{
		// The empty-key singleton has its own emission path (`PRIMARY KEY ()`) and must stay
		// on it — `isSynthesizedAllColumnsKey` never matches it, and folding it into the
		// composite branch would render an empty column list.
		label: 'empty-key singleton `primary key ()`',
		statements: [`create table t (a integer, b text, primary key ())`],
		expectedClauses: 1,
		expectedKey: [],
	},
	{
		// An all-columns key WITH a conflict action: the shape guard bails out on
		// `primaryKeyDefaultConflict`, so this stays on the declared path and its
		// `ON CONFLICT` must survive the round-trip.
		label: 'all-columns PK with ON CONFLICT (guard bails; clause emitted)',
		statements: [`create table t (a integer, b text, primary key (a, b) on conflict replace)`],
		expectedClauses: 1,
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
		expectedClauses: 1,
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: 'PRIMARY KEY ("a", "b") ON CONFLICT REPLACE',
	},
	{
		// All-columns shape ⇒ no clause ⇒ nowhere for the action to ride, so it is lost. The
		// loss is stable, so only expectedConflictAfterRoundTrip catches it.
		label: 'all-columns PK, action declared on a key column (clause omitted; action lost)',
		statements: [`create table t (a integer not null on conflict replace, b text, primary key (a, b))`],
		expectedClauses: 0,
		expectedKey: ['a collate binary', 'b collate binary'],
		expectedConflict: 'REPLACE',
		expectedConflictAfterRoundTrip: '(none)',
	},
	{
		// Same omission, single-column spelling: the lone column IS the whole key, so the
		// all-columns shape matches and the inline clause that would carry the action is
		// never emitted.
		label: 'single-column table, inline PK with ON CONFLICT (clause omitted; action lost)',
		statements: [`create table t (a integer primary key on conflict replace)`],
		expectedClauses: 0,
		expectedKey: ['a collate binary'],
		expectedConflict: 'REPLACE',
		expectedConflictAfterRoundTrip: '(none)',
	},
	{
		// The empty-key singleton emits its own clause, so its action rides that.
		label: 'empty-key singleton with ON CONFLICT',
		statements: [`create table t (a integer, b text, primary key () on conflict replace)`],
		expectedClauses: 1,
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
		expectedClauses: 1,
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
		expectedClauses: 1,
		expectedKey: ['a collate binary'],
		expectedConflict: 'REPLACE',
		expectedText: '"a" INTEGER NOT NULL PRIMARY KEY ON CONFLICT REPLACE',
	},
	{
		// ABORT is the parser's default for an absent clause, so it must NOT be emitted —
		// otherwise the text differs from an equivalent table that never named it.
		label: 'PK with ON CONFLICT ABORT emits no ON CONFLICT (the default)',
		statements: [`create table t (a integer, b text, v integer, primary key (a) on conflict abort)`],
		expectedClauses: 1,
		expectedKey: ['a collate binary'],
	},
	{
		// The guard also requires every component ascending, so a descending all-columns key
		// emits a clause and must keep its `desc`.
		label: 'all-columns PK with a DESC component (guard bails; clause emitted)',
		statements: [`create table t (a integer, b text, primary key (a, b desc))`],
		expectedClauses: 1,
		expectedKey: ['a collate binary', 'b desc collate binary'],
	},
	{
		// Same length as the column list but not in declaration order, so the guard's
		// `def.index === i` test fails and the clause is emitted in the declared order.
		label: 'all-columns PK in non-declaration order (guard bails; clause emitted)',
		statements: [`create table t (a integer, b text, primary key (b, a))`],
		expectedClauses: 1,
		expectedKey: ['b collate binary', 'a collate binary'],
	},
	{
		// A non-BINARY collation on a synthesized key member: findPKDefinition copies the
		// column collation onto the key definition, so the re-parse must resolve to the same
		// collation via the emitted column-level `COLLATE`.
		label: 'no-PK table with a NOCASE column',
		statements: [`create table t (a text collate nocase, b integer)`],
		expectedClauses: 0,
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
			expect(countPrimaryKeyClauses(original.ddl), `PRIMARY KEY clause count in: ${original.ddl}`)
				.to.equal(shape.expectedClauses);
			if (shape.expectedText) {
				expect(original.ddl, 'emitted DDL carries the declared clause').to.contain(shape.expectedText);
			} else {
				expect(original.ddl, 'no ON CONFLICT expected').to.not.contain('ON CONFLICT');
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
				.to.equal(shape.expectedConflictAfterRoundTrip ?? original.conflict);
			expect(reparsed.nullability, `re-parsed nullability from: ${original.ddl}`)
				.to.deep.equal(original.nullability);
			// Emit twice: the second emission must be byte-identical, so the persisted text
			// is a genuine fixed point rather than converging after N reopens.
			expect(reparsed.ddl, 'emit → parse → emit is byte-stable').to.equal(original.ddl);
		});
	}

	it('an omitted PRIMARY KEY and a declared all-columns PRIMARY KEY produce identical DDL', async () => {
		// True today via the shared omission, and it must stay true once both emit the
		// clause instead — the point is that the two spellings are one table.
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
});
