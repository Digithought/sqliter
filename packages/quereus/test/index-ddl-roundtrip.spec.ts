/**
 * Lossless CREATE INDEX DDL round-trip through the engine.
 *
 * Pins the three engine-level facts that let a secondary index survive being
 * persisted as canonical DDL and rehydrated by re-parsing (the store catalog
 * path, exercised here without the store):
 *
 *   1. `generateIndexDDL` emits UNIQUE + partial WHERE (+ collation / desc / tags),
 *      ordered to match the parser grammar so the result re-parses to the same shape.
 *   2. `SchemaManager.importIndex` reconstructs the full IndexSchema from the
 *      re-parsed AST — unique, predicate, per-column collation (including the
 *      collate-wrapped column form the parser folds `COLLATE` into) — and
 *      synthesizes the `derivedFromIndex` UNIQUE constraint for a unique index.
 *   3. `importCatalog` accepts a multi-statement entry (a table bundled with its
 *      indexes), importing each in document order.
 *
 * `index_info()` / `unique_constraint_info()` are the assertion surface — they
 * report the reconstructed unique / partial / collation / desc / tags / derived
 * constraint straight off the schema.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateTableDDL, generateIndexDDL } from '../src/schema/ddl-generator.js';
import { parse } from '../src/parser/index.js';
import { createIndexToString, expressionToString } from '../src/emit/ast-stringify.js';
import { computeSchemaDiff, type SchemaDiff, type RenamePolicy } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import type { CreateIndexStmt, DeclaredIndex, IndexedColumn, DeclareSchemaStmt } from '../src/parser/ast.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/**
 * The bare column name an indexed-column AST node refers to. The parser folds
 * `col COLLATE x` into a `collate` expression over a column reference, so the
 * name lives on `col.expr.expr.name` for that form.
 */
function indexColumnName(col: IndexedColumn): string | undefined {
	if (col.name) return col.name;
	if (col.expr?.type === 'collate' && col.expr.expr.type === 'column') return col.expr.expr.name;
	return undefined;
}

/** The collation an indexed column carries, from either fold (see positions spec). */
function indexCollationOf(col: IndexedColumn): string | undefined {
	if (col.collation) return col.collation;
	if (col.expr?.type === 'collate') return col.expr.collation;
	return undefined;
}

/** The index name a CREATE INDEX DDL string declares (via the real parser). */
function parseIndexName(ddl: string): string {
	const stmt = parse(ddl);
	if (stmt.type !== 'createIndex') throw new Error(`not a CREATE INDEX: ${ddl}`);
	return stmt.index.name;
}

/**
 * Builds a source DB with a table and a representative spread of secondary
 * indexes (unique, partial, composite/desc, tagged, unique-partial). Returns the
 * DB plus the canonical table + index DDL generated from its live schema.
 */
async function buildSource(): Promise<{ db: Database; tableDDL: string; indexDDLs: string[] }> {
	const db = new Database();
	await db.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
	await db.exec('create unique index uq_email on t (email)');           // unique + inherited NOCASE collation
	await db.exec('create index ix_active on t (active) where active = 1'); // partial (WHERE)
	await db.exec('create index ix_comp on t (name, active desc)');        // composite + desc
	await db.exec("create index ix_tagged on t (name) with tags (purpose = 'search')"); // tags
	await db.exec('create unique index uq_name_active on t (name) where active = 1');    // unique + partial

	const t = db.schemaManager.getTable('main', 't')!;
	return {
		db,
		tableDDL: generateTableDDL(t),
		indexDDLs: t.indexes!.map(ix => generateIndexDDL(ix, t)),
	};
}

describe('CREATE INDEX DDL round-trip: generateIndexDDL emission', () => {
	let src: Database;
	let indexDDLs: string[];

	before(async () => {
		const s = await buildSource();
		src = s.db;
		indexDDLs = s.indexDDLs;
	});

	after(async () => { await src.close(); });

	it('emits UNIQUE + inherited collation for a unique index', () => {
		const ddl = indexDDLs[0];
		expect(ddl).to.match(/^CREATE UNIQUE INDEX /);
		expect(ddl).to.include('COLLATE NOCASE');
	});

	it('emits a WHERE predicate for a partial index', () => {
		const ddl = indexDDLs[1];
		expect(ddl).to.not.match(/^CREATE UNIQUE/);
		expect(ddl).to.match(/\bWHERE active = 1\b/);
	});

	it('emits DESC for a descending composite column, columns before WHERE before WITH TAGS', () => {
		expect(indexDDLs[2]).to.match(/\("name" COLLATE BINARY, "active" COLLATE BINARY DESC\)/);
		// Clause ordering: WHERE comes after the column list (partial unique index).
		const uniquePartial = indexDDLs[4];
		expect(uniquePartial.indexOf('(')).to.be.lessThan(uniquePartial.indexOf('WHERE'));
	});

	it('emits WITH TAGS after the column list', () => {
		expect(indexDDLs[3]).to.match(/\("name" COLLATE BINARY\) WITH TAGS \(purpose = 'search'\)/);
	});

	it('every generated index DDL re-parses to an equivalent createIndex AST', () => {
		for (const ddl of indexDDLs) {
			const stmt = parse(ddl);
			expect(stmt.type, ddl).to.equal('createIndex');
		}
		// Spot-check reconstructed AST fidelity per case.
		const uq = parse(indexDDLs[0]);
		const partial = parse(indexDDLs[1]);
		const comp = parse(indexDDLs[2]);
		const tagged = parse(indexDDLs[3]);
		if (uq.type === 'createIndex') {
			expect(uq.isUnique).to.equal(true);
			expect(indexColumnName(uq.columns[0])).to.equal('email');
			expect(indexCollationOf(uq.columns[0])?.toLowerCase()).to.equal('nocase');
		}
		if (partial.type === 'createIndex') {
			expect(partial.isUnique ?? false).to.equal(false);
			expect(partial.where, 'partial index carries a WHERE predicate').to.exist;
		}
		if (comp.type === 'createIndex') {
			expect(comp.columns).to.have.length(2);
			expect(comp.columns[1].direction).to.equal('desc');
		}
		if (tagged.type === 'createIndex') {
			expect(tagged.tags?.purpose).to.equal('search');
		}
	});
});

