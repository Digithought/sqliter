/**
 * The store's PHYSICAL key bytes resolve collations against the owning database.
 *
 * `encodeText` used to normalize a text key through a process-global registry holding
 * only the three built-ins with their built-in meanings. A collation registered (or
 * overridden) with `db.registerCollation` was invisible there, so two values the
 * database's own comparator calls equal landed at two distinct primary keys — a table
 * with a duplicate PK. `EncodeOptions.normalizers` now carries
 * `db.getKeyNormalizerResolver()` down every `buildDataKey` / `buildIndexKey` path.
 *
 * A custom collation NAME on a column is still rejected by `validateCollationForType`
 * (see `backlog/feat-ddl-accepts-registered-collations`), so the discriminating probe is
 * an OVERRIDE of a built-in name, exactly as in `custom-collation.spec.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	encodeValue,
	type KVStoreProvider,
} from '../src/index.js';

/** Ignores spaces entirely, so `'a b'` and `'ab'` are one value. */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const sa = stripSpaces(a);
	const sb = stripSpaces(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

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

/** Collects every row of `sql` into an array. */
async function all(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

/** Runs `sql`, returning the thrown error or null. */
async function attempt(db: Database, sql: string): Promise<Error | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		return e as Error;
	}
}

describe('Store key bytes under a database-registered collation', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
		await db.close();
	});

	it('collides two PK values the overriding NOCASE considers equal', async () => {
		// The original bug: `'a b'` and `'ab'` are one value under this NOCASE, but the
		// built-in lowercase encoder keyed them apart, so both rows landed in the table.
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
		await db.exec(`insert into t values ('a b', 'one')`);

		const err = await attempt(db, `insert into t values ('ab', 'two')`);
		expect(err, 'expected a UNIQUE violation on the duplicate primary key').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);

		const row = await db.get(`select count(*) as cnt from t`);
		expect(row?.cnt).to.equal(1);
	});

	it('honors the override in a composite PK mixing a text and an integer column', async () => {
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`
			create table t (k text collate NOCASE, n integer, v text, primary key (k, n))
			using store
		`);
		await db.exec(`insert into t values ('a b', 1, 'one')`);

		// Same (k, n) under the override — collides.
		const err = await attempt(db, `insert into t values ('ab', 1, 'two')`);
		expect(err, 'expected a UNIQUE violation on the composite primary key').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);

		// A distinct integer member keeps the rows apart even when `k` collapses.
		expect(await attempt(db, `insert into t values ('ab', 2, 'two')`)).to.be.null;
		const row = await db.get(`select count(*) as cnt from t`);
		expect(row?.cnt).to.equal(2);
	});

	it('finds a row by its equivalence class through a point PK seek', async () => {
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
		await db.exec(`insert into t values ('a b', 'one')`);

		// The seek encodes 'ab' through the override's normalizer, landing on the key
		// written for 'a b'. Under the built-in encoder it would miss.
		const row = await db.get(`select v from t where k = 'ab'`);
		expect(row?.v).to.equal('one');
	});

	it('re-keys a row when an update moves its PK across the collation equivalence classes', async () => {
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
		await db.exec(`insert into t values ('a b', 'one')`);

		// 'ab' is the SAME value, so the row keeps its key and its identity.
		await db.exec(`update t set k = 'ab' where k = 'a b'`);
		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);

		// 'a c' is a DIFFERENT value, so the row moves to a new key with no leftover.
		await db.exec(`update t set k = 'a c' where k = 'ab'`);
		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
		expect((await db.get(`select v from t where k = 'ac'`))?.v).to.equal('one');
		expect(await db.get(`select v from t where k = 'ab'`)).to.be.undefined;
	});

	it('maintains a secondary index whose PK suffix uses the overridden collation', async () => {
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (k text collate NOCASE primary key, n integer) using store`);
		await db.exec(`create index ix_n on t (n)`);
		await db.exec(`insert into t values ('a b', 10), ('c d', 20)`);

		// An index scan resolves each entry back through the data key its PK suffix
		// encodes; a suffix keyed under a different normalizer would resolve to nothing.
		const rows = await all(db, `select k from t where n >= 10 order by n`);
		expect(rows.map(r => r.k)).to.deep.equal(['a b', 'c d']);

		// Deleting through the index leaves no orphan entry.
		await db.exec(`delete from t where n = 10`);
		expect((await all(db, `select k from t where n >= 10`)).length).to.equal(1);
	});

	it('rejects at CREATE TABLE a comparator-only collation on a text primary key', async () => {
		// No normalizer ⇒ the collation can order rows but cannot key them.
		db.registerCollation('NOCASE', noSpace);

		const err = await attempt(
			db,
			`create table t (k text collate NOCASE primary key, v text) using store`,
		);
		expect(err, 'expected CREATE TABLE to reject the comparator-only collation').to.not.be.null;
		expect(err!.message).to.match(/NOCASE/);
		expect(err!.message).to.match(/cannot key a persisted structure/i);
	});

	it('rejects at CREATE TABLE an unregistered table key collation K', async () => {
		const err = await attempt(
			db,
			`create table t (k text primary key, v text) using store (collation = 'NOSPACE')`,
		);
		expect(err, 'expected CREATE TABLE to reject the unregistered key collation').to.not.be.null;
		expect(err!.message).to.match(/NOSPACE/);
	});

	it('leaves an integer-PK table with no index unaffected by an unusable K', async () => {
		// K is never encoded here — no text PK member, no secondary index — so a
		// collation the connection cannot key must not make the table unopenable.
		db.registerCollation('NOCASE', noSpace);
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'x')`);
		expect((await db.get(`select v from t where id = 1`))?.v).to.equal('x');
	});

	it('leaves an all-integer secondary index unaffected by an unusable K', async () => {
		// A secondary index encodes its INDEX-COLUMN bytes under K — but only when a
		// column can hold text. An integer index column over an integer PK never
		// consults K, so an unusable K must not make the index uncreatable.
		db.registerCollation('NOCASE', noSpace);
		await db.exec(`create table t (id integer primary key, n integer) using store`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		expect(await attempt(db, `create index ix_n on t (n)`)).to.be.null;

		const rows = await all(db, `select id from t where n >= 10 order by n`);
		expect(rows.map(r => r.id)).to.deep.equal([1, 2]);
	});

	it('an undecorated text index column keys BINARY — an unusable K no longer blocks it', async () => {
		// Index-column bytes encode under the column's own effective collation (BINARY
		// for an undecorated text column — see resolveIndexKeyCollations), so a
		// comparator-only override of K = NOCASE is never consulted and must not make
		// the index uncreatable.
		db.registerCollation('NOCASE', noSpace);
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'x'), (2, 'y')`);

		expect(await attempt(db, `create index ix_v on t (v)`)).to.be.null;
		expect((await db.get(`select id from t where v = 'y'`))?.id).to.equal(2);
	});

	it('rejects a secondary index whose own column collation cannot key', async () => {
		// The collation the index bytes DO encode under — the column's declared one —
		// must carry a key normalizer, and is rejected at CREATE INDEX rather than
		// reached at write time.
		db.registerCollation('NOCASE', noSpace);
		await db.exec(`create table t (id integer primary key, w text collate NOCASE) using store`);

		const err = await attempt(db, `create index ix_w on t (w)`);
		expect(err, 'expected CREATE INDEX to reject the comparator-only key collation').to.not.be.null;
		expect(err!.message).to.match(/cannot key a persisted structure/i);
	});

	it('rejects ADD CONSTRAINT UNIQUE when existing rows collide under the override', async () => {
		// `validateUniqueOverExistingRows` buckets the existing rows through the
		// connection's key normalizers; under the override 'a b' and 'ab' are one value.
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (id integer primary key, v text collate NOCASE) using store`);
		await db.exec(`insert into t values (1, 'a b'), (2, 'ab')`);

		const err = await attempt(db, `alter table t add constraint uq_v unique (v)`);
		expect(err, 'expected the existing-row scan to see the two values as one').to.not.be.null;
		expect(err!.message).to.match(/unique/i);

		// The same rows are accepted once they are distinct under the override.
		await db.exec(`update t set v = 'zz' where id = 2`);
		expect(await attempt(db, `alter table t add constraint uq_v unique (v)`)).to.be.null;
	});

	it('rebuilds secondary indexes under the override when a PK column changes collation', async () => {
		// `alter column … set collate` on a PK member rekeys the data store and rebuilds
		// every index; the rebuilt PK suffix must be encoded through the same resolver.
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (k text collate BINARY primary key, n integer) using store`);
		await db.exec(`create index ix_n on t (n)`);
		await db.exec(`insert into t values ('a b', 10), ('c d', 20)`);

		await db.exec(`alter table t alter column k set collate NOCASE`);

		// Each index entry must still resolve to its live row through the rekeyed PK suffix.
		const rows = await all(db, `select k, n from t where n >= 10 order by n`);
		expect(rows.map(r => r.k)).to.deep.equal(['a b', 'c d']);

		// And the rekeyed PK now collapses the override's equivalence class.
		expect((await db.get(`select n from t where k = 'ab'`))?.n).to.equal(10);

		// Maintenance recomputes the index key from the LIVE resolver; a rebuild that
		// wrote the PK suffix under a different normalizer leaves this delete an orphan.
		await db.exec(`delete from t where k = 'ab'`);
		expect((await all(db, `select k from t where n >= 10`)).map(r => r.k)).to.deep.equal(['c d']);
	});

	it('re-keys a persisted table only for a connection carrying the same override', async () => {
		const mod = new StoreModule(provider);
		const db1 = new Database();
		db1.registerCollation('NOCASE', noSpace, stripSpaces);
		db1.registerModule('store', mod);
		await db1.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
		await db1.exec(`insert into t values ('a b', 'one')`);
		await mod.whenCatalogPersisted();
		await db1.close();

		// A connection that re-registers the override reproduces the key layout.
		const restored = new Database();
		const restoredMod = new StoreModule(provider);
		restored.registerCollation('NOCASE', noSpace, stripSpaces);
		restored.registerModule('store', restoredMod);
		await restoredMod.rehydrateCatalog(restored);
		expect((await restored.get(`select v from t where k = 'ab'`))?.v).to.equal('one');
		await restored.close();

		// A connection whose NOCASE cannot key at all refuses the table outright rather
		// than reading rows under a layout it cannot reproduce. Rehydration logs and skips
		// the entry, so the table is simply absent.
		const comparatorOnly = new Database();
		const comparatorOnlyMod = new StoreModule(provider);
		comparatorOnly.registerCollation('NOCASE', noSpace);
		comparatorOnly.registerModule('store', comparatorOnlyMod);
		await comparatorOnlyMod.rehydrateCatalog(comparatorOnly);
		const err = await attempt(comparatorOnly, `select v from t where k = 'ab'`);
		expect(err, 'expected the comparator-only connection not to reach the table').to.not.be.null;
		expect(err!.message).to.match(/not found/i);
		await comparatorOnly.close();
	});

	it('leaves an ANY-typed PK column unaffected by a table key collation K that cannot key', async () => {
		// `resolvePkKeyCollations` keys an ANY/JSON member under hard-coded BINARY, never K,
		// because `ANY_TYPE.compare` ignores whatever collation it is handed. So a
		// comparator-only K is never encoded with, and the two BINARY-distinct rows both land.
		db.registerCollation('NOCASE', noSpace);
		expect(await attempt(db, `create table t (k any primary key, v text) using store`)).to.be.null;
		await db.exec(`insert into t values ('A', 'upper'), ('a', 'lower')`);

		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
		expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
		expect((await db.get(`select v from t where k = 'a'`))?.v).to.equal('lower');
	});

	it('keeps BINARY and NOCASE key bytes byte-identical to the retired encoders', () => {
		const utf8 = (s: string) => new TextEncoder().encode(s);
		const expected = (tag: number, s: string) =>
			new Uint8Array([tag, ...utf8(s), 0x00]);

		expect(encodeValue('Hello', { collation: 'BINARY' })).to.deep.equal(expected(0x03, 'Hello'));
		expect(encodeValue('Hello', { collation: 'NOCASE' })).to.deep.equal(expected(0x03, 'hello'));
		expect(encodeValue('Hello')).to.deep.equal(expected(0x03, 'hello')); // NOCASE default
		expect(encodeValue('foo  ', { collation: 'RTRIM' })).to.deep.equal(expected(0x03, 'foo'));
	});
});
