import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

/**
 * `WindowNode.computePhysical` advertises the order the window emitter actually
 * yields rows in. Before bug-window-node-advertises-source-row-order it relayed
 * the *source's* ordering unconditionally, so a window that sorts its own rows
 * (or regroups them by partition) told the optimizer the rows still arrived in
 * source order — and a merge join above it dropped rows on that false claim.
 */
interface OrderingEntry { column: number; desc: boolean }

describe('Window ordering advertisement', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("create table wo (k integer primary key, g text, v integer) using memory");
		await db.exec("insert into wo values (1,'a',10),(2,'b',20),(3,'a',30),(4,'b',40)");
	});

	afterEach(async () => {
		await db.close();
	});

	interface PlanRow { id: number; parentId: number | null; nodeType: string; ordering?: OrderingEntry[] }

	/** Every node of the optimized plan for `sql`, with its advertised ordering. */
	async function planNodes(sql: string): Promise<PlanRow[]> {
		const rows: PlanRow[] = [];
		for await (const r of db.eval("select id, parent_id, node_type, physical from query_plan(?)", [sql])) {
			const raw = r as { id: number; parent_id: number | null; node_type: string; physical?: string | null };
			const physical = raw.physical ? JSON.parse(raw.physical) as { ordering?: OrderingEntry[] } : {};
			rows.push({ id: raw.id, parentId: raw.parent_id, nodeType: raw.node_type, ordering: physical.ordering });
		}
		return rows;
	}

	/** The plan's `Window` nodes, innermost first (a stacked window is the parent of its input). */
	async function windowNodes(sql: string): Promise<PlanRow[]> {
		const nodes = await planNodes(sql);
		return nodes.filter(n => n.nodeType === 'Window').reverse();
	}

	async function soleWindow(sql: string): Promise<PlanRow> {
		const windows = await windowNodes(sql);
		expect(windows.length, 'expected exactly one Window node in the plan').to.equal(1);
		return windows[0];
	}

	async function soleWindowOrdering(sql: string): Promise<OrderingEntry[] | undefined> {
		return (await soleWindow(sql)).ordering;
	}

	it('advertises a DESC ordering for a desc-ordered unpartitioned window', async () => {
		// `v` is source column index 2. The buffered emitter sorts the single
		// partition by the window ORDER BY, so that IS the emit order.
		const ordering = await soleWindowOrdering(
			'select k, g, v, row_number() over (order by v desc) as rn from wo');
		expect(ordering).to.deep.equal([{ column: 2, desc: true }]);
	});

	it('advertises an ASC ordering for an asc-ordered unpartitioned window', async () => {
		const ordering = await soleWindowOrdering(
			'select k, g, v, row_number() over (order by v) as rn from wo');
		expect(ordering).to.deep.equal([{ column: 2, desc: false }]);
	});

	it('advertises the full multi-key ordering, in declared order', async () => {
		const ordering = await soleWindowOrdering(
			'select k, g, v, row_number() over (order by g, v desc) as rn from wo');
		expect(ordering).to.deep.equal([{ column: 1, desc: false }, { column: 2, desc: true }]);
	});

	it('advertises no ordering for a partitioned window', async () => {
		// `groupByPartitions` emits whole partitions in first-seen order, so no
		// ordering over the source columns survives — not even the scan's own.
		const ordering = await soleWindowOrdering(
			'select k, g, sum(v) over (partition by g) as s from wo');
		expect(ordering).to.equal(undefined);
	});

	it('advertises no ordering for a partitioned+ordered window', async () => {
		const ordering = await soleWindowOrdering(
			'select k, g, v, row_number() over (partition by g order by v desc) as rn from wo');
		expect(ordering).to.equal(undefined);
	});

	it('advertises no ordering when a window ORDER BY key is not a plain column', async () => {
		// `extractOrderingFromSortKeys` bails on a non-trivial key — the
		// conservative answer, since the emit order is over a computed value that
		// is not one of the output columns.
		const ordering = await soleWindowOrdering(
			'select k, g, v, row_number() over (order by v * -1) as rn from wo');
		expect(ordering).to.equal(undefined);
	});

	it('passes the source ordering through when the window neither sorts nor partitions', async () => {
		// No PARTITION BY and no ORDER BY: `sortRows` returns the rows unchanged,
		// so whatever the source advertised still holds.
		const sql = 'select k, g, count(*) over () as c from wo';
		const nodes = await planNodes(sql);
		const windows = nodes.filter(n => n.nodeType === 'Window');
		expect(windows.length, 'expected exactly one Window node in the plan').to.equal(1);

		// `getChildren()` puts the relational source first, so the window's
		// lowest-id child is the node whose order is being passed through.
		const source = nodes.filter(n => n.parentId === windows[0].id)
			.sort((a, b) => a.id - b.id)[0];
		expect(source, 'window has no child in the plan').to.not.equal(undefined);
		// The scan walks the primary key, so there IS an ordering to relay — if this
		// ever goes undefined the assertion below stops proving anything.
		expect(source.ordering, `${source.nodeType} advertised no ordering to pass through`)
			.to.deep.equal([{ column: 0, desc: false }]);
		expect(windows[0].ordering).to.deep.equal(source.ordering);
	});

	it('feeds a truthful ordering to a window stacked on another window', async () => {
		// The inner window sorts desc; the outer one neither partitions nor orders,
		// so it relays what the inner actually emits — a DESC order, not the scan's
		// ascending k. Column indices differ between the two: the projection in
		// between renumbers them, so compare each window against its own child.
		const sql = 'select k, v, rn, count(*) over () as c from ' +
			'(select k, v, row_number() over (order by v desc) as rn from wo)';
		const nodes = await planNodes(sql);
		const windows = nodes.filter(n => n.nodeType === 'Window').reverse();
		expect(windows.length, 'expected two Window nodes in the plan').to.equal(2);

		// Inner: `v` is source column index 2 (k, g, v), sorted descending.
		expect(windows[0].ordering, 'inner window').to.deep.equal([{ column: 2, desc: true }]);

		const outerSource = nodes.filter(n => n.parentId === windows[1].id)
			.sort((a, b) => a.id - b.id)[0];
		expect(windows[1].ordering, 'outer window').to.deep.equal(outerSource.ordering);
		expect(windows[1].ordering?.[0].desc, 'the inner desc order must reach the outer window')
			.to.equal(true);
	});
});
