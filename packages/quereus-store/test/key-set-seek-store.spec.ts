/**
 * The key-set semi join (`where col in (select …)`, feat-key-set-semi-join) driven
 * end to end against the PERSISTENT STORE backend, and against that backend behind
 * the transaction isolation layer.
 *
 * The engine rewrites the target leaf's `FilterInfo` at runtime into an ordinary
 * single-column `plan=5` multi-seek — byte-identical to what a literal `in (1,2,3)`
 * produces — so `StoreTable.scanMultiSeek` (or `scanMultiSeekPrimary`, when the set is
 * on the primary key) and `IsolatedTable`'s merged read serve it without knowing where
 * the values came from. These tests prove that
 * for the real store: the seek actually happens (the `idxStr` the store receives is
 * captured, not inferred), uncommitted rows are visible through it, and every gate
 * that must decline still does.
 *
 * Two facts shape every test here:
 *
 * - **No `order by` on a column the target leaf's own walk already provides —
 *   EXCEPT on a primary-key target.** The store advertises primary-key order, so
 *   `… order by pk` is absorbed into the leaf at plan time, which marks its emission
 *   order load-bearing. For a SECONDARY-index seek that makes `rule-key-set-seek`
 *   decline (correctly — the seek index is not the walk index, so a multi-seek could
 *   emit in some other order), and rows are therefore collected unordered and sorted
 *   in JS. For a `_primary_` seek the seek index IS the walk index, so
 *   `seekPreservesTargetOrder` holds, the rewrite fires anyway, and the absorbed Sort
 *   stays absorbed — the `primary-key target` block below pins that, asserting RAW
 *   emission order rather than sorting in JS.
 * - **The seek is a runtime decision.** `query_plan()` shows `KeySetSemiJoin` whether
 *   the runtime ends up seeking or scanning, so seek-vs-scan is asserted from the
 *   `idxStr` the store's `query()` was handed.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray } from '@quereus/quereus';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	FilterInfo,
	Row,
	SqlValue,
	TableSchema,
} from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';
import {
	StoreModule,
	StoreTable,
	InMemoryKVStore,
	type KVCostProfile,
	type KVStoreProvider,
	type StoreModuleConfig,
} from '../src/index.js';
import { ROW_RESOLUTION_BATCH } from '../src/common/store-table-scan.js';
import { CountingKVStore, createCountingProvider } from '../src/testing/kv-counting-store.js';

/** The engine's own ceiling on runtime seek keys (`RUNTIME_SET_MAX_KEYS`). */
const ENGINE_SEEK_CEILING = 1000;

/** A `plan=5` multi-seek on the named index, capturing `inCount`. */
function multiSeekRe(indexName: string): RegExp {
	return new RegExp(`^idx=${indexName}\\(0\\);plan=5;inCount=(\\d+)$`);
}

/**
 * A plain `plan=0` walk — what the store is handed when the runtime declines to seek.
 * Asserted positively wherever "it scanned instead" is the point: a bare
 * `not.match(/plan=5/)` is also satisfied by never having queried the store at all.
 */
const SCAN_RE = /^idx=\S+;plan=0$/;


/**
 * `costProfile` is optional so every existing caller stays a parity backend — the 16 tests
 * above are the regression fingerprint for "an undeclared provider plans as it always did".
 */
function createInMemoryProvider(costProfile?: KVCostProfile): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
		...(costProfile ? { costProfile } : {}),
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/**
 * `StoreModule` that records the `idxStr` of every `query()` its tables serve, keyed
 * by lowercased table name. Under the isolation layer this still observes what the
 * STORE was asked for, since the wrapper delegates to this module's tables.
 *
 * `connect()` re-serves a memoized table, so wrapping is idempotent per instance.
 */
class IdxStrCapturingStoreModule extends StoreModule {
	readonly idxStrs = new Map<string, string[]>();
	private readonly wrapped = new WeakSet<StoreTable>();

