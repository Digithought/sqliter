import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import { PassManager, TraversalOrder, createPass } from '../../src/planner/framework/pass.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { OptContext } from '../../src/planner/framework/context.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { Optimizer } from '../../src/planner/optimizer.js';
import type { StatsProvider } from '../../src/planner/stats/index.js';

type TestNode = {
	id: string;
	nodeType: PlanNodeType;
	getChildren(): readonly PlanNode[];
	withChildren(newChildren: readonly PlanNode[]): PlanNode;
	getLogicalAttributes(): Record<string, unknown>;
};

function createTestContext(db: Database, overrides?: Partial<OptContext>): OptContext {
	return {
		optimizer: {} as Optimizer,
		stats: {} as StatsProvider,
		tuning: { ...DEFAULT_TUNING, ...(overrides?.tuning ?? {}) },
		phase: 'rewrite',
		diagnostics: {},
		db,
		visitedRules: new Map(),
		optimizedNodes: new Map(),
		...overrides,
	};
}

describe('PassManager', () => {
	it('terminates local A→B→A rewrite cycles via visited tracking', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeNode = (nodeType: PlanNodeType): TestNode => {
				const self: TestNode = {
					id: String(nextId++),
					nodeType,
					getChildren: () => [],
					withChildren: () => self as unknown as PlanNode,
					getLogicalAttributes: () => ({}),
				};
				return self;
			};

			const pass = createPass(
				'test-cycle',
				'Test cycle',
				'Creates a local rewrite cycle for termination testing',
				0,
				TraversalOrder.TopDown
			);

			pass.rules.push(
				{
					id: 'a-filter-to-project',
					nodeType: PlanNodeType.Filter,
					phase: 'rewrite',
					fn: () => makeNode(PlanNodeType.Project) as unknown as PlanNode,
					sideEffectMode: 'safe',
				},
				{
					id: 'b-project-to-filter',
					nodeType: PlanNodeType.Project,
					phase: 'rewrite',
					fn: () => makeNode(PlanNodeType.Filter) as unknown as PlanNode,
					sideEffectMode: 'safe',
				},
			);

			const pm = new PassManager([]);
			pm.registerPass(pass);

			const context = createTestContext(db, {
				tuning: { ...DEFAULT_TUNING, maxOptimizationDepth: 100 }
			});

			const root = makeNode(PlanNodeType.Filter);
			const optimized = pm.execute(root as unknown as PlanNode, context);

			expect(optimized.nodeType).to.equal(PlanNodeType.Filter);

			const anyVisitedIncludesBoth = Array.from(context.visitedRules.values()).some(set =>
				set.has('a-filter-to-project') && set.has('b-project-to-filter')
			);
			expect(anyVisitedIncludesBoth).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('enforces maxOptimizationDepth during pass traversal', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeChain = (length: number): TestNode => {
				let current: TestNode | null = null;
				for (let i = 0; i < length; i++) {
					const child = current;
					const self: TestNode = {
						id: String(nextId++),
						nodeType: PlanNodeType.Filter,
						getChildren: () => (child ? [child as unknown as PlanNode] : []),
						withChildren: () => self as unknown as PlanNode,
						getLogicalAttributes: () => ({}),
					};
					current = self;
				}
				return current!;
			};

			const pass = createPass(
				'test-depth',
				'Test depth limiting',
				'Ensures traversal depth is bounded by tuning',
				0,
				TraversalOrder.TopDown
			);

			const pm = new PassManager([]);
			pm.registerPass(pass);

			// Use headroom: 0 so the budget is bounded by maxOptimizationDepth
			// vs. the input depth alone — otherwise the new input-scaled budget
			// would absorb the test chain.
			const context = createTestContext(db, {
				tuning: { ...DEFAULT_TUNING, maxOptimizationDepth: 5, optimizationDepthHeadroom: 0 }
			});

			const deepPlan = makeChain(20);

			expect(() => pm.execute(deepPlan as unknown as PlanNode, context)).to.throw(/Maximum optimization depth exceeded/);
		} finally {
			await db.close();
		}
	});

	it('depth budget scales with input plan depth (deep chains plan cleanly under default tuning)', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeChain = (length: number): TestNode => {
				let current: TestNode | null = null;
				for (let i = 0; i < length; i++) {
					const child = current;
					const self: TestNode = {
						id: String(nextId++),
						nodeType: PlanNodeType.Filter,
						getChildren: () => (child ? [child as unknown as PlanNode] : []),
						withChildren: () => self as unknown as PlanNode,
						getLogicalAttributes: () => ({}),
					};
					current = self;
				}
				return current!;
			};

			const pass = createPass(
				'test-deep-input',
				'Test deep input',
				'Deep input must not trip the depth guard under default tuning',
				0,
				TraversalOrder.TopDown
			);
			const pm = new PassManager([]);
			pm.registerPass(pass);

			// 200-deep chain — far exceeds default maxOptimizationDepth (50)
			// but should plan cleanly because the input-scaled budget kicks in.
			const deepPlan = makeChain(200);
			const context = createTestContext(db, { tuning: DEFAULT_TUNING });

			expect(() => pm.execute(deepPlan as unknown as PlanNode, context)).to.not.throw();
		} finally {
			await db.close();
		}
	});

	it('does not stack-overflow on deep plans (50,000-deep chain, both orders)', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeChain = (length: number): TestNode => {
				let current: TestNode | null = null;
				for (let i = 0; i < length; i++) {
					const child = current;
					const self: TestNode = {
						id: String(nextId++),
						nodeType: PlanNodeType.Filter,
						getChildren: () => (child ? [child as unknown as PlanNode] : []),
						withChildren: () => self as unknown as PlanNode,
						getLogicalAttributes: () => ({}),
					};
					current = self;
				}
				return current!;
			};

			const deepPlan = makeChain(50_000);

			for (const order of [TraversalOrder.TopDown, TraversalOrder.BottomUp]) {
				const pass = createPass(
					`test-deep-${order}`,
					`Test deep ${order}`,
					'No-op pass — only the traversal scaffolding is exercised',
					0,
					order
				);
				const pm = new PassManager([]);
				pm.registerPass(pass);

				const context = createTestContext(db, {
					tuning: {
						...DEFAULT_TUNING,
						maxOptimizationDepth: 100,
						optimizationDepthHeadroom: 100_000,
					},
				});

				let optimized: PlanNode | undefined;
				expect(() => {
					optimized = pm.execute(deepPlan as unknown as PlanNode, context);
				}).to.not.throw();

				// No rules fired, so the root reference is unchanged.
				expect(optimized).to.equal(deepPlan as unknown as PlanNode);
			}
		} finally {
			await db.close();
		}
	});

	it('preserves child ordering and rule semantics across a fan-out tree (sanity)', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeNode = (nodeType: PlanNodeType, children: PlanNode[]): TestNode => {
				const self: TestNode = {
					id: String(nextId++),
					nodeType,
					getChildren: () => children,
					withChildren: (newChildren) => makeNode(nodeType, [...newChildren]) as unknown as PlanNode,
					getLogicalAttributes: () => ({}),
				};
				return self;
			};

			// Depth-3 binary tree of Filter nodes (15 nodes total).
			const buildTree = (depth: number): TestNode => {
				if (depth === 0) return makeNode(PlanNodeType.Filter, []);
				const left = buildTree(depth - 1) as unknown as PlanNode;
				const right = buildTree(depth - 1) as unknown as PlanNode;
				return makeNode(PlanNodeType.Filter, [left, right]);
			};
			const root = buildTree(3);

			// Top-down: Filter -> Project (preserve children).
			const topDownPass = createPass(
				'sanity-top',
				'Sanity top-down',
				'Rewrite Filter to Project preserving children',
				0,
				TraversalOrder.TopDown
			);
			topDownPass.rules.push({
				id: 'filter-to-project',
				nodeType: PlanNodeType.Filter,
				phase: 'rewrite',
				fn: (node) => makeNode(PlanNodeType.Project, [...node.getChildren()]) as unknown as PlanNode,
				sideEffectMode: 'safe',
			});

			// Bottom-up: Project (leaf) -> SingleRow.
			const bottomUpPass = createPass(
				'sanity-bot',
				'Sanity bottom-up',
				'Rewrite leaf Project to ConstantRow',
				10,
				TraversalOrder.BottomUp
			);
			bottomUpPass.rules.push({
				id: 'leaf-project-to-single-row',
				nodeType: PlanNodeType.Project,
				phase: 'rewrite',
				fn: (node) => {
					if (node.getChildren().length === 0) {
						return makeNode(PlanNodeType.SingleRow, []) as unknown as PlanNode;
					}
					return node;
				},
				sideEffectMode: 'safe',
			});

			const pm = new PassManager([]);
			pm.registerPass(topDownPass);
			pm.registerPass(bottomUpPass);

			const context = createTestContext(db, { tuning: DEFAULT_TUNING });
			const optimized = pm.execute(root as unknown as PlanNode, context);

			// Root is now a Project, leaves are ConstantRow, internal nodes are Project.
			expect(optimized.nodeType).to.equal(PlanNodeType.Project);

			let leafCount = 0;
			let internalProjectCount = 0;
			const walk = (n: PlanNode): void => {
				const children = n.getChildren();
				if (children.length === 0) {
					expect(n.nodeType).to.equal(PlanNodeType.SingleRow);
					leafCount++;
				} else {
					expect(n.nodeType).to.equal(PlanNodeType.Project);
					internalProjectCount++;
					for (const c of children) walk(c);
				}
			};
			walk(optimized);
			// Binary tree of depth 3 → 8 leaves, 7 internal nodes.
			expect(leafCount).to.equal(8);
			expect(internalProjectCount).to.equal(7);
		} finally {
			await db.close();
		}
	});

	it('reuses cached results for shared subtrees within a single pass', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeNode = (nodeType: PlanNodeType, children: PlanNode[]): TestNode => {
				const self: TestNode = {
					id: String(nextId++),
					nodeType,
					getChildren: () => children,
					withChildren: (newChildren) => makeNode(nodeType, [...newChildren]) as unknown as PlanNode,
					getLogicalAttributes: () => ({}),
				};
				return self;
			};

			// Build a DAG: a single shared leaf reached via two parent paths.
			const sharedLeaf = makeNode(PlanNodeType.Filter, []);
			const left = makeNode(PlanNodeType.Filter, [sharedLeaf as unknown as PlanNode]);
			const right = makeNode(PlanNodeType.Filter, [sharedLeaf as unknown as PlanNode]);
			const root = makeNode(PlanNodeType.Filter, [
				left as unknown as PlanNode,
				right as unknown as PlanNode,
			]);

			// Rule fires once per distinct original node id. If the cache short-circuits
			// the second visit of `sharedLeaf`, the rule fires 4 times (root, left,
			// right, sharedLeaf), not 5.
			let firings = 0;
			const pass = createPass(
				'dag-sharing',
				'DAG sharing',
				'Confirm within-pass cache hits on shared subtrees',
				0,
				TraversalOrder.BottomUp
			);
			pass.rules.push({
				id: 'count-firings',
				nodeType: PlanNodeType.Filter,
				phase: 'rewrite',
				fn: (node) => {
					firings++;
					return makeNode(PlanNodeType.Project, [...node.getChildren()]) as unknown as PlanNode;
				},
				sideEffectMode: 'safe',
			});

			const pm = new PassManager([]);
			pm.registerPass(pass);

			const context = createTestContext(db, { tuning: DEFAULT_TUNING });
			pm.execute(root as unknown as PlanNode, context);

			expect(firings).to.equal(4);
		} finally {
			await db.close();
		}
	});

	it('maxRulesFired trips when total rule firings exceed the budget', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeFilterNode = (children: PlanNode[]): TestNode => {
				const self: TestNode = {
					id: String(nextId++),
					nodeType: PlanNodeType.Filter,
					getChildren: () => children,
					withChildren: (newChildren) => makeFilterNode([...newChildren]) as unknown as PlanNode,
					getLogicalAttributes: () => ({}),
				};
				return self;
			};

			// Build a 200-deep chain of distinct Filter nodes
			let current: TestNode = makeFilterNode([]);
			for (let i = 1; i < 200; i++) {
				current = makeFilterNode([current as unknown as PlanNode]);
			}

			const pass = createPass(
				'test-rules-fired',
				'Test rules-fired budget',
				'A rule firing on every node in a long chain must trip the rules-fired budget',
				0,
				TraversalOrder.TopDown
			);
			// Rule rewrites every Filter to a fresh Filter (different identity)
			// once per original node. Across 200 chain levels that's 200 firings,
			// well over the 50-budget set below.
			pass.rules.push({
				id: 'always-rewrite',
				nodeType: PlanNodeType.Filter,
				phase: 'rewrite',
				fn: (node) => makeFilterNode([...node.getChildren()]) as unknown as PlanNode,
				sideEffectMode: 'safe',
			});

			const pm = new PassManager([]);
			pm.registerPass(pass);
			const context = createTestContext(db, {
				tuning: { ...DEFAULT_TUNING, maxRulesFired: 50 }
			});

			expect(() => pm.execute(current as unknown as PlanNode, context))
				.to.throw(/maxRulesFired/);
		} finally {
			await db.close();
		}
	});
});

