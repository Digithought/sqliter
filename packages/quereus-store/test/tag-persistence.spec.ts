import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildCatalogKey,
	type KVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * A persistent in-memory provider: unlike the teardown-flavored factory in
 * `rehydrate-catalog.spec.ts`, its `closeStore` / `closeIndexStore` / `closeAll`
 * are no-ops, so the underlying data survives a *logical* `StoreModule.closeAll()`
 * — mirroring real disk. This lets a test close db1's module (which drains the
 * catalog persist queue) and then reopen the SAME storage with a fresh module,
 * the only way to express close → reopen. `_hardClose()` is the real teardown.
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

	return {
		stores,
		async getStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return getOrCreate(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return getOrCreate('__catalog__');
		},
		async closeStore() {
			/* no-op: durable storage survives a logical close */
		},
		async closeIndexStore() {
			/* no-op */
		},
		async closeAll() {
			/* no-op: data survives module close, mirroring real disk */
		},
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule catalog-only tag persistence', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	/** Phase 1: create a fresh db + module over the shared provider. */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** Phase 2: a brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<Database> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog DDL parses cleanly').to.have.lengthOf(0);
		return db;
	}

	it('table tags persist across reopen (closeAll drains)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, name text) using store`);
		// INSERT persists the table's DDL to the catalog (lazy on first store access),
		// so the catalog-present check in the listener fires on the later SET TAGS.
		await db.exec(`insert into t values (1, 'x')`);
		await db.exec(`alter table t set tags (display_name = 'Widgets', audit = true)`);
		await mod.closeAll(); // unsubscribes + drains the persist queue before close

		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.deep.equal({ display_name: 'Widgets', audit: true });
	});

	it('column tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, name text) using store`);
		await db.exec(`insert into t values (1, 'x')`);
		await db.exec(`alter table t alter column name set tags (searchable = true, display_name = 'Name')`);
		await mod.closeAll();

		const db2 = await reopen();
		const col = db2.schemaManager.findTable('t')!.columns.find(c => c.name === 'name')!;
		expect(col.tags).to.deep.equal({ searchable: true, display_name: 'Name' });
	});

	it('named UNIQUE constraint tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, email text, constraint uq_email unique (email)) using store`);
		await db.exec(`insert into t values (1, 'a@x')`);
		await db.exec(`alter table t alter constraint uq_email set tags (error_message = 'Email must be unique')`);
		await mod.closeAll();

		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_email')!;
		expect(uc.tags).to.deep.equal({ error_message: 'Email must be unique' });

		// The reopened UNIQUE still enforces (tags are metadata, not a relaxation).
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, 'a@x')`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'duplicate email still rejected after reopen').to.be.true;
	});

	it('named CHECK constraint tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, qty integer, constraint chk_qty check (qty >= 0)) using store`);
		await db.exec(`insert into t values (1, 5)`);
		await db.exec(`alter table t alter constraint chk_qty set tags (error_message = 'Quantity must be non-negative')`);
		await mod.closeAll();

		const db2 = await reopen();
		const cc = db2.schemaManager.findTable('t')!.checkConstraints.find(c => c.name === 'chk_qty')!;
		expect(cc.tags).to.deep.equal({ error_message: 'Quantity must be non-negative' });

		// The reopened CHECK still enforces (tags are metadata, not a relaxation).
		let rejected = false;
		try {
			await db2.exec(`insert into t values (2, -1)`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'CHECK still rejected after reopen').to.be.true;
	});

	it('named FOREIGN KEY constraint tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table parent (id integer primary key) using store`);
		await db.exec(`insert into parent values (1)`);
		await db.exec(`create table child (id integer primary key, pid integer, constraint fk_p foreign key (pid) references parent(id)) using store`);
		await db.exec(`insert into child values (1, 1)`);
		await db.exec(`alter table child alter constraint fk_p set tags (error_message = 'Unknown parent')`);
		await mod.closeAll();

		const db2 = await reopen();
		const fk = db2.schemaManager.findTable('child')!.foreignKeys!.find(c => c.name === 'fk_p')!;
		expect(fk.tags).to.deep.equal({ error_message: 'Unknown parent' });
	});

	it('clearing tags (SET TAGS ()) round-trips, and successive swaps serialize in order', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		// Two swaps back-to-back: the queue must apply them in order so the final
		// state after draining is "cleared".
		await db.exec(`alter table t set tags (x = 1)`);
		await db.exec(`alter table t set tags ()`);
		await mod.closeAll();

		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.be.undefined;
	});

	it('re-setting tags to a new value persists the latest value', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t set tags (display_name = 'First')`);
		await db.exec(`alter table t set tags (display_name = 'Second')`);
		await mod.closeAll();

		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.deep.equal({ display_name: 'Second' });
	});

	it('persists without an explicit close (whenCatalogPersisted barrier)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t set tags (k = 'v')`);

		// In-session, the swap is already live in memory.
		expect(db.schemaManager.getTableTags('t')).to.deep.equal({ k: 'v' });

		// Draining the barrier (no close) makes the catalog current.
		await mod.whenCatalogPersisted();
		const db2 = await reopen();
		expect(db2.schemaManager.getTableTags('t')).to.deep.equal({ k: 'v' });
	});

	it('SET TAGS on a non-store table in the same db leaves the store catalog untouched', async () => {
		const { db, mod } = open();
		// A memory-backed table (default module) alongside a store table.
		await db.exec(`create table mem_t (id integer primary key, name text)`);
		await db.exec(`insert into mem_t values (1, 'm')`);
		await db.exec(`create table store_t (id integer primary key) using store`);
		await db.exec(`insert into store_t values (1)`); // persist store_t DDL

		await db.exec(`alter table mem_t set tags (display_name = 'Mem')`);
		await mod.whenCatalogPersisted();

		const catalog = await provider.getCatalogStore();
		expect(
			await catalog.get(buildCatalogKey('main', 'mem_t')),
			'memory table must NOT be written into the store catalog',
		).to.be.undefined;
		expect(
			await catalog.get(buildCatalogKey('main', 'store_t')),
			'store table catalog entry is present',
		).to.not.be.undefined;
	});

	it('a structural ALTER does not produce a second, differing catalog write', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, name text) using store`);
		await db.exec(`insert into t values (1, 'x')`); // persist DDL (ddlSaved = true)

		// Spy on catalog puts AFTER the initial persistence is done.
		const catalog: KVStore = await provider.getCatalogStore();
		let putCount = 0;
		const origPut = catalog.put.bind(catalog);
		catalog.put = async (key: Uint8Array, value: Uint8Array) => {
			putCount++;
			await origPut(key, value);
		};

		// ADD COLUMN: the store's own alterTable writes the final DDL once; the engine
		// then fires table_modified with the same final schema, so the listener must
		// read identical DDL and skip — no double-write, no clobber.
		await db.exec(`alter table t add column age integer null`);
		await mod.whenCatalogPersisted();

		expect(putCount, 'exactly one catalog write (module); listener skipped identical DDL').to.equal(1);

		const db2 = await reopen();
		const t = db2.schemaManager.findTable('t')!;
		expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'name', 'age']);
	});

	// --- Exposed implicit index user tags (UniqueConstraintSchema.exposedIndexTags) ---
	// Store mode never materializes the implicit covering index as an IndexSchema,
	// so its user tags ride a trailing `alter index … set tags` line in the catalog
	// bundle, re-applied silently by importDDL on rehydrate.

	/** Decode the catalog bundle for main.<table>. */
	async function readCatalogEntry(tableName: string): Promise<string> {
		const catalog = await provider.getCatalogStore();
		const bytes = await catalog.get(buildCatalogKey('main', tableName));
		expect(bytes, `catalog entry for ${tableName} present`).to.not.be.undefined;
		return new TextDecoder().decode(bytes!);
	}

	it('exposed implicit index tags persist across reopen (SET TAGS) and surface via schema()', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin set tags (purpose = 'lookup', audited = true)`);
		await mod.whenCatalogPersisted();

		// The bundle carries the canonical whole-set alter-index line.
		expect(await readCatalogEntry('t')).to.match(/alter index main\.uq_vin set tags \(/);

		await mod.closeAll();
		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_vin')!;
		expect(uc.exposedIndexTags).to.deep.equal({ purpose: 'lookup', audited: true });
		// The exposure flag stays on uc.tags, never leaking into the index tags.
		expect(uc.tags).to.deep.equal({ 'quereus.expose_implicit_index': true });

		// Surfaced identically to a live session through the synthetic catalog entry.
		const rows: unknown[] = [];
		for await (const row of db2.eval(`select json_extract(tags, '$.purpose') as purpose from schema() where type = 'index' and name = 'uq_vin'`)) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([{ purpose: 'lookup' }]);
	});

	it('ADD TAGS / DROP TAGS on an exposed implicit index normalize into the persisted whole-set form', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin add tags (a = 'x', keep = true)`);
		await db.exec(`alter index uq_vin drop tags (a)`);
		await mod.closeAll();

		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_vin')!;
		expect(uc.exposedIndexTags).to.deep.equal({ keep: true });
	});

	it('clearing exposed implicit index tags removes the alter-index line and round-trips empty', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin set tags (x = '1')`);
		await db.exec(`alter index uq_vin set tags ()`);
		await mod.whenCatalogPersisted();

		expect(await readCatalogEntry('t'), 'cleared tags emit no alter-index line').to.not.match(/alter index/i);

		await mod.closeAll();
		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_vin')!;
		expect(uc.exposedIndexTags).to.be.undefined;
	});

	it('an unexposed UNIQUE constraint contributes no alter-index line', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await mod.whenCatalogPersisted();

		expect(await readCatalogEntry('t')).to.not.match(/alter index/i);
	});

	it('a structural ALTER with tagged exposed implicit index still writes the catalog exactly once', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin set tags (purpose = 'lookup')`);
		await mod.whenCatalogPersisted(); // drain the tag write before spying

		const catalog: KVStore = await provider.getCatalogStore();
		let putCount = 0;
		const origPut = catalog.put.bind(catalog);
		catalog.put = async (key: Uint8Array, value: Uint8Array) => {
			putCount++;
			await origPut(key, value);
		};

		// The module's own alterTable write and the follow-up table_modified listener
		// pass must both render the bundle — including the alter-index tag line —
		// byte-identically, so the listener skips.
		await db.exec(`alter table t add column age integer null`);
		await mod.whenCatalogPersisted();
		expect(putCount, 'exactly one catalog write; listener skipped identical bundle').to.equal(1);

		await mod.closeAll();
		const db2 = await reopen();
		const t = db2.schemaManager.findTable('t')!;
		expect(t.columns.map(c => c.name)).to.deep.equal(['id', 'vin', 'age']);
		expect(t.uniqueConstraints!.find(c => c.name === 'uq_vin')!.exposedIndexTags).to.deep.equal({ purpose: 'lookup' });
	});

	it('tags on an unnamed UC follow the implicit name across a column rename', async () => {
		const { db, mod } = open();
		// Unnamed table-level UNIQUE: implicit index name derives from the column (_uc_vin).
		await db.exec(`create table t (id integer primary key, vin text, unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index _uc_vin set tags (purpose = 'lookup')`);
		await db.exec(`alter table t rename column vin to chassis`);
		await mod.whenCatalogPersisted();

		// Emitted name and reopen-time resolution both derive from the post-rename
		// schema, so the bundle targets _uc_chassis.
		expect(await readCatalogEntry('t')).to.match(/alter index main\._uc_chassis set tags \(/);

		await mod.closeAll();
		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints![0];
		expect(uc.exposedIndexTags).to.deep.equal({ purpose: 'lookup' });

		// Addressable under the renamed implicit name.
		await db2.exec(`alter index _uc_chassis add tags (extra = true)`);
		const uc2 = db2.schemaManager.findTable('t')!.uniqueConstraints![0];
		expect(uc2.exposedIndexTags).to.deep.equal({ purpose: 'lookup', extra: true });
	});

	it('dropping the exposure flag drops the tags from persistence (accepted divergence)', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin set tags (purpose = 'lookup')`);
		await db.exec(`alter table t alter constraint uq_vin drop tags ("quereus.expose_implicit_index")`);
		await mod.whenCatalogPersisted();

		// An unexposed constraint emits no alter-index line (emitting one would make
		// the import NOTFOUND-fail), even while exposedIndexTags lingers in-session.
		expect(await readCatalogEntry('t')).to.not.match(/alter index/i);

		// In-session, re-exposing resurrects the dormant tags.
		await db.exec(`alter table t alter constraint uq_vin add tags ("quereus.expose_implicit_index" = true)`);
		const live = db.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_vin')!;
		expect(live.exposedIndexTags, 'dormant tags resurrect in-session').to.deep.equal({ purpose: 'lookup' });

		// But across a reopen taken while unexposed, the tags are gone for good.
		await db.exec(`alter table t alter constraint uq_vin drop tags ("quereus.expose_implicit_index")`);
		await mod.closeAll();
		const db2 = await reopen();
		await db2.exec(`alter table t alter constraint uq_vin add tags ("quereus.expose_implicit_index" = true)`);
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_vin')!;
		expect(uc.exposedIndexTags, 're-exposing after reopen yields no tags').to.be.undefined;
	});

	it('a rehydrated tagged exposed implicit index does not churn the declarative differ', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin set tags (purpose = 'lookup')`);
		await mod.closeAll();

		// Reopen with the store as default module (mirrors the converged-schema
		// pattern in rehydrate-catalog.spec.ts) and re-declare the same shape: a
		// converged schema diffs empty — the rehydrated exposedIndexTags must not
		// surface phantom index ops.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		db2.setDefaultVtabName('store');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);

		await db2.exec(`
			declare schema main
				using (default_vtab_module = 'store')
			{
				table t (
					id INTEGER PRIMARY KEY,
					vin TEXT,
					constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
				);
			}
		`);
		const diffRows: unknown[] = [];
		for await (const row of db2.eval('diff schema main')) {
			diffRows.push(row);
		}
		expect(diffRows, 'no drift on a converged schema').to.deep.equal([]);
	});

	it('multiple exposed implicit indexes on one table each persist their own tags', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, email text,
			constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true),
			constraint uq_email unique (email) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1', 'e1')`);
		await db.exec(`alter index uq_vin set tags (a = '1')`);
		await db.exec(`alter index uq_email set tags (b = '2')`);
		await mod.whenCatalogPersisted();

		// One alter line per constraint, in uniqueConstraints array order — the
		// byte-determinism the compare-write relies on.
		const bundle = await readCatalogEntry('t');
		const vinAt = bundle.indexOf('alter index main.uq_vin set tags (');
		const emailAt = bundle.indexOf('alter index main.uq_email set tags (');
		expect(vinAt, 'uq_vin line present').to.be.greaterThan(-1);
		expect(emailAt, 'uq_email line present').to.be.greaterThan(-1);
		expect(vinAt, 'lines follow uniqueConstraints order').to.be.lessThan(emailAt);

		await mod.closeAll();
		const db2 = await reopen();
		const ucs = db2.schemaManager.findTable('t')!.uniqueConstraints!;
		expect(ucs.find(c => c.name === 'uq_vin')!.exposedIndexTags).to.deep.equal({ a: '1' });
		expect(ucs.find(c => c.name === 'uq_email')!.exposedIndexTags).to.deep.equal({ b: '2' });
	});

	it('hand-crafted add/drop tags bundle lines exercise the merge and drop import arms', async () => {
		// The generator only ever emits the whole-set replace form, so rehydrate
		// normally exercises only that arm of the import path. Write merge/drop
		// lines directly into the catalog bytes to cover the other two.
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await db.exec(`alter index uq_vin set tags (base = 'keep', stale = true)`);
		await mod.closeAll();

		const catalog = await provider.getCatalogStore();
		const key = buildCatalogKey('main', 't');
		const existing = new TextDecoder().decode((await catalog.get(key))!);
		const appended = existing
			+ `\nalter index main.uq_vin add tags (extra = 7)`
			+ `\nalter index main.uq_vin drop tags (stale)`;
		await catalog.put(key, new TextEncoder().encode(appended));

		const db2 = await reopen();
		const uc = db2.schemaManager.findTable('t')!.uniqueConstraints!.find(c => c.name === 'uq_vin')!;
		expect(uc.exposedIndexTags).to.deep.equal({ base: 'keep', extra: 7 });
	});

	it('an alter-index line with an unresolvable target records a per-entry rehydrate error', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, vin text, constraint uq_vin unique (vin)) using store`);
		await db.exec(`insert into t values (1, 'v1')`);
		await mod.closeAll();

		// Simulate corruption: an alter line whose target resolves nowhere (the
		// constraint is unexposed, so the fallback also misses → NOTFOUND).
		const catalog = await provider.getCatalogStore();
		const key = buildCatalogKey('main', 't');
		const existing = new TextDecoder().decode((await catalog.get(key))!);
		await catalog.put(key, new TextEncoder().encode(existing + `\nalter index main.uq_vin set tags (x = 1)`));

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'fail-loud: the bad line is recorded per-entry').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/uq_vin/);
		// Statements apply in document order, so the CREATE TABLE earlier in the
		// same entry already registered (import is not transactional); only the
		// result tally skips the errored entry.
		expect(db2.schemaManager.findTable('t'), 'table registered before the bad line').to.not.be.undefined;
		expect(result.tables).to.deep.equal([]);
	});

	it('after closeAll the listener is detached: a later table_modified does not persist', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t set tags (a = 1)`);
		await mod.closeAll(); // unsubscribes the listener

		const catalog = await provider.getCatalogStore();
		const before = await catalog.get(buildCatalogKey('main', 't'));
		expect(before, 'catalog has the table after drain').to.not.be.undefined;

		// The engine catalog still holds 't'; fire another tag swap on db's notifier.
		// The module listener is gone, so nothing should be re-persisted.
		db.schemaManager.setTableTags('t', { a: 2 });
		await Promise.resolve(); // let any stray microtask run

		const after = await catalog.get(buildCatalogKey('main', 't'));
		const dec = new TextDecoder();
		expect(dec.decode(after!), 'catalog DDL unchanged after unsubscribe').to.equal(dec.decode(before!));
	});
});
