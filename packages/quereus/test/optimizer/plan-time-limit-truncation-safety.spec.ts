/**
 * `BestAccessPlanRequest.limit` is a licence to stop early, not a hint, so the engine
 * sends it only when it can prove nothing between the module's scan and the LIMIT can
 * discard a row (`truncationIsSafe`, planner/rules/retrieve/rule-grow-retrieve.ts).
 *
 * The shipped memory module ignores `request.limit` outright, so on a stock table the
 * proof is invisible: right or wrong, the plan is identical. These cases therefore run
 * against a module that answers DIFFERENTLY depending on whether it was given a bound —
 * ordered and cheap with one, unordered and expensive without — which is the shape of
 * the backend that reported the bug (`feat-sort-absorb-blind-to-limit`, GitHub #31).
 * A `LIMITOFFSET` over the access leaf then means "the engine sent the bound", and its
 * absence means "the engine withheld it", with no need to inspect the request stream.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { LimitOffsetNode } from '../../src/planner/nodes/limit-offset.js';

/** How many of the request's filters the module claims, given the request. */
type ClaimPolicy = (request: BestAccessPlanRequest) => boolean[];

/**
 * A module whose ordered arm exists only under a plan-time bound.
 *
 * Without one it prices the ordered read of the whole table, loses to a scan, and
 * advertises no ordering at all — so a `Sort` cannot be absorbed and the min/max
 * boundary rewrite declines. With one it serves the requested ordering for next to
 * nothing. That asymmetry is the whole reason the bound has to reach the module, and it
 * makes the engine's truncation-safety decision visible in the plan.
 */
class LimitSensitiveModule extends MemoryTableModule {
	constructor(private readonly claim: ClaimPolicy) { super(); }

	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const base = super.getBestAccessPlan(db, tableInfo, request);
		const handledFilters = this.claim(request);
		const bounded = request.limit !== undefined && request.limit !== null;
		return bounded
			? { ...base, handledFilters, providesOrdering: request.requiredOrdering, rows: 1, cost: 1 }
			: { ...base, handledFilters, providesOrdering: undefined, rows: 1000, cost: 1e6 };
	}
}

const claimAll: ClaimPolicy = req => req.filters.map(() => true);
const claimNone: ClaimPolicy = req => req.filters.map(() => false);
/** Claim the FIRST constraint only — for a BETWEEN, one of its two bounds. */
const claimFirstOnly: ClaimPolicy = req => req.filters.map((_f, i) => i === 0);

function hasLimit(root: PlanNode): boolean {
	if (root instanceof LimitOffsetNode) return true;
	return root.getChildren().some(child => hasLimit(child as PlanNode));
}

describe('plan-time limit is sent only when truncation is provably safe', () => {
	let db: Database;

	const openWith = async (claim: ClaimPolicy): Promise<void> => {
		db = new Database();
		db.registerModule('limit_sensitive', new LimitSensitiveModule(claim));
		await db.exec('create table t (k integer primary key, b integer not null, c integer not null) using limit_sensitive');
		await db.exec('insert into t values (1, 1, 30), (2, 1, 10), (3, 2, 20)');
		await db.exec('create index ix_bc on t (b, c)');
	};

	afterEach(async () => {
		await db.close();
	});

	it('sends the bound when every conjunct below the Sort is claimed', async () => {
		await openWith(claimAll);
		expect(hasLimit(db.getPlan('select min(c) from t where b = 1')),
			'the boundary rewrite needs the module to serve the ordering, which needs the bound')
			.to.equal(true);
	});

	it('withholds it when a conjunct is left in the residual', async () => {
		await openWith(claimNone);
		// `b = 1` becomes a residual Filter above the access, and a Filter above a
		// truncated scan underproduces — `min(c)` over a scan stopped at one row the
		// filter then rejects would answer NULL.
		expect(hasLimit(db.getPlan('select min(c) from t where b = 1'))).to.equal(false);
	});

	it('withholds it when only PART of a multi-constraint expression is claimed', async () => {
		await openWith(claimFirstOnly);
		// A BETWEEN yields its `>=` and its `<=` from the same node, and the residual
		// assembly puts that node back the moment EITHER is unclaimed. Covering the
		// conjunct off the claimed half alone would license a truncation the surviving
		// Filter can still underproduce.
		expect(hasLimit(db.getPlan('select min(c) from t where b between 1 and 2'))).to.equal(false);
	});

	it('withholds it when the whole predicate is unextractable', async () => {
		await openWith(claimAll);
		// No constraint is extracted from `b + 0 = 1`, so it never appears in
		// `request.filters` and no claim can cover it — the Filter is invisible to the
		// residual assembly but not to the safety walk.
		expect(hasLimit(db.getPlan('select min(c) from t where b + 0 = 1'))).to.equal(false);
	});
});
