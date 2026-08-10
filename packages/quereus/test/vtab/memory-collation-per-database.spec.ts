/**
 * The memory virtual table must resolve collation names against the `Database` it
 * belongs to, not a process-global registry. Before this suite's fix, everything
 * under `vtab/memory/` called the global `resolveCollation` (or passed a name to the
 * three-argument `compareSqlValues`), so a collation registered — or overridden —
 * with `db.registerCollation` was invisible to primary keys, secondary indexes, range
 * seeks, and UNIQUE enforcement: they silently ordered by raw byte value.
 *
 * Two reachable shapes exercise that:
 *  - **overriding a built-in** (`NOCASE`/`RTRIM`) on one database. DDL accepts the
 *    name on a TEXT column, but the comparator must be the database's.
 *  - **a custom-named collation on an index column** (`create index … collate REVERSE`).
 *    `IndexColumnSchema.collation` is not gated by `LogicalType.supportedCollations`,
 *    so a custom name reaches the index comparator.
 *
 * Since `feat-ddl-accepts-registered-collations`, a *column* declaring
 * `collate REVERSE` is ACCEPTED at DDL when REVERSE is registered on the connection
 * (the type-list gate is now registry-aware); an UNREGISTERED name is rejected for
 * every column type — including INTEGER/REAL/BLOB, which previously slid through the
 * gate and only failed later at comparator build. Both are exercised by the
 * `column DDL accepts a registered collation` describe at the bottom of this file.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { ConflictResolution, IndexConstraintOp } from '../../src/common/constants.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import type { ScanPlan } from '../../src/vtab/memory/layer/scan-plan.js';
import type { CollationFunction } from '../../src/types/logical-type.js';
import type { Row, SqlValue } from '../../src/common/types.js';

/** Descending lexicographic order — the inverse of BINARY. */
const REVERSE: CollationFunction = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/** Case-insensitive *descending* order — the inverse of the built-in NOCASE. */
const REVERSE_NOCASE: CollationFunction = (a, b) => REVERSE(a.toLowerCase(), b.toLowerCase());

/** Byte order. Registered under the name `NOCASE`, it makes that name case-sensitive. */
const BINARY_LIKE: CollationFunction = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Ignores *leading* spaces. Registered under `RTRIM`, it inverts which variants collide. */
const LTRIM: CollationFunction = (a, b) => BINARY_LIKE(a.replace(/^ +/, ''), b.replace(/^ +/, ''));

/** The memory manager backing `main.<tableName>` on `db`. */
function getManager(db: Database, tableName: string): MemoryTableManager {
	const schema = db.schemaManager.getTable('main', tableName);
	expect(schema, `schema for '${tableName}'`).to.not.be.undefined;
	expect(schema!.vtabModule, `'${tableName}' module`).to.be.instanceOf(MemoryTableModule);
	const manager = (schema!.vtabModule as MemoryTableModule).tables.get(`main.${tableName}`.toLowerCase());
	expect(manager, `memory manager for '${tableName}'`).to.not.be.undefined;
	return manager!;
}

/**
 * Scans a table's committed layer under `plan` directly. The planner does not
 * currently choose an index whose collation differs from the query's, so driving the
 * index scan by hand is the only way to observe the index comparator's ordering.
 */
async function scanCommitted(db: Database, tableName: string, plan: ScanPlan): Promise<Row[]> {
	const manager = getManager(db, tableName);
	const rows: Row[] = [];
	for await (const row of manager.scanLayer(manager.currentCommittedLayer, plan)) rows.push(row);
	return rows;
}

/** Collects one column of a query result, preserving row order. */
async function column(db: Database, sql: string, name: string): Promise<SqlValue[]> {
	const values: SqlValue[] = [];
	for await (const row of db.eval(sql)) values.push(row[name] as SqlValue);
	return values;
}

