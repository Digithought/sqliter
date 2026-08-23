/**
 * Aggregate-rollup arm of the automatic materialized-view query rewrite
 * (`mv-query-rewrite-aggregate-rollup`) — matcher unit tests. Recognizes when a
 * `group by g…, agg(…)` query is answered from a grouped MV: exact-key (scan the
 * backing directly) or superset-key rollup (re-aggregate the backing down to the
 * query's coarser key). Drives the matcher directly so per-reason outcomes are
 * observable, mirroring `query-rewrite.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { DEFAULT_TUNING } from '../src/planner/optimizer.js';
import { PlanNodeType } from '../src/planner/nodes/plan-node-type.js';
import type { RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import type { SqlValue } from '../src/common/types.js';
import { serializePlanTree } from '../src/planner/debug.js';
import { createAggregateFunction } from '../src/func/registration.js';
import { isAggregateFunctionSchema } from '../src/schema/function.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import {
	matchAggregateMaterializedViewRewrite,
	type RewriteResult,
	type DeterminismProbe,
	type AggregateResolver,
} from '../src/planner/analysis/query-rewrite-matcher.js';

const ALL_DETERMINISTIC: DeterminismProbe = () => true;

/** Resolve an aggregate's schema by (name, argc) off the live registry — the same probe
 *  the rule threads into the matcher, so the unit tests exercise the real algebra source. */
function aggResolver(db: Database): AggregateResolver {
	return (name, argc) => {
		const fn = db.schemaManager.findFunction(name, argc) ?? db.schemaManager.findFunction(name, -1);
		return fn && isAggregateFunctionSchema(fn) ? fn : undefined;
	};
}

/** Rules that would either rewrite the fragment, lower the logical Aggregate to a
 *  physical Stream/Hash node, simplify/reposition the GROUP BY, or move the WHERE —
 *  disabling them yields the pristine logical `Aggregate(Filter?(scan(...)))` the
 *  matcher reads. */
const AGG_SHAPE_RULES = new Set<string>([
	'materialized-view-rewrite',
	'materialized-view-rewrite-aggregate',
	'aggregate-physical',
	'groupby-fd-simplification',
	'predicate-pushdown',
	'aggregate-predicate-pushdown',
	'filter-merge',
	'sargable-range-rewrite',
	'predicate-inference-equivalence',
	...[
		PlanNodeType.Filter, PlanNodeType.Project, PlanNodeType.Sort, PlanNodeType.LimitOffset,
		PlanNodeType.Aggregate, PlanNodeType.Distinct, PlanNodeType.Join, PlanNodeType.Window,
	].map(t => `grow-retrieve-${t}`),
]);

async function freshDb(ddl: string[]): Promise<Database> {
	const db = new Database();
	for (const stmt of ddl) await db.exec(stmt);
	return db;
}

/** A pristine logical `Aggregate(Filter?(scan(...)))` fragment for the matcher. */
function pristineAggregateFragment(db: Database, sql: string): RelationalPlanNode {
	const prev = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: AGG_SHAPE_RULES });
	try {
		const root = db.getPlan(sql).getRelations()[0];
		expect(root, 'fragment produced a relation').to.not.be.undefined;
		return root as RelationalPlanNode;
	} finally {
		db.optimizer.updateTuning(prev);
	}
}

function matchAgg(db: Database, sql: string, mvName: string, isDet: DeterminismProbe = ALL_DETERMINISTIC): RewriteResult {
	const root = pristineAggregateFragment(db, sql);
	const mv = db.schemaManager.getMaintainedTable('main', mvName)!;
	// The maintained table IS its own backing in the unified model.
	const backing = db.schemaManager.getTable('main', mv.name);
	return matchAggregateMaterializedViewRewrite(root, mv, backing, isDet, aggResolver(db));
}

