/**
 * A store PK column keys under the collation the engine actually compares it under.
 * For a collation-blind type (`json`, the temporal types — their `compare` ignores the
 * collation argument) that is hard-coded BINARY; for an UNDECORATED `any` PK it is BINARY
 * too (`resolveDefaultCollation` never applies a non-BINARY default to ANY, and the
 * store's K-reconcile skips non-text columns). The store used to leave such a member's
 * key collation `undefined`, which `encodeValue` reads as "fall back to the table key
 * collation K" (default NOCASE) — enforcing PK uniqueness under NOCASE while the engine
 * compared under BINARY. `'A'` and `'a'` are distinct BINARY values that collided at one
 * NOCASE key, so the second `insert` was rejected and an `insert or replace` silently
 * destroyed the first row.
 *
 * An `any` PK carrying an EXPLICIT non-BINARY COLLATE is different since
 * any-type-compare-honors-collation: `ANY_TYPE.compare` honors the collation it is
 * handed, so such a member keys — and enforces — under the declared name (see the ALTER
 * case below and 06.4.5-any-collate-declared-keys.sqllogic).
 *
 * A memory table is the oracle for UNIQUENESS throughout. Since the semantic-ordering ruling
 * (docs/types.md "Semantic ordering"), it is the ordering oracle too: `Sort` ranks a TIMESPAN
 * or JSON operand by `logicalType.compare` (elapsed time / structural). The store DECLINES
 * ordering advertisements and byte windows over every semantic-ordering PK member
 * (`keyOrderMatchesCollation`), answering through a full scan + the type-aware residual
 * instead. Both types' key bytes now encode through an order-preserving transform (TIMESPAN's
 * `groupKey` total seconds — see timespan-semantic-key-identity.spec.ts; JSON's structural
 * encoding — see json-semantic-key-order.spec.ts), so the declines are merely conservative;
 * re-opening those seeks is tracked in backlog `feat-reopen-timespan-store-seeks`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

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

/** Every value of `column` produced by `sql`, in emission order. */
async function column(db: Database, sql: string, name: string): Promise<SqlValue[]> {
	return (await asyncIterableToArray(db.eval(sql))).map(r => r[name] as SqlValue);
}

