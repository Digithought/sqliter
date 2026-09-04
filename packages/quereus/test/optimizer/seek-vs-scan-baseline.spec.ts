/**
 * The seek-versus-scan baseline in `rule-grow-retrieve`'s index-style fallback.
 *
 * When a predicate can be pushed into a module's index, `fallbackIndexSupports` compares
 * the module's quoted seek cost against a whole-table baseline and pushes down only if the
 * seek wins. Both numbers have to be priced against ONE table size. They were not: the
 * seek came from the module (which may keep a live row count) while the baseline came from
 * the engine's `seqScanCost(request.estimatedRows ?? 1000)` over the CATALOG's count —
 * `undefined` when nobody ran `ANALYZE`, and a stale `0` when `ANALYZE` ran before the
 * table was filled.
 *
 * Where the two disagreed the honest seek lost to a made-up scan, the grow was declined,
 * and `selectPhysicalNode` re-attached the predicate as a `Filter` ABOVE the seek that had
 * already bounded the rows — every row drained and re-tested for nothing. The fix asks the
 * same module for the baseline, so the comparison cannot read two different table sizes.
 *
 * Two arms, and a size-only test would miss the second:
 *
 *  - **never analyzed** — the request carries `undefined`, the baseline was priced at a
 *    fixed 1000, and the seek lost on any table bigger than the break-even (~7000 rows for
 *    this backend's range arm);
 *  - **analyzed while empty, then grown** — the request carries a measured `0`, so
 *    `seqScanCost(0)` = 0.1 and the seek loses at EVERY table size, 1000 included.
 *
 * The double below is the engine-side equivalent of `quereus-store`'s
 * `sizeRequestFromLiveCount` (`packages/quereus-store/src/common/store-module.ts`), which
 * substitutes the store's live count for an unknown request size and overrides a stale `0`
 * the same way. No rows are inserted and nothing is read — this is a planning-only test.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';

/**
 * A memory backend that knows its own size, the way a real storage backend does.
 *
 * `MemoryTableModule` itself substitutes a flat 1000 for an unknown request size
 * (`feat-memory-backend-sizes-itself` is what would change that), so it cannot show this
 * defect on its own. This subclass substitutes a configurable live count instead.
 */
class SelfSizingMemoryModule extends MemoryTableModule {
	/** What this backend believes the table really holds. */
	liveRows = 10000;

	/**
	 * Also override a measured-but-stale `0`. `quereus-store` does exactly this in its
	 * `staleEmptySnapshot` branch: a catalog count of 0 alongside a non-empty live count
	 * means `ANALYZE` ran before the rows landed, and the live count is the truth.
	 */
	overrideStaleZero = false;

	/** Every request this module was handed, in order. */
	readonly requests: BestAccessPlanRequest[] = [];

	/** `request.estimatedRows` as it arrived, per call, in order. */
	get asked(): Array<number | undefined> {
		return this.requests.map(r => r.estimatedRows);
	}

	/**
	 * Multiplier applied to the cost of a plan that claimed a filter, so the module prices
	 * its own seek above its own filter-free baseline. `1` leaves the module honest; a
	 * large value is how the veto's decline path is reached.
	 */
	seekCostMultiplier = 1;

	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		this.requests.push(request);
		const catalogIsWrong = request.estimatedRows === undefined
			|| (this.overrideStaleZero && request.estimatedRows === 0);
		const sized = catalogIsWrong ? { ...request, estimatedRows: this.liveRows } : request;
		const plan = super.getBestAccessPlan(db, tableInfo, sized);
		if (this.seekCostMultiplier === 1 || !plan.handledFilters.some(Boolean)) return plan;
		return { ...plan, cost: plan.cost * this.seekCostMultiplier };
	}
}

/** The `op` column of `query_plan(sql)`, in plan order. */
async function planOps(db: Database, sql: string): Promise<string[]> {
	const ops: string[] = [];
	for await (const row of db.eval('select op from query_plan(?)', [sql])) {
		ops.push(String((row as unknown as { op: unknown }).op));
	}
	return ops;
}

