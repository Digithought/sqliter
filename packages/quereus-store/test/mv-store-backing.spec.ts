/**
 * End-to-end `create materialized view … using store` over the registered
 * isolated store module (`IsolationModule(StoreModule)`) — the engine-driven
 * counterpart of the capability-surface tests in `backing-host.spec.ts`, and
 * the store analogue of `quereus/test/mv-backing-module.spec.ts` (the `mem2`
 * suite this matrix mirrors).
 *
 * Covers: round-trip + catalog persistence of the backing table bundle,
 * row-time maintenance, mid-transaction visibility, rollback/commit lockstep,
 * savepoints, covering-UNIQUE enforcement through a store backing, MV-over-MV
 * cascade in every memory/store direction, refresh (data-only, in-transaction
 * parity with memory, and shape rebuild), drop, and the `collation` backing
 * arg's effect on PK key encoding.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { IsolationModule } from '@quereus/isolation';
import {
	StoreModule,
	InMemoryKVStore,
	createIsolatedStoreModule,
	buildCatalogKey,
	buildMaterializedViewCatalogKey,
	type KVStoreProvider,
} from '../src/index.js';

// Unified model: the MV's backing IS the table registered under the MV's own name.
const BACKING = 'mv';

interface TestProvider extends KVStoreProvider {
	stores: Map<string, InMemoryKVStore>;
}

function createProvider(): TestProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	return {
		stores,
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore() { return get('__stats__'); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() { /* no-op: shared in-memory store */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() {
			for (const s of stores.values()) await s.close();
			stores.clear();
		},
		async deleteTableStores(schemaName, tableName, indexNames) {
			stores.delete(`${schemaName}.${tableName}`);
			for (const i of indexNames) stores.delete(`${schemaName}.${tableName}_idx_${i}`);
		},
	};
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function expectThrows(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		expect((e as Error).message).to.match(pattern);
	}
	expect(threw, `expected a throw matching ${pattern}`).to.equal(true);
}

