/**
 * The store physically orders rows by memcmp of each text key's NORMALIZED bytes, but the
 * engine orders and filters them with the collation's COMPARATOR. `db.registerCollation`
 * promises only that a normalizer partitions strings the way its comparator calls them
 * equal — it says nothing about order. Three store decisions used to assume order anyway:
 *
 *   - the PK byte-range window (`StoreTable.analyzePKAccess` → `buildPKRangeBounds`),
 *   - the secondary-index byte-range window (`StoreTable.analyzeIndexAccess`),
 *   - the PK-order advertisement (`StoreModule.buildPkOrderingAdvertisement`), which elides
 *     the Sort above an `order by <pk>`.
 *
 * Under a normalizer that agrees on equality but disagrees on order, the first two silently
 * DROPPED rows and the third returned them in byte order. All three now consult
 * `Database._isCollationOrderPreserving` and degrade to a full scan / a retained Sort.
 *
 * The probe collation below is a legal registration today: `NOCASE` may be overridden (only
 * `BINARY` is protected). Its normalizer is `toLowerCase`, exactly matching its comparator's
 * equality classes; its comparator orders SHORTER strings first, which byte order does not.
 * A memory table — which orders and filters purely by comparator — is the oracle.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** Lowercase-equal, but SHORTER-first: `'aa' > 'b'` under the comparator, `'aa' < 'b'` in bytes. */
const lower = (s: string): string => s.toLowerCase();
const lengthFirst = (a: string, b: string): number => {
	if (a.length !== b.length) return a.length - b.length;
	const [la, lb] = [lower(a), lower(b)];
	return la < lb ? -1 : la > lb ? 1 : 0;
};

/** Ignores spaces. Its comparator IS the byte order of its normalized forms. */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const [sa, sb] = [stripSpaces(a), stripSpaces(b)];
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

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;

