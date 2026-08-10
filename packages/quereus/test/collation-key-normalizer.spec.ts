/**
 * Row-grouping key normalizers must resolve against the **database's** collation
 * registry, not the process-global built-in table (ticket
 * `bug-key-normalizer-ignores-database-collations`).
 *
 * Every operator here buckets rows by a serialized text key: GROUP BY (hash aggregate),
 * window PARTITION BY, bloom/hash join keys, and AS OF partitioning. Each must partition
 * rows into exactly the classes the collation's *comparator* calls equal — otherwise
 * `where`, `distinct`, and `order by` disagree with `group by` on the same column in the
 * same connection.
 *
 * Column DDL still refuses a collation name it has never heard of (see the
 * `feat-ddl-accepts-registered-collations` backlog ticket), so — as in
 * `test/mv-custom-collation-maintenance.spec.ts` — these tests reach a *custom*
 * comparator by overriding the built-in `NOCASE` on one connection. The override
 * equates any two strings of the same length, which the built-in NOCASE never does;
 * every assertion below is false under byte comparison and false under the real NOCASE.
 */
import { expect } from 'chai';
import { Database } from '../src/index.js';

/** A `NOCASE` that equates every pair of same-length strings. */
const lengthOnly = (a: string, b: string): number => a.length - b.length;
/** Partitions strings into the same classes as {@link lengthOnly}. */
const lengthNormalizer = (s: string): string => 'x'.repeat(s.length);

async function results(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

/** The `s` column of every row, in order. Group-by queries also surface the group key,
 *  whose byte value is an arbitrary representative of its collation class — assert the
 *  aggregate, not the representative. */
async function sums(db: Database, sql: string): Promise<unknown[]> {
	return (await results(db, sql)).map(r => r.s);
}

/** The `op` values of every node in the plan for `sql`. */
async function planOps(db: Database, sql: string): Promise<string[]> {
	const rows: string[] = [];
	for await (const r of db.eval('select op from query_plan(?)', [sql])) {
		rows.push((r as { op: string }).op);
	}
	return rows;
}

/** True iff some node in the plan for `sql` advertises a bloom/hash join. */
async function usesBloomJoin(db: Database, sql: string): Promise<boolean> {
	for await (const r of db.eval(
		"select 1 as ok from query_plan(?) where properties like '%bloom%' limit 1", [sql],
	)) {
		void r;
		return true;
	}
	return false;
}

describe('hash-keyed operators group under the database-registered collation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerCollation('NOCASE', lengthOnly, { normalizer: lengthNormalizer });
		await db.exec('create table src (id integer primary key, k text collate nocase, v integer)');
		await db.exec("insert into src values (1, 'aa', 10), (2, 'bb', 5)");
	});
	afterEach(async () => { await db.close(); });

	it('agrees with `where` and `distinct`, which already honored the collation', async () => {
		// The baseline the grouping paths were contradicting: comparison-based operators
		// have always resolved NOCASE from the database.
		expect(await results(db, "select id from src where k = 'bb' order by id"))
			.to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await results(db, 'select distinct k from src')).to.deep.equal([{ k: 'aa' }]);
	});

	it('collapses collation-equal group keys in the hash aggregate', async () => {
		const sql = 'select sum(v) as s from src group by k';
		expect(await planOps(db, sql), 'hash aggregate is the path under test')
			.to.include('HASHAGGREGATE');
		expect(await sums(db, sql)).to.deep.equal([15]);
	});

	it('gives the same answer through the streaming aggregate', async () => {
		// Which aggregate the optimizer picks is invisible to the user, so both must agree.
		// Pre-sorting the source on the group key steers `ruleAggregatePhysical` to the
		// already-sorted → StreamAggregate branch.
		const sql = 'select sum(v) as s from (select k, v from src order by k) group by k';
		expect(await planOps(db, sql), 'streaming aggregate is the path under test')
			.to.include('STREAMAGGREGATE');
		expect(await sums(db, sql)).to.deep.equal([15]);
	});

	it('puts collation-equal rows in one window partition', async () => {
		expect(await results(db, 'select id, sum(v) over (partition by k) as s from src order by id'))
			.to.deep.equal([{ id: 1, s: 15 }, { id: 2, s: 15 }]);
	});

	it('matches collation-equal keys across a bloom join', async () => {
		await db.exec('create table j_left (id integer primary key, k text collate nocase)');
		await db.exec('create table j_right (id integer primary key, k text collate nocase, tag text)');
		await db.exec("insert into j_left values (1, 'aa'), (2, 'ccc')");
		await db.exec("insert into j_right values (10, 'bb', 'two'), (20, 'dddd', 'four')");

		const sql = 'select l.id, r.tag from j_left l join j_right r on l.k = r.k order by l.id';
		expect(await usesBloomJoin(db, sql), 'bloom join is the path under test').to.equal(true);
		// 'aa' ≡ 'bb' (both length 2); 'ccc' matches nothing (no length-3 right key).
		expect(await results(db, sql)).to.deep.equal([{ id: 1, tag: 'two' }]);
	});

	it('matches collation-equal keys across an AS OF partition', async () => {
		await db.exec('create table trades (id integer primary key, symbol text collate nocase, ts integer)');
		await db.exec('create table quotes (ts integer primary key, symbol text collate nocase, bid real)');
		await db.exec("insert into trades values (1, 'AA', 100), (2, 'C', 100)");
		await db.exec("insert into quotes values (50, 'BB', 1.5), (60, 'DDDD', 2.5)");

		// `order by ts` makes the left input monotonic on the match attribute, which is what
		// lets `rule-asof-scan` rewrite the lateral-top-1 into an AsofScanNode. Partitioned →
		// the hash strategy, which is the one that buckets the partition key.
		const sql = `select t.id, q.bid from (select id, symbol, ts from trades order by ts) t
			left join lateral (
				select bid from quotes q where q.symbol = t.symbol and q.ts <= t.ts order by q.ts desc limit 1
			) q on true order by t.id`;
		expect(await planOps(db, sql), 'asof scan is the path under test').to.include('ASOFSCAN');
		// Trade 'AA' (length 2) partitions with quote 'BB'; trade 'C' (length 1) with neither.
		expect(await results(db, sql)).to.deep.equal([{ id: 1, bid: 1.5 }, { id: 2, bid: null }]);
	});
});

