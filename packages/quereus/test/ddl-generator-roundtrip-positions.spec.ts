/**
 * Deterministic reserved-word round-trip for the canonical DDL generator
 * (`src/schema/ddl-generator.ts` + `src/schema/catalog.ts`) — the second,
 * persistence-oriented DDL emitter, distinct from the AST stringifier.
 *
 * The AST round-trip suites (`emit-roundtrip-positions.spec.ts`,
 * `emit-roundtrip-property.spec.ts`) go `parse → astToString → parse` and
 * structurally cannot reach this generator, so a reserved-word name in a
 * generator-only identifier position was uncovered. This suite closes that gap
 * by building schemas that carry reserved-word names, generating DDL, and
 * re-parsing it — mirroring the spirit of `emit-roundtrip-positions.spec.ts`.
 *
 * Coverage (the four bare-emit sites the ticket routes through `quoteIdentifier`):
 *   - COLLATE name        — generateIndexDDL  → parse  (collation survives)
 *   - USING module name   — generateTableDDL  → parse  (module name survives)
 *   - vtab-arg key        — generateTableDDL  → parse  (arg key survives)
 *   - CREATE ASSERTION name — collectSchemaCatalog over a real keyword-named
 *     assertion → assert the emitted catalog `ddl` quotes the name AND
 *     re-parses to a `createAssertion` statement.
 *
 * The keyword set is driven straight off the lexer `KEYWORDS` table (as in the
 * AST suite) so it can never drift from the lexer.
 *
 * The assertion catalog `ddl` is now a faithful, re-parseable
 * `CREATE ASSERTION <name> CHECK (<expr>)`: `assertionSchemaToCatalog` emits the
 * CHECK slot from the stored `checkExpression` AST via `expressionToString`
 * (not the `select 1 where not (…)` `violationSql`, which is not a
 * CHECK-*expression* and never parsed). The assertion site below therefore
 * exercises a full `parse(ddl)` round-trip in addition to name quoting.
 */

import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { KEYWORDS } from '../src/parser/lexer.js';
import { generateTableDDL, generateIndexDDL } from '../src/schema/ddl-generator.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { expressionToString } from '../src/emit/ast-stringify.js';
import { Database } from '../src/core/database.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../src/types/builtin-types.js';
import { columnDefToSchema } from '../src/schema/table.js';
import type { Statement, IndexedColumn, ColumnDef, ColumnConstraint } from '../src/parser/ast.js';
import type { TableSchema, IndexSchema } from '../src/schema/table.js';
import type { ColumnSchema } from '../src/schema/column.js';

/** Every reserved word, taken straight from the lexer so the suite can't drift. */
const RESERVED_WORDS = Object.keys(KEYWORDS);

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * The collation a re-parsed index column carries. The parser folds
 * `c COLLATE x` into a `collate` expression on `.expr` (its `.collation` field
 * stays unset for that form), so look in both places.
 */
function collationOf(col: IndexedColumn): string | undefined {
	if (col.collation) return col.collation;
	if (col.expr?.type === 'collate') return col.expr.collation;
	return undefined;
}

/**
 * The collation a re-parsed CREATE TABLE column carries. A column-level
 * `c TEXT COLLATE x` parses to a `collate` column constraint whose `.collation`
 * holds the name.
 */
function columnCollationOf(col: ColumnDef): string | undefined {
	const c = col.constraints?.find((k: ColumnConstraint) => k.type === 'collate');
	return c && c.type === 'collate' ? c.collation : undefined;
}

/** Build a minimal ColumnSchema (mirrors the store ddl-generator spec helper). */
function makeColumn(name: string, opts?: Partial<ColumnSchema>): ColumnSchema {
	return {
		name,
		logicalType: INTEGER_TYPE,
		notNull: true,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: '',
		generated: false,
		...opts,
	};
}

/** Build a minimal TableSchema (mirrors the store ddl-generator spec helper). */
function makeTableSchema(overrides: Partial<TableSchema> & { name: string; columns: ColumnSchema[] }): TableSchema {
	const columns = overrides.columns;
	const columnIndexMap = new Map(columns.map((c, i) => [c.name.toLowerCase(), i]));
	return {
		schemaName: 'main',
		primaryKeyDefinition: [],
		checkConstraints: [],
		vtabModuleName: '',
		isView: false,
		columnIndexMap,
		...overrides,
	} as TableSchema;
}

