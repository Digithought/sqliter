/**
 * Read-your-own-writes tests for the bare StoreModule (no isolation wrapper).
 *
 * Within an explicit transaction, `StoreTable.query` merges the shared
 * coordinator's pending ops over the committed store — point lookups honor
 * pending puts/deletes, and range/full scans emit a key-ordered merge — while
 * readers outside any transaction (and other connections after rollback) see
 * committed data only.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type Row, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	StoreTable,
	InMemoryKVStore,
	StoreEventEmitter,
	buildDataKey,
	serializeRow,
	type KVStoreProvider,
	type KVStore,
	type IterateOptions,
	type KVEntry,
	type DataChangeEvent,
} from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** Exposes the protected merge entry points for direct bounded/reverse tests. */
class HarnessStoreTable extends StoreTable {
	async open(): Promise<KVStore> {
		await this.ensureCoordinator();
		return this.ensureStore();
	}

	iterateMerged(store: KVStore, bounds: IterateOptions, reverse?: boolean): AsyncIterable<KVEntry> {
		return this.iterateEffective(store, bounds, reverse);
	}
}

describe('StoreTable read-your-own-writes (bare StoreModule)', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let module: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		module = new StoreModule(provider);
		db.registerModule('store', module);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('begin → insert → select sees the row; rollback discards it', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);

		const during = await collect(db, `select id, v from t`);
		expect(during).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`rollback`);
		const after = await collect(db, `select id, v from t`);
		expect(after).to.deep.equal([]);
	});

	it('commit persists mid-transaction rows', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1), (2)`);
		await db.exec(`commit`);
		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('point lookup honors a pending put and a pending delete', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'committed'), (2, 'doomed')`);

		await db.exec(`begin`);
		await db.exec(`update t set v = 'pending' where id = 1`);
		await db.exec(`delete from t where id = 2`);
		await db.exec(`insert into t values (3, 'new')`);

		expect(await collect(db, `select v from t where id = 1`))
			.to.deep.equal([{ v: 'pending' }]);
		expect(await collect(db, `select v from t where id = 2`)).to.deep.equal([]);
		expect(await collect(db, `select v from t where id = 3`))
			.to.deep.equal([{ v: 'new' }]);

		await db.exec(`rollback`);
		expect(await collect(db, `select v from t where id = 1`))
			.to.deep.equal([{ v: 'committed' }]);
		expect(await collect(db, `select v from t where id = 2`))
			.to.deep.equal([{ v: 'doomed' }]);
	});

	it('merged full scan stays in PK order with mixed pending/committed rows (ASC)', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (10), (30), (50)`);

		await db.exec(`begin`);
		await db.exec(`insert into t values (5), (20), (60)`);
		await db.exec(`delete from t where id = 30`);

		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 5 }, { id: 10 }, { id: 20 }, { id: 50 }, { id: 60 }]);
		await db.exec(`rollback`);
	});

	it('merged full scan stays in PK order with a DESC PK', async () => {
		await db.exec(`create table t (id integer primary key desc) using store`);
		await db.exec(`insert into t values (10), (30), (50)`);

		await db.exec(`begin`);
		await db.exec(`insert into t values (20), (60)`);

		const rows = await collect(db, `select id from t`);
		expect(rows).to.deep.equal([{ id: 60 }, { id: 50 }, { id: 30 }, { id: 20 }, { id: 10 }]);
		await db.exec(`rollback`);
	});

	it('NOCASE PK pending overwrite merges with its committed entry (no duplicate)', async () => {
		// Default store key collation is NOCASE: 'a' and 'A' share key bytes, so
		// the pending put must shadow the committed entry, not sit beside it.
		await db.exec(`create table t (name text primary key, v integer) using store`);
		await db.exec(`insert into t values ('a', 1)`);

		await db.exec(`begin`);
		await db.exec(`update t set name = 'A', v = 2 where name = 'a'`);

		const rows = await collect(db, `select name, v from t`);
		expect(rows).to.deep.equal([{ name: 'A', v: 2 }]);
		await db.exec(`rollback`);
	});

	it('rollback to savepoint discards only the tail', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`savepoint s1`);
		await db.exec(`insert into t values (2)`);
		await db.exec(`rollback to s1`);
		await db.exec(`insert into t values (3)`);

		expect(await collect(db, `select id from t`)).to.deep.equal([{ id: 1 }, { id: 3 }]);

		await db.exec(`commit`);
		expect(await collect(db, `select id from t`)).to.deep.equal([{ id: 1 }, { id: 3 }]);
	});

	it('UNIQUE constraints still see pending writes through the merge', async () => {
		await db.exec(`create table t (id integer primary key, u text unique) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'x')`);
		let failed = false;
		try {
			await db.exec(`insert into t values (2, 'x')`);
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true, 'intra-transaction UNIQUE duplicate must be rejected');
		await db.exec(`rollback`);
	});

	it('secondary-index seek reads its own pending index puts and deletes', async () => {
		// The index scan iterates `iterateEffective(indexStore, …)`, so pending index
		// puts/deletes must be visible mid-transaction — not just the committed entries.
		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`); // committed

		await db.exec(`begin`);
		// Pending insert: seek finds the not-yet-committed value.
		await db.exec(`insert into t values (3, 30)`);
		expect(await collect(db, `select id from t where v = 30`)).to.deep.equal([{ id: 3 }]);

		// Update the indexed column: old value misses, new value hits.
		await db.exec(`update t set v = 99 where id = 1`);
		expect(await collect(db, `select id from t where v = 10`), 'old index value gone').to.deep.equal([]);
		expect(await collect(db, `select id from t where v = 99`), 'new index value present').to.deep.equal([{ id: 1 }]);

		// Delete: the entry is suppressed by the pending index delete.
		await db.exec(`delete from t where id = 2`);
		expect(await collect(db, `select id from t where v = 20`), 'deleted row not seekable').to.deep.equal([]);

		await db.exec(`commit`);
		// Committed state reflects the whole transaction.
		expect(await collect(db, `select id, v from t order by id`))
			.to.deep.equal([{ id: 1, v: 99 }, { id: 3, v: 30 }]);
	});

	describe('cross-table transaction (module-wide coordinator)', () => {
		// The headline behavior, exercised at the SQL level over a real Database:
		// two store tables share ONE module coordinator, so a single transaction
		// reads-its-own-writes across both, and commit/rollback are all-or-nothing
		// across both. (The in-memory provider has no beginAtomicBatch, so this is
		// the fallback per-store-batch path; the atomic-batch fault path is covered
		// by transaction.spec.ts and the IDB suite.)

		it('reads own writes across two tables mid-transaction; commit persists both', async () => {
			await db.exec(`create table a (id integer primary key, v text) using store`);
			await db.exec(`create table b (id integer primary key, v text) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into a values (1, 'a1')`);
			await db.exec(`insert into b values (2, 'b2')`);

			// Both tables' pending writes are visible mid-transaction on the same
			// connection — proving the two tables bucket separately on one shared
			// coordinator (no cross-bleed, no missing writes).
			expect(await collect(db, `select v from a where id = 1`)).to.deep.equal([{ v: 'a1' }]);
			expect(await collect(db, `select v from b where id = 2`)).to.deep.equal([{ v: 'b2' }]);

			await db.exec(`commit`);
			expect(await collect(db, `select v from a`)).to.deep.equal([{ v: 'a1' }]);
			expect(await collect(db, `select v from b`)).to.deep.equal([{ v: 'b2' }]);
		});

		it('rollback discards writes to BOTH tables', async () => {
			await db.exec(`create table a (id integer primary key) using store`);
			await db.exec(`create table b (id integer primary key) using store`);
			await db.exec(`insert into a values (1)`);
			await db.exec(`insert into b values (1)`);

			await db.exec(`begin`);
			await db.exec(`insert into a values (2)`);
			await db.exec(`insert into b values (2)`);
			await db.exec(`rollback`);

			// Pre-transaction rows survive on both; in-transaction rows vanish on both.
			expect(await collect(db, `select id from a`)).to.deep.equal([{ id: 1 }]);
			expect(await collect(db, `select id from b`)).to.deep.equal([{ id: 1 }]);
		});

		it('savepoint rollback undoes the tail on both tables, keeps the pre-savepoint head', async () => {
			await db.exec(`create table a (id integer primary key) using store`);
			await db.exec(`create table b (id integer primary key) using store`);

			await db.exec(`begin`);
			await db.exec(`insert into a values (1)`);
			await db.exec(`insert into b values (1)`);
			await db.exec(`savepoint s1`);
			await db.exec(`insert into a values (2)`);
			await db.exec(`insert into b values (2)`);
			await db.exec(`rollback to s1`);

			// Post-savepoint writes gone on both; pre-savepoint writes intact on both.
			expect(await collect(db, `select id from a`)).to.deep.equal([{ id: 1 }]);
			expect(await collect(db, `select id from b`)).to.deep.equal([{ id: 1 }]);

			await db.exec(`commit`);
			expect(await collect(db, `select id from a`)).to.deep.equal([{ id: 1 }]);
			expect(await collect(db, `select id from b`)).to.deep.equal([{ id: 1 }]);
		});
	});

	describe('iterateEffective (direct merge harness)', () => {
		it('bounded merge excludes out-of-bounds pending puts; reverse mirrors forward', async () => {
			await db.exec(`create table t (id integer primary key) using store`);
			await db.exec(`insert into t values (10), (30), (50)`);

			const schema = db.schemaManager.getTable('main', 't');
			expect(schema).to.not.equal(undefined);
			const harness = new HarnessStoreTable(db, module, schema!, { collation: 'NOCASE' }, undefined, true);
			const store = await harness.open();

			// Pending ops via the SHARED module coordinator (the same one SQL DML
			// would use), addressed by this table's data-store handle: puts at 20
			// and 60, delete of committed 30.
			const coordinator = module.getCoordinator();
			coordinator.begin();
			try {
				coordinator.put(buildDataKey([20]), serializeRow([20] as Row), store);
				coordinator.put(buildDataKey([60]), serializeRow([60] as Row), store);
				coordinator.delete(buildDataKey([30]), store);

				const keysOf = async (bounds: IterateOptions, reverse?: boolean) => {
					const out: string[] = [];
					for await (const entry of harness.iterateMerged(store, bounds, reverse)) {
						out.push(Array.from(entry.key).join(','));
					}
					return out;
				};
				const expectKeys = (values: number[]) =>
					values.map(v => Array.from(buildDataKey([v])).join(','));

				// Unbounded: pending 20/60 merge in, deleted 30 suppressed.
				const forward = await keysOf({});
				expect(forward).to.deep.equal(expectKeys([10, 20, 50, 60]));

				// Reverse yields the exact reverse of forward.
				const reversed = await keysOf({}, true);
				expect(reversed).to.deep.equal([...forward].reverse());

				// Bounded window [15, 45): pending 20 included, committed 30 stays
				// suppressed, pending 60 (out of bounds) must not leak in.
				const bounds: IterateOptions = { gte: buildDataKey([15]), lt: buildDataKey([45]) };
				expect(await keysOf(bounds)).to.deep.equal(expectKeys([20]));
				expect(await keysOf(bounds, true)).to.deep.equal(expectKeys([20]));
			} finally {
				coordinator.rollback();
			}
		});

		it('degrades to the committed iterate when no transaction is active', async () => {
			await db.exec(`create table t (id integer primary key) using store`);
			await db.exec(`insert into t values (1), (2)`);

			const schema = db.schemaManager.getTable('main', 't');
			const harness = new HarnessStoreTable(db, module, schema!, { collation: 'NOCASE' }, undefined, true);
			const store = await harness.open();

			const out: Uint8Array[] = [];
			for await (const entry of harness.iterateMerged(store, {})) {
				out.push(entry.key);
			}
			expect(out).to.deep.equal([buildDataKey([1]), buildDataKey([2])]);
		});
	});
});

