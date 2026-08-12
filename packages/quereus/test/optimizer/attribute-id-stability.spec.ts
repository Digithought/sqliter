import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { WindowNode } from '../../src/planner/nodes/window-node.js';
import type { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';

describe('Attribute ID stability', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");
	}

	it('preserves attributeId across SELECT aliasing and ORDER BY references', async () => {
		await setup();

		const sql = "SELECT v AS vv, id AS ii FROM t ORDER BY id";
		const refs: Array<{ attributeId: number; column: string }> = [];

		for await (const r of db.eval("SELECT properties FROM query_plan(?) WHERE node_type = 'ColumnReference'", [sql])) {
			const properties = (r as { properties?: string | null }).properties ?? null;
			if (!properties) continue;
			const parsed = JSON.parse(properties);
			if (typeof parsed?.attributeId === 'number' && typeof parsed?.column === 'string') {
				refs.push({ attributeId: parsed.attributeId, column: parsed.column });
			}
		}

		const idRefs = refs.filter(r => r.column === 'id' || r.column === 'ii');
		expect(idRefs.length).to.be.greaterThan(0);

		const uniqueIds = new Set(idRefs.map(r => r.attributeId));
		expect(uniqueIds.size).to.equal(1);
	});

	/** Every WindowNode and ColumnReference in an (optimized) plan tree. */
	function collectWindowsAndRefs(plan: PlanNode): { windows: WindowNode[]; refs: ColumnReferenceNode[] } {
		const windows: WindowNode[] = [];
		const refs: ColumnReferenceNode[] = [];
		const stack: PlanNode[] = [plan];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.nodeType === PlanNodeType.Window) windows.push(node as WindowNode);
			if (node.nodeType === PlanNodeType.ColumnReference) refs.push(node as ColumnReferenceNode);
			stack.push(...node.getChildren());
		}
		return { windows, refs };
	}

	/**
	 * Asserts every column reference named `columnName` in the optimized plan for
	 * `sql` is bound to an attribute some WindowNode actually publishes. A dangling
	 * id here is the failure mode of re-minting window attributes when the
	 * optimizer replaces the WindowNode's source or attaches a streaming config.
	 */
	function expectWindowColumnBound(sql: string, columnName: string): void {
		const { windows, refs } = collectWindowsAndRefs(db.getPlan(sql) as PlanNode);
		expect(windows.length, `expected a WindowNode in the plan for: ${sql}`).to.be.greaterThan(0);

		const windowAttrIds = new Set(windows.flatMap(w => w.getWindowAttributes().map(a => a.id)));
		const windowRefs = refs.filter(r => r.expression.name === columnName);
		expect(windowRefs.length, `expected a reference to window column '${columnName}' in: ${sql}`)
			.to.be.greaterThan(0);
		for (const ref of windowRefs) {
			expect(
				windowAttrIds.has(ref.attributeId),
				`reference to '${columnName}' (attr ${ref.attributeId}) must be a window output attribute (have: ${[...windowAttrIds].join(',')})`
			).to.equal(true);
		}
	}

	it('keeps a window output column bound to its WindowNode when decorrelation rewrites the plan', async () => {
		await db.exec("CREATE TABLE wg (a TEXT, b TEXT) USING memory");
		await db.exec("INSERT INTO wg VALUES ('x','p'),('y','q'),('x','r')");

		// rule-scalar-agg-decorrelation replaces the WindowNode's source (the grouped
		// aggregate becomes a physical aggregate) and places a join between the
		// WindowNode and its projection — the shape that used to re-mint the window
		// attributes and that a positional read silently misresolved.
		expectWindowColumnBound(
			"SELECT k, (SELECT min(t.b) FROM wg t WHERE t.a = k) AS c, count(*) OVER () AS n "
			+ "FROM (SELECT a AS k FROM wg) GROUP BY k",
			'n'
		);
	});

	it('keeps a window output column bound to its WindowNode on the streaming path', async () => {
		await setup();
		// PK-ordered scan ⇒ rule-monotonic-window rebuilds the node via withStreaming;
		// the projection's reference must still land on the same attribute id.
		expectWindowColumnBound('SELECT id, row_number() OVER (ORDER BY id) AS rn FROM t', 'rn');
	});
});