describe('Generator: reserved word survives every generator-only identifier position', function () {
	// Whole-KEYWORDS sweep per position; a generous timeout keeps it safe under
	// the slower store harness.
	this.timeout(30000);

	it('COLLATE name (generateIndexDDL → parse)', () => {
		const failures: string[] = [];
		const table = makeTableSchema({ name: 't', columns: [makeColumn('c')] });

		for (const kw of RESERVED_WORDS) {
			const idx: IndexSchema = { name: 'i', columns: [{ index: 0, collation: kw }] };
			const ddl = generateIndexDDL(idx, table);

			let stmt: Statement;
			try {
				stmt = parse(ddl);
			} catch (e) {
				failures.push(`[${kw}] re-parse failed (forgot to quote?): ${errText(e)}\n      ddl: ${ddl}`);
				continue;
			}
			if (stmt.type !== 'createIndex') {
				failures.push(`[${kw}] expected createIndex, got ${stmt.type}\n      ddl: ${ddl}`);
				continue;
			}
			const got = stmt.columns[0] ? collationOf(stmt.columns[0])?.toLowerCase() : undefined;
			if (got !== kw) {
				failures.push(`[${kw}] collation did not survive: got ${String(got)}\n      ddl: ${ddl}`);
			}
		}

		expect(failures, `\n${failures.join('\n')}\n`).to.have.length(0);
	});

	it('COLLATE name — table column (generateTableDDL → parse)', () => {
		const failures: string[] = [];

		for (const kw of RESERVED_WORDS) {
			// Single-column table whose column carries a reserved-word collation.
			const table = makeTableSchema({ name: 't', columns: [makeColumn('c', { collation: kw })] });
			const ddl = generateTableDDL(table);

			let stmt: Statement;
			try {
				stmt = parse(ddl);
			} catch (e) {
				failures.push(`[${kw}] re-parse failed (forgot to quote?): ${errText(e)}\n      ddl: ${ddl}`);
				continue;
			}
			if (stmt.type !== 'createTable') {
				failures.push(`[${kw}] expected createTable, got ${stmt.type}\n      ddl: ${ddl}`);
				continue;
			}
			const got = stmt.columns[0] ? columnCollationOf(stmt.columns[0])?.toLowerCase() : undefined;
			if (got !== kw) {
				failures.push(`[${kw}] column collation did not survive: got ${String(got)}\n      ddl: ${ddl}`);
			}
		}

		expect(failures, `\n${failures.join('\n')}\n`).to.have.length(0);
	});

	it('USING module name (generateTableDDL → parse)', () => {
		const failures: string[] = [];

		for (const kw of RESERVED_WORDS) {
			// No db context → USING is emitted unconditionally.
			const table = makeTableSchema({ name: 't', columns: [makeColumn('c')], vtabModuleName: kw });
			const ddl = generateTableDDL(table);

			let stmt: Statement;
			try {
				stmt = parse(ddl);
			} catch (e) {
				failures.push(`[${kw}] re-parse failed (forgot to quote?): ${errText(e)}\n      ddl: ${ddl}`);
				continue;
			}
			if (stmt.type !== 'createTable') {
				failures.push(`[${kw}] expected createTable, got ${stmt.type}\n      ddl: ${ddl}`);
				continue;
			}
			if (stmt.moduleName?.toLowerCase() !== kw) {
				failures.push(`[${kw}] module name did not survive: got ${String(stmt.moduleName)}\n      ddl: ${ddl}`);
			}
		}

		expect(failures, `\n${failures.join('\n')}\n`).to.have.length(0);
	});

	it('vtab-arg key (generateTableDDL → parse)', () => {
		const failures: string[] = [];

		for (const kw of RESERVED_WORDS) {
			const table = makeTableSchema({
				name: 't',
				columns: [makeColumn('c')],
				vtabModuleName: 'store',
				vtabArgs: { [kw]: 'v' },
			});
			const ddl = generateTableDDL(table);

			let stmt: Statement;
			try {
				stmt = parse(ddl);
			} catch (e) {
				failures.push(`[${kw}] re-parse failed (forgot to quote?): ${errText(e)}\n      ddl: ${ddl}`);
				continue;
			}
			if (stmt.type !== 'createTable') {
				failures.push(`[${kw}] expected createTable, got ${stmt.type}\n      ddl: ${ddl}`);
				continue;
			}
			const keys = Object.keys(stmt.moduleArgs ?? {}).map(k => k.toLowerCase());
			if (!keys.includes(kw)) {
				failures.push(`[${kw}] arg key did not survive: got [${keys.join(', ')}]\n      ddl: ${ddl}`);
			}
		}

		expect(failures, `\n${failures.join('\n')}\n`).to.have.length(0);
	});

	// `formatUsingClause` has two emit paths: the no-db branch (above) and the
	// db-context branch (reached when a db is passed and the module differs from
	// the session default `default_vtab_module`, which defaults to 'memory').
	// A fresh Database has that default, and no reserved word equals 'memory',
	// so passing `db` exercises the db-context branch for every keyword.
	describe('USING module name — db-context branch', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('generateTableDDL(table, db) → parse', () => {
			const failures: string[] = [];

			for (const kw of RESERVED_WORDS) {
				const table = makeTableSchema({ name: 't', columns: [makeColumn('c')], vtabModuleName: kw });
				const ddl = generateTableDDL(table, db);

				let stmt: Statement;
				try {
					stmt = parse(ddl);
				} catch (e) {
					failures.push(`[${kw}] re-parse failed (forgot to quote?): ${errText(e)}\n      ddl: ${ddl}`);
					continue;
				}
				if (stmt.type !== 'createTable') {
					failures.push(`[${kw}] expected createTable, got ${stmt.type}\n      ddl: ${ddl}`);
					continue;
				}
				if (stmt.moduleName?.toLowerCase() !== kw) {
					failures.push(`[${kw}] module name did not survive: got ${String(stmt.moduleName)}\n      ddl: ${ddl}`);
				}
			}

			expect(failures, `\n${failures.join('\n')}\n`).to.have.length(0);
		});
	});
});