/**
 * DML internal reads (the insert PK-conflict probe, the update/delete old-image
 * reads, and the update PK-change conflict probe) must read through the same
 * pending-over-committed merge as `query()`. Otherwise a row written earlier in
 * the same transaction lives only in the coordinator's pending bucket, so the
 * committed-only probes report "absent": no PK conflict, no secondary-index
 * cleanup, wrong stats deltas, and events with a missing `oldRow`.
 */
describe('StoreTable DML internal reads are pending-aware (bare StoreModule)', () => {
	let db: Database;
	let provider: KVStoreProvider & { stores: Map<string, InMemoryKVStore> };
	let module: StoreModule;
	let events: DataChangeEvent[];

	/** In-memory provider that exposes its store map so index entries are countable. */
	function createExposedProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
		const stores = new Map<string, InMemoryKVStore>();
		const get = (key: string) => {
			if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
			return stores.get(key)!;
		};
		return {
			stores,
			async getStore(s, t) { return get(`${s}.${t}`); },
			async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
			async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
			async getCatalogStore() { return get('__catalog__'); },
			async closeStore() {},
			async closeIndexStore() {},
			async closeAll() {
				for (const store of stores.values()) await store.close();
				stores.clear();
			},
		};
	}

	beforeEach(() => {
		db = new Database();
		provider = createExposedProvider();
		const emitter = new StoreEventEmitter();
		events = [];
		emitter.onDataChange(e => events.push(e));
		module = new StoreModule(provider, emitter);
		db.registerModule('store', module);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	/** Committed estimated row count of `main.t` from the live table. */
	const rowCount = () => module.getTable('main', 't')!.getEstimatedRowCount();
	/** Entry count of the backing KV store for index `ix` on `main.t`. */
	const indexSize = (ix: string) => provider.stores.get(`main.t_idx_${ix}`)?.size ?? 0;

	it('insert over a pending PK raises UNIQUE (ABORT)', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		let failed = false;
		try {
			await db.exec(`insert into t values (1, 'b')`);
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true, 'duplicate PK over a pending row must be rejected');
		// The pending row is untouched.
		expect(await collect(db, `select id, v from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
		await db.exec(`rollback`);
	});

	it('insert or ignore over a pending PK keeps the original row', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`insert or ignore into t values (1, 'b')`);
		expect(await collect(db, `select id, v from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
		await db.exec(`commit`);
		expect(await collect(db, `select id, v from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
		expect(await rowCount()).to.equal(1);
	});

	it('insert or replace over a pending PK overwrites it: one row, stats 1, update event with the pending oldRow', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`insert or replace into t values (1, 'b')`);
		await db.exec(`commit`);
		expect(await collect(db, `select id, v from t`)).to.deep.equal([{ id: 1, v: 'b' }]);
		expect(await rowCount()).to.equal(1);
		const updates = events.filter(e => e.type === 'update');
		expect(updates).to.have.lengthOf(1);
		expect(updates[0].oldRow).to.deep.equal([1, 'a']);
		expect(updates[0].newRow).to.deep.equal([1, 'b']);
	});

	it('updating an indexed column on a pending row leaves exactly one index entry', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'old')`);
		await db.exec(`update t set v = 'new' where id = 1`);
		await db.exec(`commit`);
		expect(await collect(db, `select id, v from t`)).to.deep.equal([{ id: 1, v: 'new' }]);
		// The stale 'old' index entry must be removed, not leaked beside 'new'.
		expect(indexSize('ix_v')).to.equal(1);
		// The update arm read the pending old image, so its event carries it.
		const updates = events.filter(e => e.type === 'update');
		expect(updates).to.have.lengthOf(1);
		expect(updates[0].oldRow).to.deep.equal([1, 'old']);
		expect(updates[0].newRow).to.deep.equal([1, 'new']);
	});

	it('insert then delete within a transaction nets to empty: no rows, stats 0, zero index entries', async () => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'x')`);
		await db.exec(`delete from t where id = 1`);
		await db.exec(`commit`);
		expect(await collect(db, `select id, v from t`)).to.deep.equal([]);
		expect(await rowCount()).to.equal(0);
		expect(indexSize('ix_v')).to.equal(0);
		// The delete saw the pending row, so it emitted a delete carrying its oldRow.
		const deletes = events.filter(e => e.type === 'delete');
		expect(deletes).to.have.lengthOf(1);
		expect(deletes[0].oldRow).to.deep.equal([1, 'x']);
	});

	it('PK-change UPDATE onto a pending row raises UNIQUE (ABORT)', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1), (2)`);
		let failed = false;
		try {
			await db.exec(`update t set id = 2 where id = 1`);
		} catch {
			failed = true;
		}
		expect(failed).to.equal(true, 'a PK change onto a pending row must conflict');
		await db.exec(`rollback`);
	});

	// `UPDATE OR <action>` is intentionally unsupported by the parser (logic/47.2
	// §5), so the only SQL-level way to drive the PK-change REPLACE path is a
	// schema-level `PRIMARY KEY ON CONFLICT REPLACE` default.
	it('PK-change UPDATE evicts a pending row at the new PK under PRIMARY KEY ON CONFLICT REPLACE', async () => {
		await db.exec(`create table t (id integer primary key on conflict replace, v text) using store`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'one'), (2, 'two')`);
		// No statement-level OR; the column-level REPLACE applies. The colliding
		// row at PK 2 is pending — committed-only probes would miss it (the bug).
		await db.exec(`update t set id = 2 where id = 1`);
		await db.exec(`commit`);
		// Row 1 relocated to PK 2 with its own value; the pending row 2 was evicted.
		expect(await collect(db, `select id, v from t order by id`)).to.deep.equal([{ id: 2, v: 'one' }]);
		expect(await rowCount()).to.equal(1);
	});
});