describe('CREATE INDEX DDL round-trip: importCatalog reconstruction', () => {
	it('rehydrates unique / partial / collation / desc / tags + derived constraint losslessly', async () => {
		const { db: src, indexDDLs } = await buildSource();
		try {
			const srcIndexInfo = await rows(src, "select * from index_info('t')");
			const srcUniqueInfo = await rows(src, "select * from unique_constraint_info('t')");

			// Fresh DB: table established first (so the memory module can connect),
			// then the index bundle imported as a single multi-statement entry.
			const dst = new Database();
			try {
				await dst.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
				const result = await dst.schemaManager.importCatalog([indexDDLs.join(';\n')]);
				expect(result.indexes).to.have.length(indexDDLs.length);

				const dstIndexInfo = await rows(dst, "select * from index_info('t')");
				const dstUniqueInfo = await rows(dst, "select * from unique_constraint_info('t')");

				// Full-fidelity: the rehydrated catalog matches the source byte-for-byte.
				expect(dstIndexInfo, 'index_info round-trips').to.deep.equal(srcIndexInfo);
				expect(dstUniqueInfo, 'unique_constraint_info round-trips').to.deep.equal(srcUniqueInfo);

				// Explicit spot-checks (guard against both sides being wrong together).
				const uqEmail = dstIndexInfo.find(r => r.index_name === 'uq_email')!;
				expect(uqEmail.unique).to.equal(1);
				expect(uqEmail.collation).to.equal('NOCASE');
				const ixActive = dstIndexInfo.find(r => r.index_name === 'ix_active')!;
				expect(ixActive.partial).to.equal(1);
				const ixCompDesc = dstIndexInfo.find(r => r.index_name === 'ix_comp' && r.seq === 1)!;
				expect(ixCompDesc.desc).to.equal(1);
				const ixTagged = dstIndexInfo.find(r => r.index_name === 'ix_tagged')!;
				expect(ixTagged.tags).to.equal('{"purpose":"search"}');

				// Both unique indexes synthesized their derived UNIQUE constraint; the
				// partial one carries the partial flag.
				const derivedNames = dstUniqueInfo.map(r => r.name);
				expect(derivedNames).to.include.members(['uq_email', 'uq_name_active']);
				const derivedPartial = dstUniqueInfo.find(r => r.name === 'uq_name_active')!;
				expect(derivedPartial.partial).to.equal(1);
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('a collate-wrapped index column imports without the expression-index rejection', async () => {
		// Every generated index DDL emits an explicit COLLATE, which re-parses as a
		// `collate` expression over the column — the exact shape the old importIndex
		// rejected as an expression index.
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, email text)');
			await dst.schemaManager.importCatalog(['CREATE INDEX i ON t (email COLLATE NOCASE)']);
			const info = await rows(dst, "select column_name, collation from index_info('t')");
			expect(info).to.deep.equal([{ column_name: 'email', collation: 'NOCASE' }]);
		} finally {
			await dst.close();
		}
	});

	it('an index whose name a UNIQUE constraint on the same table holds imports (warn-and-proceed) into a degraded table', async () => {
		// Both write paths refuse this collision now, so only a catalog written before
		// those guards — or a hand-built bundle like this one — can carry it. `importIndex`
		// deliberately warns and proceeds rather than bricking the open; this pins what
		// "proceeds" actually costs, which is more than the shadowing the warning used to
		// describe: two index entries under one name, neither reported by `index_info()`,
		// `DROP INDEX` refusing, and a predicate over the imported index's column no longer
		// filtering. Asserted so a future decision to reject or rename here visibly flips it.
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, a text, b text, constraint foo unique (a))');
			await dst.exec("insert into t values (1, 'x', 'p'), (2, 'y', 'q')");
			const result = await dst.schemaManager.importCatalog(['CREATE INDEX foo ON t (b)']);
			expect(result.indexes, 'import proceeds').to.have.length(1);

			const named = dst._findTable('t')!.indexes!.filter(idx => idx.name.toLowerCase() === 'foo');
			expect(named, 'two structures now answer to one name').to.have.length(2);
			expect(await rows(dst, "select index_name from index_info('t')"), 'neither is reported').to.deep.equal([]);

			let dropErr: Error | undefined;
			try { await dst.exec('drop index foo'); } catch (e) { dropErr = e as Error; }
			expect(dropErr?.message, 'the imported index is not droppable').to.match(/no such index/i);

			// The constraint still enforces, but the imported index no longer filters.
			const filtered = await rows(dst, "select id from t where b = 'q'");
			expect(filtered, 'predicate over the shadowed index stops filtering (known damage)').to.have.length(2);
		} finally {
			await dst.close();
		}
	});

	it('CREATE TABLE refuses two UNIQUE constraints that derive one structure name', async () => {
		// The sibling test above pins what two entries under one name cost. This pins the
		// other producer of that shape and the guard that closes it: a UNIQUE whose backing
		// structure name is the one another UNIQUE on the same table derives. Reachable two
		// ways — the engine's reserved `_uc_` prefix written into a constraint name (here),
		// and the `_`-joined auto-name colliding on ORDINARY column names (the sibling test
		// below). Both are refused at CREATE TABLE, as they already were at every ALTER path.
		const dst = new Database();
		try {
			let err: Error | undefined;
			try {
				await dst.exec('create table t (id integer primary key, c integer, b integer, constraint _uc_c unique (b), unique (c))');
			} catch (e) { err = e as Error; }
			expect(err?.message, 'refused').to.match(/both derive backing structure name '_uc_c'/i);

			// Refused before `module.create`, so nothing was registered.
			expect(dst._findTable('t'), 'no table left behind').to.equal(undefined);
			expect(await rows(dst, "select count(*) as c from schema() where type = 'table' and name = 't'"))
				.to.deep.equal([{ c: 0 }]);
		} finally {
			await dst.close();
		}
	});

	it('the same collision is reachable with ordinary column names, and is refused there too', async () => {
		// `_uc_<cols>` joins the covered column names with `_`, so a single column named
		// `a_b` derives the name the pair `(a, b)` derives. No reserved prefix, no unusual
		// spelling — two plain UNIQUE declarations. The duplicate-constraint guard does not
		// fire (different column SETS, genuinely different rules), so only the structure-name
		// guard catches it.
		const dst = new Database();
		try {
			let err: Error | undefined;
			try {
				await dst.exec('create table t (id integer primary key, a_b integer, a integer, b integer, unique (a_b), unique (a, b))');
			} catch (e) { err = e as Error; }
			expect(err?.message, 'refused').to.match(/both derive backing structure name '_uc_a_b'/i);
			expect(dst._findTable('t'), 'no table left behind').to.equal(undefined);
		} finally {
			await dst.close();
		}
	});

	// NOTE: the legacy-catalog half of this rule — a catalog written BEFORE the guard,
	// carrying the colliding pair, must still open — is pinned store-side in
	// `packages/quereus-store/test/index-persistence.spec.ts`. It cannot be expressed
	// here: `importTable` rehydrates through `module.connect`, and the memory module has
	// no definition to connect to for a table it never created.

	it('a genuine expression index is still rejected on import', async () => {
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, email text)');
			let threw = false;
			try {
				await dst.schemaManager.importCatalog(['CREATE INDEX i ON t (lower(email))']);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/Expression-based index columns are not supported/);
			}
			expect(threw, 'expression index import should throw').to.equal(true);
		} finally {
			await dst.close();
		}
	});

	it('re-generating DDL from the imported schema is a fixed point (predicate / collation / desc survive textually)', async () => {
		// index_info() exposes the partial flag but NOT the predicate text, so the
		// deep-equal above cannot catch predicate drift (WHERE active = 1 degrading
		// to a different/empty body). Re-emitting the imported index as DDL and
		// comparing it to the original generated DDL closes that gap: it asserts the
		// whole clause shape — UNIQUE, column collation, DESC, WHERE body, tags —
		// round-trips, making generateIndexDDL a fixed point over import.
		const { db: src, indexDDLs } = await buildSource();
		try {
			const dst = new Database();
			try {
				await dst.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
				await dst.schemaManager.importCatalog([indexDDLs.join(';\n')]);

				const dstTable = dst.schemaManager.getTable('main', 't')!;
				const byName = new Map(indexDDLs.map(ddl => [parseIndexName(ddl), ddl]));
				for (const ix of dstTable.indexes!) {
					const regenerated = generateIndexDDL(ix, dstTable);
					expect(regenerated, `index ${ix.name} re-emits identically`).to.equal(byName.get(ix.name));
				}
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('a composite UNIQUE index synthesizes a derived constraint over all its columns', async () => {
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, a integer, b integer)');
			await dst.schemaManager.importCatalog(['CREATE UNIQUE INDEX uq_ab ON t (a, b DESC)']);
			const uc = await rows(dst, "select name, column_name, seq from unique_constraint_info('t') where name = 'uq_ab' order by seq");
			expect(uc.map(r => r.column_name)).to.deep.equal(['a', 'b']);
		} finally {
			await dst.close();
		}
	});
});