describe('Generator: ordinary identifiers are never over-quoted', () => {
	// Pins `quoteIdentifier`'s "quote only when necessary" policy at the
	// generator's bare-emit sites, guarding against an always-quote regression
	// (which would also break the store ddl-generator spec's bare-emit asserts).
	it('COLLATE name stays bare', () => {
		const table = makeTableSchema({ name: 't', columns: [makeColumn('c')] });
		const ddl = generateIndexDDL({ name: 'i', columns: [{ index: 0, collation: 'mycoll' }] }, table);
		expect(ddl).to.include('COLLATE mycoll');
		expect(ddl).to.not.include('COLLATE "mycoll"');
	});

	it('USING module name stays bare', () => {
		const table = makeTableSchema({ name: 't', columns: [makeColumn('c')], vtabModuleName: 'mymod' });
		const ddl = generateTableDDL(table);
		expect(ddl).to.include('USING mymod');
		expect(ddl).to.not.include('USING "mymod"');
	});

	it('table-column COLLATE name stays bare; reserved-word quotes', () => {
		const bare = generateTableDDL(makeTableSchema({ name: 't', columns: [makeColumn('c', { collation: 'NOCASE' })] }));
		expect(bare).to.include('COLLATE NOCASE');
		expect(bare).to.not.include('COLLATE "NOCASE"');

		const reserved = generateTableDDL(makeTableSchema({ name: 't', columns: [makeColumn('c', { collation: 'select' })] }));
		expect(reserved).to.include('COLLATE "select"');
	});

	it('vtab-arg key stays bare', () => {
		const table = makeTableSchema({
			name: 't',
			columns: [makeColumn('c')],
			vtabModuleName: 'store',
			vtabArgs: { cache_size: 100 },
		});
		const ddl = generateTableDDL(table);
		expect(ddl).to.include('cache_size = 100');
		expect(ddl).to.not.include('"cache_size"');
	});
});

