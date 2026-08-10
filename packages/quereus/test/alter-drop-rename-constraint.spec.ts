/**
 * Memory-module-specific behaviour of `ALTER TABLE DROP/RENAME CONSTRAINT` and of
 * `ALTER TABLE RENAME COLUMN`'s effect on a UNIQUE's covering index.
 *
 * The cross-module behavioural surface (enforcement on/off, introspection names,
 * error cases) lives in `test/logic/41.6-alter-drop-rename-constraint.sqllogic` and
 * `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`, which run under both
 * memory and store. This file pins the bits that are MemoryTable-specific and have no
 * store analogue: the implicit covering index a UNIQUE auto-builds (named after the
 * constraint, or `_uc_<covered columns>` when it has no name) is torn down on DROP
 * CONSTRAINT, renamed in lock-step on RENAME CONSTRAINT, and — for the unnamed case,
 * whose name is derived from the columns — re-derived on RENAME COLUMN, so none of
 * the three leaves an orphan index in `tableSchema.indexes` (the in-memory
 * materialization).
 *
 * `index_info()` hides this structure while the constraint is hidden-implicit
 * (see `isHiddenImplicitIndex`), so it can't be used to observe the covering
 * index's lifecycle here — these assertions read the memory-specific
 * `TableSchema.indexes` array directly instead.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

function indexNames(db: Database, table: string): string[] {
	const tableSchema = db._findTable(table);
	return (tableSchema?.indexes ?? []).map(idx => idx.name).sort();
}

describe('ALTER TABLE DROP/RENAME CONSTRAINT (memory covering-index behaviour)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('DROP CONSTRAINT on a named inline UNIQUE tears down its implicit covering index', async () => {
		await db.exec('create table t (id integer primary key, email text, constraint uq_email unique (email))');

		// The auto-built covering index is named after the constraint.
		expect(indexNames(db, 't')).to.deep.equal(['uq_email']);

		await db.exec('alter table t drop constraint uq_email');

		// Constraint and its covering index are both gone.
		const ucs = await collect(db, `select count(*) as c from unique_constraint_info('t') where name = 'uq_email'`);
		expect(ucs[0].c).to.equal(0);
		expect(indexNames(db, 't'), 'covering index torn down').to.deep.equal([]);

		// Duplicate emails now allowed.
		await db.exec("insert into t values (1, 'a@x'), (2, 'a@x')");
		const cnt = await collect(db, 'select count(*) as c from t');
		expect(cnt[0].c).to.equal(2);
	});

	it('RENAME CONSTRAINT on a named inline UNIQUE renames the covering index in lock-step', async () => {
		await db.exec('create table t (id integer primary key, email text, constraint uq_email unique (email))');
		await db.exec("insert into t values (1, 'a@x')");

		await db.exec('alter table t rename constraint uq_email to uq_user_email');

		// The covering index follows the constraint name — no orphan under the old name.
		expect(indexNames(db, 't')).to.deep.equal(['uq_user_email']);
		const ucs = await collect(db, `select name from unique_constraint_info('t')`);
		expect(ucs.map(r => r.name)).to.deep.equal(['uq_user_email']);

		// Enforcement still active under the new name.
		let rejected = false;
		try { await db.exec("insert into t values (2, 'a@x')"); } catch { rejected = true; }
		expect(rejected, 'renamed UNIQUE still enforces').to.be.true;
	});

	it('RENAME then DROP a UNIQUE leaves no orphan index', async () => {
		await db.exec('create table t (id integer primary key, sku text, constraint uq_sku unique (sku))');
		await db.exec('alter table t rename constraint uq_sku to uq_product_sku');
		await db.exec('alter table t drop constraint uq_product_sku');
		expect(indexNames(db, 't'), 'no index survives the rename+drop').to.deep.equal([]);
	});

	it('dropping one UNIQUE leaves a sibling UNIQUE (and its index) intact', async () => {
		await db.exec('create table t (id integer primary key, a text, b text, constraint uq_a unique (a), constraint uq_b unique (b))');
		expect(indexNames(db, 't')).to.deep.equal(['uq_a', 'uq_b']);

		await db.exec('alter table t drop constraint uq_a');
		expect(indexNames(db, 't'), 'sibling index retained').to.deep.equal(['uq_b']);

		// uq_b still enforces.
		await db.exec("insert into t values (1, 'x', 'y')");
		let rejected = false;
		try { await db.exec("insert into t values (2, 'x2', 'y')"); } catch { rejected = true; }
		expect(rejected, 'surviving UNIQUE still enforces').to.be.true;
	});

	it('a refused UNIQUE declaration never leaves two indexes sharing a name', async () => {
		// `ensureUniqueConstraintIndexes` looks for a reusable covering index by COLUMNS,
		// so a constraint whose name is already an index over a DIFFERENT column used to
		// append a second entry under the same name. Reads then resolved by first match
		// and landed on the wrong structure (rows vanishing from one predicate,
		// multiplying on the other) while `schema()` showed neither. The declaration is
		// refused up front now; this pins the array shape the refusal preserves.
		await db.exec('create table t (id integer primary key, a text, b text)');
		await db.exec('create index foo on t (b)');
		await db.exec("insert into t values (1, 'x', 'p'), (2, 'y', 'q')");

		let err: Error | undefined;
		try { await db.exec('alter table t add constraint foo unique (a)'); } catch (e) { err = e as Error; }
		expect(err, 'expected rejection').to.not.be.undefined;
		expect(err!.message).to.match(/would collide with existing index 'foo'/i);

		// Exactly one `foo`, still the user's index on `b`.
		expect(indexNames(db, 't')).to.deep.equal(['foo']);
		const foo = db._findTable('t')!.indexes!.find(idx => idx.name === 'foo')!;
		expect(foo.columns.map(c => c.index), "index still keyed on 'b'").to.deep.equal([2]);

		// ...and it still resolves rows by that column.
		expect(await collect(db, "select id from t where b = 'q'")).to.deep.equal([{ id: 2 }]);
		expect(await collect(db, "select id from t where b = 'p'")).to.deep.equal([{ id: 1 }]);

		// No constraint was installed, so duplicates on `a` stay legal.
		await db.exec("insert into t values (3, 'x', 'r')");
		expect(await collect(db, "select count(*) as c from t where a = 'x'")).to.deep.equal([{ c: 2 }]);
	});

	it('a refused RENAME CONSTRAINT leaves both the constraint and the index in place', async () => {
		await db.exec('create table t (id integer primary key, a text, b text, constraint uq_a unique (a))');
		await db.exec('create index taken on t (b)');
		expect(indexNames(db, 't')).to.deep.equal(['taken', 'uq_a']);

		let err: Error | undefined;
		try { await db.exec('alter table t rename constraint uq_a to taken'); } catch (e) { err = e as Error; }
		expect(err, 'expected rejection').to.not.be.undefined;
		expect(err!.message).to.match(/would collide with existing index 'taken'/i);

		expect(indexNames(db, 't'), 'neither index moved').to.deep.equal(['taken', 'uq_a']);
	});

	it("RENAME COLUMN re-derives an unnamed UNIQUE's covering index name", async () => {
		// `_uc_<cols>` is computed from the columns' CURRENT names every time it is needed
		// and recorded nowhere, so a rename moves it. Left behind under the old name the
		// entry stops being recognized as the constraint's structure: it surfaces in
		// `schema()` / `index_info()` as a user index and `DROP INDEX` deletes it.
		await db.exec('create table t (id integer primary key, a text, b text, unique (a))');
		expect(indexNames(db, 't')).to.deep.equal(['_uc_a']);

		await db.exec('alter table t rename column a to z');

		expect(indexNames(db, 't'), 'covering index follows the column').to.deep.equal(['_uc_z']);
		const covering = db._findTable('t')!.indexes!.find(idx => idx.name === '_uc_z')!;
		expect(covering.columns.map(c => c.index), 'still keyed on the renamed column').to.deep.equal([1]);

		// Enforcement survives the rename, under the new column name.
		await db.exec("insert into t values (1, 'x', 'p')");
		let rejected = false;
		try { await db.exec("insert into t values (2, 'x', 'q')"); } catch { rejected = true; }
		expect(rejected, 'renamed UNIQUE still enforces').to.be.true;
	});

	it('a refused RENAME COLUMN leaves the column name and both index entries in place', async () => {
		await db.exec('create table t (id integer primary key, a text, b text, unique (a))');
		await db.exec('create index _uc_z on t (b)');
		expect(indexNames(db, 't')).to.deep.equal(['_uc_a', '_uc_z']);

		let err: Error | undefined;
		try { await db.exec('alter table t rename column a to z'); } catch (e) { err = e as Error; }
		expect(err, 'expected rejection').to.not.be.undefined;
		expect(err!.message).to.match(/would collide with existing index '_uc_z'/i);

		expect(indexNames(db, 't'), 'neither index moved').to.deep.equal(['_uc_a', '_uc_z']);
		expect(db._findTable('t')!.columns.map(c => c.name), 'column keeps its old name')
			.to.deep.equal(['id', 'a', 'b']);
	});

	it('a CREATE UNIQUE INDEX-derived constraint cannot be dropped via DROP CONSTRAINT', async () => {
		await db.exec('create table t (id integer primary key, a integer)');
		await db.exec('create unique index uq_a on t (a)');

		let err: Error | undefined;
		try { await db.exec('alter table t drop constraint uq_a'); } catch (e) { err = e as Error; }
		expect(err, 'expected rejection').to.not.be.undefined;
		expect(err!.message).to.match(/backed by index/i);

		// The index (and its enforcement) survive the rejected drop.
		expect(indexNames(db, 't')).to.deep.equal(['uq_a']);
	});
});
