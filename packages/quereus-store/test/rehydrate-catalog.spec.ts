import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
	type RehydrationResult,
} from '../src/index.js';
import { buildCatalogKey } from '../src/common/key-builder.js';

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

describe('StoreModule.rehydrateCatalog()', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('rehydrates a single table from persisted catalog', async () => {
		// Phase 1: create table and persist DDL
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT
			) USING store
		`);
		await db1.exec(`INSERT INTO items VALUES (1, 'Widget')`);

		// Phase 2: new Database, same provider — rehydrate
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);

		expect(result.errors).to.have.lengthOf(0);
		expect(result.tables).to.have.lengthOf(1);

		// Table should be queryable
		const rows = await asyncIterableToArray(db2.eval('select id, name from items'));
		expect(rows).to.deep.equal([{ id: 1, name: 'Widget' }]);
	});

	it('rehydrates multiple tables', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE b (id INTEGER PRIMARY KEY, val TEXT) USING store`);
		// Touch both tables so DDL gets persisted to the catalog
		await db1.exec(`INSERT INTO a VALUES (1)`);
		await db1.exec(`INSERT INTO b VALUES (1, 'x')`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);

		expect(result.errors).to.have.lengthOf(0);
		expect(result.tables).to.have.lengthOf(2);
	});

	it('returns empty result for empty catalog', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		const result = await mod.rehydrateCatalog(db);

		expect(result.tables).to.have.lengthOf(0);
		expect(result.indexes).to.have.lengthOf(0);
		expect(result.errors).to.have.lengthOf(0);
	});

	it('collects errors for corrupt DDL without blocking other tables', async () => {
		// Phase 1: create a real table and touch it to persist DDL
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`CREATE TABLE good (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO good VALUES (1)`);

		// Manually inject a corrupt DDL entry into the catalog
		const catalogStore = await provider.getCatalogStore();
		const encoder = new TextEncoder();
		await catalogStore.put(
			encoder.encode('main.corrupt'),
			encoder.encode('THIS IS NOT VALID SQL')
		);

		// Phase 2: rehydrate — corrupt entry should be skipped
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);

		expect(result.errors).to.have.lengthOf(1);
		expect(result.errors[0].ddl).to.equal('THIS IS NOT VALID SQL');
		expect(result.tables).to.include('main.good');
	});

	it('APPLY SCHEMA sees rehydrated tables and generates correct diff', async () => {
		// Phase 1: create table with original schema
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT
			) USING store
		`);
		await db1.exec(`INSERT INTO users VALUES (1, 'Alice')`);

		// Phase 2: new Database, rehydrate, then APPLY SCHEMA with added column
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		db2.setDefaultVtabName('store');

		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);

		// Declare schema with an additional column
		await db2.exec(`
			declare schema main
				using (default_vtab_module = 'store')
			{
				table users {
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT NULL
				}
			}
		`);

		// Apply should ADD COLUMN, not try to CREATE TABLE
		await db2.exec(`apply schema main`);

		// Verify the column was added and data preserved
		const rows = await asyncIterableToArray(db2.eval('select id, name, email from users'));
		expect(rows).to.deep.equal([{ id: 1, name: 'Alice', email: null }]);
	});

	it('no-ops APPLY SCHEMA when persisted schema matches declared schema', async () => {
		// Phase 1: create table
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING store
		`);
		await db1.exec(`INSERT INTO items VALUES (1, 'Widget')`);

		// Phase 2: rehydrate and declare identical schema
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		db2.setDefaultVtabName('store');

		await mod2.rehydrateCatalog(db2);

		await db2.exec(`
			declare schema main
				using (default_vtab_module = 'store')
			{
				table items {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL
				}
			}
		`);

		// DIFF should produce no migration statements
		const diffRows = await asyncIterableToArray(db2.eval('diff schema main'));
		expect(diffRows).to.have.lengthOf(0);

		// APPLY should be a no-op
		await db2.exec(`apply schema main`);

		// Data preserved
		const rows = await asyncIterableToArray(db2.eval('select * from items'));
		expect(rows).to.deep.equal([{ id: 1, name: 'Widget' }]);
	});

	// Constraint-survival across reopen: generateTableDDL persists the catalog DDL
	// that rehydrateCatalog re-parses, so a table's UNIQUE / CHECK / FOREIGN KEY
	// constraints must still ENFORCE after a fresh Database rehydrates the catalog.
	// Before the fix, generateTableDDL dropped all table constraints, so these
	// inserts would silently succeed on reopen.
	async function expectRejected(fn: () => Promise<unknown>, msg: string): Promise<void> {
		let rejected = false;
		try {
			await fn();
		} catch (e) {
			rejected = true;
			expect(String(e), `${msg}: error mentions constraint`).to.match(/constraint/i);
		}
		expect(rejected, msg).to.be.true;
	}

	it('UNIQUE constraint survives reopen and still rejects duplicates', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`
			CREATE TABLE uq_t (
				id INTEGER PRIMARY KEY,
				email TEXT,
				CONSTRAINT uq_email UNIQUE (email)
			) USING store
		`);
		// Insert persists the DDL (and a row) so the constraint must round-trip.
		await db1.exec(`INSERT INTO uq_t VALUES (1, 'a@x.com')`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed constraint DDL parses cleanly').to.have.lengthOf(0);

		// A duplicate of the persisted email is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO uq_t VALUES (2, 'a@x.com')`),
			'duplicate email rejected after reopen',
		);
		// A distinct email still succeeds.
		await db2.exec(`INSERT INTO uq_t VALUES (3, 'b@x.com')`);
	});

	it('CHECK constraint survives reopen and still rejects violations', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`
			CREATE TABLE chk_t (
				id INTEGER PRIMARY KEY,
				qty INTEGER,
				CONSTRAINT chk_qty CHECK (qty > 0)
			) USING store
		`);
		await db1.exec(`INSERT INTO chk_t VALUES (1, 5)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed constraint DDL parses cleanly').to.have.lengthOf(0);

		// A CHECK-violating insert is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO chk_t VALUES (2, -1)`),
			'CHECK violation rejected after reopen',
		);
		// A satisfying insert still succeeds.
		await db2.exec(`INSERT INTO chk_t VALUES (3, 10)`);
	});

	it('FOREIGN KEY constraint survives reopen and still rejects orphans', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE fk_parent (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`
			CREATE TABLE fk_child (
				id INTEGER PRIMARY KEY,
				pref INTEGER,
				CONSTRAINT fk_pref FOREIGN KEY (pref) REFERENCES fk_parent (pid)
			) USING store
		`);
		await db1.exec(`INSERT INTO fk_parent VALUES (1)`);
		// Valid child (parent 1 exists); persists both tables' DDL.
		await db1.exec(`INSERT INTO fk_child VALUES (10, 1)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed constraint DDL parses cleanly').to.have.lengthOf(0);

		// An orphan child (no parent pid=99) is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO fk_child VALUES (20, 99)`),
			'orphan child rejected after reopen',
		);
		// A valid child (parent pid=1 exists) still succeeds.
		await db2.exec(`INSERT INTO fk_child VALUES (21, 1)`);
	});

	// ALTER TABLE ADD COLUMN with a column-level constraint must persist that
	// constraint into the catalog DDL — the engine merges it into the live
	// in-memory schema, but only the store's persisted DDL survives reopen.
	it('ADD COLUMN column-level FOREIGN KEY survives reopen and still rejects orphans', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE p (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE c (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO p VALUES (1)`);
		await db1.exec(`INSERT INTO c VALUES (10)`);
		// Add a column carrying a column-level FK. The column is nullable, so the
		// existing row's new value is NULL, which MATCH-SIMPLE exempts from the FK —
		// the ALTER succeeds. (Without NULL the store defaults to NOT NULL and rejects
		// the no-default backfill on a non-empty table.)
		await db1.exec(`ALTER TABLE c ADD COLUMN pref INTEGER NULL REFERENCES p (pid)`);
		// Live enforcement: an orphan is rejected in the same session.
		await expectRejected(
			() => db1.exec(`INSERT INTO c VALUES (11, 99)`),
			'orphan rejected live (pre-reopen)',
		);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed ADD COLUMN FK DDL parses cleanly').to.have.lengthOf(0);

		// The persisted column-level FK must still reject an orphan after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO c VALUES (12, 99)`),
			'orphan child rejected after reopen',
		);
		// A valid child (parent pid=1 exists) still succeeds.
		await db2.exec(`INSERT INTO c VALUES (13, 1)`);
	});

	it('ADD COLUMN column-level CHECK survives reopen and still rejects violations', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`CREATE TABLE chk_add (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO chk_add VALUES (1)`);
		// Column-level CHECK on the added column. The nullable column leaves the
		// existing row's qty NULL, which CHECK admits (passes on NULL), so the ALTER
		// succeeds. (NULL also dodges the store's NOT NULL no-default backfill reject.)
		await db1.exec(`ALTER TABLE chk_add ADD COLUMN qty INTEGER NULL CHECK (qty > 0)`);
		await expectRejected(
			() => db1.exec(`INSERT INTO chk_add VALUES (2, -1)`),
			'CHECK violation rejected live (pre-reopen)',
		);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed ADD COLUMN CHECK DDL parses cleanly').to.have.lengthOf(0);

		// A CHECK-violating insert is still rejected after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO chk_add VALUES (3, -5)`),
			'CHECK violation rejected after reopen',
		);
		// A satisfying insert still succeeds.
		await db2.exec(`INSERT INTO chk_add VALUES (4, 10)`);
	});

	// Persistence must NOT be gated on a foldable (literal) DEFAULT: a per-row
	// (non-foldable) DEFAULT like `new.id` rides a backfill evaluator, but the
	// column-level FK is extracted from the AST regardless and must still persist.
	it('ADD COLUMN with per-row DEFAULT + column-level FK survives reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE pp (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE cc (id INTEGER PRIMARY KEY) USING store`);
		// Parent must contain every existing child id, since the new column backfills
		// each existing row to `new.id` and the FK validates those backfilled values.
		await db1.exec(`INSERT INTO pp VALUES (1)`);
		await db1.exec(`INSERT INTO cc VALUES (1)`);
		// Per-row (non-foldable) DEFAULT `new.id` + column-level FK to pp(pid).
		await db1.exec(`ALTER TABLE cc ADD COLUMN pref INTEGER DEFAULT (new.id) REFERENCES pp (pid)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed per-row-default ADD COLUMN FK DDL parses cleanly').to.have.lengthOf(0);

		// The persisted FK must still reject an orphan after reopen.
		await expectRejected(
			() => db2.exec(`INSERT INTO cc VALUES (20, 99)`),
			'orphan child rejected after reopen (per-row default path)',
		);
		// A valid child (parent pid=1 exists) still succeeds.
		await db2.exec(`INSERT INTO cc VALUES (21, 1)`);
	});

	// An explicitly-NAMED column-level constraint takes the `con.name` branch of the
	// extraction (not the `_fk_<col>` auto-name). The persisted DDL must carry that name
	// so the re-parsed constraint enforces identically after reopen.
	it('ADD COLUMN explicitly-named column-level FK survives reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE np (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE nc (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO np VALUES (1)`);
		await db1.exec(`INSERT INTO nc VALUES (10)`);
		await db1.exec(`ALTER TABLE nc ADD COLUMN pref INTEGER NULL CONSTRAINT my_named_fk REFERENCES np (pid)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed named ADD COLUMN FK DDL parses cleanly').to.have.lengthOf(0);

		await expectRejected(
			() => db2.exec(`INSERT INTO nc VALUES (12, 99)`),
			'orphan child rejected after reopen (named FK)',
		);
		await db2.exec(`INSERT INTO nc VALUES (13, 1)`);
	});

	// A no-PRIMARY-KEY table synthesizes an all-columns key whose columns keep their
	// declared nullability (ticket lens-no-pk-nullable-column-deploy-mismatch). The
	// persistence round-trip is the highest-risk path: generateTableDDL must OMIT the
	// synthesized PK clause so rehydrateCatalog re-synthesizes the key instead of
	// treating a named all-columns PK as explicit and re-forcing NOT NULL. This pins
	// that the nullable declaration AND a stored NULL-in-key row survive a reopen.
	it('no-PK nullable table preserves nullability and a NULL-in-key row across reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`CREATE TABLE npk (a INTEGER NULL, b INTEGER NULL) USING store`);
		// A NULL participates in the synthesized all-columns key; persists DDL + row.
		await db1.exec(`INSERT INTO npk (a, b) VALUES (null, 5)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed no-PK DDL parses cleanly').to.have.lengthOf(0);

		// Nullability survived: a declared PK would have re-forced NOT NULL on reopen.
		const t = db2.schemaManager.findTable('npk')!;
		expect(t.columns.find(c => c.name === 'a')!.notNull, 'a nullable after reopen').to.equal(false);
		expect(t.columns.find(c => c.name === 'b')!.notNull, 'b nullable after reopen').to.equal(false);
		expect(t.columns.find(c => c.name === 'a')!.primaryKey, 'a still in synthesized key').to.equal(true);

		// The persisted NULL-in-key row is readable.
		const rows = await asyncIterableToArray(db2.eval('select a, b from npk'));
		expect(rows).to.deep.equal([{ a: null, b: 5 }]);

		// A fully-identical row collides on the synthesized key — a key/constraint
		// conflict, NOT a NOT NULL failure (the pre-fix symptom).
		let dupMsg: string | undefined;
		try {
			await db2.exec(`INSERT INTO npk (a, b) VALUES (null, 5)`);
		} catch (e) {
			dupMsg = String(e);
		}
		expect(dupMsg, 'duplicate NULL-in-key row rejected after reopen').to.not.be.undefined;
		expect(dupMsg!, 'rejected as a key conflict, not NOT NULL').to.not.match(/NOT NULL/i);
		expect(dupMsg!, 'a key/constraint conflict').to.match(/constraint|unique|duplicate|primary key/i);

		// A distinct row still inserts and reads back (NULL value preserved).
		await db2.exec(`INSERT INTO npk (a, b) VALUES (null, 6)`);
		const rows2 = await asyncIterableToArray(db2.eval('select a, b from npk order by b'));
		expect(rows2).to.deep.equal([{ a: null, b: 5 }, { a: null, b: 6 }]);
	});

	// A non-default column COLLATE must survive the persistence round-trip: the catalog
	// stores the canonical CREATE TABLE DDL and rehydrates by re-parsing it, so if
	// generateTableDDL drops COLLATE the column silently reverts to BINARY on reopen —
	// changing its comparison / sort / unique semantics. Pins that the rehydrated
	// schema carries `collation === 'NOCASE'` (deterministic, authoritative assert).
	it('non-default column COLLATE survives reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec(`CREATE TABLE ci (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE) USING store`);
		// Insert a row so the table (and its DDL) is persisted.
		await db1.exec(`INSERT INTO ci (id, name) VALUES (1, 'Alice')`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed collated DDL parses cleanly').to.have.lengthOf(0);

		// Primary assert: the rehydrated schema preserved the column collation.
		// Before the generator fix this would be 'BINARY'.
		const t = db2.schemaManager.findTable('ci')!;
		expect(t.columns.find(c => c.name === 'name')!.collation, 'name keeps NOCASE after reopen').to.equal('NOCASE');
	});

	// Option (a) reload provenance-upgrade (ticket collation-provenance-stability-
	// set-collate-and-reload): a column whose collation came from session
	// `default_collation` is rank 1 (`default`) IN-SESSION — it loses silently to a
	// declared collation on the other operand — but the persisted DDL is fully
	// explicit (an explicit `COLLATE` for any non-BINARY collation), so on reopen the
	// re-parsed clause sets `collationExplicit` and the column reloads as rank 2
	// (`declared`). The documented effect is fail-louder-only: a comparison that
	// resolved silently in-session becomes a prepare-time ambiguous-collation error
	// after reopen — never silently different results. This locks that boundary
	// upgrade, which was otherwise covered by prose alone.
	it('default_collation-derived collation upgrades rank 1 → declared across reopen (fail-louder)', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		// `v` inherits NOCASE from the session default (rank 1, collationExplicit
		// false); `r` is a declared RTRIM (rank 2). 'xx ' = 'xx' matches under RTRIM
		// but not under NOCASE, so a returned row proves the in-session comparison
		// resolved to the rank-2 RTRIM winner with no conflict.
		await db1.exec(`PRAGMA default_collation = 'nocase'`);
		await db1.exec(`CREATE TABLE prov (id INTEGER PRIMARY KEY, v TEXT, r TEXT COLLATE RTRIM) USING store`);
		await db1.exec(`INSERT INTO prov VALUES (1, 'xx ', 'xx')`);
		const inSession = await asyncIterableToArray(db1.eval('select id from prov where v = r'));
		expect(inSession, 'in-session: rank-1 default v loses silently to declared RTRIM r').to.deep.equal([{ id: 1 }]);

		// Reopen into a fresh Database (default_collation back at BINARY — irrelevant,
		// since the persisted DDL carries an explicit COLLATE NOCASE).
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed default-derived collation DDL parses cleanly').to.have.lengthOf(0);
		// The rehydrated column carries NOCASE...
		const t = db2.schemaManager.findTable('prov')!;
		expect(t.columns.find(c => c.name === 'v')!.collation, 'v keeps NOCASE after reopen').to.equal('NOCASE');
		// ...and now contributes at rank 2, so v = r is a same-rank declared conflict.
		let rejected = false;
		try {
			await asyncIterableToArray(db2.eval('select id from prov where v = r'));
		} catch (e) {
			rejected = true;
			expect(String(e), 'after reopen: rank-2 NOCASE vs rank-2 RTRIM is an ambiguous-collation error')
				.to.match(/ambiguous collation/i);
		}
		expect(rejected, 'the silently-resolved in-session comparison fails louder after reopen').to.be.true;
	});

	// A single ADD COLUMN declaring BOTH a CHECK and an FK exercises the store's two
	// independent merge arms (checkConstraints AND foreignKeys both extended on
	// `persistedSchema`). Both must persist and enforce after reopen.
	it('ADD COLUMN with combined CHECK + FK survives reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('PRAGMA foreign_keys = true');
		await db1.exec(`CREATE TABLE bp (pid INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`CREATE TABLE bc (id INTEGER PRIMARY KEY) USING store`);
		await db1.exec(`INSERT INTO bp VALUES (1)`);
		await db1.exec(`INSERT INTO bc VALUES (10)`);
		await db1.exec(`ALTER TABLE bc ADD COLUMN pref INTEGER NULL CHECK (pref > 0) REFERENCES bp (pid)`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('PRAGMA foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed combined CHECK+FK ADD COLUMN DDL parses cleanly').to.have.lengthOf(0);

		// CHECK arm: pref must be > 0 (parent 1 exists, so FK alone would admit it).
		await expectRejected(
			() => db2.exec(`INSERT INTO bc VALUES (12, 0)`),
			'CHECK violation (pref=0) rejected after reopen (combined)',
		);
		// FK arm: pref=99 passes the CHECK but has no parent.
		await expectRejected(
			() => db2.exec(`INSERT INTO bc VALUES (13, 99)`),
			'orphan (pref=99) rejected after reopen (combined)',
		);
		// Satisfies both: > 0 AND parent pid=1 exists.
		await db2.exec(`INSERT INTO bc VALUES (14, 1)`);
	});

	// The store load path no longer reconciles PK collations (ticket
	// store-pk-collate-drop-ineffective-connect-leniency). A legacy / hand-authored
	// persisted DDL whose text PK declares a collation diverging from the fixed key
	// collation K must stay loadable AS-DECLARED: no misleading `[StoreModule]
	// Normalized a divergent…` warning fires on reopen, and `table_info` reports the
	// stale-but-loadable declared collation (BINARY here), not K (NOCASE). The old
	// `connect` leniency arm only coerced the transient StoreTable — which the
	// post-import reconcile loop immediately overwrote — so it logged a normalization
	// that never survived reopen. Physical key bytes are always K-encoded, so this is
	// a declared-side `table_info` fact, not a correctness risk. The genuine reopen
	// migration stays deferred in store-pk-collate-legacy-reopen-divergence.
	it('legacy divergent text-PK collation loads without a Normalized warning and reports the declared collation', async () => {
		// Hand-seed a raw catalog entry to stand in for a legacy persisted DDL whose text PK
		// declares BINARY. (A normal CREATE now HONORS that as a per-column BINARY key; this
		// arm specifically guards the load path's no-reconcile / no-warn contract, so it seeds
		// the catalog directly.) `using store` routes the entry through this module's
		// rehydration; the key matches saveTableDDL's `buildCatalogKey(schema, table)`.
		const catalogStore = await provider.getCatalogStore();
		await catalogStore.put(
			buildCatalogKey('main', 't'),
			new TextEncoder().encode('create table t (x text collate binary primary key) using store'),
		);

		// Spy on console.warn so the assertion is that the *normalization* warning is
		// gone — not merely that warnings are silent (recordError also uses console.warn).
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...captured: unknown[]) => { warnings.push(captured.map(String).join(' ')); };

		const db = new Database();
		let result!: RehydrationResult;
		try {
			const mod = new StoreModule(provider);
			db.registerModule('store', mod);
			result = await mod.rehydrateCatalog(db);
		} finally {
			console.warn = originalWarn;
		}

		// The legacy DDL parsed cleanly and registered the table (no recordError).
		expect(result.errors, 'legacy divergent-PK DDL loads cleanly').to.have.lengthOf(0);
		expect(result.tables, 'table t rehydrated').to.include('main.t');

		// (a) No misleading "Normalized a divergent…" warning fired on the load path.
		expect(
			warnings.filter(w => /Normalized a divergent/.test(w)),
			'load path no longer logs a normalization that never survives reopen',
		).to.have.lengthOf(0);

		// (b) table_info reports the stale-but-loadable DECLARED collation (BINARY),
		// not the physical key collation K (NOCASE) — documented, not silently coerced.
		const info = await asyncIterableToArray(db.eval(`select name, collation from table_info('t')`));
		const x = info.find(r => String(r.name).toLowerCase() === 'x');
		expect(x, 'column x present in table_info').to.not.be.undefined;
		expect(String(x!.collation).toUpperCase(), 'declared (stale) collation reported as-is').to.equal('BINARY');

		// The table is queryable and usable after reopen (key bytes are K-encoded).
		expect(await asyncIterableToArray(db.eval('select x from t')), 'empty table reads back').to.deep.equal([]);
		await db.exec(`insert into t values ('a')`);
		expect(await asyncIterableToArray(db.eval('select x from t')), 'inserted row round-trips').to.deep.equal([{ x: 'a' }]);

		await db.close();
	});

	// Per-column PK key collation survives a close → reopen. The store keys PRIMARY KEY
	// columns under their declared collation (store-pk-collate-physical-rekey), so a
	// divergent (BINARY) PK key collation — established either by an explicit `collate
	// binary` CREATE or by a SET COLLATE re-key of a default-NOCASE PK — must still be in
	// force after a fresh Database rehydrates the catalog: the re-encoded physical keys
	// and the reloaded column collation must agree, or point lookups / uniqueness break.
	it('per-column PK key collation round-trips through close → reopen', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		// (1) explicit `collate binary` CREATE — holds a case-distinct pair NOCASE can't.
		await db1.exec(`create table bpk (k text collate binary primary key) using store`);
		await db1.exec(`insert into bpk values ('a'), ('A')`);

		// (2) SET COLLATE re-key of a default-NOCASE PK to BINARY, then a case-distinct insert.
		await db1.exec(`create table spk (k text primary key) using store`);
		await db1.exec(`insert into spk values ('a')`);
		await db1.exec(`alter table spk alter column k set collate binary`);
		await db1.exec(`insert into spk values ('A')`);

		await mod1.whenCatalogPersisted();

		// Reopen: fresh module + Database over the SAME provider (stores persist).
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		// (a) Both case-distinct pairs survived and read back under BINARY ordering
		//     ('A' = 0x41 sorts before 'a' = 0x61).
		expect(await asyncIterableToArray(db2.eval(`select k from bpk order by k`)), 'bpk under BINARY')
			.to.deep.equal([{ k: 'A' }, { k: 'a' }]);
		expect(await asyncIterableToArray(db2.eval(`select k from spk order by k`)), 'spk under BINARY')
			.to.deep.equal([{ k: 'A' }, { k: 'a' }]);

		// (b) table_info reports BINARY for each reopened PK column.
		for (const t of ['bpk', 'spk']) {
			const info = await asyncIterableToArray(db2.eval(`select name, collation from table_info('${t}')`));
			const k = info.find(r => String(r.name).toLowerCase() === 'k');
			expect(String(k!.collation).toUpperCase(), `${t}.k collation after reopen`).to.equal('BINARY');
		}

		// (c) BINARY uniqueness still enforced after reopen, and a point lookup addresses
		//     the re-encoded keys.
		await expectRejected(() => db2.exec(`insert into bpk values ('A')`), 'exact-dup PK rejected after reopen');
		expect(await asyncIterableToArray(db2.eval(`select k from bpk where k = 'A'`)), 'point lookup under BINARY key')
			.to.deep.equal([{ k: 'A' }]);

		await db2.close();
	});

	// Quoted identifiers may legally contain a dot: table "a.b" composes a
	// tableKey of 'main.a.b'. StoreModule.getStore used to recover
	// (schemaName, tableName) by splitting that composite key on '.', which
	// mis-routed the extra segment — 'main.a.b'.split('.') dropped the 'b'
	// and opened the physical store for ('main', 'a') instead of ('main', 'a.b').
	// The bug only surfaced on a `this.stores` cache miss, i.e. the first touch
	// of a table's store after a fresh StoreModule (reconnect/rehydrate) — so
	// this test must reopen with a NEW StoreModule instance, not reuse mod1.
	it('quoted table name containing a dot survives reconnect (tableKey split mis-route)', async () => {
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`CREATE TABLE "a.b" (id INTEGER PRIMARY KEY, v TEXT) USING store`);
		await db1.exec(`CREATE TABLE "a.c" (id INTEGER PRIMARY KEY, v TEXT) USING store`);
		await db1.exec(`INSERT INTO "a.b" VALUES (1, 'from-b')`);
		await db1.exec(`INSERT INTO "a.c" VALUES (1, 'from-c')`);

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);

		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 're-parsed dotted-identifier DDL parses cleanly').to.have.lengthOf(0);
		expect(result.tables).to.have.lengthOf(2);

		// Each table reads back its own row from its own physical store — not
		// collapsed onto ('main', 'a') nor onto each other.
		const bRows = await asyncIterableToArray(db2.eval(`select v from "a.b" where id = 1`));
		expect(bRows, '"a.b" reads back its own row after reconnect').to.deep.equal([{ v: 'from-b' }]);

		const cRows = await asyncIterableToArray(db2.eval(`select v from "a.c" where id = 1`));
		expect(cRows, '"a.c" reads back its own row after reconnect').to.deep.equal([{ v: 'from-c' }]);
	});
});
