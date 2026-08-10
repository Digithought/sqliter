import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode, DEFAULT_PHYSICAL, type PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../src/planner/framework/characteristics.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import type { BaseType } from '../../src/common/datatype.js';
import type { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';

describe('PlanNode: visit and getTotalCost traversal', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('visit() should not visit any node more than once', () => {
		// FilterNode has getChildren() = [source, predicate], getRelations() = [source]
		// If visit() iterates both, source subtree gets visited twice
		const plan = db.getPlan('select * from t where id > 1');

		const visitCounts = new Map<PlanNode, number>();
		plan.visit((node) => {
			visitCounts.set(node, (visitCounts.get(node) || 0) + 1);
		});

		for (const [node, count] of visitCounts) {
			expect(count, `Node ${node.nodeType} [${node.id}] visited ${count} times`).to.equal(1);
		}
	});

	it('getTotalCost() should equal estimatedCost + sum of children getTotalCost()', () => {
		// For any node, cost should be purely additive through getChildren()
		// The current bug multiplies by getRelations() cost, double-counting
		const plan = db.getPlan('select * from t where id > 1');

		const stack: PlanNode[] = [plan];
		while (stack.length > 0) {
			const node = stack.pop()!;
			const children = node.getChildren();
			const expectedTotal = node.estimatedCost + children.reduce(
				(sum, child) => sum + child.getTotalCost(), 0
			);

			expect(node.getTotalCost(),
				`Node ${node.nodeType} [${node.id}]: getTotalCost() should be additive`
			).to.equal(expectedTotal);

			for (const child of children) {
				stack.push(child);
			}
		}
	});

	it('visit() should not double-visit with subquery nodes', () => {
		// ExistsNode/ScalarSubqueryNode have getChildren() = [subquery],
		// getRelations() = [subquery] — same node in both
		const plan = db.getPlan('select * from t where exists (select 1 from t as t2 where t2.id = t.id)');

		const visitCounts = new Map<PlanNode, number>();
		plan.visit((node) => {
			visitCounts.set(node, (visitCounts.get(node) || 0) + 1);
		});

		for (const [node, count] of visitCounts) {
			expect(count, `Node ${node.nodeType} [${node.id}] visited ${count} times`).to.equal(1);
		}
	});
});

/**
 * Minimal synthetic PlanNode: a single optional child, a fixed self-cost of 1,
 * and no `computePhysical` override (so it inherits leaf/AND-of-children
 * defaults). Used to build an arbitrarily deep unary chain for the
 * no-stack-overflow regression.
 *
 * Fields are declared explicitly and assigned in the constructor body — the
 * test runner's TypeScript type-stripping does not support parameter properties.
 * The constructor stores only its own self-cost (never folds a child's cost), so
 * building a deep chain does not recurse at construction time.
 */
class ChainNode extends PlanNode {
	readonly nodeType = 'ChainNode' as PlanNodeType;
	readonly child?: ChainNode;

	constructor(scope: Scope, child?: ChainNode) {
		super(scope, 1);
		this.child = child;
	}

	getType(): BaseType {
		return { typeClass: 'void' };
	}

	getChildren(): readonly PlanNode[] {
		return this.child ? [this.child] : [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return this;
	}
}

describe('PlanNode: deep-plan traversal does not overflow the stack', () => {
	let db: Database;
	let scope: Scope;

	// Deep enough to blow the native call stack under the old recursive accessors
	// (reproduced overflow at 30 000).
	const DEPTH = 30_000;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		// Any real plan supplies a valid Scope; ChainNode never reads it, but the
		// PlanNode constructor requires one.
		scope = db.getPlan('select id, v from t').scope;
	});

	afterEach(async () => {
		await db.close();
	});

	/** Build a DEPTH-deep unary chain iteratively (never recursively). */
	function buildChain(depth: number): ChainNode {
		let node = new ChainNode(scope);
		for (let i = 0; i < depth; i++) {
			node = new ChainNode(scope, node);
		}
		return node;
	}

	it('physical does not overflow on a deep chain', () => {
		const root = buildChain(DEPTH);
		expect(() => root.physical).to.not.throw();
		// Deep read is memoized and O(1) the second time.
		expect(root.physical).to.equal(root.physical);
	});

	it('getTotalCost() does not overflow on a deep chain', () => {
		const root = buildChain(DEPTH);
		let total = 0;
		expect(() => { total = root.getTotalCost(); }).to.not.throw();
		// DEPTH + 1 nodes, each self-cost 1.
		expect(total).to.be.closeTo(DEPTH + 1, 1e-9);
	});

	it('visit() does not overflow on a deep chain', () => {
		const root = buildChain(DEPTH);
		let count = 0;
		expect(() => root.visit(() => { count++; })).to.not.throw();
		expect(count).to.equal(DEPTH + 1);
	});

	it('subtreeHasSideEffects() does not overflow on a deep chain', () => {
		const root = buildChain(DEPTH);
		let result: boolean | undefined;
		expect(() => { result = PlanNodeCharacteristics.subtreeHasSideEffects(root); }).to.not.throw();
		// ChainNode has no side effects (default readonly), so the walk drains fully.
		expect(result).to.equal(false);
	});
});

/**
 * Multi-child synthetic node that counts how many times its physical is folded.
 * Used to prove the iterative `physical` fold visits a shared (DAG) subtree node
 * exactly once. `computePhysical` bumps a per-instance counter and returns an
 * empty override so the defaults/merge path runs unchanged.
 */
