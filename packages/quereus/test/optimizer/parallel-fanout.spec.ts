/**
 * Recognition + cost-gate tests for `ruleFanOutLookupJoin`.
 *
 * Runtime correctness lives in `test/runtime/fanout-lookup-join.spec.ts`; these
 * tests only care about *when* the rule fires and what shape its output takes.
 *
 * The cost gate is anchored on `physical.expectedLatencyMs`, which the
 * synthetic `HighLatencyMemoryModule` below declares non-zero. With no remote
 * plugin in tree the rule is inert by design — the local-only no-rewrite case
 * verifies that.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { SqlValue } from '../../src/common/types.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

/**
 * Memory-backed module that declares a non-zero `expectedLatencyMs`. Used as
 * the lookup table type in multi-branch scenarios so the fan-out cost gate has
 * a real savings number to compare against `branchSetupCost`.
 */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

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

async function results(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function hasFanOut(rows: readonly PlanRow[]): boolean {
	return rows.some(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
}

function joinCount(rows: readonly PlanRow[]): number {
	const JOIN_OPS = new Set([
		'JOIN', 'HASHJOIN', 'MERGEJOIN', 'NESTEDLOOPJOIN', 'BLOOMJOIN', 'ASOFSCAN',
	]);
	return rows.filter(r => JOIN_OPS.has(r.op)).length;
}

/** Branch modes parsed from the fan-out node's logical properties. */
function fanOutBranchModes(rows: readonly PlanRow[]): string[] {
	const fo = rows.find(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
	if (!fo || !fo.properties) return [];
	const props = JSON.parse(fo.properties) as { branches?: { mode: string }[] };
	return (props.branches ?? []).map(b => b.mode);
}

// Tests that *execute* a fan-out plan with an ORDER BY hit a known strict-fork
// harness interaction: the Sort/Project above the fan-out join calls
// `createRowSlot` on the parent rctx while the join's forks are still counted
// active, tripping invariant 2 (parent immutability during fork lifetime). The
// forks never read the parent's later-created slot, so this is a
// strict-harness false-positive only — `bumpParentForkCounter` is a no-op in
// production (see docs/runtime-parallel.md § Strict-fork interaction). Mirror the
// `Sort-above-AsyncGather` guard in `parallel-async-gather.spec.ts`: skip the
// execution paths under strict-fork; the non-strict run validates correctness.
const strictFork = typeof process !== 'undefined' && (process.env?.QUEREUS_FORK_STRICT === '1' || process.env?.QUEREUS_FORK_STRICT === 'true');
const forkExecTest = strictFork ? it.skip : it;

describe('ruleFanOutLookupJoin', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Register the high-latency module under a distinct name so tables can
		// opt in via USING.
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		// Tighten the cap so N=3 branches surface a positive cost gate (default
		// cap=8 ≥ N=3 means `(N - cap) × latency = 0`, which the gate rejects —
		// the rule fires only when concurrency-bound). Each test that needs the
		// default cap behavior restores it inline.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, concurrency: 2 },
		});
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Three lookup tables (cust, prod, region) and one orders table whose FKs
	 * point at each lookup's PK. `using_lookup` controls whether the lookup
	 * tables are backed by the high-latency module.
	 */
	async function setup3Branches(using_lookup: 'memory' | 'hi_lat_memory'): Promise<void> {
		await db.exec(
			`create table cust (id integer primary key, name text) using ${using_lookup}`,
		);
		await db.exec(
			`create table prod (id integer primary key, sku text) using ${using_lookup}`,
		);
		await db.exec(
			`create table region (id integer primary key, label text) using ${using_lookup}`,
		);
		await db.exec(
			`create table orders (
				order_id integer primary key,
				customer_id integer not null references cust(id),
				product_id integer not null references prod(id),
				region_id integer not null references region(id),
				total real
			) using memory`,
		);
		await db.exec("insert into cust values (1, 'Acme'), (2, 'Beta')");
		await db.exec("insert into prod values (10, 'SKU-A'), (20, 'SKU-B')");
		await db.exec("insert into region values (100, 'EU'), (200, 'US')");
		await db.exec(`insert into orders values
			(1, 1, 10, 100, 99.0),
			(2, 2, 20, 200, 49.5),
			(3, 1, 20, 100, 12.0)`);
	}

	const fanout3SQL =
		`select o.order_id, c.name, p.sku, r.label
		 from orders o
		 left join cust c on o.customer_id = c.id
		 left join prod p on o.product_id = p.id
		 left join region r on o.region_id = r.id`;

	it('does NOT cluster below tuning.parallel.minBranches', async () => {
		// One branch over the high-latency module → below the default minBranches=2.
		await setup3Branches('hi_lat_memory');
		const q = `select o.order_id, c.name from orders o left join cust c on o.customer_id = c.id`;
		const plan = await planRows(db, q);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('clusters when N ≥ minBranches and latency win exceeds setup overhead', async () => {
		await setup3Branches('hi_lat_memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);

		// Original 3 joins collapsed into the FanOut → no other join ops survive.
		expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
	});

	it('does NOT cluster on local-only chains regardless of N', async () => {
		// 3 branches over the memory module (expectedLatencyMs=0) — cost gate
		// must reject because (N-cap) × 0 ≤ N × branchSetupCost.
		await setup3Branches('memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT cluster when concurrency cap >= branch count (no parallel win)', async () => {
		await setup3Branches('hi_lat_memory');
		// Cap=10 on 3 branches → (3-3) × 25 = 0 savings vs 3 × 1.0 = 3 overhead.
		// (`beforeEach` lowered the cap to 2 to make the positive-case tests fire;
		// here we restore the default 8 — which is still ≥ N — to verify the gate.)
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, concurrency: 10 },
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('clusters when N > default concurrency cap', async () => {
		// Use a fresh tuning with the default cap=8, and N=9 to exceed it.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({ ...before, parallel: { ...before.parallel, concurrency: 8 } });
		try {
			// 9 lookup tables, all FK→PK aligned.
			for (let i = 0; i < 9; i++) {
				await db.exec(`create table lk${i} (id integer primary key, v integer) using hi_lat_memory`);
				await db.exec(`insert into lk${i} values (1, ${i * 10}), (2, ${i * 10 + 1})`);
			}
			const cols = Array.from({ length: 9 }, (_, i) =>
				`fk${i} integer not null references lk${i}(id)`).join(', ');
			await db.exec(`create table wide (id integer primary key, ${cols}) using memory`);
			await db.exec(`insert into wide values (1, ${Array(9).fill('1').join(',')})`);
			const joins = Array.from({ length: 9 }, (_, i) =>
				`left join lk${i} on wide.fk${i} = lk${i}.id`).join(' ');
			const sel = `select wide.id, ${Array.from({ length: 9 }, (_, i) => `lk${i}.v as v${i}`).join(', ')} from wide ${joins}`;
			const plan = await planRows(db, sel);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('honors disabledRules and leaves the chain as nested joins', async () => {
		await setup3Branches('hi_lat_memory');
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-lookup-join']),
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinCount(plan)).to.be.greaterThan(0);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('clusters an INNER branch with nullable FK as `cross` (fallthrough, not bail)', async () => {
		// Lookup is high-latency, but one FK is nullable → that branch fails the
		// at-most-one *existence* proof (the same nullability guard
		// `ruleJoinElimination` uses). It used to bail — aborting the WHOLE
		// cluster — but `cross` is sound for an inner join (inner-drop on an
		// empty branch is inner-join semantics), so recognizeBranch now falls
		// through and only the cardinality claim is lost. The two NOT-NULL
		// branches keep their `atMostOne-inner` mode.
		await db.exec(`create table cust (id integer primary key, name text) using hi_lat_memory`);
		await db.exec(`create table prod (id integer primary key, sku text) using hi_lat_memory`);
		await db.exec(`create table region (id integer primary key, label text) using hi_lat_memory`);
		await db.exec(`create table orders (
			order_id integer primary key,
			customer_id integer not null references cust(id),
			product_id integer not null references prod(id),
			region_id integer null references region(id),
			total real
		) using memory`);
		const q = `select o.order_id, c.name, p.sku, r.label
		           from orders o
		           inner join cust c on o.customer_id = c.id
		           inner join prod p on o.product_id = p.id
		           inner join region r on o.region_id = r.id`;
		const plan = await planRows(db, q);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-inner', 'atMostOne-inner', 'cross']);
	});

	forkExecTest('preserves output rows across rewrite (execution equivalence)', async () => {
		await setup3Branches('hi_lat_memory');
		const rewrittenPlan = await planRows(db, fanout3SQL);
		expect(hasFanOut(rewrittenPlan)).to.equal(true);
		const out = await results(db, fanout3SQL + ' order by o.order_id');

		// Now disable the rule and re-run for the baseline.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-lookup-join']),
		});
		let baseline: Record<string, SqlValue>[];
		try {
			baseline = await results(db, fanout3SQL + ' order by o.order_id');
		} finally {
			db.optimizer.updateTuning(before);
		}

		expect(out).to.deep.equal(baseline);
		expect(out.map(r => r.order_id)).to.deep.equal([1, 2, 3]);
		expect(out.map(r => r.name)).to.deep.equal(['Acme', 'Beta', 'Acme']);
		expect(out.map(r => r.sku)).to.deep.equal(['SKU-A', 'SKU-B', 'SKU-B']);
		expect(out.map(r => r.label)).to.deep.equal(['EU', 'US', 'EU']);
	});

	forkExecTest('preserves output attribute IDs across the rewrite', async () => {
		await setup3Branches('hi_lat_memory');
		// Column names + values across the rewrite are the user-facing
		// manifestation of preserved attribute IDs (the IDs themselves aren't
		// exposed in query_plan).
		//
		// IMPORTANT: Plans are built lazily on first iterator `.next()`, so we
		// must `await` each `results(...)` call *inside* the tuning window.
		// Returning an unawaited promise from `try { ... } finally { restore }`
		// would let the finally run before planning, defeating the rule toggle.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-lookup-join']),
		});
		let base: Record<string, SqlValue>[];
		try {
			base = await results(db, fanout3SQL + ' order by o.order_id');
		} finally {
			db.optimizer.updateTuning(before);
		}
		const rewr = await results(db, fanout3SQL + ' order by o.order_id');
		// Confirm the rewrite actually happened on the second run — otherwise
		// this test would compare two identical plans and pass spuriously.
		const rewrittenPlan = await planRows(db, fanout3SQL);
		expect(hasFanOut(rewrittenPlan), 'rewrite must fire for the comparison').to.equal(true);
		expect(Object.keys(base[0])).to.deep.equal(Object.keys(rewr[0]));
	});

	it('honors tuning.parallel.minBranches override', async () => {
		await setup3Branches('hi_lat_memory');
		// Tighten the threshold so 3 branches still qualifies; loosen the cap so
		// (N - cap) × latency is positive.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, minBranches: 4 },
		});
		try {
			// 3 < 4 → no cluster even with high-latency module.
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	// ----------------------------------------------------------------------
	// FK→PK alignment compares base-table column positions. A sub-select on a
	// lookup branch renumbers columns, so an untranslated comparison can accept
	// the wrong column as the PK column and classify a genuinely 1:n branch as
	// `atMostOne-left` — which `assertAtMostOne` then rejects at runtime.
	// ----------------------------------------------------------------------
	describe('derived-table lookup branches', () => {
		/**
		 * Three lookup tables whose `other` column is NOT the PK and NOT the FK
		 * target: every row carries `other = 1`, so a join on `other` matches two
		 * rows per outer row (a genuine 1:n branch).
		 */
		async function setupDerivedBranches(): Promise<void> {
			for (const t of ['cust', 'prod', 'region']) {
				await db.exec(
					`create table ${t} (id integer primary key, other integer, label text) using hi_lat_memory`,
				);
				await db.exec(`insert into ${t} values (1, 1, '${t}-a'), (2, 1, '${t}-b')`);
			}
			await db.exec(`create table orders (
				order_id integer primary key,
				customer_id integer not null references cust(id),
				product_id integer not null references prod(id),
				region_id integer not null references region(id)
			) using memory`);
			// order 1 joins on value 1 (matches both lookup rows per branch);
			// order 2 joins on value 2 (matches none — exercises the NULL pad).
			await db.exec('insert into orders values (1, 1, 1, 1), (2, 2, 2, 2)');
		}

		// `c.other` is output position 0 of the sub-select but column 1 of `cust`;
		// position 0 is `cust.id`, the column the FK references.
		const derivedNonFkSQL = `select o.order_id from orders o
			left join (select other from cust) c on o.customer_id = c.other
			left join (select other from prod) p on o.product_id = p.other
			left join (select other from region) r on o.region_id = r.other`;

		// The mirror image: a reordering sub-select that IS FK-covered.
		const derivedFkSQL = `select o.order_id, c.label from orders o
			left join (select other, id, label from cust) c on o.customer_id = c.id
			left join (select other, id from prod) p on o.product_id = p.id
			left join (select other, id from region) r on o.region_id = r.id`;

		it('does NOT classify a non-FK sub-select branch as at-most-one', async () => {
			await setupDerivedBranches();
			const plan = await planRows(db, derivedNonFkSQL);
			// The branches are still clusterable — a `cross` / `cross-left` branch is
			// always sound (data-driven 1:n, gated by the row/product guards), so
			// failing to *prove* at-most-one degrades the branch rather than killing
			// the whole cluster. What must never happen is an at-most-one claim.
			expect(fanOutBranchModes(plan)).to.deep.equal(['cross-left', 'cross-left', 'cross-left']);
		});

		forkExecTest('non-FK sub-select branches return the nested-loop row multiset', async () => {
			await setupDerivedBranches();
			const plan = await planRows(db, derivedNonFkSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			const out = await results(db, derivedNonFkSQL + ' order by o.order_id');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let baseline: Record<string, SqlValue>[];
			try {
				baseline = await results(db, derivedNonFkSQL + ' order by o.order_id');
			} finally {
				db.optimizer.updateTuning(before);
			}

			expect(out).to.deep.equal(baseline);
			// order 1 matches 2 rows on each of 3 branches (2³ = 8); order 2 matches
			// nothing and survives once via the LEFT null-pad.
			expect(out.map(r => r.order_id)).to.deep.equal([1, 1, 1, 1, 1, 1, 1, 1, 2]);
		});

		it('still recognizes at-most-one when a reordering sub-select IS FK-covered', async () => {
			await setupDerivedBranches();
			const plan = await planRows(db, derivedFkSQL);
			// `c.id` is output position 1 but table column 0 — the FK's referenced
			// column. Translating (rather than refusing sub-selects) keeps the
			// at-most-one classification available.
			expect(fanOutBranchModes(plan)).to.deep.equal([
				'atMostOne-left', 'atMostOne-left', 'atMostOne-left',
			]);
		});

		forkExecTest('FK-covered sub-select branches return the nested-loop rows', async () => {
			await setupDerivedBranches();
			const plan = await planRows(db, derivedFkSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			const out = await results(db, derivedFkSQL + ' order by o.order_id');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let baseline: Record<string, SqlValue>[];
			try {
				baseline = await results(db, derivedFkSQL + ' order by o.order_id');
			} finally {
				db.optimizer.updateTuning(before);
			}

			expect(out).to.deep.equal(baseline);
			expect(out.map(r => r.order_id)).to.deep.equal([1, 2]);
			expect(out.map(r => r.label)).to.deep.equal(['cust-a', 'cust-b']);
		});
	});

	// ----------------------------------------------------------------------
	// Subquery-branch recognition: correlated scalar aggregates in the SELECT
	// projection list cluster as `atMostOne-left` fan-out branches.
	// ----------------------------------------------------------------------
	describe('correlated scalar-aggregate subquery branches', () => {
		// The 2-branch cases below sit at the cost-gate boundary: with N = cap the
		// projected savings `(N - cap) × latency` is 0 and the gate rejects. Drop
		// the cap to 1 so a 2-branch cluster surfaces a positive win
		// `(2 - 1) × 25 = 25 > 2 × branchSetupCost`. (The outer `beforeEach` set
		// cap=2 for the 3-branch spine tests.)
		beforeEach(() => {
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, concurrency: 1 },
			});
		});

		/**
		 * One outer table and two child tables. `a` has rows for k=1,2 but NONE
		 * for k=3; `b` has rows for k=1 only. The k=3 / k=2 gaps exercise the
		 * empty-children invariant (count→0, not NULL-filled).
		 */
		async function setupSubqueryTables(child: 'memory' | 'hi_lat_memory'): Promise<void> {
			await db.exec(`create table outer_t (k integer primary key, label text) using memory`);
			await db.exec(`create table a (id integer primary key, fk integer, v integer) using ${child}`);
			await db.exec(`create table b (id integer primary key, fk integer) using ${child}`);
			await db.exec("insert into outer_t values (1, 'one'), (2, 'two'), (3, 'three')");
			await db.exec('insert into a values (10, 1, 100), (11, 1, 101), (12, 2, 200)');
			await db.exec('insert into b values (20, 1), (21, 1)');
		}

		const subq2SQL =
			`select o.k,
				(select json_group_array(a.v) from a where a.fk = o.k) as xs,
				(select count(*) from b where b.fk = o.k) as nb
			 from outer_t o`;

		it('pure subquery cluster fires with 2 atMostOne-left branches', async () => {
			await setupSubqueryTables('hi_lat_memory');
			const plan = await planRows(db, subq2SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'atMostOne-left']);
			// The branch children keep getting optimized after recognition — the
			// count(*) / json_group_array aggregates appear under the fan-out.
			expect(
				plan.some(r => r.node_type.includes('Aggregate') || r.op.includes('AGGREGATE')),
				`ops=${plan.map(r => r.op).join(',')}`,
			).to.equal(true);
		});

		it('mixed cluster: one FK→PK join branch + one subquery branch', async () => {
			await db.exec('create table lk (id integer primary key, name text) using hi_lat_memory');
			await db.exec(`create table main_t (
				id integer primary key,
				lk_id integer not null references lk(id)
			) using memory`);
			await db.exec('create table c (id integer primary key, fk integer, v integer) using hi_lat_memory');
			await db.exec("insert into lk values (1, 'Acme'), (2, 'Beta')");
			await db.exec('insert into main_t values (1, 1), (2, 2)');
			await db.exec('insert into c values (10, 1, 5), (11, 1, 7)');

			const sql =
				`select m.id, lk.name,
					(select count(*) from c where c.fk = m.id) as nc
				 from main_t m
				 left join lk on m.lk_id = lk.id`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'atMostOne-left']);
			// The join collapsed into the fan-out — no surviving join op.
			expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		});

		forkExecTest('mixed cluster result correctness: subquery branch reads at the post-spine wide-row index', async () => {
			// Outer (main_t: 2 cols) + spine branch (lk: 2 cols) places the subquery
			// branch's single output column at wide index 4. This exercises the
			// `wideIndex` accumulation across a preceding spine branch — the
			// plan-shape `it` above never executes the plan.
			await db.exec('create table lk (id integer primary key, name text) using hi_lat_memory');
			await db.exec(`create table main_t (
				id integer primary key,
				lk_id integer not null references lk(id)
			) using memory`);
			await db.exec('create table c (id integer primary key, fk integer, v integer) using hi_lat_memory');
			await db.exec("insert into lk values (1, 'Acme'), (2, 'Beta')");
			await db.exec('insert into main_t values (1, 1), (2, 2)');
			await db.exec('insert into c values (10, 1, 5), (11, 2, 7), (12, 2, 9)');

			const sql =
				`select m.id, lk.name,
					(select count(*) from c where c.fk = m.id) as nc
				 from main_t m
				 left join lk on m.lk_id = lk.id`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, sql + ' order by m.id');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({ ...before, disabledRules: new Set(['fanout-lookup-join']) });
			let disabled: Record<string, SqlValue>[];
			try {
				disabled = await results(db, sql + ' order by m.id');
			} finally {
				db.optimizer.updateTuning(before);
			}
			expect(enabled).to.deep.equal(disabled);
			expect(enabled).to.deep.equal([
				{ id: 1, name: 'Acme', nc: 1 },
				{ id: 2, name: 'Beta', nc: 2 },
			]);
		});

		forkExecTest('result correctness: enabled vs disabled, empty children → 0 not NULL', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// Confirm the rule fires for the enabled run.
			const plan = await planRows(db, subq2SQL);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, subq2SQL + ' order by o.k');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let disabled: Record<string, SqlValue>[];
			try {
				disabled = await results(db, subq2SQL + ' order by o.k');
			} finally {
				db.optimizer.updateTuning(before);
			}

			expect(enabled).to.deep.equal(disabled);
			// k=3 matches no rows in a or b; the at-most-one branch must drive the
			// aggregate to its one finalized row rather than NULL-filling.
			const k3 = enabled.find(r => r.k === 3)!;
			expect(k3.nb).to.equal(0); // count → 0, not NULL
			// k=1 has two b rows.
			expect(enabled.find(r => r.k === 1)!.nb).to.equal(2);
		});

		forkExecTest('attribute-ID stability: identical output columns enabled vs disabled', async () => {
			await setupSubqueryTables('hi_lat_memory');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let base: Record<string, SqlValue>[];
			try {
				base = await results(db, subq2SQL + ' order by o.k');
			} finally {
				db.optimizer.updateTuning(before);
			}
			const rewr = await results(db, subq2SQL + ' order by o.k');
			const rewrittenPlan = await planRows(db, subq2SQL);
			expect(hasFanOut(rewrittenPlan), 'rewrite must fire for the comparison').to.equal(true);
			expect(Object.keys(base[0])).to.deep.equal(Object.keys(rewr[0]));
		});

		it('inert in-tree: plain memory vtab does not cluster subqueries', async () => {
			await setupSubqueryTables('memory');
			const plan = await planRows(db, subq2SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		it('GROUP BY subquery is not routed into the fan-out', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// First subquery has a GROUP BY (may yield >1 row) → rejected. With only
			// the second subquery recognizable, the count drops below minBranches=2,
			// so no fan-out forms.
			const sql =
				`select o.k,
					(select count(*) from a where a.fk = o.k group by a.v) as x,
					(select count(*) from b where b.fk = o.k) as y
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		/**
		 * The subquery correlates to `lk.id` — a SPINE-branch output attribute, not
		 * the outer table. At runtime the fan-out installs only the outer row's slot
		 * before forking, so clustering this subquery would leave `lk.id`
		 * unresolvable inside the branch (it errors with "No row context found").
		 * The guard must reject it, dropping the cluster below minBranches (only the
		 * lk join remains).
		 */
		async function setupSpineCorrelated(): Promise<string> {
			await db.exec('create table lk (id integer primary key, name text) using hi_lat_memory');
			await db.exec(`create table main_t (
				id integer primary key,
				lk_id integer not null references lk(id)
			) using memory`);
			await db.exec('create table c (id integer primary key, fk integer, v integer) using hi_lat_memory');
			await db.exec("insert into lk values (1, 'Acme'), (2, 'Beta')");
			await db.exec('insert into main_t values (1, 1), (2, 2)');
			await db.exec('insert into c values (10, 1, 5), (11, 2, 7), (12, 2, 9)');
			return `select m.id, lk.name,
					(select count(*) from c where c.fk = lk.id) as nc
				 from main_t m
				 left join lk on m.lk_id = lk.id`;
		}

		it('correlated subquery referencing a spine-branch attribute is not clustered', async () => {
			const sql = await setupSpineCorrelated();
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		// Execution is a fork path (correlated per-row subquery under ORDER BY's
		// Sort→Project), so it hits the documented strict-fork false-positive — skip
		// under strict-fork like the other execution cases. Regression guard for the
		// "No row context found for column id" failure when the guard is absent.
		forkExecTest('spine-correlated subquery still returns correct rows (guard regression)', async () => {
			const sql = await setupSpineCorrelated();
			const out = await results(db, sql + ' order by m.id');
			expect(out).to.deep.equal([
				{ id: 1, name: 'Acme', nc: 1 },
				{ id: 2, name: 'Beta', nc: 2 },
			]);
		});

		it('non-correlated subquery is not clustered', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// First subquery references no outer column → constant-per-query, not a
			// per-row branch. Only the correlated one remains → below minBranches.
			const sql =
				`select o.k,
					(select count(*) from a) as total_a,
					(select count(*) from b where b.fk = o.k) as nb
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		// ------------------------------------------------------------------
		// Wrapped subqueries: a correlated scalar aggregate nested inside a
		// scalar expression (coalesce / arithmetic) clusters as a branch, and
		// the wrapping expression is preserved around the rewritten column ref.
		// ------------------------------------------------------------------

		// total_v: sum→null for an outer with no `a` rows, so coalesce(...,0)
		// exercises the wrapper. nb: count→0 (never null) — coalesce is a no-op
		// but still wraps the inner subquery node.
		const wrapped2SQL =
			`select o.k,
				coalesce((select sum(a.v) from a where a.fk = o.k), 0) as total_v,
				coalesce((select count(*) from b where b.fk = o.k), -1) as nb
			 from outer_t o`;

		it('clusters two wrapped (coalesce) subqueries as atMostOne-left branches', async () => {
			await setupSubqueryTables('hi_lat_memory');
			const plan = await planRows(db, wrapped2SQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'atMostOne-left']);
		});

		it('clusters a mix of one wrapped + one bare subquery', async () => {
			await setupSubqueryTables('hi_lat_memory');
			const sql =
				`select o.k,
					coalesce((select sum(a.v) from a where a.fk = o.k), 0) as total_v,
					(select count(*) from b where b.fk = o.k) as nb
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'atMostOne-left']);
		});

		it('clusters two subqueries wrapped in a single projection expression', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// Both subqueries live inside ONE projection (the `+` expression) — the
			// per-projection walk must find both and cluster them as two branches.
			const sql =
				`select o.k,
					coalesce((select sum(a.v) from a where a.fk = o.k), 0)
						+ coalesce((select count(*) from b where b.fk = o.k), 0) as combined
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'atMostOne-left']);
		});

		forkExecTest('wrapped subquery result correctness: enabled vs disabled, coalesce applies on empty', async () => {
			await setupSubqueryTables('hi_lat_memory');
			const plan = await planRows(db, wrapped2SQL);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, wrapped2SQL + ' order by o.k');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let disabled: Record<string, SqlValue>[];
			try {
				disabled = await results(db, wrapped2SQL + ' order by o.k');
			} finally {
				db.optimizer.updateTuning(before);
			}

			expect(enabled).to.deep.equal(disabled);
			expect(enabled).to.deep.equal([
				// k=1: sum(a.v) = 100+101 = 201; count(b) = 2
				{ k: 1, total_v: 201, nb: 2 },
				// k=2: sum(a.v) = 200; count(b) = 0 (coalesce(0,-1) = 0, not -1)
				{ k: 2, total_v: 200, nb: 0 },
				// k=3: no `a` rows ⇒ sum→null ⇒ coalesce→0; count(b)=0
				{ k: 3, total_v: 0, nb: 0 },
			]);
		});

		forkExecTest('two-subqueries-in-one-projection result correctness', async () => {
			await setupSubqueryTables('hi_lat_memory');
			const sql =
				`select o.k,
					coalesce((select sum(a.v) from a where a.fk = o.k), 0)
						+ coalesce((select count(*) from b where b.fk = o.k), 0) as combined
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, sql + ' order by o.k');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({ ...before, disabledRules: new Set(['fanout-lookup-join']) });
			let disabled: Record<string, SqlValue>[];
			try {
				disabled = await results(db, sql + ' order by o.k');
			} finally {
				db.optimizer.updateTuning(before);
			}
			expect(enabled).to.deep.equal(disabled);
			expect(enabled).to.deep.equal([
				{ k: 1, combined: 203 }, // 201 + 2
				{ k: 2, combined: 200 }, // 200 + 0
				{ k: 3, combined: 0 },   // 0 + 0
			]);
		});

		it('GROUP BY subquery wrapped in coalesce is still rejected', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// The wrapped subquery has a GROUP BY (may yield >1 row) → rejected even
			// though it is reached through the coalesce wrapper. Only the bare second
			// subquery is recognizable, dropping below minBranches=2 → no fan-out.
			const sql =
				`select o.k,
					coalesce((select count(*) from a where a.fk = o.k group by a.v), 0) as x,
					(select count(*) from b where b.fk = o.k) as y
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		it('clusters a cast-wrapped subquery (exercises CastNode.withChildren)', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// `cast(...)` is a CastNode wrapper — a distinct withChildren path from
			// the coalesce (ScalarFunctionCall) / `+` (BinaryOp) cases above.
			const sql =
				`select o.k,
					cast((select count(*) from a where a.fk = o.k) as real) as ca,
					(select count(*) from b where b.fk = o.k) as nb
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'atMostOne-left']);
		});

		forkExecTest('wrapper mixing an outer column ref with a subquery resolves after rewrite', async () => {
			await setupSubqueryTables('hi_lat_memory');
			// The `mixed` projection references the OUTER column o.k *and* a subquery
			// in one wrapper. After rewrite only the inner subquery becomes a wide-row
			// colref; the o.k reference must still resolve against the wide row.
			const sql =
				`select o.k,
					o.k * 10 + coalesce((select count(*) from b where b.fk = o.k), 0) as mixed,
					coalesce((select sum(a.v) from a where a.fk = o.k), 0) as total_v
				 from outer_t o`;
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, sql + ' order by o.k');

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({ ...before, disabledRules: new Set(['fanout-lookup-join']) });
			let disabled: Record<string, SqlValue>[];
			try {
				disabled = await results(db, sql + ' order by o.k');
			} finally {
				db.optimizer.updateTuning(before);
			}
			expect(enabled).to.deep.equal(disabled);
			expect(enabled).to.deep.equal([
				{ k: 1, mixed: 12, total_v: 201 }, // 10 + 2 ; 100+101
				{ k: 2, mixed: 20, total_v: 200 }, // 20 + 0 ; 200
				{ k: 3, mixed: 30, total_v: 0 },   // 30 + 0 ; sum→null⇒0
			]);
		});
	});

	// ----------------------------------------------------------------------
	// Cross (1:n) lookup branches: equi-lookups that are NOT provably
	// at-most-one (no FK, or FK→non-unique) cluster as `cross` fan-out
	// branches. The output is the Cartesian product per outer row, bounded by
	// the `maxCrossBranchRows` / `maxCrossProduct` recognition guards.
	// ----------------------------------------------------------------------
	describe('cross (1:n) lookup branches', () => {
		// A 2-branch cross cluster sits at the cost-gate boundary under the outer
		// beforeEach cap=2 (N = cap ⇒ 0 savings). Drop the cap to 1 so 2 branches
		// surface a positive win `(2 - 1) × 25 = 25 > 2 × branchSetupCost` (mirrors
		// the subquery describe block).
		beforeEach(() => {
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, concurrency: 1 },
			});
		});

		/**
		 * One small outer table `p` and two child tables joined on a NON-key
		 * column (`pid`, no FK) → data-driven 1:n cardinality:
		 *   p=1 → b0∈{100,101}, b1∈{5}        (2 × 1 = 2 product rows)
		 *   p=2 → b0∈{200},     b1∈{6,7}      (1 × 2 = 2 product rows)
		 *   p=3 → no matches in either        (inner-drop, both branches empty)
		 *   p=4 → b0∈{400},     b1∈{}         (inner-drop, ONE branch empty)
		 */
		async function setupCross(child: 'memory' | 'hi_lat_memory'): Promise<void> {
			await db.exec(`create table p (id integer primary key, label text) using memory`);
			await db.exec(`create table b0 (id integer primary key, pid integer, v integer) using ${child}`);
			await db.exec(`create table b1 (id integer primary key, pid integer, w integer) using ${child}`);
			await db.exec("insert into p values (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four')");
			await db.exec('insert into b0 values (10, 1, 100), (11, 1, 101), (12, 2, 200), (13, 4, 400)');
			await db.exec('insert into b1 values (20, 1, 5), (21, 2, 6), (22, 2, 7)');
		}

		const crossSQL =
			`select p.id, b0.v, b1.w
			 from p
			 join b0 on p.id = b0.pid
			 join b1 on p.id = b1.pid`;

		/** Branch modes parsed from the fan-out node's logical properties. */
		function fanOutBranchModes(rows: readonly PlanRow[]): string[] {
			const fo = rows.find(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
			if (!fo || !fo.properties) return [];
			const props = JSON.parse(fo.properties) as { branches?: { mode: string }[] };
			return (props.branches ?? []).map(b => b.mode);
		}

		it('clusters a 1:n inner chain as cross branches and collapses the joins', async () => {
			await setupCross('hi_lat_memory');
			const plan = await planRows(db, crossSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['cross', 'cross']);
			expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		});

		it('does NOT cluster on local-only (memory) 1:n chains', async () => {
			// expectedLatencyMs=0 throughout → the cost gate rejects, same as the
			// at-most-one local-only case.
			await setupCross('memory');
			const plan = await planRows(db, crossSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		it('cross branch lookup is not wrapped in a CacheNode (re-executes per outer row)', async () => {
			// Cross branches are correlated (parameterized by the outer row), so the
			// materialization advisory must NOT cache them across outer rows — each
			// outer row re-executes the lookup, exactly like an NLJ inner. (The
			// advisory's correlated-subquery rule already excludes them; this is a
			// regression guard on that behaviour.)
			await setupCross('hi_lat_memory');
			const plan = await planRows(db, crossSQL);
			expect(hasFanOut(plan)).to.equal(true);
			expect(
				plan.some(r => r.op === 'CACHE' || r.node_type === 'Cache'),
				`ops=${plan.map(r => r.op).join(',')}`,
			).to.equal(false);
		});

		forkExecTest('cross fan-out returns the same multiset as the nested-loop chain', async () => {
			await setupCross('hi_lat_memory');
			const plan = await planRows(db, crossSQL);
			expect(hasFanOut(plan)).to.equal(true);
			const ordered = crossSQL + ' order by p.id, b0.v, b1.w';
			const enabled = await results(db, ordered);

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let baseline: Record<string, SqlValue>[];
			try {
				baseline = await results(db, ordered);
			} finally {
				db.optimizer.updateTuning(before);
			}

			expect(enabled).to.deep.equal(baseline);
			// p=3 (both branches empty) and p=4 (b1 branch empty) are dropped by
			// inner-drop semantics — neither appears in the product.
			expect(enabled).to.deep.equal([
				{ id: 1, v: 100, w: 5 },
				{ id: 1, v: 101, w: 5 },
				{ id: 2, v: 200, w: 6 },
				{ id: 2, v: 200, w: 7 },
			]);
		});

		// The fan-out forms with default tuning (verified above); the guard-trip
		// cases below tighten a cap so the same chain stays nested-loop. NOTE: the
		// synthetic memory-vtab fixtures resolve `estimatedRows` to 0 (no row-count
		// reaches the access plan), so the deterministic way to exercise the gate
		// is a sub-zero cap (0 > -1). In production the same comparison rejects a
		// real positive estimate that exceeds a positive cap.
		it('guard trips: product cap below the cross product leaves a nested-loop chain', async () => {
			await setupCross('hi_lat_memory');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, maxCrossProduct: -1 },
			});
			try {
				const plan = await planRows(db, crossSQL);
				expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
				expect(joinCount(plan)).to.be.greaterThan(0);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});

		it('guard trips: per-branch cap below the cross branch estimate leaves a nested-loop chain', async () => {
			await setupCross('hi_lat_memory');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, maxCrossBranchRows: -1 },
			});
			try {
				const plan = await planRows(db, crossSQL);
				expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
				expect(joinCount(plan)).to.be.greaterThan(0);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});

		/**
		 * A chain that mixes one at-most-one FK→PK branch (`m left join lk`) with
		 * one cross 1:n branch (`join c on m.id = c.mid`, no FK) → a single
		 * FanOutLookupJoin carrying both modes.
		 */
		async function setupMixed(): Promise<string> {
			await db.exec('create table lk (id integer primary key, name text) using hi_lat_memory');
			await db.exec(`create table m (
				id integer primary key,
				lk_id integer not null references lk(id)
			) using memory`);
			await db.exec('create table c (id integer primary key, mid integer, v integer) using hi_lat_memory');
			await db.exec("insert into lk values (1, 'Acme'), (2, 'Beta')");
			await db.exec('insert into m values (1, 1), (2, 2)');
			await db.exec('insert into c values (10, 1, 100), (11, 1, 101), (12, 2, 200)');
			return `select m.id, lk.name, c.v
				 from m
				 left join lk on m.lk_id = lk.id
				 join c on m.id = c.mid`;
		}

		it('mixed chain: one FK→PK at-most-one branch + one cross branch → single fan-out', async () => {
			const sql = await setupMixed();
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'cross']);
			expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		});

		forkExecTest('mixed chain result equals the nested-loop chain', async () => {
			const sql = await setupMixed();
			const ordered = sql + ' order by m.id, c.v';
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, ordered);

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let baseline: Record<string, SqlValue>[];
			try {
				baseline = await results(db, ordered);
			} finally {
				db.optimizer.updateTuning(before);
			}
			expect(enabled).to.deep.equal(baseline);
			expect(enabled).to.deep.equal([
				{ id: 1, name: 'Acme', v: 100 },
				{ id: 1, name: 'Acme', v: 101 },
				{ id: 2, name: 'Beta', v: 200 },
			]);
		});
	});

	// ----------------------------------------------------------------------
	// Cross-left (LEFT 1:n) lookup branches: a LEFT join whose non-preserved
	// side is a parameterized equi-lookup that is NOT provably at-most-one (no
	// FK, or FK→non-unique) folds into a `cross-left` branch. Unlike `cross`,
	// an outer row with zero matches is preserved once with NULL branch columns
	// (LEFT semantics), and the branch output attributes are nullable-widened.
	// ----------------------------------------------------------------------
	describe('cross-left (LEFT 1:n) lookup branches', () => {
		// Mirror the cross block: drop the cap to 1 so a 2-branch cluster surfaces
		// a positive cost-gate win `(2 - 1) × 25 = 25 > 2 × branchSetupCost`.
		beforeEach(() => {
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, concurrency: 1 },
			});
		});

		/** Branch modes parsed from the fan-out node's logical properties. */
		function fanOutBranchModes(rows: readonly PlanRow[]): string[] {
			const fo = rows.find(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
			if (!fo || !fo.properties) return [];
			const props = JSON.parse(fo.properties) as { branches?: { mode: string }[] };
			return (props.branches ?? []).map(b => b.mode);
		}

		/**
		 * One small outer table `p` and two child tables LEFT-joined on a NON-key
		 * column (`pid`, no FK) → data-driven 1:n cardinality with LEFT preservation:
		 *   p=1 → b0∈{100,101}, b1∈{5}   (2 × 1 = 2 product rows)
		 *   p=2 → b0∈{200},     b1∈{6,7} (1 × 2 = 2 product rows)
		 *   p=3 → no matches in either   (preserved once, both branch cols NULL)
		 *   p=4 → b0∈{400},     b1∈{}    (b0 product × NULL-padded b1 → 1 row)
		 */
		async function setupCrossLeft(child: 'memory' | 'hi_lat_memory'): Promise<void> {
			await db.exec(`create table p (id integer primary key, label text) using memory`);
			await db.exec(`create table b0 (id integer primary key, pid integer, v integer) using ${child}`);
			await db.exec(`create table b1 (id integer primary key, pid integer, w integer) using ${child}`);
			await db.exec("insert into p values (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four')");
			await db.exec('insert into b0 values (10, 1, 100), (11, 1, 101), (12, 2, 200), (13, 4, 400)');
			await db.exec('insert into b1 values (20, 1, 5), (21, 2, 6), (22, 2, 7)');
		}

		const crossLeftSQL =
			`select p.id, b0.v, b1.w
			 from p
			 left join b0 on p.id = b0.pid
			 left join b1 on p.id = b1.pid`;

		it('clusters a 1:n LEFT chain as cross-left branches and collapses the joins', async () => {
			await setupCrossLeft('hi_lat_memory');
			const plan = await planRows(db, crossLeftSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['cross-left', 'cross-left']);
			expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		});

		it('does NOT cluster on local-only (memory) 1:n LEFT chains', async () => {
			await setupCrossLeft('memory');
			const plan = await planRows(db, crossLeftSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});

		forkExecTest('cross-left fan-out preserves empty-match outer rows with NULL branch columns', async () => {
			await setupCrossLeft('hi_lat_memory');
			const plan = await planRows(db, crossLeftSQL);
			expect(hasFanOut(plan)).to.equal(true);
			const ordered = crossLeftSQL + ' order by p.id, b0.v, b1.w';
			const enabled = await results(db, ordered);

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let baseline: Record<string, SqlValue>[];
			try {
				baseline = await results(db, ordered);
			} finally {
				db.optimizer.updateTuning(before);
			}

			expect(enabled).to.deep.equal(baseline);
			// p=3 (both branches empty) is preserved with NULL,NULL; p=4 (b1 empty)
			// keeps its b0 row with a NULL b1 — neither is dropped (LEFT semantics).
			expect(enabled).to.deep.equal([
				{ id: 1, v: 100, w: 5 },
				{ id: 1, v: 101, w: 5 },
				{ id: 2, v: 200, w: 6 },
				{ id: 2, v: 200, w: 7 },
				{ id: 3, v: null, w: null },
				{ id: 4, v: 400, w: null },
			]);
		});

		it('guard trips: product cap below the cross product leaves a nested-loop chain', async () => {
			await setupCrossLeft('hi_lat_memory');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, maxCrossProduct: -1 },
			});
			try {
				const plan = await planRows(db, crossLeftSQL);
				expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
				expect(joinCount(plan)).to.be.greaterThan(0);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});

		it('guard trips: per-branch cap below the cross-left branch estimate leaves a nested-loop chain', async () => {
			await setupCrossLeft('hi_lat_memory');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, maxCrossBranchRows: -1 },
			});
			try {
				const plan = await planRows(db, crossLeftSQL);
				expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
				expect(joinCount(plan)).to.be.greaterThan(0);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});

		/**
		 * A chain mixing all three relational modes:
		 *   m left join lk  → atMostOne-left (FK→PK, NOT NULL)
		 *   m join c        → cross           (inner, no FK)
		 *   m left join d   → cross-left       (left, no FK)
		 * c always matches (so the cross branch never drops); d misses for m=2 so
		 * cross-left's NULL preservation shows.
		 */
		async function setupMixedLeft(): Promise<string> {
			await db.exec('create table lk (id integer primary key, name text) using hi_lat_memory');
			await db.exec(`create table m (
				id integer primary key,
				lk_id integer not null references lk(id)
			) using memory`);
			await db.exec('create table c (id integer primary key, mid integer, v integer) using hi_lat_memory');
			await db.exec('create table d (id integer primary key, mid integer, w integer) using hi_lat_memory');
			await db.exec("insert into lk values (1, 'Acme'), (2, 'Beta')");
			await db.exec('insert into m values (1, 1), (2, 2)');
			await db.exec('insert into c values (10, 1, 100), (11, 1, 101), (12, 2, 200)');
			await db.exec('insert into d values (20, 1, 7)'); // no row for m=2
			return `select m.id, lk.name, c.v, d.w
				 from m
				 left join lk on m.lk_id = lk.id
				 join c on m.id = c.mid
				 left join d on m.id = d.mid`;
		}

		it('mixed chain: atMostOne-left + cross + cross-left → single fan-out', async () => {
			const sql = await setupMixedLeft();
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutBranchModes(plan)).to.deep.equal(['atMostOne-left', 'cross', 'cross-left']);
			expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		});

		forkExecTest('mixed chain result equals the nested-loop chain (incl. cross-left NULL pad)', async () => {
			const sql = await setupMixedLeft();
			const ordered = sql + ' order by m.id, c.v, d.w';
			const plan = await planRows(db, sql);
			expect(hasFanOut(plan)).to.equal(true);
			const enabled = await results(db, ordered);

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				disabledRules: new Set(['fanout-lookup-join']),
			});
			let baseline: Record<string, SqlValue>[];
			try {
				baseline = await results(db, ordered);
			} finally {
				db.optimizer.updateTuning(before);
			}
			expect(enabled).to.deep.equal(baseline);
			expect(enabled).to.deep.equal([
				{ id: 1, name: 'Acme', v: 100, w: 7 },
				{ id: 1, name: 'Acme', v: 101, w: 7 },
				{ id: 2, name: 'Beta', v: 200, w: null },
			]);
		});
	});
});