describe('materialized views `using store` (end-to-end)', () => {
	let db: Database;
	let provider: TestProvider;
	let wrapper: IsolationModule;
	let storeModule: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createProvider();
		wrapper = createIsolatedStoreModule({ provider });
		storeModule = wrapper.underlying as StoreModule;
		db.registerModule('store', wrapper);
	});
	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	/** True when the provider's catalog store currently holds `key`. */
	async function catalogHas(key: Uint8Array): Promise<boolean> {
		const catalog = provider.stores.get('__catalog__');
		if (!catalog) return false;
		return (await catalog.get(key)) !== undefined;
	}

	it('create round-trips: the backing lives in the store module and the catalog holds the table bundle', async () => {
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10), (2, 20)');
		await db.exec('create materialized view mv using store as select id, v from src');

		const backing = db.schemaManager.getTable('main', BACKING)!;
		expect(backing, 'backing registered').to.not.be.undefined;
		expect(backing.vtabModuleName, 'backing owned by the store registration').to.equal('store');
		expect(storeModule.getTable('main', BACKING), 'backing in the StoreModule table map').to.not.be.undefined;
		expect(provider.stores.has(`main.${BACKING}`), 'physical backing store created').to.equal(true);

		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// The lazy first-access saveTableDDL fired during the create-fill
		// (replaceContents opens the data store), so the catalog already holds the
		// `mv` TABLE bundle — the adopt ticket's phase-1 rehydrate precondition.
		expect(await catalogHas(buildCatalogKey('main', BACKING)), 'table bundle persisted').to.equal(true);
		// The MV's own catalog entry rides the async persist queue.
		await storeModule.whenCatalogPersisted();
		expect(await catalogHas(buildMaterializedViewCatalogKey('main', 'mv')), 'MV catalog entry persisted').to.equal(true);

		const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
		expect(mv.vtabModuleName).to.equal('store');
	});

	it('row-time maintenance keeps the store backing consistent through insert/update/delete', async () => {
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10), (2, 20)');
		await db.exec('create materialized view mv using store as select id, v from src');

		await db.exec('insert into src values (3, 30)');
		await db.exec('update src set v = 99 where id = 1');
		await db.exec('delete from src where id = 2');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 99 }, { id: 3, v: 30 }]);
	});

	it('a source write is visible through the MV mid-transaction and reverts on rollback', async () => {
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');

		await db.exec('begin');
		await db.exec('insert into src values (2, 20)');
		// Reads-own-writes: the uncommitted source write reaches the MV through the
		// substrate merge (IsolatedTable merged read → empty overlay →
		// StoreTable.query → coordinator-pending merge).
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		await db.exec('rollback');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }]);
	});

	it('a committed transaction persists the backing delta in lockstep with the source', async () => {
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');

		await db.exec('begin');
		await db.exec('insert into src values (2, 20)');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		await db.exec('commit');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		expect(await rows(db, 'select id, v from src order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
	});

	it('partial rollback to a savepoint truncates backing maintenance in lockstep with the source', async () => {
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('create materialized view mv using store as select id, v from src');

		await db.exec('begin');
		await db.exec('insert into src values (1, 10)');
		await db.exec('savepoint s1');
		await db.exec('insert into src values (2, 20)');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		await db.exec('rollback to s1');
		expect(await rows(db, 'select id, v from mv order by id'), 'post-savepoint delta gone, pre-savepoint kept')
			.to.deep.equal([{ id: 1, v: 10 }]);
		await db.exec('commit');
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }]);
		expect(await rows(db, 'select id, v from src order by id'))
			.to.deep.equal([{ id: 1, v: 10 }]);
	});

	describe('covering-UNIQUE enforcement through a store backing', () => {
		beforeEach(async () => {
			await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y)) using store');
			// Covering shape: uc-cols + pk, ordered by the uc columns (prefix-scan path).
			await db.exec('create materialized view ix using store as select x, y, id from t order by x, y');
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.uniqueConstraints![0].coveringStructureName, 'covering link established').to.equal('ix');
		});

		it('rejects a duplicate via the store backing, including mid-transaction pending rows', async () => {
			await db.exec('insert into t values (1, 7, 8)');
			await expectThrows(() => db.exec('insert into t values (9, 7, 8)'), /unique/i);

			// Mid-transaction: BOTH the conflicting source row and its backing entry
			// are pending (uncommitted) when the duplicate arrives.
			await db.exec('begin');
			await db.exec('insert into t values (2, 5, 6)');
			await expectThrows(() => db.exec('insert into t values (3, 5, 6)'), /unique/i);
			await db.exec('rollback');
			expect(await rows(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id from ix order by id')).to.deep.equal([{ id: 1 }]);
		});

		it('honors the IGNORE and REPLACE arms, with same-statement reads-own-writes', async () => {
			await db.exec('insert into t values (1, 7, 8)');

			// IGNORE: the duplicate is dropped, nothing changes.
			await db.exec('insert or ignore into t values (9, 7, 8)');
			expect(await rows(db, 'select id, x, y from t order by id')).to.deep.equal([{ id: 1, x: 7, y: 8 }]);

			// REPLACE evicts the conflicting source row; the eviction pipeline keeps
			// the store backing consistent within the same statement.
			await db.exec('insert or replace into t values (2, 7, 8)');
			expect(await rows(db, 'select id, x, y from t order by id')).to.deep.equal([{ id: 2, x: 7, y: 8 }]);
			expect(await rows(db, 'select x, y, id from ix order by x, y')).to.deep.equal([{ x: 7, y: 8, id: 2 }]);

			// Same-statement reads-own-writes: the second row conflicts with the
			// first row of the SAME statement and must evict it via the pending state.
			await db.exec('insert or replace into t values (3, 9, 9), (4, 9, 9)');
			expect(await rows(db, 'select id from t where x = 9 and y = 9')).to.deep.equal([{ id: 4 }]);
			expect(await rows(db, 'select id from ix where x = 9 and y = 9')).to.deep.equal([{ id: 4 }]);
		});
	});

	describe('MV-over-MV cascade across backing modules', () => {
		/** Build base + two chained MVs with the given backing clauses, then assert
		 *  a write propagates two levels and a failed statement reverts both. */
		async function chain(mv1Using: string, mv2Using: string): Promise<void> {
			await db.exec('create table base (id integer primary key, v integer) using store');
			await db.exec('insert into base values (1, 10)');
			await db.exec(`create materialized view mv1 ${mv1Using} as select id, v from base`);
			await db.exec(`create materialized view mv2 ${mv2Using} as select id, v from mv1`);

			// One write flows through both backings.
			await db.exec('insert into base values (2, 20)');
			for (const mv of ['mv1', 'mv2']) {
				expect(await rows(db, `select id, v from ${mv} order by id`), `${mv} after cascade`)
					.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			}

			// An explicit-transaction rollback reverts BOTH levels in lockstep.
			await db.exec('begin');
			await db.exec('insert into base values (3, 30)');
			for (const mv of ['mv1', 'mv2']) {
				expect(await rows(db, `select id, v from ${mv} order by id`), `${mv} mid-transaction`)
					.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
			}
			await db.exec('rollback');
			for (const mv of ['mv1', 'mv2']) {
				expect(await rows(db, `select id, v from ${mv} order by id`), `${mv} after rollback`)
					.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			}
		}

		it('memory consumer over a store producer', async () => {
			await chain('using store', '');
		});

		it('store consumer over a memory producer', async () => {
			await chain('', 'using store');
		});

		it('store consumer over a store producer', async () => {
			await chain('using store', 'using store');
		});
	});

	describe('refresh', () => {
		it('data-only refresh preserves the store backing', async () => {
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view mv using store as select id, v from src');

			await db.exec('refresh materialized view mv');
			expect(db.schemaManager.getTable('main', BACKING)!.vtabModuleName).to.equal('store');
			expect(await rows(db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 10 }]);
		});

		it('refresh inside an explicit transaction behaves exactly like the memory backing (DDL-commits parity)', async () => {
			// Run the identical scenario against a store-backed and a memory-backed
			// MV (same store source) and require the SAME observable outcome:
			// `replaceContents`' commit-first posture is the store analogue of
			// memory's `replaceBaseLayer` in-flight-layer drain.
			const run = async (usingClause: string): Promise<{ mv: unknown; src: unknown }> => {
				const arm = new Database();
				const armProvider = createProvider();
				arm.registerModule('store', createIsolatedStoreModule({ provider: armProvider }));
				try {
					await arm.exec('create table src (id integer primary key, v integer) using store');
					await arm.exec('insert into src values (1, 10)');
					await arm.exec(`create materialized view mv ${usingClause} as select id, v from src`);
					await arm.exec('begin');
					await arm.exec('insert into src values (2, 20)');
					await arm.exec('refresh materialized view mv');
					await arm.exec('rollback');
					return {
						mv: await rows(arm, 'select id, v from mv order by id'),
						src: await rows(arm, 'select id, v from src order by id'),
					};
				} finally {
					await arm.close();
					await armProvider.closeAll();
				}
			};

			const store = await run('using store');
			const memory = await run('');
			expect(store, 'store and memory backings observe the same refresh-in-txn outcome').to.deep.equal(memory);
		});

		it('refresh inside a savepoint does not throw and matches memory arm (DDL-commits parity)', async () => {
			// Mirror the refresh-in-txn parity test but with a savepoint wrapping the
			// insert + refresh. The backing coordinator's stack is cleared by the
			// DDL-commit in replaceContents; the subsequent rollback-to-s1 broadcast
			// must warn-and-return rather than throw (regression guard).
			const run = async (usingClause: string): Promise<{ mv: unknown; src: unknown }> => {
				const arm = new Database();
				const armProvider = createProvider();
				arm.registerModule('store', createIsolatedStoreModule({ provider: armProvider }));
				try {
					await arm.exec('create table src (id integer primary key, v integer) using store');
					await arm.exec('insert into src values (1, 10)');
					await arm.exec(`create materialized view mv ${usingClause} as select id, v from src`);
					await arm.exec('begin');
					await arm.exec('savepoint s1');
					await arm.exec('insert into src values (2, 20)');
					await arm.exec('refresh materialized view mv'); // DDL-commits: clears backing stack
					await arm.exec('rollback to s1');               // must not throw; degrades to DDL-commits
					await arm.exec('commit');
					return {
						mv: await rows(arm, 'select id, v from mv order by id'),
						src: await rows(arm, 'select id, v from src order by id'),
					};
				} finally {
					await arm.close();
					await armProvider.closeAll();
				}
			};

			const storeResult = await run('using store');
			const memoryResult = await run('');
			expect(storeResult, 'store and memory backings observe the same refresh-in-savepoint outcome').to.deep.equal(memoryResult);
		});

		it('an in-place reshape after a source ALTER keeps the backing in the store module (no silent migration)', async () => {
			await db.exec('create table src (id integer primary key, v integer) using store');
			await db.exec('insert into src values (1, 10)');
			await db.exec('create materialized view mv using store as select * from src');

			// A trailing source-column add shifts the `select *` body's shape → refresh
			// reshapes the maintained table IN PLACE (via the store module's alterTable),
			// keeping the incarnation in the MV's OWN module.
			await db.exec('alter table src add column w integer default 7');
			await db.exec('refresh materialized view mv');

			const backing = db.schemaManager.getTable('main', BACKING)!;
			expect(backing.vtabModuleName, 'reshaped backing module').to.equal('store');
			expect(storeModule.getTable('main', BACKING), 'reshaped backing in StoreModule map').to.not.be.undefined;
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.vtabModuleName).to.equal('store');
			expect(await rows(db, 'select id, v, w from mv')).to.deep.equal([{ id: 1, v: 10, w: 7 }]);

			// Maintenance is live against the reshaped incarnation.
			await db.exec('insert into src values (2, 20, 8)');
			expect(await rows(db, 'select id, v, w from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10, w: 7 }, { id: 2, v: 20, w: 8 }]);
		});

		it('a narrowing retype reshapes the durable store backing against the reconciled body, not the stale rows (no MISMATCH)', async () => {
			// Store analogue of the memory `narrowing retype validates the reconciled
			// body` regression (`maintained-table-reshape-narrowing-attr-on-stale-data`).
			// Pins `store-module-alter-column.ts`'s setDataType arm under a narrowing:
			// the backing goes stale on an unrelated source add, so a source data-fix is
			// NOT maintained in (the durable backing keeps the un-convertible 'abc'). The
			// deferred post-reconcile retype must validate the clean re-derived body.
			await db.exec('create table src (id integer primary key, v text) using store');
			await db.exec("insert into src values (1, 'abc')");
			await db.exec('create materialized view mv using store as select * from src');

			await db.exec('alter table src add column w integer default 0'); // mv stale
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			await db.exec("update src set v = '5' where id = 1");             // unmaintained
			await db.exec('alter table src alter column v set data type integer'); // source narrows; backing keeps 'abc'

			// OLD code retyped v over the durable 'abc' before the reconcile → MISMATCH.
			// The fix defers it past the reconcile so it validates the clean body.
			await db.exec('refresh materialized view mv');

			const backing = db.schemaManager.getTable('main', BACKING)!;
			expect(backing.vtabModuleName, 'reshaped backing still in the store module').to.equal('store');
			expect(backing.columns.map(c => c.name)).to.deep.equal(['id', 'v', 'w']);
			expect(backing.columns[1].logicalType.name.toUpperCase(), 'v retyped to INTEGER').to.equal('INTEGER');
			// read(MV) == evaluate(body): reconciled the fresh body, never the stale 'abc'.
			expect(await rows(db, 'select id, v, w from mv order by id'))
				.to.deep.equal(await rows(db, 'select id, v, w from src order by id'));

			// Maintenance is live against the reshaped incarnation.
			await db.exec("insert into src values (2, '7', 9)");
			expect(await rows(db, 'select id, w from mv order by id'))
				.to.deep.equal([{ id: 1, w: 0 }, { id: 2, w: 9 }]);
		});
	});

	describe('constraint-bearing refresh re-validation', () => {
		// Store analogue of `quereus/test/maintained-table-refresh-revalidation.spec.ts`'s
		// `stale fast-path` blocks, pinning `rebuildBacking`'s CONSTRAINT-BEARING branch
		// (`applyMaintenance('replace-all')` → `validateDeclaredConstraintsOverContents`
		// → `conn.commit()`) on the STORE backing host specifically. The memory spec only
		// reaches that branch on memory backings, and the MV-sugar store cases above never
		// declare a constraint (so they take the validation-free `replaceContents` fast
		// path). Here `src` and the TABLE-FORM maintained table `mt` are both `using store`,
		// so the bulk validation scan must read the store connection's PENDING `replace-all`
		// writes (reads-own-writes) to catch a drifted violator BEFORE the commit — the
		// untested variable vs. the store-tested attach core is the trigger (refresh vs.
		// attach), not the host machinery.
		//
		// Flow mirrors the memory spec: (1) seed a clean row (row-time maintained into mt);
		// (2) a body-relevant shape-shifting ALTER on a projected column (drop not null /
		// retype) marks mt stale and detaches its row-time plan, so step (3) is NOT maintained in; (3) drift a
		// violator into the now-unmaintained source; (4) `refresh` and assert the
		// maintained-table-attributed diagnostic + intact COMMITTED store contents + stays
		// stale (a clean drift instead commits + clears stale).
		const isStale = (name: string): boolean =>
			db.schemaManager.getMaintainedTable('main', name)!.derivation.stale === true;

		describe('CHECK violator on the store backing', () => {
			beforeEach(async () => {
				await db.exec('create table src (id integer primary key, v text not null) using store');
				await db.exec(`create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					using store maintained as select id, v from src`);
				await db.exec(`insert into src values (1, 'clean')`);
				await db.exec('alter table src alter column v drop not null'); // stale + plan detached
				expect(isStale('mt'), 'shape-shifting alter marked mt stale').to.equal(true);
			});

			it('a CHECK-violating drift throws the attribution and leaves the committed store contents intact + stale', async () => {
				await db.exec(`insert into src (id, v) values (2, 'poison')`); // drift, unmaintained
				expect(await rows(db, 'select id, v from mt order by id'), 'drift not maintained in')
					.to.deep.equal([{ id: 1, v: 'clean' }]);

				await expectThrows(() => db.exec('refresh materialized view mt'),
					/row derived into maintained table 'main\.mt'/);

				// The rejected pending `replace-all` was discarded by statement-level rollback,
				// NOT committed to the store: re-reading mt returns the COMMITTED seed row, and
				// mt stays stale so the next read re-validates rather than serving the rejected set.
				expect(await rows(db, 'select id, v from mt order by id')).to.deep.equal([{ id: 1, v: 'clean' }]);
				expect(isStale('mt'), 'mt stays stale after a rejected refresh').to.equal(true);
			});

			it('a clean drift commits to the store backing and clears stale', async () => {
				await db.exec(`insert into src (id, v) values (2, 'fresh')`);
				await db.exec('refresh materialized view mt');
				expect(await rows(db, 'select id, v from mt order by id'))
					.to.deep.equal([{ id: 1, v: 'clean' }, { id: 2, v: 'fresh' }]);
				expect(isStale('mt'), 'a conforming refresh clears stale').to.equal(false);
			});
		});

		describe('child-side FK orphan on the store backing (FK enforcement on)', () => {
			beforeEach(async () => {
				// parent is store-backed too (the FK anti-join is a plain SQL query, so the
				// backing under test stays the store backing regardless).
				await db.exec('create table parent (pid integer primary key) using store');
				await db.exec('create table src (id integer primary key, ref integer null) using store');
				await db.exec(`create table mt (id integer primary key, ref integer null references parent(pid))
					using store maintained as select id, ref from src`);
				await db.exec('insert into parent values (1)');
				await db.exec('insert into src values (1, 1)');
				expect(await rows(db, 'select id, ref from mt')).to.deep.equal([{ id: 1, ref: 1 }]);
				await db.exec('alter table src alter column ref set data type real'); // stale + plan detached
				expect(isStale('mt'), 'shape-shifting alter marked mt stale').to.equal(true);
			});

			it('an FK-orphan drift throws the FK attribution and leaves the committed store contents intact + stale', async () => {
				await db.exec('insert into src (id, ref) values (2, 99)'); // parent 99 absent, unmaintained
				await expectThrows(() => db.exec('refresh materialized view mt'),
					/references a missing 'main\.parent'/);
				expect(await rows(db, 'select id, ref from mt order by id')).to.deep.equal([{ id: 1, ref: 1 }]);
				expect(isStale('mt'), 'mt stays stale after a rejected refresh').to.equal(true);
			});

			it('an orphan-drift with a matching parent commits and clears stale', async () => {
				await db.exec('insert into parent values (2)');
				await db.exec('insert into src (id, ref) values (2, 2)');
				await db.exec('refresh materialized view mt');
				expect(await rows(db, 'select id, ref from mt order by id'))
					.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: 2 }]);
				expect(isStale('mt'), 'a conforming refresh clears stale').to.equal(false);
			});
		});

		describe('commit-first parity on the store backing (an enclosing rollback does not undo a refresh)', () => {
			// The constraint-bearing branch ends in an explicit `conn.commit()` on the
			// resolved attach connection — a DIFFERENT commit mechanism than the MV-sugar
			// store path's `replaceContents` (pinned above in the `refresh` block) and than
			// the memory constraint-bearing branch (pinned engine-wide in the memory spec's
			// `commit-first parity` case). Neither covers a STORE constraint-bearing refresh
			// committing through the coordinator under an enclosing transaction, so pin that
			// the swap is durable past the outer `rollback` here — exact parity with both.
			beforeEach(async () => {
				await db.exec('create table src (id integer primary key, v text not null) using store');
				await db.exec(`create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					using store maintained as select id, v from src`);
				await db.exec(`insert into src values (1, 'a')`);
				await db.exec('alter table src add column pad integer null'); // stale + plan detached
				await db.exec(`insert into src (id, v) values (2, 'b')`);      // conforming drift, unmaintained
			});

			it('a successful constraint-bearing refresh survives an enclosing rollback', async () => {
				await db.exec('begin');
				await db.exec('refresh materialized view mt');
				await db.exec('rollback');

				// `conn.commit()` swapped the store backing independently of the outer txn.
				expect(await rows(db, 'select id, v from mt order by id'))
					.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
				expect(isStale('mt'), 'a successful refresh clears stale even under an enclosing rollback')
					.to.equal(false);
			});
		});

		// Duplicate-derived-key reject is deliberately NOT re-pinned here: the set gate
		// (`assertRefreshRowsAreSet`) runs at the ENGINE level BEFORE `host.applyMaintenance`,
		// so it exercises nothing store-host-specific (no pending `replace-all` write
		// reached yet). It is already owned by the memory spec's `duplicate-key reject
		// parity` block engine-wide, and the store create-fill collision is pinned at
		// `using store(...) args: PK key collation` above (the NOCASE-PK set-gate case).
		// A fully-store source also collapses the case-variant keys on `src`'s OWN store PK
		// (store-default NOCASE keying), so the collision would throw at the source insert,
		// not the refresh — further proof the case is not about the store backing branch.
	});

	it('drop materialized view destroys the store backing and removes both catalog entries', async () => {
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');
		await storeModule.whenCatalogPersisted();
		expect(await catalogHas(buildCatalogKey('main', BACKING))).to.equal(true);
		expect(await catalogHas(buildMaterializedViewCatalogKey('main', 'mv'))).to.equal(true);

		await db.exec('drop materialized view mv');
		await storeModule.whenCatalogPersisted();

		expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
		expect(db.schemaManager.getTable('main', BACKING)).to.be.undefined;
		expect(storeModule.getTable('main', BACKING), 'StoreModule map evicted').to.be.undefined;
		expect(provider.stores.has(`main.${BACKING}`), 'physical backing store deleted').to.equal(false);
		expect(await catalogHas(buildCatalogKey('main', BACKING)), 'table bundle removed').to.equal(false);
		expect(await catalogHas(buildMaterializedViewCatalogKey('main', 'mv')), 'MV catalog entry removed').to.equal(false);
	});

	describe('`using store(...)` args: PK key collation', () => {
		// A memory source whose PK is the text column itself: 'a' and 'A' are
		// distinct rows under the engine's BINARY column default, and the body
		// `select name from src` carries a provable key on (name) — so the
		// backing PK is exactly the text column whose key encoding the store's
		// `collation` arg governs.
		it("collation = 'BINARY' keys the backing PK byte-exactly — case-distinct values survive", async () => {
			await db.exec('create table src (name text primary key, v integer)');
			await db.exec("insert into src values ('a', 1), ('A', 2)");
			await db.exec("create materialized view mv using store(collation = 'BINARY') as select name from src");
			expect(await rows(db, 'select name from mv order by name')).to.deep.equal([{ name: 'A' }, { name: 'a' }]);
		});

		it('a text PK backing refreshes on the data-only path (the wrapper forwards normalizeCreateSchema)', async () => {
			// The backing's text PK has no explicit COLLATE, so the store keys it under
			// K = NOCASE while the body's output type says BINARY. The engine asks the
			// module "what would this schema become?" (`normalizeCreateSchema`) before
			// comparing — and `IsolationModule` must FORWARD that hook, or the probe
			// answers "verbatim" while `create` still rewrote, and refresh misreads the
			// no-op as a physical-PK re-key (an inexpressible reshape ⇒ an error).
			await db.exec('create table src (id integer primary key, a text not null, b integer) using store');
			await db.exec("insert into src values (1, 'x', 10), (2, 'y', 20)");
			await db.exec('create materialized view mv using store as select a, sum(b) as s from src group by a');
			const backing = db.schemaManager.getTable('main', BACKING)!;
			expect(backing.columns[0].collation, 'the store keyed the implicit text PK under K').to.equal('NOCASE');

			await db.exec('refresh materialized view mv');

			expect(db.schemaManager.getTable('main', BACKING), 'data-only refresh preserves the table identity')
				.to.equal(backing);
			expect(await rows(db, 'select a, s from mv order by a'))
				.to.deep.equal([{ a: 'x', s: 10 }, { a: 'y', s: 20 }]);
		});

		it('a declared `collate binary` key survives a source NOT NULL loosening (still data-only)', async () => {
			// The mirror of the case above, and the shape `06.6-aggregate-extended.sqllogic`
			// uses: a table-form maintained table whose text key opts OUT of the store's K.
			// The re-derived shape's key column is IMPLICIT-BINARY, which is compatible with
			// both readings — but only the collation is in question. Weighing the NOT NULL
			// difference too (the backing keeps its physical-PK column NOT NULL; the loosened
			// body does not) pushed the key to NOCASE, marking the view stale and turning
			// `refresh` into a spurious inexpressible re-key.
			await db.exec('create table src (id integer primary key, a text not null, b integer) using store');
			await db.exec("insert into src values (1, 'x', 10), (2, 'y', 20)");
			await db.exec('create table mt (a text not null collate binary primary key, n integer not null) '
				+ 'using store maintained as select a, count(*) as n from src group by a');

			await db.exec('alter table src alter column a drop not null');

			const live = db.schemaManager.getTable('main', 'mt')!;
			expect(live.columns[0].collation, 'the declaration still wins over the store K').to.equal('BINARY');
			expect(db.schemaManager.getMaintainedTable('main', 'mt')!.derivation.stale ?? false,
				'the loosening did not strand the view stale').to.equal(false);

			await db.exec('refresh materialized view mt');
			expect(db.schemaManager.getTable('main', 'mt'), 'data-only refresh preserves the table identity')
				.to.equal(live);
			expect(await rows(db, 'select a, n from mt order by a'))
				.to.deep.equal([{ a: 'x', n: 1 }, { a: 'y', n: 1 }]);
		});

		it('the default key collation (NOCASE) collapses case-variant keys — the set gate rejects the body', async () => {
			await db.exec('create table src (name text primary key, v integer)');
			await db.exec("insert into src values ('a', 1), ('A', 2)");
			// Documented store-backing semantic: a backing text PK column with no
			// EXPLICIT collation keys under the store default K = NOCASE (the same
			// reconcile every `create table … using store` applies), so 'a'/'A'
			// collide and the MV "must be a set" gate fires at create-fill — where a
			// memory backing (BINARY column default) would accept this body.
			await expectThrows(
				() => db.exec('create materialized view mv using store as select name from src'),
				/must be a set/i,
			);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', BACKING), 'half-built backing rolled back').to.be.undefined;
		});
	});
});
