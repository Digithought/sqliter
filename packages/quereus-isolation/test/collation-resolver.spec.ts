/**
 * IsolatedTable resolves collation names against its OWN database.
 *
 * The overlay/underlying merge aligns rows by a primary-key comparator, and the
 * read-your-own-writes write path decides "same logical key" with `keysEqual`. Both
 * used to resolve the PK columns' declared collation through the process-global
 * `compareSqlValues(a, b, name)`, which knows only BINARY / NOCASE / RTRIM and falls
 * back to BINARY on a miss. They now resolve through `db.getCollationResolver()`, so a
 * collation registered (or a built-in overridden) on the connection participates — and
 * agrees with the collation the underlying table keys its rows by.
 *
 * A custom collation cannot yet be named on a *column* (`validateCollationForType`
 * checks a static per-type list), so these tests override the built-in `NOCASE` on the
 * database. A comparison that reached the global registry would still get the built-in
 * case-folding comparator, which is what makes the override a discriminating probe.
 * The custom-name-on-an-index-column shape is exercised too.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, type SqlValue } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/** Ignores spaces, so `'a b'` and `'ab'` are one value. Does NOT fold case. */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const sa = stripSpaces(a);
	const sb = stripSpaces(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
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

describe('IsolatedTable collation resolution', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
	});

	afterEach(async () => {
		await db.close();
	});

	describe('primary key under an overridden NOCASE', () => {
		beforeEach(async () => {
			// NOCASE now means "ignore spaces", on this database only.
			db.registerCollation('NOCASE', noSpace, stripSpaces);
			await db.exec(`create table t (k text collate NOCASE primary key, v text) using isolated`);
			await db.exec(`insert into t values ('a b', 'base')`);
		});

		it('treats a collation-equal PK rewrite as an in-place update, not a relocation', async () => {
			// 'ab' is the SAME logical key as 'a b' under the overridden NOCASE. Resolved
			// against the global registry the two are distinct, so the write is classified
			// as a PK relocation whose "new" key resolves back to the same underlying row —
			// a false PK conflict.
			await db.exec(`begin`);
			expect(await attempt(db, `update t set k = 'ab', v = 'staged' where k = 'a b'`)).to.be.null;

			const staged = await collect(db, `select k, v from t`);
			expect(staged, 'the staged row shadows the base row exactly once').to.deep.equal([
				{ k: 'ab', v: 'staged' },
			]);
			await db.exec(`commit`);

			const committed = await collect(db, `select k, v from t`);
			expect(committed).to.deep.equal([{ k: 'ab', v: 'staged' }]);
		});

		it('restores the base row on rollback', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set k = 'ab', v = 'staged' where k = 'a b'`);
			await db.exec(`rollback`);

			const rows = await collect(db, `select k, v from t`);
			expect(rows).to.deep.equal([{ k: 'a b', v: 'base' }]);
		});

		it('shadows the base row exactly once when only a non-key column is staged', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set v = 'staged' where k = 'a b'`);

			const rows = await collect(db, `select k, v from t`);
			expect(rows).to.deep.equal([{ k: 'a b', v: 'staged' }]);
			await db.exec(`rollback`);
		});

		it('rejects an insert whose PK collation-equals a committed row', async () => {
			await db.exec(`begin`);
			const err = await attempt(db, `insert into t values ('ab', 'dup')`);
			expect(err, 'expected a PK conflict against the underlying row').to.not.be.null;
			expect(err!.message).to.match(/constraint failed|unique/i);
			await db.exec(`rollback`);

			const rows = await collect(db, `select k, v from t`);
			expect(rows).to.deep.equal([{ k: 'a b', v: 'base' }]);
		});

		it('accepts an insert whose PK the overridden NOCASE keeps distinct', async () => {
			await db.exec(`begin`);
			expect(await attempt(db, `insert into t values ('a c', 'other')`)).to.be.null;
			await db.exec(`commit`);

			const rows = await collect(db, `select k, v from t order by k`);
			expect(rows).to.have.lengthOf(2);
		});
	});

	// NOTE: every test here reaches `mergedSecondaryIndexQuery` only because the planner
	// picks `ix_v` for `where v = ...`. If it ever stops doing so the scan falls back to the
	// primary-key merge, which shadows correctly for other reasons — so these tests would
	// pass vacuously rather than fail. If you change index selection, re-verify that
	// reverting `pkNormalizers` to a built-ins-only resolver still makes them fail.
	describe('secondary-index scan under a custom PK collation', () => {
		it('shadows the base row exactly once when the PK is rewritten to a collation-equal value', async () => {
			// Same override-NOCASE probe as above, but the read path is a secondary-index
			// scan (`mergedSecondaryIndexQuery`), which keys its modified-PK set separately
			// from the primary-key merge exercised above.
			db.registerCollation('NOCASE', noSpace, stripSpaces);
			await db.exec(`create table t (k text collate NOCASE primary key, v integer) using isolated`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values ('a b', 1)`);

			await db.exec(`begin`);
			await db.exec(`update t set k = 'ab' where k = 'a b'`);

			const rows = await collect(db, `select k, v from t where v = 1`);
			expect(rows, 'the staged row shadows the base row exactly once').to.deep.equal([
				{ k: 'ab', v: 1 },
			]);
			await db.exec(`rollback`);
		});

		it('raises rather than under-shadowing when the PK collation has no key normalizer', async () => {
			// A comparator-only collation (no `normalizer` passed to `registerCollation`) can
			// order rows but cannot bucket them into a Set key — `getKeyNormalizerResolver()`
			// throws instead of silently falling back to identity, which would reproduce the
			// duplicate-row bug this suite guards against.
			db.registerCollation('NOCASE', noSpace);
			await db.exec(`create table t (k text collate NOCASE primary key, v integer) using isolated`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values ('a b', 1)`);

			await db.exec(`begin`);
			await db.exec(`update t set k = 'ab' where k = 'a b'`);

			// `attempt`/`db.exec` doesn't fully drain a bare SELECT's row stream, so the
			// error (raised while iterating rows) must be caught around `collect`/`db.eval`.
			let err: Error | null = null;
			try {
				await collect(db, `select k, v from t where v = 1`);
			} catch (e) {
				err = e as Error;
			}
			expect(err, 'expected a missing-key-normalizer error').to.not.be.null;
			expect(err!.message).to.match(/has no key normalizer/i);
			await db.exec(`rollback`);
		});

		it('needs no key normalizer for a PK column whose type can never hold text', async () => {
			// `serializeRowKey` normalizes only string values, so an INTEGER PK buckets by
			// value under any collation. MYCOLL is registered below, so DDL accepts the name on
			// the INTEGER column (an unregistered name would be rejected at CREATE since
			// feat-ddl-accepts-registered-collations); demanding a normalizer here would reject a
			// valid query that the engine's own hash sites (`hashKeyCollationName`) accept.
			db.registerCollation('MYCOLL', (a, b) => (a < b ? -1 : a > b ? 1 : 0));
			await db.exec(`create table t (n integer collate MYCOLL primary key, v integer) using isolated`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 10), (2, 20)`);

			await db.exec(`begin`);
			await db.exec(`update t set v = 11 where n = 1`);

			const rows = await collect(db, `select n, v from t where v = 11`);
			expect(rows, 'the staged row shadows the base row exactly once').to.deep.equal([
				{ n: 1, v: 11 },
			]);
			await db.exec(`rollback`);
		});
	});

	describe('UNIQUE against committed rows', () => {
		it('enforces an index-derived UNIQUE under a custom collation named on the index column', async () => {
			db.registerCollation('NOSPACE', noSpace, stripSpaces);
			await db.exec(`create table t (id integer primary key, code text) using isolated`);
			await db.exec(`create unique index ix_code on t (code collate NOSPACE)`);
			await db.exec(`insert into t values (1, 'a b')`);

			await db.exec(`begin`);
			const err = await attempt(db, `insert into t values (2, 'ab')`);
			expect(err, 'expected a UNIQUE violation against the committed row').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			await db.exec(`rollback`);
		});

		it('still rejects a case-variant duplicate under the built-in NOCASE', async () => {
			// Regression guard: NOCASE resolves in both registries, so this would keep
			// passing under a wiring mistake that picks the wrong one — it catches only a
			// mistake that breaks enforcement outright.
			await db.exec(`create table t (id integer primary key, code text collate NOCASE unique) using isolated`);
			await db.exec(`insert into t values (1, 'abc')`);

			await db.exec(`begin`);
			const err = await attempt(db, `insert into t values (2, 'ABC')`);
			expect(err, 'expected a UNIQUE violation').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			await db.exec(`rollback`);
		});
	});

	describe('unregistered collation', () => {
		it('is rejected at DDL rather than falling back to BINARY', async () => {
			// Since feat-ddl-accepts-registered-collations the engine's column-DDL gate is
			// registry-aware for EVERY type, so an unregistered name on an INTEGER column is
			// rejected up front with `Unknown collation` — before the isolation module's
			// resolver would have thrown `no such collation sequence` at comparator build.
			const err = await attempt(
				db,
				`create table t (k integer collate FROBNICATE primary key, v text) using isolated`,
			);
			expect(err, 'expected an unresolvable-collation error').to.not.be.null;
			expect(err!.message).to.match(/Unknown collation/i);
		});
	});
});
