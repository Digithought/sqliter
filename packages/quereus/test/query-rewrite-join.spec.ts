/**
 * Join-subsumption arm of the automatic materialized-view query rewrite
 * (`mv-query-rewrite-join-subsumption`) — matcher unit tests + end-to-end
 * rewrite/row checks. Recognizes when a query whose join is a 1:1 row-preserving
 * inner/cross join is answered from an MV whose body materializes that same join,
 * and rewrites it to scan the MV's backing table (eliminating the join at read
 * time). Drives the matcher directly so per-reason outcomes are observable,
 * mirroring `query-rewrite.spec.ts` / `query-rewrite-aggregate.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { DEFAULT_TUNING } from '../src/planner/optimizer.js';
import { serializePlanTree } from '../src/planner/debug.js';
import { PlanNodeType } from '../src/planner/nodes/plan-node-type.js';
import type { RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import type * as AST from '../src/parser/ast.js';
import {
	matchJoinMaterializedViewRewrite,
	type RewriteResult,
	type DeterminismProbe,
} from '../src/planner/analysis/query-rewrite-matcher.js';

const ALL_DETERMINISTIC: DeterminismProbe = () => true;

/** Rules that lower the logical join / table refs to physical nodes or move the
 *  WHERE — disabling them yields the pristine `Project(Filter?(Join(T, P)))`
 *  fragment the join matcher reads (the same shape the rule sees in the Structural
 *  pass, before grow-retrieve / predicate-pushdown / physical selection). */
const JOIN_SHAPE_RULES = new Set<string>([
	'materialized-view-rewrite',
	'predicate-pushdown',
	'join-predicate-pushdown',
	'aggregate-predicate-pushdown',
	'filter-merge',
	'sargable-range-rewrite',
	'predicate-inference-equivalence',
	'select-access-path',
	'join-physical-selection',
	// Wraps a surviving nested-loop join's right side in a CacheNode; would
	// otherwise insert Cache(P) between the Join and its lookup table, hiding
	// the pristine Join(T, P) shape the matcher reads. (In production the MV
	// matcher runs in the Structural pass, before this PostOptimization rule.)
	'nested-loop-right-cache',
	'monotonic-merge-join',
	'join-elimination',
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

/** A pristine `Project(Filter?(Join(T, P)))` logical fragment for the matcher. */
function pristineJoinFragment(db: Database, sql: string): RelationalPlanNode {
	const prev = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: JOIN_SHAPE_RULES });
	try {
		const root = db.getPlan(sql).getRelations()[0];
		expect(root, 'fragment produced a relation').to.not.be.undefined;
		return root as RelationalPlanNode;
	} finally {
		db.optimizer.updateTuning(prev);
	}
}

/** The MV body's fully-optimized relational root (rewrite suppressed), as the rule
 *  derives it. */
function mvBodyRoot(db: Database, mvName: string): RelationalPlanNode {
	const mv = db.schemaManager.getMaintainedTable('main', mvName)!;
	const root = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.getPlan(mv.derivation.selectAst as AST.AstNode).getRelations()[0],
	);
	expect(root, 'MV body produced a relation').to.not.be.undefined;
	return root as RelationalPlanNode;
}

function matchJoin(db: Database, sql: string, mvName: string, isDet: DeterminismProbe = ALL_DETERMINISTIC): RewriteResult {
	const root = pristineJoinFragment(db, sql);
	const mv = db.schemaManager.getMaintainedTable('main', mvName)!;
	// The maintained table IS its own backing in the unified model.
	const backing = db.schemaManager.getTable('main', mv.name);
	return matchJoinMaterializedViewRewrite(root, mv, mvBodyRoot(db, mvName), backing, isDet);
}

function reason(res: RewriteResult): string | undefined {
	return (res as { reason?: string }).reason;
}

