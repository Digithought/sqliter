import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// Reopen idempotency for `apply schema … with seed` (ticket
// declarative-seed-reopen-pk-collision).
//
// A previously-seeded database whose row data lives in a host-backed vtab (here
// the store) persists those rows in the shared provider. On reopen, a fresh
// `Database` whose in-memory catalog is NOT rehydrated re-runs `declare` +
// `apply schema … with seed`. Before the fix, the seed step diffed the declared
// tables against the EPHEMERAL catalog, misclassified the persisted table as
// freshly-created, skipped the `DELETE` wipe, and ran bare `INSERT`s that
// collided with the persisted rows → `UNIQUE constraint failed: <table> PK`.
//
// The fix makes seed application idempotent — each seed row is written as
// `INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk>) DO NOTHING` (ticket
// seed-or-ignore-masks-malformed-rows; previously `INSERT OR IGNORE`, before
// that `INSERT OR REPLACE`) — so a reopen reseeds cleanly regardless of whether
// the catalog was rehydrated. The store path has no `asOf` snapshot fault, so it
// both reproduces the original crash and serves as the in-repo regression harness.

function createInMemoryProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		stores,
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
	};
}

// Brace-form table body + a sibling `seed` item, routed through the store via the
// USING clause. Re-declared verbatim on every open (the declared schema lives in
// the ephemeral DeclaredSchemaManager, not the persistent backing).
const DECLARE_SQL = `
	declare schema main
		using (default_vtab_module = 'store')
	{
		table tablemetadata {
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL
		}
		seed tablemetadata ((1, 'AllSite'), (2, 'Other'))
	}
`;

const SEED_ROWS = [
	{ id: 1, name: 'AllSite' },
	{ id: 2, name: 'Other' },
];

describe('declarative seed: reopen idempotency (store)', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	async function readSeedTable(db: Database): Promise<unknown[]> {
		return asyncIterableToArray(db.eval('select id, name from tablemetadata order by id'));
	}

	/** Open a fresh Database over the shared provider, register the store, declare + seed. */
	async function open(seed = false): Promise<{ db: Database; mod: StoreModule }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		db.setDefaultVtabName('store');
		await db.exec(DECLARE_SQL);
		if (seed) await db.exec('apply schema main with seed');
		return { db, mod };
	}

	// (c) A genuinely-fresh first apply still seeds correctly — no regression from
	// removing the freshly-created / DELETE-skip heuristic.
	it('seeds a genuinely-fresh table on first apply', async () => {
		const { db } = await open(true);
		expect(await readSeedTable(db)).to.deep.equal(SEED_ROWS);
		await db.close();
	});

	// (a) The bug: reopen WITHOUT rehydrateCatalog. The ephemeral catalog is empty,
	// so the table is created against the still-populated backing and the seed must
	// upsert rather than collide. Pre-fix this threw `UNIQUE constraint failed`.
	it('re-applies seed on reopen WITHOUT rehydrateCatalog (no PK collision)', async () => {
		const { db: db1, mod: mod1 } = await open(true);
		expect(await readSeedTable(db1), 'first open seeds').to.deep.equal(SEED_ROWS);
		await mod1.whenCatalogPersisted();

		// Fresh Database + module over the SAME provider; NO rehydrateCatalog.
		const { db: db2 } = await open(true);
		expect(await readSeedTable(db2), 'reopen reseeds without colliding').to.deep.equal(SEED_ROWS);

		await db1.close();
		await db2.close();
	});

	// (b) Reopen WITH rehydrateCatalog still passes. Here the catalog IS populated,
	// so the old code's wipe-then-reseed path used to run; the idempotent upsert
	// must keep this case green too.
	it('re-applies seed on reopen WITH rehydrateCatalog', async () => {
		const { db: db1, mod: mod1 } = await open(true);
		expect(await readSeedTable(db1), 'first open seeds').to.deep.equal(SEED_ROWS);
		await mod1.whenCatalogPersisted();

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		db2.setDefaultVtabName('store');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);
		await db2.exec(DECLARE_SQL);
		await db2.exec('apply schema main with seed');
		expect(await readSeedTable(db2), 'rehydrated reopen reseeds').to.deep.equal(SEED_ROWS);

		await db1.close();
		await db2.close();
	});

	// (d) ON CONFLICT (<pk>) DO NOTHING semantics: a re-apply with seed on a table that
	// already holds BOTH seed rows and a non-seed user row leaves all existing rows
	// intact — both the user-added row and the user-edited seed row are preserved
	// unchanged.
	it('preserves user edits and non-seed rows across a reopen reseed (ON CONFLICT DO NOTHING)', async () => {
		const { db: db1, mod: mod1 } = await open(true);
		// A user adds a row beyond the seed set, and mutates a seeded row.
		await db1.exec(`insert into tablemetadata values (3, 'UserAdded')`);
		await db1.exec(`update tablemetadata set name = 'Edited' where id = 2`);
		await mod1.whenCatalogPersisted();

		// Reopen (no rehydrate) and re-seed: ON CONFLICT (<pk>) DO NOTHING skips existing
		// PKs, so both the user edit (id=2) and the user-added row (id=3) survive unchanged.
		const { db: db2 } = await open(true);
		expect(await readSeedTable(db2)).to.deep.equal([
			{ id: 1, name: 'AllSite' },
			{ id: 2, name: 'Edited' },    // user edit preserved (DO NOTHING skips existing row)
			{ id: 3, name: 'UserAdded' }, // non-seed row preserved
		]);

		await db1.close();
		await db2.close();
	});
});
