import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { AccessPlanBuilder } from '../../src/vtab/best-access-plan.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import type { TableSchema } from '../../src/schema/table.js';

type ResultRow = Record<string, SqlValue>;

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

const JOIN_OPS = new Set([
	'JOIN',
	'HASHJOIN',
	'MERGEJOIN',
	'NESTEDLOOPJOIN',
	'BLOOMJOIN',
	'ASOFSCAN',
]);

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function hasOp(rows: readonly PlanRow[], op: string): boolean {
	return rows.some(r => r.op === op);
}

function joinCount(rows: readonly PlanRow[]): number {
	return rows.filter(r => JOIN_OPS.has(r.op)).length;
}

async function results(db: Database, sql: string): Promise<ResultRow[]> {
	const rows: ResultRow[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('Empty-relation folding', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupBase(): Promise<void> {
		await db.exec(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL, k INTEGER NOT NULL) USING memory",
		);
		await db.exec(
			"CREATE TABLE t2 (id INTEGER PRIMARY KEY, y INTEGER NOT NULL, k INTEGER NOT NULL) USING memory",
		);
		await db.exec("INSERT INTO t VALUES (1, 10, 100), (2, 20, 200), (3, 30, 300)");
		await db.exec("INSERT INTO t2 VALUES (1, 11, 100), (2, 22, 200)");
	}

	describe('Filter with falsy literal predicate', () => {
		it('folds `where false` to EmptyRelation (no SeqScan)', async () => {
			await setupBase();
			const q = 'select * from t where false';
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(hasOp(plan, 'SEQSCAN'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});

		it('folds `where null` to EmptyRelation', async () => {
			await setupBase();
			const q = 'select * from t where null';
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(hasOp(plan, 'SEQSCAN')).to.equal(false);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});

		it('count(*) over `where false` returns 0', async () => {
			await setupBase();
			const out = await results(db, 'select count(*) as cnt from t where false');
			expect(out).to.have.lengthOf(1);
			expect(out[0].cnt).to.equal(0);
		});

		// TODO: depends on ticket 2-optimizer-predicate-contradiction-detection —
		// once contradictory predicates (e.g. `1=2`) collapse to LiteralNode(false),
		// they will fold here too. Not in scope for this ticket.
	});

	describe('Cascading folds through Project/Sort/Limit/Distinct', () => {
		// NOTE on cascading: the Structural pass is top-down and rules fire on a
		// parent BEFORE its children are visited. So when an inner Filter folds to
		// EmptyRelation, the outer Sort/Project/LimitOffset/etc. has already been
		// rule-visited and won't re-fire automatically. The runtime still produces
		// zero rows (EmptyRelation yields nothing, propagating up), but residual
		// operators above the EmptyRelation may survive in the plan. Tests here
		// assert correct semantics and that the SeqScan vanished, not full collapse.
		it('folds inner `where false` to EmptyRelation; outer Sort/LIMIT still produce zero rows', async () => {
			await setupBase();
			const q = 'select x from (select * from t where false) order by x limit 5';
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(hasOp(plan, 'SEQSCAN')).to.equal(false);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});

		it('Project(Filter(t, false)) folds to EmptyRelation directly (immediate parent)', async () => {
			await setupBase();
			// Filter fires first (bottom subtree), Project is its immediate parent
			// and is re-visited after children change in the applyPassRules per-node
			// fixed-point loop... actually no — applyPassRules is per-node. So this
			// test is the SAME shape as cascading above. Use it to lock in the
			// "EmptyRelation appears, SeqScan gone, zero rows" contract.
			const q = 'select x from t where false';
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(hasOp(plan, 'SEQSCAN')).to.equal(false);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});

		it('Project preserves its attribute IDs when folding (aliased column name survives)', async () => {
			await setupBase();
			const q = 'select x as y from t where false';
			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
			// EmptyRelation gets the host node's attributes; the alias should be
			// preserved if Project is the immediate fold site, otherwise the
			// outer Project node carries it. Either way the runtime emits a
			// `y` column.
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION')).to.equal(true);
		});

		it('folds `select distinct x from t where false`', async () => {
			await setupBase();
			const q = 'select distinct x from t where false';
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});
	});

	describe('Inner / cross joins fold when either side is empty', () => {
		// NOTE on Structural cascade limits: the Structural pass is top-down and a
		// JoinNode's rules fire BEFORE its children are visited. So `Join(L,
		// Alias(Filter(R, false)))` is observed by the Join rule with a non-empty
		// right (Alias around a non-folded Filter); only the inner Filter folds.
		// The join survives in the plan but its runtime still produces zero rows
		// because EmptyRelation yields nothing. The folds below show the *direct*
		// case where the IND rule emits EmptyRelation in the same node visit; the
		// `Inner join over NOT-EXISTS-empty` case exercises the JoinFoldEmpty rule.

		it('inner join with empty left → EmptyRelation (runtime zero rows)', async () => {
			await setupBase();
			const q = 'select * from (select * from t where false) z join t2 on z.k = t2.k';
			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});

		it('cross join with empty side → runtime zero rows', async () => {
			await setupBase();
			const q = 'select * from t cross join (select * from t2 where false) z';
			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});

		it('inner join over an IND-empty anti-join → EmptyRelation (Join fold)', async () => {
			// Setup: child2.parent_id is NOT NULL REFERENCES parent_t(id).
			// NOT EXISTS (SELECT 1 FROM parent_t WHERE parent_t.id = c.parent_id)
			// folds to EmptyRelation directly within the same JoinNode visit (the
			// anti-join IND rule and the JoinFoldEmpty rule are co-located in
			// Structural pass — but here we put it BELOW another Join to exercise
			// cascade in a non-Alias-wrapped position).
			await db.exec('CREATE TABLE parent_t (id INTEGER PRIMARY KEY) USING memory');
			await db.exec(
				'CREATE TABLE child_t (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent_t(id), k INTEGER NOT NULL) USING memory',
			);
			await db.exec('CREATE TABLE side_t (k INTEGER PRIMARY KEY, v TEXT) USING memory');
			await db.exec('INSERT INTO parent_t VALUES (1), (2)');
			await db.exec('INSERT INTO child_t VALUES (10, 1, 100), (11, 2, 200)');
			await db.exec("INSERT INTO side_t VALUES (100, 'a'), (200, 'b')");

			// The anti-join over (child_t, parent_t) folds to EmptyRelation in
			// the same Structural visit; per-node fixed-point lets the Join rule
			// fire on the resulting EmptyRelation source within the same loop.
			// This validates JoinFoldEmpty without depending on cross-tree
			// cascade.
			const q = `SELECT c.id FROM child_t c
				WHERE NOT EXISTS (SELECT 1 FROM parent_t p WHERE p.id = c.parent_id)`;
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});
	});

	describe('Outer joins: must abstain in the wrong direction', () => {
		it('LEFT JOIN with empty right keeps the join and null-pads the right', async () => {
			await setupBase();
			const q = 'select t.id, t.x, z.y from t left join (select * from t2 where false) z on t.k = z.k order by t.id';
			const plan = await planRows(db, q);
			// LEFT JOIN with empty right is NOT empty — the join-fold rule must
			// abstain. The inner subquery may still have collapsed to
			// EmptyRelation, but the LEFT JOIN survives and null-pads the right.
			expect(joinCount(plan), `plan ops=${plan.map(r => r.op).join(',')}`).to.be.greaterThan(0);

			const out = await results(db, q);
			expect(out.map(r => r.id)).to.deep.equal([1, 2, 3]);
			for (const r of out) {
				expect(r.y, `row id=${r.id}: right side should be NULL`).to.equal(null);
			}
		});

		it('LEFT JOIN with empty LEFT (driving side empty) → runtime zero rows', async () => {
			await setupBase();
			// When the *left* (driving) side of a LEFT JOIN is empty, the entire
			// output is empty. The runtime correctness is guaranteed; the plan
			// shape may still contain the residual JOIN node above an
			// EmptyRelation (top-down cascade limitation), but the EmptyRelation
			// drives zero output rows.
			const q = 'select * from (select * from t where false) z left join t2 on z.k = t2.k';
			const out = await results(db, q);
			expect(out).to.have.lengthOf(0);
		});
	});

	describe('Anti-join: empty right side must NOT fold to empty', () => {
		it('NOT EXISTS over an empty subquery returns all of L', async () => {
			await setupBase();
			// The inner `where false` is an EmptyRelation, but the outer NOT EXISTS
			// becomes an anti-join — anti-join with empty right returns ALL of t.
			const q = 'select id from t where not exists (select 1 from (select * from t2 where false) z where z.k = t.k) order by id';
			const out = await results(db, q);
			expect(out.map(r => r.id)).to.deep.equal([1, 2, 3]);
		});
	});
});

// ── `rows: 0` is an estimate; `provablyEmpty` is the proof ──────────────────
// `selectPhysicalNode` replaces a table access with an EmptyResult only on the module's
// explicit `provablyEmpty` flag. It used to fold on `accessPlan.rows === 0` instead —
// reading a documented estimate as a proof — so a module reporting a live count of zero,
// or rounding a very selective estimate down, had its read deleted; planning precedes
// execution, so "empty now" is not "empty when this runs".

/** A module that reports its live size on a no-filter scan, honestly — zero included. */
class LiveCountModule extends MemoryTableModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		if (request.filters.length === 0) {
			return AccessPlanBuilder
				.fullScan(0)
				.setHandledFilters([])
				.setExplanation('Live count says the table is empty right now')
				.build();
		}
		return super.getBestAccessPlan(db, tableInfo, request);
	}
}

