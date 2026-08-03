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
 * or JSON operand by `logicalType.compare` (elapsed time / structural). Both types' key bytes
 * encode through an order-preserving transform (TIMESPAN's `groupKey` total seconds — see
 * timespan-semantic-key-identity.spec.ts; JSON's structural encoding — see
 * json-semantic-key-order.spec.ts), so the store ADVERTISES PK order over such members and
 * serves a leading-column range predicate as a byte-window seek
 * (`semanticKeyOrderIsFaithful`, pk-key-resolution.ts). Every seek BOUND additionally passes
 * the per-value gate `semanticProbeIsKeyFaithful`: a bound with no faithful byte position (a
 * numeric or unparseable TIMESPAN probe, a blob JSON probe) is dropped, which only WIDENS
 * the window, and the type-aware residual still decides rows — the under-fetch regressions
 * below pin exactly that. Equality-shaped seeks over such members remain declined
 * (`feat-store-semantic-key-point-seeks`), as do IN-list multi-seeks
 * (backlog `feat-store-semantic-key-multiseek`).
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

		it('advertises PK order for a `json` PK — the Sort elides and order matches memory', async () => {
			// The structural key bytes scan in `compare` order (json-semantic-key-order.spec.ts),
			// so `semanticKeyOrderIsFaithful` opens the advertisement and no Sort runs.
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('{"b":1}'), ('{"A":1}'), ('{"a":1}')`);
			}

			const q = `select json_quote(j) as j from t order by j`;
			expect(await column(db, q, 'j'))
				.to.deep.equal(await column(db, `select json_quote(j) as j from m order by j`, 'j'));
			expect(await planOps(db, `select j from t order by j`), 'structural byte order IS compare order — no Sort')
				.to.not.match(/sort/i);
		});

		it('orders a `timespan` PK by elapsed time straight off the key bytes (no Sort)', async () => {
			// Under the semantic-ordering ruling, Sort ranks TIMESPAN by
			// `TIMESPAN.compare` (elapsed time): 'PT90M' precedes 'PT2H' though the
			// text-byte order says the reverse. The key bytes encode total seconds, so
			// the PK-order advertisement is live and the Sort elides; the same column
			// as a NON-key still needs its Sort.
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table sorted (id integer primary key, d timespan) using store`);
			await db.exec(`insert into t values ('PT2H'), ('PT90M')`);
			await db.exec(`insert into sorted values (1, 'PT2H'), (2, 'PT90M')`);

			const pkOrdered = await column(db, `select d from t order by d`, 'd');
			expect(await planOps(db, `select d from t order by d`), 'key-byte order IS elapsed-time order — no Sort')
				.to.not.match(/sort/i);

			expect(await planOps(db, `select d from sorted order by d`), 'a non-key column still Sorts')
				.to.match(/sort/i);
			expect(pkOrdered).to.deep.equal(await column(db, `select d from sorted order by d`, 'd'));
			expect(pkOrdered).to.deep.equal(['PT90M', 'PT2H']);
		});

		it('range-scans a `timespan` PK with elapsed-time bounds through a real seek', async () => {
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT2H'), ('PT90M')`);
			}
			// 2h > 90min semantically, though 'PT2H' < 'PT90M' textually — the window
			// must be in elapsed-time space, not text space.
			const q = `select d from t where d > 'PT90M'`;
			expect(await column(db, q, 'd')).to.deep.equal(['PT2H']);
			expect(await column(db, q, 'd')).to.deep.equal(await column(db, `select d from m where d > 'PT90M'`, 'd'));
			expect(await planOps(db, q), 'total-seconds key bytes make the byte window sound').to.match(SEEK);
		});
	});

	describe('the re-opened semantic-ordering windows: probe gating and edge shapes', () => {
		it('returns every row for a numeric probe on a `timespan` PK (bound dropped, window widened)', async () => {
			// `createTypedComparator` short-circuits on the storage-class mismatch, so the
			// predicate admits every stored (TEXT-class) row — but `groupKey(5)` would
			// build a `> NUMERIC(5)` byte window that EXCLUDES 'PT1S' (total 1). The
			// probe gate drops the bound; the type-aware residual answers.
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT1S'), ('PT2H')`);
			}
			const q = (tbl: string) => `select d from ${tbl} where d > 5`;
			expect(await column(db, q('t'), 'd')).to.deep.equal(await column(db, q('m'), 'd'));
		});

		it('matches memory for an unparseable text probe on a `timespan` PK (bound dropped)', async () => {
			// `groupKey` falls back to the raw text (TEXT-tagged bytes, above every
			// NUMERIC-tagged stored key) while `compare` falls back to BINARY text against
			// the canonical stored spelling — two different positions. Drop the bound.
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT1S'), ('PT2H')`);
			}
			const q = (tbl: string) => `select d from ${tbl} where d > 'not a duration'`;
			expect(await column(db, q('t'), 'd')).to.deep.equal(await column(db, q('m'), 'd'));
		});

		it('returns rows — and does not raise — for a blob probe on a `json` PK', async () => {
			// `jsonStructuralKey` raises INTERNAL for a blob; `jsonKeyEncodable` declines
			// it first, so the bound is dropped and the storage-class residual answers
			// (BLOB ranks between TEXT and OBJECT).
			await db.exec(`create table t (j json primary key) using store`);
			await db.exec(`create table m (j json primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('7'), ('"abc"'), ('{"a":1}')`);
			}
			const q = (tbl: string) => `select json_quote(j) as q from ${tbl} where j > x'01'`;
			expect(await column(db, q('t'), 'q')).to.deep.equal(await column(db, q('m'), 'q'));
		});

		it('keeps a `collate`-decorated index over a `json` column declined, rows correct', async () => {
			// Index DDL does not type-gate a COLLATE the way column DDL does; such a
			// column's key bytes are hard-BINARY while the residual re-compares under the
			// declared name. `keyOrderMatchesCollation`'s FALL-THROUGH to the collation
			// checks is what declines this — an early `return true` for a faithful
			// semantic type would silently re-open it.
			await db.exec(`create table t (id integer primary key, j json) using store`);
			await db.exec(`create index ix_j on t (j collate nocase)`);
			await db.exec(`create table m (id integer primary key, j json)`);
			await db.exec(`create index ix_mj on m (j collate nocase)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values (1, '"a"'), (2, '"B"'), (3, '{"a":1}')`);
			}
			const q = (tbl: string) => `select id from ${tbl} where j > 'a' order by id`;
			expect(await column(db, q('t'), 'id')).to.deep.equal(await column(db, q('m'), 'id'));
			expect(await planOps(db, q('t')), 'key bytes are BINARY, residual is NOCASE — no seek').to.not.match(SEEK);
		});

		it('keeps a `collate`-decorated index over a `timespan` column declined, rows correct', async () => {
			await db.exec(`create table t (id integer primary key, d timespan) using store`);
			await db.exec(`create index ix_d on t (d collate nocase)`);
			await db.exec(`create table m (id integer primary key, d timespan)`);
			await db.exec(`create index ix_md on m (d collate nocase)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values (1, 'PT30M'), (2, 'PT2H')`);
			}
			const q = (tbl: string) => `select id from ${tbl} where d > 'PT1H' order by id`;
			expect(await column(db, q('t'), 'id')).to.deep.equal(await column(db, q('m'), 'id'));
			expect(await planOps(db, q('t')), 'the declared COLLATE keeps the range declined').to.not.match(SEEK);
		});

		it('elides the Sort for `order by d desc` over a DESC `timespan` PK', async () => {
			await db.exec(`create table t (d timespan, primary key (d desc)) using store`);
			await db.exec(`create table m (d timespan, primary key (d desc))`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT2H'), ('PT90M'), ('PT30S')`);
			}
			const q = `select d from t order by d desc`;
			expect(await column(db, q, 'd')).to.deep.equal(['PT2H', 'PT90M', 'PT30S']);
			expect(await column(db, q, 'd')).to.deep.equal(await column(db, `select d from m order by d desc`, 'd'));
			expect(await planOps(db, q), 'the DESC advertisement matches — no Sort').to.not.match(/sort/i);
		});

		it('elides the Sort for a DESC `json` PK, a proper prefix sorting last', async () => {
			// Bit-inversion turns the structural encoding's 0x00 terminator into 0xff —
			// above every inverted content byte — so a proper prefix ([2] vs [2,0])
			// correctly sorts LAST under DESC, matching the reversed length tiebreak.
			await db.exec(`create table t (j json, primary key (j desc)) using store`);
			await db.exec(`create table m (j json, primary key (j desc))`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('[2]'), ('[2,0]'), ('[10]')`);
			}
			const q = `select json_quote(j) as q from t order by j desc`;
			expect(await column(db, q, 'q')).to.deep.equal(['[10]', '[2,0]', '[2]']);
			expect(await column(db, q, 'q'))
				.to.deep.equal(await column(db, `select json_quote(j) as q from m order by j desc`, 'q'));
			expect(await planOps(db, q), 'inverted structural bytes still advertise').to.not.match(/sort/i);
		});

		it('advertises both members of a composite (timespan, integer) PK and seeks its leading range', async () => {
			await db.exec(`create table t (d timespan, id integer, primary key (d, id)) using store`);
			await db.exec(`create table m (d timespan, id integer, primary key (d, id))`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT2H', 1), ('PT90M', 2), ('PT90M', 1), ('PT30S', 9)`);
			}
			const ord = `select d || '/' || id as r from t order by d, id`;
			expect(await column(db, ord, 'r'))
				.to.deep.equal(await column(db, `select d || '/' || id as r from m order by d, id`, 'r'));
			expect(await planOps(db, ord), 'the advertisement covers both members').to.not.match(/sort/i);

			const rng = `select id from t where d >= 'PT1H30M' order by d, id`;
			expect(await column(db, rng, 'id')).to.deep.equal([1, 2, 1]);
			expect(await planOps(db, rng), 'the leading-member range seeks').to.match(SEEK);
		});

		it('counts a semantic-ordering SECOND member into the order-preserving prefix', async () => {
			await db.exec(`create table t (id integer, d timespan, primary key (id, d)) using store`);
			await db.exec(`create table m (id integer, d timespan, primary key (id, d))`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values (1, 'PT2H'), (1, 'PT90M'), (2, 'PT30S')`);
			}
			const q = `select id || '/' || d as r from t order by id, d`;
			expect(await column(db, q, 'r'))
				.to.deep.equal(await column(db, `select id || '/' || d as r from m order by id, d`, 'r'));
			expect(await planOps(db, q), 'the prefix must not truncate at the timespan member').to.not.match(/sort/i);
		});

		it("finds a row stored under a different spelling: `>= 'PT59M'` matches 'PT1H'", async () => {
			// Bound and stored value are different spellings; the window is in
			// elapsed-time space, so 3540s ≤ 3600s lands inside it.
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT1H'), ('PT30M')`);
			}
			const q = (tbl: string) => `select d from ${tbl} where d >= 'PT59M'`;
			expect(await column(db, q('t'), 'd')).to.deep.equal(['PT1H']);
			expect(await column(db, q('t'), 'd')).to.deep.equal(await column(db, q('m'), 'd'));
			expect(await planOps(db, q('t'))).to.match(SEEK);
		});

		it('narrows BETWEEN to one window and lets the tighter of a redundant pair win', async () => {
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT30M'), ('PT1H'), ('PT90M'), ('PT2H')`);
			}
			for (const where of [
				`d between 'PT45M' and 'PT100M'`,
				`d > 'PT30M' and d > 'PT1H'`, // redundant same-side pair — the tighter must win
			]) {
				const q = (tbl: string) => `select d from ${tbl} where ${where}`;
				expect(await column(db, q('t'), 'd'), where).to.deep.equal(await column(db, q('m'), 'd'));
			}
		});

		it('places NULL first in a nullable `timespan` index column, matching memory', async () => {
			await db.exec(`create table t (id integer primary key, d timespan null) using store`);
			await db.exec(`create index ix_d on t (d)`);
			await db.exec(`create table m (id integer primary key, d timespan null)`);
			await db.exec(`create index ix_md on m (d)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values (1, 'PT2H'), (2, null), (3, 'PT90M')`);
			}
			expect(await column(db, `select id from t order by d`, 'id'))
				.to.deep.equal(await column(db, `select id from m order by d`, 'id'));
			// A range op against NULL matches nothing, so the NULL row stays out.
			const q = (tbl: string) => `select id from ${tbl} where d > 'PT100M' order by id`;
			expect(await column(db, q('t'), 'id')).to.deep.equal([1]);
			expect(await column(db, q('t'), 'id')).to.deep.equal(await column(db, q('m'), 'id'));
		});

		it('answers an IN-list over an indexed `timespan` column without multi-seeking', async () => {
			// The multi-seek stays declined for a semantic-ordering seek column (backlog
			// `feat-store-semantic-key-multiseek`): cost-only plan, residual retained —
			// which is what lets the re-spelled 'PT60M' member match the stored 'PT1H'.
			await db.exec(`create table t (id integer primary key, d timespan) using store`);
			await db.exec(`create index ix_d on t (d)`);
			await db.exec(`create table m (id integer primary key, d timespan)`);
			await db.exec(`create index ix_md on m (d)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values (1, 'PT1H'), (2, 'PT90M'), (3, 'PT2H')`);
			}
			const q = (tbl: string) => `select id from ${tbl} where d in ('PT60M', 'PT2H') order by id`;
			expect(await column(db, q('t'), 'id')).to.deep.equal([1, 3]);
			expect(await column(db, q('t'), 'id')).to.deep.equal(await column(db, q('m'), 'id'));
		});
	});
});
