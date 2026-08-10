import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import { planRows, allRows, isDescendantOf } from './_helpers.js';

/**
 * Locks the asof-scan merge variant's `reactivate()` mitigation (the
 * child-shadows-operator direction of the "source-attr contexts and child pulls"
 * invariant — see docs/runtime.md). The merge scan advances its right cursor past
 * the matched row (consuming look-ahead rows), so the right scan's own slot holds
 * the cursor position, not `matched`. Before yielding, the asof emitter calls
 * `rightSlot.reactivate()` so a downstream Filter/Project that references the
 * right's columns resolves through the matched row, not the cursor's look-ahead.
 *
 * Without `reactivate()` the results are wrong (verified during implementation by
 * disabling the call: a non-strict desc match returned the look-ahead bid for
 * every left row). This guard pins both the merge plan shape (so the regression
 * stays exercised) and the matched-row correctness.
 */
describe('Plan shape: asof merge with a downstream filter on right-side columns', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// trades sorted by ts; quotes scanned by its (ts) PK ⇒ both co-ordered on
		// ts, so the asof rule can pick the merge strategy.
		await db.exec('CREATE TABLE trades (id INTEGER PRIMARY KEY, ts INTEGER) USING memory');
		await db.exec('CREATE TABLE quotes (ts INTEGER PRIMARY KEY, bid REAL) USING memory');
		await db.exec('INSERT INTO trades VALUES (1,100),(2,200),(3,300)');
		await db.exec('INSERT INTO quotes VALUES (50,1.0),(150,1.5),(250,2.5)');
		// Force the merge strategy regardless of cost estimates.
		db.optimizer.updateTuning({ ...DEFAULT_TUNING, asof: { mergeRowThreshold: 0 } });
	});

	afterEach(async () => { await db.close(); });

	const Q = `select t.id, q.bid from (select id, ts from trades order by ts) t left join lateral (
			select bid from quotes q where q.ts <= t.ts order by q.ts desc limit 1
		) q on true where q.bid > 1.2`;

	function asofProps(rows: { op: string; properties?: string | null }[]): { strategy?: string; direction?: string } | undefined {
		const r = rows.find(x => x.op === 'ASOFSCAN');
		if (!r) return undefined;
		// planRows does not project `properties`; callers that need it query directly.
		return r.properties ? JSON.parse(r.properties) as { strategy?: string; direction?: string } : undefined;
	}

	it('uses the merge strategy with a Filter on the right column above the AsofScan', async () => {
		const rows = await planRows(db, Q);
		const ops = rows.map(r => r.op);
		expect(ops, 'AsofScan node present').to.include('ASOFSCAN');
		expect(ops, 'right-column predicate stays a Filter above the AsofScan').to.include('FILTER');

		// Pull properties to confirm the merge strategy (the reactivate path).
		const propRows: { op: string; properties?: string | null }[] = [];
		for await (const r of db.eval('SELECT op, properties FROM query_plan(?)', [Q])) {
			propRows.push(r as { op: string; properties?: string | null });
		}
		const props = asofProps(propRows);
		expect(props, 'AsofScan properties present').to.not.equal(undefined);
		expect(props!.strategy, 'must exercise the merge variant (where reactivate lives)').to.equal('merge');

		const asofRow = rows.find(r => r.op === 'ASOFSCAN')!;
		const filterRow = rows.find(r => r.op === 'FILTER')!;
		expect(
			isDescendantOf(rows, asofRow.id, filterRow.id),
			'the Filter on q.bid must sit above the AsofScan (downstream resolution hazard)'
		).to.equal(true);
	});

	it('reads the matched right row, not the cursor look-ahead', async () => {
		// For each trade, the asof picks the latest quote with ts <= trade.ts:
		//   trade 1 (ts 100) → quote ts 50  bid 1.0  (filtered out: 1.0 !> 1.2)
		//   trade 2 (ts 200) → quote ts 150 bid 1.5  (kept)
		//   trade 3 (ts 300) → quote ts 250 bid 2.5  (kept)
		// A reactivate regression leaks the look-ahead cursor row, e.g. returning
		// bid 1.5 for trade 1 (wrongly kept) and shifting the rest.
		const res = await allRows<{ id: number; bid: number }>(db, Q + ' order by t.id');
		expect(res).to.deep.equal([
			{ id: 2, bid: 1.5 },
			{ id: 3, bid: 2.5 },
		]);
	});

	it('control: hash strategy (default tuning) materializes the right and stays correct', async () => {
		// Re-plan with default tuning ⇒ the right row estimate is below the default
		// mergeRowThreshold ⇒ hash strategy, which builds the right fully before
		// emit (no cross-pull interleave). Same answer, different (safe) path.
		db.optimizer.updateTuning(DEFAULT_TUNING);
		const propRows: { op: string; properties?: string | null }[] = [];
		for await (const r of db.eval('SELECT op, properties FROM query_plan(?)', [Q])) {
			propRows.push(r as { op: string; properties?: string | null });
		}
		expect(asofProps(propRows)?.strategy).to.equal('hash');

		const res = await allRows<{ id: number; bid: number }>(db, Q + ' order by t.id');
		expect(res).to.deep.equal([
			{ id: 2, bid: 1.5 },
			{ id: 3, bid: 2.5 },
		]);
	});
});
