/**
 * Automatic materialized-view query rewrite (read side) — matcher unit tests +
 * end-to-end rewrite/row checks. The matcher
 * (`planner/analysis/query-rewrite-matcher.ts`) recognizes when an arbitrary
 * scan-projection-filter query is answered from a covering MV; the rule
 * (`planner/rules/cache/rule-materialized-view-rewrite.ts`) turns a match into a
 * backing-table scan. Drives the matcher directly so per-reason outcomes are
 * observable, mirroring `covering-structure.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { DEFAULT_TUNING } from '../src/planner/optimizer.js';
import { serializePlanTree } from '../src/planner/debug.js';
import { PlanNodeType } from '../src/planner/nodes/plan-node-type.js';
import type { RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import {
	analyzeQueryFragment,
	matchFragmentToMv,
	type RewriteResult,
	type DeterminismProbe,
} from '../src/planner/analysis/query-rewrite-matcher.js';

const ALL_DETERMINISTIC: DeterminismProbe = () => true;

/** Rules that move/absorb the WHERE Filter relative to the table access; disabling
 *  them (plus the rewrite itself) yields the pristine `Project(Filter?(scan(...)))`
 *  fragment the matcher is designed for. */
const SHAPE_RULES = new Set<string>([
	'materialized-view-rewrite',
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

/** A pristine `Project(Filter?(scan(TableReference)))` fragment for the matcher. */
function pristineFragment(db: Database, sql: string): RelationalPlanNode {
	const prev = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: SHAPE_RULES });
	try {
		const root = db.getPlan(sql).getRelations()[0];
		expect(root, 'fragment produced a relation').to.not.be.undefined;
		return root as RelationalPlanNode;
	} finally {
		db.optimizer.updateTuning(prev);
	}
}

/** Match `sql` (planned pristine) against the named MV. */
function match(db: Database, sql: string, mvName: string, isDet: DeterminismProbe = ALL_DETERMINISTIC): RewriteResult {
	const frag = analyzeQueryFragment(pristineFragment(db, sql));
	expect(frag.ok, `fragment analyzable (${(frag as { reason?: string }).reason ?? ''})`).to.be.true;
	if (!frag.ok) throw new Error('unreachable');
	const mv = db.schemaManager.getMaintainedTable('main', mvName)!;
	// The maintained table IS its own backing in the unified model.
	const backing = db.schemaManager.getTable('main', mv.name);
	return matchFragmentToMv(frag.shape, mv, backing, isDet);
}