class CountingNode extends PlanNode {
	readonly nodeType = 'CountingNode' as PlanNodeType;
	readonly kids: readonly PlanNode[];
	physicalComputeCount = 0;

	constructor(scope: Scope, kids: readonly PlanNode[] = []) {
		super(scope, 1);
		this.kids = kids;
	}

	getType(): BaseType {
		return { typeClass: 'void' };
	}

	getChildren(): readonly PlanNode[] {
		return this.kids;
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return this;
	}

	computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		this.physicalComputeCount++;
		return {};
	}
}

describe('PlanNode: physical fold visits a shared (DAG) subtree node once', () => {
	let db: Database;
	let scope: Scope;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		scope = db.getPlan('select id, v from t').scope;
	});

	afterEach(async () => {
		await db.close();
	});

	it('folds a diamond DAG (A→[B,C], B→[D], C→[D]) computing D exactly once', () => {
		// D is reachable via two parents. The isDone memo guard must fold it once
		// and populate its `_physical` before either parent reads it.
		const d = new CountingNode(scope);
		const b = new CountingNode(scope, [d]);
		const c = new CountingNode(scope, [d]);
		const a = new CountingNode(scope, [b, c]);

		void a.physical;

		expect(d.physicalComputeCount, 'shared node D folded exactly once').to.equal(1);
		expect(b.physicalComputeCount).to.equal(1);
		expect(c.physicalComputeCount).to.equal(1);
		expect(a.physicalComputeCount).to.equal(1);
		// Every node's memo is populated after the single fold.
		expect(d.physical).to.equal(d.physical);
		expect(d.physicalComputeCount, 'memoized — no recompute on re-read').to.equal(1);
	});
});

describe('PlanNode: iterative traversal matches a recursive reference on real plans', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
	});

	afterEach(async () => {
		await db.close();
	});

	const QUERIES = [
		'select * from t where id > 1',
		'select v, count(*) as c from t group by v order by c',
		'select * from t where exists (select 1 from t as t2 where t2.id = t.id)',
	];

	/** Independent recursive pre-order enumeration (shallow real plans only). */
	function recursivePreOrder(root: PlanNode): PlanNode[] {
		const out: PlanNode[] = [];
		const rec = (n: PlanNode): void => {
			out.push(n);
			for (const c of n.getChildren()) rec(c);
		};
		rec(root);
		return out;
	}

	/** Independent recursive whole-subtree cost (sum of self-costs via getChildren()). */
	function recursiveTotalCost(node: PlanNode): number {
		return node.estimatedCost + node.getChildren().reduce((s, c) => s + recursiveTotalCost(c), 0);
	}

	/**
	 * Independent recursive recomputation of physical, replicating the exact
	 * defaults/override merge in `PlanNode.get physical`. Reads each node's own
	 * (unchanged) `computePhysical` override, so any divergence signals a
	 * behavior change in the iterative fold.
	 */
	function recursivePhysical(node: PlanNode): PhysicalProperties {
		const childrenPhysical = node.getChildren().map(recursivePhysical);
		const propsOverride = node.computePhysical?.(childrenPhysical);
		const defaults = childrenPhysical.length
			? {
				deterministic: childrenPhysical.every(c => c.deterministic),
				idempotent: childrenPhysical.every(c => c.idempotent),
				readonly: childrenPhysical.every(c => c.readonly),
				expectedLatencyMs: childrenPhysical.reduce((a, c) => Math.max(a, c.expectedLatencyMs ?? 0), 0),
				concurrencySafe: childrenPhysical.every(c => c.concurrencySafe !== false),
			}
			: DEFAULT_PHYSICAL;
		return { ...defaults, ...propsOverride };
	}

	// Scalar physical fields the fold derives or passes through — safe for deep
	// equality (avoids comparing function-valued fields like updateLineage inverses,
	// which mint fresh closures on each computePhysical call).
	const PHYSICAL_KEYS = [
		'readonly', 'deterministic', 'idempotent', 'constant',
		'expectedLatencyMs', 'concurrencySafe', 'estimatedRows',
	] as const;

	for (const sql of QUERIES) {
		it(`visit order matches recursion for: ${sql}`, () => {
			const plan = db.getPlan(sql);
			const iterative: PlanNode[] = [];
			plan.visit(n => iterative.push(n));
			const recursive = recursivePreOrder(plan);
			expect(iterative.map(n => n.id)).to.deep.equal(recursive.map(n => n.id));
		});

		it(`getTotalCost matches recursion for every node in: ${sql}`, () => {
			const plan = db.getPlan(sql);
			for (const node of recursivePreOrder(plan)) {
				expect(node.getTotalCost(), `${node.nodeType} [${node.id}]`)
					.to.be.closeTo(recursiveTotalCost(node), 1e-9);
			}
		});

		it(`physical matches recursion for every node in: ${sql}`, () => {
			const plan = db.getPlan(sql);
			for (const node of recursivePreOrder(plan)) {
				const got = node.physical as Record<string, unknown>;
				const ref = recursivePhysical(node) as Record<string, unknown>;
				for (const k of PHYSICAL_KEYS) {
					expect(got[k], `${node.nodeType} [${node.id}].${k}`).to.deep.equal(ref[k]);
				}
			}
		});
	}
});
