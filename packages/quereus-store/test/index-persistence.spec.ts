/**
 * Persistence of store-backed secondary indexes across close → reopen.
 *
 * Each table's CREATE INDEX DDL is bundled into its catalog entry (keyed
 * `{schema}.{table}`), so a `CREATE INDEX` on a `using store` table survives
 * closeAll() → reopen → rehydrateCatalog: the index reappears in `index_info`,
 * its backing KV store is reattached (not rebuilt), DML maintains it, and any
 * derived UNIQUE / partial / collation / desc / tags round-trip.
 *
 * Uses a *persistent* in-memory provider (no-op close, like real disk) plus
 * `open()` / `reopen()` helpers, the only way to express close → reopen against
 * the same storage — mirroring tag-persistence.spec.ts. The provider also
 * implements `deleteIndexStore` / `deleteTableStores` / `renameTableStores` over
 * its store map so DROP INDEX / DROP TABLE / RENAME TABLE teardown + relocation
 * are observable.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildCatalogKey,
	type KVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * Persistent in-memory provider: logical close is a no-op so data survives a
 * StoreModule.closeAll(), and delete/rename hooks mutate the same store map so
 * DROP/RENAME physical teardown is observable. `_hardClose` is the real teardown.
 */
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
			// Key off the authoritative index list (exact store names), matching real
			// provider semantics — a `{table}_idx_` prefix sweep would also drop a
			// sibling table named `{table}_idx_<x>`.
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
			for (const i of indexNames) {
				move(idxKey(s, oldName, i), idxKey(s, newName, i));
			}
		},
		async closeAll() { /* data survives module close, mirroring real disk */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule secondary-index persistence', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	/** Phase 1: a fresh db + module over the shared provider. */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** Phase 2: a brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<{ db: Database; mod: StoreModule }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog bundle parses cleanly').to.have.lengthOf(0);
		return { db, mod };
	}

	async function indexInfo(db: Database, table: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(`select * from index_info('${table}')`)) as Record<string, SqlValue>[];
	}

	async function rows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	/** Number of entries in the backing index KV store (one per indexed row). */
	function indexStoreSize(table: string, indexName: string, schema = 'main'): number {
		const s = provider.stores.get(`${schema}.${table}_idx_${indexName}`);
		return s ? s.size : 0;
	}

	/** Decoded catalog bundle for a table, or undefined when absent. */
	async function catalogEntry(table: string, schema = 'main'): Promise<string | undefined> {
		const catalog = await provider.getCatalogStore();
		const raw = await catalog.get(buildCatalogKey(schema, table));
		return raw ? new TextDecoder().decode(raw) : undefined;
	}

	/**
	 * Record the DDL of every value durably written to the catalog store from now on.
	 *
	 * Asserting only on the FINAL catalog entry cannot see a bundle that was written
	 * stale and corrected a moment later by the async `table_modified` listener — yet
	 * a crash in that window leaves the stale bundle on disk forever. These tests
	 * therefore assert on the whole write sequence, not just its last element.
	 */
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

	it('plain CREATE INDEX survives reopen; backing store reattaches and DML maintains it', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);
		expect(indexStoreSize('t', 'ix_b'), 'index has one entry per row pre-reopen').to.equal(3);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// index_info lists the index after reopen.
		const info = await indexInfo(db2, 't');
		expect(info.map(r => r.index_name)).to.include('ix_b');

		// Backing store entries SURVIVED (reattached, not rebuilt or lost).
		expect(indexStoreSize('t', 'ix_b'), 'backing entries survive reopen').to.equal(3);

		// DML after reopen maintains the rehydrated index.
		await db2.exec(`insert into t values (4, 40)`);
		expect(indexStoreSize('t', 'ix_b'), 'INSERT grows the index store').to.equal(4);

		// An index-backed predicate returns the right rows.
		const r = await rows(db2, `select id from t where b = 20`);
		expect(r).to.deep.equal([{ id: 2 }]);
	});

	it('the secondary-index scan arm reads reattached entries after reopen (seek + range)', async () => {
		// Entries written pre-reopen carry the row's data key as their value; after
		// reopen the store's index-scan arm resolves each entry back to its base row
		// through that stored data key, so an index seek returns correct rows without
		// a rebuild.
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20), (3, 30), (4, 20)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// EQ seek across the reattached index (two rows share b = 20).
		expect(await rows(db2, `select id from t where b = 20 order by id`))
			.to.deep.equal([{ id: 2 }, { id: 4 }]);

		// Range seek across the reattached index; order by b, id → 20, 20, 30.
		expect(await rows(db2, `select id from t where b > 15 order by b, id`))
			.to.deep.equal([{ id: 2 }, { id: 4 }, { id: 3 }]);

		// The plan actually uses the index (not a full scan + residual).
		const planRows = await rows(db2, `select json_group_array(op) as ops from query_plan('select id from t where b = 20')`);
		expect(planRows[0].ops as string).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
	});

	it('secondary index is rebuilt consistently after an ALTER COLUMN SET COLLATE re-key of the PK', async () => {
		const { db } = open();
		// Text PK keyed BINARY + a secondary index on a value column. Uppercase PK values
		// so the BINARY→NOCASE re-key actually changes the data-key bytes (and thus the PK
		// suffix embedded in every index key).
		await db.exec(`create table t (k text collate binary primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`insert into t values ('A', 10), ('B', 20)`);
		expect(indexStoreSize('t', 'ix_v'), 'one index entry per row pre-ALTER').to.equal(2);

		// Re-key the PK under NOCASE: 'A'/'B' data keys become 'a'/'b'. The index must be
		// cleared + rebuilt so its embedded PK suffix matches the re-encoded data keys.
		await db.exec(`alter table t alter column k set collate nocase`);
		expect(indexStoreSize('t', 'ix_v'), 'index entry count preserved across re-key').to.equal(2);

		// Data survived the re-key intact (full-scan filter; the store does not read the index).
		expect(await rows(db, `select k from t where v = 20`), 'row reachable after re-key').to.deep.equal([{ k: 'B' }]);

		// DELETE drives index maintenance, which computes each index key under the NEW
		// per-column PK collation. Had the rebuild embedded the STALE (BINARY) PK suffix,
		// these deletes would not match the rebuilt entries and orphan them — so a
		// fully-drained table whose index store is empty proves rebuild and write-time
		// maintenance agree on the PK-suffix encoding.
		await db.exec(`delete from t`);
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'all rows deleted').to.equal(0);
		expect(indexStoreSize('t', 'ix_v'), 'no orphaned index entries after re-key + delete').to.equal(0);
	});

	it('binary-config store: CREATE INDEX over existing rows and write-time maintenance agree on the index-column key collation', async () => {
		// Regression for the build-vs-maintenance index-COLUMN encoding fix
		// (store-pk-collate-physical-rekey): `buildIndexEntries` formerly hardcoded the
		// index-column key collation to NOCASE while `updateSecondaryIndexes` (write-time
		// maintenance) used the table's configured K. On a `collation = binary` store the
		// two disagreed, so an index built over EXISTING rows (NOCASE bytes) could not be
		// maintained by later DML (BINARY bytes) — a stale/orphaned-entry latent bug.
		//
		// `collation = binary` makes K = BINARY (vs the NOCASE default), and the index
		// column values 'X' / 'x' differ ONLY in case, so the two encodings produce
		// DIFFERENT bytes — the only configuration that exposes the mismatch.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, v text) using store (collation = binary)`);

		// Insert BEFORE the index exists so CREATE INDEX populates it via buildIndexEntries
		// (the build path), encoding the index-column 'X'/'x' values under K = BINARY.
		await db.exec(`insert into t values (1, 'X'), (2, 'x')`);
		await db.exec(`create index ix_v on t (v)`);
		expect(indexStoreSize('t', 'ix_v'), 'one built entry per existing row').to.equal(2);

		// DELETE drives write-time maintenance, which recomputes each index key under K.
		// Had build used NOCASE while maintenance uses BINARY, the delete keys would not
		// match the built entries and would orphan them — a drained index store proves the
		// two paths agree on the index-column encoding for a BINARY-config store.
		await db.exec(`delete from t`);
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'all rows deleted').to.equal(0);
		expect(indexStoreSize('t', 'ix_v'), 'no orphaned index entries (build + maintenance agree under K=BINARY)').to.equal(0);
	});

	it('CREATE UNIQUE INDEX survives reopen and still rejects duplicates', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, email text) using store`);
		await db.exec(`create unique index uq_email on t (email)`);
		await db.exec(`insert into t values (1, 'a@x.com')`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		const uq = (await indexInfo(db2, 't')).find(r => r.index_name === 'uq_email')!;
		expect(uq, 'unique index present').to.not.be.undefined;
		expect(uq.unique, 'unique flag round-trips').to.equal(1);

		// Duplicate rejected, distinct succeeds (derived UNIQUE constraint enforces).
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, 'a@x.com')`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'duplicate email rejected after reopen').to.be.true;
		await db2.exec(`insert into t values (3, 'b@x.com')`);
	});

	it('partial CREATE INDEX (WHERE) survives reopen; only in-scope rows are indexed', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_pos on t (b) where b > 0`);
		// Two in-scope rows, one out-of-scope — only the in-scope rows index.
		await db.exec(`insert into t values (1, 10), (2, 20), (3, -5)`);
		expect(indexStoreSize('t', 'ix_pos'), 'only in-scope rows indexed at build').to.equal(2);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		const ix = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_pos')!;
		expect(ix.partial, 'partial flag round-trips').to.equal(1);
		expect(indexStoreSize('t', 'ix_pos'), 'backing entries survive reopen').to.equal(2);

		// An out-of-scope INSERT after reopen adds NO index entry; an in-scope one does.
		await db2.exec(`insert into t values (4, -1)`);
		expect(indexStoreSize('t', 'ix_pos'), 'out-of-scope INSERT adds no entry').to.equal(2);
		await db2.exec(`insert into t values (5, 50)`);
		expect(indexStoreSize('t', 'ix_pos'), 'in-scope INSERT adds an entry').to.equal(3);
	});

	it('UPDATE relocates a full-index entry on the rehydrated index (no stale key leak)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// Mutating the indexed column re-keys the single backing entry: the count
		// stays 1 only if the old (b=10) key was removed before the new (b=99) key
		// was written. A leak would leave two entries.
		await db2.exec(`update t set b = 99 where id = 1`);
		expect(indexStoreSize('t', 'ix_b'), 'UPDATE re-keys without leaking the old entry').to.equal(1);
		expect(await rows(db2, `select id from t where b = 99`)).to.deep.equal([{ id: 1 }]);
		expect(await rows(db2, `select id from t where b = 10`), 'old value no longer present').to.deep.equal([]);
	});

	it('UPDATE across a partial-index predicate scope maintains the rehydrated backing store both ways', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_pos on t (b) where b > 0`);
		await db.exec(`insert into t values (1, 10)`);
		expect(indexStoreSize('t', 'ix_pos')).to.equal(1);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// in-scope → out-of-scope: the old entry is removed and none is added.
		await db2.exec(`update t set b = -5 where id = 1`);
		expect(indexStoreSize('t', 'ix_pos'), 'edit out of scope drops the entry').to.equal(0);

		// out-of-scope → in-scope: an entry is added with no stale delete to undo it.
		await db2.exec(`update t set b = 7 where id = 1`);
		expect(indexStoreSize('t', 'ix_pos'), 'edit back into scope re-adds the entry').to.equal(1);

		// in-scope → in-scope: the entry is re-keyed in place, count unchanged.
		await db2.exec(`update t set b = 8 where id = 1`);
		expect(indexStoreSize('t', 'ix_pos'), 'in-scope→in-scope stays a single entry').to.equal(1);
	});

	it('DESC + COLLATE index columns round-trip across reopen', async () => {
		const { db, mod } = open();
		// Collation flows into the index by inheriting the column's COLLATE (the live
		// CREATE INDEX path does not accept an inline per-column COLLATE — a separate
		// pre-existing engine limitation); the persisted DDL still emits the explicit
		// `COLLATE NOCASE DESC`, which import unwraps.
		await db.exec(`create table t (id integer primary key, name text collate nocase) using store`);
		await db.exec(`create index ix_name on t (name desc)`);
		await db.exec(`insert into t values (1, 'Alice')`);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		const col = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_name')!;
		expect(col.desc, 'desc round-trips').to.equal(1);
		expect(col.collation, 'collation round-trips').to.equal('NOCASE');
	});

	it('a multi-index table rehydrates both indexes cleanly (table-before-indexes)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
		await db.exec(`create index ix_a on t (a)`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10, 100)`);
		await mod.closeAll();

		// reopen() already asserts result.errors is empty (bundle imports in order).
		const { db: db2 } = await reopen();
		const names = (await indexInfo(db2, 't')).map(r => r.index_name);
		expect(names).to.include.members(['ix_a', 'ix_b']);
	});

	it('DROP INDEX is durable: index absent, bundle no longer carries it, backing store gone', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		expect(indexStoreSize('t', 'ix_b')).to.equal(1);

		await db.exec(`drop index ix_b`);
		// Backing store torn down immediately (deleteIndexStore).
		expect(indexStoreSize('t', 'ix_b'), 'backing store gone after drop').to.equal(0);
		// Bundle no longer carries the index line.
		expect(await catalogEntry('t'), 'bundle drops the index DDL').to.not.match(/CREATE INDEX/i);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		const names = (await indexInfo(db2, 't')).map(r => r.index_name);
		expect(names, 'index absent after reopen').to.not.include('ix_b');
	});

	// ── ALTER TABLE … DROP COLUMN and the physical index stores it reshapes
	// (bug-drop-column-leaks-index-store). `shiftSchemaIndicesForDrop` removes an index
	// outright when the dropped column was its ONLY column or when it is UNIQUE and spans
	// the column, and NARROWS a plain multi-column index that merely loses one column. The
	// removed index's store must be torn down and the narrowed one's re-encoded — its key
	// layout loses one value ahead of the PK suffix.

	it('DROP COLUMN collapsing a single-column index tears its backing store down', async () => {
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);
		expect(indexStoreSize('t', 'ix_b'), 'one entry per row before the drop').to.equal(2);

		await db.exec(`alter table t drop column b`);

		// Schema drops the index (its only column is gone) — and so must the store.
		expect((await indexInfo(db, 't')).map(r => r.index_name), 'index gone from the schema')
			.to.not.include('ix_b');
		expect(provider.stores.has('main.t_idx_ix_b'), 'backing store torn down, not leaked')
			.to.equal(false);
	});

	it('DROP COLUMN removing a UNIQUE index that spans the column tears its backing store down', async () => {
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create unique index ux_bc on t (b, c)`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);
		expect(indexStoreSize('t', 'ux_bc')).to.equal(2);

		// A UNIQUE index spanning the dropped column is removed outright rather than
		// narrowed (narrowing would claim a constraint the table never declared).
		await db.exec(`alter table t drop column b`);

		expect((await indexInfo(db, 't')).map(r => r.index_name)).to.not.include('ux_bc');
		expect(provider.stores.has('main.t_idx_ux_bc'), 'backing store torn down, not leaked')
			.to.equal(false);
	});

	it('a same-named CREATE INDEX after DROP COLUMN builds a fresh store (no adopted stale entries)', async () => {
		// The user-visible consequence of a leaked store: `getIndexStore` hands the existing
		// store back and `buildIndexEntries` APPENDS to it, so the new index carries both
		// encodings. `assertStoreNameFree` cannot catch it — the dropped index is no longer a
		// registered schema object. A range scan then yields each row twice, because a stale
		// key's leading bytes can fall inside the seek window and the row it resolves to does
		// satisfy the predicate.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);

		await db.exec(`alter table t drop column b`);
		await db.exec(`create index ix_b on t (c)`);

		expect(indexStoreSize('t', 'ix_b'), 'exactly one entry per row (no adopted stale entries)')
			.to.equal(2);
		expect(await rows(db, `select id from t where c = 100`)).to.deep.equal([{ id: 1 }]);
		expect(await rows(db, `select id from t where c > 0 order by id`), 'each row exactly once')
			.to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('DROP COLUMN narrowing a multi-column index re-encodes entries written before the drop', async () => {
		// Rows inserted BEFORE the drop are what exposes this: their entries carry the WIDE
		// key (b's value ahead of c's) while every later seek and every write-time delete
		// computes the NARROW one, so a lookup misses the row and a delete orphans its entry.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_bc on t (b, c)`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);
		expect(indexStoreSize('t', 'ix_bc')).to.equal(2);

		await db.exec(`alter table t drop column b`);

		// The index survives over its remaining column, and the plan seeks through it.
		expect(await rows(db, `select index_name, column_name from index_info('t')`))
			.to.deep.equal([{ index_name: 'ix_bc', column_name: 'c' }]);
		const planRows = await rows(db, `select json_group_array(op) as ops from query_plan('select id from t where c = 100')`);
		expect(planRows[0].ops as string).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

		expect(indexStoreSize('t', 'ix_bc'), 'entry count preserved across the re-encode').to.equal(2);
		expect(await rows(db, `select id from t where c = 100`), 'pre-drop row still found via the index')
			.to.deep.equal([{ id: 1 }]);
		expect(await rows(db, `select id from t where c > 0 order by id`), 'each pre-drop row exactly once')
			.to.deep.equal([{ id: 1 }, { id: 2 }]);

		// DELETE recomputes each index key under the narrow encoding: a fully-drained index
		// store proves the rebuild and write-time maintenance agree on it.
		await db.exec(`delete from t`);
		expect(indexStoreSize('t', 'ix_bc'), 'no orphaned entries after the re-encode + delete').to.equal(0);
	});

	it('DROP COLUMN narrowing a PARTIAL index re-encodes only the in-scope rows', async () => {
		// The narrowed rebuild compiles the surviving WHERE predicate against the POST-drop
		// column list (the engine rejects a DROP COLUMN whose column the predicate names, so
		// the predicate can only reference survivors). Out-of-scope rows must stay unindexed.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_bc on t (b, c) where c > 0`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, -5)`);
		expect(indexStoreSize('t', 'ix_bc'), 'only the in-scope row is indexed at build').to.equal(1);

		await db.exec(`alter table t drop column b`);

		expect(indexStoreSize('t', 'ix_bc'), 'still only the in-scope row after the re-encode').to.equal(1);
		expect(await rows(db, `select id from t where c = 100`)).to.deep.equal([{ id: 1 }]);

		// Write-time maintenance agrees with the re-encoded entries in both scope directions.
		await db.exec(`insert into t values (3, 300)`);
		expect(indexStoreSize('t', 'ix_bc'), 'in-scope insert indexed').to.equal(2);
		await db.exec(`insert into t values (4, -7)`);
		expect(indexStoreSize('t', 'ix_bc'), 'out-of-scope insert excluded').to.equal(2);
		await db.exec(`delete from t`);
		expect(indexStoreSize('t', 'ix_bc'), 'no orphaned entries after the re-encode + delete').to.equal(0);
	});

	it('one DROP COLUMN reshapes every affected index and leaves the unaffected one alone', async () => {
		// All three fates in one statement: `ix_b` removed (its only column goes), `ix_bc`
		// narrowed to (c), `ix_c` untouched (same column count — its indices shift but its
		// key bytes do not). The narrowed rebuild is handed only the narrowed list, so a bug
		// there shows up as either a missed re-encode or a clobbered `ix_c`.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`create index ix_bc on t (b, c)`);
		await db.exec(`create index ix_c on t (c)`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);

		await db.exec(`alter table t drop column b`);

		expect(provider.stores.has('main.t_idx_ix_b'), 'collapsed index torn down').to.equal(false);
		expect((await indexInfo(db, 't')).map(r => r.index_name).sort())
			.to.deep.equal(['ix_bc', 'ix_c']);
		expect(indexStoreSize('t', 'ix_bc'), 'narrowed index re-encoded, one entry per row').to.equal(2);
		expect(indexStoreSize('t', 'ix_c'), 'untouched index intact').to.equal(2);
		expect(await rows(db, `select id from t where c = 100`)).to.deep.equal([{ id: 1 }]);

		// Both survivors drain, so write-time maintenance agrees with each one's entries.
		await db.exec(`delete from t`);
		expect(indexStoreSize('t', 'ix_bc'), 'narrowed index drained').to.equal(0);
		expect(indexStoreSize('t', 'ix_c'), 'untouched index drained').to.equal(0);
	});

	it('DROP COLUMN narrowing a DESC / NOCASE index re-encodes under the same direction and collation', async () => {
		// The rebuild must carry the surviving column's `desc` flag and the table key
		// collation into the new key bytes, not re-encode ASC / BINARY: a case-insensitive
		// match on a pre-drop row is what catches a collation regression, and the DESC
		// ordering below what catches a direction one.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, name text collate nocase) using store`);
		await db.exec(`create index ix_bn on t (b, name desc)`);
		await db.exec(`insert into t values (1, 10, 'Alice'), (2, 20, 'bob')`);

		await db.exec(`alter table t drop column b`);

		const info = await indexInfo(db, 't');
		expect(info.map(r => [r.index_name, r.column_name, r.desc]), 'narrowed to the DESC column')
			.to.deep.equal([['ix_bn', 'name', 1]]);
		expect(indexStoreSize('t', 'ix_bn'), 'entry per row after the re-encode').to.equal(2);
		expect(await rows(db, `select id from t where name = 'ALICE'`), 'NOCASE match on a pre-drop row')
			.to.deep.equal([{ id: 1 }]);
		expect(await rows(db, `select id from t where name > 'a' order by name desc`))
			.to.deep.equal([{ id: 2 }, { id: 1 }]);
		await db.exec(`delete from t`);
		expect(indexStoreSize('t', 'ix_bn'), 'no orphaned entries after the re-encode + delete').to.equal(0);
	});

	it('DROP COLUMN inside an open transaction strands no ops against the reshaped stores', async () => {
		// The arm flushes ONCE, before the row migration, and then writes the data and index
		// stores outside the coordinator — so the teardown of a doomed store takes no second
		// flush. A pending write against the doomed index before the statement is what would
		// expose a stranded op: it would replay into a closed store at commit.
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`create index ix_bc on t (b, c)`);
		await db.exec(`insert into t values (1, 10, 100)`);

		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 20, 200)`);
		// DDL that rewrites rows force-commits the module transaction (`ddlTransactionality:
		// 'auto-commit'`), so the pending row above is part of the migrated set.
		await db.exec(`alter table t drop column b`);
		await db.exec(`insert into t values (3, 300)`);
		await db.exec(`commit`);

		expect(provider.stores.has('main.t_idx_ix_b'), 'doomed store torn down').to.equal(false);
		expect(indexStoreSize('t', 'ix_bc'), 'every row indexed under the narrow encoding').to.equal(3);
		expect(await rows(db, `select id from t where c > 0 order by id`))
			.to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it('DROP COLUMN then reopen: the removed index does not resurrect from a leaked store', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10, 100), (2, 20, 200)`);

		await db.exec(`alter table t drop column b`);
		expect(await catalogEntry('t'), 'bundle no longer carries the index DDL').to.not.match(/CREATE INDEX/i);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		expect((await indexInfo(db2, 't')).map(r => r.index_name), 'index absent after reopen')
			.to.not.include('ix_b');
		expect(provider.stores.has('main.t_idx_ix_b'), 'store still absent after reopen').to.equal(false);
	});

	it('DROP TABLE then reopen: no table/index resurrection, no orphan catalog entry', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);

		await db.exec(`drop table t`);
		expect(await catalogEntry('t'), 'catalog entry removed on DROP TABLE').to.be.undefined;
		expect(indexStoreSize('t', 'ix_b'), 'index store torn down on DROP TABLE').to.equal(0);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		expect(db2.schemaManager.findTable('t'), 'table does not resurrect').to.be.undefined;
	});

	it('RENAME TABLE then reopen: index present under new name, absent under old', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		await db.exec(`alter table t rename to t2`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// Index present under the new name; data survived the relocation.
		const names = (await indexInfo(db2, 't2')).map(r => r.index_name);
		expect(names, 'index present under new name').to.include('ix_b');
		expect(indexStoreSize('t2', 'ix_b'), 'backing entries relocated under new name').to.equal(2);
		const r = await rows(db2, `select id from t2 where b = 20`);
		expect(r).to.deep.equal([{ id: 2 }]);

		// Old name is gone (no catalog entry, no live table).
		expect(await catalogEntry('t'), 'old catalog entry removed').to.be.undefined;
		expect(db2.schemaManager.findTable('t'), 'old name not present').to.be.undefined;
	});

	it('RENAME TABLE under a table-qualified partial WHERE: persisted predicate follows the rename and rehydrates', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b) where t.b > 0`);
		await db.exec(`insert into t values (1, 10), (2, -1)`);

		await db.exec(`alter table t rename to t2`);
		// The propagated predicate rewrite re-persists via the async table_modified
		// listener — drain it before reading the catalog.
		await mod.whenCatalogPersisted();

		// The re-persisted catalog DDL renders the NEW qualifier; a stale `t.b`
		// would reference a no-longer-existing table.
		const entry = (await catalogEntry('t2'))!;
		expect(entry, 'persisted index DDL carries the renamed qualifier').to.match(/WHERE t2\.b > 0/);
		expect(entry, 'no stale qualifier survives').to.not.match(/\bt\.b\b/);

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors

		const ix = (await indexInfo(db2, 't2')).find(r => r.index_name === 'ix_b')!;
		expect(ix.partial, 'rehydrated index is partial').to.equal(1);
		expect(indexStoreSize('t2', 'ix_b'), 'only the in-scope row is indexed').to.equal(1);
	});

	it('RENAME COLUMN under a partial WHERE: persisted predicate follows the rename and rehydrates', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b) where b > 0`);
		await db.exec(`insert into t values (1, 10), (2, -1)`);

		await db.exec(`alter table t rename column b to c`);
		await mod.whenCatalogPersisted();

		// A stale `WHERE b > 0` would name a column that no longer exists, failing
		// predicate compilation on rehydrate.
		const entry = (await catalogEntry('t'))!;
		expect(entry, 'persisted index DDL carries the renamed column').to.match(/WHERE c > 0/);

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors

		const ix = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_b')!;
		expect(ix.partial, 'rehydrated index is partial').to.equal(1);
		expect(indexStoreSize('t', 'ix_b'), 'only the in-scope row is indexed').to.equal(1);

		// Write-time maintenance still honors the predicate under the new name.
		await db2.exec(`insert into t values (3, 5)`);
		await db2.exec(`insert into t values (4, -7)`);
		expect(indexStoreSize('t', 'ix_b'), 'in-scope insert indexed, out-of-scope excluded').to.equal(2);
	});

	it('RENAME COLUMN never durably writes a partial-index predicate naming the old column', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b) where b > 0`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename column b to c`);
		await mod.whenCatalogPersisted();

		expect(writes.length, 'the rename persisted at least one bundle').to.be.greaterThan(0);
		for (const ddl of writes) {
			expect(ddl, 'no bundle written during the rename names the old column').to.not.match(/where\s+b\s*>\s*0/i);
		}
		// The hook now persists the final bundle itself, so the propagation pass's
		// `table_modified` event finds an identical entry and compare-skips it.
		expect(writes.length, 'exactly one effective catalog write').to.equal(1);
	});

	it('RENAME TABLE never durably writes a partial-index predicate naming the old table', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b) where t.b > 0`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename to t2`);
		await mod.whenCatalogPersisted();

		expect(writes.length, 'the rename persisted at least one bundle').to.be.greaterThan(0);
		for (const ddl of writes) {
			expect(ddl, 'no bundle written during the rename names the old table').to.not.match(/where\s+t\.b/i);
		}
	});

	it('RENAME COLUMN under a UNIQUE partial index: uniqueness still enforced in scope after reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer, g integer) using store`);
		await db.exec(`create unique index ux_g on t (g) where b > 0`);
		// Out-of-scope rows may duplicate `g` freely.
		await db.exec(`insert into t values (1, 10, 100), (2, -1, 100)`);
		const writes = await traceCatalogWrites();

		await db.exec(`alter table t rename column b to c`);
		await mod.whenCatalogPersisted();
		for (const ddl of writes) {
			expect(ddl, 'no bundle written during the rename names the old column').to.not.match(/where\s+b\s*>\s*0/i);
		}

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors

		// The derived UNIQUE constraint rehydrated with the renamed predicate: an
		// in-scope duplicate is rejected, an out-of-scope duplicate is not.
		let rejected = false;
		try {
			await db2.exec(`insert into t values (3, 5, 100)`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'in-scope duplicate g rejected after reopen').to.be.true;

		await db2.exec(`insert into t values (4, -3, 100)`);
		expect(indexStoreSize('t', 'ux_g'), 'only in-scope rows are indexed').to.equal(1);
	});

	it('ALTER INDEX SET / ADD / DROP TAGS round-trip via index_info after reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);

		// SET (whole-set replace), then ADD (merge), then DROP one key.
		await db.exec(`alter index ix_b set tags (owner = 'search', purpose = 'lookup')`);
		await db.exec(`alter index ix_b add tags (team = 'core')`);
		await db.exec(`alter index ix_b drop tags (purpose)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		const ix = (await indexInfo(db2, 't')).find(r => r.index_name === 'ix_b')!;
		expect(JSON.parse(ix.tags as string)).to.deep.equal({ owner: 'search', team: 'core' });
	});

	it('inline UNIQUE constraint + a separate CREATE INDEX on one table both survive reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, email text, b integer, constraint uq_email unique (email)) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 'a@x', 10)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();

		// The separate CREATE INDEX round-trips via its own bundle line.
		const names = (await indexInfo(db2, 't')).map(r => r.index_name);
		expect(names, 'separate index present').to.include('ix_b');

		// The inline UNIQUE round-trips via the table DDL (table constraint) and
		// still enforces — and is NOT doubled by an extra CREATE INDEX line.
		const entry = (await catalogEntry('t'))!;
		expect((entry.match(/CREATE INDEX/gi) ?? []).length, 'inline UNIQUE not emitted as CREATE INDEX').to.equal(1);
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, 'a@x', 99)`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'inline UNIQUE still enforces after reopen').to.be.true;
	});

	it('CREATE INDEX produces exactly one effective catalog write (listener skips identical bundle)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`insert into t values (1, 10)`); // persist table DDL (ddlSaved = true) before spying

		const catalog: KVStore = await provider.getCatalogStore();
		let putCount = 0;
		const origPut = catalog.put.bind(catalog);
		catalog.put = async (key: Uint8Array, value: Uint8Array) => {
			putCount++;
			await origPut(key, value);
		};

		await db.exec(`create index ix_b on t (b)`);
		await mod.whenCatalogPersisted();

		// createIndex writes the bundle once; the follow-up table_modified listener
		// regenerates an identical bundle and skips — no double-write.
		expect(putCount, 'exactly one catalog write for CREATE INDEX').to.equal(1);

		const { db: db2 } = await reopen();
		expect((await indexInfo(db2, 't')).map(r => r.index_name)).to.include('ix_b');
	});

	// ── Module-facing stored-name canonicalization (module-facing-schema-name-
	// canonicalization). The engine now hands every module hook the STORED names
	// of the object it acts on — never the raw spelling of the triggering DDL. This
	// in-memory provider keys its stores by the EXACT casing it is handed (a real
	// disk provider lowercases via buildDataStoreName/buildIndexStoreName, masking
	// the drift), so it directly exposes whether dropIndex / destroy address the
	// store created under the stored name. Physical keys are unchanged either way —
	// lowercase(canonical) === lowercase(raw) — so these are display/registry fixes,
	// asserted here as "no orphan store under the raw drop spelling".

	it('DROP INDEX with a case-divergent spelling releases the backing store under the stored name', async () => {
		const { db } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index MyIdx on t (b)`); // stored display casing: MyIdx
		await db.exec(`insert into t values (1, 10)`);
		expect(indexStoreSize('t', 'MyIdx'), 'backing store created under the stored casing').to.equal(1);

		// Drop with a divergent spelling. module.dropIndex receives the stored `MyIdx`
		// (via SchemaManager), so StoreTable.indexStores + provider.deleteIndexStore
		// address the right store — the raw `MYIDX` would orphan it.
		await db.exec(`drop index MYIDX`);
		expect(indexStoreSize('t', 'MyIdx'), 'backing store for the stored name is torn down').to.equal(0);
		expect(provider.stores.has('main.t_idx_MYIDX'), 'no orphan store under the raw DROP spelling').to.equal(false);
	});

	it('DROP TABLE with a case-divergent spelling tears down the stored-name stores; reopen does not resurrect', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		expect(provider.stores.has('main.t'), 'data store present').to.equal(true);
		expect(indexStoreSize('t', 'ix_b')).to.equal(1);

		// module.destroy receives the stored `t` (not the raw `T`), so deleteTableStores
		// addresses the data + index stores created under the stored name.
		await db.exec(`drop table T`);
		expect(provider.stores.has('main.t'), 'data store torn down under the stored name').to.equal(false);
		expect(indexStoreSize('t', 'ix_b'), 'index store torn down under the stored name').to.equal(0);
		expect(provider.stores.has('main.T'), 'no orphan data store under the raw DROP spelling').to.equal(false);
		expect(await catalogEntry('t'), 'catalog entry removed').to.be.undefined;
		await mod.closeAll();

		const { db: db2 } = await reopen();
		expect(db2.schemaManager.findTable('t'), 'table does not resurrect').to.be.undefined;
	});
});