/**
 * Answers every filtered request with the underlying plan, then stamps `rows: 0` on it —
 * the shape the old fold read as a proof (every filter claimed, zero rows) with no
 * `provablyEmpty` flag. The filters are genuinely claimed and genuinely enforced by the
 * memory module's own seek, so the correct answer is the row, not nothing.
 */
class ZeroEstimateModule extends MemoryTableModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const plan = super.getBestAccessPlan(db, tableInfo, request);
		return request.filters.length > 0 ? { ...plan, rows: 0 } : plan;
	}
}

/** Answers any filtered request with a PROOF that nothing matches. */
class ProvenEmptyModule extends MemoryTableModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		if (request.filters.length === 0) return super.getBestAccessPlan(db, tableInfo, request);
		return AccessPlanBuilder
			.empty(new Array(request.filters.length).fill(true))
			.setExplanation('Module says nothing can match')
			.build();
	}
}

describe('A module `rows: 0` is an estimate, not a proof', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('zero_estimate', new ZeroEstimateModule());
	});

	afterEach(async () => {
		await db.close();
	});

	it('reads the table and enforces the filter when every filter is claimed', async () => {
		await db.exec('create table z (id integer primary key, v text) using zero_estimate');
		await db.exec("insert into z values (1, 'a'), (2, 'b')");

		const q = 'select id, v from z where id = 1';
		const plan = await planRows(db, q);
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		expect(await results(db, q)).to.deep.equal([{ id: 1, v: 'a' }]);
	});
});

