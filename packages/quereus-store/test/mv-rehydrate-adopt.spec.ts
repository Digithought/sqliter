/**
 * Adopt-without-refill at catalog rehydrate.
 *
 * The reopen matrix for the durable-backing adopt fast path: under a clean
 * shutdown (attested by the single-use `\x00meta\x00clean_shutdown` catalog
 * marker), a store-hosted maintained table whose backing phase 1 already
 * rehydrated (as a plain table under the MV's own name) is trusted as-is —
 * the MV registers without re-running its body. Any failed gate falls back
 * to the always-correct drop+refill.
 *
 * **Sentinel-divergence probe.** Each scenario plants a sentinel row directly
 * into the backing's physical KV store between sessions — content the body
 * would never produce. A post-reopen `select` of the MV serving the sentinel
 * PROVES the backing was adopted (no refill ran); the sentinel's absence
 * proves a refill. This is the adopt-vs-refill oracle throughout.
 *
 * Provider mirrors `view-mv-persistence.spec.ts`: persistent in-memory byte
 * maps whose `closeStore`/`closeAll` are no-ops, so a logical
 * `StoreModule.closeAll()` (which drains the persist queue and writes the
 * clean-shutdown marker) survives and a fresh module can reopen the same
 * storage. Skipping `StoreModule.closeAll()` therefore simulates a crash.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildDataKey,
	serializeRow,
	buildMetaCatalogKey,
	buildMaterializedViewCatalogKey,
	CLEAN_SHUTDOWN_META_NAME,
	STALE_MVS_META_NAME,
	type AtomicBatch,
	type KVStore,
	type KVStoreProvider,
	type RehydrationResult,
} from '../src/index.js';

type PersistentProvider = KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
};

/**
 * A persistent in-memory provider mirroring `view-mv-persistence.spec.ts`: byte
 * maps whose `closeStore`/`closeAll` are no-ops, so a logical `StoreModule.closeAll()`
 * survives and a fresh module can reopen the same storage; skipping `closeAll()`
 * therefore simulates a crash.
 *
 * `opts.atomic` additionally exposes `beginAtomicBatch` — the capability the adopt
 * fast path's gate-5 drop hinges on (method PRESENCE is the gate, matching both the
 * coordinator wiring and `rehydrateCatalog`'s check). The batch is faithfully
 * all-or-nothing for these logical tests: in-memory has no torn-write crash, so
 * applying the queued ops sequentially on `write()` is atomic enough; what matters is
 * that the provider advertises the capability so rehydrate trusts the durable
 * stale-MV set instead of the crash-losable clean-shutdown marker.
 *
 * `opts.stores` lets two providers share one byte-map — used to model a capability
 * gained (upgrade) or lost (downgrade) BETWEEN sessions over the same on-disk store.
 */
function createPersistentProvider(opts?: { atomic?: boolean; stores?: Map<string, InMemoryKVStore> }): PersistentProvider {
	const stores = opts?.stores ?? new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};

	const beginAtomicBatch = (): AtomicBatch => {
		const ops: Array<{ store: KVStore; key: Uint8Array; value?: Uint8Array }> = [];
		return {
			put(store, key, value) { ops.push({ store, key, value }); },
			delete(store, key) { ops.push({ store, key }); },
			async write() {
				for (const op of ops) {
					if (op.value !== undefined) await op.store.put(op.key, op.value);
					else await op.store.delete(op.key);
				}
				ops.length = 0;
			},
			clear() { ops.length = 0; },
		};
	};

	return {
		stores,
		async getStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return getOrCreate(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore() {
			return getOrCreate('__stats__');
		},
		async getCatalogStore() {
			return getOrCreate('__catalog__');
		},
		async closeStore() { /* no-op: durable storage survives a logical close */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() { /* no-op: data survives module close, mirroring real disk */ },
		async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]) {
			// A refill's drop must destroy the physical stores (mirrors a real provider).
			stores.delete(`${schemaName}.${tableName}`);
			for (const i of indexNames) stores.delete(`${schemaName}.${tableName}_idx_${i}`);
		},
		...(opts?.atomic ? { beginAtomicBatch } : {}),
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	return (await asyncIterableToArray(db.eval(sql))) as Record<string, unknown>[];
}

