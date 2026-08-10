/**
 * Secondary-index KEY bytes encode each index column under the column's own effective
 * collation C (`resolveIndexKeyCollations`: the index column's COLLATE, else the table
 * column's declared collation, else BINARY) — NOT the table key collation K
 * (`collation = …` module option, default NOCASE) they historically used.
 *
 * Everything that COMPARES index-scanned or UNIQUE-enforced values already compares
 * under C (`matchesFilters`' residual, the planner's cover analysis,
 * `uniqueEnforcementCollations`), so keying under K left the stored bytes disagreeing
 * with every comparison made against them. These tests pin the C-encoded behavior at
 * the seams where the K encoding was observable: read seeks, UNIQUE enforcement
 * (including the `_uc_*`-vs-explicit-index resolution), multi-seek window folding,
 * ALTER COLUMN … SET COLLATE index rebuilds, catalog reopen, DDL-time collation
 * validation, and the isolation overlay's index-scan merge order
 * (`StoreTableScan.getIndexComparator`).
 *
 * A memory table is the oracle wherever the semantics should match.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, INTEGER_TYPE, TEXT_TYPE, ANY_TYPE, type SqlValue, type TableIndexSchema, type ColumnSchema } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	createIsolatedStoreModule,
	resolveIndexKeyCollations,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * Persistent in-memory provider: logical close is a no-op so data survives a module
 * close (mirroring real disk), letting the reopen tests re-rehydrate the same catalog.
 */
