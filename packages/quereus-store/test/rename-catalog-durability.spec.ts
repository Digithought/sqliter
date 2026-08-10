/**
 * Durability of the catalog bundle across ALTER TABLE RENAME.
 *
 * A rename must never durably write a table definition that names the pre-rename
 * table or column: the engine's rename propagation runs only *after* the module's
 * hook returns, so a module that persists first would write a stale bundle and rely
 * on a follow-up `table_modified` event to correct it. A crash — or a failed second
 * write — in that window strands an un-rehydratable definition on disk.
 *
 * `index-persistence.spec.ts` covers the partial-index predicate under the same
 * invariant (its `reopen()` harness is index-shaped). This file covers the other
 * two self-naming parts of a table's own definition: CHECK constraint expressions
 * and self-referencing foreign keys.
 *
 * Every test asserts on the *whole* sequence of durable catalog writes, not just
 * the last one — the final entry has always been correct, which is exactly why the
 * stale intermediate went unnoticed.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** Persistent in-memory provider: logical close is a no-op, so data survives closeAll(). */
function createPersistentProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const statsKey = (s: string, t: string) => `${s}.${t}.__stats__`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;

	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) {
			stores.delete(idxKey(s, t, i));
		},
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async renameTableStores(s: string, oldName: string, newName: string, indexNames: readonly string[]) {
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) { stores.set(to, store); stores.delete(from); }
			};
			move(dataKey(s, oldName), dataKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
		async closeAll() { /* data survives module close, mirroring real disk */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule rename catalog durability', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	async function reopen(): Promise<{ db: Database; mod: StoreModule }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog bundle parses cleanly').to.have.lengthOf(0);
		return { db, mod };
	}

	/** Record the DDL of every value durably written to the catalog store from now on. */
	async function traceCatalogWrites(): Promise<string[]> {
		const catalog = await provider.getCatalogStore();
		const writes: string[] = [];
		const originalPut = catalog.put.bind(catalog);
		catalog.put = async (key, value, options?) => {
			writes.push(new TextDecoder().decode(value));
			await originalPut(key, value, options);
		};
		return writes;
	}

	/**
	 * Record every durable catalog op — `put` AND `delete` — in order, decoding each key
	 * to its `{schema}.{table}` string (and, for puts, the written DDL). Ordering, not
	 * just the final contents, is the invariant for the multi-table rename: the bug leaves
	 * the final on-disk state correct but sequences the renamed table's delete BEFORE the
	 * dependent's corrective rewrite, so a crash in between strands the dependent.
	 */
	async function traceCatalogOps(): Promise<Array<{ op: 'put' | 'delete'; key: string; ddl: string }>> {
		const catalog = await provider.getCatalogStore();
		const ops: Array<{ op: 'put' | 'delete'; key: string; ddl: string }> = [];
		const decoder = new TextDecoder();
		const originalPut = catalog.put.bind(catalog);
		const originalDelete = catalog.delete.bind(catalog);
		catalog.put = async (key, value, options?) => {
			ops.push({ op: 'put', key: decoder.decode(key), ddl: decoder.decode(value) });
			await originalPut(key, value, options);
		};
		catalog.delete = async (key, options?) => {
			ops.push({ op: 'delete', key: decoder.decode(key), ddl: '' });
			await originalDelete(key, options);
		};
		return ops;
	}

	/** Assert no durable write matched `stale`, and that exactly `expected` writes happened. */
	function expectCleanWrites(writes: readonly string[], stale: RegExp, expected: number): void {
		for (const ddl of writes) {
			expect(ddl, `no bundle written during the rename matches ${stale}`).to.not.match(stale);
		}
		expect(writes.length, 'the rename persisted exactly one bundle').to.equal(expected);
	}

	/** Whether `sql` is rejected by a constraint. */
	async function violates(db: Database, sql: string): Promise<boolean> {
		try {
			await db.exec(sql);
			return false;
		} catch (e) {
			expect(String(e)).to.match(/constraint|foreign key/i);
			return true;
		}
	}

	it('RENAME COLUMN never durably writes a CHECK expression naming the old column', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer check (b > 0)) using store`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename column b to c`);
		await mod.whenCatalogPersisted();
		expectCleanWrites(writes, /check[^)]*\(\s*b\s*>\s*0\s*\)/i, 1);

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors
		expect(await violates(db2, `insert into t values (1, -1)`), 'CHECK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t values (2, 5)`);
	});

	it('RENAME COLUMN never durably writes a self-FK referencing the old column name', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, p integer null, foreign key (p) references t(id)) using store`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename column id to id2`);
		await mod.whenCatalogPersisted();
		expectCleanWrites(writes, /references\s+t\s*\(\s*id\s*\)/i, 1);

		await mod.closeAll();
		const { db: db2 } = await reopen();
		await db2.exec(`insert into t values (1, null)`);
		expect(await violates(db2, `insert into t values (2, 99)`), 'self-FK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t values (3, 1)`);
	});

	it('RENAME TABLE never durably writes a CHECK or self-FK naming the old table', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (
			id integer primary key, p integer null, b integer,
			check (t.b > 0),
			foreign key (p) references t(id)
		) using store`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename to t2`);
		await mod.whenCatalogPersisted();
		// `t.b` in the CHECK and `references t(id)` in the FK both name the vanished
		// table — and `removeTableDDL` drops the old bundle right after this write.
		expectCleanWrites(writes, /\bt\.b\b|references\s+t\s*\(/i, 1);

		await mod.closeAll();
		const { db: db2 } = await reopen();
		expect(await violates(db2, `insert into t2 values (1, null, -1)`), 'CHECK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t2 values (1, null, 5)`);
		expect(await violates(db2, `insert into t2 values (2, 99, 5)`), 'self-FK still enforced after reopen').to.be.true;
		await db2.exec(`insert into t2 values (3, 1, 5)`);
	});

	it('RENAME TABLE re-persists a dependent table before deleting the renamed table', async () => {
		const { db, mod } = open();
		await db.exec(`create table parent (id integer primary key) using store`);
		await db.exec(`create table child (
			id integer primary key,
			p integer null,
			foreign key (p) references parent(id)
		) using store`);
		// Force BOTH tables' DDL onto disk before tracing: a store table with no rows has
		// no catalog entry, so the dependent's corrective rewrite would early-return
		// (nothing to supersede) and the ordering bug could not bite. A row triggers the
		// lazy first-access saveTableDDL.
		await db.exec(`insert into parent values (1)`);
		await db.exec(`insert into child values (1, 1)`);
		await mod.whenCatalogPersisted();

		const ops = await traceCatalogOps();

		await db.exec(`alter table parent rename to parent2`);
		await mod.whenCatalogPersisted();

		// During the window the only `child` write is the corrective one: it must name
		// `parent2`, never the vanished `parent`.
		const childPut = ops.findIndex(o => o.op === 'put' && o.key === 'main.child');
		const parentDelete = ops.findIndex(o => o.op === 'delete' && o.key === 'main.parent');
		expect(childPut, `child was re-persisted during the rename (ops: ${JSON.stringify(ops)})`).to.be.greaterThan(-1);
		expect(parentDelete, 'old parent catalog entry was deleted').to.be.greaterThan(-1);
		expect(ops[childPut].ddl, 'child rewrite names parent2').to.match(/parent2/i);
		expect(ops[childPut].ddl, 'child rewrite no longer names the vanished parent')
			.to.not.match(/references\s+(?:main\.)?parent\s*\(/i);

		// The ordering invariant: child's corrective rewrite is durable BEFORE parent's
		// old entry is deleted, so no durable catalog set names a table that does not exist.
		expect(childPut, 'child rewrite persisted before the parent delete').to.be.lessThan(parentDelete);

		// Belt-and-suspenders: no durable write during the rename names the vanished parent.
		for (const o of ops) {
			if (o.op === 'put') {
				expect(o.ddl, `no catalog write during the rename names the vanished 'parent' (${o.key})`)
					.to.not.match(/references\s+(?:main\.)?parent\s*\(/i);
			}
		}

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors

		// After reopen the FK enforces against parent2 (which holds the row moved into it).
		expect(await violates(db2, `insert into child values (2, 99)`), 'FK enforced against parent2 after reopen').to.be.true;
		await db2.exec(`insert into child values (3, 1)`);
	});

	it('RENAME TABLE re-persists a dependent VIEW body before deleting the renamed table', async () => {
		// A view body is a *different* dependent kind than the FK case above: the engine's
		// propagation fires `view_modified`, which the store persists via `saveViewDDL`
		// (reserved `\x00view\x00` key prefix) — a distinct enqueued function from a table's
		// `persistCatalogIfChanged`. Both ride the same FIFO `persistQueue`, so the same
		// ordering invariant must hold: the view's corrective rewrite (naming `parent2`) is
		// durable BEFORE the old `parent` entry is deleted.
		const { db, mod } = open();
		await db.exec(`create table parent (id integer primary key) using store`);
		await db.exec(`create view v as select id from parent`);
		// A view entry persists eagerly on create (view_added); a row forces parent's own
		// (lazy) table entry to disk so there is an old entry to delete during the rename.
		await db.exec(`insert into parent values (1)`);
		await mod.whenCatalogPersisted();

		const ops = await traceCatalogOps();

		await db.exec(`alter table parent rename to parent2`);
		await mod.whenCatalogPersisted();

		const viewPut = ops.findIndex(o => o.op === 'put' && o.key.includes('main.v'));
		const parentDelete = ops.findIndex(o => o.op === 'delete' && o.key === 'main.parent');
		expect(viewPut, `view body was re-persisted during the rename (ops: ${JSON.stringify(ops)})`).to.be.greaterThan(-1);
		expect(parentDelete, 'old parent catalog entry was deleted').to.be.greaterThan(-1);
		expect(ops[viewPut].ddl, 'view body names parent2').to.match(/parent2/i);
		// `\bparent\b` matches a bare `parent` token but not `parent2` (the trailing digit is
		// a word char, so there is no word boundary after the `t`) — robust to DDL quoting.
		expect(ops[viewPut].ddl, 'view body no longer names the vanished parent').to.not.match(/\bparent\b/i);

		// The ordering invariant: view rewrite durable BEFORE the old parent entry is deleted.
		expect(viewPut, 'view rewrite persisted before the parent delete').to.be.lessThan(parentDelete);

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors — view resolves against parent2

		// After reopen the view reads through parent2 (which holds the row moved into it).
		const viewRows = await asyncIterableToArray(db2.eval(`select id from v`));
		expect(viewRows, 'view over renamed table returns the moved row after reopen').to.have.lengthOf(1);
	});
});
