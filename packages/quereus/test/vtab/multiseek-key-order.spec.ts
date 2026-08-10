/**
 * Regression: bug-isolation-multiseek-merge-order.
 *
 * A `multiSeek` access path (`plan=5`, e.g. `WHERE pk IN (3, 1, 2)`) must emit
 * rows in the SCANNED STRUCTURE's own key order, not the order the seek values
 * appear in the SQL text. `quereus-isolation`'s merge (`mergeStreams` /
 * `mergedSecondaryIndexQuery`) assumes the underlying stream arrives in that
 * order — an out-of-order underlying stream mis-pairs staged rows with stored
 * ones (see the isolation package's `key-set-seek-merge.spec.ts`).
 *
 * These tests pin the contract at its source: a bare `MemoryTableModule`
 * (no isolation layer involved) must itself serve a multi-seek in ascending
 * (or, for a DESC key, descending) index-key order. None of these queries
 * carry an `ORDER BY`, so nothing downstream re-sorts the result — the row
 * order observed here IS the scan's emission order.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

async function evalRows(
	db: Database,
	sql: string,
	params?: SqlValue[],
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql, params)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('multi-seek emission order (bug-isolation-multiseek-merge-order)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('serves an ascending-PK multi-seek in ascending key order, not seek-argument order', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
		const rows = await evalRows(db, 'select id, v from t where id in (3, 1, 2)');
		expect(rows).to.deep.equal([
			{ id: 1, v: 'a' },
			{ id: 2, v: 'b' },
			{ id: 3, v: 'c' },
		]);
	});

	it('serves a DESC-PK multi-seek in descending key order', async () => {
		await db.exec('create table td (id integer, v text, primary key (id desc))');
		await db.exec("insert into td values (1, 'a'), (2, 'b'), (3, 'c')");
		const rows = await evalRows(db, 'select id, v from td where id in (1, 3, 2)');
		expect(rows).to.deep.equal([
			{ id: 3, v: 'c' },
			{ id: 2, v: 'b' },
			{ id: 1, v: 'a' },
		]);
	});

	it('serves a composite-PK multi-seek (cross-product) in ascending tuple key order', async () => {
		await db.exec('create table tc (a integer, b integer, v text, primary key (a, b))');
		await db.exec("insert into tc values (1, 1, 'x'), (2, 1, 'y'), (3, 1, 'z')");
		const rows = await evalRows(db, 'select a, b, v from tc where a in (3, 1, 2) and b = 1');
		expect(rows).to.deep.equal([
			{ a: 1, b: 1, v: 'x' },
			{ a: 2, b: 1, v: 'y' },
			{ a: 3, b: 1, v: 'z' },
		]);
	});

	it('serves an ascending secondary-index multi-seek in ascending index-key order', async () => {
		await db.exec('create table s (id integer primary key, k integer)');
		await db.exec('create index idx_k on s (k)');
		await db.exec('insert into s values (1, 30), (2, 10), (3, 20)');
		const rows = await evalRows(db, 'select id, k from s where k in (30, 10, 20)');
		expect(rows).to.deep.equal([
			{ id: 2, k: 10 },
			{ id: 3, k: 20 },
			{ id: 1, k: 30 },
		]);
	});

	// The sort keys off the built seek keys, not off how they were written, so these two
	// non-literal sources of the same plan must order identically. `rule-select-access-path`
	// reaches the multi-seek from either an `IN` list or a collapsed `OR` chain, and the
	// key values can arrive as runtime parameters rather than literals.
	it('serves a parameter-bound multi-seek in ascending key order', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
		const rows = await evalRows(db, 'select id, v from t where id in (?, ?, ?)', [3, 1, 2]);
		expect(rows).to.deep.equal([
			{ id: 1, v: 'a' },
			{ id: 2, v: 'b' },
			{ id: 3, v: 'c' },
		]);
	});

	it('serves an OR-collapsed multi-seek in ascending key order', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
		const rows = await evalRows(db, 'select id, v from t where id = 3 or id = 1 or id = 2');
		expect(rows).to.deep.equal([
			{ id: 1, v: 'a' },
			{ id: 2, v: 'b' },
			{ id: 3, v: 'c' },
		]);
	});

	it('serves a DESC secondary-index multi-seek in descending index-key order', async () => {
		await db.exec('create table sd (id integer primary key, k integer)');
		await db.exec('create index idx_kd on sd (k desc)');
		await db.exec('insert into sd values (1, 30), (2, 10), (3, 20)');
		const rows = await evalRows(db, 'select id, k from sd where k in (10, 30, 20)');
		expect(rows).to.deep.equal([
			{ id: 1, k: 30 },
			{ id: 3, k: 20 },
			{ id: 2, k: 10 },
		]);
	});
});