function createPersistentProvider(): KVStoreProvider & { _hardClose: () => void } {
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
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async closeAll() { /* durable */ },
		_hardClose() {
			for (const store of stores.values()) void store.close();
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

/** A keyable custom collation (comparator + key normalizer) that ignores spaces. */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const sa = stripSpaces(a);
	const sb = stripSpaces(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;
const UNIQUE_FAILED = /unique constraint failed/i;

describe('secondary-index key bytes encode under the index column collation, not the table key collation', () => {
	let db: Database;
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		db = new Database();
		provider = createPersistentProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await db.close();
		provider._hardClose();
	});

	describe('resolveIndexKeyCollations (unit)', () => {
		const col = (partial: Partial<ColumnSchema> & { name: string }): ColumnSchema =>
			partial as unknown as ColumnSchema;
		const columns: ColumnSchema[] = [
			col({ name: 'plain_text', logicalType: TEXT_TYPE }),
			col({ name: 'nocase_text', logicalType: TEXT_TYPE, collation: 'nocase' }),
			col({ name: 'n', logicalType: INTEGER_TYPE }),
			col({ name: 'v', logicalType: ANY_TYPE, collation: 'nocase' }),
		];
		const index = (cols: TableIndexSchema['columns']): TableIndexSchema =>
			({ name: 'ix', columns: cols } as unknown as TableIndexSchema);

		it('an undecorated text column keys BINARY — the fallback is BINARY, not K', () => {
			expect(resolveIndexKeyCollations(index([{ index: 0 }]), columns)).to.deep.equal(['BINARY']);
		});

		it('a declared column collation is honored, and an index COLLATE overrides it', () => {
			expect(resolveIndexKeyCollations(index([{ index: 1 }]), columns)).to.deep.equal(['NOCASE']);
			expect(resolveIndexKeyCollations(index([{ index: 1, collation: 'binary' }]), columns))
				.to.deep.equal(['BINARY']);
		});

		it('a never-text column resolves undefined; an `any` column keys under its declared collation', () => {
			// `v any collate nocase`: ANY_TYPE.compare honors the collation it is handed
			// (any-type-compare-honors-collation), so the key encodes under the declared
			// NOCASE — the same collation the residual and UNIQUE enforcement compare under.
			expect(resolveIndexKeyCollations(index([{ index: 2 }, { index: 3 }]), columns))
				.to.deep.equal([undefined, 'NOCASE']);
		});
	});

	describe('the default shape: K = NOCASE, undecorated text column keys BINARY', () => {
		it('an index seek finds the exact case, and both case-variant rows are index-reachable', async () => {
			await db.exec(`create table t (id integer primary key, name text) using store`);
			await db.exec(`create table m (id integer primary key, name text)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`create index ix_${tbl} on ${tbl} (name)`);
				await db.exec(`insert into ${tbl} values (1, 'Ann'), (2, 'ann')`);
			}

			const q = `select id from t where name = 'ann'`;
			expect(await planOps(db, q), 'the predicate is served by the index').to.match(SEEK);
			expect(await column(db, q, 'id')).to.deep.equal([2]);
			expect(await column(db, q, 'id'))
				.to.deep.equal(await column(db, `select id from m where name = 'ann'`, 'id'));
			expect(await column(db, `select id from t where name = 'Ann'`, 'id')).to.deep.equal([1]);
		});

		it('build path and maintenance path agree byte-for-byte (index on a non-empty table, then UPDATE)', async () => {
			await db.exec(`create table t (id integer primary key, name text) using store`);
			await db.exec(`insert into t values (1, 'Ann'), (2, 'Bob')`);
			// Build path: buildIndexEntries over existing rows.
			await db.exec(`create index ix on t (name)`);
			expect(await column(db, `select id from t where name = 'Ann'`, 'id')).to.deep.equal([1]);

			// Maintenance path: delete-then-insert must address the same bytes the build wrote.
			await db.exec(`update t set name = 'Cat' where id = 1`);
			expect(await column(db, `select id from t where name = 'Cat'`, 'id')).to.deep.equal([1]);
			expect(await column(db, `select id from t where name = 'Ann'`, 'id')).to.deep.equal([]);
		});
	});

	describe('UNIQUE enforcement seeks the constraint-realizing index under its true key bytes', () => {
		it("the constraint's own `_uc_*` wins over a collation-mismatched explicit index", async () => {
			// `findReusableIndexForUnique` refuses `ix` (BINARY ≠ the declared NOCASE), so
			// `_uc_email` is materialized under NOCASE. A by-column-set resolution would
			// still land on the EXPLICIT `ix`, whose BINARY bytes cannot see 'A@x' from a
			// probe for 'a@x' — the seek under-fetches and the duplicate lands silently.
			await db.exec(`create table t (id integer primary key, email text collate nocase, unique (email)) using store`);
			await db.exec(`create index ix on t (email collate binary)`);
			await db.exec(`insert into t values (1, 'A@x')`);

			const err = await attempt(db, `insert into t values (2, 'a@x')`);
			expect(err, 'the NOCASE-enforced UNIQUE must reject the case-variant').to.not.be.null;
			expect(err!.message).to.match(UNIQUE_FAILED);
		});

		it("a UNIQUE index over `any` accepts both 'A' and 'a', as a memory table does", async () => {
			await db.exec(`create table t (id integer primary key, v any) using store`);
			await db.exec(`create table m (id integer primary key, v any)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`create unique index uv_${tbl} on ${tbl} (v)`);
				await db.exec(`insert into ${tbl} values (1, 'A')`);
				expect(await attempt(db, `insert into ${tbl} values (2, 'a')`), `${tbl} must accept both`).to.be.null;
			}
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
		});

		it('a partial UNIQUE index under K = BINARY still catches a case-variant entering its scope', async () => {
			// email is declared NOCASE while K = BINARY: under the old K encoding the
			// enforcement seek for 'a@x' would probe byte-exact bytes and miss 'A@x'.
			await db.exec(`create table t (id integer primary key, email text collate nocase, active integer) using store (collation = binary)`);
			await db.exec(`create unique index ix on t (email) where active = 1`);
			await db.exec(`insert into t values (1, 'A@x', 1)`);
			await db.exec(`insert into t values (2, 'a@x', 0)`);

			const err = await attempt(db, `update t set active = 1 where id = 2`);
			expect(err, 'the scope transition re-triggers the NOCASE-enforced check').to.not.be.null;
			expect(err!.message).to.match(UNIQUE_FAILED);
		});

		it('a DESC NOCASE unique index under K = BINARY lands its seek on the inverted window', async () => {
			await db.exec(`create table t (id integer primary key, email text) using store (collation = binary)`);
			await db.exec(`create unique index ue on t (email collate nocase desc)`);
			await db.exec(`insert into t values (1, 'A@x')`);

			const err = await attempt(db, `insert into t values (2, 'a@X')`);
			expect(err, 'the DESC-encoded NOCASE window must find the committed entry').to.not.be.null;
			expect(err!.message).to.match(UNIQUE_FAILED);
		});
	});

	describe('read seeks under an explicit index COLLATE', () => {
		it('a BINARY index over a NOCASE column returns only the byte-exact row for =', async () => {
			await db.exec(`create table t (id integer primary key, email text collate nocase) using store`);
			await db.exec(`create index ix on t (email collate binary)`);
			await db.exec(`insert into t values (1, 'A@X'), (2, 'a@x')`);

			expect(await column(db, `select id from t where email collate binary = 'A@X'`, 'id'))
				.to.deep.equal([1]);
			// The column's own (NOCASE) equality still unifies both rows.
			expect((await column(db, `select id from t where email = 'a@x'`, 'id')).sort())
				.to.deep.equal([1, 2]);
		});
	});

	describe('multi-seek window folding happens under C, not K', () => {
		it("`in ('a','A')` over a BINARY column yields both rows, in BINARY index-key order", async () => {
			// PKs chosen so the pre-change single K-folded window (PK-suffix order: 1 then 2)
			// and the two C-distinct windows ('A' 0x41 before 'a' 0x61) disagree on order.
			await db.exec(`create table t (id integer primary key, name text) using store`);
			await db.exec(`create index ix on t (name)`);
			await db.exec(`insert into t values (1, 'a'), (2, 'A')`);

			const rows = await asyncIterableToArray(db.eval(`select id, name from t where name in ('a', 'A')`));
			expect(rows.map(r => [r.id, r.name])).to.deep.equal([[2, 'A'], [1, 'a']]);
		});
	});

	describe('ALTER COLUMN … SET COLLATE re-encodes covering indexes', () => {
		it('an index-backed lookup succeeds for a value matching only under the new collation', async () => {
			await db.exec(`create table t (id integer primary key, name text) using store`);
			await db.exec(`create index ix on t (name)`);
			await db.exec(`insert into t values (1, 'Ann')`);

			await db.exec(`alter table t alter column name set collate nocase`);
			// C = NOCASE = K now, so the planner takes the index seek and drops the
			// residual: a stale BINARY-keyed entry would make this silently return 0 rows.
			const q = `select id from t where name = 'ANN'`;
			expect(await planOps(db, q)).to.match(SEEK);
			expect(await column(db, q, 'id')).to.deep.equal([1]);
		});

		it('a derived UNIQUE both enforces under the new collation and has re-encoded entries', async () => {
			await db.exec(`create table t (id integer primary key, email text) using store`);
			await db.exec(`create unique index ue on t (email)`);
			await db.exec(`insert into t values (1, 'A@x')`);

			await db.exec(`alter table t alter column email set collate nocase`);
			const err = await attempt(db, `insert into t values (2, 'a@X')`);
			expect(err, 'enforcement now unifies case-variants').to.not.be.null;
			expect(err!.message).to.match(UNIQUE_FAILED);
			// And the read side finds the re-encoded entry through the index.
			expect(await column(db, `select id from t where email = 'a@X'`, 'id')).to.deep.equal([1]);
		});

		it('the pre-mutation UNIQUE probe rejects a SET COLLATE that would make existing rows collide', async () => {
			await db.exec(`create table t (id integer primary key, email text) using store`);
			await db.exec(`create unique index ue on t (email)`);
			await db.exec(`insert into t values (1, 'A@x'), (2, 'a@x')`);

			const err = await attempt(db, `alter table t alter column email set collate nocase`);
			expect(err, "'A@x' and 'a@x' collide under the new collation").to.not.be.null;
			expect(err!.message).to.match(UNIQUE_FAILED);
			// The rejected ALTER left the rows and the old (BINARY) enforcement intact.
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
		});

		it('SET COLLATE on a PK member re-encodes the index-column half of an index over it', async () => {
			// The PK re-key arm rebuilds every index; the rebuilt entries must carry the
			// column's NEW collation in the index-column half too, not just the PK suffix.
			await db.exec(`create table t (name text primary key, v integer) using store`);
			await db.exec(`create index ixn on t (name)`);
			await db.exec(`insert into t values ('Ann', 1)`);

			await db.exec(`alter table t alter column name set collate binary`);
			// The column is now BINARY, so the index bytes and the scan residual both use
			// BINARY and the planner seeks a BINARY-exact window (the table key collation K
			// is not consulted) — a stale NOCASE-keyed entry ('ann') would miss it.
			expect(await column(db, `select v from t where name = 'Ann'`, 'v')).to.deep.equal([1]);
			expect(await column(db, `select v from t where name = 'ANN'`, 'v')).to.deep.equal([]);
		});
	});

	describe('catalog round-trip', () => {
		it('an explicit index COLLATE survives close → reopen and the UNIQUE seek still lands', async () => {
			await db.exec(`create table t (id integer primary key, email text) using store`);
			await db.exec(`create unique index ue on t (email collate nocase)`);
			await db.exec(`insert into t values (1, 'Ann')`);
			await db.close();

			db = new Database();
			const mod = new StoreModule(provider);
			db.registerModule('store', mod);
			const result = await mod.rehydrateCatalog(db);
			expect(result.errors).to.have.lengthOf(0);

			// A reopen that dropped the index COLLATE would resolve the key collation (and
			// the derived UNIQUE's enforcement) to BINARY, probe byte-exact 'ANN' against
			// the persisted NOCASE ('ann') entry, miss it, and accept the duplicate.
			const err = await attempt(db, `insert into t values (2, 'ANN')`);
			expect(err, 'the rehydrated NOCASE enforcement must reject the case-variant').to.not.be.null;
			expect(err!.message).to.match(UNIQUE_FAILED);
			// Sanity: the reopened table is still writable for a genuinely distinct value.
			expect(await attempt(db, `insert into t values (3, 'Zed')`)).to.be.null;
		});

		it('a table whose index collation this connection cannot key is evicted alone; siblings still reconcile', async () => {
			// `validateKeyCollations` now covers index key collations, so the rehydrate's
			// post-import reconcile (`updateSchema`) can throw where it never could before.
			// Unhandled that aborted the whole loop, leaving every LATER table live on its
			// import-time index-less schema — accepting DML without maintaining indexes and
			// without enforcing its derived UNIQUE.
			db.registerCollation('NOSPACE', noSpace, stripSpaces);
			await db.exec(`create table bad (id integer primary key, code text) using store`);
			await db.exec(`create unique index ix_code on bad (code collate NOSPACE)`);
			await db.exec(`create table good (id integer primary key, email text) using store`);
			await db.exec(`create unique index ix_email on good (email collate nocase)`);
			await db.exec(`insert into bad values (1, 'a b')`);
			await db.exec(`insert into good values (1, 'A@x')`);
			await db.close();

			// Fresh connection: NOSPACE never registered, so `bad`'s index cannot key.
			db = new Database();
			const mod = new StoreModule(provider);
			db.registerModule('store', mod);
			const result = await mod.rehydrateCatalog(db);
			expect(result.errors.map(e => e.error.message).join('; ')).to.match(/NOSPACE/i);
			expect(result.errors, 'only the offending table fails').to.have.lengthOf(1);

			// `good` reconciled its index despite `bad` failing first: the derived UNIQUE
			// enforces under NOCASE, which an index-less half-schema could not do.
			const goodErr = await attempt(db, `insert into good values (2, 'a@X')`);
			expect(goodErr, "good's rehydrated UNIQUE must reject the case-variant").to.not.be.null;
			expect(goodErr!.message).to.match(UNIQUE_FAILED);

			// `bad` was evicted rather than left half-schema'd, so the next statement
			// reconnects and raises at the point of use instead of silently skipping
			// index maintenance.
			const badErr = await attempt(db, `insert into bad values (2, 'zz')`);
			expect(badErr, 'the evicted table must raise, not accept unmaintained DML').to.not.be.null;
			expect(badErr!.message).to.match(/NOSPACE/i);
		});
	});

	describe('getIndexComparator states the store\'s physical index-key order', () => {
		it('honors the key collation, negates DESC, and resolves a hidden `_uc_*`', async () => {
			// Its own module handle, so the connected StoreTable is reachable directly —
			// the isolation merge consumes these comparators end-to-end (above), this
			// pins the per-column output they are built from.
			const localProvider = createPersistentProvider();
			const localDb = new Database();
			const module = new StoreModule(localProvider);
			localDb.registerModule('store', module);
			try {
				await localDb.exec(`create table t (id integer primary key, name text collate nocase, score integer, email text, unique (email)) using store`);
				await localDb.exec(`create index ix on t (name, score desc)`);

				const table = module.getTable('main', 't');
				expect(table, 'the connected StoreTable').to.not.be.undefined;

				const comparators = table!.getIndexComparator('ix');
				expect(comparators, 'one comparator per index column').to.have.lengthOf(2);
				expect(comparators![0]('Ann', 'ann'), "the column's NOCASE key collation").to.equal(0);
				expect(comparators![1](1, 2), 'DESC inverts the key bytes, so the comparator negates').to.be.greaterThan(0);

				// Resolved against the MATERIALIZED schema, so the hidden index realizing the
				// plain `unique (email)` is nameable — and its undecorated text column keys
				// BINARY, not under the NOCASE table key collation.
				const ucComparators = table!.getIndexComparator('_uc_email');
				expect(ucComparators).to.have.lengthOf(1);
				expect(ucComparators![0]('A@x', 'a@x')).to.not.equal(0);

				expect(table!.getIndexComparator('no_such_index')).to.be.undefined;
			} finally {
				await localDb.close();
				localProvider._hardClose();
			}
		});
	});

	describe('DDL-time collation validation follows the index key collations', () => {
		it('a comparator-only collation on an index column is rejected at CREATE INDEX, not at first write', async () => {
			db.registerCollation('vault', (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
			// The column alone is fine — comparisons only need the comparator.
			await db.exec(`create table t (id integer primary key, v text collate vault) using store`);
			await db.exec(`insert into t values (1, 'x')`);

			const err = await attempt(db, `create index ix on t (v)`);
			expect(err, 'an index would KEY under vault, which cannot produce key bytes').to.not.be.null;
			expect(err!.message).to.match(/cannot key|no key normalizer/i);
		});

		it('a comparator-only collation under a plain UNIQUE is rejected at CREATE TABLE (hidden `_uc_*`)', async () => {
			db.registerCollation('vault2', (a, b) => (a < b ? -1 : a > b ? 1 : 0));
			const err = await attempt(db,
				`create table t (id integer primary key, v text collate vault2, unique (v)) using store`);
			expect(err).to.not.be.null;
			expect(err!.message).to.match(/cannot key|no key normalizer/i);
		});
	});

	describe('isolation overlay merge order (StoreTableScan.getIndexComparator)', () => {
		it('an overlay row NOCASE-equal to a committed row merges in NOCASE order, PK tie-break', async () => {
			// `v text collate nocase` under the NOCASE default K: the index emits in NOCASE
			// byte order, and the store now STATES that order via getIndexComparator. The
			// isolation layer's descriptor fallback would compare BINARY ('B' < 'b'
			// unconditionally), placing the committed row (pk 5) ahead of the staged one
			// (pk 1) even though the NOCASE tie must break on PK.
			const isoProvider = createPersistentProvider();
			const isoDb = new Database();
			isoDb.registerModule('store', createIsolatedStoreModule({ provider: isoProvider }));
			try {
				await isoDb.exec(`create table t (id integer primary key, v text collate nocase) using store`);
				await isoDb.exec(`create index ix on t (v)`);
				await isoDb.exec(`insert into t values (5, 'B')`);

				await isoDb.exec(`begin`);
				await isoDb.exec(`insert into t values (1, 'b')`);
				const rows = await asyncIterableToArray(isoDb.eval(`select id from t where v = 'b'`));
				expect(rows.map(r => r.id), 'NOCASE-equal values order by PK: staged 1 before committed 5')
					.to.deep.equal([1, 5]);
				await isoDb.exec(`rollback`);
			} finally {
				await isoDb.close();
				isoProvider._hardClose();
			}
		});
	});
});
