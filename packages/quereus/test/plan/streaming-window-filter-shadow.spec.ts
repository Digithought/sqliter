import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows, planOps, allRows, isDescendantOf } from './_helpers.js';

/**
 * Locks the plan shape and correctness of the streaming-window cross-pull
 * context-shadow mitigation (see docs/runtime.md "source-attr contexts and child
 * pulls"). A streaming Window registers its own source-attribute context and wins
 * the attributeIndex for its own callbacks and at each yield; it must `demote()`
 * that context before pulling the next source row so a residual Filter directly
 * below it reads its *current* row, not the Window's last-yielded row.
 *
 * The data is ADVERSARIAL on purpose: adjacent rows straddle the filter threshold
 * (val > 50), so if the Window shadowed the Filter, the Filter would read the
 * previous row's `val` and the filtered set would be wrong. Monotone data (e.g.
 * 10,20,30,…) masks the bug — see the prior-art note in the ticket.
 *
 * The shape assertions (streaming Window, standalone Filter directly below, NO
 * interposed Sort) matter because a Sort would drain the child before the Window
 * runs, removing the interleaving and silently neutering the correctness guard.
 */
describe('Plan shape: streaming window over a residual-filtered ordered scan', () => {
	let db: Database;

	beforeEach(async () => {
		// PK on id ⇒ IndexScan is ordered by id, so ORDER BY id needs no Sort ⇒
		// streaming Window. The filter is on the non-key column `val`, which cannot
		// seek and is not part of the window ⇒ it stays a standalone Filter node
		// directly below the Window.
		db = new Database();
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER) USING memory');
		await db.exec('INSERT INTO t VALUES (1,100),(2,5),(3,100),(4,5),(5,100)');
	});

	afterEach(async () => { await db.close(); });

	async function windowProps(sql: string): Promise<{ streaming?: unknown } | undefined> {
		for await (const r of db.eval('SELECT op, properties FROM query_plan(?)', [sql])) {
			const rr = r as { op: string; properties: string | null };
			if (rr.op === 'WINDOW' && rr.properties) {
				return JSON.parse(rr.properties) as { streaming?: unknown };
			}
		}
		return undefined;
	}

	it('places a standalone Filter directly below a streaming Window (no Sort)', async () => {
		const q = 'SELECT id, val, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM t WHERE val > 50';
		const rows = await planRows(db, q);
		const ops = rows.map(r => r.op);

		expect(ops, 'a Window node should be present').to.include('WINDOW');
		expect(ops, 'residual val-predicate must remain a standalone Filter').to.include('FILTER');
		expect(ops, 'a Sort below the Window would drain the child and mask the bug').to.not.include('SORT');

		const props = await windowProps(q);
		expect(props, 'Window properties present').to.not.equal(undefined);
		expect(props!.streaming, 'Window must take the streaming path (the shadow hazard surface)').to.not.equal(undefined);

		const winRow = rows.find(r => r.op === 'WINDOW')!;
		const filterRow = rows.find(r => r.op === 'FILTER')!;
		expect(
			isDescendantOf(rows, filterRow.id, winRow.id),
			'the Filter must sit below the Window (the interleaving hazard)'
		).to.equal(true);
	});

	it('ROW_NUMBER over a straddling residual filter yields only matching rows, renumbered', async () => {
		// Correct: only val=100 rows (id 1,3,5) survive the filter; ROW_NUMBER is
		// assigned over the filtered stream ⇒ 1,2,3. A shadowing regression admits
		// id=2/4 (val=5) and/or drops later rows.
		const q = 'SELECT id, val, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM t WHERE val > 50 ORDER BY id';
		const res = await allRows<{ id: number; val: number; rn: number }>(db, q);
		expect(res).to.deep.equal([
			{ id: 1, val: 100, rn: 1 },
			{ id: 3, val: 100, rn: 2 },
			{ id: 5, val: 100, rn: 3 },
		]);
	});

	it('running SUM over a straddling residual filter accumulates only matching rows', async () => {
		const q = 'SELECT id, SUM(val) OVER (ORDER BY id) AS rt FROM t WHERE val > 50 ORDER BY id';
		const res = await allRows<{ id: number; rt: number }>(db, q);
		expect(res).to.deep.equal([
			{ id: 1, rt: 100 },
			{ id: 3, rt: 200 },
			{ id: 5, rt: 300 },
		]);
	});

	it('streaming Window feeding a downstream Window keeps the residual filter correct', async () => {
		// Stacked: a streaming inner Window (ROW_NUMBER) over the residual Filter,
		// feeding a (buffered) outer sliding-SUM Window. The intermediate Project
		// drops monotonicOn so the outer Window cannot also stream — but the inner
		// Window still streams and is the direct parent of the Filter, so the
		// cross-pull shadow hazard is live. This guards the implementer's flagged
		// "streaming Window feeds another Window" interaction in its producible
		// form; disabling demote() corrupts it exactly like the standalone case
		// (id=2/val=5 wrongly admitted).
		const q = `SELECT id, rn, SUM(val) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS sw
			FROM (SELECT id, val, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM t WHERE val > 50) ORDER BY id`;
		const ops = await planOps(db, q);
		// Two Window nodes, one of which streams (the inner ROW_NUMBER over Filter).
		expect(ops.filter(o => o === 'WINDOW').length, 'two stacked Window nodes').to.equal(2);
		expect(ops, 'residual Filter present below the streaming inner Window').to.include('FILTER');

		const res = await allRows<{ id: number; rn: number; sw: number }>(db, q);
		// Survivors id 1,3,5 (val=100); rn renumbered over the filtered stream;
		// sw = 1-preceding running sum over the same filtered stream.
		expect(res).to.deep.equal([
			{ id: 1, rn: 1, sw: 100 },
			{ id: 3, rn: 2, sw: 200 },
			{ id: 5, rn: 3, sw: 200 },
		]);
	});

	it('control: buffered Window (PARTITION BY non-key) drains the child and stays correct', async () => {
		// PARTITION BY val is not aligned with the (id) source ordering ⇒ buffered
		// path, which fully materializes before emit ⇒ no cross-pull interleave.
		const q = 'SELECT id, val, ROW_NUMBER() OVER (PARTITION BY val ORDER BY id) AS rn FROM t WHERE val > 50';
		const ops = await planOps(db, q);
		const props = await windowProps(q);
		expect(ops).to.include('WINDOW');
		// Buffered path: no streaming config (the partition key isn't source-ordered).
		expect(props?.streaming, 'PARTITION BY non-key column should not stream').to.equal(undefined);

		const res = await allRows<{ id: number; val: number; rn: number }>(
			db, q + ' ORDER BY id'
		);
		// All survivors share val=100 ⇒ one partition ⇒ rn 1,2,3.
		expect(res).to.deep.equal([
			{ id: 1, val: 100, rn: 1 },
			{ id: 3, val: 100, rn: 2 },
			{ id: 5, val: 100, rn: 3 },
		]);
	});
});