describe('seek-versus-scan baseline is quoted by the module', () => {
	let db: Database;
	let mod: SelfSizingMemoryModule;

	beforeEach(() => {
		db = new Database();
		mod = new SelfSizingMemoryModule();
		db.registerModule('selfsizing', mod);
	});

	afterEach(async () => {
		await db.close();
	});

	const createTable = (name = 't'): Promise<void> =>
		db.exec(`create table ${name} (id integer primary key, val integer) using selfsizing`);

	/** The bug's signature: a residual `Filter` sitting on top of the seek it duplicates. */
	const expectBareSeek = (ops: string[], why: string): void => {
		expect(ops, `${why}: expected an index seek, got ${ops.join(' | ')}`).to.include('INDEXSEEK');
		expect(ops, `${why}: the pushed-down predicate is enforced a second time above the seek`)
			.to.not.include('FILTER');
	};

	describe('a never-analyzed table the module can size itself', () => {
		// The engine-side break-even for this backend's range arm sits between 7000 and 8000
		// rows against the old fixed-1000 baseline. Straddle it deliberately: one size below,
		// several well above, so a future change to a cost constant cannot slide the flip
		// past the parameters and leave this test passing for the wrong reason.
		for (const liveRows of [1000, 8000, 10000, 50000]) {
			it(`pushes the predicate into the seek at ${liveRows} live rows`, async () => {
				mod.liveRows = liveRows;
				await createTable();

				expectBareSeek(await planOps(db, 'select * from t where id < 500'), `${liveRows} live rows`);
			});
		}
	});

	describe('a table ANALYZEd while empty, then grown', () => {
		// This arm fails at EVERY size, not only above a break-even: the catalog's measured
		// `0` made the engine-side baseline `seqScanCost(0)` = 0.1, which no honest seek cost
		// can beat. A size-only parameterization misses it entirely.
		for (const liveRows of [1000, 10000]) {
			it(`still seeks with a stale measured 0 against ${liveRows} live rows`, async () => {
				mod.liveRows = liveRows;
				mod.overrideStaleZero = true;
				await createTable();
				await db.exec('analyze t');

				const ops = await planOps(db, 'select * from t where id < 500');
				expectBareSeek(ops, `stale 0 vs ${liveRows} live rows`);
			});
		}

		it('sends the stale 0 the planner measured, so the module is the one that corrects it', async () => {
			// Guards the premise of the arm above: if `analyze` on an empty table ever stopped
			// producing a measured `0` in the request, those tests would pass without ever
			// exercising the stale-measurement path.
			mod.overrideStaleZero = false;
			await createTable('e');
			await db.exec('analyze e');
			mod.requests.length = 0;

			await planOps(db, 'select * from e where id < 500');

			expect(mod.asked, 'the planner asked about the analyzed-empty table').to.not.be.empty;
			for (const seen of mod.asked) {
				expect(seen, 'a measured 0 must arrive as 0, not as unknown').to.equal(0);
			}
		});
	});

	describe('the baseline is a second probe of the same module', () => {
		// The cost-outcome tests above prove the veto now reaches the right verdict; these
		// pin HOW, so a refactor that left `filters` or `requiredOrdering` on the baseline
		// probe — or fetched one where it is never read — fails here rather than silently.
		const isBaselineProbe = (r: BestAccessPlanRequest): boolean =>
			r.filters.length === 0 && r.requiredOrdering === undefined
			&& r.limit === undefined && r.offset === undefined;

		it('asks the module for a filter-free whole-table price, sized like the seek', async () => {
			await createTable();
			mod.requests.length = 0;

			expectBareSeek(await planOps(db, 'select * from t where id < 500'), 'baseline probe');

			const seek = mod.requests.filter(r => r.filters.length > 0);
			const baseline = mod.requests.filter(isBaselineProbe);
			expect(seek, 'the seek probe carries the pushed-down constraint').to.have.lengthOf(1);
			expect(baseline, 'the baseline is quoted by the module, not modelled by the engine')
				.to.have.lengthOf(1);
			expect(baseline[0].estimatedRows, 'both sides of the comparison are sized identically')
				.to.equal(seek[0].estimatedRows);
		});

		it('does not pay for a baseline when the plan provides the required ordering', async () => {
			// The veto only fires on `!providesOrdering`, so the probe lives inside that
			// branch. If a future change ever makes the veto apply to an ordering-providing
			// plan too, the probe has to move back out — and this test is what says so.
			await createTable();
			mod.requests.length = 0;

			const ops = await planOps(db, 'select * from t order by id');
			expect(ops, `expected the ordering to be absorbed, got ${ops.join(' | ')}`)
				.to.not.include('SORT');
			expect(mod.requests.filter(isBaselineProbe),
				'an ordering-providing plan reads no baseline, so none should be fetched')
				.to.be.empty;
		});
	});

	describe('the veto still fires', () => {
		it('declines the push-down when the module prices its seek above its own scan', async () => {
			// The decline path of `accessPlan.cost >= seqCost`, which the arms above only ever
			// drive to `accept`. The module answers the filtered probe with a cost it cannot
			// justify against the filter-free baseline IT quoted, so quoting the baseline
			// through the module must not have turned the comparison into a rubber stamp.
			mod.liveRows = 10000;
			mod.seekCostMultiplier = 1000;
			await createTable();

			const ops = await planOps(db, 'select * from t where id < 500');
			expect(ops, `expected the grow to decline, got ${ops.join(' | ')}`).to.include('FILTER');

			// KNOWN WRONG, pinned deliberately. Declining here does NOT produce the sequential
			// scan the veto believes it is choosing: `rule-predicate-pushdown` then pushes the
			// same predicate into the now-context-free Retrieve and `ruleSelectAccessPath`
			// rebuilds the very same seek, with the absorbed Filter re-stacked on top — so the
			// veto's decline is strictly worse than the push-down it refused. Tracked as
			// `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter`; when that
			// lands, this expectation flips to `.to.not.include('INDEXSEEK')`.
			expect(ops, 'pins the pathological decline shape until the tracked bug is fixed')
				.to.include('INDEXSEEK');
		});

		it('leaves a non-sargable predicate above the access node', async () => {
			// Nothing to push down: no constraint is extractable from the predicate, so the
			// grow declines for want of a benefit and the Filter belongs where it is. Pins
			// that quoting the baseline through the module did not turn the veto into a
			// rubber stamp.
			await createTable();

			const ops = await planOps(db, 'select * from t where val + id < 500');
			expect(ops, `expected the predicate to stay above the scan, got ${ops.join(' | ')}`)
				.to.include('FILTER');
		});
	});
});