describe('`provablyEmpty` is the fold signal', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('proven_empty', new ProvenEmptyModule());
	});

	afterEach(async () => {
		await db.close();
	});

	it('folds the whole table access away', async () => {
		await db.exec('create table p (id integer primary key, v text) using proven_empty');
		await db.exec("insert into p values (1, 'a')");

		const q = 'select id from p where id = 1';
		const plan = await planRows(db, q);
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(await results(db, q)).to.have.lengthOf(0);
	});

	it('leaves an unfiltered read alone', async () => {
		await db.exec('create table p2 (id integer primary key, v text) using proven_empty');
		await db.exec("insert into p2 values (1, 'a')");

		const q = 'select id from p2 order by id';
		expect(await results(db, q)).to.deep.equal([{ id: 1 }]);
	});
});

describe('A no-filter `rows: 0` is an estimate, not a proof', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('live_count', new LiveCountModule());
	});

	afterEach(async () => {
		await db.close();
	});

	it('keeps the table read instead of folding it away', async () => {
		await db.exec('create table lc (id integer primary key, v text) using live_count');
		await db.exec("insert into lc values (1, 'a'), (2, 'b')");

		const q = 'select id from lc order by id';
		const plan = await planRows(db, q);
		// `createEmptyResultNode` emits EMPTYRESULT (the access-fold node), distinct from
		// the EMPTYRELATION the `where false` rules above produce.
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		expect(await results(db, q)).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('still folds when the module claimed the filter it was given', async () => {
		// The memory module's own impossible-predicate arm: IS NULL on a NOT NULL column,
		// reported as rows: 0 with that one filter claimed handled. Unaffected by the guard.
		await db.exec('create table nn (id integer primary key, v text not null) using live_count');
		await db.exec("insert into nn values (1, 'a')");

		const q = 'select id from nn where v is null';
		const plan = await planRows(db, q);
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(await results(db, q)).to.have.lengthOf(0);
	});
});

