/**
 * Regression tests for DROP COLUMN's shift/prune order on secondary indexes.
 *
 * The defect: when a column immediately preceding an indexed column is dropped,
 * the indexed column was shifted into the dropped slot *before* the prune pass,
 * causing the prune to remove the wrong (surviving) column.  The fix reverses
 * the order: filter the dropped column first, then shift the survivors down.
 *
 * Assertion surface: `index_info('<table>')` — one row per (index, column) pair.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

async function indexColumns(db: Database, table: string, indexName: string): Promise<string[]> {
	const rows = await collect(
		db,
		`select column_name from index_info('${table}') where index_name = '${indexName}' order by seq`,
	);
	return rows.map(r => String(r.column_name));
}

async function indexNames(db: Database, table: string): Promise<string[]> {
	const rows = await collect(db, `select distinct index_name from index_info('${table}')`);
	return rows.map(r => String(r.index_name)).sort();
}

describe('ALTER TABLE DROP COLUMN — index shift/prune order', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('preserves all columns of an index when the dropped column precedes them', async () => {
		// colIndex layout: a=0, b=1, c=2, d=3.  idx_cd covers [2,3].
		// Dropping b (colIndex=1) should leave idx_cd covering [c, d] (shifted to [1, 2]).
		await db.exec('create table t (a integer, b integer, c integer, d integer, primary key (a))');
		await db.exec('create index idx_cd on t (c, d)');

		await db.exec('alter table t drop column b');

		expect(await indexColumns(db, 't', 'idx_cd'), 'idx_cd must still cover c and d').to.deep.equal(['c', 'd']);
	});

	it('prunes the dropped column from a multi-column index that spans it', async () => {
		// colIndex layout: a=0, b=1, c=2, d=3.  idx_bcd covers [1,2,3].
		// Dropping b prunes b from the index; c and d survive (shifted to [1,2]).
		await db.exec('create table t (a integer, b integer, c integer, d integer, primary key (a))');
		await db.exec('create index idx_bcd on t (b, c, d)');

		await db.exec('alter table t drop column b');

		expect(await indexColumns(db, 't', 'idx_bcd'), 'idx_bcd must retain c and d after b pruned').to.deep.equal(['c', 'd']);
	});

	it('removes a single-column index whose only column is dropped', async () => {
		// idx_b covers only b; after dropping b the index must vanish entirely.
		await db.exec('create table t (a integer, b integer, c integer, primary key (a))');
		await db.exec('create index idx_b on t (b)');

		await db.exec('alter table t drop column b');

		expect(await indexNames(db, 't'), 'idx_b must be removed entirely').to.deep.equal([]);
	});

	it('leaves indexes that are entirely above the dropped column unaffected', async () => {
		// Dropping the first non-PK column should not disturb an index on later columns.
		// colIndex layout: a=0, b=1, c=2.  drop b; idx_c covers only c (shifted 2→1).
		await db.exec('create table t (a integer, b integer, c integer, primary key (a))');
		await db.exec('create index idx_c on t (c)');

		await db.exec('alter table t drop column b');

		expect(await indexColumns(db, 't', 'idx_c'), 'idx_c must still cover c').to.deep.equal(['c']);
	});

	it('preserves the desc flag of a surviving column shifted past the dropped one', async () => {
		// The shift remaps `ic.index` via a `{ ...ic }` spread; a regression that
		// reconstructs the column descriptor instead of spreading would silently drop
		// the `desc` (and `collation`) flags. Guard the spread directly: idx_cd has a
		// DESC leading column; after dropping the preceding b it must stay DESC.
		await db.exec('create table t (a integer, b integer, c integer, d integer, primary key (a))');
		await db.exec('create index idx_cd on t (c desc, d)');

		await db.exec('alter table t drop column b');

		const rows = await collect(
			db,
			`select column_name, "desc" from index_info('t') where index_name = 'idx_cd' order by seq`,
		);
		expect(rows.map(r => [String(r.column_name), Number(r.desc)]), 'idx_cd keeps c DESC, d ASC after the shift')
			.to.deep.equal([['c', 1], ['d', 0]]);
	});

	it('handles multiple indexes simultaneously, each shifted correctly', async () => {
		// Two indexes spanning the same dropped column.
		await db.exec('create table t (a integer, b integer, c integer, d integer, primary key (a))');
		await db.exec('create index idx_cd on t (c, d)');
		await db.exec('create index idx_bc on t (b, c)');

		await db.exec('alter table t drop column b');

		// idx_cd: b not in it, both c and d survive
		expect(await indexColumns(db, 't', 'idx_cd'), 'idx_cd untouched by b drop').to.deep.equal(['c', 'd']);
		// idx_bc: b pruned, c survives shifted
		expect(await indexColumns(db, 't', 'idx_bc'), 'idx_bc retains only c').to.deep.equal(['c']);
	});
});