describe('materialized-view adopt-without-refill at rehydrate', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => { provider = createPersistentProvider(); });
	afterEach(() => { provider._hardClose(); });

	/** A fresh db + module over the shared provider (first session). */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** A brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<{ db: Database; mod: StoreModule; result: RehydrationResult }> {
		const { db, mod } = open();
		const result = await mod.rehydrateCatalog(db);
		return { db, mod, result };
	}

	/** Plant a sentinel row directly in a backing's physical data store. */
	async function plantSentinel(storeName: string, row: number[]): Promise<void> {
		const s = provider.stores.get(storeName);
		expect(s, `physical store ${storeName} exists`).to.not.be.undefined;
		await s!.put(buildDataKey([row[0]]), serializeRow(row));
	}

	/** True when the catalog currently holds the clean-shutdown marker. */
	async function markerPresent(): Promise<boolean> {
		const catalog = await provider.getCatalogStore();
		return (await catalog.get(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME))) !== undefined;
	}

	/** Raw clean-shutdown marker value, or undefined when absent. */
	async function markerValue(): Promise<string | undefined> {
		const catalog = await provider.getCatalogStore();
		const raw = await catalog.get(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME));
		return raw ? new TextDecoder().decode(raw) : undefined;
	}

	/** Raw durable stale-MV set value, or undefined when absent. */
	async function durableStaleValue(): Promise<string | undefined> {
		const catalog = await provider.getCatalogStore();
		const raw = await catalog.get(buildMetaCatalogKey(STALE_MVS_META_NAME));
		return raw ? new TextDecoder().decode(raw) : undefined;
	}

	/** Delete the durable stale-MV set entry (simulate a pre-ticket store / old code). */
	async function deleteDurableStale(): Promise<void> {
		const catalog = await provider.getCatalogStore();
		await catalog.delete(buildMetaCatalogKey(STALE_MVS_META_NAME));
	}

	/** Standard first session: store source + store-backed MV (+ a plain view so
	 *  every rehydrate phase runs alongside the meta marker), cleanly closed. */
	async function seedSession(): Promise<void> {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10), (2, 20)');
		await db.exec('create materialized view mv using store as select id, v from src');
		await db.exec('create view plain as select id from src');
		await mod.closeAll();
	}

	it('adopts a store backing after a clean shutdown: the sentinel survives and serves', async () => {
		await seedSession();
		expect(await markerPresent(), 'closeAll wrote the marker').to.equal(true);
		await plantSentinel('main.mv', [99, 990]);

		const { db, result } = await reopen();
		expect(result.errors, 'marker + tables + view + MV rehydrate cleanly').to.have.lengthOf(0);
		expect(result.materializedViews).to.deep.equal(['main.mv']);
		expect(await markerPresent(), 'marker consumed (single-use)').to.equal(false);

		// The sentinel is served through the MV — the body was NOT re-run.
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 99, v: 990 }]);

		// Adopted, not just registered: row-time maintenance is live.
		await db.exec('insert into src values (3, 30)');
		await db.exec('delete from src where id = 1');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 2, v: 20 }, { id: 3, v: 30 }, { id: 99, v: 990 }]);

		const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
		expect(mv.vtabModuleName).to.equal('store');
		expect(mv.derivation.stale ?? false).to.equal(false);
		expect(db.schemaManager.getTable('main', 'mv')!.vtabModuleName).to.equal('store');
	});

	it('the marker is single-use: a second rehydrate without an intervening close refills', async () => {
		await seedSession();
		await plantSentinel('main.mv', [99, 990]);

		// First reopen consumes the marker and adopts (sentinel preserved).
		const r1 = await reopen();
		expect(r1.result.errors).to.have.lengthOf(0);
		expect(await rows(r1.db, 'select id from mv where id = 99')).to.deep.equal([{ id: 99 }]);

		// Second reopen WITHOUT closing r1 (a crash after the first open): no
		// marker, so the adopt gate fails and the backing refills — divergence heals.
		const r2 = await reopen();
		expect(r2.result.errors).to.have.lengthOf(0);
		expect(await rows(r2.db, 'select id, v from mv order by id'), 'refilled from the body')
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// A clean close re-arms the fast path for the next open.
		await r2.mod.closeAll();
		await plantSentinel('main.mv', [98, 980]);
		const r3 = await reopen();
		expect(r3.result.errors).to.have.lengthOf(0);
		expect(await rows(r3.db, 'select id from mv where id = 98'), 'adopts again after clean close')
			.to.deep.equal([{ id: 98 }]);
	});

	it('no marker — a skipped closeAll (simulated crash) refills', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');
		// Flush the MV catalog entry WITHOUT the clean close (no marker written).
		await mod.whenCatalogPersisted();
		expect(await markerPresent(), 'no marker without closeAll').to.equal(false);
		await plantSentinel('main.mv', [99, 990]);

		const { db: db2, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db2, 'select id, v from mv order by id'), 'sentinel scrubbed by the refill')
			.to.deep.equal([{ id: 1, v: 10 }]);
	});

	it('a source shape change between sessions fails the shape gate: refill matches the new shape', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body re-plans wider than
		// the persisted 2-column backing, then close cleanly (marker present —
		// every gate but shape passes on the next open).
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		const { db: db3, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db3, 'select id, v, w from mv order by id'), 'refilled to the re-planned 3-column shape')
			.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
		expect(await rows(db3, 'select count(*) as n from mv where id = 99')).to.deep.equal([{ n: 0 }]);
	});

	it('a table-form IMPLICIT MV reshapes on reopen after a source widening (live-create channel)', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		// The IMPLICIT `create table … maintained as` form (no rename-list clause):
		// records derivation.columns = undefined, so its `select *` body reshapes its
		// source on reopen — the table-form analogue of the sugar `select *` test above,
		// authored through the LIVE-create channel this ticket fixed.
		await db.exec('create table mv (id integer primary key, v integer) using store maintained as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body re-plans wider than the
		// persisted 2-column backing, then close cleanly (marker present).
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		const { db: db3, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db3, 'select id, v, w from mv order by id'), 'refilled to the re-planned 3-column shape')
			.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
		expect(await rows(db3, 'select count(*) as n from mv where id = 99')).to.deep.equal([{ n: 0 }]);
	});

	it('a declared-column arity mismatch under trust errors per-entry without dropping the backing', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv (a, b) using store as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body produces three columns
		// under the two-column declared list — the entry can never materialize.
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		// The `alter table src` marked mv stale, so closeAll's marker names it —
		// which would force the *refill* path (drop-then-rebuild, covered by the
		// stale-at-close tests). Re-arm full trust here to isolate the *adopt* path's
		// handling of a body that can never materialize: its arity check fires BEFORE
		// any drop (`tryAdoptPreExistingBacking`), so the durable backing survives as a
		// plain table for a later DDL fix instead of being destroyed for nothing.
		const catalog = await provider.getCatalogStore();
		await catalog.put(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME), new TextEncoder().encode('[]'));

		const { db: db3, result } = await reopen();
		expect(result.errors, 'one per-entry error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/2 declared columns but body produces 3/i);
		expect(db3.schemaManager.getMaintainedTable('main', 'mv'), 'no MV record').to.be.undefined;
		// The durable backing was NOT dropped first (the refill arm would have
		// destroyed the rows before raising the same error): it stays a plain table.
		expect(db3.schemaManager.getTable('main', 'mv'), 'backing still registered').to.not.be.undefined;
		expect(await provider.stores.get('main.mv')!.get(buildDataKey([99])), 'sentinel row preserved').to.not.be.undefined;
	});

	it('refill-path twin: a declared-column arity mismatch errors per-entry without dropping the backing', async () => {
		// Guards assertDeclaredColumnArity's placement ABOVE the adopt/refill branch in
		// importMaterializedView. Unlike the adopt-path twin above (which manually re-arms
		// `[]` to force trust), this test does NOT re-arm the marker — the `alter table src`
		// in session 2 marks mv stale-at-close, so closeAll writes a marker naming it and
		// session 3 takes the REFILL path. The arity guard fires BEFORE the DROP, so the
		// durable backing is preserved as a plain table instead of being destroyed for nothing.
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv (a, b) using store as select * from src');
		await mod.closeAll();

		// Session 2: widen the source so the `select *` body produces 3 columns under
		// the 2-column declared list — the entry can never materialize. The alter marks
		// mv stale-at-close; closeAll writes a marker naming it (no re-arm needed).
		const s2 = await reopen();
		expect(s2.result.errors).to.have.lengthOf(0);
		await s2.db.exec('alter table src add column w integer default 7');
		await s2.mod.closeAll();
		// Do NOT re-arm `[]` — stale-at-close set already names mv, forcing the REFILL path.
		await plantSentinel('main.mv', [99, 990]);

		const { db: db3, result } = await reopen();
		expect(result.errors, 'one per-entry error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/2 declared columns but body produces 3/i);
		expect(db3.schemaManager.getMaintainedTable('main', 'mv'), 'no MV record').to.be.undefined;
		// The durable backing was NOT dropped before the error: assertDeclaredColumnArity fires
		// above the drop in importMaterializedView, so rows survive for a later DDL fix.
		expect(db3.schemaManager.getTable('main', 'mv'), 'backing still registered').to.not.be.undefined;
		expect(await provider.stores.get('main.mv')!.get(buildDataKey([99])), 'sentinel row preserved').to.not.be.undefined;
	});

	it('a memory source fails the same-module gate: refill every reopen', async () => {
		const { db, mod } = open();
		// An anchor store table establishes persistence; the source is MEMORY.
		await db.exec('create table anchor (id integer primary key) using store');
		await db.exec('create table memsrc (id integer primary key, v integer)');
		await db.exec('insert into memsrc values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from memsrc');
		await mod.closeAll();
		await plantSentinel('main.mv', [99, 990]);

		// The memory source does not persist — recreate it (fresh content) BEFORE
		// rehydrating, so the body plans; the cross-module gate still forces refill
		// (the persisted backing rows are stale relative to the just-recreated source).
		const { db: db2, mod: mod2 } = open();
		await db2.exec('create table memsrc (id integer primary key, v integer)');
		await db2.exec('insert into memsrc values (1, 11), (2, 22)');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db2, 'select id, v from mv order by id'), 'refilled from the fresh memory source')
			.to.deep.equal([{ id: 1, v: 11 }, { id: 2, v: 22 }]);
	});

	/**
	 * A backing whose primary key is a TEXT column with NO explicit `collate`.
	 *
	 * The store keys such a column under its table-level key collation K (default
	 * NOCASE — `reconcilePkCollations`), so the PERSISTED backing reads
	 * `COLLATE NOCASE` while the body's output type says BINARY. Until the engine
	 * ran the derived shape through the module's own `normalizeCreateSchema`, gate 2
	 * compared the post-reconcile persisted schema against a pre-reconcile derived
	 * shape and refilled EVERY reopen — a full body re-execution proportional to the
	 * source data. These pin the fast path AND the divergences that must still refill.
	 */
	describe('text primary-key backing (module-normalized collation)', () => {
		/** Plant a sentinel into a TEXT-keyed backing. The physical key must be encoded
		 *  under the same per-column key collation the backing declares, else the row
		 *  lands off-key. */
		async function plantTextSentinel(storeName: string, row: SqlValue[], collation = 'NOCASE'): Promise<void> {
			const s = provider.stores.get(storeName);
			expect(s, `physical store ${storeName} exists`).to.not.be.undefined;
			await s!.put(buildDataKey([row[0]], undefined, undefined, [collation]), serializeRow(row));
		}

		/** Source + a group-by MV whose backing PK is the implicit-collation text column `a`. */
		async function seedTextKeyed(moduleClause = 'using store'): Promise<void> {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, a text not null, b integer) using store');
			await db.exec("insert into src values (1, 'x', 10), (2, 'y', 20)");
			await db.exec(`create materialized view mv ${moduleClause} as select a, count(*) as n, sum(b) as s from src group by a`);
			await mod.closeAll();
		}

		it('adopts across a clean reopen — and again on a second consecutive reopen', async () => {
			await seedTextKeyed();
			await plantTextSentinel('main.mv', ['zz', 7, 700]);

			const s2 = await reopen();
			expect(s2.result.errors).to.have.lengthOf(0);
			expect(s2.result.materializedViews).to.deep.equal(['main.mv']);
			// The sentinel serves ⇒ the body was NOT re-run. Pre-fix this refilled.
			expect(await rows(s2.db, 'select a, n, s from mv order by a'), 'adopted — sentinel served')
				.to.deep.equal([
					{ a: 'x', n: 1, s: 10 }, { a: 'y', n: 1, s: 20 }, { a: 'zz', n: 7, s: 700 },
				]);
			// Adopted, not merely registered: row-time maintenance is armed.
			await s2.db.exec("insert into src values (3, 'x', 5)");
			expect(await rows(s2.db, 'select a, n, s from mv where a = \'x\''))
				.to.deep.equal([{ a: 'x', n: 2, s: 15 }]);

			// The first adopt must leave the backing in a state the NEXT open also accepts.
			await s2.mod.closeAll();
			const s3 = await reopen();
			expect(s3.result.errors).to.have.lengthOf(0);
			expect(await rows(s3.db, 'select a, n, s from mv order by a'), 'adopts again on the second reopen')
				.to.deep.equal([
					{ a: 'x', n: 2, s: 15 }, { a: 'y', n: 1, s: 20 }, { a: 'zz', n: 7, s: 700 },
				]);
		});

		it("a non-default `using store(collation = 'BINARY')` backing adopts (K read from the backing's own args)", async () => {
			// K comes from the BACKING's stored module args, not a session default and not
			// the source's args: the persisted backing keys `a` under BINARY here, and the
			// derived shape must normalize to the same.
			await seedTextKeyed("using store(collation = 'BINARY')");
			await plantTextSentinel('main.mv', ['zz', 7, 700], 'BINARY');

			const { db, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db, 'select a, n, s from mv order by a'), 'adopted under a non-default K')
				.to.deep.equal([
					{ a: 'x', n: 1, s: 10 }, { a: 'y', n: 1, s: 20 }, { a: 'zz', n: 7, s: 700 },
				]);
		});

		it('a GENUINE collation divergence still fails the shape gate and refills', async () => {
			// The property that keeps the fix from degenerating into "ignore collation on
			// PK columns": normalization only supplies K to an IMPLICIT collation, so an
			// EXPLICIT one the persisted backing does not carry is still a real shape
			// change and must still rebuild.
			await seedTextKeyed();

			// Session 2: declare the source column RTRIM. `set collate` carries the standing
			// of a CREATE-time COLLATE clause, and a non-BINARY collation persists in the
			// source's DDL — so on reopen the body publishes an EXPLICIT RTRIM output
			// collation, which the store's reconcile leaves alone. The backing is still
			// NOCASE: the live ALTER marks the view stale rather than re-collating it.
			const s2 = await reopen();
			expect(s2.result.errors).to.have.lengthOf(0);
			await s2.db.exec('alter table src alter column a set collate rtrim');
			expect(s2.db.schemaManager.getTable('main', 'mv')!.columns[0].collation,
				'the live backing keeps the collation it was built under').to.equal('NOCASE');
			await s2.mod.closeAll();

			// Re-arm FULL trust (as the arity tests do) so gate 2 — not the stale-at-close
			// marker — is what decides.
			const catalog = await provider.getCatalogStore();
			await catalog.put(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME), new TextEncoder().encode('[]'));
			await plantTextSentinel('main.mv', ['zz', 7, 700]);

			const { db: db3, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db3, 'select a, n, s from mv order by a'), 'refilled — the sentinel is scrubbed')
				.to.deep.equal([{ a: 'x', n: 1, s: 10 }, { a: 'y', n: 1, s: 20 }]);
			// The refill rebuilt the backing at the collation the body actually produces.
			expect(db3.schemaManager.getTable('main', 'mv')!.columns[0].collation).to.equal('RTRIM');
		});

		it('a table-form key declared `collate binary` keeps its own declaration and still adopts', async () => {
			// The other reading of an implicit body collation. `create table … maintained`
			// freezes a DECLARED shape, and a text key declared `collate binary` opts out of
			// the store's K — so the module's reconcile is a no-op and the backing keys
			// BINARY. Normalization must not push it to K: that would refill this table on
			// every reopen (and make `refresh` misread a no-op as a physical re-key), the
			// exact bug this ticket removes, in mirror image. See `normalizeBackingShape`
			// § two-valued compatibility.
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, a text not null, b integer) using store');
			await db.exec("insert into src values (1, 'x', 10), (2, 'y', 20)");
			await db.exec('create table mv (a text not null collate binary primary key, n integer not null) '
				+ 'using store maintained as select a, count(*) as n from src group by a');
			expect(db.schemaManager.getTable('main', 'mv')!.columns[0].collation,
				'the declaration wins over the store K').to.equal('BINARY');
			await db.exec('refresh materialized view mv');
			await mod.closeAll();
			await plantTextSentinel('main.mv', ['zz', 7], 'BINARY');

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select a, n from mv order by a'), 'adopted — sentinel served')
				.to.deep.equal([{ a: 'x', n: 1 }, { a: 'y', n: 1 }, { a: 'zz', n: 7 }]);
			expect(db2.schemaManager.getTable('main', 'mv')!.columns[0].collation).to.equal('BINARY');
		});

		it('an `any`-typed primary key column is untouched by normalization (still adopts)', async () => {
			// `reconcilePkCollations` deliberately gates on `isTextual`, so an `any` PK keeps
			// its BINARY. The hook inherits that — it must not start rewriting `any`.
			const { db, mod } = open();
			await db.exec('create table src (k any primary key, v integer) using store');
			await db.exec("insert into src values ('a', 1), (2, 20)");
			await db.exec('create materialized view mv using store as select k, v from src');
			await mod.closeAll();
			await plantTextSentinel('main.mv', ['zz', 99], 'BINARY');

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select count(*) as c from mv'), 'adopted — sentinel present')
				.to.deep.equal([{ c: 3 }]);
		});
	});

	describe('MV-over-MV', () => {
		it('both store-backed adopt under a clean shutdown (trust composes across fixpoint rounds)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			// `amv` reads `zmv` but sorts FIRST by catalog key order. zmv's plain
			// table pre-exists from phase 1, so amv's body PLANS — the ordering gate
			// defers it (zmv's own MV entry is still pending) — and the adopt must
			// survive the deferred round (backing NOT dropped) and compose via the
			// adopt ledger in round 2.
			await db.exec('create materialized view zmv using store as select id, v from src');
			await db.exec('create materialized view amv using store as select id, v from zmv');
			await mod.closeAll();
			await plantSentinel('main.zmv', [98, 980]);
			await plantSentinel('main.amv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(result.materializedViews).to.have.members(['main.zmv', 'main.amv']);
			expect(await rows(db2, 'select id from zmv where id >= 90'), 'upstream adopted')
				.to.deep.equal([{ id: 98 }]);
			// 99 present (amv's own rows kept) and 98 ABSENT (a refill from the
			// adopted zmv would have copied 98 in and dropped 99).
			expect(await rows(db2, 'select id from amv where id >= 90'), 'dependent adopted, not refilled')
				.to.deep.equal([{ id: 99 }]);
		});

		it('a refilled upstream forces the dependent to refill (adopt-ledger gate)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view zmv using store as select * from src');
			await db.exec('create materialized view amv using store as select id, v from zmv');
			await mod.closeAll();

			// Perturb the UPSTREAM's shape only: zmv (`select *`) refills next open;
			// amv's own gates (shape `id, v`, store sources, marker) all still pass.
			const s2 = await reopen();
			expect(s2.result.errors).to.have.lengthOf(0);
			await s2.db.exec('alter table src add column w integer default 7');
			await s2.mod.closeAll();
			await plantSentinel('main.zmv', [98, 980]);
			await plantSentinel('main.amv', [99, 990]);

			const { db: db3, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db3, 'select id, v, w from zmv order by id'), 'upstream refilled to the new shape')
				.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
			expect(await rows(db3, 'select id, v from amv order by id'), 'dependent refilled despite its own gates passing')
				.to.deep.equal([{ id: 1, v: 10 }]);
		});

		it('a memory upstream forces the store dependent to refill (module gate)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view mv1 as select id, v from src');
			await db.exec('create materialized view mv2 using store as select id, v from mv1');
			await mod.closeAll();
			await plantSentinel('main.mv2', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// mv1's memory backing was itself just recomputed; mv2 must follow it.
			expect(await rows(db2, 'select id, v from mv2 order by id'), 'dependent over a memory upstream refilled')
				.to.deep.equal([{ id: 1, v: 10 }]);
		});
	});

	it('adopt followed by a registration failure leaves the backing as a plain table (rows preserved)', async () => {
		await seedSession();
		// Hand-edit the persisted MV body: shape-identical (same projection, keys
		// preserved through the filter) so every adopt gate passes, but the
		// non-deterministic filter trips the row-time gate inside
		// registerMaterializedView — AFTER the adopt path has registered the backing.
		const catalog = await provider.getCatalogStore();
		await catalog.put(
			buildMaterializedViewCatalogKey('main', 'mv'),
			new TextEncoder().encode('create materialized view main.mv using store as select id, v from src where random() is not null'),
		);
		await plantSentinel('main.mv', [99, 990]);

		const { db, result } = await reopen();
		expect(result.errors, 'one per-entry error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/non-deterministic/i);
		expect(db.schemaManager.getMaintainedTable('main', 'mv'), 'no MV record').to.be.undefined;
		// The durable backing was NOT dropped: it reverts to a plain table and the
		// rows (sentinel included) survive for a later retry to adopt.
		expect(db.schemaManager.getTable('main', 'mv'), 'backing still registered').to.not.be.undefined;
		const backingStore = provider.stores.get('main.mv')!;
		expect(await backingStore.get(buildDataKey([99])), 'sentinel row preserved').to.not.be.undefined;
	});

	it('catalog fixed point: bytes after an adopt session equal bytes after a refill session', async () => {
		await seedSession();

		const snapshot = async (): Promise<Array<[string, string]>> => {
			const catalog = await provider.getCatalogStore();
			const dec = new TextDecoder();
			const out: Array<[string, string]> = [];
			for await (const e of catalog.iterate({ gte: new Uint8Array(0), lt: new Uint8Array([0xff]) })) {
				out.push([Array.from(e.key).join(','), dec.decode(e.value)]);
			}
			return out;
		};

		// Adopt session: marker present → adopt; clean close.
		const adoptSession = await reopen();
		expect(adoptSession.result.errors).to.have.lengthOf(0);
		await adoptSession.mod.closeAll();
		const afterAdopt = await snapshot();

		// Refill session: consume the marker without closing (simulated crash),
		// then reopen again — no marker → refill; clean close.
		await reopen();
		const refillSession = await reopen();
		expect(refillSession.result.errors).to.have.lengthOf(0);
		await refillSession.mod.closeAll();
		const afterRefill = await snapshot();

		expect(afterAdopt, 'an adopted and a refilled MV leave identical catalog bytes').to.deep.equal(afterRefill);
	});

	describe('stale-at-close exclusion', () => {
		it('a stale-at-close MV refills even under a clean shutdown (structural alter + post-stale DML)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			// A shape-shifting structural ALTER on the PROJECTED column v (drop not null
			// shifts the body's output nullability) fires a body-RELEVANT `table_modified`
			// on src ⇒ mv goes stale and its row-time maintenance detaches. Pin the trigger.
			// (A value-disjoint structural ALTER — e.g. a bare unprojected ADD COLUMN — no
			// longer stales: it recompiles the MV in place; see 53.4 sqllogic.)
			await db.exec('alter table src alter column v drop not null');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale, 'shape-shifting alter marked the MV stale')
				.to.equal(true);
			// NOT propagated to the backing (maintenance detached) — the divergence.
			await db.exec('insert into src (id, v) values (3, 30)');
			await mod.closeAll();
			expect(await markerValue(), 'marker names the stale MV').to.equal('["main.mv"]');
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors, 'rehydrate clean').to.have.lengthOf(0);
			// Refilled: the post-stale row is present and both the sentinel and the
			// behind-backing are scrubbed. A stale adopt would have served [1,2,99].
			expect(await rows(db2, 'select id, v from mv order by id'), 'refilled to current source content')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
			expect(db2.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false, 'refill cleared staleness')
				.to.equal(false);
			// Re-armed, not merely flag-cleared: a post-reopen source write now reaches
			// the refilled backing (the very maintenance that was detached at close).
			await db2.exec('insert into src (id, v) values (4, 40)');
			expect(await rows(db2, 'select id, v from mv order by id'), 'live maintenance re-armed after refill')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }, { id: 4, v: 40 }]);
		});

		it('a stale-then-refreshed MV adopts (refresh clears the flag before close)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			await db.exec('alter table src alter column v drop not null');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			// refresh re-materializes and re-arms maintenance, clearing `stale`.
			await db.exec('refresh materialized view mv');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false, 'refresh cleared staleness')
				.to.equal(false);
			// Post-refresh DML now propagates to the backing again.
			await db.exec('insert into src (id, v) values (3, 30)');
			await mod.closeAll();
			expect(await markerValue(), 'nothing stale at close').to.equal('[]');
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Adopted: the sentinel survives and serves (a refill would scrub it).
			expect(await rows(db2, 'select id, v from mv order by id'), 'adopted (not stale at close)')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }, { id: 99, v: 990 }]);
		});

		it('fine-grained: only the stale-at-close MV refills, the live one adopts', async () => {
			const { db, mod } = open();
			await db.exec('create table a (id integer primary key, v integer) using store');
			await db.exec('create table b (id integer primary key, v integer) using store');
			await db.exec('insert into a values (1, 10)');
			await db.exec('insert into b values (1, 100)');
			await db.exec('create materialized view amv using store as select id, v from a');
			await db.exec('create materialized view bmv using store as select id, v from b');
			// Only `a` is altered (a shape-shifting drop not null on the projected column
			// v) ⇒ only amv goes stale; bmv stays live.
			await db.exec('alter table a alter column v drop not null');
			expect(db.schemaManager.getMaintainedTable('main', 'amv')!.derivation.stale, 'amv stale').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'bmv')!.derivation.stale ?? false, 'bmv live').to.equal(false);
			await mod.closeAll();
			expect(await markerValue(), 'marker names only the stale MV').to.equal('["main.amv"]');
			await plantSentinel('main.amv', [99, 990]);
			await plantSentinel('main.bmv', [98, 980]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id from amv where id = 99'), 'stale amv refilled — sentinel scrubbed')
				.to.deep.equal([]);
			expect(await rows(db2, 'select id from bmv where id = 98'), 'live bmv adopted — sentinel survives')
				.to.deep.equal([{ id: 98 }]);
		});

		it('MV-over-MV: a stale upstream cascades, both refill', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv1 using store as select id, v from src');
			await db.exec('create materialized view mv2 using store as select id, v from mv1');
			// A body-relevant ALTER on mv1's source (a shape-shifting drop not null on
			// the projected column v) marks mv1 stale; the backing-invalidation cascade
			// (synthetic `table_modified` on `mv1`) marks mv2 stale too.
			await db.exec('alter table src alter column v drop not null');
			expect(db.schemaManager.getMaintainedTable('main', 'mv1')!.derivation.stale, 'mv1 stale').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv2')!.derivation.stale, 'mv2 stale (cascade)').to.equal(true);
			await mod.closeAll();
			expect(JSON.parse((await markerValue())!), 'both MVs in the stale set')
				.to.have.members(['main.mv1', 'main.mv2']);
			await plantSentinel('main.mv1', [98, 980]);
			await plantSentinel('main.mv2', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Both refilled end-to-end: sentinels scrubbed, content correct.
			expect(await rows(db2, 'select id, v from mv1 order by id'), 'upstream refilled')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			expect(await rows(db2, 'select id, v from mv2 order by id'), 'dependent refilled')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		});

		it('a close that observed no schema writes an empty stale set (next session adopts)', async () => {
			// Session 1: seed + clean close.
			await seedSession();
			await plantSentinel('main.mv', [99, 990]);

			// Session 2a: a module never registered on any Database — `computeStaleMvSet`
			// takes its no-`subscribedDb` arm. (Since `onRegister` subscribes at
			// `registerModule`, this is now the ONLY way to reach that arm.)
			const unregistered = new StoreModule(provider);
			await unregistered.closeAll();
			expect(await markerValue(), 'unobserved close writes an empty stale set').to.equal('[]');

			// Session 2b: a registered module that never rehydrates and never touches a
			// store table. It IS subscribed, so it enumerates its own (empty) db and
			// reaches the same empty set — re-arming the fast path rather than skipping
			// the marker or writing garbage.
			const { mod: mod2 } = open();
			await mod2.closeAll();
			expect(await markerValue(), 'registered-but-idle close writes an empty stale set').to.equal('[]');

			// Session 3: adopts (empty stale set ⇒ full trust) — the sentinel survives.
			const { db: db3, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db3, 'select id from mv where id = 99'), 'adopted under empty stale set')
				.to.deep.equal([{ id: 99 }]);
		});

		it('a garbage (legacy bare-flag) marker payload degrades to refill', async () => {
			await seedSession();
			// Overwrite the JSON marker with the legacy bare '1' (pre-payload format):
			// parses to a number, not a string array ⇒ conservative parse ⇒ refill all.
			const catalog = await provider.getCatalogStore();
			await catalog.put(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME), new TextEncoder().encode('1'));
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id from mv where id = 99'), 'garbage payload ⇒ refill (sentinel scrubbed)')
				.to.deep.equal([]);
		});
	});

	describe('engine importCatalog arm (no rehydrateCatalog)', () => {
		/** Replays the persisted catalog through importCatalog by hand: phase-1 the
		 *  table bundles, then the MV entry with the given options. */
		async function manualImport(options?: { trustBackings?: boolean; adoptedBackings?: Set<string> }): Promise<Database> {
			const { db, mod } = open();
			const ddls = await mod.loadAllDDL();
			// The meta marker is filtered out of loadAllDDL — only DDL remains.
			expect(ddls.every(d => /^create/i.test(d)), 'loadAllDDL returns only DDL').to.equal(true);
			// A maintained table persists as the canonical `create table … maintained as`
			// form (the unified model), so the MV arm matches that clause as well as the
			// `create materialized view` sugar; the real rehydrateCatalog classifies by
			// catalog key prefix (loadAllDDL discards the keys this hand-replay lacks).
			const isMv = (d: string): boolean => /^create materialized view/i.test(d) || /\bmaintained\s+as\b/i.test(d);
			const isView = (d: string): boolean => /^create view/i.test(d);
			await db.schemaManager.importCatalog(ddls.filter(d => !isMv(d) && !isView(d)));
			await db.schemaManager.importCatalog(ddls.filter(isView));
			await db.schemaManager.importCatalog(ddls.filter(isMv), options);
			return db;
		}

		it('without options, a pre-existing backing refills even when every other gate passes', async () => {
			await seedSession();
			expect(await markerPresent(), 'marker present but irrelevant to the engine').to.equal(true);
			await plantSentinel('main.mv', [99, 990]);

			const db = await manualImport(/* no options */);
			expect(await rows(db, 'select id, v from mv order by id'), 'default is the always-correct refill')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		});

		it('with trustBackings, the engine adopts (gate check without the store wrapper)', async () => {
			await seedSession();
			await plantSentinel('main.mv', [99, 990]);

			const db = await manualImport({ trustBackings: true, adoptedBackings: new Set() });
			expect(await rows(db, 'select id from mv where id = 99')).to.deep.equal([{ id: 99 }]);
		});

		it('trustBackings does not bypass the other-module CONSTRAINT arm', async () => {
			const { db } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			// A MEMORY table squatting on the MV's own name: not ours to adopt OR
			// drop, trust notwithstanding.
			await db.exec('create table mv (id integer primary key, v integer)');
			let message = '';
			try {
				await db.schemaManager.importCatalog(
					['create materialized view main.mv using store as select id, v from src'],
					{ trustBackings: true, adoptedBackings: new Set() },
				);
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).to.match(/already exists in module 'memory', not the MV's backing module 'store'/i);
			expect(db.schemaManager.getTable('main', 'mv')!.vtabModuleName, 'squatter untouched').to.equal('memory');
		});
	});

	// A provider WITHOUT `beginAtomicBatch` (the default here) keeps gate 5 exactly as
	// before: it NEVER writes the durable stale-set (the write is gated on the capability —
	// the set's sole reader/truster is an atomic provider, so a non-atomic session writing
	// it would be useless and a soundness hazard for a later atomic reopen). The
	// clean-shutdown marker alone governs trust — the parity guarantee for any minimal
	// provider.
	it('without beginAtomicBatch the durable stale-set is never written — the marker governs (parity)', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');
		// Drain the persist queue WITHOUT a clean close: a non-atomic provider enqueues no
		// durable-set write at all, so the entry stays absent.
		await mod.whenCatalogPersisted();
		expect(await durableStaleValue(), 'non-atomic provider never writes the durable set').to.be.undefined;
		expect(await markerPresent(), 'no marker (crash)').to.equal(false);
		await plantSentinel('main.mv', [99, 990]);

		const { db: db2, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		// No capability ⇒ marker path ⇒ no marker ⇒ refill. The sentinel is scrubbed.
		expect(await rows(db2, 'select id from mv where id = 99'), 'no capability ⇒ marker path ⇒ refilled')
			.to.deep.equal([]);
	});

	// The genuine DOWNGRADE direction the comment above only gestured at: a store WRITTEN by
	// an atomic session (durable set present on disk) then REOPENED by a non-atomic provider
	// over the same byte-map. The non-atomic reopen must IGNORE the on-disk set and fall back
	// to the marker — proving the read is gated, not just the write.
	it('an atomic-written durable set is ignored when reopened non-atomic — the marker governs (true downgrade)', async () => {
		const shared = new Map<string, InMemoryKVStore>();
		// Session 1: atomic provider, clean close ⇒ writes BOTH the marker and the durable set.
		const atomicProvider = createPersistentProvider({ atomic: true, stores: shared });
		const mod1 = new StoreModule(atomicProvider);
		const db1 = new Database();
		db1.registerModule('store', mod1);
		await db1.exec('create table src (id integer primary key, v integer) using store');
		await db1.exec('insert into src values (1, 10)');
		await db1.exec('create materialized view mv using store as select id, v from src');
		await mod1.closeAll();
		// The atomic session left the durable set on disk.
		const catalog1 = await atomicProvider.getCatalogStore();
		expect((await catalog1.get(buildMetaCatalogKey(STALE_MVS_META_NAME))) !== undefined,
			'atomic clean close wrote the durable set').to.equal(true);

		// Session 2: NON-atomic provider over the SAME byte-map. The marker (from the clean
		// close) governs; the on-disk durable set is not consulted. Adopts via the marker.
		const plainProvider = createPersistentProvider({ stores: shared });
		const mod2 = new StoreModule(plainProvider);
		const db2 = new Database();
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);
		// Marker present from the clean close ⇒ non-stale MV adopts (live-at-close).
		expect(await rows(db2, 'select id, v from mv order by id')).to.deep.equal([{ id: 1, v: 10 }]);
		await mod2.closeAll();
	});

	describe('atomic-commit domain (gate 5 dropped for same-module backings)', () => {
		// Override the shared provider with an atomic-capable one (exposes beginAtomicBatch).
		// Mocha runs this AFTER the parent beforeEach, so it replaces the non-atomic default;
		// the parent afterEach still tears the (replaced) provider down.
		beforeEach(() => { provider = createPersistentProvider({ atomic: true }); });

		/** A session that creates a store source + store-backed MV WITHOUT a clean close
		 *  (a crash): flushes the durable stale-set, leaves no marker. */
		async function crashAfterSeed(): Promise<void> {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			await mod.whenCatalogPersisted();
		}

		it('a non-stale backing adopts across a crash with NO marker — gate 4 alone governs', async () => {
			await crashAfterSeed();
			expect(await markerPresent(), 'no marker without closeAll (a crash)').to.equal(false);
			expect(await durableStaleValue(), 'durable stale-set written incrementally: nothing stale').to.equal('[]');
			await plantSentinel('main.mv', [99, 990]);

			const { db, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(result.materializedViews).to.deep.equal(['main.mv']);
			// Adopted despite the missing marker: the sentinel survives and serves — proof
			// the body was NOT re-run (the crash-divergence window is closed by the atomic
			// commit domain, so gate 4 alone governs).
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 99, v: 990 }]);
			// Live maintenance is armed on the adopted backing.
			await db.exec('insert into src values (3, 30)');
			await db.exec('delete from src where id = 1');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 2, v: 20 }, { id: 3, v: 30 }, { id: 99, v: 990 }]);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false).to.equal(false);
		});

		it('a stale-at-close MV refills across a crash — driven by the durable stale-set, not the lost marker', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			// A shape-shifting structural ALTER on the projected column v stales mv and
			// detaches its row-time maintenance.
			await db.exec('alter table src alter column v drop not null');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale, 'alter staled mv').to.equal(true);
			// NOT propagated to the backing (maintenance detached) — the divergence.
			await db.exec('insert into src (id, v) values (3, 30)');
			await mod.whenCatalogPersisted();
			expect(await markerPresent(), 'crash: no marker').to.equal(false);
			expect(await durableStaleValue(), 'durable stale-set names mv').to.equal('["main.mv"]');
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Refilled: sentinel + behind-backing scrubbed, post-stale row present. A stale
			// adopt would have served [1,2,99]. Proves the LOGICAL-staleness window stays
			// sound under the dropped gate.
			expect(await rows(db2, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
			expect(db2.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false, 'refill cleared staleness')
				.to.equal(false);
		});

		it('residual content-stale hole: a value-semantics ALTER on a read-only-in-WHERE column refills after a crash', async () => {
			const { db, mod } = open();
			await db.exec("create table src (id integer primary key, v integer, g text not null default 'keep') using store");
			await db.exec("insert into src values (1, 10, 'keep'), (2, 20, 'keep')");
			// `g` is read ONLY in the WHERE predicate, never projected → the projected
			// backing shape is (id, v).
			await db.exec("create materialized view mv using store as select id, v from src where g <> 'skip'");
			// A collation change on `g` (a read column) is content-relevant but shape-stable:
			// gate 2 (backingShapeMatches over (id, v)) passes, yet the engine declines the
			// in-place recompile and marks mv stale. Pin the trigger (the specific hole).
			await db.exec('alter table src alter column g set collate nocase');
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale,
				'value-semantics ALTER on a read column staled mv (projected shape unchanged)').to.equal(true);
			await mod.whenCatalogPersisted();
			expect(await durableStaleValue(), 'durable stale-set names mv').to.equal('["main.mv"]');
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Must REFILL (sentinel scrubbed): the durable stale-set closes the hole that
			// gates 2/3/4 alone would have adopted straight through.
			expect(await rows(db2, 'select id from mv where id = 99'), 'refilled — sentinel scrubbed').to.deep.equal([]);
			expect(await rows(db2, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		});

		it('capability present but no durable stale-set yet falls back to the marker path (upgrade)', async () => {
			// A clean close writes BOTH the marker and the stale-set; delete the stale-set to
			// model a store written by pre-ticket code (capability gained on reopen, no entry).
			await seedSession();
			await deleteDurableStale();
			expect(await durableStaleValue(), 'no stale-set entry (old store)').to.be.undefined;
			expect(await markerPresent(), 'marker present from the clean close').to.equal(true);
			await plantSentinel('main.mv', [99, 990]);

			const { db, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Adopts via the marker fallback (clean shutdown, not stale-at-close).
			expect(await rows(db, 'select id from mv where id = 99'), 'adopted via the marker fallback')
				.to.deep.equal([{ id: 99 }]);
		});

		it('a stale-then-refreshed MV adopts across a crash (refresh cleared it from the durable set)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using store as select id, v from src');
			await db.exec('alter table src alter column v drop not null'); // stale
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			await db.exec('refresh materialized view mv'); // re-materialize + re-arm, clears stale
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false).to.equal(false);
			await db.exec('insert into src (id, v) values (3, 30)'); // maintained into the backing again
			await mod.whenCatalogPersisted();
			expect(await durableStaleValue(), 'refresh recomputed the durable set to empty').to.equal('[]');
			expect(await markerPresent(), 'crash: no marker').to.equal(false);
			await plantSentinel('main.mv', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			// Adopted: the now-healthy backing's sentinel survives (a refill would scrub it).
			expect(await rows(db2, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }, { id: 99, v: 990 }]);
		});

		it('MV-over-MV: a stale upstream forces both to refill across a crash (cascade in the durable set)', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			await db.exec('create materialized view mv1 using store as select id, v from src');
			await db.exec('create materialized view mv2 using store as select id, v from mv1');
			// A body-relevant ALTER on mv1's source stales mv1; the backing-invalidation
			// cascade (synthetic table_modified on mv1) stales mv2 too.
			await db.exec('alter table src alter column v drop not null');
			expect(db.schemaManager.getMaintainedTable('main', 'mv1')!.derivation.stale, 'mv1 stale').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv2')!.derivation.stale, 'mv2 stale (cascade)').to.equal(true);
			await mod.whenCatalogPersisted();
			expect(JSON.parse((await durableStaleValue())!), 'both MVs in the durable set')
				.to.have.members(['main.mv1', 'main.mv2']);
			expect(await markerPresent(), 'crash: no marker').to.equal(false);
			await plantSentinel('main.mv1', [98, 980]);
			await plantSentinel('main.mv2', [99, 990]);

			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id, v from mv1 order by id'), 'upstream refilled')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			expect(await rows(db2, 'select id, v from mv2 order by id'), 'dependent refilled')
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		});

		it('listener ordering: a source ALTER\'s stale flag is visible in the persisted durable stale-set', async () => {
			// The engine MV manager subscribes in the Database constructor — before the
			// store's lazy subscription — so its listener runs first and the store's
			// recompute observes the already-updated stale flags. Asserted end-to-end: the
			// durable entry written DURING the ALTER event names the just-staled MV.
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view mv using store as select id, v from src');
			await mod.whenCatalogPersisted();
			expect(await durableStaleValue(), 'nothing stale yet').to.equal('[]');

			await db.exec('alter table src alter column v drop not null');
			await mod.whenCatalogPersisted();
			expect(await durableStaleValue(), 'the ALTER event observed the post-transition stale flag')
				.to.equal('["main.mv"]');
		});

		it('a memory-backed MV named in the durable stale-set is harmless (always refills)', async () => {
			const { db, mod } = open();
			// A store source establishes persistence; the MV itself is MEMORY-hosted.
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view memmv as select id, v from src');
			await db.exec('alter table src alter column v drop not null'); // stales memmv
			expect(db.schemaManager.getMaintainedTable('main', 'memmv')!.derivation.stale).to.equal(true);
			await mod.whenCatalogPersisted();
			expect(JSON.parse((await durableStaleValue())!), 'memory MV named in the durable set')
				.to.include('main.memmv');

			// Reopen: a memory MV has no phase-1 durable backing, so withholding trust is a
			// no-op — it refills from the (store-persisted) source regardless.
			const { db: db2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id, v from memmv order by id')).to.deep.equal([{ id: 1, v: 10 }]);
		});

		it('rename-restore conservatism: a no-event clear yields a sound (wasteful) refill across a crash', async () => {
			const { db, mod } = open();
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10), (2, 20)');
			// A `select *` body follows a source column rename (pure name shift).
			await db.exec('create materialized view mv using store as select * from src');
			await mod.whenCatalogPersisted();
			expect(await durableStaleValue(), 'nothing stale yet').to.equal('[]');

			// The rename stales mv DURING the event (the store writes the durable name),
			// then restoreUnaffectedMaterializedViews restores it — firing NO clear event.
			await db.exec('alter table src rename column v to v2');
			await mod.whenCatalogPersisted();
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale ?? false, 'restored live')
				.to.equal(false);
			expect(await durableStaleValue(), 'durable set over-names the restored MV (the clear fired no event)')
				.to.equal('["main.mv"]');
			expect(await markerPresent(), 'crash: no marker').to.equal(false);

			// Reopen across the crash: the durable set names mv → conservative refill.
			// Wasteful (the backing was actually current) but SOUND — content matches the body.
			const { db: db2, mod: mod2, result } = await reopen();
			expect(result.errors).to.have.lengthOf(0);
			expect(await rows(db2, 'select id, v2 from mv order by id'), 'refill is sound (correct content)')
				.to.deep.equal([{ id: 1, v2: 10 }, { id: 2, v2: 20 }]);

			// The next clean close recomputes the drift away (mv is not stale at close).
			await mod2.closeAll();
			expect(await durableStaleValue(), 'clean close corrected the over-naming').to.equal('[]');
		});

		it('catalog fixed point: clean atomic-domain reopen cycles converge to identical catalog bytes', async () => {
			// In the atomic domain, the durable stale-set ([]) makes every clean reopen adopt.
			// Two clean adopt+close cycles must leave byte-identical catalog — including the
			// new meta entries (marker + durable stale-set). (The adopt-vs-refill byte parity
			// is covered by the non-atomic 'catalog fixed point' test above.)
			await seedSession();

			const snapshot = async (): Promise<Array<[string, string]>> => {
				const catalog = await provider.getCatalogStore();
				const dec = new TextDecoder();
				const out: Array<[string, string]> = [];
				for await (const e of catalog.iterate({ gte: new Uint8Array(0), lt: new Uint8Array([0xff]) })) {
					out.push([Array.from(e.key).join(','), dec.decode(e.value)]);
				}
				return out;
			};

			const first = await reopen();
			expect(first.result.errors).to.have.lengthOf(0);
			await first.mod.closeAll();
			const afterFirst = await snapshot();

			const second = await reopen();
			expect(second.result.errors).to.have.lengthOf(0);
			await second.mod.closeAll();
			const afterSecond = await snapshot();

			expect(afterFirst, 'two clean adopt sessions converge to identical catalog bytes').to.deep.equal(afterSecond);
		});
	});
});