const SALES = [
	'create table sales (id integer primary key, d integer not null, r integer not null, amt integer null)',
	// A grouped MV over (d, r) storing the decomposable partials sum/count(*)/count(amt)/min/max.
	'create materialized view byregion as select d, r, sum(amt) as total, count(*) as cnt, '
		+ 'count(amt) as cntamt, min(amt) as mn, max(amt) as mx from sales group by d, r',
];

function reason(res: RewriteResult): string | undefined {
	return (res as { reason?: string }).reason;
}

/** Read `sql` end-to-end, capturing declared column names and positional row values. */
async function readPositional(db: Database, sql: string): Promise<{ columns: string[]; rows: string[] }> {
	const stmt = db.prepare(sql);
	try {
		const rows: string[] = [];
		for await (const row of stmt.iterateRows()) rows.push(JSON.stringify(Object.values(row) as SqlValue[]));
		return { columns: stmt.getColumnNames(), rows };
	} finally {
		await stmt.finalize();
	}
}

/**
 * Assert the aggregate rewrite is a faithful drop-in for `sql`: it actually fires over
 * `mvName`, and its column names/order and row values (positional, compared as a
 * multiset since neither side is ordered) match the base recompute exactly.
 */
async function expectBaseViewAgreement(db: Database, sql: string, mvName: string): Promise<void> {
	db.optimizer.updateTuning(DEFAULT_TUNING);
	const withRewrite = await readPositional(db, sql);
	// The rewrite must actually fire — else this vacuously compares two base recomputes.
	expect(serializePlanTree(db.getPlan(sql)), 'rewrite fired over the MV').to.contain(`"name": "${mvName}"`);

	db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite-aggregate']) });
	try {
		const withoutRewrite = await readPositional(db, sql);
		expect(withRewrite.columns, 'column names/order must agree').to.deep.equal(withoutRewrite.columns);
		expect([...withRewrite.rows].sort(), 'row values (positional) must agree')
			.to.deep.equal([...withoutRewrite.rows].sort());
	} finally {
		db.optimizer.updateTuning(DEFAULT_TUNING);
	}
}

describe('aggregate-rollup matcher — exact-key', () => {
	it('exact-key match (query group key == MV group key) ⇒ direct scan, no re-aggregation', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, r, sum(amt) from sales group by d, r', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(true);
			expect(res.match!.residualConjuncts).to.be.empty;
			// d, r, sum(amt) all resolve to backing columns.
			expect(res.match!.outputColumnMap).to.have.lengthOf(3);
		} finally {
			await db.close();
		}
	});

	it('exact-key with a range residual on a group-key column', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, r, sum(amt) from sales where r >= 10 group by d, r', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(true);
			expect(res.match!.residualConjuncts).to.have.lengthOf(1);
		} finally {
			await db.close();
		}
	});

	it('exact-key min/max passthrough', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, r, min(amt), max(amt) from sales group by d, r', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(true);
		} finally {
			await db.close();
		}
	});
});