describe('Generator: table-column COLLATE default elision + round-trip', () => {
	it('elides a default collation (BINARY and empty-string both emit no COLLATE)', () => {
		const binary = generateTableDDL(makeTableSchema({ name: 't', columns: [makeColumn('c', { collation: 'BINARY' })] }));
		expect(binary).to.not.include('COLLATE');

		const empty = generateTableDDL(makeTableSchema({ name: 't', columns: [makeColumn('c', { collation: '' })] }));
		expect(empty).to.not.include('COLLATE');

		// Case-folded default also elides.
		const lower = generateTableDDL(makeTableSchema({ name: 't', columns: [makeColumn('c', { collation: 'binary' })] }));
		expect(lower).to.not.include('COLLATE');
	});

	it('an inline single-column PK + non-default COLLATE re-parses, keeping both', () => {
		// The generator places COLLATE before the inline PRIMARY KEY
		// (`"id" TEXT COLLATE NOCASE PRIMARY KEY`). Column constraints re-parse
		// order-independently, but pin that the combined spelling round-trips:
		// both the collation and the PK survive. A second (non-PK) column keeps
		// this off the synthesized all-columns-key path.
		const table = makeTableSchema({
			name: 't',
			columns: [
				makeColumn('id', { logicalType: TEXT_TYPE, collation: 'NOCASE', primaryKey: true, pkOrder: 1 }),
				makeColumn('other', { logicalType: TEXT_TYPE }),
			],
			primaryKeyDefinition: [{ index: 0 }],
		});
		const ddl = generateTableDDL(table);
		expect(ddl, 'COLLATE precedes inline PRIMARY KEY').to.include('COLLATE NOCASE PRIMARY KEY');

		const stmt = parse(ddl);
		expect(stmt.type).to.equal('createTable');
		if (stmt.type === 'createTable') {
			const col = stmt.columns.find(c => c.name === 'id')!;
			expect(columnCollationOf(col)?.toLowerCase(), 'collation survives').to.equal('nocase');
			expect(col.constraints?.some(c => c.type === 'primaryKey'), 'inline PK survives').to.equal(true);
		}
	});

	it('round-trips a non-default collation back to canonical NOCASE via columnDefToSchema', () => {
		const table = makeTableSchema({
			name: 't',
			columns: [makeColumn('name', { logicalType: TEXT_TYPE, collation: 'NOCASE' })],
		});
		const ddl = generateTableDDL(table);
		const stmt = parse(ddl);
		expect(stmt.type).to.equal('createTable');
		if (stmt.type === 'createTable') {
			const col = stmt.columns.find(c => c.name === 'name')!;
			const schema = columnDefToSchema(col);
			// The schema stores the canonical UPPERCASE name; re-normalization is idempotent.
			expect(schema.collation).to.equal('NOCASE');
		}
	});
});

describe('Generator: every ALTER-reachable column shape re-parses', () => {
	// The standing invariant, stated as a property rather than as today's answer: a column
	// shape an ALTER can produce must be a shape CREATE TABLE accepts. `ALTER COLUMN … SET
	// DATA TYPE` keeps the column's collation, so retyping a `collate nocase` column into a
	// type that accepts BINARY only (DATE / TIME / DATETIME / TIMESPAN / JSON all declare
	// `supportedCollations: []`) either has to be REJECTED, or has to leave DDL that still
	// re-executes. Anything else is the data-loss path: a store-backed catalog persists the
	// generated DDL and silently skips the table on reopen when it will not re-parse.
	//
	// Written as "rejected OR round-trips" so the test survives a future decision to coerce
	// the collation instead of rejecting — it guards the invariant, not the mechanism.
	const COLLATIONLESS_TYPES = ['date', 'time', 'datetime', 'timespan', 'json'];

	for (const targetType of COLLATIONLESS_TYPES) {
		it(`text collate nocase → ${targetType}: rejected, or its generated DDL re-executes`, async () => {
			const db = new Database();
			try {
				await db.exec(`create table t (id integer primary key, d text collate nocase)`);

				let alterErr: unknown = null;
				try {
					await db.exec(`alter table t alter column d set data type ${targetType}`);
				} catch (e) {
					alterErr = e;
				}

				const ddl = generateTableDDL(db.schemaManager.findTable('t', 'main')!, db);

				if (alterErr !== null) {
					// Rejected — and the rejection must leave the ORIGINAL shape, which round-trips.
					expect(errText(alterErr), `reject should name the collation\n  ddl: ${ddl}`).to.match(/Unknown collation/);
					expect(ddl, 'rejected retype leaves the column TEXT').to.include('TEXT');
				}

				// Either way the current shape must be re-creatable from its own canonical DDL.
				const fresh = new Database();
				try {
					await fresh.exec(ddl);
				} catch (e) {
					expect.fail(`generated DDL does not re-execute: ${errText(e)}\n  ddl: ${ddl}`);
				} finally {
					await fresh.close();
				}
			} finally {
				await db.close();
			}
		});
	}
});

