import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	maintenanceCost,
	selectMaintenanceStrategy,
	isFullRebuildPathological,
	shouldDegradeToRebuild,
	MAINTENANCE_REBUILD_ROW_THRESHOLD,
	type MaintenanceSourceStats,
} from '../../src/planner/cost/index.js';

/**
 * Unit + integration coverage for the backward (maintenance-direction) cost gate
 * (`incremental-maintenance-cost-gate`). The pure cost functions are exercised directly;
 * the create-time gate is exercised through a real `create materialized view` and the
 * stored `MaintenancePlan` record.
 *
 * Floor numbers are derived from `COST_CONSTANTS` in `planner/cost/index.ts`
 * (INDEX_SEEK_PER_ROW=0.3, PROJECT_PER_ROW=0.1, SEQ_SCAN_PER_ROW=1.0, FILTER_PER_ROW=0.2)
 * so they track the model if those constants change.
 */

const INVERSE_PER_ROW = 0.3 + 0.1; // INDEX_SEEK_PER_ROW + PROJECT_PER_ROW
const RESIDUAL_PER_GROUP_ROW = 1.0 + 0.2 + 0.1; // SEQ_SCAN + FILTER + PROJECT

describe('maintenanceCost — per-arm formulas', () => {
	const withStats: MaintenanceSourceStats = {
		tableRows: 1000,
		distinctGroupsEstimate: 10,
		forwardBodyCost: 250,
		fallbackRatio: 0.5,
	};

	it("'inverse-projection' is O(1) per changed row and ignores body cost", () => {
		expect(maintenanceCost('inverse-projection', 7, withStats)).to.equal(7 * INVERSE_PER_ROW);
		// Independent of forwardBodyCost.
		expect(maintenanceCost('inverse-projection', 7, { ...withStats, forwardBodyCost: 1e9 }))
			.to.equal(7 * INVERSE_PER_ROW);
	});

	it("'full-rebuild' is the body cost, independent of changeCardinality", () => {
		expect(maintenanceCost('full-rebuild', 1, withStats)).to.equal(250);
		expect(maintenanceCost('full-rebuild', 10_000, withStats)).to.equal(250);
	});

	it("'residual-recompute' with stats costs against rows-per-group", () => {
		// rowsPerGroup = tableRows / distinctGroups = 1000 / 10 = 100.
		const expected = 3 * (100 * RESIDUAL_PER_GROUP_ROW);
		expect(maintenanceCost('residual-recompute', 3, withStats)).to.equal(expected);
	});

	it("'residual-recompute' with NO stats reproduces the deltaPerRowFallbackRatio heuristic", () => {
		const noStats: MaintenanceSourceStats = { tableRows: 1000, forwardBodyCost: 100, fallbackRatio: 0.5 };
		// Parity: cc × forwardBodyCost × ratio — the legacy ratio behaviour, byte-for-byte.
		expect(maintenanceCost('residual-recompute', 4, noStats)).to.equal(4 * 100 * 0.5);
		// Absent fallbackRatio defaults to 0.5 (kept equal to DEFAULT_TUNING).
		expect(maintenanceCost('residual-recompute', 4, { tableRows: 1000, forwardBodyCost: 100 }))
			.to.equal(4 * 100 * 0.5);
	});
});

describe('selectMaintenanceStrategy — argmin over sound strategies', () => {
	it('picks inverse-projection for the covering shape (always cheapest)', () => {
		const stats: MaintenanceSourceStats = { tableRows: 1000, forwardBodyCost: 1200, fallbackRatio: 0.5 };
		expect(selectMaintenanceStrategy(['inverse-projection', 'full-rebuild'], 10, stats))
			.to.equal('inverse-projection');
	});

	it('picks full-rebuild when residual-recompute is the cheaper sound alternative crosses over', () => {
		// No-stats residual = cc × forwardBodyCost × 0.5. At cc=10 that is 500 > rebuild 100.
		const stats: MaintenanceSourceStats = { tableRows: 1000, forwardBodyCost: 100, fallbackRatio: 0.5 };
		expect(selectMaintenanceStrategy(['residual-recompute', 'full-rebuild'], 10, stats))
			.to.equal('full-rebuild');
		// At cc=1 residual (50) beats rebuild (100).
		expect(selectMaintenanceStrategy(['residual-recompute', 'full-rebuild'], 1, stats))
			.to.equal('residual-recompute');
	});

	it('resolves an empty sound set to the full-rebuild floor', () => {
		const stats: MaintenanceSourceStats = { tableRows: 1, forwardBodyCost: 1 };
		expect(selectMaintenanceStrategy([], 1, stats)).to.equal('full-rebuild');
	});
});