describe('CREATE INDEX DDL round-trip: importCatalog multi-statement entries', () => {
	it('imports a CREATE TABLE + CREATE INDEX bundle in document order', async () => {
		const { db: src, tableDDL, indexDDLs } = await buildSource();
		try {
			const dst = new Database();
			try {
				// Establish the memory table so module.connect() succeeds (the store
				// module connects to fresh storage; memory requires a prior create).
				await dst.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
				const result = await dst.schemaManager.importCatalog([`${tableDDL};\n${indexDDLs[0]}`]);
				expect(result.tables, 'table imported from the bundle').to.have.length(1);
				expect(result.indexes, 'index imported from the same bundle').to.have.length(1);
				const info = await rows(dst, "select index_name, unique from index_info('t')");
				expect(info).to.deep.equal([{ index_name: 'uq_email', unique: 1 }]);
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('an empty DDL string is a no-op', async () => {
		const dst = new Database();
		try {
			const result = await dst.schemaManager.importCatalog(['']);
			expect(result).to.deep.equal({ tables: [], indexes: [], views: [], materializedViews: [] });
		} finally {
			await dst.close();
		}
	});

	it('an unsupported statement type in a bundle throws (fail-loud)', async () => {
		const dst = new Database();
		try {
			let threw = false;
			try {
				await dst.schemaManager.importCatalog(['select 1']);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/does not support statement type/);
			}
			expect(threw).to.equal(true);
		} finally {
			await dst.close();
		}
	});
});

// ============================================================================
// ALTER TABLE RENAME / RENAME COLUMN propagation into stored partial-index
// predicates.
//
// The forward rename propagation (runtime/emit/alter-table.ts) rewrites the
// `IndexSchema.predicate` AST alongside CHECK expressions and FK references,
// so the catalog DDL rendered by `generateIndexDDL` (the store persistence
// payload) never references a renamed-away table qualifier or column name.
// The AST is rewritten in place, so the derived UNIQUE constraint of a unique
// partial index — which shares the predicate by reference (see
// `appendIndexToTableSchema`) — is covered by the same rewrite.
// ============================================================================

describe('ALTER rename propagation: stored partial-index predicates', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	/** The catalog DDL of the named index on the named table, post-ALTER. */
	function indexDDL(tableName: string, indexName: string): string {
		const table = db.schemaManager.getTable('main', tableName)!;
		const ix = table.indexes!.find(i => i.name === indexName)!;
		return generateIndexDDL(ix, table);
	}

	it('RENAME TABLE rewrites a table-qualified predicate to the new qualifier', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create index ix on t (name) where t.active = 1');
		await db.exec('alter table t rename to t2');

		const ddl = indexDDL('t2', 'ix');
		expect(ddl, 'predicate qualifier follows the table rename').to.match(/WHERE t2\.active = 1/);
		expect(ddl, 'no stale reference to the old table name').to.not.match(/\bt\.active\b/);
	});

	it('RENAME TABLE leaves an unqualified predicate untouched', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create index ix on t (name) where active = 1');
		await db.exec('alter table t rename to t2');

		expect(indexDDL('t2', 'ix')).to.match(/WHERE active = 1/);
	});

	it('RENAME COLUMN rewrites an unqualified predicate reference', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create index ix on t (name) where active = 1');
		await db.exec('alter table t rename column active to is_active');

		expect(indexDDL('t', 'ix'), 'unqualified ref follows the column rename').to.match(/WHERE is_active = 1/);
	});

	it('RENAME COLUMN rewrites a table-qualified predicate reference', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create index ix on t (name) where t.active = 1');
		await db.exec('alter table t rename column active to is_active');

		expect(indexDDL('t', 'ix')).to.match(/WHERE t\.is_active = 1/);
	});

	it('RENAME TABLE under a UNIQUE partial index also rewrites the derived constraint predicate (shared AST)', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create unique index uq on t (name) where t.active = 1');
		await db.exec('alter table t rename to t2');

		const t2 = db.schemaManager.getTable('main', 't2')!;
		const ix = t2.indexes!.find(i => i.name === 'uq')!;
		const uc = t2.uniqueConstraints!.find(c => c.derivedFromIndex === 'uq')!;
		expect(expressionToString(ix.predicate!), 'index predicate qualifier rewritten').to.equal('t2.active = 1');
		expect(expressionToString(uc.predicate!), 'derived constraint predicate rewritten').to.equal('t2.active = 1');
		expect(uc.predicate, 'still shared by reference — one in-place rewrite covers both').to.equal(ix.predicate);
	});

	it('RENAME COLUMN under a UNIQUE partial index also rewrites the derived constraint predicate (shared AST)', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create unique index uq on t (name) where active = 1');
		await db.exec('alter table t rename column active to is_active');

		const t = db.schemaManager.getTable('main', 't')!;
		const ix = t.indexes!.find(i => i.name === 'uq')!;
		const uc = t.uniqueConstraints!.find(c => c.derivedFromIndex === 'uq')!;
		expect(expressionToString(ix.predicate!), 'index predicate rewritten').to.equal('is_active = 1');
		expect(expressionToString(uc.predicate!), 'derived constraint predicate rewritten').to.equal('is_active = 1');
		expect(uc.predicate, 'still shared by reference — one in-place rewrite covers both').to.equal(ix.predicate);
	});

	it('a like-named predicate column on ANOTHER table is not rewritten', async () => {
		await db.exec('create table t (id integer primary key, name text, active integer)');
		await db.exec('create table u (id integer primary key, name text, active integer)');
		await db.exec('create index ixu on u (name) where active = 1');
		await db.exec('alter table t rename column active to is_active');

		expect(indexDDL('u', 'ixu'), 'other table predicate unchanged').to.match(/WHERE active = 1/);
	});
});

// ============================================================================
// Declarative differ: index BODY drift detection.
//
// The differ resolves indexes by name, then compares a CANONICAL BODY (UNIQUE-
// ness, column set/order/direction, partial WHERE, per-column collation — tags
// excluded) rendered by the same `createIndexBodyToCanonicalString` on both the
// declared-AST side and the actual-catalog side (lifted via `indexToCanonicalDDL`).
// Per-column collation is resolved identically on both sides (explicit index
// COLLATE, else the table column's collation, else BINARY; normalized) so an
// inherited/default-BINARY collation that is unchanged never churns, while a real
// collation change drops+recreates. A name-matched index whose body drifted drops +
// recreates (the recreate carries the declared tags); an unchanged body with drifted
// tags takes in-place SET TAGS.
// ============================================================================

