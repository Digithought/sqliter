/**
 * Memory-module-specific behaviour of `ALTER TABLE DROP/RENAME CONSTRAINT`.
 *
 * The cross-module behavioural surface (enforcement on/off, introspection names,
 * error cases) lives in `test/logic/41.6-alter-drop-rename-constraint.sqllogic`,
 * which runs under both memory and store. This file pins the bits that are
 * MemoryTable-specific and have no store analogue: the implicit covering index a
 * named inline UNIQUE auto-builds (named after the constraint) is torn down on
 * DROP CONSTRAINT and renamed in lock-step on RENAME CONSTRAINT — so neither
 * leaves an orphan index in `tableSchema.indexes` (the in-memory materialization).
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
