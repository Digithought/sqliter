/**
 * `IndexSeekNode.pushedConstraints` / `orderingLoadBearing` provenance.
 *
 * When a module claims a WHERE predicate (`handledFilters[i] === true`),
 * `rule-select-access-path` folds it into seek keys and the predicate stops
 * existing as a `Filter` anywhere in the tree — the seek's `FilterInfo` becomes
 * its only enforcer. `pushedConstraints` records WHICH planner-level constraints
 * that is, so a later rule that wants to replace the access method can re-apply
 * them (their `sourceExpression` carries the effective comparison collation, which
 * the encoded `FilterInfo.constraints` cannot express).
 *
 * These assertions inspect the plan node directly: neither field is exposed via
 * `getLogicalAttributes`, deliberately, so `test/plan/golden-plans.spec.ts` does
 * not churn.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import { IndexSeekNode, SeqScanNode } from '../../src/planner/nodes/table-access-nodes.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { SortNode } from '../../src/planner/nodes/sort.js';
import { BetweenNode, BinaryOpNode } from '../../src/planner/nodes/scalar.js';
import { InNode } from '../../src/planner/nodes/subquery.js';
import { combineResidualExpressions } from '../../src/planner/rules/access/rule-select-access-path.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import type { TableSchema } from '../../src/schema/table.js';

function collectNodes<T extends PlanNode>(
	root: PlanNode,
	predicate: (n: PlanNode) => n is T,
): T[] {
	const found: T[] = [];
	const walk = (n: PlanNode): void => {
		if (predicate(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(root);
	return found;
}

const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;
const isSeqScan = (n: PlanNode): n is SeqScanNode => n instanceof SeqScanNode;
const isFilter = (n: PlanNode): n is FilterNode => n instanceof FilterNode;
const isSort = (n: PlanNode): n is SortNode => n instanceof SortNode;

/** The single IndexSeek in a plan (asserts there is exactly one). */
function soleSeek(db: Database, sql: string): IndexSeekNode {
	const seeks = collectNodes(db.getPlan(sql), isIndexSeek);
	expect(seeks, `exactly one IndexSeek for: ${sql}`).to.have.lengthOf(1);
	return seeks[0];
}

/** The recorded constraints' distinct source expressions, in recorded order. */
function recordedSources(seek: IndexSeekNode): ScalarPlanNode[] {
	expect(seek.pushedConstraints, 'pushedConstraints stamped').to.not.equal(undefined);
	return seek.pushedConstraints!.map(c => c.sourceExpression);
}

/**
 * A memory module whose access plans deliberately omit the index identity, so
 * `selectPhysicalNode` falls to the legacy PK-heuristic arm. Everything else
 * (runtime, claimed filters, costs) is the stock memory module, so the legacy
 * seek still executes.
 */
class LegacyPlanMemoryModule extends MemoryTableModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const plan = super.getBestAccessPlan(db, tableInfo, request);
		const stripped = { ...plan };
		delete stripped.indexName;
		delete stripped.seekColumnIndexes;
		return stripped;
	}
}