describe('aggregate-rollup matcher — rollup (superset key)', () => {
	it('rollup sum: re-aggregate sum(stored sum)', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, sum(amt) from sales group by d', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(false);
			expect(res.match!.rollup!.aggregates).to.have.lengthOf(1);
			const recipe = res.match!.rollup!.aggregates[0];
			expect(recipe.kind).to.equal('merge');
			// sum re-aggregates its own stored partial via its declared merge/decode.
			if (recipe.kind === 'merge') expect(recipe.reagg.schema.name).to.equal('sum');
		} finally {
			await db.close();
		}
	});

	it('rollup count(*): re-aggregate as sum(stored count)', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, count(*) from sales group by d', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			const recipe = res.match!.rollup!.aggregates[0];
			expect(recipe.kind).to.equal('merge');
			// count re-aggregates its stored count partial via count's declared merge/decode
			// (a sum-of-counts); the empty-group 0 comes from finalize(identity), not a coalesce.
			if (recipe.kind === 'merge') expect(recipe.reagg.schema.name).to.equal('count');
		} finally {
			await db.close();
		}
	});

	it('rollup avg: recombine from stored sum + count(amt)', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, avg(amt) from sales group by d', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			const recipe = res.match!.rollup!.aggregates[0];
			expect(recipe.kind).to.equal('compose');
			// avg composes from two stored partials: sum(amt) and count(amt).
			if (recipe.kind === 'compose') {
				expect(recipe.partials).to.have.lengthOf(2);
				expect(recipe.partials.map(p => p.schema.name)).to.deep.equal(['sum', 'count']);
			}
		} finally {
			await db.close();
		}
	});

	it('global-scalar rollup: re-aggregate every backing row into one group', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select sum(amt) from sales', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(false);
			expect(res.match!.rollup!.groupKeyBackingCols).to.be.empty;
		} finally {
			await db.close();
		}
	});

	it('rollup avg from stored sum + count(*) when the column is NOT NULL', async () => {
		// `r` is NOT NULL, so count(*) excludes the same (zero) NULLs avg(r) would.
		const db = await freshDb([
			'create table t (id integer primary key, k integer not null, r integer not null)',
			'create materialized view mv as select k, r, sum(r) as sr, count(*) as c from t group by k, r',
		]);
		try {
			const res = matchAgg(db, 'select k, avg(r) from t group by k', 'mv');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			const recipe = res.match!.rollup!.aggregates[0];
			expect(recipe.kind).to.equal('compose');
			// The count partial falls back to the stored count(*) — sound because `r` is NOT NULL.
			if (recipe.kind === 'compose') expect(recipe.partials.map(p => p.schema.name)).to.deep.equal(['sum', 'count']);
		} finally {
			await db.close();
		}
	});

	it('rollup avg forgone when only count(*) is stored and the column is nullable', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, k integer not null, x integer null)',
			'create materialized view mv as select k, x, sum(x) as sx, count(*) as c from t group by k, x',
		]);
		try {
			// count(*) counts NULL x rows; avg(x) excludes them — recombine would be wrong, so forgo.
			const res = matchAgg(db, 'select k, avg(x) from t group by k', 'mv');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('aggregate-not-decomposable');
		} finally {
			await db.close();
		}
	});
});

