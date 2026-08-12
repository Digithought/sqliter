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

	/** Physical properties of every `Window` node in the optimized plan for `sql`. */
	async function windowPhysical(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval("select physical from query_plan(?) where node_type = 'Window'", [sql])) {
			const physical = (r as { physical?: string | null }).physical ?? null;
			rows.push(physical ? JSON.parse(physical) as Record<string, unknown> : {});
		}
		return rows;
	}

	async function soleWindowOrdering(sql: string): Promise<OrderingEntry[] | undefined> {
		const windows = await windowPhysical(sql);
		expect(windows.length, 'expected exactly one Window node in the plan').to.equal(1);
		return windows[0].ordering as OrderingEntry[] | undefined;
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
		const sourceOrderings: OrderingEntry[][] = [];
		for await (const r of db.eval(
			"select node_type, physical from query_plan(?) where physical is not null", [sql])) {
			const row = r as { node_type: string; physical: string };
			if (row.node_type === 'Window') continue;
			const parsed = JSON.parse(row.physical) as { ordering?: OrderingEntry[] };
			if (parsed.ordering) sourceOrderings.push(parsed.ordering);
		}
		const ordering = await soleWindowOrdering(sql);
		if (sourceOrderings.length === 0) {
			// Nothing below advertised an ordering; the window must not invent one.
			expect(ordering).to.equal(undefined);
		} else {
			expect(ordering).to.deep.equal(sourceOrderings[0]);
		}
	});
});