async function readRows(db: Database, sql: string): Promise<string> {
	const rows: string[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(JSON.stringify(Object.values(row), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
	}
	return rows.sort().join('|');
}

const SALES = [
	'create table sales (id integer primary key, customer_id integer not null, amt integer not null)',
	'insert into sales values (1,7,10),(2,7,-3),(3,9,5),(4,7,20),(5,9,-1),(6,7,0)',
];

describe('query-rewrite matcher — positive', () => {
	it('fragment WHERE ⊇ MV WHERE ⇒ match with the extra clause as residual', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			const res = match(db, 'select customer_id, amt from sales where amt > 0 and customer_id = 7', 'recent');
			expect(res.match, 'matched').to.not.be.undefined;
			expect(res.match!.residualClauses).to.have.lengthOf(1);
			expect(res.match!.residualClauses[0]).to.include({ kind: 'eq-literal' });
			// Output columns customer_id, amt resolve to backing columns.
			expect(res.match!.outputColumnMap.map(o => o.backingCol)).to.have.lengthOf(2);
		} finally {
			await db.close();
		}
	});

	it('fragment WHERE == MV WHERE ⇒ match with empty residual', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			const res = match(db, 'select customer_id, amt from sales where amt > 0', 'recent');
			expect(res.match, 'matched').to.not.be.undefined;
			expect(res.match!.residualClauses).to.be.empty;
		} finally {
			await db.close();
		}
	});

	it('MV with no WHERE subsumes any fragment WHERE (residual = full query WHERE)', async () => {
		const db = await freshDb([...SALES, 'create materialized view allsales as select id, customer_id, amt from sales']);
		try {
			const res = match(db, 'select customer_id from sales where customer_id = 7', 'allsales');
			expect(res.match, 'matched').to.not.be.undefined;
			expect(res.match!.residualClauses).to.have.lengthOf(1);
		} finally {
			await db.close();
		}
	});

	it('matches via a `select *` MV (star expands to all base columns)', async () => {
		const db = await freshDb([...SALES, 'create materialized view starmv as select * from sales']);
		try {
			const res = match(db, 'select customer_id from sales where amt = 10', 'starmv');
			expect(res.match, 'matched via star').to.not.be.undefined;
			// Output (customer_id) and residual (amt) both resolve to backing columns.
			expect(res.match!.residualClauses).to.have.lengthOf(1);
		} finally {
			await db.close();
		}
	});

	it('ignores a computed MV column when matching a passthrough query', async () => {
		const db = await freshDb([
			...SALES,
			'create materialized view derived as select id, customer_id, amt, amt + 1 as amt1 from sales where amt > 0',
		]);
		try {
			// customer_id, amt are passthrough columns; the computed amt1 is unmapped and ignored.
			const res = match(db, 'select customer_id, amt from sales where amt > 0', 'derived');
			expect(res.match, 'matched ignoring the computed column').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('query-rewrite matcher — per-reason negatives', () => {
	it('predicate-not-entailed: fragment with no WHERE vs MV with WHERE', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			const res = match(db, 'select customer_id, amt from sales', 'recent');
			expect(res.match).to.be.undefined;
			expect((res as { reason: string }).reason).to.equal('predicate-not-entailed');
		} finally {
			await db.close();
		}
	});

	it('missing-column: fragment projects a column the MV omits', async () => {
		const db = await freshDb([...SALES, 'create materialized view amts as select id, amt from sales where amt > 0']);
		try {
			const res = match(db, 'select customer_id from sales where amt > 0', 'amts');
			expect(res.match).to.be.undefined;
			expect((res as { reason: string }).reason).to.equal('missing-column');
		} finally {
			await db.close();
		}
	});

	it('missing-column: residual references a column the MV omits', async () => {
		const db = await freshDb([...SALES, 'create materialized view amts as select id, amt from sales where amt > 0']);
		try {
			// Output (amt) is covered, but the residual (customer_id = 7) is not.
			const res = match(db, 'select amt from sales where amt > 0 and customer_id = 7', 'amts');
			expect(res.match).to.be.undefined;
			expect((res as { reason: string }).reason).to.equal('missing-column');
		} finally {
			await db.close();
		}
	});

	it('source-mismatch: MV reads a different base table', async () => {
		const db = await freshDb([
			...SALES,
			'create table other (id integer primary key, customer_id integer not null, amt integer not null)',
			'create materialized view othermv as select id, customer_id, amt from other',
		]);
		try {
			const res = match(db, 'select customer_id, amt from sales', 'othermv');
			expect(res.match).to.be.undefined;
			expect((res as { reason: string }).reason).to.equal('source-mismatch');
		} finally {
			await db.close();
		}
	});
});

describe('query-rewrite matcher — gates (no-candidate)', () => {
	it('a stale MV is never matched', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			// A body-relevant alter (retyping the projected `amt`) marks the MV stale but it still plans.
			await db.exec('alter table sales alter column amt set data type real');
			expect(db.schemaManager.getMaintainedTable('main', 'recent')!.derivation.stale).to.equal(true);
			const res = match(db, 'select customer_id, amt from sales where amt > 0', 'recent');
			expect(res.match).to.be.undefined;
			expect((res as { reason: string }).reason).to.equal('no-candidate');
		} finally {
			await db.close();
		}
	});

	it('a non-deterministic-body MV is never matched', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			// Inject a determinism probe that flags `>` ... no: flag nothing real, but
			// pretend the body referenced a non-deterministic function by flagging all.
			const allNonDet: DeterminismProbe = () => false;
			// The body has no function calls, so the probe alone never fires; instead
			// confirm a body WITH a flagged function gates. Use a stub MV body.
			const mv = db.schemaManager.getMaintainedTable('main', 'recent')!;
			const stubAst = { ...(mv.derivation.selectAst as object), where: undefined, columns: [
				{ type: 'column', expr: { type: 'function', name: 'random', args: [] } },
			] } as unknown as typeof mv.derivation.selectAst;
			const stub = { ...mv, derivation: { ...mv.derivation, selectAst: stubAst } };
			const frag = analyzeQueryFragment(pristineFragment(db, 'select customer_id, amt from sales where amt > 0'));
			expect(frag.ok).to.be.true;
			if (!frag.ok) throw new Error('unreachable');
			const backing = db.schemaManager.getTable('main', mv.name);
			const res = matchFragmentToMv(frag.shape, stub, backing, allNonDet);
			expect(res.match).to.be.undefined;
			expect((res as { reason: string }).reason).to.equal('no-candidate');
		} finally {
			await db.close();
		}
	});
});

