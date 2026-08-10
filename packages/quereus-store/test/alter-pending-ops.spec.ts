/**
 * Row-rewriting ALTER TABLE vs. the module's buffered writes.
 *
 * `ADD COLUMN`, `DROP COLUMN`, `ALTER PRIMARY KEY`, `SET COLLATE` on a PK member,
 * `SET DATA TYPE` across physical representations, and a backfilling `SET NOT NULL`
 * all rewrite the stored rows in place, reading and writing the committed
 * store directly. The transaction coordinator's buffered ops are `(keyBytes,
 * valueBytes)` pairs encoded under the PRE-ALTER schema, so replaying them over a
 * rewritten store corrupts, loses, or misfiles the rows. Each arm therefore
 * DDL-commits the module-wide transaction before its first physical write.
 *
 * These tests pin both halves of that posture: rows written earlier in the same
 * open transaction survive the rewrite correctly, and a `rollback` after the
 * ALTER does not restore them (the transaction is gone).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};

	return {
		async getStore(schemaName: string, tableName: string) {
			return get(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return get(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return get(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return get('__catalog__');
		},
		async closeStore() { /* no-op for in-memory stores */ },
		async closeIndexStore() { /* no-op for in-memory stores */ },
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

describe('Store ALTER TABLE with pending transaction ops', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('ALTER PRIMARY KEY', () => {
		it('re-keys a row inserted earlier in the same transaction', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`insert into t values (1, 10)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 20)`);
			await db.exec(`alter table t alter primary key (b)`);
			await db.exec(`commit`);

			// A full scan hides the orphan: the row would still be present under its
			// stale `a`-keyed bytes. Only a point lookup on the NEW key proves it moved.
			expect(await db.get(`select a, b from t where b = 20`))
				.to.deep.equal({ a: 2, b: 20 });
			expect(await db.get(`select a, b from t where b = 10`))
				.to.deep.equal({ a: 1, b: 10 });
			expect(await asyncIterableToArray(db.eval(`select a from t`))).to.have.lengthOf(2);
		});

		it('honors a delete issued earlier in the same transaction', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`insert into t values (1, 10), (2, 20)`);

			await db.exec(`begin`);
			await db.exec(`delete from t where a = 1`);
			await db.exec(`alter table t alter primary key (b)`);
			await db.exec(`commit`);

			expect(await asyncIterableToArray(db.eval(`select a, b from t order by b`)))
				.to.deep.equal([{ a: 2, b: 20 }]);
		});

		it('rejects a pending insert that duplicates the new primary key', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`insert into t values (1, 10)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 10)`);
			// The duplicate-key pass must SEE the pending row — hence the DDL-commit
			// precedes it, and this CONSTRAINT arrives with the transaction flushed.
			try {
				await db.exec(`alter table t alter primary key (b)`);
				expect.fail('expected a CONSTRAINT error');
			} catch (e) {
				expect(String(e)).to.match(/UNIQUE constraint failed/i);
			}

			// The store is left unmutated: both rows survive under the ORIGINAL key.
			expect(await asyncIterableToArray(db.eval(`select a, b from t order by a`)))
				.to.deep.equal([{ a: 1, b: 10 }, { a: 2, b: 10 }]);
		});

		it('rebuilds a secondary index over rows pending at ALTER time', async () => {
			await db.exec(`create table t (a integer primary key, b integer, c text) using store`);
			await db.exec(`create index t_c on t (c)`);
			await db.exec(`insert into t values (1, 10, 'x')`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 20, 'y')`);
			await db.exec(`alter table t alter primary key (b)`);
			await db.exec(`commit`);

			// Resolved through the rebuilt index, whose keys embed the NEW PK suffix.
			expect(await db.get(`select a, b from t where c = 'y'`))
				.to.deep.equal({ a: 2, b: 20 });
		});
	});

	describe('ALTER COLUMN ... SET COLLATE on a PK member', () => {
		// The store's default key collation is already NOCASE, so `set collate nocase`
		// changes no key bytes and re-keys nothing. `binary` forces a real re-key.
		it('honors a pending delete of an upper-case key', async () => {
			await db.exec(`create table t (id text primary key, v integer) using store`);
			await db.exec(`insert into t values ('A', 1)`);

			await db.exec(`begin`);
			await db.exec(`delete from t where id = 'A'`);
			await db.exec(`alter table t alter column id set collate binary`);
			await db.exec(`commit`);

			expect(await asyncIterableToArray(db.eval(`select id from t`))).to.deep.equal([]);
		});

		it('re-keys a row inserted earlier in the same transaction', async () => {
			await db.exec(`create table t (id text primary key, v integer) using store`);
			await db.exec(`insert into t values ('a', 1)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values ('B', 2)`);
			await db.exec(`alter table t alter column id set collate binary`);
			await db.exec(`commit`);

			// Under BINARY keys, 'B' is addressable case-sensitively and 'b' is absent.
			expect(await db.get(`select id, v from t where id = 'B'`))
				.to.deep.equal({ id: 'B', v: 2 });
			expect(await db.get(`select id, v from t where id = 'b'`)).to.equal(undefined);
		});
	});

	describe('ADD COLUMN', () => {
		it('gives the new column to a row inserted earlier in the same transaction', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`insert into t values (1, 10)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 20)`);
			await db.exec(`alter table t add column w integer default 7`);
			await db.exec(`commit`);

			// Without the DDL-commit, row 2's buffered bytes replay in the old 2-column
			// layout and it comes back missing `w`.
			expect(await asyncIterableToArray(db.eval(`select a, b, w from t order by a`)))
				.to.deep.equal([{ a: 1, b: 10, w: 7 }, { a: 2, b: 20, w: 7 }]);
		});

		it('honors a pending delete when backfilling', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`insert into t values (1, 10), (2, 20)`);

			await db.exec(`begin`);
			await db.exec(`delete from t where a = 1`);
			await db.exec(`alter table t add column w integer default 7`);
			await db.exec(`commit`);

			expect(await asyncIterableToArray(db.eval(`select a, b, w from t order by a`)))
				.to.deep.equal([{ a: 2, b: 20, w: 7 }]);
		});

		it('rejects NOT NULL without a default when the only rows are pending', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 10)`);
			// The emptiness probe reads effectively, so it sees the pending row and
			// throws BEFORE the DDL-commit — the transaction stays alive and rolls back.
			try {
				await db.exec(`alter table t add column w integer not null`);
				expect.fail('expected a CONSTRAINT error');
			} catch (e) {
				expect(String(e)).to.match(/without a DEFAULT|NOT NULL/i);
			}
			await db.exec(`rollback`);

			expect(await asyncIterableToArray(db.eval(`select a from t`))).to.deep.equal([]);
		});

		it('allows NOT NULL without a default when the only row is pending-deleted', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`insert into t values (1, 10)`);

			await db.exec(`begin`);
			await db.exec(`delete from t where a = 1`);
			await db.exec(`alter table t add column w integer not null`);
			await db.exec(`commit`);

			await db.exec(`insert into t values (2, 20, 30)`);
			expect(await asyncIterableToArray(db.eval(`select a, b, w from t`)))
				.to.deep.equal([{ a: 2, b: 20, w: 30 }]);
		});
	});

	describe('DROP COLUMN', () => {
		it('does not resurrect the dropped column on a row pending at ALTER time', async () => {
			await db.exec(`create table t (a integer primary key, b integer, w integer) using store`);
			await db.exec(`insert into t values (1, 10, 100)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 20, 200)`);
			await db.exec(`alter table t drop column w`);
			await db.exec(`commit`);

			// A stale 3-column value replaying over the 2-column layout surfaces the
			// third slot as a phantom `col_2`.
			const rows = await asyncIterableToArray(db.eval(`select * from t order by a`));
			expect(rows).to.deep.equal([{ a: 1, b: 10 }, { a: 2, b: 20 }]);
		});

		it('honors a pending delete', async () => {
			await db.exec(`create table t (a integer primary key, b integer, w integer) using store`);
			await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);

			await db.exec(`begin`);
			await db.exec(`delete from t where a = 1`);
			await db.exec(`alter table t drop column w`);
			await db.exec(`commit`);

			expect(await asyncIterableToArray(db.eval(`select * from t`)))
				.to.deep.equal([{ a: 2, b: 20 }]);
		});
	});

	describe('ALTER COLUMN ... SET NOT NULL', () => {
		it('backfills a NULL written earlier in the same transaction', async () => {
			await db.exec(`create table t (a integer primary key, c integer null default 9) using store`);
			await db.exec(`insert into t values (1, null)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, null)`);
			await db.exec(`alter table t alter column c set not null`);
			await db.exec(`commit`);

			// Without the DDL-commit, row 2's buffered NULL replays over the backfilled
			// store and lands a NULL in a NOT NULL column.
			expect(await asyncIterableToArray(db.eval(`select a, c from t order by a`)))
				.to.deep.equal([{ a: 1, c: 9 }, { a: 2, c: 9 }]);
		});

		it('rejects a NULL written earlier in the same transaction when there is no default', async () => {
			await db.exec(`create table t (a integer primary key, c integer null) using store`);
			await db.exec(`insert into t values (1, 5)`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, null)`);
			// The NULL probe reads effectively, so it sees the pending row and throws
			// BEFORE the DDL-commit — the transaction stays alive and rolls back.
			try {
				await db.exec(`alter table t alter column c set not null`);
				expect.fail('expected a CONSTRAINT error');
			} catch (e) {
				expect(String(e)).to.match(/contains NULL values/i);
			}
			await db.exec(`rollback`);

			expect(await asyncIterableToArray(db.eval(`select a, c from t`)))
				.to.deep.equal([{ a: 1, c: 5 }]);
		});

		it('honors a pending delete of the only NULL row', async () => {
			await db.exec(`create table t (a integer primary key, c integer null) using store`);
			await db.exec(`insert into t values (1, 5), (2, null)`);

			await db.exec(`begin`);
			await db.exec(`delete from t where a = 2`);
			// No live NULL remains, so the tightening needs no backfill — and therefore
			// never DDL-commits. The delete is still an ordinary buffered op at commit.
			await db.exec(`alter table t alter column c set not null`);
			await db.exec(`commit`);

			expect(await asyncIterableToArray(db.eval(`select a, c from t`)))
				.to.deep.equal([{ a: 1, c: 5 }]);
		});
	});

	describe('ALTER COLUMN ... SET DATA TYPE', () => {
		it('converts a value written earlier in the same transaction', async () => {
			await db.exec(`create table t (a integer primary key, c text) using store`);
			await db.exec(`insert into t values (1, '5')`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, '7')`);
			await db.exec(`alter table t alter column c set data type integer`);
			await db.exec(`commit`);

			// Without the DDL-commit, row 2's buffered bytes replay with `c` still a
			// TEXT '7' — the column's physical type is no longer uniform.
			const rows = await asyncIterableToArray(db.eval(`select a, c from t order by a`));
			expect(rows).to.deep.equal([{ a: 1, c: 5 }, { a: 2, c: 7 }]);
			expect(rows.map(r => typeof (r as { c: unknown }).c)).to.deep.equal(['number', 'number']);
		});

		it('rejects an unconvertible value written earlier in the same transaction', async () => {
			await db.exec(`create table t (a integer primary key, c text) using store`);
			await db.exec(`insert into t values (1, '5')`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'nope')`);
			// The convertibility probe reads effectively and throws before the
			// DDL-commit, so the transaction survives and rolls back.
			try {
				await db.exec(`alter table t alter column c set data type integer`);
				expect.fail('expected a MISMATCH error');
			} catch (e) {
				expect(String(e)).to.match(/Cannot convert value/i);
			}
			await db.exec(`rollback`);

			expect(await asyncIterableToArray(db.eval(`select a, c from t`)))
				.to.deep.equal([{ a: 1, c: '5' }]);
		});

		it('honors a pending delete of the only unconvertible row', async () => {
			await db.exec(`create table t (a integer primary key, c text) using store`);
			await db.exec(`insert into t values (1, '5'), (2, 'nope')`);

			await db.exec(`begin`);
			await db.exec(`delete from t where a = 2`);
			await db.exec(`alter table t alter column c set data type integer`);
			await db.exec(`commit`);

			expect(await asyncIterableToArray(db.eval(`select a, c from t`)))
				.to.deep.equal([{ a: 1, c: 5 }]);
		});
	});

	describe('DDL-commit posture', () => {
		// Each rewriting arm flushes the module-wide transaction before touching
		// storage, so a later `rollback` cannot restore the pre-ALTER rows. These
		// pin the documented behavior — changing it should be a deliberate test edit.
		const arms: ReadonlyArray<{ name: string; ddl: string }> = [
			{ name: 'ADD COLUMN', ddl: `alter table t add column w integer default 7` },
			{ name: 'DROP COLUMN', ddl: `alter table t drop column c` },
			{ name: 'ALTER PRIMARY KEY', ddl: `alter table t alter primary key (b)` },
			{ name: 'SET DATA TYPE', ddl: `alter table t alter column b set data type text` },
		];

		for (const arm of arms) {
			it(`${arm.name} commits pending ops; a later rollback does not restore them`, async () => {
				await db.exec(`create table t (a integer primary key, b integer, c text) using store`);

				await db.exec(`begin`);
				await db.exec(`insert into t values (1, 10, 'x')`);
				await db.exec(arm.ddl);
				await db.exec(`rollback`);

				expect(await asyncIterableToArray(db.eval(`select a from t`)))
					.to.deep.equal([{ a: 1 }]);
			});
		}

		it('SET NOT NULL commits pending ops when it backfills; a later rollback does not restore them', async () => {
			await db.exec(`create table t (a integer primary key, c integer null default 9) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`alter table t alter column c set not null`);
			await db.exec(`rollback`);

			expect(await asyncIterableToArray(db.eval(`select a, c from t`)))
				.to.deep.equal([{ a: 1, c: 9 }]);
		});

		it('SET NOT NULL stays inside the transaction when no live row is NULL', async () => {
			await db.exec(`create table t (a integer primary key, c integer null) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 5)`);
			// Nothing to backfill, so nothing is rewritten and nothing is flushed.
			await db.exec(`alter table t alter column c set not null`);
			await db.exec(`rollback`);

			expect(await asyncIterableToArray(db.eval(`select a from t`))).to.deep.equal([]);
		});

		it('commits a sibling table\'s pending ops too (the coordinator is module-wide)', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);
			await db.exec(`create table sibling (k integer primary key) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into sibling values (99)`);
			await db.exec(`alter table t add column w integer default 7`);
			await db.exec(`rollback`);

			expect(await asyncIterableToArray(db.eval(`select k from sibling`)))
				.to.deep.equal([{ k: 99 }]);
		});

		it('leaves a non-rewriting ALTER inside the transaction', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 10)`);
			await db.exec(`alter table t rename column b to b2`);
			await db.exec(`rollback`);

			// RENAME COLUMN writes no rows, so it never DDL-commits: the insert rolls back.
			expect(await asyncIterableToArray(db.eval(`select a from t`))).to.deep.equal([]);
		});
	});
});
