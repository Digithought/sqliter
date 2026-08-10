/**
 * CREATE-conformance — store leg of the per-column PRIMARY KEY collation contract.
 *
 * Companion to `alter-table-conformance.spec.ts`. The store enforces PRIMARY KEY
 * uniqueness/ordering PHYSICALLY in the key bytes under a PER-COLUMN key collation
 * (`StoreTable.pkKeyCollations`, drawn from each PK column's declared `collation`),
 * so ANY declared PK collation is honored natively — an explicit `collate binary`
 * text PK is keyed under BINARY, `collate nocase` under NOCASE, `collate rtrim`
 * under RTRIM. `StoreModule.create` only supplies the store's table-level DEFAULT
 * K (`config.collation || 'NOCASE'`) to an IMPLICIT-default text PK column (so an
 * undecorated text PK keeps the store's historical NOCASE-keyed behavior rather
 * than the engine's BINARY column default); an EXPLICIT collation is left exactly
 * as declared and keyed under it. There is no longer any declared≠enforced split,
 * and no CREATE-time `UNSUPPORTED` reject for a divergent PK collation.
 *
 * Store backing: the in-memory KV provider (same as `alter-table.spec.ts`), so this
 * stays in the fast `yarn test` lane (no LevelDB).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// ── In-memory KV provider (mirrors alter-table-conformance.spec.ts) ───────────

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() { /* no-op */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

// ── Read-back helpers ─────────────────────────────────────────────────────────

async function rows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) out.push(r);
	return out;
}

async function collationOf(db: Database, column: string, table = 't'): Promise<string | undefined> {
	const all = await rows(db, `select name, collation from table_info('${table}')`);
	const info = all.find(r => String(r.name).toLowerCase() === column.toLowerCase());
	return info ? String(info.collation).toUpperCase() : undefined;
}

async function tableExists(db: Database, table = 't'): Promise<boolean> {
	// `table_info` throws (not returns empty) when the table is absent, so a thrown
	// "not found" is the negative answer; any other error propagates.
	try {
		return (await rows(db, `select name from table_info('${table}')`)).length > 0;
	} catch (e) {
		if (e instanceof QuereusError && /not found|no such table/i.test(e.message)) return false;
		throw e;
	}
}