describe('query-rewrite — end-to-end rows + plan shape', () => {
	it('rewrites to the MV-table scan and returns identical rows', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			const q = 'select customer_id, amt from sales where amt > 0 and customer_id = 7 order by amt';
			// Plan shows the MV-table scan.
			const serialized = serializePlanTree(db.getPlan(q));
			expect(serialized, 'rewrote to the MV table').to.contain('"name": "recent"');

			// Rows identical to the rule-disabled recompute.
			const enabled = await readRows(db, q);
			db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) });
			const disabled = await readRows(db, q);
			db.optimizer.updateTuning(DEFAULT_TUNING);
			expect(enabled).to.equal(disabled);
			expect(enabled).to.equal('[7,10]|[7,20]');
		} finally {
			await db.close();
		}
	});

	it('an aliased/qualified-column query rewrites and stays row-identical', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			// Qualified source (`from sales s`) + qualified columns (`s.amt`): entailment
			// resolves by bare name and the residual/outputs remap by columnIndex.
			const q = 'select s.customer_id, s.amt from sales s where s.amt > 0 and s.customer_id = 7 order by s.amt';
			expect(serializePlanTree(db.getPlan(q)), 'rewrote to the MV table').to.contain('"name": "recent"');

			const enabled = await readRows(db, q);
			db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) });
			const disabled = await readRows(db, q);
			db.optimizer.updateTuning(DEFAULT_TUNING);
			expect(enabled).to.equal(disabled);
			expect(enabled).to.equal('[7,10]|[7,20]');
		} finally {
			await db.close();
		}
	});

	it('a near-miss (non-entailed predicate) keeps the base recompute', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			// Query wants amt > -5, which the amt>0 MV does NOT cover.
			const serialized = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > -5'));
			expect(serialized, 'no rewrite').to.not.contain('"name": "recent"');
			expect(serialized).to.contain('"name": "sales"');
		} finally {
			await db.close();
		}
	});
});

describe('query-rewrite — MV self-maintenance is never rewritten', () => {
	it('creating/maintaining the MV reads from the source, not the backing', async () => {
		const db = await freshDb([...SALES, 'create materialized view recent as select id, customer_id, amt from sales where amt > 0']);
		try {
			// Backing reflects the source body (amt > 0): ids 1,3,4.
			expect(await readRows(db, 'select id from recent')).to.equal('[1]|[3]|[4]');
			// A source write maintains the backing correctly (would break if the
			// maintenance body had been rewritten to read the backing).
			await db.exec('insert into sales values (7, 7, 99)');
			expect(await readRows(db, 'select id from recent')).to.equal('[1]|[3]|[4]|[7]');
			await db.exec('refresh materialized view recent');
			expect(await readRows(db, 'select id from recent')).to.equal('[1]|[3]|[4]|[7]');
		} finally {
			await db.close();
		}
	});
});