describe('hash-keyed operators reject a collation that cannot bucket', () => {
	/** Run `sql`, returning the error message it raised ('' if it succeeded). */
	async function errorFrom(db: Database, sql: string): Promise<string> {
		try {
			await results(db, sql);
			return '';
		} catch (e) {
			return (e as Error).message;
		}
	}

	it('raises when a comparator-only collation keys a GROUP BY, naming the collation', async () => {
		const db = new Database();
		try {
			// A comparator with no normalizer can order rows, but nothing can say which rows
			// share a bucket. Guessing a built-in normalizer would split or merge groups the
			// comparator disagrees with. Column DDL still refuses an unknown collation name,
			// so the custom name is reached through an expression-level COLLATE.
			db.registerCollation('CMPONLY', lengthOnly);
			await db.exec('create table src (id integer primary key, k text, v integer)');
			await db.exec("insert into src values (1, 'aa', 10), (2, 'bb', 5)");

			expect(await errorFrom(db, 'select sum(v) as s from src group by k collate cmponly'))
				.to.match(/collation CMPONLY has no key normalizer/);
		} finally {
			await db.close();
		}
	});

	it('raises when a built-in is overridden without a normalizer', async () => {
		const db = new Database();
		try {
			db.registerCollation('NOCASE', lengthOnly);
			await db.exec('create table src (id integer primary key, k text collate nocase, v integer)');
			await db.exec("insert into src values (1, 'aa', 10), (2, 'bb', 5)");

			expect(await errorFrom(db, 'select sum(v) as s from src group by k'))
				.to.match(/collation NOCASE has no key normalizer/);
		} finally {
			await db.close();
		}
	});

	// A normalizer is only ever applied to a *string* key value, so a key that can never
	// hold text does not need one — demanding it would reject a query the collation cannot
	// affect. `hashKeyCollationName()` drops the inert name before the resolver sees it.
	describe('but not when the key can never hold text', () => {
		it('groups an INTEGER column declared under a comparator-only collation', async () => {
			const db = new Database();
			try {
				db.registerCollation('NOCASE', lengthOnly);
				await db.exec('create table src (id integer primary key, n integer collate nocase, v integer)');
				await db.exec('insert into src values (1, 7, 10), (2, 7, 5), (3, 9, 1)');
				expect(await results(db, 'select n, sum(v) as s from src group by n order by n'))
					.to.deep.equal([{ n: 7, s: 15 }, { n: 9, s: 1 }]);
			} finally {
				await db.close();
			}
		});

		it('groups an INTEGER expression under an explicit comparator-only COLLATE', async () => {
			const db = new Database();
			try {
				db.registerCollation('CMPONLY', lengthOnly);
				await db.exec('create table src (id integer primary key, n integer, v integer)');
				await db.exec('insert into src values (1, 7, 10), (2, 7, 5)');
				expect(await sums(db, 'select sum(v) as s from src group by n collate cmponly'))
					.to.deep.equal([15]);
			} finally {
				await db.close();
			}
		});

		it('partitions an INTEGER window key under a comparator-only collation', async () => {
			const db = new Database();
			try {
				db.registerCollation('NOCASE', lengthOnly);
				await db.exec('create table src (id integer primary key, n integer collate nocase, v integer)');
				await db.exec('insert into src values (1, 7, 10), (2, 7, 5)');
				expect(await results(db, 'select id, sum(v) over (partition by n) as s from src order by id'))
					.to.deep.equal([{ id: 1, s: 15 }, { id: 2, s: 15 }]);
			} finally {
				await db.close();
			}
		});

		it('bloom-joins INTEGER keys declared under a comparator-only collation', async () => {
			const db = new Database();
			try {
				db.registerCollation('NOCASE', lengthOnly);
				await db.exec('create table a (id integer primary key, n integer collate nocase)');
				await db.exec('create table b (id integer primary key, n integer collate nocase)');
				// Enough rows that the optimizer prefers the bloom/hash join over nested loops.
				const vals = Array.from({ length: 300 }, (_, i) => `(${i},${i})`).join(',');
				await db.exec(`insert into a values ${vals}`);
				await db.exec(`insert into b values ${vals}`);

				const sql = 'select count(*) as c from a join b on a.n = b.n';
				expect(await usesBloomJoin(db, sql), 'bloom join is the path under test').to.equal(true);
				expect(await results(db, sql)).to.deep.equal([{ c: 300 }]);
			} finally {
				await db.close();
			}
		});

		it('groups a BLOB key under a comparator-only collation', async () => {
			const db = new Database();
			try {
				db.registerCollation('CMPONLY', lengthOnly);
				await db.exec('create table src (id integer primary key, b blob, v integer)');
				await db.exec("insert into src values (1, x'01', 10), (2, x'01', 5)");
				expect(await sums(db, 'select sum(v) as s from src group by b collate cmponly'))
					.to.deep.equal([15]);
			} finally {
				await db.close();
			}
		});

		it('still raises for a TEXT key alongside an inert INTEGER one', async () => {
			// The text key in the same GROUP BY list is not excused by its integer sibling.
			const db = new Database();
			try {
				db.registerCollation('NOCASE', lengthOnly);
				await db.exec('create table src (id integer primary key, n integer collate nocase, k text collate nocase, v integer)');
				await db.exec("insert into src values (1, 7, 'aa', 10)");
				expect(await errorFrom(db, 'select sum(v) as s from src group by n, k'))
					.to.match(/collation NOCASE has no key normalizer/);
			} finally {
				await db.close();
			}
		});

		// A JSON value can BE a text string: `JSON_TYPE.parse` passes a JSON scalar string
		// through, so `'"Bob"'` stores the ordinary string `Bob`. The "can never hold text"
		// test must therefore be an allow-list over the physical representation
		// (INTEGER/REAL/BLOB/BOOLEAN), not `physicalType !== TEXT` — which would exempt
		// JSON's OBJECT and silently group `'Bob'`/`'BOB'` apart under NOCASE. See
		// `bug-json-columns-classified-as-non-textual`.
		it('still normalizes a JSON key, whose value can be a text string', async () => {
			const db = new Database();
			try {
				await db.exec('create table src (id integer primary key, j json, v integer)');
				await db.exec(`insert into src values (1, '"Bob"', 10), (2, '"BOB"', 5)`);
				expect(await sums(db, 'select sum(v) as s from src group by j collate nocase'))
					.to.deep.equal([15]);
			} finally {
				await db.close();
			}
		});

		it('still raises for a JSON key under a comparator-only collation', async () => {
			const db = new Database();
			try {
				db.registerCollation('CMPONLY', lengthOnly);
				await db.exec('create table src (id integer primary key, j json, v integer)');
				await db.exec(`insert into src values (1, '"Bob"', 10)`);
				expect(await errorFrom(db, 'select sum(v) as s from src group by j collate cmponly'))
					.to.match(/collation CMPONLY has no key normalizer/);
			} finally {
				await db.close();
			}
		});

		it('still raises for an ANY key, which can hold text', async () => {
			const db = new Database();
			try {
				db.registerCollation('CMPONLY', lengthOnly);
				await db.exec('create table src (id integer primary key, a any, v integer)');
				await db.exec("insert into src values (1, 'Bob', 10)");
				expect(await errorFrom(db, 'select sum(v) as s from src group by a collate cmponly'))
					.to.match(/collation CMPONLY has no key normalizer/);
			} finally {
				await db.close();
			}
		});
	});
});

