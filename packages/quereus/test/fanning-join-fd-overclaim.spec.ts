/**
 * Fanning-join FD over-claim regression (ticket `join-fanning-isset-overclaim`).
 *
 * A fanning (non-1:1) inner/cross join must NOT let a downstream key-dropping
 * projection re-derive a spurious unique key. `propagateJoinFds` drops a side's
 * KEY FDs when the join does not preserve that side's key (no preserved key lies
 * entirely within that side's columns), so the side key cannot resurrect as an
 * all-columns key once the *other* side's distinguishing columns are projected
 * away. Without the fix the optimizer reads the resulting bag as a set and
 * eliminates a DISTINCT / collapses a GROUP BY that must stand.
 *
 * Setup: `g (id pk, k, v)` ⋈ `g2 (id pk, w)`.
 *   - `on g.k = g2.w`  fans out — `k`/`w` are non-unique, so one `g` row can
 *     match several `g2` rows. Neither side's PK is covered ⇒ only the composite
 *     `(g.id, g2.id)` product key survives the join; projecting to `(g.id, g.v)`
 *     drops `g2.id` and leaves no key ⇒ the body is a bag.
 *   - `on g.id = g2.id` is pk=pk (≤1:1, no fan-out) ⇒ `g`'s PK survives ⇒ set.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { PlanNode } from '../src/planner/nodes/plan-node.js';
import { DistinctNode } from '../src/planner/nodes/distinct-node.js';

function findNodes<T extends PlanNode>(plan: PlanNode, ctor: new (...args: never[]) => T): T[] {
	const out: T[] = [];
	const stack: PlanNode[] = [plan];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node instanceof ctor) out.push(node as T);
		for (const child of node.getChildren()) stack.push(child);
	}
	return out;
}

describe('fanning-join FD over-claim: optimizer blast radius', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table g (id integer primary key, k integer, v integer);
			create table g2 (id integer primary key, w integer);
			create table g3 (id integer primary key, z integer);
			insert into g values (1, 100, 5);
			insert into g2 values (10, 100), (11, 100);
			insert into g3 values (20, 100), (21, 100);
		`);
	});
	afterEach(async () => { await db.close(); });

	it('DISTINCT over a fanning (non-1:1) join is RETAINED (the projected body is a bag)', () => {
		const plan = db.getPlan('select distinct g.id, g.v from g join g2 on g.k = g2.w');
		expect(findNodes(plan, DistinctNode), 'DISTINCT must survive over a fanning join').to.have.length.greaterThan(0);
	});

	it('control: DISTINCT over a pk=pk (≤1:1, no fan-out) join is still ELIMINATED', () => {
		const plan = db.getPlan('select distinct g.id, g.v from g join g2 on g.id = g2.id');
		expect(findNodes(plan, DistinctNode), 'DISTINCT eliminated when the driving PK is preserved').to.have.length(0);
	});

	it('GROUP BY over a fanning join is not collapsed — duplicate rows are counted', async () => {
		// The single g row matches both g2 rows (w = 100), so the (g.id, g.v) group
		// holds 2 rows. A phantom {g.id} key must NOT collapse them to count = 1.
		const out: { id: number; v: number; c: number }[] = [];
		for await (const r of db.eval('select g.id as id, g.v as v, count(*) as c from g join g2 on g.k = g2.w group by g.id, g.v')) {
			out.push(r as unknown as { id: number; v: number; c: number });
		}
		expect(out).to.deep.equal([{ id: 1, v: 5, c: 2 }]);
	});

	it('3-way fanning join: DISTINCT over (g.id, g.v) is RETAINED and groups are not collapsed', async () => {
		// g (1 row) ⋈ g2 (2 rows, w=100) ⋈ g3 (2 rows, z=100) on the non-unique k ⇒ the single
		// g row fans to 2×2 = 4 product rows. Dropping both lookup sides' columns leaves no key,
		// so the body stays a bag through both join frames — no phantom {g.id} key may resurrect.
		const plan = db.getPlan('select distinct g.id, g.v from g join g2 on g.k = g2.w join g3 on g.k = g3.z');
		expect(findNodes(plan, DistinctNode), 'DISTINCT must survive a multi-frame fanning join').to.have.length.greaterThan(0);

		const out: { id: number; v: number; c: number }[] = [];
		for await (const r of db.eval('select g.id as id, g.v as v, count(*) as c from g join g2 on g.k = g2.w join g3 on g.k = g3.z group by g.id, g.v')) {
			out.push(r as unknown as { id: number; v: number; c: number });
		}
		expect(out).to.deep.equal([{ id: 1, v: 5, c: 4 }]);
	});
});