async function readRows(db: Database, sql: string): Promise<string> {
	const rows: string[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(JSON.stringify(Object.values(row), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
	}
	return rows.sort().join('|');
}

/** customers (parent, PK id) ⋈ orders (child, NOT-NULL FK customer_id → customers.id).
 *  `referrer_id` is a SECOND NOT-NULL FK to customers — lets us exercise distinct
 *  equi-pairs over the same (T, P). The MV `enriched` materializes the FK join. */
const SCHEMA = [
	'create table customers (id integer primary key, name text null, region integer null)',
	'create table orders (id integer primary key, customer_id integer not null, referrer_id integer not null, '
		+ 'amt integer not null, foreign key (customer_id) references customers(id), '
		+ 'foreign key (referrer_id) references customers(id))',
	'create materialized view enriched as select o.id, o.customer_id, o.amt, c.name '
		+ 'from orders o join customers c on o.customer_id = c.id',
	// Stores a lookup column (region) but NOT name — for the missing-lookup-column case.
	'create materialized view enriched_region as select o.id, o.customer_id, o.amt, c.region '
		+ 'from orders o join customers c on o.customer_id = c.id',
];

const ROWS = [
	"insert into customers values (1,'ann',10),(2,'bob',20),(3,null,30)",
	'insert into orders values (101,1,2,5),(102,1,3,150),(103,2,1,200),(104,3,2,-4)',
];

describe('join-subsumption matcher — positive', () => {
	it('fragment join == MV join, both 1:1 ⇒ match (residual = empty when no WHERE)', async () => {
		const db = await freshDb(SCHEMA);
		try {
			const res = matchJoin(db, 'select o.id, o.amt, c.name from orders o join customers c on o.customer_id = c.id', 'enriched');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.residualConjuncts).to.be.empty;
			expect(res.match!.joinInfo!.drivingTable.name).to.equal('orders');
			expect(res.match!.joinInfo!.lookupTable.name).to.equal('customers');
			expect(res.match!.outputColumnMap).to.have.lengthOf(3);
		} finally {
			await db.close();
		}
	});

	it('a driving-side WHERE becomes a residual filter', async () => {
		const db = await freshDb(SCHEMA);
		try {
			const res = matchJoin(db,
				'select o.id, c.name from orders o join customers c on o.customer_id = c.id where o.amt > 100', 'enriched');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.residualConjuncts).to.have.lengthOf(1);
		} finally {
			await db.close();
		}
	});

	it('a lookup-side WHERE is allowed on the read side (residual over the stored join)', async () => {
		const db = await freshDb(SCHEMA);
		try {
			const res = matchJoin(db,
				"select o.id, o.amt from orders o join customers c on o.customer_id = c.id where c.name = 'ann'", 'enriched');
			expect(res.match, `matched (${reason(res)})`).to.not.be.undefined;
			expect(res.match!.residualConjuncts).to.have.lengthOf(1);
		} finally {
			await db.close();
		}
	});
});