describe('CREATE INDEX DDL round-trip: declarative differ stability', () => {
	/** Parse a `declare schema main { … }` body into its DeclareSchemaStmt AST. */
	function declaredSchemaOf(body: string): DeclareSchemaStmt {
		const stmt = parse(`declare schema main {\n${body}\n}`);
		if (stmt.type !== 'declareSchema') throw new Error(`not a declare schema: ${stmt.type}`);
		return stmt;
	}

	/**
	 * Apply `baseline` as schema `main`, then diff a fresh `modified` declaration
	 * against the resulting actual catalog. The baseline is applied so the actual
	 * table round-trips with zero churn — only the index edit between `baseline` and
	 * `modified` drives the returned diff. `policy` defaults to 'allow'.
	 */
	async function diffIndexEdit(baseline: string, modified: string, policy?: RenamePolicy): Promise<SchemaDiff> {
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${baseline}\n}`);
			await db.exec('apply schema main');
			const actual = collectSchemaCatalog(db, 'main');
			return computeSchemaDiff(declaredSchemaOf(modified), actual, policy);
		} finally {
			await db.close();
		}
	}

	/** Table shared by every index-edit case (identical in baseline + modified, so no table churn). */
	const TABLE = `table t { id INTEGER PRIMARY KEY, name TEXT, email TEXT, active INTEGER }`;

	it('an unchanged re-declared index produces no migration, and the actual DDL carries UNIQUE', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nunique index uq_email on t (email)\n}`);
			await db.exec('apply schema main');
			const actual = collectSchemaCatalog(db, 'main');
			// The actual-side index DDL now carries the UNIQUE keyword (generateIndexDDL).
			expect(actual.indexes.find(i => i.name.toLowerCase() === 'uq_email')!.ddl)
				.to.match(/^CREATE UNIQUE INDEX/);
			// Re-diffing the same declaration is a no-op: the differ compares canonical
			// bodies, and the declared UNIQUE matches the actual UNIQUE body (collation,
			// excluded from the body, cannot churn either).
			const diff = computeSchemaDiff(declaredSchemaOf(`${TABLE}\nunique index uq_email on t (email)`), actual);
			expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
			expect(diff.indexTagsChanges, 'no tag changes').to.deep.equal([]);
			expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an inherited-NOCASE unique index re-declares with no churn (both sides resolve the same collation)', async () => {
		// The index has no explicit COLLATE; both sides resolve NOCASE from the table
		// column, so the canonical bodies match and no recreate churns.
		const tbl = `table t { id INTEGER PRIMARY KEY, email TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${tbl}\nunique index uq_email on t (email)`, `${tbl}\nunique index uq_email on t (email)`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('plain → UNIQUE drops + recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_email on t (email)`, `${TABLE}\nunique index ix_email on t (email)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/^create unique index/i);
		expect(diff.indexTagsChanges, 'no separate SET TAGS').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table churn').to.deep.equal([]);
	});

	it('UNIQUE → plain drops + recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nunique index ix_email on t (email)`, `${TABLE}\nindex ix_email on t (email)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/^create index/i);
		expect(diff.indexesToCreate[0], 'recreate drops the UNIQUE keyword').to.not.match(/unique/i);
	});

	it('adding a partial WHERE predicate recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active)`, `${TABLE}\nindex ix_active on t (active) where active = 1`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/where active = 1/i);
	});

	it('removing a partial WHERE predicate recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active) where active = 1`, `${TABLE}\nindex ix_active on t (active)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate drops the WHERE').to.not.match(/where/i);
	});

	it('changing a partial WHERE predicate recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active) where active = 1`, `${TABLE}\nindex ix_active on t (active) where active = 0`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/where active = 0/i);
	});

	it('a semantically-identical partial predicate does not churn', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active) where active = 1`, `${TABLE}\nindex ix_active on t (active) where active = 1`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('a partial WHERE whose column-ref case changes across re-declares does not churn', async () => {
		// The stored predicate keeps the as-written ref case; baseline WHERE references the
		// column as `Active`, the modified re-declare as `active` (the column is `active`).
		// Equal only after folding the column ref in the canonical index body — and the
		// literal `1` is preserved byte-exact (the genuine-edit case above proves it differs).
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (name) where Active = 1`, `${TABLE}\nindex ix_active on t (name) where active = 1`);
		expect(diff.indexesToDrop, 'no drop from a WHERE column-ref case change').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate from a WHERE column-ref case change').to.deep.equal([]);
	});

	it('reordering index columns recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, active)`, `${TABLE}\nindex ix_comp on t (active, name)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_comp']);
		expect(diff.indexesToCreate).to.have.length(1);
	});

	it('flipping a column direction (asc → desc) recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, active)`, `${TABLE}\nindex ix_comp on t (name, active desc)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_comp']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/active desc/i);
	});

	it('a desc index re-declared unchanged does not churn (actual-side desc lift is symmetric)', async () => {
		// Guards the `indexToCanonicalDDL` lift: the stored `IndexColumnSchema.desc`
		// must round-trip to a `desc` direction so a baseline desc index re-declared
		// verbatim renders the SAME canonical body — no spurious drop+recreate. Every
		// other desc test starts from an asc baseline, so only this one exercises the
		// actual side already carrying desc.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, active desc)`, `${TABLE}\nindex ix_comp on t (name, active desc)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.indexTagsChanges, 'no tag changes').to.deep.equal([]);
	});

	it('changing the indexed column (different column) recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_one on t (name)`, `${TABLE}\nindex ix_one on t (email)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_one']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/\(\s*"?email"?\s*\)/i);
	});

	// An index reference whose case diverges from the column DEFINITION case must not
	// churn: the actual side lifts the definition case (tableSchema.columns[i].name)
	// while the declared side carries the as-written reference case, and the canonical
	// body folds both (matching case-insensitive column resolution). Without the fold
	// these render byte-unequal and drop+recreate on every diff.
	it('an index column whose case differs from the column definition does not churn', async () => {
		// Column declared `Email`, index references `email` — same on both apply→declare
		// sides, so only the definition≠reference case divergence is under test.
		const tbl = `table t { id INTEGER PRIMARY KEY, Email TEXT, Active INTEGER, Name TEXT }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t (email)`, `${tbl}\nindex ix on t (email)`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('a composite index with mixed-case column references does not churn', async () => {
		// Columns `name` / `active` (lowercase definitions) referenced as `Name` / `Active`.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (Name, Active)`, `${TABLE}\nindex ix_comp on t (Name, Active)`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('a reserved-word index column in mixed case re-quotes identically on both sides', async () => {
		// Probe: a reserved-word column name must lowercase BEFORE quoteIdentifier so it
		// re-quotes to `"order"` on both the definition (`Order`) and reference (`ORDER`)
		// sides — neither over- nor under-quoted, and no case-only churn.
		const tbl = `table t { id INTEGER PRIMARY KEY, "Order" INTEGER }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t ("ORDER")`, `${tbl}\nindex ix on t ("ORDER")`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('a tags-only change takes SET TAGS, not a recreate', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_name on t (name) with tags (purpose = 'a')`, `${TABLE}\nindex ix_name on t (name) with tags (purpose = 'b')`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.indexTagsChanges).to.deep.equal([{ name: 'ix_name', tags: { purpose: 'b' } }]);
	});

	it('a body change with a concurrent tags change is a single recreate, no SET TAGS', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_name on t (name) with tags (purpose = 'a')`, `${TABLE}\nunique index ix_name on t (name) with tags (purpose = 'b')`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_name']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/^create unique index/i);
		expect(diff.indexesToCreate[0], 'recreate carries the declared tags').to.match(/purpose = 'b'/i);
		expect(diff.indexTagsChanges, 'no separate SET TAGS').to.deep.equal([]);
	});

	it('a body-change recreate does not trip require-hint policy', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_email on t (email)`, `${TABLE}\nunique index ix_email on t (email)`, 'require-hint');
		expect(diff.indexesToDrop).to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
	});

	it('a genuine unhinted create + drop still trips require-hint policy', async () => {
		let threw = false;
		try {
			await diffIndexEdit(`${TABLE}\nindex ix_old on t (email)`, `${TABLE}\nindex ix_new on t (email)`, 'require-hint');
		} catch (e) {
			threw = true;
			expect((e as Error).message).to.match(/require-hint/i);
		}
		expect(threw, 'distinct-name create + drop must trip require-hint').to.equal(true);
	});

	it('applying an index body change converges (the drop + recreate executes, re-diff is empty)', async () => {
		// End-to-end: exercise the real apply path (generateMigrationDDL → exec the
		// DROP INDEX + CREATE UNIQUE INDEX pair), not just the diff decision.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nindex ix_email on t (email)\n}`);
			await db.exec('apply schema main');

			// Re-declare the same index as UNIQUE and re-apply — the migration drops
			// and recreates it.
			await db.exec(`declare schema main {\n${TABLE}\nunique index ix_email on t (email)\n}`);
			await db.exec('apply schema main');

			// The applied index is now UNIQUE…
			const actual = collectSchemaCatalog(db, 'main');
			expect(actual.indexes.find(i => i.name.toLowerCase() === 'ix_email')!.ddl).to.match(/^CREATE UNIQUE INDEX/);

			// …and the declaration now matches the catalog (the migration converged —
			// a third diff is empty).
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'converged: no creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'converged: no drops').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// --- Per-column collation in the canonical index body ---
	// Both sides pre-resolve each column's effective collation (explicit index
	// COLLATE, else the table column's collation, else BINARY; normalized), so an
	// inherited/default-BINARY collation that is unchanged renders identically (no
	// churn) while a genuine collation change diverges (drop+recreate).

	it('an index inheriting BINARY, re-declared verbatim, does not churn', async () => {
		// The common case the original exclusion protected: no COLLATE anywhere, both
		// sides resolve BINARY and elide it.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (name)`, `${TABLE}\nindex ix on t (name)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.indexTagsChanges, 'no tag changes').to.deep.equal([]);
	});

	it('adding an explicit index COLLATE recreates the index', async () => {
		// Declared resolves NOCASE, actual still BINARY → diverge → drop+recreate.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (email)`, `${TABLE}\nindex ix on t (email collate nocase)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate carries the declared collation').to.match(/collate nocase/i);
	});

	it('applying an added explicit index COLLATE converges and the catalog index carries the collation', async () => {
		// End-to-end companion to the diff-only case above: exercise the real apply
		// path. The recreate's CREATE INDEX … (email collate nocase) flows through the
		// live buildIndexSchema (a collate-folded column), the path this ticket unblocked.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nindex ix on t (email)\n}`);
			await db.exec('apply schema main');

			// Re-declare with an explicit per-column COLLATE and re-apply — drop+recreate.
			await db.exec(`declare schema main {\n${TABLE}\nindex ix on t (email collate nocase)\n}`);
			await db.exec('apply schema main');

			// The applied index now carries NOCASE on its column…
			const info = await rows(db, "select column_name, collation from index_info('t')");
			expect(info, 'applied index column resolves NOCASE').to.deep.equal([{ column_name: 'email', collation: 'NOCASE' }]);

			// …and a re-diff is empty (the migration converged).
			const actual = collectSchemaCatalog(db, 'main');
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'converged: no creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'converged: no drops').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an explicit-COLLATE index applies on first declare and re-applies with zero churn', async () => {
		// The collate-folded form must survive the live create path on the FIRST apply
		// (not just as a recreate), then re-declaring it verbatim must not churn.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nindex ix on t (email collate nocase)\n}`);
			await db.exec('apply schema main');

			const info = await rows(db, "select column_name, collation from index_info('t')");
			expect(info, 'first apply built the index with NOCASE').to.deep.equal([{ column_name: 'email', collation: 'NOCASE' }]);

			// Re-declaring the identical index is a no-op (zero churn on re-diff).
			await db.exec(`declare schema main {\n${TABLE}\nindex ix on t (email collate nocase)\n}`);
			const actual = collectSchemaCatalog(db, 'main');
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'no creates on verbatim re-declare').to.deep.equal([]);
			expect(diff.indexesToDrop, 'no drops on verbatim re-declare').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a descending explicit-COLLATE index applies and the catalog carries both DESC and the collation', async () => {
		// The collate-folded DESC form (`email collate nocase desc`) must survive the
		// live create path AND round-trip its direction: buildIndexSchema reads the
		// direction off col.direction (not the folded expr), and the persistence
		// emitter re-appends the trailing `desc` for that form. End-to-end apply-level
		// guard for the DESC half (the canonical-body no-churn case is covered below).
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nindex ix on t (email collate nocase desc)\n}`);
			await db.exec('apply schema main');

			const info = await rows(db, "select column_name, collation, \"desc\" from index_info('t')");
			expect(info, 'applied index column carries NOCASE and DESC').to.deep.equal([{ column_name: 'email', collation: 'NOCASE', desc: 1 }]);

			// Re-declaring the identical descending index is a no-op (zero churn on re-diff).
			await db.exec(`declare schema main {\n${TABLE}\nindex ix on t (email collate nocase desc)\n}`);
			const actual = collectSchemaCatalog(db, 'main');
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'no creates on verbatim re-declare').to.deep.equal([]);
			expect(diff.indexesToDrop, 'no drops on verbatim re-declare').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an index inheriting a non-BINARY column collation, re-declared verbatim, does not churn', async () => {
		// `email text collate nocase`, index has no explicit COLLATE: both sides resolve
		// NOCASE from the TABLE column. Guards that the declared side reads the
		// table-column collation, not just the index column's explicit COLLATE.
		const tbl = `table t { id INTEGER PRIMARY KEY, email TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t (email)`, `${tbl}\nindex ix on t (email)`);
		expect(diff.indexesToDrop, 'no drop from inherited NOCASE').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate from inherited NOCASE').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('changing the column collation under a stable-named index recreates it AND alters the column', async () => {
		// `name text` → `name text collate nocase` with a same-named index inheriting it.
		// The index follows the declared column: declared body resolves NOCASE, actual
		// body (old) is BINARY → drop+recreate. The column itself also emits a SET COLLATE.
		const baseTbl = `table t { id INTEGER PRIMARY KEY, name TEXT }`;
		const modTbl = `table t { id INTEGER PRIMARY KEY, name TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${baseTbl}\nindex ix on t (name)`, `${modTbl}\nindex ix on t (name)`);
		expect(diff.indexesToDrop, 'index drops').to.deep.equal(['ix']);
		expect(diff.indexesToCreate, 'index recreates').to.have.length(1);
		// The column collation change rides the table-alter channel.
		expect(diff.tablesToAlter, 'one table alter').to.have.length(1);
		const colChange = diff.tablesToAlter[0].columnsToAlter.find(c => c.columnName.toLowerCase() === 'name');
		expect(colChange?.collation, 'column SET COLLATE to NOCASE').to.equal('NOCASE');
	});

	it('an explicit COLLATE BINARY on a BINARY column does not churn', async () => {
		// Normalization makes `binary` / `BINARY` / absent equivalent — both elide.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (email)`, `${TABLE}\nindex ix on t (email collate binary)`);
		expect(diff.indexesToDrop, 'no drop from a no-op explicit BINARY').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate from a no-op explicit BINARY').to.deep.equal([]);
	});

	it('a composite index with all collations unchanged does not churn', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, email)`, `${TABLE}\nindex ix_comp on t (name, email)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('a composite index gaining one column COLLATE recreates', async () => {
		// Only the second column's render differs → recreate.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, email)`, `${TABLE}\nindex ix_comp on t (name, email collate nocase)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_comp']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/collate nocase/i);
	});

	it('a desc index inheriting a non-BINARY collation, re-declared verbatim, does not churn', async () => {
		// Guards the name->collate->desc render order on both sides with an inherited
		// NOCASE collation plus a descending column.
		const tbl = `table t { id INTEGER PRIMARY KEY, name TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t (name desc)`, `${tbl}\nindex ix on t (name desc)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('an explicit COLLATE on a descending column (collate-folded form), re-declared verbatim, does not churn', async () => {
		const diff = await diffIndexEdit(
			`${TABLE}\nindex ix on t (email collate nocase desc)`,
			`${TABLE}\nindex ix on t (email collate nocase desc)`,
		);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('a pure collation body-change recreate does not trip require-hint policy', async () => {
		// A collation-driven recreate is a body change (counts in indexRecreates),
		// so it is excluded from the unhinted-rename guard, exactly as other body changes.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (email)`, `${TABLE}\nindex ix on t (email collate nocase)`, 'require-hint');
		expect(diff.indexesToDrop).to.deep.equal(['ix']);
		expect(diff.indexesToCreate).to.have.length(1);
	});

	// --- Concurrent column-rename reconciliation in the canonical index body ---
	// The actual catalog body renders the PRE-rename column names (the rename has not
	// landed at diff time) while the declared body renders the NEW names. The differ
	// inverse-applies the index table's in-diff column renames to the declared body so
	// a same-named index over a renamed column matches (no churn — the rename rides the
	// table-alter channel) while a genuine body edit layered on the rename still
	// recreates. A column rename needs `quereus.previous_name` on the modified column
	// (baseline under the old name, modified under the new name + hint).

	it('a column rename under a same-named index emits only the column rename (no index churn)', async () => {
		// Headline case: index ix_email on t(email) with email renamed to email_addr.
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT }\nindex ix_email on t (email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT with tags ("quereus.previous_name" = 'email') }\nindex ix_email on t (email_addr)`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no index drop from a pure column rename').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate from a pure column rename').to.deep.equal([]);
		expect(diff.indexTagsChanges, 'no index tag change').to.deep.equal([]);
		expect(diff.tablesToAlter, 'one table alter for the column rename').to.have.length(1);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
	});

	it('a column rename plus an index body edit recreates the index AND emits the column rename', async () => {
		// Same rename, but the index also flips the column direction asc → desc: the
		// reconciled body still differs (the edit is not undone by the inverse-rename) →
		// drop+recreate, while the column rename is also emitted.
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT }\nindex ix_email on t (email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT with tags ("quereus.previous_name" = 'email') }\nindex ix_email on t (email_addr desc)`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'body edit recreates under the rename').to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate carries the NEW column name + desc').to.match(/email_addr desc/i);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
	});

	it('a composite index with one renamed and one stable column does not churn', async () => {
		// Only the renamed column is inverse-mapped; the stable column matches as-is.
		const base = `table t { id INTEGER PRIMARY KEY, name TEXT, email TEXT }\nindex ix_comp on t (name, email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, name TEXT, email_addr TEXT with tags ("quereus.previous_name" = 'email') }\nindex ix_comp on t (name, email_addr)`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no churn — body matches after reconcile').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
	});

	it('a renamed column whose inherited collation is unchanged does not churn (ordering guard)', async () => {
		// The collation must resolve on the NEW name (the declared ColumnDef is keyed by
		// it) and only THEN be mapped back to the old name. Reversing the order would
		// look the collation up under the old name, miss the NOCASE, and churn.
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT collate nocase }\nindex ix on t (email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT collate nocase with tags ("quereus.previous_name" = 'email') }\nindex ix on t (email_addr)`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no churn — inherited NOCASE resolved on the new name, then mapped back').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
	});

	it('a renamed column whose collation also changed recreates the index', async () => {
		// Rename email → email_addr AND add an inherited NOCASE on the column: the
		// reconciled body resolves NOCASE on the new name (mapped back to old) vs the
		// actual BINARY → genuine collation change still recreates, alongside the column
		// rename. The recreate DDL carries no explicit COLLATE (the index inherits the
		// table column's NOCASE rather than declaring its own); the drop+recreate is the
		// observable effect, plus a column SET COLLATE on the table-alter channel.
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT }\nindex ix on t (email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT collate nocase with tags ("quereus.previous_name" = 'email') }\nindex ix on t (email_addr)`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'collation change still recreates under a rename').to.deep.equal(['ix']);
		expect(diff.indexesToCreate).to.have.length(1);
		const alter = diff.tablesToAlter[0];
		expect(alter.columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
		const colChange = alter.columnsToAlter.find(c => c.columnName.toLowerCase() === 'email_addr');
		expect(colChange?.collation, 'column SET COLLATE to NOCASE rides the table-alter channel').to.equal('NOCASE');
	});

	it('a partial-WHERE index over a renamed column does not churn (WHERE predicate reconciled)', async () => {
		// The index column list (name) is stable; only the partial predicate references
		// the renamed column. The declared WHERE (`is_active = 1`) is inverse-rewritten
		// back to `active = 1` to match the actual (pre-rename) predicate.
		const base = `table t { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix_active on t (name) where active = 1`;
		const mod = `table t { id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER with tags ("quereus.previous_name" = 'active') }\nindex ix_active on t (name) where is_active = 1`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no churn — the partial WHERE predicate is reconciled new→old').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'active', newName: 'is_active' }]);
	});

	it('a partial-WHERE index whose predicate genuinely changed still recreates under a rename', async () => {
		// Precedence guard for the WHERE reconcile: a real predicate edit (literal 1 → 0)
		// layered on the column rename survives the inverse-rewrite → drop+recreate.
		const base = `table t { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix_active on t (name) where active = 1`;
		const mod = `table t { id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER with tags ("quereus.previous_name" = 'active') }\nindex ix_active on t (name) where is_active = 0`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'genuine predicate edit still recreates').to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/where is_active = 0/i);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'active', newName: 'is_active' }]);
	});

	it('a column-rename-only diff under require-hint does not trip the index guard', async () => {
		// A reconciled pure column rename produces NO index drop+create, so it must not
		// trip the unhinted-rename guard (it counts as zero creates / zero drops).
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT }\nindex ix_email on t (email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT with tags ("quereus.previous_name" = 'email') }\nindex ix_email on t (email_addr)`;
		const diff = await diffIndexEdit(base, mod, 'require-hint');
		expect(diff.indexesToDrop, 'reconciled rename produces no index churn').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate').to.deep.equal([]);
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
	});

	it('applying a column rename under a same-named index converges (RENAME COLUMN executes, index survives, re-diff empty)', async () => {
		// End-to-end: exercise the real apply path, not just the diff DECISION. A pure
		// column rename is a metadata-only RENAME COLUMN (no index drop+recreate), and
		// the index — which stores its column by ordinal, not name — survives intact.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\ntable t { id INTEGER PRIMARY KEY, email TEXT }\nindex ix_email on t (email)\n}`);
			await db.exec('apply schema main');
			await db.exec("insert into t values (1, 'a@x')");

			// Re-declare with the column renamed (previous_name hint) and re-apply.
			await db.exec(`declare schema main {\ntable t { id INTEGER PRIMARY KEY, email_addr TEXT with tags ("quereus.previous_name" = 'email') }\nindex ix_email on t (email_addr)\n}`);
			await db.exec('apply schema main');

			// The column is renamed and the index survived (no drop+recreate).
			const actual = collectSchemaCatalog(db, 'main');
			expect(actual.tables[0].columns.some(c => c.name.toLowerCase() === 'email_addr'), 'column renamed to email_addr').to.equal(true);
			expect(actual.indexes.some(i => i.name.toLowerCase() === 'ix_email'), 'index survived the rename').to.equal(true);

			// The declaration now matches the catalog — a third diff is empty (idempotent;
			// the previous_name hint must not re-trigger after the rename lands).
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'converged: no index creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'converged: no index drops').to.deep.equal([]);
			expect(diff.tablesToAlter, 'converged: no table alters').to.deep.equal([]);

			// The data survived and is queryable under the new column name.
			const rows: Record<string, unknown>[] = [];
			for await (const r of db.eval('select email_addr from t where id = 1')) rows.push(r as Record<string, unknown>);
			expect(rows, 'row survived the rename, readable under email_addr').to.deep.equal([{ email_addr: 'a@x' }]);
		} finally {
			await db.close();
		}
	});

	it('applying a pure column rename under a PARTIAL index converges (stored predicate rewritten, re-diff empty)', async () => {
		// Diff #1 reconciles the index body new→old (no drop+recreate — the
		// migration runs only RENAME COLUMN), so convergence depends on the rename
		// propagation rewriting the STORED predicate; with it left stale, the
		// re-diff would drop+recreate the index one apply cycle late.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\ntable t { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix_active on t (name) where active = 1\n}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {\ntable t { id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER with tags ("quereus.previous_name" = 'active') }\nindex ix_active on t (name) where is_active = 1\n}`);
			await db.exec('apply schema main');

			// Post-apply, the catalog index DDL renders the NEW column name.
			const actual = collectSchemaCatalog(db, 'main');
			const ix = actual.indexes.find(i => i.name.toLowerCase() === 'ix_active')!;
			expect(ix.ddl, 'stored predicate follows the rename').to.match(/WHERE is_active = 1/i);
			expect(ix.ddl, 'no stale reference to the old column name').to.not.match(/where active = 1/i);

			// Re-diff is empty — the apply converged in one cycle.
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToDrop, 'converged: no index drops').to.deep.equal([]);
			expect(diff.indexesToCreate, 'converged: no index creates').to.deep.equal([]);
			expect(diff.tablesToAlter, 'converged: no table alters').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a renamed index over a concurrently-renamed column recreates under the OLD column name', async () => {
		// The index is matched via its own previous_name hint (ix_old → ix_new) AND its
		// referenced column is renamed (email → email_addr). The body reconcile still
		// applies on the rename-matched index (no body drift), but the `kind: 'index'`
		// rename op is metadata only — the convergence DDL is the hinted-rename
		// drop+recreate, rendered with the in-diff column rename inverse-applied
		// (creates precede RENAME COLUMN in migration order; the live propagation
		// rewrites the fresh index afterwards).
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT }\nindex ix_old on t (email)`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT with tags ("quereus.previous_name" = 'email') }\nindex ix_new on t (email_addr) with tags ("quereus.previous_name" = 'ix_old')`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'drop targets the actual (old) index name').to.deep.equal(['ix_old']);
		expect(diff.indexesToCreate, 'one recreate under the declared name').to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate names the OLD column (RENAME COLUMN has not run yet)').to.match(/\(email\)/i);
		expect(diff.indexesToCreate[0], 'recreate does not name the NEW column').to.not.match(/email_addr/i);
		expect(diff.renames, 'index rename op still recorded (metadata)').to.deep.include({ kind: 'index', oldName: 'ix_old', newName: 'ix_new' });
		expect(diff.tablesToAlter[0].columnsToRename).to.deep.equal([{ oldName: 'email', newName: 'email_addr' }]);
	});

	it('a renamed PARTIAL index over collate-folded + predicate-referenced renamed columns recreates fully reconciled', async () => {
		// The columnReconciledIndexStmt paths the plain re-pin above does not reach:
		// an indexed column in the parser's collate-folded form (bare name on
		// col.expr.expr.name, not col.name) and a partial WHERE predicate referencing
		// a second renamed column (own-table seeded CHECK-expression walk). Both must
		// render under the OLD names — RENAME COLUMN has not run at create time.
		const base = `table t { id INTEGER PRIMARY KEY, email TEXT, active INTEGER }\nindex ix_old on t (email collate nocase) where active = 1`;
		const mod = `table t { id INTEGER PRIMARY KEY, email_addr TEXT with tags ("quereus.previous_name" = 'email'), is_active INTEGER with tags ("quereus.previous_name" = 'active') }\nindex ix_new on t (email_addr collate nocase) where is_active = 1 with tags ("quereus.previous_name" = 'ix_old')`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'drop targets the actual (old) index name').to.deep.equal(['ix_old']);
		expect(diff.indexesToCreate, 'one recreate under the declared name').to.have.length(1);
		expect(diff.indexesToCreate[0], 'collate-folded indexed column maps back to the OLD name').to.match(/email collate nocase/i);
		expect(diff.indexesToCreate[0], 'WHERE predicate names the OLD column').to.match(/where active = 1/i);
		expect(diff.indexesToCreate[0], 'no NEW names leak into the recreate').to.not.match(/email_addr|is_active/i);
	});

	it('a table rename with stable columns does not churn the index body', async () => {
		// The index body excludes the `on <table>` reference, so a *table* rename alone
		// never churns it; the column-rename lookup keyed by the new table name returns
		// [] (no column renames), so the reconcile is a no-op. Only the table rename op
		// is emitted — no index drop+recreate.
		const base = `table t_old { id INTEGER PRIMARY KEY, email TEXT }\nindex ix on t_old (email)`;
		const mod = `table t_new { id INTEGER PRIMARY KEY, email TEXT } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (email)`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no index drop from a table rename').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate from a table rename').to.deep.equal([]);
		expect(diff.renames, 'table rename op emitted').to.deep.include({ kind: 'table', oldName: 't_old', newName: 't_new' });
	});

	it('a table rename with an UNQUALIFIED partial-WHERE predicate does not churn the index', async () => {
		// Regression guard: a partial predicate with an *unqualified* column reference
		// carries no table name, so the body is invariant under a table rename — only the
		// table rename op is emitted. (A *table-qualified* self-reference embeds the table
		// name and is reconciled by the qualifier inverse-rewrite — pinned by the
		// qualified-predicate cases below. The unqualified form is the idiomatic one and
		// is pinned here.)
		const base = `table t_old { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix on t_old (name) where active = 1`;
		const mod = `table t_new { id INTEGER PRIMARY KEY, name TEXT, active INTEGER } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (name) where active = 1`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no index drop from a table rename under an unqualified predicate').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate from a table rename under an unqualified predicate').to.deep.equal([]);
		expect(diff.renames, 'table rename op emitted').to.deep.include({ kind: 'table', oldName: 't_old', newName: 't_new' });
	});

	// --- Concurrent TABLE-rename reconciliation in the partial-WHERE predicate ---
	// A table-QUALIFIED self-reference (`where t_old.active = 1`) embeds the table
	// name in the predicate body, so a pure table rename would otherwise churn a
	// spurious drop+recreate. The differ inverse-rewrites the qualifier NEW→OLD over
	// a cloned predicate (the exact inverse of the forward rewriter the rename
	// migration runs) BEFORE the per-column rewrites — which are seeded with the OLD
	// table name, so a qualified ref under both a table AND a column rename
	// reconciles on both dimensions.

	it('a table rename with a QUALIFIED partial-WHERE self-reference does not churn the index', async () => {
		const base = `table t_old { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix on t_old (name) where t_old.active = 1`;
		const mod = `table t_new { id INTEGER PRIMARY KEY, name TEXT, active INTEGER } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (name) where t_new.active = 1`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no index drop — the predicate qualifier is reconciled new→old').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate').to.deep.equal([]);
		expect(diff.renames, 'table rename op emitted').to.deep.include({ kind: 'table', oldName: 't_old', newName: 't_new' });
	});

	it('a table rename PLUS a column rename with a qualified predicate ref does not churn (seed alignment)', async () => {
		// Covers the rewriter-seed alignment: the qualifier is normalized NEW→OLD first,
		// then the column rewrite runs seeded with the OLD table name — so the qualified
		// ref under the NEW table name (`t_new.is_active`) reconciles on BOTH dimensions.
		// (Seeding the column rewrite with the NEW name, as before, would rewrite the
		// column but strand the qualifier.)
		const base = `table t_old { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix on t_old (name) where t_old.active = 1`;
		const mod = `table t_new { id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER with tags ("quereus.previous_name" = 'active') } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (name) where t_new.is_active = 1`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'no index drop — qualifier AND column reconciled').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate').to.deep.equal([]);
		expect(diff.renames, 'table rename op emitted').to.deep.include({ kind: 'table', oldName: 't_old', newName: 't_new' });
		expect(diff.tablesToAlter[0].columnsToRename, 'column rename rides the table-alter channel').to.deep.equal([{ oldName: 'active', newName: 'is_active' }]);
	});

	it('a genuine predicate edit layered on a table rename still recreates', async () => {
		// Precedence guard for the qualifier reconcile: a real predicate edit (literal
		// 1 → 0) survives the inverse-rewrite → drop+recreate, alongside the rename op.
		const base = `table t_old { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix on t_old (name) where t_old.active = 1`;
		const mod = `table t_new { id INTEGER PRIMARY KEY, name TEXT, active INTEGER } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (name) where t_new.active = 0`;
		const diff = await diffIndexEdit(base, mod);
		expect(diff.indexesToDrop, 'genuine predicate edit recreates').to.deep.equal(['ix']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate carries the NEW qualifier + edited literal').to.match(/where t_new\.active = 0/i);
		expect(diff.renames, 'table rename op still emitted').to.deep.include({ kind: 'table', oldName: 't_old', newName: 't_new' });
	});

	it('a reconciled qualified-predicate table rename under require-hint does not trip the index guard', async () => {
		// The reconcile yields zero index creates/drops, so the unhinted-rename guard
		// has nothing to trip on (the table rename itself is hinted).
		const base = `table t_old { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix on t_old (name) where t_old.active = 1`;
		const mod = `table t_new { id INTEGER PRIMARY KEY, name TEXT, active INTEGER } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (name) where t_new.active = 1`;
		const diff = await diffIndexEdit(base, mod, 'require-hint');
		expect(diff.indexesToDrop, 'no index churn under require-hint').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no index recreate under require-hint').to.deep.equal([]);
	});

	it('applying a table rename under a QUALIFIED partial-WHERE index converges (stored qualifier rewritten, re-diff empty)', async () => {
		// Diff #1 reconciles the predicate qualifier new→old (no drop+recreate — the
		// migration runs only ALTER TABLE RENAME); convergence then depends on the
		// forward propagation rewriting the STORED predicate's qualifier, so the
		// re-diff sees `t_new.active` on both sides.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\ntable t_old { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }\nindex ix on t_old (name) where t_old.active = 1\n}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {\ntable t_new { id INTEGER PRIMARY KEY, name TEXT, active INTEGER } with tags ("quereus.previous_name" = 't_old')\nindex ix on t_new (name) where t_new.active = 1\n}`);
			await db.exec('apply schema main');

			// Post-apply, the catalog index DDL renders the NEW qualifier.
			const actual = collectSchemaCatalog(db, 'main');
			const ix = actual.indexes.find(i => i.name.toLowerCase() === 'ix')!;
			expect(ix.ddl, 'stored predicate qualifier follows the rename').to.match(/WHERE t_new\.active = 1/i);
			expect(ix.ddl, 'no stale reference to the old table name').to.not.match(/t_old\.active/i);

			// Re-diff is empty — the apply converged in one cycle.
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToDrop, 'converged: no index drops').to.deep.equal([]);
			expect(diff.indexesToCreate, 'converged: no index creates').to.deep.equal([]);
			expect(diff.tablesToAlter, 'converged: no table alters').to.deep.equal([]);
			expect(diff.renames, 'converged: no rename re-trigger').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// `declare schema { ... }` index WHERE-clause grammar (partial declared index).
//
// `declareIndexItem` must accept an optional WHERE <predicate> between the column
// list and WITH TAGS, mirroring the standalone `create index` form, so a partial
// index can be expressed inside a declarative schema. These are parse-level tests:
// they inspect the `CreateIndexStmt.where` the parser populates on each declared
// index item.
// ============================================================================

/** Extract every declared index's `CreateIndexStmt` from a declare-schema body. */
function declaredIndexes(body: string): CreateIndexStmt[] {
	const stmt = parse(`declare schema main {\n${body}\n}`);
	if (stmt.type !== 'declareSchema') throw new Error(`not a declare schema: ${stmt.type}`);
	return stmt.items
		.filter((it): it is DeclaredIndex => it.type === 'declaredIndex')
		.map(it => it.indexStmt);
}

describe('declare schema: index WHERE-clause grammar', () => {
	it('a plain partial index populates indexStmt.where', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 index ix_active on t (active) where active = 1`,
		);
		expect(ix.index.name).to.equal('ix_active');
		expect(ix.where, 'partial declared index carries a WHERE predicate').to.exist;
		expect(ix.isUnique ?? false, 'plain index is not unique').to.equal(false);
		expect(ix.tags, 'no tags on a bare partial index').to.be.undefined;
	});

	it('a unique partial index sets both isUnique and where', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 unique index uq_active on t (active) where active = 1`,
		);
		expect(ix.isUnique, 'unique keyword threads through').to.equal(true);
		expect(ix.where, 'unique partial index carries a WHERE predicate').to.exist;
	});

	it('a partial index with WITH TAGS populates both where and tags', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 unique index uq_a on t (active) where active = 1 with tags (k = 'v')`,
		);
		expect(ix.where, 'WHERE before WITH TAGS').to.exist;
		expect(ix.tags, 'WITH TAGS still parses after WHERE').to.deep.equal({ k: 'v' });
		expect(ix.isUnique).to.equal(true);
	});

	it('a non-partial declared index leaves where undefined (no regression)', () => {
		// Plain, tag-only, and a tag-only index followed by another item all keep
		// `where` undefined and must not mis-step the WITH/TAGS backtrack.
		const ixs = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }
			 index ix_plain on t (name)
			 index ix_tagged on t (active) with tags (purpose = 'search')
			 index ix_after on t (id)`,
		);
		expect(ixs.map(i => i.index.name)).to.deep.equal(['ix_plain', 'ix_tagged', 'ix_after']);
		expect(ixs[0].where, 'plain index has no predicate').to.be.undefined;
		expect(ixs[1].where, 'tag-only index has no predicate').to.be.undefined;
		expect(ixs[1].tags).to.deep.equal({ purpose: 'search' });
		// The item after a tag-only index parses cleanly — the WITH backtrack did
		// not strand the cursor.
		expect(ixs[2].where).to.be.undefined;
		expect(indexColumnName(ixs[2].columns[0])).to.equal('id');
	});

	it('a non-trivial predicate round-trips through createIndexToString re-parseably', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 index ix_active on t (active) where active = 1 and id > 0`,
		);
		const emitted = createIndexToString(ix);
		expect(emitted, 'emitted DDL carries the full predicate').to.match(/where active = 1 and id > 0/i);

		// Re-parse the emitted standalone DDL and re-emit: createIndexToString is a
		// fixed point over the declared partial index, so the predicate survives.
		const reparsed = parse(emitted);
		expect(reparsed.type).to.equal('createIndex');
		if (reparsed.type === 'createIndex') {
			expect(reparsed.where, 're-parsed DDL still carries a WHERE').to.exist;
			expect(createIndexToString(reparsed)).to.equal(emitted);
		}
	});
});