	private capture(table: StoreTable): StoreTable {
		if (this.wrapped.has(table)) return table;
		this.wrapped.add(table);
		const key = table.tableName.toLowerCase();
		const strs = this.idxStrs;
		const original = table.query.bind(table);
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
			const list = strs.get(key) ?? [];
			list.push(filterInfo.idxStr ?? '');
			strs.set(key, list);
			return original(filterInfo);
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<StoreTable> {
		return this.capture(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: StoreModuleConfig,
		importedTableSchema?: TableSchema,
	): Promise<StoreTable> {
		return this.capture(
			await super.connect(db, pAux, moduleName, schemaName, tableName, options, importedTableSchema));
	}

	reset(): void {
		this.idxStrs.clear();
	}

	/** Every `idxStr` the named table was queried with since the last {@link reset}. */
	seen(tableName: string): string[] {
		return this.idxStrs.get(tableName.toLowerCase()) ?? [];
	}
}

describe('key-set semi join over the store backend (feat-key-set-seek-store-isolation)', () => {
	describe('store module, no isolation', () => {
		let db: Database;
		let provider: KVStoreProvider;
		let mod: IdxStrCapturingStoreModule;

		beforeEach(() => {
			db = new Database();
			provider = createInMemoryProvider();
			mod = new IdxStrCapturingStoreModule(provider);
			db.registerModule('store', mod);
		});

		afterEach(async () => {
			await provider.closeAll();
		});

		/** Rows of `q`, sorted in JS — see the file header on why not `order by`. */
		const pks = async (q: string, params?: SqlValue[]): Promise<number[]> =>
			(await asyncIterableToArray(db.eval(q, params)))
				.map(r => r.pk as number)
				.sort((a, b) => a - b);

		/**
		 * `pk` of every row of `q` in RAW emission order — no JS sort. Used where the
		 * order the target emitted in IS the assertion.
		 */
		const rawPks = async (q: string): Promise<number[]> =>
			(await asyncIterableToArray(db.eval(q))).map(r => r.pk as number);

		/** The `query_plan()` op names for `query`, as a JSON array string. */
		const planOps = async (query: string): Promise<string> => {
			const rows = await asyncIterableToArray(
				db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]));
			return rows[0].ops as string;
		};

		/** The single `KeySetSemiJoin`'s logical attributes for `query`. */
		const keySetProps = async (query: string): Promise<Record<string, unknown>> => {
			const rows = await asyncIterableToArray(db.eval(
				`select properties from query_plan(?) where op = 'KEYSETSEMIJOIN'`, [query]));
			expect(rows, 'exactly one KeySetSemiJoin in the plan').to.have.lengthOf(1);
			return JSON.parse(rows[0].properties as string) as Record<string, unknown>;
		};

		describe('single-column secondary index', () => {
			beforeEach(async () => {
				await db.exec(`create table big (pk integer primary key, v integer, w integer) using store`);
				await db.exec(`create index ix_v on big (v)`);
				await db.exec(`create table ksrc (id integer primary key, k integer null) using store`);
				await db.exec(`insert into big values ${
					Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${(i + 1) * 10}, ${i + 1})`).join(', ')}`);
			});

			it('hands the store a plan=5 multi-seek with one window per distinct key', async () => {
				await db.exec(`insert into ksrc values (1, 100), (2, 300), (3, 9999)`);
				mod.reset();
				expect(await pks(`select pk from big where v in (select k from ksrc)`)).to.deep.equal([10, 30]);

				const seen = mod.seen('big');
				expect(seen, 'the target was opened exactly once').to.have.lengthOf(1);
				// Not `fullscan`, not the plan-time `_primary_` walk: a real index multi-seek.
				expect(seen[0], 'the store received a multi-seek').to.match(multiSeekRe('ix_v'));
				expect(seen[0]).to.contain('inCount=3');
			});

			it('collapses duplicate and NULL inner values before stamping inCount', async () => {
				await db.exec(`insert into ksrc values (1, 100), (2, 100), (3, null), (4, 300), (5, 100)`);
				mod.reset();
				expect(await pks(`select pk from big where v in (select k from ksrc)`)).to.deep.equal([10, 30]);
				expect(mod.seen('big')[0]).to.contain('inCount=2');
			});

			it('never opens the target when the key set is empty', async () => {
				mod.reset();
				expect(await pks(`select pk from big where v in (select k from ksrc)`)).to.deep.equal([]);
				expect(mod.seen('big'), 'the store was never queried').to.have.lengthOf(0);
			});

			it('seeks a single-key set as a one-window multi-seek, not a plain EQ', async () => {
				await db.exec(`insert into ksrc values (1, 70)`);
				mod.reset();
				expect(await pks(`select pk from big where v in (select k from ksrc)`)).to.deep.equal([7]);
				expect(mod.seen('big')[0]).to.match(multiSeekRe('ix_v'));
				expect(mod.seen('big')[0]).to.contain('inCount=1');
			});

			it('a key set matching nothing returns no rows but still seeks', async () => {
				await db.exec(`insert into ksrc values (1, 7), (2, 13)`);
				mod.reset();
				expect(await pks(`select pk from big where v in (select k from ksrc)`)).to.deep.equal([]);
				expect(mod.seen('big')[0]).to.match(multiSeekRe('ix_v'));
			});

			it('two key-set seeks in one statement each answer independently', async () => {
				// Two `KeySetSemiJoin`s in one plan, each with its own per-execution key-set
				// state (a `WeakMap` keyed by RuntimeContext). No parallel fan-out happens
				// here — neither shipped module advertises `fully-reentrant`, so the planner
				// never inserts an AsyncGather over a store table and the branches run
				// serially on the same context. This pins the serial case; the forked case
				// is unreachable today (see the handoff).
				await db.exec(`create table big2 (pk integer primary key, v integer) using store`);
				await db.exec(`create index ix_v2 on big2 (v)`);
				await db.exec(`insert into big2 values (1, 10), (2, 20), (3, 30)`);
				await db.exec(`insert into ksrc values (1, 10), (2, 30)`);
				mod.reset();
				const rows = await asyncIterableToArray(db.eval(
					`select pk from big where v in (select k from ksrc)
					 union all
					 select pk from big2 where v in (select k from ksrc)`));
				expect(rows.map(r => r.pk as number).sort((a, b) => a - b)).to.deep.equal([1, 1, 3, 3]);
				expect(mod.seen('big')[0], 'first branch seeked').to.match(multiSeekRe('ix_v'));
				expect(mod.seen('big2')[0], 'second branch seeked').to.match(multiSeekRe('ix_v2'));
			});

			it('a DELETE driven by the key set seeks, and only the matched rows go', async () => {
				await db.exec(`insert into ksrc values (1, 20), (2, 40), (3, 60)`);
				mod.reset();
				await db.exec(`delete from big where v in (select k from ksrc)`);
				expect(mod.seen('big')[0], 'the delete read its victims through the seek')
					.to.match(multiSeekRe('ix_v'));
				const remaining = await asyncIterableToArray(db.eval(`select count(*) as c from big`));
				expect(remaining[0].c).to.equal(197);
				expect(await pks(`select pk from big where pk in (2, 4, 6)`)).to.deep.equal([]);
			});

			it('seeks with cross-type numeric keys (REAL keys, INTEGER column)', async () => {
				// The byte-encoding half of feat-key-set-seek-cross-type-keys: `encodeNumeric`
				// uses ONE numeric tag for both `number` and `bigint`, so 100.0 and 100 produce
				// identical key bytes and the window is exactly the qualifying rows. 55.5 keys
				// to a window of its own that holds nothing — no truncation to 55.
				await db.exec(`create table rsrc (id integer primary key, r real) using store`);
				await db.exec(`insert into rsrc values (1, 100.0), (2, 300.0), (3, 55.5)`);
				mod.reset();
				expect(await pks(`select pk from big where v in (select r from rsrc)`)).to.deep.equal([10, 30]);
				expect(mod.seen('big')[0], 'the store received a multi-seek').to.match(multiSeekRe('ix_v'));
				expect(mod.seen('big')[0]).to.contain('inCount=3');
			});

			it('an UPDATE driven by the key set seeks, and only the matched rows change', async () => {
				// A different write path from the DELETE above: the victims are read through
				// the seek, then rewritten — which also rewrites the very index the seek is
				// walking (w is unindexed here, so the walked windows stay put).
				await db.exec(`insert into ksrc values (1, 20), (2, 40)`);
				mod.reset();
				// `w` is seeded positive for every row, so -1 marks exactly what this ran on.
				await db.exec(`update big set w = -1 where v in (select k from ksrc)`);
				expect(mod.seen('big')[0], 'the update read its victims through the seek')
					.to.match(multiSeekRe('ix_v'));
				expect(await pks(`select pk from big where w = -1`)).to.deep.equal([2, 4]);
			});
		});

		it('a REAL key past 2^53 matches only the integer of equal magnitude', async () => {
			// `encodeNumeric`'s 8-byte tie-break tail is what makes this exact: 9007199254740992n
			// and 9007199254740992.0 share a nearest double AND a zero residual, so they encode
			// identically, while 9007199254740993n shares the double but carries residual 1 and
			// lands in a different window. Filler rows keep the seek cheaper than a scan.
			await db.exec(`create table bt (pk integer primary key, v integer) using store`);
			await db.exec(`create index ix_bt on bt (v)`);
			await db.exec(`create table bsrc (id integer primary key, r real) using store`);
			await db.exec(`insert into bt values ${
				Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
			await db.exec(`insert into bt values (201, 9007199254740992), (202, 9007199254740993)`);
			await db.exec(`insert into bsrc values (1, 9007199254740992.0)`);
			mod.reset();
			expect(await pks(`select pk from bt where v in (select r from bsrc)`),
				'the neighbour one above is not in the window').to.deep.equal([201]);
			expect(mod.seen('bt')[0], 'served as a multi-seek').to.match(multiSeekRe('ix_bt'));
		});

		it('seeks a DESC index column (seek keys sorted to match encoded-byte order)', async () => {
			await db.exec(`create table dt (pk integer primary key, v integer) using store`);
			await db.exec(`create index ix_dv on dt (v desc)`);
			await db.exec(`create table dsrc (id integer primary key, k integer) using store`);
			await db.exec(`insert into dt values (1, 10), (2, 20), (3, 30), (4, 40)`);
			await db.exec(`insert into dsrc values (1, 30), (2, 10), (3, 40)`);
			mod.reset();
			expect(await pks(`select pk from dt where v in (select k from dsrc)`)).to.deep.equal([1, 3, 4]);
			expect(mod.seen('dt')[0], 'the DESC index was seeked').to.match(multiSeekRe('ix_dv'));
		});

		it('seeks a one-column prefix of a composite index (seekWidth 1)', async () => {
			await db.exec(`create table ct (pk integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on ct (a, b)`);
			await db.exec(`create table csrc (id integer primary key, k integer) using store`);
			await db.exec(`insert into ct values (1, 1, 10), (2, 1, 20), (3, 2, 10), (4, 3, 10)`);
			await db.exec(`insert into csrc values (1, 1), (2, 3)`);
			mod.reset();
			// Each seek key is a PREFIX of the two-column index — scanMultiSeek builds a
			// range window per prefix rather than a point lookup.
			expect(await pks(`select pk from ct where a in (select k from csrc)`)).to.deep.equal([1, 2, 4]);
			expect(mod.seen('ct')[0]).to.match(multiSeekRe('ix_ab'));
			expect(mod.seen('ct')[0]).to.contain('inCount=2');
		});

		it('reads its own uncommitted writes through the seek (store pending ops)', async () => {
			// scanMultiSeek routes every window through scanIndex → iterateEffective, so a
			// row staged in the open transaction must surface / vanish exactly as committed
			// rows do. No isolation layer here: this is StoreTable's own pending-op merge.
			await db.exec(`create table rw (pk integer primary key, v integer) using store`);
			await db.exec(`create index ix_rw on rw (v)`);
			await db.exec(`create table rsrc (id integer primary key, k integer) using store`);
			await db.exec(`insert into rw values (1, 10), (2, 20), (3, 30), (4, 40)`);
			await db.exec(`insert into rsrc values (1, 20), (2, 50), (3, 30)`);

			await db.exec(`begin`);
			await db.exec(`insert into rw values (5, 50)`);   // staged insert, key IS in the set
			await db.exec(`update rw set v = 20 where pk = 4`); // staged move INTO the set
			await db.exec(`update rw set v = 99 where pk = 3`); // staged move OUT of the set
			mod.reset();
			const staged = await pks(`select pk from rw where v in (select k from rsrc)`);
			expect(mod.seen('rw')[0], 'still a seek, not a scan').to.match(multiSeekRe('ix_rw'));
			expect(staged, 'staged insert + move-in visible, move-out gone').to.deep.equal([2, 4, 5]);
			await db.exec(`commit`);
			mod.reset();
			expect(await pks(`select pk from rw where v in (select k from rsrc)`)).to.deep.equal([2, 4, 5]);
		});

		it('a staged delete of an in-set row does not surface through the seek', async () => {
			await db.exec(`create table dl (pk integer primary key, v integer) using store`);
			await db.exec(`create index ix_dl on dl (v)`);
			await db.exec(`create table dlsrc (id integer primary key, k integer) using store`);
			await db.exec(`insert into dl values (1, 10), (2, 20), (3, 30)`);
			await db.exec(`insert into dlsrc values (1, 10), (2, 30)`);

			await db.exec(`begin`);
			await db.exec(`delete from dl where pk = 1`);
			expect(await pks(`select pk from dl where v in (select k from dlsrc)`)).to.deep.equal([3]);
			await db.exec(`commit`);
			expect(await pks(`select pk from dl where v in (select k from dlsrc)`)).to.deep.equal([3]);
		});

		it('stops after the first resolution batch under `limit 1` rather than materializing all windows', async () => {
			// Emission is lazy in ROW_RESOLUTION_BATCH-bounded batches
			// (store-index-seek-batched-scan): `limit 1` collects and resolves ONE batch
			// of index entries — not one row, but also not the whole seek. Counted on the
			// DATA store: a drained 300-window seek resolves 300 index entries to data
			// rows (two batches), a stopped one at most 256 (one batch).
			const dataStores = new Map<string, CountingKVStore>();
			const cprovider = createCountingProvider(dataStores);
			const cdb = new Database();
			const cmod = new IdxStrCapturingStoreModule(cprovider);
			cdb.registerModule('store', cmod);
			try {
				await cdb.exec(`create table lz (pk integer primary key, v integer) using store`);
				await cdb.exec(`create index ix_lz on lz (v)`);
				await cdb.exec(`create table lsrc (id integer primary key, k integer) using store`);
				await cdb.exec(`insert into lz values ${
					Array.from({ length: 300 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
				await cdb.exec(`insert into lsrc values ${
					Array.from({ length: 300 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);

				const store = dataStores.get('main.lz')!;
				store.iterateEntryCount = 0;
				store.getCount = 0;
				store.getManyCalls = 0;
				cmod.reset();
				const rows = await asyncIterableToArray(cdb.eval(`select pk from lz where v in (select k from lsrc) limit 1`));
				expect(rows).to.have.lengthOf(1);
				expect(cmod.seen('lz')[0], 'a 300-key seek').to.match(multiSeekRe('ix_lz'));
				expect(store.iterateEntryCount, 'no data-store full scan').to.equal(0);
				expect(store.getManyCalls, 'no second batch after the limit').to.be.at.most(1);
				expect(store.getCount, 'bounded by one batch, not the whole seek')
					.to.be.at.most(ROW_RESOLUTION_BATCH);
			} finally {
				await cprovider.closeAll();
			}
		});

		describe('primary-key target', () => {
			// The PK arm used to match a `'='`-only operator group, so a key set on the primary
			// key found no claimable index and `rule-key-set-seek` kept the semi join it
			// started from. It now claims the IN (feat-store-pk-in-list-multiseek):
			// `scanMultiSeekPrimary` emits ascending by encoded data key — which IS primary-key
			// order — so the rewrite fires and the store point-reads the listed keys instead of
			// walking the table.
			//
			// This block covers the `in (select …)` caller specifically. Two things separate it
			// from the secondary-index block above, both settled by probe against the real
			// planner and pinned here:
			//
			// - `seekPreservesTargetOrder` HOLDS. The store leaf arrives as an ordering-only
			//   `IndexScan` over `_primary_` (`plan=0`, providing `[{column: 0, desc: false}]`),
			//   and the pushdown's claimed index is that same single-column `_primary_` — so the
			//   node claims the walk order, `order by pk` stays absorbed, and no `Sort`
			//   reappears. Every assertion here therefore reads RAW emission order.
			// - Both ARMS are reachable. `pk in (select k from …)` — the key column is an
			//   ordinary column — plans as a hash semi join; `pk in (select id from …)` — the
			//   key column is the SOURCE's primary key, so both sides walk in key order — plans
			//   as a MERGE semi join and takes `rule-key-set-seek`'s merge anchor, whose two
			//   extra gates (`seekPreservesTargetOrder`, and a key-source row estimate under
			//   `min(maxKeys, breakEvenKeys)`) both pass on these fixtures.
			//
			// Fixture size: `pkt` holds 4 rows, for which the store's costs put the interpolated
			// break-even at 6 keys — every set below it seeks. No padding needed.
			beforeEach(async () => {
				await db.exec(`create table pkt (pk integer primary key, tag text) using store`);
				await db.exec(`create table psrc (id integer primary key, k integer null) using store`);
				await db.exec(`insert into pkt values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')`);
			});

			const HASH_Q = `select pk from pkt where pk in (select k from psrc)`;
			const MERGE_Q = `select pk from pkt where pk in (select id from psrc)`;

			it('a runtime set on the PRIMARY KEY is served as a `_primary_` multi-seek', async () => {
				await db.exec(`insert into psrc values (1, 1), (2, 3), (3, 9)`);
				expect(await planOps(HASH_Q), 'the rule fires on a PK set').to.match(/KEYSETSEMIJOIN/);
				mod.reset();
				expect(await rawPks(HASH_Q), 'emitted ascending by primary key').to.deep.equal([1, 3]);
				expect(mod.seen('pkt'), 'the target was opened exactly once').to.have.lengthOf(1);
				expect(mod.seen('pkt')[0], 'served as a primary-key multi-seek')
					.to.match(multiSeekRe('_primary_'));
				expect(mod.seen('pkt')[0]).to.contain('inCount=3');
			});

			it('collapses duplicate and NULL inner values before stamping inCount', async () => {
				await db.exec(`insert into psrc values (1, 3), (2, 3), (3, null), (4, 1), (5, 3)`);
				mod.reset();
				expect(await rawPks(HASH_Q)).to.deep.equal([1, 3]);
				expect(mod.seen('pkt')[0]).to.match(multiSeekRe('_primary_'));
				expect(mod.seen('pkt')[0]).to.contain('inCount=2');
			});

			it('never opens the target when the key set is empty', async () => {
				mod.reset();
				expect(await rawPks(HASH_Q)).to.deep.equal([]);
				expect(mod.seen('pkt'), 'the store was never queried').to.have.lengthOf(0);
			});

			it('seeks a single-key set as a one-window multi-seek, not a plain EQ', async () => {
				await db.exec(`insert into psrc values (1, 2)`);
				mod.reset();
				expect(await rawPks(HASH_Q)).to.deep.equal([2]);
				expect(mod.seen('pkt')[0]).to.match(multiSeekRe('_primary_'));
				expect(mod.seen('pkt')[0]).to.contain('inCount=1');
			});

			it('a key set matching nothing returns no rows but still seeks', async () => {
				await db.exec(`insert into psrc values (1, 77), (2, 88)`);
				mod.reset();
				expect(await rawPks(HASH_Q)).to.deep.equal([]);
				expect(mod.seen('pkt')[0]).to.match(multiSeekRe('_primary_'));
			});

			it('the MERGE arm (key source ordered by its own primary key) seeks too', async () => {
				// `psrc.id` is that table's primary key, so both sides walk in key order and
				// `monotonic-merge-join` builds a MERGE semi join — the shape a PK target most
				// naturally hits. That the incoming join really is a merge join is visible in
				// the composite-key test below, where the rewrite declines and the MERGEJOIN
				// survives on this exact query shape.
				//
				// Both merge-only gates pass. The first is real: the seek reproduces the walk
				// order. The second — key-source rows under `min(maxKeys, breakEvenKeys)` —
				// passes vacuously, because a store leaf's PHYSICAL row estimate reads 0
				// however many rows are committed (measured: 7 rows, estimate 0). See the NOTE
				// at that gate in `rule-key-set-seek.ts`.
				await db.exec(`insert into psrc values (2, 0), (3, 0), (9, 0)`);
				expect(await planOps(MERGE_Q), 'the merge join was replaced').to.not.match(/MERGEJOIN/);
				expect(await planOps(MERGE_Q)).to.match(/KEYSETSEMIJOIN/);
				mod.reset();
				expect(await rawPks(MERGE_Q)).to.deep.equal([2, 3]);
				expect(mod.seen('pkt')[0]).to.match(multiSeekRe('_primary_'));
			});

			it('`order by pk` keeps the seek and the absorbed Sort, on both arms', async () => {
				// The ordering question this ticket exists to settle. `order by pk` is absorbed
				// into the leaf's walk (making its emission order load-bearing), which is a
				// DECLINE for a secondary-index target — but here the seek index IS the walk
				// index, so the node claims the leaf's order and the Sort stays absorbed. The
				// row order is asserted, not merely the absence of the Sort: the claim is only
				// sound because `scanMultiSeekPrimary` emits ascending by encoded data key.
				// `k` mirrors `id` so BOTH arms carry the same non-trivial key set {3,1,4} and
				// both can assert rows; the source rows are stored out of key order so an arm
				// that emitted in key-source order would be caught.
				await db.exec(`insert into psrc values (3, 3), (1, 1), (4, 4)`);
				for (const q of [
					`select pk from pkt where pk in (select k from psrc) order by pk`,
					`select pk from pkt where pk in (select id from psrc) order by pk`,
				]) {
					const ops = await planOps(q);
					expect(ops, `the rewrite fires despite orderingLoadBearing: ${q}`).to.match(/KEYSETSEMIJOIN/);
					expect(ops, `no Sort — the node serves the absorbed ORDER BY: ${q}`).to.not.match(/SORT/);
					expect((await keySetProps(q)).preservesTargetOrder,
						`the node claims the walk order: ${q}`).to.equal(true);
					mod.reset();
					expect(await rawPks(q), `rows actually ascend: ${q}`).to.deep.equal([1, 3, 4]);
					expect(mod.seen('pkt')[0], `and it is still a seek: ${q}`).to.match(multiSeekRe('_primary_'));
				}
			});

			it('`limit`/`offset` over the ordered seek trims after the seek, not before', async () => {
				// The seek window is the whole key set — the limit is applied above the node, so
				// `inCount` stays 3 while only the first rows are emitted. Pins that the ordered
				// PK seek composes with a limit, which is what makes `order by pk limit N` cheap.
				await db.exec(`insert into psrc values (1, 4), (2, 1), (3, 3)`);
				const ordered = (tail: string) =>
					`select pk from pkt where pk in (select k from psrc) order by pk ${tail}`;
				mod.reset();
				expect(await rawPks(ordered(`limit 2`))).to.deep.equal([1, 3]);
				expect(mod.seen('pkt')[0], 'one seek over all three keys').to.match(multiSeekRe('_primary_'));
				expect(mod.seen('pkt')[0]).to.contain('inCount=3');
				expect(await rawPks(ordered(`limit 2 offset 1`))).to.deep.equal([3, 4]);
			});

			it('a DESC primary key seeks, emits descending, and keeps its own `order by`', async () => {
				// `scanMultiSeekPrimary` sorts ascending by ENCODED data key, and per-column DESC
				// inversion is baked into those bytes — so the identical code emits DESCENDING
				// SQL values here, which is exactly this leaf's walk order.
				// `seekPreservesTargetOrder` compares the advertised direction against the index
				// key column's rather than assuming ascending, so it holds on a DESC key too.
				await db.exec(`create table dpk (pk integer, tag text, primary key (pk desc)) using store`);
				await db.exec(`insert into dpk values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')`);
				await db.exec(`insert into psrc values (1, 3), (2, 1), (3, 4)`);
				const bare = `select pk from dpk where pk in (select k from psrc)`;

				mod.reset();
				expect(await rawPks(bare), 'descending — the DESC walk order').to.deep.equal([4, 3, 1]);
				expect(mod.seen('dpk')[0]).to.match(multiSeekRe('_primary_'));

				expect(await planOps(`${bare} order by pk desc`),
					'the absorbed DESC Sort stays absorbed').to.not.match(/SORT/);
				mod.reset();
				expect(await rawPks(`${bare} order by pk desc`)).to.deep.equal([4, 3, 1]);
				expect(mod.seen('dpk')[0]).to.match(multiSeekRe('_primary_'));

				// ASC over a DESC key is NOT the walk order, so that Sort was never absorbed and
				// survives as a real Sort — with the seek still taken underneath it.
				expect(await planOps(`${bare} order by pk asc`),
					'a real Sort, not an absorbed one').to.match(/SORT/);
				mod.reset();
				expect(await rawPks(`${bare} order by pk asc`)).to.deep.equal([1, 3, 4]);
				expect(mod.seen('dpk')[0], 'still a seek, just re-sorted above').to.match(multiSeekRe('_primary_'));
			});

			it('a TEXT primary key under COLLATE NOCASE seeks and matches case-insensitively', async () => {
				// The seek keys are encoded under the primary key's OWN key collation, so a
				// key-source value differing only in case still lands on the row's byte key —
				// the property a BINARY-encoded seek over a NOCASE key would silently lose,
				// returning no rows where the walk would have matched.
				await db.exec(`create table tpk (pk text primary key collate nocase, tag text) using store`);
				await db.exec(`create table tsrc (id integer primary key, k text) using store`);
				await db.exec(`insert into tpk values ('Alpha', 'a'), ('beta', 'b'), ('Gamma', 'c')`);
				await db.exec(`insert into tsrc values (1, 'ALPHA'), (2, 'gamma'), (3, 'missing')`);
				mod.reset();
				expect(await asyncIterableToArray(db.eval(`select pk from tpk where pk in (select k from tsrc)`)),
					'case-insensitive hits, in key order').to.deep.equal([{ pk: 'Alpha' }, { pk: 'Gamma' }]);
				expect(mod.seen('tpk')[0]).to.match(multiSeekRe('_primary_'));
				expect(mod.seen('tpk')[0]).to.contain('inCount=3');
			});

			it('a COMPOSITE primary key declines the rewrite and the merge join answers', async () => {
				// `claimedIndex` declines any plan claiming more than one seek column, and the
				// store's PK arm only claims a key that is pinned in FULL — so a set on the
				// LEADING column of a composite key is claimed by neither side and the semi
				// join survives untouched. Documented restriction, not a bug: sorting by
				// single-column SQL value order equals index-key order only for a single key
				// column (see `seekPreservesTargetOrder`).
				await db.exec(`create table comp (a integer, b integer, tag text, primary key (a, b)) using store`);
				await db.exec(`insert into comp values (1, 1, 'x'), (1, 2, 'y'), (2, 1, 'z'), (3, 1, 'w')`);
				await db.exec(`insert into psrc values (1, 0), (3, 0)`);

				const q = `select a, b from comp where a in (select id from psrc)`;
				const ops = await planOps(q);
				expect(ops, 'no rewrite').to.not.match(/KEYSETSEMIJOIN/);
				expect(ops, 'the streaming merge semi join survives').to.match(/MERGEJOIN/);
				mod.reset();
				const rows = await asyncIterableToArray(db.eval(q));
				expect(rows, 'and it still answers').to.deep.equal([
					{ a: 1, b: 1 }, { a: 1, b: 2 }, { a: 3, b: 1 },
				]);
				expect(mod.seen('comp')[0], 'the target was walked, not seeked').to.match(SCAN_RE);
			});

			it('a DELETE driven by the key set seeks, and only the matched rows go', async () => {
				await db.exec(`insert into psrc values (1, 2), (2, 4)`);
				mod.reset();
				await db.exec(`delete from pkt where pk in (select k from psrc)`);
				expect(mod.seen('pkt')[0], 'the delete read its victims through the seek')
					.to.match(multiSeekRe('_primary_'));
				expect(await rawPks(`select pk from pkt`)).to.deep.equal([1, 3]);
			});

			it('an UPDATE driven by the key set seeks, and only the matched rows change', async () => {
				// The victims are read through the `_primary_` seek and then rewritten in
				// place — the very structure the seek is walking.
				await db.exec(`insert into psrc values (1, 2), (2, 4)`);
				mod.reset();
				await db.exec(`update pkt set tag = 'hit' where pk in (select k from psrc)`);
				expect(mod.seen('pkt')[0], 'the update read its victims through the seek')
					.to.match(multiSeekRe('_primary_'));
				expect(await asyncIterableToArray(db.eval(`select pk, tag from pkt`))).to.deep.equal([
					{ pk: 1, tag: 'a' }, { pk: 2, tag: 'hit' }, { pk: 3, tag: 'c' }, { pk: 4, tag: 'hit' },
				]);
			});

			it('reads its own uncommitted writes through the seek (store pending ops)', async () => {
				// The `_primary_` twin of the secondary-index case below: no isolation layer,
				// so this is StoreTable's own pending-op merge — `scanMultiSeekPrimary` resolves
				// its sorted key list through `readEffectiveRowsByKeys`, which consults the open
				// transaction's staged rows before the committed ones. Raw emission order, so a
				// staged row landing out of key order would fail here too.
				await db.exec(`insert into psrc values (1, 2), (2, 3), (3, 5)`);
				await db.exec(`begin`);
				await db.exec(`insert into pkt values (5, 'staged')`);      // staged insert, key IS in the set
				await db.exec(`update pkt set tag = 'restaged' where pk = 3`); // staged in-place update
				await db.exec(`delete from pkt where pk = 2`);               // staged delete of an in-set row
				mod.reset();
				expect(await asyncIterableToArray(db.eval(`select pk, tag from pkt where pk in (select k from psrc)`)))
					.to.deep.equal([{ pk: 3, tag: 'restaged' }, { pk: 5, tag: 'staged' }]);
				expect(mod.seen('pkt')[0], 'still a seek, not a scan').to.match(multiSeekRe('_primary_'));
				await db.exec(`commit`);
				mod.reset();
				expect(await rawPks(HASH_Q)).to.deep.equal([3, 5]);
				expect(mod.seen('pkt')[0]).to.match(multiSeekRe('_primary_'));
			});
		});

		describe('gates that must decline (the hash semi join answers instead)', () => {
			it('an `any` column with a declared COLLATE multi-seeks, and the answer is unchanged', async () => {
				// `ANY_TYPE.compare` honors the collation it is handed
				// (any-type-compare-honors-collation), so an `any collate nocase` index keys
				// under NOCASE — the same collation the residual and the join probe compare
				// under — and the multi-seek window is exactly the qualifying set, like the
				// `text collate nocase` arm below.
				await db.exec(`create table cif (pk integer primary key, s any collate nocase) using store`);
				await db.exec(`create index ix_cif on cif (s)`);
				await db.exec(`create table cifsrc (id integer primary key, s any collate nocase) using store`);
				await db.exec(`insert into cif values (1, 'Alpha'), (2, 'beta'), (3, 'GAMMA')`);
				await db.exec(`insert into cifsrc values (1, 'alpha'), (2, 'gamma')`);

				const q = `select pk from cif where s in (select s from cifsrc)`;
				expect(await planOps(q), 'the rule fires').to.match(/KEYSETSEMIJOIN/);
				mod.reset();
				expect(await pks(q), 'NOCASE equality still matches both rows').to.deep.equal([1, 3]);
				expect(mod.seen('cif')[0], 'served as a multi-seek').to.match(/plan=5/);
			});

			it('a NOCASE column of a K=BINARY store now SEEKS, and the answer is unchanged', async () => {
				// The arm the guard collapse restored: index bytes encode under the column's
				// own NOCASE, which is also what the residual and the join probe compare
				// under, so the multi-seek window is exactly the qualifying set.
				await db.exec(`create table cnk (pk integer primary key, s text collate nocase) using store (collation = binary)`);
				await db.exec(`create index ix_cnk on cnk (s)`);
				await db.exec(`create table cnksrc (id integer primary key, s text collate nocase) using store (collation = binary)`);
				await db.exec(`insert into cnk values (1, 'Alpha'), (2, 'beta'), (3, 'GAMMA')`);
				await db.exec(`insert into cnksrc values (1, 'alpha'), (2, 'gamma')`);

				const q = `select pk from cnk where s in (select s from cnksrc)`;
				expect(await planOps(q), 'the rule fires').to.match(/KEYSETSEMIJOIN/);
				mod.reset();
				expect(await pks(q), 'NOCASE equality still matches both rows').to.deep.equal([1, 3]);
				expect(mod.seen('cnk')[0], 'served as a multi-seek').to.match(/plan=5/);
			});

			it('a plain BINARY column of a NOCASE-keyed store seeks and returns only the BINARY match', async () => {
				// The store's default K is NOCASE, but an undecorated `text` column keys
				// BINARY — K is not part of the index seek decision. So 'alpha' and 'ALPHA'
				// occupy DISTINCT windows and the seek for 'alpha' never fetches row 2 in the
				// first place. (It used to share one K-encoded window and rely on the semi
				// join's probe to trim the over-fetch; the probe still runs, it just has
				// nothing to trim here.)
				await db.exec(`create table cb (pk integer primary key, s text) using store`);
				await db.exec(`create index ix_cb on cb (s)`);
				await db.exec(`create table cbsrc (id integer primary key, s text) using store`);
				await db.exec(`insert into cb values (1, 'alpha'), (2, 'ALPHA'), (3, 'beta')`);
				await db.exec(`insert into cbsrc values (1, 'alpha')`);
				mod.reset();
				expect(await pks(`select pk from cb where s in (select s from cbsrc)`),
					'the BINARY-distinct case variant is not a match').to.deep.equal([1]);
				expect(mod.seen('cb')[0], 'the seek did happen').to.match(multiSeekRe('ix_cb'));
			});
		});

		describe('the engine ceiling on seek keys', () => {
			// OBSERVED BREAK-EVEN, recorded per the ticket: on this table the interpolated
			// `breakEvenKeys` clamps at the engine's 1000-key ceiling — i.e. the runtime seeks
			// for every set size it is allowed to. That is the store's own cost model being
			// consistent, not this rule misreading it: `cap` holds exactly 1000 rows, and a
			// 1000-key seek (cost 800) still beats a full scan of 1000 rows (cost 1000).
			// Over-seeking costs performance only — the semi join's probe re-checks every
			// emitted row.
			//
			// The 1000 is now the table's REAL size rather than a placeholder that happened to
			// match: since debt-store-analyze-row-count, `StoreModule.getBestAccessPlan` fills
			// `request.estimatedRows` in from the row count the store maintains whenever the
			// planner has no ANALYZE snapshot to hand it. The numbers below are unchanged
			// because the two coincide at this table's size; seed a different row count and the
			// break-even moves with it.
			//
			// The interpolation arm itself is pinned cheaply in
			// "break-even interpolated from doctored store costs" below.
			beforeEach(async () => {
				await db.exec(`create table cap (pk integer primary key, v integer) using store`);
				await db.exec(`create index ix_cap on cap (v)`);
				await db.exec(`create table capsrc (id integer primary key, k integer) using store`);
				await db.exec(`insert into cap values ${
					Array.from({ length: 1000 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
			});

			const seedKeys = async (count: number): Promise<void> => {
				await db.exec(`delete from capsrc`);
				await db.exec(`insert into capsrc values ${
					Array.from({ length: count }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
			};

			/** Rows and the store's idxStr for the key-set query at `count` distinct keys. */
			async function runWithKeys(count: number): Promise<{ pks: number[]; idxStr: string }> {
				await seedKeys(count);
				mod.reset();
				const rows = await asyncIterableToArray(db.eval(`select pk from cap where v in (select k from capsrc)`));
				return {
					pks: rows.map(r => r.pk as number).sort((a, b) => a - b),
					idxStr: mod.seen('cap')[0] ?? '',
				};
			}

			it(`seeks at exactly ${ENGINE_SEEK_CEILING} keys, scans one above, and both return identical rows`, async () => {
				// The push/scan equivalence check, run through the store: the two paths must
				// be observationally identical. Every key here matches a row, so the extra
				// key in the second run adds no row and the two answers are the same set.
				const at = await runWithKeys(ENGINE_SEEK_CEILING);
				expect(at.idxStr, 'at the ceiling the store seeks').to.match(multiSeekRe('ix_cap'));
				expect(at.idxStr).to.contain(`inCount=${ENGINE_SEEK_CEILING}`);

				const over = await runWithKeys(ENGINE_SEEK_CEILING + 1);
				expect(over.idxStr, 'one key above it the store is walked, not seeked')
					.to.match(SCAN_RE);

				const allPks = Array.from({ length: 1000 }, (_, i) => i + 1);
				expect(at.pks, 'seek path').to.deep.equal(allPks);
				expect(over.pks, 'scan path returns the same rows').to.deep.equal(allPks);
			});
		});

		describe('break-even interpolated from doctored store costs', () => {
			// The store's real costs make the interpolated break-even clamp at the ceiling
			// (see the note above), so the interpolation arm itself would never be
			// exercised. Patch only the COSTS the three synthesized probes see — the claim
			// (index, seek columns) stays the real module's answer, so the runtime path is
			// unchanged:
			//
			//   runtime-set probe: cost = 1 + 10·maxCount → 21 @2 keys, 10001 @1000
			//   scan probe:        cost = 71
			//   slope = (10001 − 21) / 998 = 10   ⇒   breakEven = floor(2 + (71 − 21)/10) = 7
			class DoctoredCostStoreModule extends IdxStrCapturingStoreModule {
				override getBestAccessPlan(
					db: Database,
					tableInfo: TableSchema,
					request: BestAccessPlanRequest,
				): BestAccessPlanResult {
					const plan = super.getBestAccessPlan(db, tableInfo, request);
					if (tableInfo.name.toLowerCase() !== 'be') return plan;
					const runtimeSet = request.filters.find(f => f.runtimeSet)?.runtimeSet;
					if (runtimeSet) return { ...plan, cost: 1 + 10 * runtimeSet.maxCount };
					if (request.filters.length === 0) return { ...plan, cost: 71 };
					return plan;
				}
			}

			let bdb: Database;
			let bprovider: KVStoreProvider;
			let bmod: DoctoredCostStoreModule;

			beforeEach(async () => {
				bprovider = createInMemoryProvider();
				bmod = new DoctoredCostStoreModule(bprovider);
				bdb = new Database();
				bdb.registerModule('store', bmod);
				await bdb.exec(`create table be (pk integer primary key, v integer) using store`);
				await bdb.exec(`create index ix_be on be (v)`);
				await bdb.exec(`create table besrc (id integer primary key, k integer) using store`);
				await bdb.exec(`insert into be values ${
					Array.from({ length: 30 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
			});

			afterEach(async () => {
				await bprovider.closeAll();
			});

			async function runWithKeys(count: number): Promise<{ pks: number[]; idxStr: string }> {
				await bdb.exec(`delete from besrc`);
				await bdb.exec(`insert into besrc values ${
					Array.from({ length: count }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
				bmod.reset();
				const rows = await asyncIterableToArray(bdb.eval(`select pk from be where v in (select k from besrc)`));
				return {
					pks: rows.map(r => r.pk as number).sort((a, b) => a - b),
					idxStr: bmod.seen('be')[0] ?? '',
				};
			}

			it('seeks at exactly breakEvenKeys, scans one above, and both return identical rows', async () => {
				const at = await runWithKeys(7);
				expect(at.idxStr, '7 keys — at the break-even — seeks').to.match(multiSeekRe('ix_be'));
				expect(at.idxStr).to.contain('inCount=7');

				const over = await runWithKeys(8);
				expect(over.idxStr, '8 keys — over the break-even — scans').to.match(SCAN_RE);

				expect(at.pks).to.deep.equal([1, 2, 3, 4, 5, 6, 7]);
				expect(over.pks, 'the scan path returns the 7-key rows plus the 8th match')
					.to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
			});
		});

		// A backend that declares its seeks expensive (`store-backend-cost-profile`) moves
		// where this rewrite pays off, and that movement has to be a TESTED outcome rather
		// than a surprise. Everything above runs on a provider declaring nothing (parity), so
		// these are the only tests here that see a declared profile.
		//
		// The engine probes the module at 2 and 1000 seek keys, fits a line, and solves for
		// the key count at which a seek overtakes the displaced plan. With the store's
		// multi-seek cost `k·S + 0.3·min(N, k·0.1N)` against a scan baseline of `N`, the
		// break-even lands at roughly `N/(2S)` — so raising `seekPositioning` from the parity
		// 0.5 to IndexedDB's declared 5.0 divides it by ten.
		describe('a backend declaring expensive seeks (IndexedDB profile)', () => {
			/** IndexedDB's declared profile — see `packages/quereus-plugin-indexeddb/src/provider.ts`. */
			const IDB_PROFILE: KVCostProfile = { pointRead: 3.0, seekPositioning: 5.0 };

			/**
			 * A fresh database over a provider declaring `profile`, holding `big` (`rowCount`
			 * rows, indexed on `v`) and a 3-key `ksrc`.
			 */
			async function seed(profile: KVCostProfile | undefined, rowCount: number): Promise<{
				db: Database;
				provider: KVStoreProvider;
				mod: IdxStrCapturingStoreModule;
			}> {
				const provider = createInMemoryProvider(profile);
				const mod = new IdxStrCapturingStoreModule(provider);
				const db = new Database();
				db.registerModule('store', mod);
				await db.exec(`create table big (pk integer primary key, v integer) using store`);
				await db.exec(`create index ix_v on big (v)`);
				await db.exec(`create table ksrc (id integer primary key, k integer) using store`);
				await db.exec(`insert into big values ${
					Array.from({ length: rowCount }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
				await db.exec(`insert into ksrc values (1, 10), (2, 20), (3, 30)`);
				mod.reset();
				return { db, provider, mod };
			}

			const KEY_SET_QUERY = `select pk from big where v in (select k from ksrc)`;

			/** The `query_plan()` op names for `query` on `db`, as a JSON array string. */
			const opsOf = async (db: Database, query: string): Promise<string> => {
				const rows = await asyncIterableToArray(
					db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]));
				return rows[0].ops as string;
			};

			it('still rewrites, and still seeks, on a 200-row table', async () => {
				const { db, provider, mod } = await seed(IDB_PROFILE, 200);
				try {
					// Break-even at N=200, S=5: seek costs 22 at 2 keys and 5,060 at 1,000, so the
					// line through them crosses the 200-row scan baseline around 37 keys — well
					// above the 3 keys this query carries.
					expect(await opsOf(db, KEY_SET_QUERY), 'the rewrite fired').to.contain('KEYSETSEMIJOIN');
					mod.reset();
					const rows = await asyncIterableToArray(db.eval(KEY_SET_QUERY));
					expect(rows.map(r => r.pk as number).sort((a, b) => a - b)).to.deep.equal([1, 2, 3]);
					expect(mod.seen('big')[0], 'the store served it as a multi-seek')
						.to.match(multiSeekRe('ix_v'));
				} finally {
					await provider.closeAll();
				}
			});

			it('declines the rewrite on a tiny table — and returns the parity rows anyway', async () => {
				// The deliberate behavior change. At 5 rows the two-key probe already costs more
				// than the whole scan (10.6 vs 5), so `interpolateBreakEven` returns 0 and
				// `rule-key-set-seek` declines outright. Right answer, right cost — a 5-row seek
				// on this backend is five IPC round trips to avoid reading five rows.
				const scaled = await seed(IDB_PROFILE, 5);
				const parity = await seed(undefined, 5);
				try {
					expect(await opsOf(scaled.db, KEY_SET_QUERY), 'the expensive backend declines')
						.to.not.contain('KEYSETSEMIJOIN');
					expect(await opsOf(parity.db, KEY_SET_QUERY), 'a parity backend still rewrites')
						.to.contain('KEYSETSEMIJOIN');

					const rowsOf = async (db: Database): Promise<number[]> =>
						(await asyncIterableToArray(db.eval(KEY_SET_QUERY)))
							.map(r => r.pk as number).sort((a, b) => a - b);
					const scaledRows = await rowsOf(scaled.db);
					expect(scaledRows, 'declining the rewrite never changes the answer')
						.to.deep.equal(await rowsOf(parity.db));
					expect(scaledRows).to.deep.equal([1, 2, 3]);
				} finally {
					await scaled.provider.closeAll();
					await parity.provider.closeAll();
				}
			});
		});
	});

	describe('store behind the isolation layer', () => {
		// The production stack (`createIsolatedStoreModule` builds exactly this pair; it is
		// assembled by hand here only so the underlying StoreModule can be instrumented).
		// A merged secondary-index read runs `IsolatedTable.buildConstraintMatcher` over the
		// staged rows: our stamped FilterInfo carries K EQ constraints on one column, which
		// must decompose into the same per-column IN set a literal list produces.
		let db: Database;
		let provider: KVStoreProvider;
		let mod: IdxStrCapturingStoreModule;

		beforeEach(async () => {
			db = new Database();
			provider = createInMemoryProvider();
			mod = new IdxStrCapturingStoreModule(provider);
			db.registerModule('store', new IsolationModule({
				underlying: mod,
				overlay: new MemoryTableModule(),
			}));
			await db.exec(`create table t (pk integer primary key, v integer, tag text) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`create table ksrc (id integer primary key, k integer) using store`);
			await db.exec(`insert into t values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd')`);
			await db.exec(`insert into ksrc values (1, 20), (2, 30), (3, 50)`);
		});

		afterEach(async () => {
			await provider.closeAll();
		});

		const rowsOf = async (q: string): Promise<Record<string, SqlValue>[]> =>
			(await asyncIterableToArray(db.eval(q)))
				.sort((a, b) => (a.pk as number) - (b.pk as number)) as Record<string, SqlValue>[];

		const KEY_SET_QUERY = `select pk, v, tag from t where v in (select k from ksrc)`;

		/** Assert the underlying store really served this read as a multi-seek. */
		function expectStoreSeeked(): void {
			expect(mod.seen('t')[0], 'the store served a multi-seek under isolation')
				.to.match(multiSeekRe('ix_v'));
		}

		it('a staged insert whose key is in the set surfaces', async () => {
			await db.exec(`begin`);
			await db.exec(`insert into t values (5, 50, 'e')`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
				{ pk: 5, v: 50, tag: 'e' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('a staged update that moves a row INTO the set surfaces, once, in its new form', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set v = 50, tag = 'moved-in' where pk = 1`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 1, v: 50, tag: 'moved-in' },
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('a staged update that moves a row OUT of the set stops surfacing', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set v = 999 where pk = 2`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('a staged in-place update of an in-set row appears exactly once, in its new form', async () => {
			// The shadowing case: the committed row is inside the seek window AND the staged
			// row is too. Both streams carry it, so a merge slip would emit it twice.
			await db.exec(`begin`);
			await db.exec(`update t set tag = 'rewritten' where pk = 3`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'rewritten' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('a staged delete of an in-set row does not resurface', async () => {
			await db.exec(`begin`);
			await db.exec(`delete from t where pk = 2`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('staged rows outside the seek window are excluded by the overlay predicate', async () => {
			// The overlay is full-scanned, so EVERY staged row reaches
			// `buildConstraintMatcher`; only the window predicate keeps the out-of-window
			// ones out. If the K EQ constraints failed to decompose into an IN set, either
			// nothing would match (AND of mutually exclusive equalities) or everything would.
			await db.exec(`begin`);
			await db.exec(`insert into t values (6, 60, 'out'), (7, 20, 'in')`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
				{ pk: 7, v: 20, tag: 'in' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('emits every row exactly once when several staged rows interleave with the seek windows', async () => {
			// Emission-order check for the secondary-index merge path: the engine sorts the
			// seek keys before stamping, so the underlying stream arrives in index-key order
			// and the sorted overlay rows interleave against it. Staged keys deliberately
			// straddle the committed ones.
			await db.exec(`begin`);
			await db.exec(`insert into ksrc values (4, 10), (5, 40)`);
			await db.exec(`insert into t values (8, 40, 'x'), (9, 10, 'y')`);
			await db.exec(`update t set tag = 'z' where pk = 4`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 1, v: 10, tag: 'a' },
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
				{ pk: 4, v: 40, tag: 'z' },
				{ pk: 8, v: 40, tag: 'x' },
				{ pk: 9, v: 10, tag: 'y' },
			]);
			expectStoreSeeked();
			await db.exec(`rollback`);
		});

		it('deletes through the seek inside a transaction, reads back, then commits', async () => {
			await db.exec(`begin`);
			mod.reset();
			await db.exec(`delete from t where v in (select k from ksrc)`);
			expect(mod.seen('t')[0], 'the delete read its victims through the seek')
				.to.match(multiSeekRe('ix_v'));
			expect(await rowsOf(`select pk, v, tag from t`), 'in-transaction read-back').to.deep.equal([
				{ pk: 1, v: 10, tag: 'a' },
				{ pk: 4, v: 40, tag: 'd' },
			]);
			await db.exec(`commit`);
			expect(await rowsOf(`select pk, v, tag from t`), 'after commit').to.deep.equal([
				{ pk: 1, v: 10, tag: 'a' },
				{ pk: 4, v: 40, tag: 'd' },
			]);
		});

		it('a rolled-back staged change leaves the committed answer intact', async () => {
			await db.exec(`begin`);
			await db.exec(`insert into t values (5, 50, 'e')`);
			await db.exec(`delete from t where pk = 3`);
			await db.exec(`rollback`);
			mod.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expectStoreSeeked();
		});

		describe('primary-key target', () => {
			// The case `bug-isolation-multiseek-merge-order` was filed for, now reached
			// through the store rather than the memory backend: the isolation layer merges
			// the underlying stream with its overlay BY PRIMARY KEY, assuming both arrive
			// ascending. `scanMultiSeekPrimary`'s ascending-encoded-data-key emission is what
			// satisfies that assumption on the store side, and nothing re-sorts afterwards —
			// so every assertion below reads RAW emission order. A merge slip shows up as a
			// stale row beside its updated copy, a resurrected delete, or simply the wrong
			// order; sorting the rows in JS first would hide all three.
			//
			// Unlike the secondary-index block above, the target's own walk order is the one
			// being asserted, so `seekPreservesTargetOrder` holds and an `order by pk` (used
			// nowhere here — the raw order already ascends) would stay absorbed.
			beforeEach(async () => {
				await db.exec(`create table pt (pk integer primary key, tag text) using store`);
				await db.exec(`create table pksrc (id integer primary key, k integer null) using store`);
				await db.exec(`insert into pt values (10, 'a'), (20, 'b'), (30, 'c'), (40, 'd')`);
				await db.exec(`insert into pksrc values (1, 20), (2, 30), (3, 50)`);
			});

			/** RAW emission order — deliberately NOT sorted (see the block comment). */
			const pkRowsOf = async (q: string): Promise<Record<string, SqlValue>[]> =>
				(await asyncIterableToArray(db.eval(q))) as Record<string, SqlValue>[];

			const PK_QUERY = `select pk, tag from pt where pk in (select k from pksrc)`;

			/** Assert the underlying store really served this read as a `_primary_` multi-seek. */
			function expectPkSeeked(): void {
				expect(mod.seen('pt')[0], 'the store served a primary-key multi-seek under isolation')
					.to.match(multiSeekRe('_primary_'));
			}

			it('a staged insert whose key is in the set surfaces', async () => {
				await db.exec(`begin`);
				await db.exec(`insert into pt values (50, 'e')`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY)).to.deep.equal([
					{ pk: 20, tag: 'b' },
					{ pk: 30, tag: 'c' },
					{ pk: 50, tag: 'e' },
				]);
				expectPkSeeked();
				await db.exec(`rollback`);
			});

			it('a staged in-place update of an in-set row appears exactly once, in its new form', async () => {
				// The shadowing case: the committed row is inside the seek window AND the
				// staged row is too, so both streams carry it and a merge slip emits it twice.
				await db.exec(`begin`);
				await db.exec(`update pt set tag = 'rewritten' where pk = 30`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY)).to.deep.equal([
					{ pk: 20, tag: 'b' },
					{ pk: 30, tag: 'rewritten' },
				]);
				expectPkSeeked();
				await db.exec(`rollback`);
			});

			it('a staged delete of an in-set row does not resurface', async () => {
				await db.exec(`begin`);
				await db.exec(`delete from pt where pk = 20`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY)).to.deep.equal([
					{ pk: 30, tag: 'c' },
				]);
				expectPkSeeked();
				await db.exec(`rollback`);
			});

			it('staged rows outside the key list are excluded by the overlay predicate', async () => {
				// The overlay is full-scanned, so EVERY staged row reaches
				// `buildConstraintMatcher`; only the window predicate keeps the out-of-list
				// ones out. If the K EQ constraints failed to decompose into an IN set, either
				// nothing would match (AND of mutually exclusive equalities) or everything would.
				await db.exec(`begin`);
				await db.exec(`insert into pt values (60, 'out'), (50, 'in')`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY)).to.deep.equal([
					{ pk: 20, tag: 'b' },
					{ pk: 30, tag: 'c' },
					{ pk: 50, tag: 'in' },
				]);
				expectPkSeeked();
				await db.exec(`rollback`);
			});

			it('several staged rows straddling the committed keys interleave in key order', async () => {
				// Staged keys deliberately fall BETWEEN committed ones, so a merge that
				// appended one stream to the other — or visited the seek windows in key-source
				// order — would emit these out of order even though the row SET is right.
				await db.exec(`insert into pksrc values (4, 10), (5, 25), (6, 40)`);
				await db.exec(`begin`);
				await db.exec(`insert into pt values (25, 'x'), (50, 'y')`);
				await db.exec(`update pt set tag = 'z' where pk = 30`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY), 'ascending by primary key, each row once').to.deep.equal([
					{ pk: 10, tag: 'a' },
					{ pk: 20, tag: 'b' },
					{ pk: 25, tag: 'x' },
					{ pk: 30, tag: 'z' },
					{ pk: 40, tag: 'd' },
					{ pk: 50, tag: 'y' },
				]);
				expectPkSeeked();
				await db.exec(`rollback`);
			});

			it('deletes through the seek inside a transaction, reads back, then commits', async () => {
				await db.exec(`begin`);
				mod.reset();
				await db.exec(`delete from pt where pk in (select k from pksrc)`);
				expect(mod.seen('pt')[0], 'the delete read its victims through the seek')
					.to.match(multiSeekRe('_primary_'));
				expect(await pkRowsOf(`select pk, tag from pt`), 'in-transaction read-back').to.deep.equal([
					{ pk: 10, tag: 'a' },
					{ pk: 40, tag: 'd' },
				]);
				await db.exec(`commit`);
				expect(await pkRowsOf(`select pk, tag from pt`), 'after commit').to.deep.equal([
					{ pk: 10, tag: 'a' },
					{ pk: 40, tag: 'd' },
				]);
			});

			it('a rolled-back staged change leaves the committed answer intact', async () => {
				await db.exec(`begin`);
				await db.exec(`insert into pt values (50, 'e')`);
				await db.exec(`delete from pt where pk = 30`);
				await db.exec(`rollback`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY)).to.deep.equal([
					{ pk: 20, tag: 'b' },
					{ pk: 30, tag: 'c' },
				]);
				expectPkSeeked();
			});

			it('NULL and duplicate key-source values collapse before the seek, overlay included', async () => {
				// The engine builds the key set before the target opens, so the overlay never
				// sees the NULL or the duplicates — but the staged row still has to survive the
				// collapsed set. `inCount` pins that the set really was deduplicated.
				await db.exec(`insert into pksrc values (4, null), (5, 30), (6, 20)`);
				await db.exec(`begin`);
				await db.exec(`insert into pt values (50, 'staged')`);
				mod.reset();
				expect(await pkRowsOf(PK_QUERY)).to.deep.equal([
					{ pk: 20, tag: 'b' },
					{ pk: 30, tag: 'c' },
					{ pk: 50, tag: 'staged' },
				]);
				expect(mod.seen('pt')[0], 'three distinct non-null keys').to.contain('inCount=3');
				expectPkSeeked();
				await db.exec(`rollback`);
			});

			it('a DESC primary key merges with the overlay in DESCENDING key order', async () => {
				// The isolation merge follows the key's own direction, and the seek supplies it
				// for free: ascending-encoded-key emission IS descending SQL order on a DESC key.
				// A merge that assumed ascending VALUES would interleave the staged rows wrong
				// even though the row SET came out right — so the order here is the assertion.
				await db.exec(`create table dpt (pk integer, tag text, primary key (pk desc)) using store`);
				await db.exec(`insert into dpt values (10, 'a'), (20, 'b'), (30, 'c'), (40, 'd')`);
				await db.exec(`begin`);
				await db.exec(`insert into dpt values (50, 'e')`);
				await db.exec(`update dpt set tag = 'rewritten' where pk = 30`);
				mod.reset();
				expect(await pkRowsOf(`select pk, tag from dpt where pk in (select k from pksrc)`)).to.deep.equal([
					{ pk: 50, tag: 'e' },
					{ pk: 30, tag: 'rewritten' },
					{ pk: 20, tag: 'b' },
				]);
				expect(mod.seen('dpt')[0], 'the store served a primary-key multi-seek under isolation')
					.to.match(multiSeekRe('_primary_'));
				await db.exec(`rollback`);
			});
		});
	});
});
