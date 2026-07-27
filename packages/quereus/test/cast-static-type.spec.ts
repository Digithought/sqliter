/**
 * `CastNode.getType()` — the static type a CAST advertises (ticket
 * `failed-cast-stores-unconverted-value`).
 *
 * Two properties the write path depends on, neither of which is visible in a
 * result set:
 *   - the planner resolves the target name exactly as `runtime/emit/cast.ts`
 *     does (`inferType`), so the advertised logical type is the one the emitter
 *     will actually produce;
 *   - a converting CAST is nullable even over a NOT NULL operand, because an
 *     unconvertible value now yields NULL.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import { PlanNode } from '../src/planner/nodes/plan-node.js';
import { CastNode } from '../src/planner/nodes/scalar.js';

describe('CastNode static type', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table cst (id integer primary key, t text not null, n integer null)');
	});

	afterEach(async () => {
		await db.close();
	});

	/** The first CastNode in a logically-planned statement. */
	function findCast(sql: string): CastNode {
		const ast = new Parser().parse(sql) as unknown as AST.Statement;
		const { plan } = db._buildPlan([ast]);
		let found: CastNode | undefined;
		const visit = (n: PlanNode): void => {
			if (found) return;
			if (n instanceof CastNode) { found = n; return; }
			for (const c of n.getChildren()) visit(c);
			for (const r of n.getRelations()) visit(r);
		};
		visit(plan);
		if (!found) throw new Error(`no CastNode in plan for: ${sql}`);
		return found;
	}

	async function typeofValue(sql: string): Promise<unknown> {
		for await (const r of db.eval(sql)) return (r as { ty: unknown }).ty;
		throw new Error('no row');
	}

	it('resolves an affinity-only target name the same way the emitter does', async () => {
		// NVARCHAR misses the registry but matches the CHAR affinity rule. Under the
		// old `getTypeOrDefault` lookup the plan advertised BLOB while the emitter
		// produced TEXT.
		expect(findCast('select cast(id as nvarchar) as c from cst').getType().logicalType.name).to.equal('TEXT');
		await db.exec("insert into cst values (1, 'a', null)");
		expect(await typeofValue('select typeof(cast(id as nvarchar)) as ty from cst')).to.equal('text');
	});

	it('treats an affinity-only alias of the operand type as a no-op cast', () => {
		// TEXT column → NVARCHAR resolves to TEXT, so the cast converts nothing and
		// keeps the operand's non-nullability.
		expect(findCast('select cast(t as nvarchar) as c from cst').getType().nullable).to.equal(false);
	});

	it('reports a converting cast as nullable even over a NOT NULL operand', () => {
		expect(findCast('select cast(t as date) as c from cst').getType().nullable).to.equal(true);
		expect(findCast('select cast(t as integer) as c from cst').getType().nullable).to.equal(true);
	});

	it('reports a no-op cast with the operand nullability', () => {
		expect(findCast('select cast(t as text) as c from cst').getType().nullable).to.equal(false);
		expect(findCast('select cast(n as integer) as c from cst').getType().nullable).to.equal(true);
	});
});