describe('memory vtab resolves collations against its own database', () => {
	describe('primary key ordering', () => {
		it('honors a per-database override of a built-in collation', async () => {
			const db = new Database();
			db.registerCollation('NOCASE', REVERSE_NOCASE);
			await db.exec('create table t (k text collate nocase primary key)');
			await db.exec("insert into t values ('a'), ('b'), ('c')");

			// A bare `select` walks the primary BTree in key order, so this observes the
			// PK comparator directly. Under the global NOCASE it returned a, b, c.
			expect(await column(db, 'select k from t', 'k')).to.deep.equal(['c', 'b', 'a']);
			await db.close();
		});

		it('leaves a database that did not override the built-in alone', async () => {
			const db = new Database();
			await db.exec('create table t (k text collate nocase primary key)');
			await db.exec("insert into t values ('a'), ('b'), ('c')");

			expect(await column(db, 'select k from t', 'k')).to.deep.equal(['a', 'b', 'c']);
			await db.close();
		});
	});

	describe('secondary index ordering', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			db.registerCollation('REVERSE', REVERSE);
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('create index ix_v on t (v collate REVERSE)');
			await db.exec("insert into t values (1,'a'), (2,'b'), (3,'c')");
		});

		afterEach(async () => { await db.close(); });

		it('walks a REVERSE-collated index in REVERSE key order', async () => {
			const rows = await scanCommitted(db, 't', { indexName: 'ix_v', descending: false });
			expect(rows.map(r => r[1])).to.deep.equal(['c', 'b', 'a']);
		});

		it('seeks a range bound under the index collation, not byte order', async () => {
			// Under REVERSE, 'a' sorts after 'b'. So `v > 'b'` selects 'a' alone —
			// the exact inverse of the BINARY answer ('c').
			const plan: ScanPlan = {
				indexName: 'ix_v',
				descending: false,
				lowerBound: { op: IndexConstraintOp.GT, value: 'b' },
				boundCollation: 'REVERSE',
			};
			const rows = await scanCommitted(db, 't', plan);
			expect(rows.map(r => r[1])).to.deep.equal(['a']);
		});

		it('orders a transaction layer over an inherited REVERSE index consistently', async () => {
			// The child layer wraps the parent's secondary BTree as its base, so its
			// compareKeys must be built from the same collation function the parent
			// ordered those nodes with — otherwise the inherited nodes are unreachable
			// or mis-ordered.
			const manager = getManager(db, 't');
			const conn = manager.connect();
			conn.begin();
			await manager.performMutation(conn, 'insert', [4, 'b5'], undefined, ConflictResolution.ABORT);

			const layer = conn.pendingTransactionLayer ?? conn.readLayer;
			const rows: Row[] = [];
			for await (const r of manager.scanLayer(layer, { indexName: 'ix_v', descending: false })) rows.push(r);
			expect(rows.map(r => r[1])).to.deep.equal(['c', 'b5', 'b', 'a']);
			conn.rollback();
		});

		it('never passes NULL to a collation function', async () => {
			// Collation functions only ever see the TEXT branch of compareSameType;
			// NULLs are ordered by storage class before any comparator runs.
			const seen: unknown[] = [];
			const db2 = new Database();
			db2.registerCollation('REVERSE', (a, b) => { seen.push(a, b); return REVERSE(a, b); });
			await db2.exec('create table n (id integer primary key, v text null)');
			await db2.exec('create index ix_n on n (v collate REVERSE)');
			await db2.exec("insert into n values (1, null), (2, 'x'), (3, null), (4, 'y')");
			await scanCommitted(db2, 'n', { indexName: 'ix_n', descending: false });

			expect(seen.length, 'collation was exercised').to.be.greaterThan(0);
			expect(seen.every(v => typeof v === 'string'), `saw ${JSON.stringify(seen)}`).to.be.true;
			await db2.close();
		});
	});

	describe('two databases, same collation name, opposite comparators', () => {
		it('sorts each memory table by its own database rules', async () => {
			const ascending = new Database();
			const descending = new Database();
			ascending.registerCollation('REVERSE', (a, b) => (a < b ? -1 : a > b ? 1 : 0)); // deliberately NOT reversed
			descending.registerCollation('REVERSE', REVERSE);

			for (const db of [ascending, descending]) {
				await db.exec('create table t (id integer primary key, v text)');
				await db.exec('create index ix_v on t (v collate REVERSE)');
				await db.exec("insert into t values (1,'a'), (2,'b'), (3,'c')");
			}

			const plan: ScanPlan = { indexName: 'ix_v', descending: false };
			expect((await scanCommitted(ascending, 't', plan)).map(r => r[1])).to.deep.equal(['a', 'b', 'c']);
			expect((await scanCommitted(descending, 't', plan)).map(r => r[1])).to.deep.equal(['c', 'b', 'a']);

			await ascending.close();
			await descending.close();
		});
	});

	describe('UNIQUE enforcement', () => {
		it('still rejects a case-variant duplicate under the built-in NOCASE', async () => {
			const db = new Database();
			await db.exec('create table t (id integer primary key, email text collate nocase unique)');
			await db.exec("insert into t values (1, 'abc')");

			let message = '';
			try { await db.exec("insert into t values (2, 'ABC')"); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/UNIQUE constraint failed/);
			await db.close();
		});

		it('enforces UNIQUE under the overriding database NOCASE comparator', async () => {
			// A NOCASE override that only folds case for ASCII letters still unifies
			// 'abc'/'ABC'; what changes is that the comparator is the database's.
			const db = new Database();
			db.registerCollation('NOCASE', REVERSE_NOCASE);
			await db.exec('create table t (id integer primary key, email text collate nocase unique)');
			await db.exec("insert into t values (1, 'abc')");

			let message = '';
			try { await db.exec("insert into t values (2, 'ABC')"); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/UNIQUE constraint failed/);

			// A non-equal value still inserts.
			await db.exec("insert into t values (3, 'abd')");
			expect(await column(db, 'select count(*) as n from t', 'n')).to.deep.equal([2]);
			await db.close();
		});

		it('lets an overriding NOCASE that does not fold case admit a case variant', async () => {
			// The discriminating case: the two tests above pass whichever comparator the
			// storage layer picked, because both the built-in NOCASE and REVERSE_NOCASE
			// unify 'abc'/'ABC'. Here the database's NOCASE is case-*sensitive*, so 'ABC'
			// must insert. Against the global registry's NOCASE it raised UNIQUE.
			const db = new Database();
			db.registerCollation('NOCASE', BINARY_LIKE);
			await db.exec('create table t (id integer primary key, email text collate nocase unique)');
			await db.exec("insert into t values (1, 'abc')");
			await db.exec("insert into t values (2, 'ABC')");

			expect(await column(db, 'select count(*) as n from t', 'n')).to.deep.equal([2]);

			// And an exact duplicate still collides.
			let message = '';
			try { await db.exec("insert into t values (3, 'abc')"); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/UNIQUE constraint failed/);
			await db.close();
		});

		it('enforces UNIQUE under an overriding RTRIM comparator', async () => {
			// RTRIM's override is the same seam as NOCASE's but a different built-in;
			// here the database's RTRIM ignores *leading* spaces instead of trailing.
			const db = new Database();
			db.registerCollation('RTRIM', LTRIM);
			await db.exec('create table t (id integer primary key, tag text collate rtrim unique)');
			await db.exec("insert into t values (1, 'x')");

			// Trailing-space variant is distinct under LTRIM (the built-in would unify it).
			await db.exec("insert into t values (2, 'x  ')");
			// Leading-space variant collides under LTRIM (the built-in would not).
			let message = '';
			try { await db.exec("insert into t values (3, '  x')"); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/UNIQUE constraint failed/);

			expect(await column(db, 'select count(*) as n from t', 'n')).to.deep.equal([2]);
			await db.close();
		});
	});

	describe('composite primary key', () => {
		it('applies the overridden collation to a trailing key column', async () => {
			// The single-column PK path and the composite path build their comparators
			// separately (createSingleColumn… / createCompositeColumn…); only the latter
			// resolves a collation for a non-leading column.
			const db = new Database();
			db.registerCollation('NOCASE', REVERSE_NOCASE);
			await db.exec('create table t (a integer, b text collate nocase, primary key (a, b))');
			await db.exec("insert into t values (1,'a'), (1,'b'), (1,'c')");

			expect(await column(db, 'select b from t', 'b')).to.deep.equal(['c', 'b', 'a']);
			await db.close();
		});
	});

	describe('unregistered collation', () => {
		it('rejects an unregistered collation on an INTEGER column at DDL', async () => {
			// Since feat-ddl-accepts-registered-collations the type-list gate is
			// registry-aware, so a no-list type (INTEGER) no longer slides an unregistered
			// name through to the comparator: DDL rejects it up front with the same
			// `Unknown collation` shape a TEXT column gets, rather than the resolver's later
			// `no such collation sequence`.
			const db = new Database();
			let message = '';
			try { await db.exec('create table t (k integer collate frobnicate primary key)'); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/Unknown collation/);
			await db.close();
		});

		it('reports the DDL validation error first for a TEXT column', async () => {
			// Pinned by test/logic/102.1-unique-edge-cases.sqllogic: the type-level
			// "Unknown collation" message must not be pre-empted by the resolver's throw.
			const db = new Database();
			let message = '';
			try { await db.exec('create table t (id integer primary key, x text collate frobnicate)'); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/Unknown collation/);
			await db.close();
		});
	});

	describe('column DDL accepts a registered collation', () => {
		it('accepts a registered custom collation on a TEXT PK column and orders by it', async () => {
			// The headline (enables the deferred assertion from 3.3-memory-vtab-collation-resolver):
			// REVERSE is registered, so `text collate REVERSE primary key` is now accepted at DDL —
			// the type-list gate is registry-aware — and the primary BTree orders under the REVERSE
			// comparator, so a bare read comes back descending.
			const db = new Database();
			db.registerCollation('REVERSE', REVERSE);
			await db.exec('create table t (k text collate REVERSE primary key)');
			await db.exec("insert into t values ('a'), ('b'), ('c')");
			expect(await column(db, 'select k from t', 'k')).to.deep.equal(['c', 'b', 'a']);
			await db.close();
		});

		it('resolves case / whitespace variants of the registered name identically', async () => {
			// normalizeCollationName (trim + uppercase) runs both at the DDL gate and in the
			// registry, so every spelling reaches the same REVERSE comparator. The quoted form
			// exercises the parser's quote-stripping plus the gate's trim.
			for (const spell of ['reverse', 'REVERSE', '"  ReVeRsE "']) {
				const db = new Database();
				db.registerCollation('REVERSE', REVERSE);
				await db.exec(`create table t (k text collate ${spell} primary key)`);
				await db.exec("insert into t values ('a'), ('b'), ('c')");
				expect(await column(db, 'select k from t', 'k'), `spelling ${spell}`)
					.to.deep.equal(['c', 'b', 'a']);
				await db.close();
			}
		});

		it('still accepts a registered built-in (NOCASE) on an INTEGER column as a no-op', async () => {
			// NOCASE is registered, so it passes the registry gate on a no-list type (INTEGER);
			// it is a harmless no-op on a non-text column. Only UNREGISTERED names flip to reject.
			const db = new Database();
			await db.exec('create table t (k integer collate nocase primary key)');
			await db.exec('insert into t values (3), (1), (2)');
			expect(await column(db, 'select k from t', 'k')).to.deep.equal([1, 2, 3]);
			await db.close();
		});

		it('rejects a registered custom collation on a JSON column (empty-list precedence)', async () => {
			// JSON carries an EMPTY supportedCollations list, which precedes the registry: no
			// non-BINARY name is accepted, even one the connection registered.
			const db = new Database();
			db.registerCollation('REVERSE', REVERSE);
			let message = '';
			try { await db.exec('create table t (id integer primary key, x json collate REVERSE)'); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/Unknown collation/);
			await db.close();
		});

		it('accepts COLLATE BINARY on a JSON column (BINARY fast-path)', async () => {
			// BINARY is always accepted, ahead of the empty-list throw — a strict improvement
			// over the pre-fix behavior, which rejected even `collate binary` on JSON/temporal.
			const db = new Database();
			await db.exec('create table t (id integer primary key, x json collate binary)');
			await db.exec(`insert into t values (1, '{"a":1}')`);
			expect(await column(db, 'select count(*) as n from t', 'n')).to.deep.equal([1]);
			await db.close();
		});

		it('accepts SET COLLATE to a registered custom collation via ALTER', async () => {
			const db = new Database();
			db.registerCollation('REVERSE', REVERSE);
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec("insert into t values (1,'a'), (2,'b'), (3,'c')");
			await db.exec('alter table t alter column name set collate REVERSE');

			// table_info reports the new (normalized) collation …
			expect(await column(db, "select collation from table_info('t') where name = 'name'", 'collation'))
				.to.deep.equal(['REVERSE']);
			// … and ORDER BY name now follows REVERSE (descending).
			expect(await column(db, 'select name from t order by name', 'name')).to.deep.equal(['c', 'b', 'a']);
			await db.close();
		});

		it('rejects SET COLLATE to an unregistered collation via ALTER', async () => {
			const db = new Database();
			await db.exec('create table t (id integer primary key, name text)');
			let message = '';
			try { await db.exec('alter table t alter column name set collate frobnicate'); }
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/Unknown collation/);
			await db.close();
		});

		it('reopens a custom-collation column only when the collation is re-registered', async () => {
			// Reopen = replay the canonical CREATE DDL on a fresh connection. buildColumnSchemas is
			// the shared choke point for CREATE and catalog rehydrate (importTable), so replaying the
			// DDL validates against the registry exactly as a store reopen would: it SUCCEEDS once
			// REVERSE is re-registered, and THROWS `Unknown collation` when it is not — the same loud
			// failure the key-collation resolver seam already produces (see docs/schema.md).
			const ddl = 'create table t (k text collate REVERSE primary key)';

			const reopened = new Database();
			reopened.registerCollation('REVERSE', REVERSE);
			await reopened.exec(ddl); // re-registered → reopens cleanly
			await reopened.exec("insert into t values ('a'), ('b')");
			expect(await column(reopened, 'select k from t', 'k')).to.deep.equal(['b', 'a']);
			await reopened.close();

			const notRegistered = new Database();
			let message = '';
			try { await notRegistered.exec(ddl); } // no re-registration → loud reject
			catch (e) { message = (e as Error).message; }
			expect(message).to.match(/Unknown collation/);
			await notRegistered.close();
		});
	});
});