describe('Generator: cross-schema FOREIGN KEY qualifier round-trip', () => {
	// `generateTableDDL` must emit the `schema.` qualifier on a FK whose parent
	// lives in a different schema than the child — so a store-backed catalog keeps
	// the parent schema across reload — and must NOT emit it for a same-schema FK,
	// keeping existing FK DDL byte-identical. See `schemaConstraintToTableConstraint`
	// in ddl-generator.ts.
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('emits and re-parses the parent-schema qualifier for a cross-schema FK', async () => {
		db.schemaManager.addSchema('s2');
		await db.exec('create table s2.par (id integer primary key)');
		await db.exec('create table childtbl (id integer primary key, p integer null, foreign key (p) references s2.par(id))');

		const child = db.schemaManager.findTable('childtbl', 'main')!;
		const ddl = generateTableDDL(child, db);
		expect(ddl, `qualifier emitted\n  ddl: ${ddl}`).to.include('references s2.par');

		const stmt = parse(ddl);
		expect(stmt.type, `ddl re-parses\n  ddl: ${ddl}`).to.equal('createTable');
		if (stmt.type === 'createTable') {
			const fk = stmt.constraints.find(c => c.type === 'foreignKey');
			expect(fk, 'FK constraint present').to.exist;
			if (fk && fk.type === 'foreignKey') {
				expect(fk.foreignKey?.schema?.toLowerCase(), 'parent schema survives round-trip').to.equal('s2');
			}
		}
	});

	it('omits the qualifier for a same-schema FK (byte-identical to today)', async () => {
		await db.exec('create table par2 (id integer primary key)');
		await db.exec('create table child2 (id integer primary key, p integer null, foreign key (p) references par2(id))');

		const child = db.schemaManager.findTable('child2', 'main')!;
		const ddl = generateTableDDL(child, db);
		expect(ddl, `bare parent\n  ddl: ${ddl}`).to.include('references par2');
		expect(ddl, `no qualifier on same-schema FK\n  ddl: ${ddl}`).to.not.include('main.par2');
		expect(ddl, `no qualifier on same-schema FK\n  ddl: ${ddl}`).to.not.include('"main"');

		const stmt = parse(ddl);
		expect(stmt.type).to.equal('createTable');
		if (stmt.type === 'createTable') {
			const fk = stmt.constraints.find(c => c.type === 'foreignKey');
			expect(fk, 'FK constraint present').to.exist;
			if (fk && fk.type === 'foreignKey') {
				expect(fk.foreignKey?.schema, 'no parent-schema qualifier for same-schema FK').to.equal(undefined);
			}
		}
	});
});

describe('Generator: GENERATED ALWAYS AS round-trips (generateTableDDL → parse → columnDefToSchema)', () => {
	// bug-store-reopen-loses-computed-columns: formatColumnDef had no branch for
	// GENERATED ALWAYS AS, so a store-backed catalog silently dropped the computing rule
	// on reopen. Pins the engine-side round-trip without needing the store package.
	it('a stored and a virtual generated column both survive generate → parse → columnDefToSchema', () => {
		const src = parse(`create table t (
			id integer primary key,
			a integer null,
			g integer null generated always as (a + 1) stored,
			v integer null generated always as (a * 2)
		)`);
		expect(src.type, 'source parses as createTable').to.equal('createTable');
		if (src.type !== 'createTable') return;

		const columns = src.columns.map(c => columnDefToSchema(c));
		const table = makeTableSchema({
			name: 't',
			columns,
			primaryKeyDefinition: [{ index: 0 }],
		});
		const ddl = generateTableDDL(table);
		expect(ddl, ddl).to.include('GENERATED ALWAYS AS (a + 1) STORED');
		expect(ddl, ddl).to.include('GENERATED ALWAYS AS (a * 2) VIRTUAL');

		const reparsed = parse(ddl);
		expect(reparsed.type, `ddl re-parses\n  ddl: ${ddl}`).to.equal('createTable');
		if (reparsed.type !== 'createTable') return;

		const gSchema = columnDefToSchema(reparsed.columns.find(c => c.name === 'g')!);
		const vSchema = columnDefToSchema(reparsed.columns.find(c => c.name === 'v')!);

		expect(gSchema.generated, 'g: generated survives').to.equal(true);
		expect(gSchema.generatedStored, 'g: stored survives').to.equal(true);
		expect(gSchema.generatedExpr && expressionToString(gSchema.generatedExpr), 'g: expr survives').to.equal('a + 1');

		expect(vSchema.generated, 'v: generated survives').to.equal(true);
		expect(vSchema.generatedStored, 'v: virtual survives').to.equal(false);
		expect(vSchema.generatedExpr && expressionToString(vSchema.generatedExpr), 'v: expr survives').to.equal('a * 2');
	});
});