describe('isFullRebuildPathological — synchronous reject-at-create gate', () => {
	const T = MAINTENANCE_REBUILD_ROW_THRESHOLD;
	it('is true only when the source is large AND the body costs more than a full scan', () => {
		const big = T * 2;
		// Body more expensive than a full scan of a large source → pathological.
		expect(isFullRebuildPathological({ tableRows: big, forwardBodyCost: big * 1.5 }, T)).to.equal(true);
		// Large source but cheap body (≤ scan) → not pathological.
		expect(isFullRebuildPathological({ tableRows: big, forwardBodyCost: big * 0.5 }, T)).to.equal(false);
		// Small source → never pathological, even with an expensive body.
		expect(isFullRebuildPathological({ tableRows: 1000, forwardBodyCost: 1e9 }, T)).to.equal(false);
	});

	it('a threshold of 0 disables the size reject (accept any size)', () => {
		const huge = T * 1000;
		expect(isFullRebuildPathological({ tableRows: huge, forwardBodyCost: huge * 10 }, 0)).to.equal(false);
	});

	it('honors a custom (lowered) threshold', () => {
		// A source of 5 rows is pathological under a threshold of 2 (body > a full scan).
		expect(isFullRebuildPathological({ tableRows: 5, forwardBodyCost: 100 }, 2)).to.equal(true);
		// …but not under a threshold of 10.
		expect(isFullRebuildPathological({ tableRows: 5, forwardBodyCost: 100 }, 10)).to.equal(false);
	});
});

describe('shouldDegradeToRebuild — per-write runtime demotion (stateless)', () => {
	// No-stats path: residual = cc × forwardBodyCost × 0.5, rebuild = forwardBodyCost.
	// Crossover at cc = 2.
	const stats: MaintenanceSourceStats = { tableRows: 1000, forwardBodyCost: 100, fallbackRatio: 0.5 };

	it('does not degrade for low cardinality', () => {
		expect(shouldDegradeToRebuild(1, stats)).to.equal(false);
		expect(shouldDegradeToRebuild(2, stats)).to.equal(false);
	});

	it('degrades when a bulk statement crosses the crossover', () => {
		expect(shouldDegradeToRebuild(3, stats)).to.equal(true);
		expect(shouldDegradeToRebuild(1000, stats)).to.equal(true);
	});

	it('reverts on a subsequent low-cardinality statement (no retained state)', () => {
		expect(shouldDegradeToRebuild(1000, stats)).to.equal(true);
		expect(shouldDegradeToRebuild(1, stats)).to.equal(false);
	});
});

/** Read-only white-box reach into the manager's compiled plan map (key = lowercase
 *  `schema.name`), mirroring the stubbed-arm guard test in maintenance-equivalence.spec.ts. */
interface PlanRecord {
	readonly kind: string;
	readonly chosenStrategy: string;
	readonly sourceStats: MaintenanceSourceStats;
}
interface PlanMapHandle { readonly materializedViewManager: { readonly rowTime: Map<string, PlanRecord> }; }

describe('create-time gate — stored MaintenancePlan record', () => {
	it('annotates the covering-index MV with chosenStrategy=inverse-projection and its cost inputs', async () => {
		const db = new Database();
		try {
			await db.exec('create table src (id integer primary key, a integer)');
			await db.exec('create materialized view mv as select id, a from src');

			const plan = (db as unknown as PlanMapHandle).materializedViewManager.rowTime.get('main.mv');
			expect(plan, 'expected a registered plan').to.exist;
			expect(plan!.kind).to.equal('inverse-projection');
			// The cost gate ran and stored its choice + inputs.
			expect(plan!.chosenStrategy).to.equal('inverse-projection');
			// Base scan cost makes forwardBodyCost > 0 even for an empty source.
			expect(plan!.sourceStats.forwardBodyCost).to.be.greaterThan(0);
			// Empty source → 0 rows from the stats provider (a legitimate count).
			expect(plan!.sourceStats.tableRows).to.be.at.least(0);
			// deltaPerRowFallbackRatio threaded through for the no-stats residual path.
			expect(plan!.sourceStats.fallbackRatio).to.equal(0.5);
		} finally {
			await db.close();
		}
	});
});
