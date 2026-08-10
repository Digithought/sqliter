import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { CTENode } from '../../src/planner/nodes/cte-node.js';
import { RecursiveCTENode } from '../../src/planner/nodes/recursive-cte-node.js';
import { CTEReferenceNode } from '../../src/planner/nodes/cte-reference-node.js';
import { planOps, allRows } from './_helpers.js';

/** Collect every CTEReferenceNode in an optimized plan tree (deduped by identity). */
function collectCTERefs(root: PlanNode): CTEReferenceNode[] {
	const out: CTEReferenceNode[] = [];
	const seen = new Set<PlanNode>();
	const walk = (node: PlanNode): void => {
		if (seen.has(node)) return;
		seen.add(node);
		if (node instanceof CTEReferenceNode) out.push(node);
		for (const child of node.getChildren()) walk(child);
	};
	walk(root);
	return out;
}

describe('Plan shape: CTE materialization', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
		await db.exec("INSERT INTO items VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
	});

	afterEach(async () => {
		await db.close();
	});

	describe('single-reference CTE should be inlined', () => {
		it('does not produce a CACHE node for single-use CTE', async () => {
			const q = "WITH cte AS (SELECT id, val FROM items WHERE val >= 20) SELECT * FROM cte";
			const ops = await planOps(db, q);

			expect(ops).to.not.include('CACHE',
				'Single-reference CTE should be inlined, not materialized/cached');
			expect(ops).to.include('CTEREFERENCE',
				'Should still contain a CTE reference node');
		});

		it('produces correct results for inlined CTE', async () => {
			const q = "WITH cte AS (SELECT id, val FROM items WHERE val >= 20) SELECT * FROM cte ORDER BY id";
			const results = await allRows<{ id: number; val: number }>(db, q);
			expect(results).to.deep.equal([
				{ id: 2, val: 20 },
				{ id: 3, val: 30 },
				{ id: 4, val: 40 },
			]);
		});
	});

	describe('multi-reference CTE may be materialized', () => {
		it('contains multiple CTE references for multi-use CTE', async () => {
			const q = `
				WITH cte AS (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`;
			const ops = await planOps(db, q);

			const cteRefCount = ops.filter(op => op === 'CTEREFERENCE').length;
			expect(cteRefCount).to.equal(2, 'Should have two CTE reference nodes');
			expect(ops.some(op => op.includes('JOIN')),
				'Multi-use CTE with self-join should contain a JOIN'
			).to.equal(true);
		});

		it('produces correct results for multi-reference CTE', async () => {
			const q = `
				WITH cte AS (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
				ORDER BY c1.id
			`;
			const results = await allRows<{ id: number; val: number }>(db, q);
			expect(results).to.have.lengthOf(4);
			expect(results[0]).to.deep.equal({ id: 1, val: 10 });
			expect(results[3]).to.deep.equal({ id: 4, val: 40 });
		});
	});

	describe('materialize mark (shared per-execution buffer)', () => {
		it('marks a 2-reference CTE materialize and keeps one shared CTENode instance', () => {
			const plan = db.getPlan(`
				WITH cte AS (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(2, 'expected two CTE references');
			// The runtime buffer is keyed by the CTENode's plan id — if the two
			// references ever diverge onto distinct instances, the key no longer
			// matches and the CTE silently re-executes per reference.
			expect(refs[0].source, 'both references must share ONE CTENode instance').to.equal(refs[1].source);
			expect(refs[0].source).to.be.instanceOf(CTENode);
			expect((refs[0].source as CTENode).materialize, 'multi-reference CTE must be marked materialize').to.equal(true);
		});

		it('does not mark a single-reference un-hinted CTE', () => {
			const plan = db.getPlan('WITH cte AS (SELECT id, val FROM items) SELECT * FROM cte');
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(1);
			expect((refs[0].source as CTENode).materialize, 'single-ref CTE keeps the streaming path').to.equal(false);
		});

		it('marks an explicitly MATERIALIZED single-reference CTE', () => {
			const plan = db.getPlan('WITH cte AS MATERIALIZED (SELECT id, val FROM items) SELECT * FROM cte');
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(1);
			expect((refs[0].source as CTENode).materialize, 'MATERIALIZED hint forces the mark').to.equal(true);
		});

		it('honors NOT MATERIALIZED on a 2-reference CTE', () => {
			const plan = db.getPlan(`
				WITH cte AS NOT MATERIALIZED (SELECT id, val FROM items)
				SELECT c1.id, c2.val
				FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(2);
			for (const ref of refs) {
				expect((ref.source as CTENode).materialize,
					'explicit NOT MATERIALIZED opts out of the shared buffer').to.equal(false);
			}
		});
	});

	describe('recursive CTE structure', () => {
		it('produces a RECURSIVECTE plan node', async () => {
			const q = `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 5
				)
				SELECT x FROM cnt ORDER BY x
			`;
			const ops = await planOps(db, q);

			expect(ops).to.include('RECURSIVECTE',
				'Recursive CTE should produce a RECURSIVECTE node');
		});

		it('produces correct sequence from recursive CTE', async () => {
			const q = `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 5
				)
				SELECT x FROM cnt ORDER BY x
			`;
			const results = await allRows<{ x: number }>(db, q);
			expect(results.map(r => r.x)).to.deep.equal([1, 2, 3, 4, 5]);
		});

		it('marks both references of a twice-referenced recursive CTE for shared buffering', () => {
			// Recursive CTEs run through the working-table machinery
			// (RecursiveCTENode → emitRecursiveCTE), not emitCTE. Earlier optimizer
			// passes DUPLICATE a multi-referenced recursive CTE into distinct
			// RecursiveCTENode instances (unlike the non-recursive path, where one
			// CTENode stays shared), but every copy preserves the one working-table
			// `tableDescriptor`. The runtime buffer is keyed by that descriptor, so
			// both copies must be marked `materialize` and must share the descriptor —
			// otherwise each re-drives the recursion and re-opens the runaway.
			const plan = db.getPlan(`
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 3
				)
				SELECT a.x AS ax, b.x AS bx
				FROM cnt a JOIN cnt b ON a.x = b.x
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(2, 'expected two references to the recursive CTE');
			const s0 = refs[0].source;
			const s1 = refs[1].source;
			// Stays a RecursiveCTENode — never rewritten into a (non-recursive) CTENode.
			expect(s0, 'ref 0 source is a RecursiveCTENode').to.be.instanceOf(RecursiveCTENode);
			expect(s1, 'ref 1 source is a RecursiveCTENode').to.be.instanceOf(RecursiveCTENode);
			expect(s0).to.not.be.instanceOf(CTENode);
			expect((s0 as RecursiveCTENode).materialize, 'ref 0 must be marked materialize').to.equal(true);
			expect((s1 as RecursiveCTENode).materialize, 'ref 1 must be marked materialize').to.equal(true);
			// The shared buffer key: both copies must carry the SAME tableDescriptor.
			expect((s0 as RecursiveCTENode).tableDescriptor, 'both copies share one working-table descriptor')
				.to.equal((s1 as RecursiveCTENode).tableDescriptor);
		});

		it('produces correct results for a twice-referenced (self-joined) recursive CTE', async () => {
			// The regression: this previously errored with "exceeded maximum
			// iteration limit" because two interleaved streaming drives clobbered
			// each other's delta on the shared working table.
			const results = await allRows<{ ax: number; bx: number }>(db, `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 3
				)
				SELECT a.x AS ax, b.x AS bx
				FROM cnt a JOIN cnt b ON a.x = b.x
				ORDER BY a.x
			`);
			expect(results).to.deep.equal([
				{ ax: 1, bx: 1 },
				{ ax: 2, bx: 2 },
				{ ax: 3, bx: 3 },
			]);
		});

		it('buffers a UNION DISTINCT twice-referenced recursive CTE correctly', async () => {
			const results = await allRows<{ ax: number; bx: number }>(db, `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION
					SELECT x + 1 FROM cnt WHERE x < 3
				)
				SELECT a.x AS ax, b.x AS bx
				FROM cnt a JOIN cnt b ON a.x = b.x
				ORDER BY a.x
			`);
			expect(results).to.deep.equal([
				{ ax: 1, bx: 1 },
				{ ax: 2, bx: 2 },
				{ ax: 3, bx: 3 },
			]);
		});

		it('buffers a thrice-referenced recursive CTE (replay beyond two consumers)', async () => {
			const results = await allRows<{ ax: number; bx: number; cx: number }>(db, `
				WITH RECURSIVE cnt(x) AS (
					SELECT 1
					UNION ALL
					SELECT x + 1 FROM cnt WHERE x < 3
				)
				SELECT a.x AS ax, b.x AS bx, c.x AS cx
				FROM cnt a JOIN cnt b ON a.x = b.x JOIN cnt c ON a.x = c.x
				ORDER BY a.x
			`);
			expect(results).to.deep.equal([
				{ ax: 1, bx: 1, cx: 1 },
				{ ax: 2, bx: 2, cx: 2 },
				{ ax: 3, bx: 3, cx: 3 },
			]);
		});

		it('keeps single-reference recursion streaming: unbounded CTE under an outer LIMIT', async () => {
			// Regression guard for the streaming path. An unbounded recursion must
			// terminate under an outer LIMIT (the stream is cut before the iteration
			// guard trips) — buffering it would drive to the guard and error. The
			// single-reference node must therefore stay UNmarked.
			const plan = db.getPlan(`
				WITH RECURSIVE nums(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM nums)
				SELECT x FROM nums LIMIT 5
			`);
			const refs = collectCTERefs(plan);
			expect(refs).to.have.lengthOf(1, 'expected a single reference');
			expect((refs[0].source as RecursiveCTENode).materialize,
				'single-reference recursive CTE keeps the streaming path').to.equal(false);

			const results = await allRows<{ x: number }>(db, `
				WITH RECURSIVE nums(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM nums)
				SELECT x FROM nums LIMIT 5
			`);
			expect(results.map(r => r.x)).to.deep.equal([1, 2, 3, 4, 5]);
		});
	});
});