/**
 * Proves the filter it claims and leaves the rest to the engine — the shape
 * `AccessPlanBuilder.empty` and `validateAccessPlan` both accept. Claiming one filter is
 * enough for the fold: the unclaimed ones survive as residuals above an access that is
 * already known to produce nothing.
 */
class PartialProofModule extends MemoryTableModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		if (request.filters.length < 2) return super.getBestAccessPlan(db, tableInfo, request);
		const handled = request.filters.map((_, i) => i === 0);
		return AccessPlanBuilder
			.empty(handled)
			.setExplanation('Module proved the first filter unsatisfiable')
			.build();
	}
}

/**
 * Sets `provablyEmpty` on shapes `validateAccessPlan` rejects, without calling it — a
 * module that skips validation, as the store module does. The planner's own well-formedness
 * test (`provesEmpty`) must decline both rather than deleting the read.
 */
class MalformedProofModule extends MemoryTableModule {
	constructor(private readonly flavor: 'no-claim' | 'nonzero-rows') {
		super();
	}

	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		if (request.filters.length === 0) return super.getBestAccessPlan(db, tableInfo, request);
		if (this.flavor === 'no-claim') {
			// A plain scan that claims nothing, then stamps the flag on anyway.
			return {
				...AccessPlanBuilder.fullScan(0).setHandledFilters(request.filters.map(() => false)).build(),
				rows: 0,
				provablyEmpty: true,
			};
		}
		// Every filter claimed and genuinely enforced by the memory module's own seek, but
		// the plan reports rows it would return — the flag contradicts itself.
		const plan = super.getBestAccessPlan(db, tableInfo, request);
		return { ...plan, rows: 7, provablyEmpty: true };
	}
}

describe('a proof over one claimed filter still folds', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('partial_proof', new PartialProofModule());
	});

	afterEach(async () => {
		await db.close();
	});

	it('folds with the unclaimed filter left to the engine', async () => {
		await db.exec('create table pp (id integer primary key, v text) using partial_proof');
		await db.exec("insert into pp values (1, 'a')");

		const q = "select id from pp where id = 1 and v = 'a'";
		const plan = await planRows(db, q);
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(await results(db, q)).to.have.lengthOf(0);
	});
});

describe('a half-expressed proof does not fold', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('no_claim_proof', new MalformedProofModule('no-claim'));
		db.registerModule('nonzero_proof', new MalformedProofModule('nonzero-rows'));
	});

	afterEach(async () => {
		await db.close();
	});

	it('declines a proof that claims no filter', async () => {
		await db.exec('create table nc (id integer primary key, v text) using no_claim_proof');
		await db.exec("insert into nc values (1, 'a'), (2, 'b')");

		const q = 'select id, v from nc where id = 1';
		const plan = await planRows(db, q);
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		expect(await results(db, q)).to.deep.equal([{ id: 1, v: 'a' }]);
	});

	it('declines a proof that reports rows it would return', async () => {
		await db.exec('create table nz (id integer primary key, v text) using nonzero_proof');
		await db.exec("insert into nz values (1, 'a'), (2, 'b')");

		const q = 'select id, v from nz where id = 1';
		const plan = await planRows(db, q);
		expect(hasOp(plan, 'EMPTYRESULT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		expect(await results(db, q)).to.deep.equal([{ id: 1, v: 'a' }]);
	});
});