/** The JSON array of physical operator names for `query`'s plan. */
async function planOps(db: Database, query: string): Promise<string> {
	const rows = await asyncIterableToArray(
		db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
	);
	expect(rows).to.have.lengthOf(1);
	return rows[0].ops as string;
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

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;

describe('PK columns that can hold text but are not textual are keyed under BINARY', () => {
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

	describe('uniqueness is enforced under the collation the engine compares under', () => {
		it("admits both 'A' and 'a' in an `any` PK, as a memory table does", async () => {
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`create table m (k any primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('A', 'upper')`);
				expect(await attempt(db, `insert into ${t} values ('a', 'lower')`), `${t} must accept both`)
					.to.be.null;
			}

			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
			expect((await db.get(`select v from t where k = 'a'`))?.v).to.equal('lower');
		});

		it('admits two `json` PK values that differ only in the case of an object key', async () => {
			await db.exec(`create table t (j json primary key, v text) using store`);
			await db.exec(`create table m (j json primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('{"A":1}', 'upper')`);
				expect(await attempt(db, `insert into ${t} values ('{"a":1}', 'lower')`), `${t} must accept both`)
					.to.be.null;
			}

			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select count(*) as cnt from m`))?.cnt).to.equal(2);
		});

		it('lets an UPDATE move an `any` PK to a value distinct only by case', async () => {
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`insert into t values ('A', 'upper'), ('B', 'other')`);

			expect(await attempt(db, `update t set k = 'a' where v = 'other'`)).to.be.null;
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select v from t where k = 'a'`))?.v).to.equal('other');
			expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
		});

		it('does not let `insert or replace` destroy the row at a case-distinct `any` PK', async () => {
			// The data-loss direction: no error, one row silently gone.
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`create table m (k any primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('A', 'upper')`);
				await db.exec(`insert or replace into ${t} values ('a', 'lower')`);
			}

			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
			expect((await db.get(`select count(*) as cnt from m`))?.cnt).to.equal(2);
			expect((await db.get(`select v from t where k = 'A'`))?.v).to.equal('upper');
		});

		it('`alter column … set collate nocase` on an `any` PK is a real re-key: collisions refuse, survivors re-key', async () => {
			// `ANY_TYPE.compare` honors the handed collation, so `resolvePkKeyCollations`
			// resolves the ANY member to NOCASE after the ALTER and `rekeyRows` genuinely
			// re-encodes. Case-distinct rows collide under the new collation, so the
			// pre-mutation validation refuses — same stricter rule as a text PK.
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`insert into t values ('A', 'upper'), ('a', 'lower')`);

			const err = await attempt(db, `alter table t alter column k set collate nocase`);
			expect(err, "'A' and 'a' collide under NOCASE — the re-key must refuse").to.not.be.null;
			expect((await db.get(`select count(*) as cnt from t`))?.cnt, 'refusal leaves the table untouched').to.equal(2);
			expect((await db.get(`select v from t where k = 'a'`))?.v).to.equal('lower');

			// Collision-free rows re-key, and the new collation then enforces.
			await db.exec(`create table t2 (k any primary key, v text) using store`);
			await db.exec(`insert into t2 values ('A', 'upper'), ('b', 'other')`);
			expect(await attempt(db, `alter table t2 alter column k set collate nocase`)).to.be.null;
			expect(await attempt(db, `insert into t2 values ('a', 'dup')`), 'the re-keyed PK enforces NOCASE')
				.to.not.be.null;
			expect((await db.get(`select v from t2 where k = 'a'`))?.v, 'NOCASE point lookup finds the case variant')
				.to.equal('upper');
		});

		it('keeps OBJECT-class members of an `any collate nocase` PK collation-blind', async () => {
			// The declared COLLATE governs the column's TEXT values only. `compareSameType`
			// consults the collation function on the TEXT/TEXT branch alone, so two object
			// values differing in the case of an object key are DISTINCT to every engine
			// comparator — `encodeObject` must therefore encode the canonical string
			// verbatim, not through the collation's key normalizer.
			await db.exec(`create table t (k any collate nocase primary key, v text) using store`);
			await db.exec(`create table m (k any collate nocase primary key, v text)`);

			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values (json('{"A":1}'), 'upper')`);
				expect(await attempt(db, `insert into ${t} values (json('{"a":1}'), 'lower')`), `${t} must accept both`)
					.to.be.null;
				expect((await db.get(`select count(*) as cnt from ${t}`))?.cnt).to.equal(2);
			}

			// …and their order is the comparator's code-point order over the canonical
			// strings, which lowercased key bytes would invert ('B' < 'a', but 'b' > 'a').
			await db.exec(`create table t3 (k any collate nocase primary key) using store`);
			await db.exec(`create table m3 (k any collate nocase primary key)`);
			for (const t of ['t3', 'm3']) {
				await db.exec(`insert into ${t} values (json('{"B":1}')), (json('{"a":2}'))`);
			}
			expect(await column(db, `select k from t3 order by k`, 'k'))
				.to.deep.equal(await column(db, `select k from m3 order by k`, 'k'));

			// A TEXT value in the same column still folds — the collation is not inert.
			await db.exec(`create table t4 (k any collate nocase primary key) using store`);
			await db.exec(`insert into t4 values ('Bob')`);
			expect(await attempt(db, `insert into t4 values ('BOB')`), 'text members still enforce NOCASE')
				.to.not.be.null;
		});
	});

	describe('the read-side gate that BINARY keying un-declines', () => {
		it('seeks a range over a `date` PK, and returns the comparator-correct rows', async () => {
			await db.exec(`create table t (d date primary key, v text) using store`);
			await db.exec(`create table m (d date primary key, v text)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('2024-01-15', 'jan'), ('2024-06-01', 'jun')`);
			}

			const q = `select v from t where d > '2024-03-01'`;
			expect(await column(db, q, 'v')).to.deep.equal(['jun']);
			expect(await column(db, q, 'v'))
				.to.deep.equal(await column(db, `select v from m where d > '2024-03-01'`, 'v'));
			expect(await planOps(db, q), 'a date PK keys under BINARY, so the seek is sound').to.match(SEEK);
		});

		it('advertises PK order for a mixed-type `any` PK, matching the memory table', async () => {
			// The encoder's type tags order NULL(0x00) < NUMERIC(0x01) < TEXT(0x03) < BLOB(0x04)
			// < OBJECT(0x05), matching the engine's storage-class order used by
			// `compareSqlValuesFast` for cross-class comparison.
			await db.exec(`create table t (k any primary key) using store`);
			await db.exec(`create table m (k any primary key)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('B'), (2), ('aa'), (x'01')`);
			}

			const q = `select k from t order by k`;
			expect(await column(db, q, 'k')).to.deep.equal(await column(db, `select k from m order by k`, 'k'));
			expect(await planOps(db, q), 'byte order is comparator order here').to.not.match(/sort/i);
		});

		it('declines the PK-order advertisement for a `json` PK and still matches the memory table', async () => {
			// The blanket semantic-ordering gate closes for a JSON PK, so a real Sort
			// runs (conservative now that the structural key bytes DO scan in compare
			// order — see json-semantic-key-order.spec.ts), and its structural order
			// agrees with the memory table's typed PK order.
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('{"b":1}'), ('{"A":1}'), ('{"a":1}')`);
			}

			const q = `select json_quote(j) as j from t order by j`;
			expect(await column(db, q, 'j'))
				.to.deep.equal(await column(db, `select json_quote(j) as j from m order by j`, 'j'));
			expect(await planOps(db, `select j from t order by j`), 'advertisement conservatively declined — Sort must run')
				.to.match(/sort/i);
		});

		it('orders a `timespan` PK by elapsed time via a real Sort (advertisement declined)', async () => {
			// Under the semantic-ordering ruling, Sort ranks TIMESPAN by
			// `TIMESPAN.compare` (elapsed time): 'PT90M' precedes 'PT2H' though the
			// text-byte order says the reverse. The store's key bytes now encode total
			// seconds (order-preserving), but the PK-order advertisement is still
			// conservatively declined, so a real Sort runs — on the PK table exactly
			// as on the integer-PK table.
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table sorted (id integer primary key, d timespan) using store`);
			await db.exec(`insert into t values ('PT2H'), ('PT90M')`);
			await db.exec(`insert into sorted values (1, 'PT2H'), (2, 'PT90M')`);

			const pkOrdered = await column(db, `select d from t order by d`, 'd');
			expect(await planOps(db, `select d from t order by d`), 'byte order is not elapsed-time order — Sort must run')
				.to.match(/sort/i);

			expect(await planOps(db, `select d from sorted order by d`)).to.match(/sort/i);
			expect(pkOrdered).to.deep.equal(await column(db, `select d from sorted order by d`, 'd'));
			expect(pkOrdered).to.deep.equal(['PT90M', 'PT2H']);
		});

		it('range-scans a `timespan` PK with elapsed-time bounds (window declined, residual type-aware)', async () => {
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT2H'), ('PT90M')`);
			}
			// 2h > 90min semantically, though 'PT2H' < 'PT90M' textually.
			const q = `select d from t where d > 'PT90M'`;
			expect(await column(db, q, 'd')).to.deep.equal(['PT2H']);
			expect(await column(db, q, 'd')).to.deep.equal(await column(db, `select d from m where d > 'PT90M'`, 'd'));
		});
	});
});