describe('IndexSeek records the predicate its FilterInfo enforces', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (pk integer primary key, s text, n integer) using memory');
		await db.exec("insert into t values (1, 'a', 10), (2, 'b', 20), (3, 'x', 30), (5, 'x', 40), (9, 'z', 90)");
		await db.exec('create index idx_s on t(s)');
		await db.exec('create index idx_n on t(n)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('records the equality comparison behind a secondary-index seek', () => {
		const seek = soleSeek(db, "select pk from t where s = 'x'");
		expect(seek.indexName).to.equal('idx_s');
		expect(seek.pushedConstraints).to.have.lengthOf(1);

		const [source] = recordedSources(seek);
		expect(source).to.be.instanceOf(BinaryOpNode);
		expect((source as BinaryOpNode).expression.operator).to.equal('=');
		// Not a rebuilt copy — the exact node the extractor produced.
		expect(seek.pushedConstraints![0].op).to.equal('=');
		expect(combineResidualExpressions([...recordedSources(seek)])).to.equal(source);
	});

	it('records both BETWEEN bounds, which combine back to the single BetweenNode', () => {
		const seek = soleSeek(db, 'select pk from t where pk between 2 and 5');
		expect(seek.isRange, 'range seek').to.equal(true);
		expect(seek.pushedConstraints, 'BETWEEN yields a lower and an upper constraint').to.have.lengthOf(2);

		const sources = recordedSources(seek);
		expect(sources[0], 'both bounds share one source node').to.equal(sources[1]);
		expect(sources[0]).to.be.instanceOf(BetweenNode);

		// De-duplication by identity: the AND-combination is that one node, not
		// `BetweenNode AND BetweenNode`.
		const combined = combineResidualExpressions([...sources]);
		expect(combined).to.equal(sources[0]);
	});

	it('records the IN node behind a multi-seek', () => {
		const seek = soleSeek(db, 'select pk from t where pk in (1, 2, 3)');
		expect(seek.pushedConstraints).to.have.lengthOf(1);
		expect(seek.pushedConstraints![0].op).to.equal('IN');
		expect(recordedSources(seek)[0]).to.be.instanceOf(InNode);
	});

	it('records the whole OR expression behind an OR_RANGE multi-range seek', () => {
		const seek = soleSeek(db, 'select pk from t where n < 20 or n > 80');
		expect(seek.pushedConstraints, 'one OR_RANGE constraint carries every branch').to.have.lengthOf(1);
		expect(seek.pushedConstraints![0].op).to.equal('OR_RANGE');

		const [source] = recordedSources(seek);
		expect(source).to.be.instanceOf(BinaryOpNode);
		expect((source as BinaryOpNode).expression.operator).to.equal('OR');
	});

	it('records both bounds of a two-sided range seek', () => {
		const seek = soleSeek(db, 'select pk from t where pk > 1 and pk < 9');
		expect(seek.isRange).to.equal(true);
		expect(seek.pushedConstraints).to.have.lengthOf(2);
		// `constraints` order, not Set-insertion order: lower bound first.
		expect(seek.pushedConstraints!.map(c => c.op)).to.deep.equal(['>', '<']);
		const sources = recordedSources(seek);
		expect(sources[0], 'two separate comparisons, two separate nodes').to.not.equal(sources[1]);

		// Two distinct sources ⇒ a real AND, unlike the BETWEEN case above.
		const combined = combineResidualExpressions([...sources]);
		expect(combined).to.be.instanceOf(BinaryOpNode);
		expect((combined as BinaryOpNode).expression.operator).to.equal('AND');
	});

	it('stamps through the residual Filter of a COARSER_SAFE collation cover', async () => {
		await db.exec('create table cs (id integer primary key, name text) using memory');
		await db.exec("insert into cs values (1, 'Alice'), (2, 'BOB'), (3, 'Bob')");
		await db.exec('create index idx_cs on cs (name collate NOCASE)');

		// BINARY equality over a NOCASE index over-fetches a superset, so the seek is
		// kept and wrapped in a residual Filter recovering the BINARY-exact rows.
		// One plan for every assertion below: node identity is per-plan, so a second
		// `getPlan` of the same SQL yields equal-but-distinct nodes.
		const sql = "select id from cs where name = 'BOB'";
		const plan = db.getPlan(sql);
		const residual = collectNodes(plan, isFilter).find(f => f.source instanceof IndexSeekNode);
		expect(residual, 'the coarser cover leaves a residual Filter directly above the seek')
			.to.not.equal(undefined);

		// The stamp must reach the seek *underneath* that Filter.
		const seek = residual!.source as IndexSeekNode;
		expect(seek.indexName).to.equal('idx_cs');
		expect(seek.pushedConstraints).to.have.lengthOf(1);
		expect(seek.pushedConstraints![0].op).to.equal('=');

		// The recorded source IS the residual's predicate — re-applying it above the
		// seek is what the doc comment calls the double-application caveat.
		expect(residual!.predicate).to.equal(recordedSources(seek)[0]);

		const rows: unknown[] = [];
		for await (const r of db.eval(sql)) rows.push(r);
		expect(rows, 'the residual still discards the over-fetched NOCASE match').to.deep.equal([{ id: 2 }]);
	});

	it('carries both provenance fields through withChildren', () => {
		const seek = soleSeek(db, "select pk from t where s = 'x'");
		const rebuilt = seek.withChildren([seek.source, ...seek.seekKeys]) as IndexSeekNode;
		// Nothing changed ⇒ same instance, which trivially carries the fields.
		expect(rebuilt).to.equal(seek);

		// Force a real reconstruction by handing back an equal-but-distinct key list.
		const stamped = seek.withProvenance(seek.pushedConstraints!, true);
		const forced = stamped.withChildren([
			stamped.source,
			...stamped.seekKeys.map((k, i) => (i === 0 ? cloneScalar(k) : k)),
		]) as IndexSeekNode;
		expect(forced, 'reconstructed, not the same instance').to.not.equal(stamped);
		expect(forced.pushedConstraints).to.equal(stamped.pushedConstraints);
		expect(forced.orderingLoadBearing).to.equal(true);
	});

	it('marks a range seek orderingLoadBearing when it absorbed the ORDER BY', () => {
		const sql = 'select pk, n from t where n >= 20 order by n';
		const plan = db.getPlan(sql);

		// The ORDER BY is gone from the tree — the seek's emission order is the only
		// thing producing it, so a rewrite that changes that order must decline.
		expect(collectNodes(plan, isSort), 'the Sort was absorbed').to.have.lengthOf(0);

		const seek = soleSeek(db, sql);
		expect(seek.indexName).to.equal('idx_n');
		expect(seek.providesOrdering, 'seek advertises the ordering').to.not.equal(undefined);
		expect(seek.orderingLoadBearing).to.equal(true);
		// Provenance is stamped on the same node, not lost to the ordering arm.
		expect(seek.pushedConstraints).to.have.lengthOf(1);
		expect(seek.pushedConstraints![0].op).to.equal('>=');
	});

	it('leaves orderingLoadBearing false for the same seek without an ORDER BY', () => {
		const seek = soleSeek(db, 'select pk, n from t where n >= 20');
		expect(seek.orderingLoadBearing).to.equal(false);
		expect(seek.pushedConstraints).to.have.lengthOf(1);
	});

	it('stamps nothing when a collation mismatch declines the seek', async () => {
		await db.exec('create table mm (id integer primary key, name text) using memory');
		await db.exec("insert into mm values (1, 'apple'), (2, 'Banana'), (3, 'CHERRY'), (4, 'date')");
		await db.exec('create index idx_mm on mm (name)'); // BINARY index

		// predColl=NOCASE over a BINARY index ⇒ MISMATCH_UNSAFE ⇒ scan + residual.
		const plan = db.getPlan("select id from mm where name > 'banana' collate nocase");
		expect(collectNodes(plan, isIndexSeek), 'no seek to stamp').to.have.lengthOf(0);
		expect(collectNodes(plan, isSeqScan), 'declined to a sequential scan').to.have.lengthOf(1);
		expect(collectNodes(plan, isFilter), 'the predicate survives as a residual').to.have.length.greaterThan(0);
	});

	it('records a legacy-arm PK equality seek (module supplies no index identity)', async () => {
		const legacyDb = new Database();
		try {
			legacyDb.registerModule('legacy_mem', new LegacyPlanMemoryModule());
			await legacyDb.exec('create table lt (pk integer primary key, v integer) using legacy_mem');
			await legacyDb.exec('insert into lt values (1, 10), (2, 20), (3, 30)');

			const seek = soleSeek(legacyDb, 'select v from lt where pk = 2');
			expect(seek.indexName, 'legacy arm addresses the primary key directly').to.equal('primary');
			expect(seek.pushedConstraints).to.have.lengthOf(1);
			expect(seek.pushedConstraints![0].op).to.equal('=');
			expect(recordedSources(seek)[0]).to.be.instanceOf(BinaryOpNode);

			// The stamped plan still executes.
			const rows: unknown[] = [];
			for await (const r of legacyDb.eval('select v from lt where pk = 2')) rows.push(r);
			expect(rows).to.deep.equal([{ v: 20 }]);
		} finally {
			await legacyDb.close();
		}
	});
});

/**
 * A distinct-but-equivalent copy of a scalar node. `withChildren` short-circuits to
 * `this` when nothing changed, so forcing a real reconstruction needs a seek key that
 * is `!==` the original yet otherwise identical.
 */
function cloneScalar(node: ScalarPlanNode): ScalarPlanNode {
	return Object.create(
		Object.getPrototypeOf(node) as object,
		Object.getOwnPropertyDescriptors(node),
	) as ScalarPlanNode;
}