describe('Generator: CREATE ASSERTION name (collectSchemaCatalog)', () => {
	// The assertion DDL is emitted inside the private `assertionSchemaToCatalog`;
	// `collectSchemaCatalog` is the public driver that reaches it. We create a
	// real assertion (CHECK as in 95-assertions.sqllogic) and inspect the emitted
	// catalog `ddl` — both that the name is quoted correctly and that the now-
	// faithful `ddl` re-parses back to a `createAssertion` statement.
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('quotes a reserved-word assertion name', async () => {
		await db.exec('create assertion "select" check (1 = 1)');
		const catalog = collectSchemaCatalog(db, 'main');
		const a = catalog.assertions.find(x => x.name.toLowerCase() === 'select');
		expect(a, 'keyword-named assertion present in catalog').to.exist;
		expect(a!.ddl).to.include('CREATE ASSERTION "select" CHECK');
	});

	it('does not over-quote an ordinary assertion name', async () => {
		await db.exec('create assertion my_assert check (1 = 1)');
		const catalog = collectSchemaCatalog(db, 'main');
		const a = catalog.assertions.find(x => x.name.toLowerCase() === 'my_assert');
		expect(a, 'ordinary-named assertion present in catalog').to.exist;
		expect(a!.ddl).to.include('CREATE ASSERTION my_assert CHECK');
		expect(a!.ddl).to.not.include('"my_assert"');
	});

	it('emits a re-parseable CHECK for a literal predicate', async () => {
		await db.exec('create assertion my_assert check (1 = 1)');
		const catalog = collectSchemaCatalog(db, 'main');
		const a = catalog.assertions.find(x => x.name.toLowerCase() === 'my_assert');
		expect(a, 'assertion present in catalog').to.exist;
		// Previously the embedded `select 1 where not (…)` in the CHECK slot made
		// this throw; the faithful `ddl` now re-parses to a `createAssertion`.
		const stmt = parse(a!.ddl);
		expect(stmt.type, `ddl re-parsed to wrong statement: ${a!.ddl}`).to.equal('createAssertion');
		if (stmt.type === 'createAssertion') {
			expect(stmt.name.name.toLowerCase()).to.equal('my_assert');
		}
	});

	it('emits a re-parseable CHECK for an identifier-bearing predicate', async () => {
		// Exercises identifier quoting inside the CHECK: the predicate carries a
		// table reference (`t`) and a column reference (`v`), so the round-trip
		// depends on `expressionToString` reproducing parseable identifiers — not
		// just a bare literal like `1 = 1`.
		await db.exec('create table t (id integer primary key, v integer)');
		await db.exec('create assertion a2 check (not exists (select 1 from t where v < 0))');
		const catalog = collectSchemaCatalog(db, 'main');
		const a = catalog.assertions.find(x => x.name.toLowerCase() === 'a2');
		expect(a, 'assertion present in catalog').to.exist;
		const stmt = parse(a!.ddl);
		expect(stmt.type, `ddl re-parsed to wrong statement: ${a!.ddl}`).to.equal('createAssertion');
		if (stmt.type === 'createAssertion') {
			expect(stmt.name.name.toLowerCase()).to.equal('a2');
			// Faithfulness, not just shape: the re-parsed CHECK predicate must
			// canonicalise to the same expression as the original. A structure-only
			// check would miss a precedence/paren-drop bug in `expressionToString`
			// that yields *a* valid-but-different predicate.
			const ref = parse('create assertion a2 check (not exists (select 1 from t where v < 0))');
			expect(ref.type).to.equal('createAssertion');
			if (ref.type === 'createAssertion') {
				expect(expressionToString(stmt.check)).to.equal(expressionToString(ref.check));
			}
		}
	});
});