describe('join-subsumption matcher — per-reason negatives', () => {
	it('shape: an outer join is deferred', async () => {
		const db = await freshDb(SCHEMA);
		try {
			const res = matchJoin(db, 'select o.id, o.amt, c.name from orders o left join customers c on o.customer_id = c.id', 'enriched');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('shape: a different equi-pair (joins on referrer_id, MV joins on customer_id)', async () => {
		const db = await freshDb(SCHEMA);
		try {
			const res = matchJoin(db, 'select o.id, o.amt, c.name from orders o join customers c on o.referrer_id = c.id', 'enriched');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('shape: a non-1:1 (fanning) join — the join key is not an FK→PK', async () => {
		const db = await freshDb(SCHEMA);
		try {
			// o.amt = c.id has no covering FK, so the join is not provably 1:1 over either table.
			const res = matchJoin(db, 'select o.id, c.name from orders o join customers c on o.amt = c.id', 'enriched');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('missing-column: the MV omits a needed lookup column', async () => {
		const db = await freshDb(SCHEMA);
		try {
			// enriched_region stores c.region (so the join survives) but not c.name.
			const res = matchJoin(db, 'select o.id, c.name from orders o join customers c on o.customer_id = c.id', 'enriched_region');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('missing-column');
		} finally {
			await db.close();
		}
	});

	it('source-mismatch: the MV reads different tables', async () => {
		const db = await freshDb([
			...SCHEMA,
			'create table widgets (id integer primary key, owner_id integer not null, foreign key (owner_id) references customers(id))',
			'create materialized view wmv as select w.id, w.owner_id, c.name from widgets w join customers c on w.owner_id = c.id',
		]);
		try {
			const res = matchJoin(db, 'select o.id, o.amt, c.name from orders o join customers c on o.customer_id = c.id', 'wmv');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('source-mismatch');
		} finally {
			await db.close();
		}
	});

	it('no-candidate: a stale MV is never matched', async () => {
		const db = await freshDb(SCHEMA);
		try {
			await db.exec('alter table orders alter column amt set data type real');
			expect(db.schemaManager.getMaintainedTable('main', 'enriched')!.derivation.stale).to.equal(true);
			const res = matchJoin(db, 'select o.id, o.amt, c.name from orders o join customers c on o.customer_id = c.id', 'enriched');
			expect(res.match).to.be.undefined;
			expect(reason(res)).to.equal('no-candidate');
		} finally {
			await db.close();
		}
	});
});

describe('join-subsumption — end-to-end rows + plan shape', () => {
	it('rewrites a 1:1-join query to the MV-table scan (no join in the plan) and stays row-identical', async () => {
		const db = await freshDb([...SCHEMA, ...ROWS]);
		try {
			const q = 'select o.id, o.amt, c.name from orders o join customers c on o.customer_id = c.id where o.amt > 0 order by o.id';
			const serialized = serializePlanTree(db.getPlan(q));
			expect(serialized, 'rewrote to the MV table').to.contain('"name": "enriched"');
			// (The MV derivation's rendered body contains the word "join", so probe
			// for surviving join NODES rather than the bare word.)
			expect(serialized, 'no join survives').to.not.match(/"nodeType": "\w*Join"/);

			const enabled = await readRows(db, q);
			db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) });
			const disabled = await readRows(db, q);
			db.optimizer.updateTuning(DEFAULT_TUNING);
			expect(enabled).to.equal(disabled);
			expect(enabled).to.equal('[101,5,"ann"]|[102,150,"ann"]|[103,200,"bob"]');
		} finally {
			await db.close();
		}
	});

	it('a lookup-column WHERE rewrites and stays row-identical', async () => {
		const db = await freshDb([...SCHEMA, ...ROWS]);
		try {
			const q = "select o.id, o.amt from orders o join customers c on o.customer_id = c.id where c.name = 'ann' order by o.id";
			expect(serializePlanTree(db.getPlan(q)), 'rewrote to the MV table').to.contain('"name": "enriched"');
			const enabled = await readRows(db, q);
			db.optimizer.updateTuning({ ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) });
			const disabled = await readRows(db, q);
			db.optimizer.updateTuning(DEFAULT_TUNING);
			expect(enabled).to.equal(disabled);
			expect(enabled).to.equal('[101,5]|[102,150]');
		} finally {
			await db.close();
		}
	});

	it('a fanning-join near-miss keeps the base recompute (join survives)', async () => {
		const db = await freshDb([...SCHEMA, ...ROWS]);
		try {
			const serialized = serializePlanTree(db.getPlan('select o.id, c.name from orders o join customers c on o.amt = c.id'));
			expect(serialized, 'no rewrite for a non-1:1 join').to.not.contain('"name": "enriched"');
		} finally {
			await db.close();
		}
	});

	it('a stale source ALTER suspends the rewrite, and a refresh resumes it (cache re-derives)', async () => {
		const db = await freshDb([...SCHEMA, ...ROWS]);
		try {
			const q = 'select o.id, c.name from orders o join customers c on o.customer_id = c.id order by o.id';
			const expected = '[101,"ann"]|[102,"ann"]|[103,"bob"]|[104,null]';
			// Rewrites and is correct while fresh.
			expect(serializePlanTree(db.getPlan(q))).to.contain('"name": "enriched"');
			expect(await readRows(db, q)).to.equal(expected);

			// A source ALTER marks the join MV stale → no rewrite, base recompute stays correct.
			await db.exec('alter table orders alter column amt set data type real');
			expect(db.schemaManager.getMaintainedTable('main', 'enriched')!.derivation.stale).to.equal(true);
			expect(serializePlanTree(db.getPlan(q)), 'no rewrite while stale').to.not.contain('"name": "enriched"');
			expect(await readRows(db, q)).to.equal(expected);

			// Refresh clears staleness → the rewrite resumes against the re-derived body.
			await db.exec('refresh materialized view enriched');
			expect(db.schemaManager.getMaintainedTable('main', 'enriched')!.derivation.stale).to.not.equal(true);
			expect(serializePlanTree(db.getPlan(q)), 'rewrite resumes after refresh').to.contain('"name": "enriched"');
			expect(await readRows(db, q)).to.equal(expected);
		} finally {
			await db.close();
		}
	});

	it('a select* join MV ALTER+refresh reshapes the MV table in place and RE-ENABLES the rewrite (no intervening query)', async () => {
		// A source `alter` shifts a `select *` body's output shape while the create-time
		// MV table does not — desynchronizing the position-keyed stored-column map. Here the
		// column is added to the LAST join table, so it lands TRAILING in the `select *`
		// output: an identity-preserving in-place reshape (the host module's alterTable + a
		// data reconcile), restoring positional alignment — so `backingAlignsWithBody` passes
		// and the join rewrite resumes (it no longer forgoes). (An add to a non-last table
		// would interleave the new column mid-output, which is inexpressible in place and a
		// sited error — covered in materialized-view-refresh-reshape.spec.ts.) Critically
		// there is NO query while the MV is stale (the only path that used to drop the cached
		// body root), so the post-refresh plan re-validates on its own (the source `alter`
		// swapped the source `TableSchema` identity, forcing the cached body root to re-derive).
		const db = await freshDb([
			'create table customers (id integer primary key, name text null)',
			'create table orders (id integer primary key, customer_id integer not null, '
				+ 'foreign key (customer_id) references customers(id))',
			'create materialized view jstar as select * from orders o join customers c on o.customer_id = c.id',
			"insert into customers values (1,'ann'),(2,'bob')",
			'insert into orders values (101,1),(102,2)',
		]);
		try {
			const q = 'select o.id, c.name from orders o join customers c on o.customer_id = c.id order by o.id';
			const expected = '[101,"ann"]|[102,"bob"]';
			// Fresh: the select* body aligns with the stored shape, so the rewrite fires.
			expect(serializePlanTree(db.getPlan(q)), 'rewrites while fresh').to.contain('"name": "jstar"');
			expect(await readRows(db, q)).to.equal(expected);

			// Add a TRAILING source column (to the last join table), then refresh — WITHOUT
			// querying while stale. The new column appends to the select* output, so the
			// reshape is expressible in place.
			await db.exec('alter table customers add column extra integer null');
			await db.exec('refresh materialized view jstar');
			expect(db.schemaManager.getMaintainedTable('main', 'jstar')!.derivation.stale).to.not.equal(true);

			// The in-place reshape realigned the MV table with the re-planned select* body, so
			// the arm no longer forgoes — the rewrite fires again and rows stay correct.
			expect(serializePlanTree(db.getPlan(q)), 'rewrite re-enabled after reshape').to.contain('"name": "jstar"');
			expect(await readRows(db, q)).to.equal(expected);

			// Direct read of the reshaped MV exposes the new (trailing) source column.
			expect(await readRows(db, 'select * from jstar'))
				.to.equal('[101,1,1,"ann",null]|[102,2,2,"bob",null]');
		} finally {
			await db.close();
		}
	});

	it('MV self-maintenance is never rewritten (a source write maintains the join MV)', async () => {
		const db = await freshDb([...SCHEMA, ...ROWS]);
		try {
			expect(await readRows(db, 'select id from enriched')).to.equal('[101]|[102]|[103]|[104]');
			await db.exec("insert into customers values (4,'dee',40)");
			await db.exec('insert into orders values (105,4,1,9)');
			expect(await readRows(db, 'select id from enriched')).to.equal('[101]|[102]|[103]|[104]|[105]');
		} finally {
			await db.close();
		}
	});
});
