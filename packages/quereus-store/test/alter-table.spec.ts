/**
 * Tests for ALTER TABLE operations on store-backed tables.
 *
 * Validates eager row migration for ADD/DROP COLUMN and
 * schema-only updates for RENAME COLUMN.
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

	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {
			// No-op for in-memory stores
		},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {
			// No-op for in-memory stores
		},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
		async renameTableStores(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]) {
			const oldKey = `${schemaName}.${oldName}`;
			const newKey = `${schemaName}.${newName}`;
			const dataStore = stores.get(oldKey);
			if (dataStore) {
				stores.delete(oldKey);
				stores.set(newKey, dataStore);
			}
			// Relocate exactly the table's index stores (by name), matching real
			// provider semantics — a `{oldName}_idx_` prefix sweep would also move a
			// sibling table named `{oldName}_idx_<x>`.
			for (const indexName of indexNames) {
				const from = `${schemaName}.${oldName}_idx_${indexName}`;
				const store = stores.get(from);
				if (store) {
					stores.delete(from);
					stores.set(`${schemaName}.${newName}_idx_${indexName}`, store);
				}
			}
		},
	};
}

describe('Store ALTER TABLE', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		const storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('ADD COLUMN', () => {
		it('adds a column to a populated table with null default', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);
			await db.exec(`INSERT INTO items VALUES (2, 'Gadget')`);

			await db.exec(`ALTER TABLE items ADD COLUMN price REAL NULL`);

			const rows = await asyncIterableToArray(db.eval('select id, name, price from items order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, name: 'Widget', price: null });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'Gadget', price: null });
		});

		it('adds a column with a DEFAULT value', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			await db.exec(`ALTER TABLE items ADD COLUMN active INTEGER DEFAULT 1`);

			const row = await db.get('select * from items where id = 1');
			expect(row?.active).to.equal(1);
		});

		it('new inserts include the added column', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Old')`);

			await db.exec(`ALTER TABLE items ADD COLUMN color TEXT NULL`);
			await db.exec(`INSERT INTO items VALUES (2, 'New', 'red')`);

			const rows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(rows[0]).to.deep.equal({ id: 1, name: 'Old', color: null });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'New', color: 'red' });
		});

		it('adds a column to an empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items ADD COLUMN extra TEXT`);
			await db.exec(`INSERT INTO items VALUES (1, 'test', 'val')`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'test', extra: 'val' });
		});

		it('allows NOT NULL without DEFAULT on an empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items ADD COLUMN rank INTEGER NOT NULL`);
			await db.exec(`INSERT INTO items VALUES (1, 'Alice', 10)`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Alice', rank: 10 });
		});

		it('refuses NOT NULL without DEFAULT on a non-empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Alice')`);

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE items ADD COLUMN rank INTEGER NOT NULL`);
			} catch (e) {
				caught = e;
			}

			expect(caught).to.be.instanceOf(Error);
			const message = (caught as Error).message;
			expect(message).to.include(`'rank'`);
			expect(message).to.include('main.items');
			expect(message).to.not.include('__rekey_');
		});

		it('allows NOT NULL with literal DEFAULT on a non-empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Alice')`);

			await db.exec(`ALTER TABLE items ADD COLUMN score INTEGER NOT NULL DEFAULT 0`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Alice', score: 0 });
		});
	});

	describe('DROP COLUMN', () => {
		it('drops a non-PK column from a populated table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT,
					description TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget', 'A fine widget')`);
			await db.exec(`INSERT INTO items VALUES (2, 'Gadget', 'A cool gadget')`);

			await db.exec(`ALTER TABLE items DROP COLUMN description`);

			const rows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, name: 'Widget' });
			expect(rows[1]).to.deep.equal({ id: 2, name: 'Gadget' });
		});

		it('drops a column from an empty table', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT,
					extra TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items DROP COLUMN extra`);
			await db.exec(`INSERT INTO items VALUES (1, 'test')`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'test' });
		});

		it('preserves PK lookups after dropping a column', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					a TEXT,
					b TEXT,
					c TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'x', 'y', 'z')`);

			await db.exec(`ALTER TABLE items DROP COLUMN b`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, a: 'x', c: 'z' });
		});

		it('preserves PK when dropping a column before the PK', async () => {
			await db.exec(`
				CREATE TABLE items (
					label TEXT,
					id INTEGER,
					extra TEXT,
					PRIMARY KEY(id)
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES ('Widget', 1, 'x')`);
			await db.exec(`INSERT INTO items VALUES ('Gadget', 2, 'y')`);

			await db.exec(`ALTER TABLE items DROP COLUMN label`);

			const rows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, extra: 'x' });
			expect(rows[1]).to.deep.equal({ id: 2, extra: 'y' });

			// Inserts after drop must use the PK correctly (not overwrite each other)
			await db.exec(`INSERT INTO items VALUES (3, 'z')`);
			await db.exec(`INSERT INTO items VALUES (4, 'w')`);
			const allRows = await asyncIterableToArray(db.eval('select * from items order by id'));
			expect(allRows).to.have.lengthOf(4);
		});
	});

	describe('RENAME COLUMN', () => {
		it('renames a column preserving data', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			await db.exec(`ALTER TABLE items RENAME COLUMN name TO title`);

			const row = await db.get('select id, title from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Widget' });
		});

		it('allows inserts using the new column name', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			await db.exec(`ALTER TABLE items RENAME COLUMN name TO title`);
			await db.exec(`INSERT INTO items (id, title) VALUES (1, 'Test')`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Test' });
		});
	});

	describe('RENAME TABLE', () => {
		it('renames a populated table and preserves data', async () => {
			await db.exec(`
				CREATE TABLE t_rename (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);

			const rows = await asyncIterableToArray(db.eval('select * from t_renamed order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, val: 'a' });
			expect(rows[1]).to.deep.equal({ id: 2, val: 'b' });
		});

		it('allows inserts under the new name after rename', async () => {
			await db.exec(`
				CREATE TABLE t_rename (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a')`);

			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);
			await db.exec(`INSERT INTO t_renamed VALUES (2, 'b')`);

			const rows = await asyncIterableToArray(db.eval('select * from t_renamed order by id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]).to.deep.equal({ id: 1, val: 'a' });
			expect(rows[1]).to.deep.equal({ id: 2, val: 'b' });
		});

		it('rejects renaming the old name after rename', async () => {
			await db.exec(`
				CREATE TABLE t_rename (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store
			`);
			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);

			let caught: unknown = null;
			try {
				await db.exec(`SELECT * FROM t_rename`);
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(Error);
		});

		it('rejects rename to an existing table', async () => {
			await db.exec(`
				CREATE TABLE t_a (id INTEGER PRIMARY KEY) USING store
			`);
			await db.exec(`
				CREATE TABLE t_b (id INTEGER PRIMARY KEY) USING store
			`);

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE t_a RENAME TO t_b`);
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(Error);
			expect((caught as Error).message).to.match(/already exists/i);
		});

		it('rewrites the persistent catalog DDL under the new name', async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store_rename_ddl', storeModule);

			await db.exec(`
				CREATE TABLE t_before (
					id INTEGER PRIMARY KEY,
					val TEXT
				) USING store_rename_ddl
			`);
			await db.exec(`ALTER TABLE t_before RENAME TO t_after`);

			const ddlStatements = await storeModule.loadAllDDL();
			expect(ddlStatements).to.have.lengthOf(1);
			expect(ddlStatements[0].toLowerCase()).to.include('t_after');
			expect(ddlStatements[0].toLowerCase()).to.not.include('t_before');
		});

		it('rename inside a savepoint does not throw on rollback-to (DDL-commits posture)', async () => {
			// renameTable commits the coordinator mid-transaction (DDL-commits posture),
			// clearing the savepoint stack. The engine still broadcasts rollback-to-s1
			// after the rename, which must warn-and-return rather than throw.
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`BEGIN`);
			await db.exec(`SAVEPOINT s1`);
			await db.exec(`INSERT INTO t VALUES (3, 'c')`);
			await db.exec(`ALTER TABLE t RENAME TO t2`); // DDL-commits: commits insert + clears stack
			await db.exec(`ROLLBACK TO s1`);             // must not throw; warn-and-return
			await db.exec(`COMMIT`);

			// The rename persisted (DDL-commits semantics); data is accessible under the new name.
			const result = await asyncIterableToArray(db.eval('select id, val from t2 order by id'));
			expect(result.length).to.be.at.least(2);
			expect(result[0]).to.deep.equal({ id: 1, val: 'a' });
			expect(result[1]).to.deep.equal({ id: 2, val: 'b' });
		});
	});

	describe('sequential ALTER TABLE operations', () => {
		it('handles add, rename, then drop in sequence', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			// Add a column
			await db.exec(`ALTER TABLE items ADD COLUMN color TEXT NULL`);
			let row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Widget', color: null });

			// Rename the original column
			await db.exec(`ALTER TABLE items RENAME COLUMN name TO title`);
			row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Widget', color: null });

			// Drop the added column
			await db.exec(`ALTER TABLE items DROP COLUMN color`);
			row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, title: 'Widget' });
		});

		it('handles multiple add columns sequentially', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1)`);

			await db.exec(`ALTER TABLE items ADD COLUMN a TEXT NULL`);
			await db.exec(`ALTER TABLE items ADD COLUMN b INTEGER DEFAULT 42`);
			await db.exec(`ALTER TABLE items ADD COLUMN c TEXT NULL`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, a: null, b: 42, c: null });
		});

		it('handles add then drop of the same column', async () => {
			await db.exec(`
				CREATE TABLE items (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO items VALUES (1, 'Widget')`);

			await db.exec(`ALTER TABLE items ADD COLUMN scratch TEXT NULL`);
			await db.exec(`ALTER TABLE items DROP COLUMN scratch`);

			const row = await db.get('select * from items where id = 1');
			expect(row).to.deep.equal({ id: 1, name: 'Widget' });
		});
	});

	describe('ALTER PRIMARY KEY', () => {
		it('re-keys an empty table', async () => {
			await db.exec(`
				CREATE TABLE t_pk (
					id INTEGER PRIMARY KEY,
					code INTEGER NOT NULL
				) USING store
			`);

			await db.exec(`ALTER TABLE t_pk ALTER PRIMARY KEY (code)`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 100), (2, 200)`);

			const row = await db.get('select id, code from t_pk where code = 100');
			expect(row).to.deep.equal({ id: 1, code: 100 });
		});

		it('re-keys a populated table and preserves row count and data', async () => {
			await db.exec(`
				CREATE TABLE t_pk (
					id INTEGER PRIMARY KEY,
					code INTEGER NOT NULL,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 100, 'Alice'), (2, 200, 'Bob'), (3, 300, 'Charlie')`);

			await db.exec(`ALTER TABLE t_pk ALTER PRIMARY KEY (code)`);

			const rows = await asyncIterableToArray(db.eval('select * from t_pk order by code'));
			expect(rows).to.have.lengthOf(3);
			expect(rows[0]).to.deep.equal({ id: 1, code: 100, name: 'Alice' });
			expect(rows[2]).to.deep.equal({ id: 3, code: 300, name: 'Charlie' });

			// Point lookup under the new PK
			const hit = await db.get('select id, name from t_pk where code = 200');
			expect(hit).to.deep.equal({ id: 2, name: 'Bob' });
		});

		it('rejects a re-key that would duplicate primary keys and leaves the table unchanged', async () => {
			await db.exec(`
				CREATE TABLE t_pk (
					id INTEGER PRIMARY KEY,
					category INTEGER NOT NULL
				) USING store
			`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 10), (2, 10), (3, 20)`);

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE t_pk ALTER PRIMARY KEY (category)`);
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(Error);

			// Table must still be readable under the original PK, with the same row count.
			const cnt = await db.get('select count(*) as cnt from t_pk');
			expect(cnt).to.deep.equal({ cnt: 3 });

			const row = await db.get('select * from t_pk where id = 2');
			expect(row).to.deep.equal({ id: 2, category: 10 });
		});

		it('rebuilds secondary indexes after a re-key', async () => {
			await db.exec(`
				CREATE TABLE t_pk (
					id INTEGER PRIMARY KEY,
					code INTEGER NOT NULL,
					label TEXT
				) USING store
			`);
			await db.exec(`CREATE INDEX idx_label ON t_pk (label)`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 100, 'alpha'), (2, 200, 'beta'), (3, 300, 'gamma')`);

			await db.exec(`ALTER TABLE t_pk ALTER PRIMARY KEY (code)`);

			// Query that benefits from the rebuilt secondary index
			const row = await db.get(`select id, code from t_pk where label = 'beta'`);
			expect(row).to.deep.equal({ id: 2, code: 200 });

			// Full row set still intact
			const rows = await asyncIterableToArray(db.eval('select * from t_pk order by code'));
			expect(rows).to.have.lengthOf(3);
		});

		it('leaves EVERY row at its original key when a re-key collides (no partial re-key)', async () => {
			// The signatures-only pass 1 must reject the whole re-key before pass 2 writes
			// anything: a collision on ONE new key cannot leave OTHER rows already moved to
			// their new keys. Assert the full ordered row set is byte-for-byte what it was.
			await db.exec(`
				CREATE TABLE t_pk (
					id INTEGER PRIMARY KEY,
					category INTEGER NOT NULL,
					name TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_pk VALUES
				(1, 10, 'a'), (2, 20, 'b'), (3, 20, 'c'), (4, 30, 'd'), (5, 40, 'e')`);

			const before = await asyncIterableToArray(db.eval('select * from t_pk order by id'));

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE t_pk ALTER PRIMARY KEY (category)`);
			} catch (e) {
				caught = e;
			}
			expect(caught, 'the colliding re-key must throw').to.be.instanceOf(Error);

			// Still keyed by the ORIGINAL PK (id) with every row unchanged — nothing re-keyed.
			const after = await asyncIterableToArray(db.eval('select * from t_pk order by id'));
			expect(after).to.deep.equal(before);
			// And the pre-ALTER point lookup on id still resolves (proves keys untouched).
			expect(await db.get('select category, name from t_pk where id = 3'))
				.to.deep.equal({ category: 20, name: 'c' });
		});
	});

	describe('ALTER COLUMN SET COLLATE on a PK member (physical re-key)', () => {
		it('rejects all-or-nothing when the coarser collation collapses two distinct PKs', async () => {
			// Two BINARY-distinct text PKs ('A' vs 'a') collide under NOCASE. The re-key
			// must reject before any write and leave both rows present under the old BINARY
			// keys — the same all-or-nothing guarantee as ALTER PRIMARY KEY.
			await db.exec(`
				CREATE TABLE t_col (
					k TEXT COLLATE BINARY PRIMARY KEY,
					v TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_col VALUES ('A', 'upper'), ('a', 'lower')`);

			const before = await asyncIterableToArray(db.eval(`select k, v from t_col order by k`));

			let caught: unknown = null;
			try {
				await db.exec(`ALTER TABLE t_col ALTER COLUMN k SET COLLATE NOCASE`);
			} catch (e) {
				caught = e;
			}
			expect(caught, 'the colliding SET COLLATE must throw').to.be.instanceOf(Error);

			// Both case-distinct rows survive, unchanged.
			expect(await db.get('select count(*) as cnt from t_col')).to.deep.equal({ cnt: 2 });
			const after = await asyncIterableToArray(db.eval(`select k, v from t_col order by k`));
			expect(after).to.deep.equal(before);
			expect((await db.get(`select v from t_col where k = 'A'`))?.v).to.equal('upper');
			expect((await db.get(`select v from t_col where k = 'a'`))?.v).to.equal('lower');
		});

		it('re-keys every row under the new collation when there is no collision', async () => {
			// No two keys collapse, so the re-key succeeds: every row present under the new
			// NOCASE key bytes, none lost or duplicated.
			await db.exec(`
				CREATE TABLE t_col (
					k TEXT COLLATE BINARY PRIMARY KEY,
					v TEXT
				) USING store
			`);
			await db.exec(`INSERT INTO t_col VALUES ('Alpha', '1'), ('Beta', '2'), ('Gamma', '3')`);

			await db.exec(`ALTER TABLE t_col ALTER COLUMN k SET COLLATE NOCASE`);

			expect(await db.get('select count(*) as cnt from t_col')).to.deep.equal({ cnt: 3 });
			// Case-insensitive lookup now resolves under the new collation.
			expect((await db.get(`select v from t_col where k = 'beta'`))?.v).to.equal('2');
			const rows = await asyncIterableToArray(db.eval(`select k, v from t_col order by k`));
			expect(rows).to.have.lengthOf(3);
		});
	});

	describe('ALTER COLUMN SET DATA TYPE onto a key-transform type', () => {
		// TIMESPAN keys by elapsed time, so 'PT1H' and 'PT60M' — distinct TEXT — become one
		// value the moment the column is retyped. The physical type is TEXT either way, so no
		// value rewrite happens; only the key transform changes. That arm rebuilds every
		// secondary index WITHOUT the in-pass duplicate check (the pre-mutation UNIQUE probe
		// is the sole guard, so a wrapper's overlay-deleted row cannot spuriously reject), and
		// these two tests pin both halves of that bargain: the probe still rejects a real
		// collision, and the non-enforcing rebuild still produces an enforcing index.
		it('rejects an equal-elapsed pair under a UNIQUE index, changing nothing', async () => {
			await db.exec(`create table ts (id integer primary key, d text) using store`);
			await db.exec(`create unique index ts_d on ts (d)`);
			await db.exec(`insert into ts values (1, 'PT1H'), (2, 'PT60M')`);

			let caught: unknown = null;
			try {
				await db.exec(`alter table ts alter column d set data type timespan`);
			} catch (e) {
				caught = e;
			}
			expect(String(caught)).to.match(/UNIQUE constraint failed/i);

			// Values, declared type and writability all survive the rejection.
			expect(await asyncIterableToArray(db.eval(`select id, d from ts order by id`)))
				.to.deep.equal([{ id: 1, d: 'PT1H' }, { id: 2, d: 'PT60M' }]);
			expect(await db.get(`select type from table_info('ts') where name = 'd'`))
				.to.deep.equal({ type: 'TEXT' });
			await db.exec(`insert into ts values (3, 'PT90M')`);
			expect(await db.get(`select count(*) as cnt from ts`)).to.deep.equal({ cnt: 3 });
		});

		it('leaves an enforcing, seekable index behind when there is no collision', async () => {
			await db.exec(`create table ts (id integer primary key, d text) using store`);
			await db.exec(`create unique index ts_d on ts (d)`);
			await db.exec(`insert into ts values (1, 'PT1H'), (2, 'PT30M')`);

			await db.exec(`alter table ts alter column d set data type timespan`);

			// The rebuilt index keys by elapsed time: an equal-elapsed spelling finds row 1.
			expect(await db.get(`select id from ts where d = 'PT60M'`)).to.deep.equal({ id: 1 });
			expect(await db.get(`select id from ts where d = 'PT1H'`)).to.deep.equal({ id: 1 });

			let caught: unknown = null;
			try {
				await db.exec(`insert into ts values (3, 'PT60M')`);
			} catch (e) {
				caught = e;
			}
			expect(String(caught), 'the rebuilt index must still enforce').to.match(/UNIQUE constraint failed/i);
		});
	});

	describe('DDL persistence', () => {
		it('persists updated DDL after ADD COLUMN', async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store2', storeModule);

			await db.exec(`
				CREATE TABLE items2 (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store2
			`);
			await db.exec(`INSERT INTO items2 VALUES (1, 'Widget')`);
			await db.exec(`ALTER TABLE items2 ADD COLUMN color TEXT NULL`);

			// Load DDL and verify it reflects the new schema
			const ddlStatements = await storeModule.loadAllDDL();
			expect(ddlStatements).to.have.lengthOf(1);
			expect(ddlStatements[0]).to.include('color');
		});
	});
});
