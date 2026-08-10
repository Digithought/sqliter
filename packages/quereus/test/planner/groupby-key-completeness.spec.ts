/**
 * Regression net for ticket `collated-groupby-key-completeness`.
 *
 * A GROUP BY over a non-bare expression (collated, arithmetic, any computed)
 * genuinely keys the aggregate output on the group columns. The final SELECT
 * projection must keep that key: `buildFinalAggregateProjections` references the
 * aggregate's own group output column for whole-expression group-key matches, so
 * `keysOf(root)` recovers the key — published under exactly the grouping
 * collation — instead of silently dropping it at the projection layer.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { keysOf } from '../../src/planner/util/fd-utils.js';
import type { PlanNode, RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';

function rootOf(db: Database, sql: string): RelationalPlanNode {
	const block = db.getPlan(sql) as unknown as PlanNode;
	const root = (block as unknown as { getRelations?: () => RelationalPlanNode[] }).getRelations?.()[0];
	expect(root, `no relational root for: ${sql}`).to.exist;
	return root!;
}

async function collect(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

function hasKey(root: RelationalPlanNode, cols: number[]): boolean {
	return keysOf(root).some(k => k.length === cols.length && cols.every((c, i) => k[i] === c));
}

describe('GROUP BY key completeness (collated / computed group keys)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (a integer, b text) using memory');
		await db.exec("insert into t values (5, 'Bob'), (6, 'bob'), (7, 'Carol')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('a collated single group key claims the key and publishes NOCASE', () => {
		const root = rootOf(db, 'select b collate nocase as g, count(*) as n from t group by b collate nocase');
		expect(hasKey(root, [0]), 'group key {0} lost at projection').to.equal(true);
		expect((root.getType().columns[0].type.collationName ?? 'BINARY').toUpperCase()).to.equal('NOCASE');
	});

	it('an arithmetic group key claims the key', () => {
		const root = rootOf(db, 'select a + 1 as g, count(*) as n from t group by a + 1');
		expect(hasKey(root, [0])).to.equal(true);
	});

	it('a cast group key claims the key and reads it once (no double cast)', async () => {
		const sql = 'select cast(a as text) as g, count(*) as n from t group by cast(a as text)';
		const root = rootOf(db, sql);
		expect(hasKey(root, [0]), 'cast group key lost at projection').to.equal(true);
		// The aggregate column already holds cast(a) — the projection reads it as the
		// group value rather than re-applying the cast to a representative source row.
		const rows = await collect(db, sql + ' order by g');
		expect(rows.map(r => r.g)).to.deep.equal(['5', '6', '7']);
	});

	it('a composite (col, collated) group key claims the composite key', () => {
		const root = rootOf(db, 'select a, b collate nocase as bn, count(*) as n from t group by a, b collate nocase');
		expect(hasKey(root, [0, 1])).to.equal(true);
	});

	it('a partial projection of a composite group key does NOT over-claim', () => {
		const root = rootOf(db, 'select b collate nocase as bn, count(*) as n from t group by a, b collate nocase');
		// Only one of the two group columns is projected — the unique FD's other
		// determinant (a) is absent, so no single-column key may be claimed.
		expect(keysOf(root).some(k => k.length === 1 && k[0] === 0), 'partial group key over-claimed').to.equal(false);
	});

	it('an ordinal GROUP BY (group by 1) still claims the key', () => {
		const root = rootOf(db, 'select b collate nocase as g, count(*) as n from t group by 1');
		expect(hasKey(root, [0])).to.equal(true);
	});

	it('an unaliased collated group column keeps its expression name and the key', () => {
		const root = rootOf(db, 'select b collate nocase, count(*) as n from t group by b collate nocase');
		expect(hasKey(root, [0])).to.equal(true);
		expect(root.getType().columns[0].name).to.equal('b collate nocase');
	});

	it('the same group expression aliased twice plans and runs without crashing', async () => {
		const sql = 'select b collate nocase as g1, b collate nocase as g2, count(*) as n from t group by b collate nocase';
		// Both projected columns are synonyms of the group key. Planning must not
		// crash; any claimed key must be sound (no over-claim). keysOf may decline a
		// single-column key here — the same first-occurrence-wins completeness gap
		// that `select id, id` has — which is out of scope for this ticket.
		const root = rootOf(db, sql);
		expect(() => keysOf(root)).to.not.throw();
		const rows = await collect(db, sql + ' order by g1');
		expect(rows.length).to.equal(2);
		for (const r of rows) expect(r.g1).to.equal(r.g2);
	});

	it('the key survives through an intervening HAVING filter', () => {
		const root = rootOf(db, 'select b collate nocase as g, count(*) as n from t group by b collate nocase having count(*) >= 1');
		// The HAVING FilterNode sits between the aggregate and the final projection;
		// it passes the aggregate group attribute id through, so the projection still
		// maps it and the group-key FD survives.
		expect(hasKey(root, [0]), 'group key lost through HAVING').to.equal(true);
	});

	it('a nested expression over the group key falls through (no key claimed for it)', () => {
		const root = rootOf(db, "select (b collate nocase) || 'x' as g, count(*) as n from t group by b collate nocase");
		// The output column is a function of the key, not the key itself.
		expect(keysOf(root).some(k => k.length === 1 && k[0] === 0)).to.equal(false);
	});

	it('runtime parity: arithmetic group key reads the key value, not a double-applied one', async () => {
		const rows = await collect(db, 'select a + 1 as g, count(*) as n from t group by a + 1 order by g');
		// a ∈ {5,6,7} → g ∈ {6,7,8}; each is its own group. Crucially g = a+1, not
		// (a+1)+1 — the aggregate column already holds the group-key value.
		expect(rows.map(r => r.g)).to.deep.equal([6, 7, 8]);
	});

	it('runtime parity: collated group key reads the representative group value', async () => {
		const rows = await collect(db, 'select b collate nocase as g, count(*) as n from t group by b collate nocase order by g');
		// 'Bob'/'bob' collapse to one NOCASE group (n = 2); 'Carol' is its own (n = 1).
		// Order is robust: any NOCASE representative of the Bob group sorts before Carol.
		expect(rows.map(r => r.n)).to.deep.equal([2, 1]);
	});
});