describe('Store range seeks and PK-order advertisements under a non-order-preserving collation', () => {
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

	describe('a normalizer that preserves equality but inverts order', () => {
		beforeEach(() => {
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
		});

		it('keeps a text-PK range correct by declining the byte window', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);

			// Comparator order: 'b' (length 1) < 'aa' (length 2). Byte order: 'aa' < 'b'.
			// A byte window at `> 'b'` would start past 'aa' and yield nothing.
			const q = `select k from t where k > 'b'`;
			expect(await column(db, q, 'k')).to.deep.equal(['aa']);
			expect(await planOps(db, q), 'the PK seek must be declined').to.not.match(SEEK);
		});

		it('keeps a secondary-index range correct by declining the byte window', async () => {
			await db.exec(`create table t (id integer primary key, k text collate nocase) using store`);
			await db.exec(`create index ix_k on t (k)`);
			await db.exec(`insert into t values (1, 'aa'), (2, 'b')`);

			const q = `select id from t where k > 'b'`;
			expect(await column(db, q, 'id')).to.deep.equal([1]);
			expect(await planOps(db, q), 'the index seek must be declined').to.not.match(SEEK);
		});

		it('keeps `order by <text pk>` in comparator order by retaining the Sort', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);

			// Rows are stored (and iterated) as 'aa' then 'b'; the comparator says 'b' first.
			const q = `select k from t order by k`;
			expect(await column(db, q, 'k')).to.deep.equal(['b', 'aa']);
			expect(await planOps(db, q), 'the Sort must not be elided').to.match(/sort/i);
		});

		it('still answers a point PK seek, which needs only the equality guarantee', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);

			expect((await db.get(`select v from t where k = 'B'`))?.v).to.equal('two');
			expect((await db.get(`select v from t where k = 'AA'`))?.v).to.equal('one');
		});

		it('agrees with a memory table on every one of the above', async () => {
			// The oracle: memory tables compare and order purely by the comparator.
			await db.exec(`create table m (k text collate nocase primary key, v text)`);
			await db.exec(`create table mi (id integer primary key, k text collate nocase)`);
			await db.exec(`create index ix_mk on mi (k)`);
			await db.exec(`insert into m values ('aa', 'one'), ('b', 'two')`);
			await db.exec(`insert into mi values (1, 'aa'), (2, 'b')`);

			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`create table ti (id integer primary key, k text collate nocase) using store`);
			await db.exec(`create index ix_tk on ti (k)`);
			await db.exec(`insert into t values ('aa', 'one'), ('b', 'two')`);
			await db.exec(`insert into ti values (1, 'aa'), (2, 'b')`);

			expect(await column(db, `select k from t where k > 'b'`, 'k'))
				.to.deep.equal(await column(db, `select k from m where k > 'b'`, 'k'));
			expect(await column(db, `select id from ti where k > 'b'`, 'id'))
				.to.deep.equal(await column(db, `select id from mi where k > 'b'`, 'id'));
			expect(await column(db, `select k from t order by k`, 'k'))
				.to.deep.equal(await column(db, `select k from m order by k`, 'k'));
			expect((await db.get(`select v from t where k = 'B'`))?.v)
				.to.equal((await db.get(`select v from m where k = 'B'`))?.v);
		});
	});

	describe('a normalizer asserted order-preserving', () => {
		it('keeps the PK range seek and returns comparator-correct rows', async () => {
			db.registerCollation('NOCASE', noSpace, { normalizer: stripSpaces, orderPreserving: true });
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('a b', 'one'), ('c d', 'two'), ('e', 'three')`);

			// 'ab' < 'cd' < 'e' both by comparator and by normalized bytes.
			const q = `select k from t where k > 'ab'`;
			expect(await column(db, q, 'k')).to.deep.equal(['c d', 'e']);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});

		it('advertises PK order, eliding the Sort', async () => {
			db.registerCollation('NOCASE', noSpace, { normalizer: stripSpaces, orderPreserving: true });
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('c d', 'two'), ('a b', 'one'), ('e', 'three')`);

			const q = `select k from t order by k`;
			expect(await column(db, q, 'k')).to.deep.equal(['a b', 'c d', 'e']);
			expect(await planOps(db, q), 'byte order is comparator order here').to.not.match(/sort/i);
		});

		it('returns identical rows without the assertion — the gate costs speed, never rows', async () => {
			// Same comparator + normalizer pair, registered WITHOUT `orderPreserving`.
			db.registerCollation('NOCASE', noSpace, stripSpaces);
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			await db.exec(`insert into t values ('a b', 'one'), ('c d', 'two'), ('e', 'three')`);

			const q = `select k from t where k > 'ab'`;
			expect(await column(db, q, 'k')).to.deep.equal(['c d', 'e']);
			expect(await planOps(db, q), 'no assertion ⇒ no seek').to.not.match(SEEK);
			expect(await column(db, `select k from t order by k`, 'k')).to.deep.equal(['a b', 'c d', 'e']);
		});
	});

	describe('shapes the gate must leave alone', () => {
		it('keeps an integer-PK range seek — non-text key bytes are collation-independent', async () => {
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`insert into t values (1, 'a'), (2, 'b'), (3, 'c')`);

			const q = `select id from t where id > 1`;
			expect(await column(db, q, 'id')).to.deep.equal([2, 3]);
			expect(await planOps(db, q)).to.match(SEEK);
		});

		it('keeps the built-in NOCASE text-PK range seek', async () => {
			await db.exec(`create table t (k text collate nocase primary key) using store`);
			await db.exec(`insert into t values ('apple'), ('Banana'), ('cherry')`);

			const q = `select k from t where k > 'banana'`;
			expect(await column(db, q, 'k')).to.deep.equal(['cherry']);
			expect(await planOps(db, q)).to.match(SEEK);
		});

		it('keeps the equality index seek on a BINARY column of a NOCASE-keyed table', async () => {
			// The table key collation K = NOCASE is not part of this decision at all: an
			// index over an undecorated `text` column keys its bytes under BINARY, and the
			// scan residual re-compares under BINARY, so the window is exactly the
			// qualifying set. (Before the guard collapse this seek survived for a different,
			// now-retired reason — "K is coarser than C, so its window is a superset".)
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 'x'), (2, 'y')`);

			const q = `select id from t where v = 'y'`;
			expect(await column(db, q, 'id')).to.deep.equal([2]);
			expect(await planOps(db, q)).to.match(SEEK);
		});

		it('keeps the PK RANGE seek on an undecorated `any` PK, whose bytes key under BINARY', async () => {
			// `resolvePkKeyCollations` keys an undecorated ANY member under its declared
			// BINARY (the session default never applies a non-BINARY collation to ANY) —
			// rather than falling back to K = NOCASE. Key bytes and comparison agree, so
			// the byte window is sound: 'B' (0x42) < 'aa' (0x61…) both ways. The encoder's
			// type tags also order NULL < NUMERIC < TEXT < BLOB < OBJECT, matching the
			// engine's storage-class order.
			await db.exec(`create table t (k any primary key, v text) using store`);
			await db.exec(`insert into t values ('aa', 'one'), ('B', 'two')`);

			const q = `select v from t where k > 'B'`;
			expect(await column(db, q, 'v')).to.deep.equal(['one']);
			expect(await planOps(db, q), 'the PK seek must be kept').to.match(SEEK);
		});

		it('truncates — rather than voids — the PK-order advertisement when a LATER member is unsafe', async () => {
			// PK (id integer, v text collate nocase) under the order-inverting NOCASE: `id`
			// passes the predicate (non-text key bytes), `v` fails (its normalizer preserves
			// equality but not order). The advertisement must shrink to the leading member, not
			// vanish: `order by id` keeps its elided Sort, `order by id, v` gets one back, and
			// the leading-column range seek survives.
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
			const ddl = (t: string, using: string) =>
				`create table ${t} (id integer, v text collate nocase, w text, primary key (id, v)) ${using}`;
			await db.exec(ddl('t', 'using store'));
			await db.exec(ddl('m', ''));
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values (2, 'aa', 'x'), (1, 'B', 'y'), (1, 'aa', 'z')`);
			}

			expect(await planOps(db, `select id from t order by id`), 'leading member is safe')
				.to.not.match(/sort/i);
			expect(await column(db, `select id from t order by id`, 'id')).to.deep.equal([1, 1, 2]);

			// Within id = 1 the store emits byte order ('aa' keys as 'aa', 'B' as 'b'), while the
			// comparator puts the shorter 'B' first. The Sort must survive to fix that.
			expect(await planOps(db, `select v from t order by id, v`), 'the unsafe member needs its Sort')
				.to.match(/sort/i);
			expect(await column(db, `select v from t order by id, v`, 'v'))
				.to.deep.equal(await column(db, `select v from m order by id, v`, 'v'));

			const q = `select w from t where id > 1`;
			expect(await planOps(db, q), 'a range on the safe leading member still seeks').to.match(SEEK);
			expect(await column(db, q, 'w')).to.deep.equal(['x']);
		});

		it('keeps the index RANGE seek on a BINARY column of a NOCASE-keyed table', async () => {
			// The shape the guard collapse restores. U+212A KELVIN SIGN is > 'z' under BINARY.
			// While index bytes were encoded under the TABLE key collation K = NOCASE they
			// were `toLowerCase(…) = 'k'`, which sorts BEFORE 'z', so a window at `> 'z'`
			// dropped the row and the gate had to decline. Index bytes are now BINARY — the
			// same collation the residual compares under, and one that carries the
			// `orderPreserving` assertion — so the window is exact and the seek is back.
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 'K'), (2, 'a')`);

			// Memory is the oracle: a plan change must not move a row.
			await db.exec(`create table m (id integer primary key, v text)`);
			await db.exec(`create index ix_mv on m (v)`);
			await db.exec(`insert into m select id, v from t`);

			const q = `select id from t where v > 'z'`;
			expect(await column(db, q, 'id')).to.deep.equal([1]);
			expect(await column(db, `select id from m where v > 'z'`, 'id')).to.deep.equal([1]);
			expect(await planOps(db, q), 'the index range seek is restored').to.match(SEEK);
		});
	});

	// The guard collapse (store-index-collation-guard-collapse): with index bytes encoded
	// under the index column's own collation, the read guards no longer ask about the table
	// key collation K at all. EQUALITY asks only whether the key collation equals the one
	// the residual re-compares under; RANGE asks that plus the `orderPreserving` assertion.
	describe('after the guard collapse: the range arm asks only about order preservation', () => {
		/** A store table + index over `v`, alongside a memory twin used as the oracle. */
		async function twinTables(decl: string, rows: string): Promise<void> {
			await db.exec(`create table t (id integer primary key, ${decl}) using store`);
			await db.exec(`create index ix_t on t (v)`);
			await db.exec(`create table m (id integer primary key, ${decl})`);
			await db.exec(`create index ix_m on m (v)`);
			await db.exec(`insert into t values ${rows}`);
			await db.exec(`insert into m values ${rows}`);
		}

		/** Assert the store answers `where` exactly as the memory twin does. */
		async function agreesWithMemory(where: string): Promise<SqlValue[]> {
			const ids = await column(db, `select id from t where ${where} order by id`, 'id');
			expect(ids).to.deep.equal(await column(db, `select id from m where ${where} order by id`, 'id'));
			return ids;
		}

		it('restores the range seek on a plain text column of a default-K (NOCASE) table', async () => {
			// The headline shape from `store-range-seek-order-preserving-gate`: the column is
			// BINARY, the table's K is NOCASE, and the old `C === K` demand cost this seek.
			await twinTables(`v text`, `(1, 'alpha'), (2, 'mike'), (3, 'zulu')`);

			expect(await agreesWithMemory(`v > 'm'`)).to.deep.equal([2, 3]);
			expect(await planOps(db, `select id from t where v > 'm' order by id`), 'the range seek is back')
				.to.match(SEEK);
		});

		it('declines the range but keeps the EQ seek under a non-order-preserving collation', async () => {
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
			await twinTables(`v text collate nocase`, `(1, 'aa'), (2, 'b')`);

			// Range: the normalizer preserves equality, not order — no seek, right rows.
			expect(await agreesWithMemory(`v > 'b'`)).to.deep.equal([1]);
			expect(await planOps(db, `select id from t where v > 'b'`), 'range declined').to.not.match(SEEK);

			// Equality never depended on order, so it still seeks.
			expect(await agreesWithMemory(`v = 'AA'`)).to.deep.equal([1]);
			expect(await planOps(db, `select id from t where v = 'AA'`), 'EQ still seeks').to.match(SEEK);
		});

		it('gives the range seek back once the same pair asserts orderPreserving', async () => {
			db.registerCollation('NOCASE', noSpace, { normalizer: stripSpaces, orderPreserving: true });
			await twinTables(`v text collate nocase`, `(1, 'a b'), (2, 'c d'), (3, 'e')`);

			expect(await agreesWithMemory(`v > 'ab'`)).to.deep.equal([2, 3]);
			expect(await planOps(db, `select id from t where v > 'ab'`), 'assertion ⇒ seek').to.match(SEEK);
		});

		it('admits BOTH arms on an `any` column carrying a declared COLLATE', async () => {
			// `ANY_TYPE.compare` honors the collation it is handed
			// (any-type-compare-honors-collation), so an `any collate nocase` column keys
			// under NOCASE — the same collation the scan residual re-compares under — and
			// both the byte-equality and the byte-range window are exactly the qualifying
			// set. The oracle is still the store's OWN answer before the index exists:
			// creating an index must not change a query's result (and the memory backend
			// now agrees on this shape too).
			const eq = `select id from t where v = 'BOB' order by id`;
			const gt = `select id from t where v > 'a' order by id`;
			await db.exec(`create table t (id integer primary key, v any collate nocase) using store`);
			await db.exec(`insert into t values (1, 'Bob'), (2, 'zed')`);
			const eqUnindexed = await column(db, eq, 'id');
			const gtUnindexed = await column(db, gt, 'id');
			expect(eqUnindexed, 'NOCASE-equal row matches with no index').to.deep.equal([1]);

			await db.exec(`create index ix_t on t (v)`);
			expect(await column(db, eq, 'id'), 'the index must not change the answer').to.deep.equal(eqUnindexed);
			expect(await column(db, gt, 'id'), 'the index must not change the answer').to.deep.equal(gtUnindexed);
			expect(await planOps(db, eq), 'EQ seeks — key and residual collation agree').to.match(SEEK);
			expect(await planOps(db, gt), 'range seeks — NOCASE is order-preserving').to.match(SEEK);
		});

		it('re-opens the TIMESPAN index range — the transform-threaded window returns comparator rows', async () => {
			// The transform-threading regression: without `StoreTableScan.indexKeyTransforms`
			// threaded into the range window, the bounds would address raw-text bytes while
			// the index holds total-seconds bytes and the seek would return NOTHING (a range
			// window carries no residual able to resurrect a skipped row). The memory oracle
			// catches exactly that.
			await twinTables(`v timespan`, `(1, 'PT30M'), (2, 'PT2H')`);

			expect(await agreesWithMemory(`v > 'PT1H'`)).to.deep.equal([2]);
			expect(await planOps(db, `select id from t where v > 'PT1H'`), 'faithful key bytes ⇒ range seek')
				.to.match(SEEK);
		});

		it('truncates the PK-order advertisement at an equality-only text member ahead of a TIMESPAN one', async () => {
			// PK (k text collate nocase, d timespan) under the order-inverting NOCASE: the
			// order-preserving prefix must stop at `k`, so `order by k, d` keeps its Sort
			// even though the trailing timespan member alone would qualify.
			db.registerCollation('NOCASE', lengthFirst, { normalizer: lower });
			const ddl = (t: string, using: string) =>
				`create table ${t} (k text collate nocase, d timespan, primary key (k, d)) ${using}`;
			await db.exec(ddl('t', 'using store'));
			await db.exec(ddl('m', ''));
			for (const t of ['t', 'm']) {
				await db.exec(`insert into ${t} values ('aa', 'PT1H'), ('b', 'PT2H'), ('b', 'PT90M')`);
			}

			const q = `select k || '/' || d as r from t order by k, d`;
			expect(await planOps(db, q), 'the unsafe leading text member needs its Sort').to.match(/sort/i);
			expect(await column(db, q, 'r'))
				.to.deep.equal(await column(db, `select k || '/' || d as r from m order by k, d`, 'r'));
		});

		it('leaves DESC and partial index shapes alone', async () => {
			await db.exec(`create table t (id integer primary key, v text) using store`);
			await db.exec(`create index ix_desc on t (v desc)`);
			await db.exec(`create table m (id integer primary key, v text)`);
			await db.exec(`create index ix_mdesc on m (v desc)`);
			await db.exec(`insert into t values (1, 'a'), (2, 'm'), (3, 'z')`);
			await db.exec(`insert into m values (1, 'a'), (2, 'm'), (3, 'z')`);
			expect(await agreesWithMemory(`v > 'b'`)).to.deep.equal([2, 3]);
			expect(await planOps(db, `select id from t where v > 'b' order by id`), 'DESC index still seeks')
				.to.match(SEEK);

			await db.exec(`create table p (id integer primary key, v text) using store`);
			await db.exec(`create index ix_part on p (v) where id > 1`);
			await db.exec(`insert into p values (1, 'a'), (2, 'm'), (3, 'z')`);
			const pq = `select id from p where v > 'b' order by id`;
			expect(await planOps(db, pq), 'a partial index is still never seeked').to.not.match(SEEK);
			expect(await column(db, pq, 'id')).to.deep.equal([2, 3]);
		});
	});
});
