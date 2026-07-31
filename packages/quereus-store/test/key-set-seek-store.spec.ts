/**
 * The key-set semi join (`where col in (select …)`, feat-key-set-semi-join) driven
 * end to end against the PERSISTENT STORE backend, and against that backend behind
 * the transaction isolation layer.
 *
 * The engine rewrites the target leaf's `FilterInfo` at runtime into an ordinary
 * single-column `plan=5` multi-seek — byte-identical to what a literal `in (1,2,3)`
 * produces — so `StoreTable.scanMultiSeek` and `IsolatedTable`'s merged secondary
 * read serve it without knowing where the values came from. These tests prove that
 * for the real store: the seek actually happens (the `idxStr` the store receives is
 * captured, not inferred), uncommitted rows are visible through it, and every gate
 * that must decline still does.
 *
 * Two facts shape every test here:
 *
 * - **No `order by` on a column the target leaf's own walk already provides.** The
 *   store advertises primary-key order, so `… order by pk` is absorbed into the leaf
 *   at plan time, which marks its emission order load-bearing and makes
 *   `rule-key-set-seek` decline (correctly — a multi-seek emits in seek-key order).
 *   Rows are therefore collected unordered and sorted in JS.
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
	type KVStoreProvider,
	type StoreModuleConfig,
	type IterateOptions,
	type KVEntry,
} from '../src/index.js';

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
 * In-memory data store that tallies how many entries its `iterate` yields and how
 * many point `get`s it serves — the only way to tell a narrow seek from a full scan
 * that post-filters to the same rows.
 */
class CountingKVStore extends InMemoryKVStore {
	public iterateEntryCount = 0;
	public getCount = 0;
	override async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		for await (const entry of super.iterate(options)) {
			this.iterateEntryCount++;
			yield entry;
		}
	}
	override async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		this.getCount++;
		return super.get(key);
	}
}

/**
 * Provider whose DATA stores are {@link CountingKVStore}s (recorded in `dataStores`,
 * keyed `schema.table`); index / stats / catalog stores stay plain so only data-row
 * access is counted.
 */
function createCountingProvider(dataStores: Map<string, CountingKVStore>): KVStoreProvider {
	const auxStores = new Map<string, InMemoryKVStore>();
	const aux = (key: string): InMemoryKVStore => {
		let s = auxStores.get(key);
		if (!s) { s = new InMemoryKVStore(); auxStores.set(key, s); }
		return s;
	};
	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			let s = dataStores.get(key);
			if (!s) { s = new CountingKVStore(); dataStores.set(key, s); }
			return s;
		},
		async getIndexStore(schemaName, tableName, indexName) { return aux(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return aux(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return aux('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const s of dataStores.values()) await s.close();
			for (const s of auxStores.values()) await s.close();
			dataStores.clear();
			auxStores.clear();
		},
	};
}

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
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

		/** The `query_plan()` op names for `query`, as a JSON array string. */
		const planOps = async (query: string): Promise<string> => {
			const rows = await asyncIterableToArray(
				db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]));
			return rows[0].ops as string;
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

		it('stops after the first window under `limit 1` rather than materializing all of them', async () => {
			// Per-window emission is lazy by design. Counted on the DATA store: a drained
			// 50-window seek resolves ~50 index entries to data rows, a stopped one ~1.
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
					Array.from({ length: 50 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
				await cdb.exec(`insert into lsrc values ${
					Array.from({ length: 50 }, (_, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);

				const store = dataStores.get('main.lz')!;
				store.iterateEntryCount = 0;
				store.getCount = 0;
				cmod.reset();
				const rows = await asyncIterableToArray(cdb.eval(`select pk from lz where v in (select k from lsrc) limit 1`));
				expect(rows).to.have.lengthOf(1);
				expect(cmod.seen('lz')[0], 'a 50-key seek').to.match(multiSeekRe('ix_lz'));
				expect(store.iterateEntryCount, 'no data-store full scan').to.equal(0);
				expect(store.getCount, 'only the first window resolved a data row').to.be.at.most(3);
			} finally {
				await cprovider.closeAll();
			}
		});

		describe('gates that must decline (the hash semi join answers instead)', () => {
			it('a runtime set on the PRIMARY KEY declines: the store claims IN for secondary indexes only', async () => {
				// `computeBestAccessPlan`'s primary-key arm matches EQ_OPS, which excludes IN,
				// so no index is claimed and `rule-key-set-seek` keeps the join it found.
				// PK coverage arrives with backlog/feat-store-pk-in-list-multiseek — no change
				// to this feature is needed for it.
				await db.exec(`create table pkt (pk integer primary key, other text) using store`);
				await db.exec(`create table psrc (id integer primary key, k integer) using store`);
				await db.exec(`insert into pkt values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')`);
				await db.exec(`insert into psrc values (1, 1), (2, 3)`);

				const q = `select pk from pkt where pk in (select k from psrc)`;
				expect(await planOps(q), 'no key-set rewrite on a PK set').to.not.match(/KEYSETSEMIJOIN/);
				mod.reset();
				expect(await pks(q), 'the surviving semi join still answers').to.deep.equal([1, 3]);
				expect(mod.seen('pkt')[0] ?? '', 'the store was never handed a multi-seek')
					.to.not.match(/plan=5/);
			});

			it('a table key collation FINER than the column declines (K = BINARY over a NOCASE column)', async () => {
				// `eqSafeToHandle` refuses to claim the seek: the K-encoded window is not a
				// superset of the NOCASE-qualifying rows, so seeking could DROP rows the
				// probe could never resurrect. Cost-only ⇒ no index claimed ⇒ the rule
				// declines and the hash semi join returns the right answer.
				await db.exec(`create table cif (pk integer primary key, s text collate nocase) using store (collation = binary)`);
				await db.exec(`create index ix_cif on cif (s)`);
				await db.exec(`create table cifsrc (id integer primary key, s text collate nocase) using store (collation = binary)`);
				await db.exec(`insert into cif values (1, 'Alpha'), (2, 'beta'), (3, 'GAMMA')`);
				await db.exec(`insert into cifsrc values (1, 'alpha'), (2, 'gamma')`);

				const q = `select pk from cif where s in (select s from cifsrc)`;
				expect(await planOps(q), 'the rule declined').to.not.match(/KEYSETSEMIJOIN/);
				mod.reset();
				expect(await pks(q), 'NOCASE equality still matches both rows').to.deep.equal([1, 3]);
				expect(mod.seen('cif')[0] ?? '').to.not.match(/plan=5/);
			});

			it('the default table key collation COARSER than the column still seeks; the probe trims the over-fetch', async () => {
				// The store's default K is NOCASE, so a plain BINARY text column keys
				// case-insensitively: 'a' and 'A' share ONE window. That over-fetches
				// relative to the BINARY join comparison, and the semi join's probe — which
				// runs on every emitted row — drops the extra. Over-fetching is always safe;
				// only under-fetching is not.
				await db.exec(`create table cb (pk integer primary key, s text) using store`);
				await db.exec(`create index ix_cb on cb (s)`);
				await db.exec(`create table cbsrc (id integer primary key, s text) using store`);
				await db.exec(`insert into cb values (1, 'alpha'), (2, 'ALPHA'), (3, 'beta')`);
				await db.exec(`insert into cbsrc values (1, 'alpha')`);
				mod.reset();
				expect(await pks(`select pk from cb where s in (select s from cbsrc)`),
					'the case variant the K-window over-fetched is trimmed').to.deep.equal([1]);
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
	});
});