describe('re-registering a collation changes later grouping', () => {
	it('a statement prepared after the re-registration groups under the new normalizer', async () => {
		const db = new Database();
		try {
			db.registerCollation('NOCASE', lengthOnly, { normalizer: lengthNormalizer });
			await db.exec('create table src (id integer primary key, k text collate nocase, v integer)');
			await db.exec("insert into src values (1, 'aa', 10), (2, 'bb', 5)");
			// Length-only: 'aa' and 'bb' are one group.
			expect(await sums(db, 'select sum(v) as s from src group by k')).to.deep.equal([15]);

			// Swap in the real NOCASE semantics; the same SQL must now see two groups.
			const lower = (s: string): string => s.toLowerCase();
			db.registerCollation('NOCASE', (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0), { normalizer: lower });
			expect(await sums(db, 'select sum(v) as s from src group by k order by k')).to.deep.equal([10, 5]);
		} finally {
			await db.close();
		}
	});
});

describe('built-in collations group unchanged on a fresh database', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, b text, n text collate nocase, r text collate rtrim, v integer)');
		await db.exec(`insert into t values
			(1, 'x', 'Foo', 'foo',   1),
			(2, 'X', 'FOO', 'foo  ', 2),
			(3, 'x', 'bar', 'bar',   4)`);
	});
	afterEach(async () => { await db.close(); });

	it('BINARY groups by exact bytes', async () => {
		expect(await results(db, 'select b, sum(v) as s from t group by b order by b'))
			.to.deep.equal([{ b: 'X', s: 2 }, { b: 'x', s: 5 }]);
		expect(await sums(db, 'select b, sum(v) as s from t group by b order by b'))
			.to.deep.equal([2, 5]);
	});

	it('NOCASE folds case', async () => {
		expect(await sums(db, 'select sum(v) as s from t group by n order by n'))
			.to.deep.equal([4, 3]);
	});

	it('RTRIM ignores trailing spaces', async () => {
		expect(await sums(db, 'select sum(v) as s from t group by r order by r'))
			.to.deep.equal([4, 3]);
	});
});
