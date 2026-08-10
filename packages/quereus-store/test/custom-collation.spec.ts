/**
 * StoreTable resolves collation names against its OWN database.
 *
 * `StoreTable` used to compare values through the three-argument
 * `compareSqlValues(a, b, name)`, which resolves against a process-global registry
 * holding only BINARY / NOCASE / RTRIM and silently falls back to BINARY on a miss.
 * A collation registered with `db.registerCollation` was invisible there, so UNIQUE
 * enforcement and pushed-constraint re-checks ignored it. Both now resolve through
 * `db.getCollationResolver()`.
 *
 * Two DDL shapes reach a custom collation today, and this suite uses both:
 *
 *  - **Overriding a built-in.** `db.registerCollation('NOCASE', …)` replaces NOCASE for
 *    this database only. A comparison that reached the global registry would still get
 *    the built-in case-folding comparator, so an override that does something *else* is
 *    a discriminating probe.
 *  - **A custom name on an index column.** `create unique index … (v collate NOSPACE)`.
 *
 * A custom collation on a *column* (`v text collate NOSPACE`) is still rejected by
 * `validateCollationForType`, which checks the name against a static list on the logical
 * type rather than the connection's registry — see `backlog/feat-ddl-accepts-registered-collations`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * Ignores spaces entirely, so `'a b'` and `'ab'` are one value. Unlike a reversal it
 * genuinely COLLAPSES distinct byte strings, which is what makes a UNIQUE violation
 * observable; unlike the built-in NOCASE it does not fold case, so it is distinguishable
 * from whatever the global registry would have supplied.
 */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const sa = stripSpaces(a);
	const sb = stripSpaces(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** Case-SENSITIVE, i.e. the exact opposite of the built-in NOCASE. */
const caseSensitive = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** Runs `sql`, returning the thrown error or null. */
async function attempt(db: Database, sql: string): Promise<Error | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		return e as Error;
	}
}

describe('StoreTable UNIQUE under a database-registered collation', () => {
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

	it('still rejects a case-variant duplicate under the built-in NOCASE', async () => {
		// Regression guard. NOCASE resolves in BOTH registries, so this keeps passing
		// however the resolver is wired — it exists to catch a wiring mistake that
		// breaks enforcement outright, not one that picks the wrong registry.
		await db.exec(`create table t (id integer primary key, code text collate NOCASE unique) using store`);
		await db.exec(`insert into t values (1, 'abc')`);

		const err = await attempt(db, `insert into t values (2, 'ABC')`);
		expect(err, 'expected a UNIQUE violation').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);
	});

	it('lets an overriding NOCASE that does not fold case admit a case variant', async () => {
		// The discriminating direction: with the global registry's NOCASE this insert
		// raises. With the database's own (case-sensitive) NOCASE it must succeed.
		db.registerCollation('NOCASE', caseSensitive, (s: string) => s);
		await db.exec(`create table t (id integer primary key, code text collate NOCASE unique) using store`);
		await db.exec(`insert into t values (1, 'abc')`);
		expect(await attempt(db, `insert into t values (2, 'ABC')`)).to.be.null;

		// An exact duplicate must still collide.
		const err = await attempt(db, `insert into t values (3, 'abc')`);
		expect(err, 'expected a UNIQUE violation on the exact duplicate').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);
	});

	it('collides two rows the overriding NOCASE considers equal', async () => {
		// The other direction: the override makes values collide that BINARY (and the
		// built-in NOCASE) keep apart.
		db.registerCollation('NOCASE', noSpace, stripSpaces);
		await db.exec(`create table t (id integer primary key, code text collate NOCASE unique) using store`);
		await db.exec(`insert into t values (1, 'a b')`);

		const err = await attempt(db, `insert into t values (2, 'ab')`);
		expect(err, 'expected a UNIQUE violation under the overridden NOCASE').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);

		// A value the override still keeps apart inserts fine.
		expect(await attempt(db, `insert into t values (3, 'a c')`)).to.be.null;
		const row = await db.get(`select count(*) as cnt from t`);
		expect(row?.cnt).to.equal(2);
	});

	it('enforces an index-derived UNIQUE under a custom collation named on the index column', async () => {
		db.registerCollation('NOSPACE', noSpace, stripSpaces);
		await db.exec(`create table t (id integer primary key, code text) using store`);
		await db.exec(`create unique index ix_code on t (code collate NOSPACE)`);
		await db.exec(`insert into t values (1, 'a b')`);

		// 'ab' collation-equals 'a b' under NOSPACE. Before the resolver was wired in,
		// StoreTable compared these byte-wise and accepted the duplicate.
		const err = await attempt(db, `insert into t values (2, 'ab')`);
		expect(err, 'expected a UNIQUE violation').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);

		expect(await attempt(db, `insert into t values (3, 'a c')`)).to.be.null;
		const row = await db.get(`select count(*) as cnt from t`);
		expect(row?.cnt).to.equal(2);
	});

	it('enforces a PARTIAL index-derived UNIQUE under a custom collation', async () => {
		db.registerCollation('NOSPACE', noSpace, stripSpaces);
		await db.exec(`create table t (id integer primary key, code text, active integer) using store`);
		await db.exec(`create unique index ix_code on t (code collate NOSPACE) where active = 1`);
		await db.exec(`insert into t values (1, 'a b', 1)`);

		// Outside the predicate's scope: no conflict.
		expect(await attempt(db, `insert into t values (2, 'ab', 0)`)).to.be.null;

		const err = await attempt(db, `insert into t values (3, 'ab', 1)`);
		expect(err, 'expected a UNIQUE violation inside the predicate scope').to.not.be.null;
		expect(err!.message).to.match(/UNIQUE constraint failed/i);
	});

	it('scans a table with no pushed constraints, resolving an empty collation map', async () => {
		// The degenerate arm of `resolveFilterCollations` / `resolveCollationFunctions`:
		// a zero-length name list must map to a zero-length function list, not throw.
		db.registerCollation('NOSPACE', noSpace, stripSpaces);
		await db.exec(`create table t (id integer primary key, code text) using store`);
		await db.exec(`insert into t values (1, 'x')`);
		const row = await db.get(`select count(*) as cnt from t`);
		expect(row?.cnt).to.equal(1);
	});
});

describe('StoreTable unregistered collation', () => {
	/**
	 * A store whose persisted DDL names a collation the reopening connection never
	 * registered must raise `no such collation sequence`, not silently byte-order.
	 * Both connections share one provider, so the second reopens the first's catalog.
	 */
	it('raises rather than falling back to BINARY after a reopen', async () => {
		const provider = createInMemoryProvider();

		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerCollation('NOSPACE', noSpace, stripSpaces);
		db1.registerModule('store', mod1);
		await db1.exec(`create table t (id integer primary key, code text) using store`);
		await db1.exec(`create unique index ix_code on t (code collate NOSPACE)`);
		await db1.exec(`insert into t values (1, 'a b')`);
		await mod1.whenCatalogPersisted();
		await db1.close();

		// Fresh connection over the same provider, NOSPACE never registered.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await mod2.rehydrateCatalog(db2);

		const err = await attempt(db2, `insert into t values (2, 'zz')`);
		expect(err, 'expected an unresolvable-collation error').to.not.be.null;
		expect(err!.message).to.match(/no such collation sequence: NOSPACE/i);

		await db2.close();
		await provider.closeAll();
	});
});
