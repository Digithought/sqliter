import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { allRows } from './_helpers.js';

/**
 * One-sided sliding window frames — `n PRECEDING AND CURRENT ROW`,
 * `CURRENT ROW AND m FOLLOWING`, `CURRENT ROW AND CURRENT ROW`, and the
 * start-only spelling `ROWS n PRECEDING` — must take the same streaming
 * one-pass plan the two-sided `n PRECEDING AND m FOLLOWING` form already takes.
 * `CURRENT ROW` is the offset-zero case of the bound it replaces.
 *
 * Two things are locked here:
 *
 *  1. **The rule really fires**, asserted off the WindowNode's `streaming`
 *     property (and its per-function mode kinds), not assumed.
 *  2. **Both physical shapes agree.** Every query runs on a normal database and
 *     on one with `monotonic-window` disabled — the streaming emitter and the
 *     buffered frame walk must return deep-equal rows, so the new recognition
 *     cannot silently change answers.
 */
describe('Window one-sided sliding frames', () => {
	async function makeDb(disableStreaming: boolean): Promise<Database> {
		const db = new Database();
		if (disableStreaming) {
			const prev = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...prev,
				disabledRules: new Set([...(prev.disabledRules ?? []), 'monotonic-window']),
			});
		}
		// Ordered by the PK, which is what advertises monotonicOn(id).
		await db.exec('create table s (id integer primary key, v integer)');
		await db.exec('insert into s values (1,10),(2,20),(3,30),(4,40),(5,50)');
		// A non-unique indexed key, so RANGE frames see real peer ties. The index
		// on `k` is what advertises monotonicOn(k) for `order by k`.
		await db.exec('create table r (id integer primary key, k integer, v integer)');
		await db.exec('create index r_k on r (k)');
		await db.exec('insert into r values (1,10,1),(2,10,2),(3,20,4),(4,25,8),(5,40,16)');
		// Nullable value column, to exercise an all-NULL one-sided frame.
		await db.exec('create table sn (id integer primary key, v integer null)');
		await db.exec('insert into sn values (1,10),(2,null),(3,null),(4,40)');
		// A TEXT ordering key, indexed so `order by kt` would otherwise stream. A
		// numeric RANGE offset is not defined against it, and the two emitters do
		// not agree there — the rule must leave these buffered.
		await db.exec('create table rtext (id integer primary key, kt text, v integer)');
		await db.exec('create index rtext_kt on rtext (kt)');
		await db.exec("insert into rtext values (1,'a',1),(2,'a',2),(3,'b',4),(4,'c',8)");
		// Partitioned fixture.
		await db.exec('create table p (id integer primary key, g text, v integer)');
		await db.exec("insert into p values (1,'A',10),(2,'A',20),(3,'A',30),(4,'B',40),(5,'B',50)");
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

	/** Per-function streaming mode kinds for every WindowNode in the plan, in plan order. */
	async function windowModes(db: Database, sql: string): Promise<(string[] | null)[]> {
		const out: (string[] | null)[] = [];
		for await (const row of db.eval('select op, properties from query_plan(?)', [sql])) {
			const r = row as { op: string; properties: string | null };
			if (r.op !== 'WINDOW') continue;
			const props = r.properties ? JSON.parse(r.properties) as { streaming?: { modes: string[] } } : {};
			out.push(props.streaming ? props.streaming.modes : null);
		}
		return out;
	}

	/**
	 * Run `sql` on both databases, assert they agree, and return the shared
	 * result for the caller's value assertions.
	 */
	async function bothShapes(sql: string): Promise<unknown[]> {
		const streamed = await allRows(streamingDb, sql);
		const buffered = await allRows(bufferedDb, sql);
		expect(streamed, `streaming vs buffered disagree for: ${sql}`).to.deep.equal(buffered);
		return streamed;
	}

	/**
	 * Assert the plan's WindowNodes stream with exactly `modes` (one entry per
	 * node — functions sharing a window spec still land in separate nodes), and
	 * that disabling the rule drops all of them to the buffered path.
	 */
	async function expectStreamingModes(sql: string, modes: string[][]): Promise<void> {
		expect(await windowModes(streamingDb, sql), `streaming modes for: ${sql}`)
			.to.deep.equal(modes);
		expect(await windowModes(bufferedDb, sql), `rule disabled ⇒ buffered for: ${sql}`)
			.to.deep.equal(modes.map(() => null));
	}

	describe('ROWS mode', () => {
		it('n PRECEDING AND CURRENT ROW streams as a trailing window', async () => {
			const sql = 'select id, sum(v) over (order by id rows between 2 preceding and current row) as s'
				+ ' from s order by id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, s: 10 },
				{ id: 2, s: 30 },
				{ id: 3, s: 60 },
				{ id: 4, s: 90 },
				{ id: 5, s: 120 },
			]);
		});

		it('the start-only spelling ROWS n PRECEDING means the same frame', async () => {
			const sql = 'select id, sum(v) over (order by id rows 2 preceding) as s from s order by id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, s: 10 },
				{ id: 2, s: 30 },
				{ id: 3, s: 60 },
				{ id: 4, s: 90 },
				{ id: 5, s: 120 },
			]);
		});

		it('CURRENT ROW AND m FOLLOWING streams as a leading window', async () => {
			const sql = 'select id, sum(v) over (order by id rows between current row and 2 following) as s'
				+ ' from s order by id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, s: 60 },
				{ id: 2, s: 90 },
				{ id: 3, s: 120 },
				{ id: 4, s: 90 },
				{ id: 5, s: 50 },
			]);
		});

		it('CURRENT ROW AND CURRENT ROW is the single current row', async () => {
			const sql = 'select id, sum(v) over (order by id rows between current row and current row) as s'
				+ ' from s order by id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, s: 10 },
				{ id: 2, s: 20 },
				{ id: 3, s: 30 },
				{ id: 4, s: 40 },
				{ id: 5, s: 50 },
			]);
		});

		it('a trailing MIN/MAX/AVG/COUNT window agrees with the buffered walk', async () => {
			const sql = 'select id,'
				+ ' min(v) over (order by id rows between 1 preceding and current row) as mn,'
				+ ' max(v) over (order by id rows between 1 preceding and current row) as mx,'
				+ ' avg(v) over (order by id rows between 1 preceding and current row) as a,'
				+ ' count(v) over (order by id rows between 1 preceding and current row) as c'
				+ ' from s order by id';
			await expectStreamingModes(sql, [['slidingAgg'], ['slidingAgg'], ['slidingAgg'], ['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, mn: 10, mx: 10, a: 10, c: 1 },
				{ id: 2, mn: 10, mx: 20, a: 15, c: 2 },
				{ id: 3, mn: 20, mx: 30, a: 25, c: 2 },
				{ id: 4, mn: 30, mx: 40, a: 35, c: 2 },
				{ id: 5, mn: 40, mx: 50, a: 45, c: 2 },
			]);
		});

		it('FIRST_VALUE / LAST_VALUE stream under one-sided frames', async () => {
			const sql = 'select id,'
				+ ' first_value(v) over (order by id rows between 2 preceding and current row) as fv,'
				+ ' last_value(v) over (order by id rows between current row and 2 following) as lv'
				+ ' from s order by id';
			expect(await windowModes(streamingDb, sql)).to.deep.equal([['slidingAgg'], ['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, fv: 10, lv: 30 },
				{ id: 2, fv: 10, lv: 40 },
				{ id: 3, fv: 10, lv: 50 },
				{ id: 4, fv: 20, lv: 50 },
				{ id: 5, fv: 30, lv: 50 },
			]);
		});

		it('an all-NULL one-sided frame yields NULL, not the empty accumulator', async () => {
			const sql = 'select id,'
				+ ' min(v) over (order by id rows between 1 preceding and current row) as mn,'
				+ ' sum(v) over (order by id rows between 1 preceding and current row) as s'
				+ ' from sn order by id';
			await expectStreamingModes(sql, [['slidingAgg'], ['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, mn: 10, s: 10 },
				{ id: 2, mn: 10, s: 10 },
				{ id: 3, mn: null, s: null },
				{ id: 4, mn: 40, s: 40 },
			]);
		});
	});

	describe('RANGE mode with peer ties', () => {
		// k = 10, 10, 20, 25, 40 — the two k=10 rows are peers, so `CURRENT ROW`
		// must cover both of them at either edge of the frame.
		it('n PRECEDING AND CURRENT ROW covers the whole trailing peer group', async () => {
			const sql = 'select k, sum(v) over (order by k range between 10 preceding and current row) as s'
				+ ' from r order by k, id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ k: 10, s: 3 },   // [0,10] → both k=10 rows
				{ k: 10, s: 3 },
				{ k: 20, s: 7 },   // [10,20] → 1+2+4
				{ k: 25, s: 12 },  // [15,25] → 4+8
				{ k: 40, s: 16 },  // [30,40] → 16
			]);
		});

		it('CURRENT ROW AND m FOLLOWING covers the whole leading peer group', async () => {
			const sql = 'select k, sum(v) over (order by k range between current row and 10 following) as s'
				+ ' from r order by k, id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ k: 10, s: 7 },   // [10,20] → 1+2+4
				{ k: 10, s: 7 },
				{ k: 20, s: 12 },  // [20,30] → 4+8
				{ k: 25, s: 8 },   // [25,35] → 8
				{ k: 40, s: 16 },  // [40,50] → 16
			]);
		});

		it('CURRENT ROW AND CURRENT ROW is exactly the peer group', async () => {
			const sql = 'select k,'
				+ ' sum(v) over (order by k range between current row and current row) as s,'
				+ ' count(*) over (order by k range between current row and current row) as c'
				+ ' from r order by k, id';
			await expectStreamingModes(sql, [['slidingAgg'], ['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ k: 10, s: 3, c: 2 },
				{ k: 10, s: 3, c: 2 },
				{ k: 20, s: 4, c: 1 },
				{ k: 25, s: 8, c: 1 },
				{ k: 40, s: 16, c: 1 },
			]);
		});

		it('a non-numeric ORDER BY key keeps every RANGE sliding frame buffered', async () => {
			// The streaming range scan does its bound arithmetic in `Number` space;
			// the buffered walk falls back to peer-group scanning for a value that
			// isn't numeric. They disagree, so the rule must not fire — including
			// for the one-sided shapes, whose peer-group reading is otherwise the
			// one that looks most obviously safe.
			for (const bounds of [
				'between 1 preceding and 1 following',
				'between 1 preceding and current row',
				'between current row and 1 following',
				'between current row and current row',
			]) {
				const sql = `select id, count(*) over (order by kt range ${bounds}) as c`
					+ ' from rtext order by kt, id';
				expect(await windowModes(streamingDb, sql), sql).to.deep.equal([null]);
				await bothShapes(sql);
			}
		});

		it('the start-only spelling RANGE n PRECEDING means the same frame', async () => {
			const sql = 'select k, min(v) over (order by k range 10 preceding) as mn from r order by k, id';
			await expectStreamingModes(sql, [['slidingAgg']]);
			expect(await bothShapes(sql)).to.deep.equal([
				{ k: 10, mn: 1 },
				{ k: 10, mn: 1 },
				{ k: 20, mn: 1 },
				{ k: 25, mn: 4 },
				{ k: 40, mn: 16 },
			]);
		});
	});

	describe('interaction with the default frame', () => {
		it('UNBOUNDED PRECEDING AND CURRENT ROW keeps the running-accumulator path', async () => {
			// The cheap path, not the sliding buffer — this is the shape the new
			// CURRENT-ROW recognition could most easily have stolen.
			for (const sql of [
				'select id, sum(v) over (order by id) as s from s order by id',
				'select id, sum(v) over (order by id rows unbounded preceding) as s from s order by id',
				'select id, sum(v) over (order by id rows between unbounded preceding and current row) as s from s order by id',
				'select id, sum(v) over (order by id range between unbounded preceding and current row) as s from s order by id',
			]) {
				await expectStreamingModes(sql, [['runningAgg']]);
				expect(await bothShapes(sql), sql).to.deep.equal([
					{ id: 1, s: 10 },
					{ id: 2, s: 30 },
					{ id: 3, s: 60 },
					{ id: 4, s: 100 },
					{ id: 5, s: 150 },
				]);
			}
		});

		it('a one-sided frame and a default frame in one query each get their own path', async () => {
			// Distinct frames land in distinct WindowNodes; both must stream, the
			// default one as a running accumulator and the one-sided one as a
			// sliding buffer.
			const sql = 'select id,'
				+ ' sum(v) over (order by id rows between 1 preceding and current row) as trailing,'
				+ ' sum(v) over (order by id) as running,'
				+ ' row_number() over (order by id) as rn'
				+ ' from s order by id';
			const modes = await windowModes(streamingDb, sql);
			expect(modes.filter(m => m !== null).flat().sort()).to.deep.equal(
				['runningAgg', 'rowNumber', 'slidingAgg'].sort());
			expect(modes.some(m => m === null), 'every WindowNode streams').to.be.false;
			expect(await bothShapes(sql)).to.deep.equal([
				{ id: 1, trailing: 10, running: 10, rn: 1 },
				{ id: 2, trailing: 30, running: 30, rn: 2 },
				{ id: 3, trailing: 50, running: 60, rn: 3 },
				{ id: 4, trailing: 70, running: 100, rn: 4 },
				{ id: 5, trailing: 90, running: 150, rn: 5 },
			]);
		});
	});

	describe('PARTITION BY', () => {
		// No streaming assertion here on purpose: a partitioned window cannot take
		// the streaming path today regardless of frame shape, because a table access
		// advertises `monotonicOn` for only its leading unbound index column — so the
		// rule never sees monotonicOn on the ORDER BY key that follows the partition
		// keys. See the NOTE in rule-monotonic-window.ts. These cases therefore lock
		// the one-sided frame's per-partition semantics on the buffered walk, and will
		// keep locking them if the partitioned case ever starts streaming.
		it('a one-sided frame restarts at each partition boundary', async () => {
			expect(await bothShapes(
				'select id, sum(v) over (partition by g order by id rows between 1 preceding and current row) as s'
				+ ' from p order by id'
			)).to.deep.equal([
				{ id: 1, s: 10 },
				{ id: 2, s: 30 },
				{ id: 3, s: 50 },
				{ id: 4, s: 40 },
				{ id: 5, s: 90 },
			]);
			expect(await bothShapes(
				'select id, sum(v) over (partition by g order by id rows between current row and 1 following) as s'
				+ ' from p order by id'
			)).to.deep.equal([
				{ id: 1, s: 30 },
				{ id: 2, s: 50 },
				{ id: 3, s: 30 },
				{ id: 4, s: 90 },
				{ id: 5, s: 50 },
			]);
		});
	});

	describe('shapes that must stay buffered', () => {
		// An UNBOUNDED bound on either side of a sliding frame has no bounded
		// buffer, and a start bound of `n FOLLOWING` is not an offset the
		// sliding state machine understands — all still out of scope.
		const buffered = [
			'select id, sum(v) over (order by id rows between current row and unbounded following) as s from s order by id',
			'select id, sum(v) over (order by id rows between unbounded preceding and 1 following) as s from s order by id',
			'select id, sum(v) over (order by id rows between 1 following and 3 following) as s from s order by id',
			'select id, sum(distinct v) over (order by id rows between 1 preceding and current row) as s from s order by id',
		];

		it('unbounded bounds, a FOLLOWING start, and DISTINCT do not stream', async () => {
			for (const sql of buffered) {
				expect(await windowModes(streamingDb, sql), sql).to.deep.equal([null]);
				expect(await bothShapes(sql), sql).to.deep.equal(await allRows(bufferedDb, sql));
			}
		});
	});
});
