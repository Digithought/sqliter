import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { allRows } from './_helpers.js';

/**
 * Window `min(x) over (…)` / `max(x) over (…)` must rank by the same comparator the
 * `min(x)` / `max(x)` aggregate and `order by x` use — the argument's logical type's
 * `compare` when it carries semantic ordering (TIMESPAN, JSON), else storage-class
 * ordering under the argument's resolved collation. See docs/types.md "Semantic
 * ordering".
 *
 * Two things are locked here that a `.sqllogic` file cannot express:
 *
 *  1. **Both physical shapes.** A window has two emitters — the buffered frame walk
 *     and the streaming fast path that `rule-monotonic-window` activates when the
 *     source already arrives in window order. Each query below runs on BOTH (the
 *     rule disabled for the buffered run) and the results must be identical, so the
 *     two shapes cannot drift apart on comparison semantics.
 *  2. **The streaming path really engaged** for the sliding/running frames — asserted
 *     off the WindowNode's `streaming` property, not assumed.
 */
describe('Window min/max semantic ordering', () => {
	/** Build a database with the fixtures every case below shares. */
	async function makeDb(disableStreaming: boolean): Promise<Database> {
		const db = new Database();
		if (disableStreaming) {
			const prev = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...prev,
				disabledRules: new Set([...(prev.disabledRules ?? []), 'monotonic-window']),
			});
		}
		await db.exec('create table ts (id integer primary key, dur timespan)');
		await db.exec("insert into ts values (1,'PT30M'),(2,'PT1H'),(3,'PT2H'),(4,'P1D'),(5,'PT0S')");
		await db.exec('create table js (id integer primary key, d json)');
		await db.exec("insert into js values (1,'[8,1]'),(2,'[9]'),(3,'[10]')");
		await db.exec('create table nc (id integer primary key, t text collate nocase)');
		await db.exec("insert into nc values (1,'B'),(2,'a'),(3,'c')");
		await db.exec('create table anyv (id integer primary key, v any)');
		await db.exec("insert into anyv values (1,'abc'),(2,5),(3,'zz')");
		await db.exec('create table bl (id integer primary key, b blob)');
		await db.exec("insert into bl values (1, x'ff00'),(2, x'0102'),(3, x'80')");
		await db.exec('create table pg (id integer primary key, g integer, dur timespan)');
		await db.exec("insert into pg values (1,1,'PT30M'),(2,1,'P1D'),(3,2,'PT2H'),(4,2,'PT90M')");
		return db;
	}

	let streamingDb: Database;
	let bufferedDb: Database;

	beforeEach(async () => {
		streamingDb = await makeDb(false);
		bufferedDb = await makeDb(true);
	});

	afterEach(async () => {
		await streamingDb.close();
		await bufferedDb.close();
	});

	/** True when the plan's WindowNode carries the streaming marker. */
	async function isStreamingWindow(db: Database, sql: string): Promise<boolean> {
		for await (const r of db.eval('select op, properties from query_plan(?)', [sql])) {
			const rr = r as { op: string; properties: string | null };
			if (rr.op === 'WINDOW' && rr.properties) {
				return (JSON.parse(rr.properties) as { streaming?: unknown }).streaming !== undefined;
			}
		}
		return false;
	}

	/**
	 * Run `sql` on both the streaming and the buffered database, assert the two
	 * agree, and return the shared result for the caller's value assertions.
	 */
	async function bothShapes(sql: string): Promise<unknown[]> {
		const streamed = await allRows(streamingDb, sql);
		const buffered = await allRows(bufferedDb, sql);
		expect(streamed, `streaming vs buffered disagree for: ${sql}`).to.deep.equal(buffered);
		return streamed;
	}

	describe('whole-partition frame agrees with the aggregate', () => {
		it('TIMESPAN ranks by elapsed time, not text', async () => {
			// Text order would report mn='P1D', mx='PT30M'.
			expect(await bothShapes(
				'select distinct min(dur) over () as mn, max(dur) over () as mx from ts'
			)).to.deep.equal([{ mn: 'PT0S', mx: 'P1D' }]);
		});

		it('JSON ranks structurally', async () => {
			// Canonical-text order would report mn='[10]', mx='[9]'.
			expect(await bothShapes(
				'select distinct min(d) over () as mn, max(d) over () as mx from js'
			)).to.deep.equal([{ mn: [8, 1], mx: [10] }]);
		});

		it('a NOCASE text column ranks case-insensitively', async () => {
			// BINARY would report mn='B', mx='a'.
			expect(await bothShapes(
				'select distinct min(t) over () as mn, max(t) over () as mx from nc'
			)).to.deep.equal([{ mn: 'a', mx: 'c' }]);
		});

		it('mixed storage classes rank numeric below text', async () => {
			// The original defect: `5 < 'abc'` and `'abc' < 5` are both false in JS, so
			// the number was never selected and the min was whichever value arrived first.
			expect(await bothShapes(
				'select distinct min(v) over () as mn, max(v) over () as mx from anyv'
			)).to.deep.equal([{ mn: 5, mx: 'zz' }]);
		});

		it('PARTITION BY ranks within each partition', async () => {
			// Text order would give 'P1D' for g=1 and 'PT2H' for g=2.
			expect(await bothShapes(
				'select id, min(dur) over (partition by g) as mn from pg order by id'
			)).to.deep.equal([
				{ id: 1, mn: 'PT30M' },
				{ id: 2, mn: 'PT30M' },
				{ id: 3, mn: 'PT90M' },
				{ id: 4, mn: 'PT90M' },
			]);
		});

		it('blobs rank bytewise, agreeing with the aggregate', async () => {
			// `<` on two Uint8Arrays coerces both to strings — neither byte order nor
			// anything else meaningful. Bytewise order puts 0102 first and ff00 last.
			expect(await bothShapes(
				`select distinct
					(min(b) over () = (select min(b) from bl)) as min_agrees,
					(max(b) over () = (select max(b) from bl)) as max_agrees
				 from bl`
			)).to.deep.equal([{ min_agrees: true, max_agrees: true }]);
		});
	});

	describe('running and sliding frames', () => {
		// `rule-monotonic-window` maps an unbounded-preceding frame to its running
		// accumulator (`stepRunningAgg`) and a two-sided `n PRECEDING AND m FOLLOWING`
		// frame to its sliding-buffer scan — two distinct streaming code paths, each
		// of which had its own copy of the raw `<`.
		const runningSql =
			'select id, min(dur) over (order by id rows unbounded preceding) as rmn from ts order by id';
		const slidingMinSql =
			'select id, min(dur) over (order by id rows between 1 preceding and 1 following) as mn from ts order by id';
		const slidingMaxSql =
			'select id, max(dur) over (order by id rows between 1 preceding and 1 following) as mx from ts order by id';

		it('the streaming emitter really is the one under test', async () => {
			expect(await isStreamingWindow(streamingDb, runningSql), 'running frame streams').to.be.true;
			expect(await isStreamingWindow(streamingDb, slidingMinSql), 'sliding frame streams').to.be.true;
			expect(await isStreamingWindow(bufferedDb, slidingMinSql), 'rule disabled ⇒ buffered').to.be.false;
		});

		it('running MIN over TIMESPAN tightens by elapsed time', async () => {
			expect(await bothShapes(runningSql)).to.deep.equal([
				{ id: 1, rmn: 'PT30M' },
				{ id: 2, rmn: 'PT30M' },
				{ id: 3, rmn: 'PT30M' },
				{ id: 4, rmn: 'PT30M' },
				{ id: 5, rmn: 'PT0S' },
			]);
		});

		it('a sliding TIMESPAN frame ranks each window by elapsed time', async () => {
			// Text order would give mn='P1D' wherever the 'P1D' row is in frame.
			expect(await bothShapes(slidingMinSql)).to.deep.equal([
				{ id: 1, mn: 'PT30M' },
				{ id: 2, mn: 'PT30M' },
				{ id: 3, mn: 'PT1H' },
				{ id: 4, mn: 'PT0S' },
				{ id: 5, mn: 'PT0S' },
			]);
			// Text order would give mx='PT30M' at id=1.
			expect(await bothShapes(slidingMaxSql)).to.deep.equal([
				{ id: 1, mx: 'PT1H' },
				{ id: 2, mx: 'PT2H' },
				{ id: 3, mx: 'P1D' },
				{ id: 4, mx: 'P1D' },
				{ id: 5, mx: 'P1D' },
			]);
		});

		it('a sliding frame over mixed storage classes picks the numeric minimum', async () => {
			// Every frame here contains the number 5 and at least one string, so the
			// raw-`<` version returned whichever value happened to arrive first.
			expect(await bothShapes(
				'select id, min(v) over (order by id rows between 1 preceding and 1 following) as mn from anyv order by id'
			)).to.deep.equal([
				{ id: 1, mn: 5 },
				{ id: 2, mn: 5 },
				{ id: 3, mn: 5 },
			]);
		});

		it('a sliding JSON frame ranks structurally', async () => {
			expect(await bothShapes(
				'select id, min(d) over (order by id rows between 1 preceding and 1 following) as mn from js order by id'
			)).to.deep.equal([
				{ id: 1, mn: [8, 1] },
				{ id: 2, mn: [8, 1] },
				{ id: 3, mn: [9] },
			]);
		});

		it('a running NOCASE frame tightens case-insensitively', async () => {
			expect(await bothShapes(
				'select id, min(t) over (order by id rows unbounded preceding) as mn from nc order by id'
			)).to.deep.equal([
				{ id: 1, mn: 'B' },
				{ id: 2, mn: 'a' },
				{ id: 3, mn: 'a' },
			]);
		});
	});
});