async function attempt(db: Database, sql: string): Promise<QuereusError | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e; // a crash is not a clean reject
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CREATE conformance — store PK collation reconciliation', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('implicit-default text PK reports the fixed key collation K (NOCASE), not BINARY', async () => {
		await db.exec(`create table t (x text primary key) using store`);
		expect(await collationOf(db, 'x'), 'declared collation == enforced K').to.equal('NOCASE');

		// Enforcement under K: 'a' and 'A' collide on a NOCASE key. With declaration
		// now == enforcement this is no longer a silent divergence.
		await db.exec(`insert into t values ('a')`);
		const err = await attempt(db, `insert into t values ('A')`);
		expect(err, `expected a NOCASE PK collision`).to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
	});

	it('explicit collate NOCASE on a text PK (== K) is honored', async () => {
		await db.exec(`create table t (x text collate nocase primary key) using store`);
		expect(await collationOf(db, 'x')).to.equal('NOCASE');
		expect(await tableExists(db)).to.equal(true);
	});

	it('explicit collate BINARY on a text PK (≠ K) is honored — keyed under BINARY', async () => {
		await db.exec(`create table t (x text collate binary primary key) using store`);
		expect(await collationOf(db, 'x'), 'declared BINARY honored').to.equal('BINARY');

		// Keyed under BINARY: 'a' and 'A' are distinct (would collide on a NOCASE key).
		await db.exec(`insert into t values ('a')`);
		await db.exec(`insert into t values ('A')`);
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'case-distinct PKs coexist under BINARY').to.equal(2);

		// Ordering follows BINARY: 'A' (0x41) sorts before 'a' (0x61).
		const ordered = (await rows(db, `select x from t order by x`)).map(r => String(r.x));
		expect(ordered, 'PK ordering follows BINARY').to.deep.equal(['A', 'a']);

		// An exact-duplicate PK still collides.
		const dup = await attempt(db, `insert into t values ('a')`);
		expect(dup, 'exact-duplicate PK rejected').to.be.instanceOf(QuereusError);
		expect(dup!.code).to.equal(StatusCode.CONSTRAINT);
	});

	it('explicit collate RTRIM on a text PK (third collation, ≠ K) is honored — keyed under RTRIM', async () => {
		await db.exec(`create table t (x text collate rtrim primary key) using store`);
		expect(await collationOf(db, 'x'), 'declared RTRIM honored').to.equal('RTRIM');

		await db.exec(`insert into t values ('a')`);
		// RTRIM trims trailing whitespace before keying, so 'a   ' collides with 'a'.
		const err = await attempt(db, `insert into t values ('a   ')`);
		expect(err, 'trailing-space variant collides under RTRIM key').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
	});

	it('composite PK: explicit-divergent text member is honored — member keyed under BINARY', async () => {
		await db.exec(`create table t (a text collate binary, b integer, primary key (a, b)) using store`);
		expect(await collationOf(db, 'a'), 'declared BINARY member honored').to.equal('BINARY');

		await db.exec(`insert into t values ('a', 1)`);
		await db.exec(`insert into t values ('A', 1)`); // distinct under BINARY a
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'case-distinct composite PKs coexist').to.equal(2);
	});

	it('composite PK: implicit text member is normalized to K; integer member unaffected', async () => {
		await db.exec(`create table t (a text, b integer, primary key (a, b)) using store`);
		expect(await collationOf(db, 'a'), 'text PK member normalized to K').to.equal('NOCASE');
		// `b` is an integer PK member: collation is not meaningful for it, so it keeps
		// the BINARY default — the negative guard against over-normalizing non-text PKs.
		expect(await collationOf(db, 'b')).to.equal('BINARY');
	});

	it('integer PK keeps declared BINARY (negative guard against over-normalizing non-text PKs)', async () => {
		await db.exec(`create table t (id integer primary key) using store`);
		expect(await collationOf(db, 'id')).to.equal('BINARY');
	});

	it('non-PK text column is untouched (keeps BINARY default)', async () => {
		await db.exec(`create table t (id integer primary key, name text) using store`);
		expect(await collationOf(db, 'name'), 'only PK columns are reconciled').to.equal('BINARY');
	});

	it('after a default text-PK create, SET COLLATE binary is honored via a physical re-key', async () => {
		// The default text PK is keyed NOCASE (== K). SET COLLATE binary re-keys the data
		// store under BINARY, after which a case-distinct PK that NOCASE would have
		// collapsed can coexist.
		await db.exec(`create table t (x text primary key) using store`);
		expect(await collationOf(db, 'x')).to.equal('NOCASE');
		await db.exec(`insert into t values ('a')`);

		await db.exec(`alter table t alter column x set collate binary`);
		expect(await collationOf(db, 'x'), 'collation re-keyed to BINARY').to.equal('BINARY');

		await db.exec(`insert into t values ('A')`); // now distinct under BINARY
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'case-distinct PK coexists post-re-key').to.equal(2);
	});

	// ── K-parameterization: the IMPLICIT-default normalize tracks `config.collation`,
	// not a hardcoded NOCASE. With K = BINARY the implicit default is BINARY; an explicit
	// `collate nocase` PK is still honored (keyed NOCASE) rather than normalized. These
	// guard against the implicit-default fallback being silently pinned to the default K. ──

	it('K=BINARY: implicit-default text PK is consistent and stays BINARY (no spurious normalize)', async () => {
		await db.exec(`create table t (x text primary key) using store (collation = 'binary')`);
		expect(await collationOf(db, 'x'), 'declared BINARY == implicit-default K=BINARY').to.equal('BINARY');
		expect(await tableExists(db)).to.equal(true);
	});

	it('K=BINARY: explicit collate nocase on a text PK is honored — keyed under NOCASE', async () => {
		await db.exec(`create table t (x text collate nocase primary key) using store (collation = 'binary')`);
		expect(await collationOf(db, 'x'), 'declared NOCASE honored even though K=BINARY').to.equal('NOCASE');

		// Keyed under NOCASE: 'a' and 'A' collide despite K=BINARY.
		await db.exec(`insert into t values ('a')`);
		const err = await attempt(db, `insert into t values ('A')`);
		expect(err, 'NOCASE PK collision under an explicit NOCASE member').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
	});

	it('K=BINARY: explicit collate binary on a text PK (== K) is honored', async () => {
		await db.exec(`create table t (x text collate binary primary key) using store (collation = 'binary')`);
		expect(await collationOf(db, 'x')).to.equal('BINARY');
		expect(await tableExists(db)).to.equal(true);
	});
});
