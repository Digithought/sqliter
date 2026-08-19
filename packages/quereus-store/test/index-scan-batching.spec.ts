/**
 * Batched row resolution behind secondary-index scans (store-index-seek-batched-scan).
 *
 * `scanIndex` / `scanMultiSeek` collect surviving index entries in
 * ROW_RESOLUTION_BATCH-bounded batches and resolve each batch with ONE
 * `readEffectiveRowsByKeys` → `KVStore.getMany` round trip, instead of awaiting one
 * point read per entry; `scanMultiSeekPrimary` does the same over its sorted point-key
 * list. These tests pin the three things batching must NOT change — row sets, emission
 * order (including the read-your-own-writes overlay merge), and the
 * only-add-`seen`-on-yield dedup rule — and the one thing it must: the round-trip
 * count, observed through a counting store double (rows alone cannot distinguish a
 * batched resolution from a serial one).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	Database,
	asyncIterableToArray,
	IndexConstraintOp,
	type FilterInfo,
	type Row,
	type SqlValue,
} from '@quereus/quereus';
import {
	StoreModule,
	type KVStoreProvider,
	type KVEntry,
} from '../src/index.js';
import { ROW_RESOLUTION_BATCH } from '../src/common/store-table-scan.js';
import { CountingKVStore, createCountingProvider } from '../src/testing/kv-counting-store.js';

describe('batched index-scan row resolution (store-index-seek-batched-scan)', () => {
	let db: Database;
	let stores: Map<string, CountingKVStore>;
	let provider: KVStoreProvider;
	let storeModule: StoreModule;

	beforeEach(() => {
		stores = new Map();
		provider = createCountingProvider(stores, 'all');
		db = new Database();
		storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	/** The `query_plan()` op names for `query`, as a JSON array string. */
	async function planOps(query: string): Promise<string> {
		const rows = await asyncIterableToArray(
			db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
		);
		expect(rows).to.have.lengthOf(1);
		return rows[0].ops as string;
	}

	// The queries below deliberately omit ORDER BY: the assertions are about the
	// SCAN's own emission order (index-key order, overlay rows merged in place),
	// which a Sort node would mask.

	describe('rows and order across the read-your-own-writes overlay', () => {
		it('single-window index range: pending puts, deletes, and a re-key inside and outside the window', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50), (6, 60)`);

			const q = `select id, v from t where v >= 20 and v <= 50`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

			await db.exec('begin');
			await db.exec(`insert into t values (7, 25), (8, 70)`); // pending put inside + outside window
			await db.exec(`delete from t where id = 3`);            // pending delete inside window (v=30)
			await db.exec(`delete from t where id = 6`);            // pending delete outside window (v=60)
			await db.exec(`update t set v = 45 where id = 4`);      // pending re-key inside window (40 → 45)
			const rows = await asyncIterableToArray(db.eval(q));
			await db.exec('rollback');

			// Index-key (v) order with overlay rows merged in place: 20, 25(pending),
			// 45(re-keyed pending), 50. The deleted 30 and the out-of-window 60/70 are absent.
			expect(rows).to.deep.equal([
				{ id: 2, v: 20 },
				{ id: 7, v: 25 },
				{ id: 4, v: 45 },
				{ id: 5, v: 50 },
			]);
		});

		it('multi-seek: pending rows surface in window order, a pending delete empties its window', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);

			const q = `select id from t where v in (10, 20, 30)`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

			await db.exec('begin');
			await db.exec(`insert into t values (4, 20)`); // second (pending) row in the v=20 window
			await db.exec(`delete from t where id = 1`);   // empties the v=10 window
			const rows = await asyncIterableToArray(db.eval(q));
			await db.exec('rollback');

			// Windows scan in ascending encoded-key order; within the v=20 window the
			// pending row merges by (indexKey, PK): committed id=2, then pending id=4.
			expect(rows.map(r => r.id)).to.deep.equal([2, 4, 3]);
		});
	});

	it('a stale duplicate index entry inside one batch yields its row exactly once', async () => {
		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`insert into t values (1, 10), (2, 10), (3, 20)`);

		// Forge index corruption: point the (v=10, id=2) entry at row 1's data key, so
		// the v=10 window holds TWO entries for one row — both inside a single batch,
		// where the multi-seek `seen` PRE-check (which runs at entry-visit time, before
		// the batch resolves) cannot see the first yield. Only the post-read re-check
		// can keep the row from yielding twice.
		const ixStore = stores.get('main.t_idx_ix_v')!;
		const entries: KVEntry[] = [];
		for await (const e of ixStore.iterate()) entries.push(e);
		expect(entries, 'one index entry per row').to.have.lengthOf(3);
		await ixStore.put(entries[1].key, entries[0].value);

		const q = `select id from t where v in (10, 20)`;
		expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
		const rows = await asyncIterableToArray(db.eval(q));
		// Row 1 exactly once (not twice, not zero times), then row 3. Row 2 is
		// unreachable — its only index entry was deliberately corrupted away.
		expect(rows.map(r => r.id)).to.deep.equal([1, 3]);
	});

	it('a stale duplicate entry in a LATER batch than its row is still yielded once', async () => {
		// The in-batch case above pins the post-read re-check. This pins the other half:
		// `seen` must be fully populated by the time the NEXT batch is collected, so the
		// producer's pre-check catches a duplicate that lands past the batch boundary.
		// (`resolveIndexEntries` yields each batch to completion before pulling more
		// entries, which is what makes that true.)
		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		const n = ROW_RESOLUTION_BATCH + 10;
		await db.exec(`insert into t values ${
			Array.from({ length: n }, (_, i) => `(${i}, ${i})`).join(', ')}`);

		// Re-point the LAST row's index entry at row 0's data key: row 0 yields from the
		// first batch, its duplicate is visited while collecting the second.
		const ixStore = stores.get('main.t_idx_ix_v')!;
		const entries: KVEntry[] = [];
		for await (const e of ixStore.iterate()) entries.push(e);
		expect(entries).to.have.lengthOf(n);
		await ixStore.put(entries[n - 1].key, entries[0].value);

		const list = Array.from({ length: n }, (_, i) => i).join(', ');
		const rows = await asyncIterableToArray(db.eval(`select id from t where v in (${list})`));
		// Row 0 once, at its own position; the last row is unreachable (its only entry
		// was corrupted away).
		expect(rows.map(r => r.id)).to.deep.equal(Array.from({ length: n - 1 }, (_, i) => i));
	});

	describe('round-trip counts (counting store double)', () => {
		it('a multi-seek drain past the batch boundary keeps order and pays one trip per batch', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			const n = 300; // > ROW_RESOLUTION_BATCH: one full batch plus a partial tail
			await db.exec(`insert into t values ${
				Array.from({ length: n }, (_, i) => `(${i}, ${i})`).join(', ')}`);
			const dataStore = stores.get('main.t')!;
			dataStore.reset();

			const list = Array.from({ length: n }, (_, i) => i).join(', ');
			const rows = await asyncIterableToArray(db.eval(`select id from t where v in (${list})`));
			// Batches are bound by ENTRY count across windows, so 300 single-row windows
			// cost ceil(300 / 256) trips — not 300, and not one per window.
			expect(rows.map(r => r.id)).to.deep.equal(Array.from({ length: n }, (_, i) => i));
			expect(dataStore.getManyCalls, 'ceil(300 / 256) batches').to.equal(2);
			expect(dataStore.getManyKeyCount).to.equal(n);
			expect(dataStore.iterateEntryCount, 'no data-store scan').to.equal(0);
		});

		it('a multi-seek over many single-row windows collapses row resolution into one round trip', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			const vals = Array.from({ length: 100 }, (_, i) => `(${i}, ${i})`).join(', ');
			await db.exec(`insert into t values ${vals}`);
			const dataStore = stores.get('main.t')!;
			dataStore.reset();

			const list = Array.from({ length: 100 }, (_, i) => i).join(', ');
			const rows = await asyncIterableToArray(db.eval(`select id from t where v in (${list})`));
			expect(rows.map(r => r.id)).to.deep.equal(Array.from({ length: 100 }, (_, i) => i));
			expect(dataStore.iterateEntryCount, 'no data-store scan').to.equal(0);
			// One hundred single-row windows, ONE readEffectiveRowsByKeys batch — the
			// pre-batching path issued 100 serialized point reads here.
			expect(dataStore.getManyCalls, 'one batch round trip').to.equal(1);
			expect(dataStore.getManyKeyCount).to.equal(100);
		});

		it('an early break (limit 1) reads at most one resolution batch', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			const vals = Array.from({ length: 600 }, (_, i) => `(${i}, ${i})`).join(', ');
			await db.exec(`insert into t values ${vals}`);
			const dataStore = stores.get('main.t')!;
			const ixStore = stores.get('main.t_idx_ix_v')!;

			const q = `select id from t where v >= 300 limit 1`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			dataStore.reset();
			ixStore.reset();

			const rows = await asyncIterableToArray(db.eval(q));
			expect(rows).to.have.lengthOf(1);
			// The documented early-termination trade: one batch of index entries is
			// collected and resolved (not one row, but also not the whole 300-entry range).
			expect(ixStore.iterateEntryCount, 'at most one batch of index entries visited')
				.to.be.at.most(ROW_RESOLUTION_BATCH);
			expect(dataStore.getManyCalls, 'no second batch after the break').to.be.at.most(1);
			expect(dataStore.getManyKeyCount).to.be.at.most(ROW_RESOLUTION_BATCH);
			expect(dataStore.iterateEntryCount, 'no data-store scan').to.equal(0);
		});

		it('a drain past the batch boundary keeps rows and order across batches', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			const vals = Array.from({ length: 600 }, (_, i) => `(${i}, ${i})`).join(', ');
			await db.exec(`insert into t values ${vals}`);
			const dataStore = stores.get('main.t')!;
			dataStore.reset();

			// 300 matching entries > ROW_RESOLUTION_BATCH (256): exercises a full batch
			// plus a partial tail batch.
			const rows = await asyncIterableToArray(db.eval(`select id from t where v >= 300`));
			expect(rows.map(r => r.id)).to.deep.equal(Array.from({ length: 300 }, (_, i) => 300 + i));
			expect(dataStore.getManyCalls, 'ceil(300 / 256) batches').to.equal(2);
			expect(dataStore.getManyKeyCount).to.equal(300);
		});
	});

	describe('primary-key multi-seek (scanMultiSeekPrimary)', () => {
		// `computeBestAccessPlan` now plans this arm for a whole-primary-key IN, and
		// pushdown.spec.ts covers it end to end through SQL. These drive the protected
		// method directly — the same probe idiom pushdown.spec.ts uses for
		// buildPKRangeBounds — to pin the BATCHING shape (round trips, no scan), which a
		// row assertion through SQL cannot see.
		interface PrimaryMultiSeekProbe {
			scanMultiSeekPrimary(
				tuples: Array<{
					entries: Array<{ constraint: { iColumn: number; op: IndexConstraintOp }; argvIndex: number }>;
					values: SqlValue[];
				}>,
				seekWidth: number,
				filterInfo: FilterInfo,
			): AsyncIterable<Row>;
		}

		it('resolves its sorted point-key list in one bounded batch round trip', async () => {
			await db.exec(`create table pkt (id integer primary key, v text) using store`);
			await db.exec(`insert into pkt values (1, 'a'), (2, 'b'), (3, 'c')`);
			const dataStore = stores.get('main.pkt')!;
			dataStore.reset();

			// Unsorted seek keys, one of them absent from the table.
			const args: SqlValue[] = [3, 1, 2, 999];
			const tuples = args.map((value, i) => ({
				entries: [{ constraint: { iColumn: 0, op: IndexConstraintOp.EQ }, argvIndex: i + 1 }],
				values: [value],
			}));
			const filterInfo = {
				idxNum: 0,
				idxStr: 'idx=_primary_(0);plan=5;seekWidth=1;inCount=4',
				constraints: tuples.flatMap(t => t.entries),
				args,
				indexInfoOutput: {},
			} as unknown as FilterInfo;

			const table = storeModule.getTable('main', 'pkt')! as unknown as PrimaryMultiSeekProbe;
			const rows: Row[] = [];
			for await (const row of table.scanMultiSeekPrimary(tuples, 1, filterInfo)) rows.push(row);

			// Ascending encoded-PK order; the missing key answers a positional null and
			// is skipped without shifting anything.
			expect(rows.map(r => r[0])).to.deep.equal([1, 2, 3]);
			expect(dataStore.getManyCalls, 'one batch round trip for all four point keys').to.equal(1);
			expect(dataStore.getManyKeyCount).to.equal(4);
			expect(dataStore.iterateEntryCount, 'point reads, no scan').to.equal(0);
		});
	});
});