describe('aggregate-rollup matcher — per-reason negatives', () => {
	it('aggregate-not-decomposable: count(distinct) under rollup', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, count(distinct amt) from sales group by d', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('aggregate-not-decomposable');
		} finally {
			await db.close();
		}
	});

	it('aggregate-not-decomposable: group_concat under rollup', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, group_concat(amt) from sales group by d', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('aggregate-not-decomposable');
		} finally {
			await db.close();
		}
	});

	it('missing-column: a WHERE on a non-group column cannot be applied post-materialization', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d, sum(amt) from sales where amt > 5 group by d', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('missing-column');
		} finally {
			await db.close();
		}
	});

	it('group-key-mismatch: query group key is not a subset of the MV group key', async () => {
		const db = await freshDb(SALES);
		try {
			// group by amt (not a member of the MV's {d, r} key).
			const res = matchAgg(db, 'select amt, sum(d) from sales group by amt', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('group-key-mismatch');
		} finally {
			await db.close();
		}
	});

	it('aggregate-shape: a computed group key is unrecoverable', async () => {
		const db = await freshDb(SALES);
		try {
			const res = matchAgg(db, 'select d + 1, sum(amt) from sales group by d + 1', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('aggregate-shape');
		} finally {
			await db.close();
		}
	});

	it('rollup-residual: a rollup with a residual on a dropped MV group key matches (filter on the backing)', async () => {
		const db = await freshDb(SALES);
		try {
			// `r` is a group key of the MV but not of the query (rollup); the residual r=20
			// references a stored group-key column, so it re-binds onto the backing as a
			// residual Filter before the re-aggregate down to {d}. The base filter-drop bug
			// this used to dodge is fixed, so the match now proceeds.
			const res = matchAgg(db, 'select d, sum(amt) from sales where r = 20 group by d', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(false);
			expect(res.match!.residualConjuncts).to.have.lengthOf(1);
			const recipe = res.match!.rollup!.aggregates[0];
			expect(recipe.kind).to.equal('merge');
			if (recipe.kind === 'merge') expect(recipe.reagg.schema.name).to.equal('sum');
		} finally {
			await db.close();
		}
	});

	it('group-key-pinned base/view agreement: a multi-key query pinning a group column now matches, and the rewrite agrees with the base recompute on column order and row values', async () => {
		const db = await freshDb(SALES);
		try {
			const sql = 'select d, r, sum(amt) from sales where d = 1 group by d, r';

			// The base's column-order divergence this guard used to dodge is fixed
			// (bug-grouped-key-reorder-survives-to-output), so the match now succeeds.
			const res = matchAgg(db, sql, 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(true);

			await db.exec(
				'insert into sales (id, d, r, amt) values (1, 1, 1, 10), (2, 1, 2, 20), (3, 2, 1, 30), (4, 2, 2, null)',
			);
			await expectBaseViewAgreement(db, sql, 'byregion');
		} finally {
			await db.close();
		}
	});

	it('group-key-equated base/view agreement: a multi-key query equating two group columns (g1 = g2) agrees with the base recompute', async () => {
		const db = await freshDb(SALES);
		try {
			// `eq-column` was the other shape the retired guard forwent; it also gives the
			// base a determining FD between two group keys, so it exercises a distinct
			// simplification path from the `eq-literal` pin above.
			const sql = 'select d, r, sum(amt) from sales where d = r group by d, r';
			const res = matchAgg(db, sql, 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(true);

			await db.exec(
				'insert into sales (id, d, r, amt) values (1, 1, 1, 10), (2, 1, 2, 20), (3, 2, 2, 30), (4, 2, 1, null)',
			);
			await expectBaseViewAgreement(db, sql, 'byregion');
		} finally {
			await db.close();
		}
	});

	it('group-key-pinned under a rollup: a 2-key query pinning a group column over a 3-key MV rolls up and agrees with the base recompute', async () => {
		// The retired guard read the *query* group set, so it forwent rollups too — this
		// covers the pinned shape where the query key is a strict subset of the MV key.
		const db = await freshDb([
			'create table s3 (id integer primary key, d integer not null, r integer not null, x integer not null, amt integer null)',
			'create materialized view by3 as select d, r, x, sum(amt) as total, count(*) as cnt from s3 group by d, r, x',
		]);
		try {
			const sql = 'select d, r, sum(amt) from s3 where d = 1 group by d, r';
			const res = matchAgg(db, sql, 'by3');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(false);
			expect(res.match!.residualConjuncts).to.have.lengthOf(1);

			await db.exec(
				'insert into s3 (id, d, r, x, amt) values (1, 1, 1, 7, 10), (2, 1, 1, 8, 20), '
					+ '(3, 1, 2, 7, 30), (4, 2, 1, 7, 40), (5, 1, 2, 8, null)',
			);
			await expectBaseViewAgreement(db, sql, 'by3');
		} finally {
			await db.close();
		}
	});

	it('source-mismatch: MV reads a different base table', async () => {
		const db = await freshDb([
			...SALES,
			'create table other (id integer primary key, d integer not null, amt integer null)',
			'create materialized view othermv as select d, sum(amt) as total from other group by d',
		]);
		try {
			const res = matchAgg(db, 'select d, sum(amt) from sales group by d', 'othermv');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('source-mismatch');
		} finally {
			await db.close();
		}
	});

	it('no-candidate: a stale MV is never matched', async () => {
		const db = await freshDb(SALES);
		try {
			await db.exec('alter table sales alter column amt set data type real');
			expect(db.schemaManager.getMaintainedTable('main', 'byregion')!.derivation.stale).to.equal(true);
			const res = matchAgg(db, 'select d, sum(amt) from sales group by d', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('no-candidate');
		} finally {
			await db.close();
		}
	});
});

/* ── User-defined aggregate rollup (the retarget's headline win) ────────────────
 * The rollup matcher is driven by declared `AggregateAlgebra`, not a builtin-name
 * list — so a UDAF that declares algebra rolls up through an MV for free. `bit_xor`
 * is an abelian-group integer aggregate (xor is its own inverse) declaring
 * `merge` + `decode`, so it takes the directly-mergeable path exactly like `sum`. */

/** Register the `bit_xor` UDAF (mirrors the delta-aggregate suite's `xorSchema`). */
function registerBitXor(db: Database): void {
	db.registerFunction(createAggregateFunction(
		{
			name: 'bit_xor', numArgs: 1, initialValue: 0,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
			algebra: {
				merge: (a: number, b: number): number => a ^ b,
				negate: (a: number): number => a, // xor is its own inverse
				decode: (stored: SqlValue): number => Number(stored),
				decodeExact: true,
			},
		},
		(acc: number, v: SqlValue): number => (v === null ? acc : acc ^ Number(v)),
		(acc: number): number => acc,
	));
}

const XOR_DDL = [
	'create table ev (id integer primary key, d integer not null, r integer not null, v integer not null)',
	'create materialized view byreg as select d, r, bit_xor(v) as bx from ev group by d, r',
];

describe('aggregate-rollup matcher — user-defined aggregate algebra', () => {
	it('a UDAF declaring algebra rolls up through an MV (directly-mergeable recipe, no name list)', async () => {
		const db = new Database();
		registerBitXor(db);
		for (const stmt of XOR_DDL) await db.exec(stmt);
		try {
			const res = matchAgg(db, 'select d, bit_xor(v) from ev group by d', 'byreg');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(false);
			const recipe = res.match!.rollup!.aggregates[0];
			expect(recipe.kind).to.equal('merge');
			if (recipe.kind === 'merge') expect(recipe.reagg.schema.name).to.equal('bit_xor');
		} finally {
			await db.close();
		}
	});

	it('the rolled-up UDAF executes identically to the base recompute (end-to-end)', async () => {
		const db = new Database();
		registerBitXor(db);
		for (const stmt of XOR_DDL) await db.exec(stmt);
		try {
			// (d, r) groups with several rows each so the rollup to {d} folds multiple stored partials.
			const rows: [number, number, number, number][] = [
				[1, 1, 10, 5], [2, 1, 10, 6], [3, 1, 20, 7], [4, 2, 20, 3], [5, 2, 30, 9], [6, 2, 30, 9],
			];
			for (const [id, d, r, v] of rows) await db.exec(`insert into ev (id, d, r, v) values (${id}, ${d}, ${r}, ${v})`);

			const q = 'select d, bit_xor(v) as x from ev group by d order by d';
			const read = async (): Promise<string[]> => {
				const out: string[] = [];
				for await (const row of db.eval(q)) out.push(JSON.stringify(Object.values(row) as SqlValue[]));
				return out;
			};

			db.optimizer.updateTuning(DEFAULT_TUNING);
			const on = await read();
			// The rollup must actually fire — else this vacuously compares two base recomputes.
			expect(serializePlanTree(db.getPlan(q)), 'rollup fired over the UDAF MV').to.contain('"name": "byreg"');

			db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) });
			const off = await read();
			db.optimizer.updateTuning(DEFAULT_TUNING);

			expect(on, 'rolled-up UDAF diverged from base recompute').to.deep.equal(off);
		} finally {
			await db.close();
		}
	});
});

/* ── Function identity (`function-rebound`) ─────────────────────────────────────
 * Function registration overwrites by (name, argument count), so an application
 * registering its own `sum/1` re-points the name for every later query on that
 * connection — while the MV's backing still holds the numbers the PREVIOUS
 * registration produced. Matching on the name alone would serve those stale numbers.
 * The matcher therefore compares the live resolution against
 * `derivation.bodyFunctions` (captured at registration) by object identity. */

/**
 * Register a deterministic aggregate `name/numArgs` that COUNTS rows — deliberately not
 * a sum, so serving a stored `sum(x)` in its place is visibly wrong. It declares a full
 * merge/decode algebra (adding counts is a commutative monoid, and the stored count IS
 * the accumulator), so it reaches the identity gate on the rollup path too instead of
 * declining earlier as `aggregate-not-decomposable`.
 */
function registerRowCounter(db: Database, name: string, numArgs = 1): void {
	db.registerFunction(createAggregateFunction(
		{
			name, numArgs, initialValue: 0, deterministic: true,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
			algebra: {
				merge: (a: number, b: number): number => a + b,
				decode: (stored: SqlValue): number => Number(stored ?? 0),
				decodeExact: true,
			},
		},
		(acc: number, _v: SqlValue): number => acc + 1,
		(acc: number): number => acc,
	));
}

/** Register a deterministic aggregate `name/1` that SUMS, carrying sum's algebra — the
 *  "original" implementation arm B swaps out from under an already-built MV. */
function registerUserSum(db: Database, name: string): void {
	db.registerFunction(createAggregateFunction(
		{
			name, numArgs: 1, initialValue: 0, deterministic: true,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
			algebra: {
				merge: (a: number, b: number): number => a + b,
				decode: (stored: SqlValue): number => Number(stored ?? 0),
			},
		},
		(acc: number, v: SqlValue): number => (v === null ? acc : acc + Number(v)),
		(acc: number): number => acc,
	));
}

const IDENTITY_DDL = [
	'create table ti (id integer primary key, k integer not null, x integer not null)',
	'create materialized view mvi as select k, sum(x) as s from ti group by k',
];

/** Rows whose per-group SUM (30 / 30) differs from their per-group ROW COUNT (2 / 1), so
 *  a stale passthrough is distinguishable from the shadow's real answer. */
const IDENTITY_ROWS = 'insert into ti (id, k, x) values (1, 1, 10), (2, 1, 20), (3, 2, 30)';

describe('aggregate-rollup matcher — function identity', () => {
	it('function-rebound: a shadowed built-in sum declines the exact-key passthrough', async () => {
		const db = await freshDb(IDENTITY_DDL);
		try {
			// Matches before the shadow — the capture and the live registry agree.
			expect(matchAgg(db, 'select k, sum(x) from ti group by k', 'mvi').match,
				'matched before the shadow').to.not.be.undefined;

			registerRowCounter(db, 'sum');

			const res = matchAgg(db, 'select k, sum(x) from ti group by k', 'mvi');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('function-rebound');
		} finally {
			await db.close();
		}
	});

	it('function-rebound: a shadowed built-in sum declines the rollup re-aggregation too', async () => {
		const db = await freshDb(IDENTITY_DDL);
		try {
			// The global-scalar rollup (the empty query key is a strict subset of the MV's
			// {k}) folds the stored partials back together.
			expect(matchAgg(db, 'select sum(x) from ti', 'mvi').match,
				'rolled up before the shadow').to.not.be.undefined;

			registerRowCounter(db, 'sum');

			const res = matchAgg(db, 'select sum(x) from ti', 'mvi');
			expect(res.match).to.be.undefined;
			// Not `aggregate-not-decomposable`: the shadow DOES declare merge/decode, so the
			// rollup is expressible — it is the identity mismatch that declines it.
			expect(reason(res)).to.equal('function-rebound');
		} finally {
			await db.close();
		}
	});

	it('function-rebound: one user aggregate re-registered as another declines (no built-in involved)', async () => {
		const db = new Database();
		registerUserSum(db, 'myagg');
		await db.exec('create table tb (id integer primary key, k integer not null, x integer not null)');
		await db.exec('create materialized view mvb as select k, myagg(x) as s from tb group by k');
		try {
			expect(matchAgg(db, 'select k, myagg(x) from tb group by k', 'mvb').match,
				'matched while the original registration was live').to.not.be.undefined;

			registerRowCounter(db, 'myagg'); // same name/arity, different meaning

			const res = matchAgg(db, 'select k, myagg(x) from tb group by k', 'mvb');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('function-rebound');
		} finally {
			await db.close();
		}
	});

	it('a view over a user aggregate that is STILL the live registration keeps matching', async () => {
		const db = new Database();
		registerRowCounter(db, 'sum'); // taken over BEFORE the view is built — the view stores ITS output
		for (const stmt of IDENTITY_DDL) await db.exec(stmt);
		try {
			const exact = matchAgg(db, 'select k, sum(x) from ti group by k', 'mvi');
			expect(exact.match, `exact-key matched (${reason(exact)})`).to.not.be.undefined;
			expect(exact.match!.rollup!.exact).to.equal(true);

			const rollup = matchAgg(db, 'select sum(x) from ti', 'mvi');
			expect(rollup.match, `rollup matched (${reason(rollup)})`).to.not.be.undefined;
			expect(rollup.match!.rollup!.exact).to.equal(false);
		} finally {
			await db.close();
		}
	});

	it('a shadow at a different arity (sum/2) leaves sum/1 and its rewrite alone', async () => {
		const db = await freshDb(SALES);
		try {
			registerRowCounter(db, 'sum', 2);
			const res = matchAgg(db, 'select d, r, sum(amt) from sales group by d, r', 'byregion');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.rollup!.exact).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('function-rebound: an avg rollup declines when a stored PARTIAL was re-registered', async () => {
		// avg never appears in the body — it recombines the stored sum/count partials. The
		// gate therefore has to fire on a partial, not on the composed aggregate: the
		// `resolveMergeablePartial` arm, distinct from the direct-merge arm above.
		const db = await freshDb(SALES);
		try {
			expect(matchAgg(db, 'select d, avg(amt) from sales group by d', 'byregion').match,
				'composed from stored sum + count before the shadow').to.not.be.undefined;

			registerRowCounter(db, 'sum'); // declares merge/decode, so it clears the decomposability check

			const res = matchAgg(db, 'select d, avg(amt) from sales group by d', 'byregion');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('function-rebound');
		} finally {
			await db.close();
		}
	});

	it('a shadow declines only the views that store the shadowed name', async () => {
		const db = await freshDb([
			...IDENTITY_DDL,
			'create materialized view mvc as select k, count(*) as c from ti group by k',
		]);
		try {
			registerRowCounter(db, 'sum');

			const shadowed = matchAgg(db, 'select k, sum(x) from ti group by k', 'mvi');
			expect(shadowed.match).to.be.undefined;
			expect(reason(shadowed)).to.equal('function-rebound');

			// `mvc` stores count(*), which nothing re-registered — its rewrite is untouched.
			const untouched = matchAgg(db, 'select k, count(*) from ti group by k', 'mvc');
			expect(untouched.match, `matched (${reason(untouched)})`).to.not.be.undefined;
			expect(untouched.match!.rollup!.exact).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('end-to-end: after a shadow the covered and uncovered spellings agree, and the rewrite stands down', async () => {
		const db = await freshDb(IDENTITY_DDL);
		try {
			await db.exec(IDENTITY_ROWS);
			registerRowCounter(db, 'sum');
			db.optimizer.updateTuning(DEFAULT_TUNING);

			// `sum(x)` is covered by the MV; `sum(id)` is not (id is neither stored nor the
			// MV's aggregated column). Under the shadow both must be the per-group row count.
			const covered = await readPositional(db, 'select k, sum(x) as v from ti group by k');
			const uncovered = await readPositional(db, 'select k, sum(id) as v from ti group by k');
			expect([...covered.rows].sort(), 'covered spelling must equal the uncovered one')
				.to.deep.equal([...uncovered.rows].sort());
			expect([...covered.rows].sort()).to.deep.equal(['[1,2]', '[2,1]']);

			// And it is the base recompute answering, not the backing.
			expect(serializePlanTree(db.getPlan('select k, sum(x) as v from ti group by k')),
				'the rewrite must stand down').to.not.contain('"name": "mvi"');
		} finally {
			await db.close();
		}
	});
});
