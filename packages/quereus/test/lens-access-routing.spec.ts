/**
 * End-to-end tests for the lens access-shape read-path consumer
 * (`lens-access-shape-path-selection`): routing an exotic outer-query predicate
 * through an advertised auxiliary structure (nd-tree) as an auxiliary-seek ⋈
 * logical-key semi-join, with graceful degrade to a plain scan when no auxiliary
 * answers the predicate.
 *
 * Routing signal: the auxiliary backing relation only enters the optimized plan
 * tree when the rewrite fires (otherwise it is metadata on the pass-through
 * marker, not a plan child). So "the auxiliary relation appears in the optimized
 * plan" ⟺ "the predicate routed".
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { PlanNode } from '../src/planner/nodes/plan-node.js';
import { NdTreeModule, ndTreeAdvertisement, registerNdTreeFixture } from './vtab/test-nd-tree-module.js';

async function rows(db: Database, sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql, params as never)) out.push(r as Record<string, unknown>);
	return out;
}

/** Collect the (lowercased) table-reference names present in the optimized plan tree. */
function planTables(db: Database, sql: string): Set<string> {
	const optimized = db.optimizer.optimize(db.getPlan(sql), db);
	const tables = new Set<string>();
	const walk = (n: PlanNode | undefined): void => {
		if (!n) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const anyN = n as any;
		const name = anyN.tableSchema?.name;
		if (typeof name === 'string') tables.add(name.toLowerCase());
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(optimized);
	return tables;
}

/** Standard nd-tree fixture: primary name-match `main.Spatial` + auxiliary `main.Spatial_nd`. */
async function setupSpatial(db: Database, forms?: string[]): Promise<void> {
	const mod = new NdTreeModule();
	mod.ads = [ndTreeAdvertisement(forms ? { forms } : undefined)];
	db.registerModule('ndtree', mod);
	registerNdTreeFixture(db);
	await db.exec('create table Spatial (id integer primary key, coord integer) using ndtree');
	await db.exec('create table Spatial_nd (id integer primary key, coord integer) using ndtree');
	await db.exec("insert into Spatial values (1, 100), (2, 200), (3, 100)");
	await db.exec("insert into Spatial_nd values (1, 100), (2, 200), (3, 100)");
	await db.exec('declare logical schema x { table Spatial { id integer primary key, coord integer } }');
	await db.exec('apply schema x');
}

describe('lens access-shape routing: nd-tree spatial', () => {
	it('routes nd_contains(coord, ?) through the auxiliary seek ⋈ logical key', async () => {
		const db = new Database();
		try {
			await setupSpatial(db);

			// The auxiliary backing relation appears in the plan ⟺ the predicate routed.
			const tables = planTables(db, "select * from x.Spatial where nd_contains(coord, 100)");
			expect(tables.has('spatial_nd'), 'routed to the nd-tree backing').to.be.true;
			expect(tables.has('spatial'), 'primary decomposition still present').to.be.true;

			// Correctness: the routed result equals the scan-and-filter baseline.
			const routed = await rows(db, "select * from x.Spatial where nd_contains(coord, 100) order by id");
			const baseline = await rows(db, "select * from main.Spatial where nd_contains(coord, 100) order by id");
			expect(routed).to.deep.equal([{ id: 1, coord: 100 }, { id: 3, coord: 100 }]);
			expect(routed).to.deep.equal(baseline);
		} finally {
			await db.close();
		}
	});

	it('routes through an aliased view (marker under an AliasNode pass-through)', async () => {
		const db = new Database();
		try {
			await setupSpatial(db);
			const tables = planTables(db, "select s.id from x.Spatial s where nd_contains(s.coord, 200)");
			expect(tables.has('spatial_nd'), 'aliased view still routes').to.be.true;
			expect(await rows(db, "select s.id from x.Spatial s where nd_contains(s.coord, 200) order by s.id"))
				.to.deep.equal([{ id: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('an extra residual conjunct survives above the routed semi-join', async () => {
		const db = new Database();
		try {
			await setupSpatial(db);
			const tables = planTables(db, "select * from x.Spatial where nd_contains(coord, 100) and id < 3");
			expect(tables.has('spatial_nd')).to.be.true;
			// nd_contains routes to the auxiliary; `id < 3` remains a residual filter.
			const result = await rows(db, "select * from x.Spatial where nd_contains(coord, 100) and id < 3 order by id");
			expect(result).to.deep.equal([{ id: 1, coord: 100 }]);
		} finally {
			await db.close();
		}
	});

	it('degrade: a routed-form fragment referencing a second logical column falls back to the scan', async () => {
		const db = new Database();
		try {
			// The aux backs only `coord` (+ key `id`); `other` is a logical column it
			// does not carry. `nd_contains(coord, other)` matches the form, but routing
			// it would push `other` below the semi-join onto the aux scan where it does
			// not exist — so the rule must decline and leave it a residual filter.
			const mod = new NdTreeModule();
			mod.ads = [ndTreeAdvertisement()];
			db.registerModule('ndtree', mod);
			registerNdTreeFixture(db);
			await db.exec('create table Spatial (id integer primary key, coord integer, other integer) using ndtree');
			await db.exec('create table Spatial_nd (id integer primary key, coord integer) using ndtree');
			await db.exec('insert into Spatial values (1, 100, 100), (2, 200, 999), (3, 100, 7)');
			await db.exec('insert into Spatial_nd values (1, 100), (2, 200), (3, 100)');
			await db.exec('declare logical schema x { table Spatial { id integer primary key, coord integer, other integer } }');
			await db.exec('apply schema x');

			const tables = planTables(db, 'select * from x.Spatial where nd_contains(coord, other)');
			expect(tables.has('spatial_nd'), 'cross-column fragment ⇒ no routing').to.be.false;
			// Still correct as a residual filter: nd_contains(coord, other) ≡ coord = other.
			expect(await rows(db, 'select * from x.Spatial where nd_contains(coord, other) order by id'))
				.to.deep.equal([{ id: 1, coord: 100, other: 100 }]);
		} finally {
			await db.close();
		}
	});

	it('dual-decomposition discrimination: an equi-lookup on the logical PK does NOT route to the nd-tree', async () => {
		const db = new Database();
		try {
			await setupSpatial(db);
			const tables = planTables(db, "select * from x.Spatial where id = 2");
			expect(tables.has('spatial_nd'), 'equality on the PK is served by the primary, not the nd-tree').to.be.false;
			expect(await rows(db, "select * from x.Spatial where id = 2")).to.deep.equal([{ id: 2, coord: 200 }]);
		} finally {
			await db.close();
		}
	});

	it('degrade: an auxiliary advertising only an unrecognized form falls back to the scan', async () => {
		const db = new Database();
		try {
			await setupSpatial(db, ['vector-cosine']); // no recognizer for this form
			const tables = planTables(db, "select * from x.Spatial where nd_contains(coord, 100)");
			expect(tables.has('spatial_nd'), 'unrecognized form ⇒ no routing').to.be.false;
			// Results still correct — nd_contains is evaluated as an ordinary residual filter.
			expect(await rows(db, "select * from x.Spatial where nd_contains(coord, 100) order by id"))
				.to.deep.equal([{ id: 1, coord: 100 }, { id: 3, coord: 100 }]);
		} finally {
			await db.close();
		}
	});

	it('degrade: a surrogate-keyed auxiliary (no logical-PK alignment) falls back to the scan', async () => {
		const db = new Database();
		try {
			const mod = new NdTreeModule();
			// Surrogate shared key on a non-logical `sid` — not aligned to the logical PK (D4 boundary).
			mod.ads = [{
				id: 'Spatial_surr',
				logicalTable: 'Spatial',
				role: 'auxiliary-access',
				storage: {
					anchorRelationId: 'Spatial_surr',
					members: [{
						relationId: 'Spatial_surr',
						relation: { schema: 'main', table: 'Spatial_surr' },
						presence: 'mandatory',
						columns: [{ logicalColumn: 'coord', basisExpr: { type: 'column', name: 'coord' } }],
					}],
					sharedKey: {
						kind: 'surrogate',
						keyColumnsByRelation: new Map([['Spatial_surr', ['sid']]]),
					},
				},
				access: { served: [{ columns: ['coord'], forms: ['contains'] }] },
			}];
			db.registerModule('ndtree', mod);
			registerNdTreeFixture(db);
			await db.exec('create table Spatial (id integer primary key, coord integer) using ndtree');
			await db.exec('create table Spatial_surr (sid integer primary key, coord integer) using ndtree');
			await db.exec("insert into Spatial values (1, 100), (2, 200), (3, 100)");
			await db.exec('declare logical schema x { table Spatial { id integer primary key, coord integer } }');
			await db.exec('apply schema x');

			const tables = planTables(db, "select * from x.Spatial where nd_contains(coord, 100)");
			expect(tables.has('spatial_surr'), 'surrogate-only key ⇒ no routing').to.be.false;
			expect(await rows(db, "select * from x.Spatial where nd_contains(coord, 100) order by id"))
				.to.deep.equal([{ id: 1, coord: 100 }, { id: 3, coord: 100 }]);
		} finally {
			await db.close();
		}
	});
});
