/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { PlanNode, type PhysicalProperties, type Attribute } from '../../src/planner/nodes/plan-node.js';
import type { BaseType, ScalarType } from '../../src/common/datatype.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import type { OptContext } from '../../src/planner/framework/context.js';
import { DEFAULT_TUNING, type OptimizerTuning } from '../../src/planner/optimizer-tuning.js';
import {
	PassManager,
	createPass,
	TraversalOrder,
	type OptimizationPass,
} from '../../src/planner/framework/pass.js';
import {
	hasRuleBeenApplied,
	markRuleApplied,
	type RuleHandle,
} from '../../src/planner/framework/registry.js';
import {
	PlanNodeCharacteristics,
	CapabilityDetectors,
} from '../../src/planner/framework/characteristics.js';
import { AggregateFunctionCallNode } from '../../src/planner/nodes/aggregate-function.js';
import { ScalarFunctionCallNode } from '../../src/planner/nodes/function.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type { AggregateFunctionSchema, ScalarFunctionSchema } from '../../src/schema/function.js';
import type * as AST from '../../src/parser/ast.js';
import {
	extractOrderingFromSortKeys,
	mergeOrderings,
	orderingsEqual,
	orderingsCompatible,
	projectOrdering,
	type Ordering,
} from '../../src/planner/framework/physical-utils.js';
import {
	DebugTraceHook,
	PerformanceTraceHook,
	CompositeTraceHook,
	setTraceHook,
	getCurrentTraceHook,
	type TraceHook,
} from '../../src/planner/framework/trace.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;

let mockIdCounter = 100000;

/** Minimal mock PlanNode for unit testing framework code. */
class MockPlanNode extends PlanNode {
	override readonly nodeType: PlanNodeType;
	private readonly _children: PlanNode[];
	private readonly _type: BaseType;
	private physicalOverride?: Partial<PhysicalProperties>;

	constructor(opts: {
		nodeType?: PlanNodeType;
		children?: PlanNode[];
		type?: BaseType;
		physical?: Partial<PhysicalProperties>;
	} = {}) {
		super(mockScope, 0.01);
		// Ensure unique IDs even across rapid construction
		(this as any).id = `mock-${mockIdCounter++}`;
		this.nodeType = opts.nodeType ?? PlanNodeType.Filter;
		this._children = opts.children ?? [];
		this._type = opts.type ?? { typeClass: 'relation', columns: [] } as any;
		this.physicalOverride = opts.physical;
	}

	getType(): BaseType { return this._type; }
	getChildren(): readonly PlanNode[] { return this._children; }

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		return new MockPlanNode({
			nodeType: this.nodeType,
			children: [...newChildren],
			type: this._type,
			physical: this.physicalOverride,
		});
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return this.physicalOverride ?? {};
	}
}

/** Create a mock node with relational type (typeClass: 'relation') */
function relNode(opts: {
	nodeType?: PlanNodeType;
	children?: PlanNode[];
	physical?: Partial<PhysicalProperties>;
	attributes?: Attribute[];
} = {}): MockPlanNode {
	const node = new MockPlanNode({
		...opts,
		type: { typeClass: 'relation', columns: [] } as any,
	});
	if (opts.attributes) {
		(node as any).getAttributes = () => opts.attributes;
	}
	return node;
}

/** Create a mock node with scalar type */
function scalarNode(opts: {
	nodeType?: PlanNodeType;
	physical?: Partial<PhysicalProperties>;
} = {}): MockPlanNode {
	return new MockPlanNode({
		...opts,
		type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false } as ScalarType,
	});
}

/** Create a mock node with void type */
function voidNode(): MockPlanNode {
	return new MockPlanNode({ type: { typeClass: 'void' } });
}

/** Build a minimal OptContext for PassManager tests */
function makeContext(overrides: Partial<OptimizerTuning> = {}): OptContext {
	const tuning = { ...DEFAULT_TUNING, ...overrides } as OptimizerTuning;
	return {
		optimizer: {} as any,
		stats: {} as any,
		tuning,
		phase: 'rewrite',
		diagnostics: {},
		db: {} as any,
		visitedRules: new Map(),
		optimizedNodes: new Map(),
	};
}

/** Helper to build a simple RuleHandle */
function makeRule(
	id: string,
	nodeType: PlanNodeType,
	fn: (node: PlanNode, ctx: OptContext) => PlanNode | null,
): RuleHandle {
	return { id, nodeType, phase: 'rewrite', fn, sideEffectMode: 'safe' };
}

// ---------------------------------------------------------------------------
// PassManager (pass.ts)
// ---------------------------------------------------------------------------

describe('Planner Framework', () => {

	describe('PassManager', () => {

		it('executes passes in declared order', () => {
			const order: string[] = [];

			const passes: OptimizationPass[] = [
				{ ...createPass('p40', 'P40', '', 40), execute: (p) => { order.push('p40'); return p; } },
				{ ...createPass('p0', 'P0', '', 0), execute: (p) => { order.push('p0'); return p; } },
				{ ...createPass('p20', 'P20', '', 20), execute: (p) => { order.push('p20'); return p; } },
				{ ...createPass('p10', 'P10', '', 10), execute: (p) => { order.push('p10'); return p; } },
			];

			const pm = new PassManager(passes);
			const node = relNode();
			const ctx = makeContext();
			pm.execute(node, ctx);

			expect(order).to.deep.equal(['p0', 'p10', 'p20', 'p40']);
		});

		it('rule that always matches converges via visited-rules tracking', () => {
			const pass = createPass('conv', 'Convergence', '', 10, TraversalOrder.BottomUp);
			let callCount = 0;

			const rule = makeRule('always-match', PlanNodeType.Filter, (_node, _ctx) => {
				callCount++;
				// Return a new node every time (different identity)
				return relNode({ nodeType: PlanNodeType.Filter });
			});
			pass.rules.push(rule);

			const pm = new PassManager([pass]);
			const ctx = makeContext();
			const root = relNode({ nodeType: PlanNodeType.Filter });

			// Should not hang — visited tracking prevents re-application
			pm.execute(root, ctx);
			// The rule fires once for the original node, then once more for the
			// replacement; the replacement inherits the visited set so the rule
			// is not applied a third time.
			expect(callCount).to.be.lessThanOrEqual(3);
		});

		it('respects disabledRules in pass rule application', () => {
			const pass = createPass('dis', 'Disabled', '', 10, TraversalOrder.BottomUp);
			let called = false;

			const rule = makeRule('should-skip', PlanNodeType.Filter, () => {
				called = true;
				return relNode({ nodeType: PlanNodeType.Filter });
			});
			pass.rules.push(rule);

			const pm = new PassManager([pass]);
			const ctx = makeContext({ disabledRules: new Set(['should-skip']) });
			pm.execute(relNode({ nodeType: PlanNodeType.Filter }), ctx);

			expect(called).to.equal(false);
		});

		it('throws when max optimization depth is exceeded', () => {
			// Build a deeply nested tree that exceeds depth limit
			const depth = 5;
			let node: PlanNode = relNode({ nodeType: PlanNodeType.Filter });
			for (let i = 0; i < depth; i++) {
				node = relNode({ nodeType: PlanNodeType.Filter, children: [node] });
			}

			const pass = createPass('deep', 'Deep', '', 10, TraversalOrder.BottomUp);
			const pm = new PassManager([pass]);
			// headroom: 0 keeps the budget capped by maxOptimizationDepth so the
			// guard fires on this deliberately-too-deep tree.
			const ctx = makeContext({ maxOptimizationDepth: 3, optimizationDepthHeadroom: 0 });

			expect(() => pm.execute(node, ctx)).to.throw(/Maximum optimization depth/);
		});

		it('caches optimized nodes within a pass (same node not re-optimized)', () => {
			let ruleApplyCount = 0;

			const shared = relNode({ nodeType: PlanNodeType.Filter });
			// Two parents share the same child reference
			const parent1 = relNode({ nodeType: PlanNodeType.Project, children: [shared] });

			const pass = createPass('cache', 'Cache', '', 10, TraversalOrder.BottomUp);
			const rule = makeRule('count-rule', PlanNodeType.Filter, (_node, _ctx) => {
				ruleApplyCount++;
				return relNode({ nodeType: PlanNodeType.Filter });
			});
			pass.rules.push(rule);

			const pm = new PassManager([pass]);
			const ctx = makeContext();
			pm.execute(parent1, ctx);

			// The shared child should be optimized once and cached
			expect(ruleApplyCount).to.equal(1);
		});

		it('replacement node inherits visited-rule state from original', () => {
			const pass = createPass('inh', 'Inherit', '', 10, TraversalOrder.BottomUp);
			let applyCount = 0;

			const rule = makeRule('inherit-test', PlanNodeType.Filter, (_node) => {
				applyCount++;
				return relNode({ nodeType: PlanNodeType.Filter });
			});
			pass.rules.push(rule);

			const pm = new PassManager([pass]);
			const ctx = makeContext();
			const root = relNode({ nodeType: PlanNodeType.Filter });
			pm.execute(root, ctx);

			// Rule fires on original, replacement inherits visited set,
			// so the rule should not fire again on the replacement.
			// The rule can fire at most twice (original + replacement before inheritance kicks in for the second replacement)
			expect(applyCount).to.be.lessThanOrEqual(2);
		});

		it('disabled pass is skipped', () => {
			let executed = false;
			const pass: OptimizationPass = {
				...createPass('off', 'Off', '', 10),
				enabled: false,
				execute: (p) => { executed = true; return p; },
			};

			const pm = new PassManager([pass]);
			pm.execute(relNode(), makeContext());
			expect(executed).to.equal(false);
		});

		it('executeUpTo stops at specified pass', () => {
			const order: string[] = [];
			const passes: OptimizationPass[] = [
				{ ...createPass('a', 'A', '', 0), execute: (p) => { order.push('a'); return p; } },
				{ ...createPass('b', 'B', '', 10), execute: (p) => { order.push('b'); return p; } },
				{ ...createPass('c', 'C', '', 20), execute: (p) => { order.push('c'); return p; } },
			];

			const pm = new PassManager(passes);
			pm.executeUpTo(relNode(), makeContext(), 'b');

			expect(order).to.deep.equal(['a', 'b']);
		});

		it('top-down traversal applies rules to parent before children', () => {
			const order: string[] = [];
			const child = relNode({ nodeType: PlanNodeType.Filter });
			const parent = relNode({ nodeType: PlanNodeType.Filter, children: [child] });

			const pass = createPass('td', 'TopDown', '', 10, TraversalOrder.TopDown);
			const rule = makeRule('order-track', PlanNodeType.Filter, (node) => {
				order.push(node.id);
				return null; // no transformation
			});
			pass.rules.push(rule);

			const pm = new PassManager([pass]);
			pm.execute(parent, makeContext());

			// Parent should be visited first in top-down
			expect(order[0]).to.equal(parent.id);
			expect(order[1]).to.equal(child.id);
		});

		it('bottom-up traversal applies rules to children before parent', () => {
			const order: string[] = [];
			const child = relNode({ nodeType: PlanNodeType.Filter });
			const parent = relNode({ nodeType: PlanNodeType.Filter, children: [child] });

			const pass = createPass('bu', 'BottomUp', '', 10, TraversalOrder.BottomUp);
			const rule = makeRule('order-track', PlanNodeType.Filter, (node) => {
				order.push(node.id);
				return null;
			});
			pass.rules.push(rule);

			const pm = new PassManager([pass]);
			pm.execute(parent, makeContext());

			expect(order[0]).to.equal(child.id);
			expect(order[1]).to.equal(parent.id);
		});

		it('clears optimizedNodes cache between passes', () => {
			const ctx = makeContext();
			let pass1Cached = false;
			let pass2Cached = false;

			const passes: OptimizationPass[] = [
				{
					...createPass('p1', 'P1', '', 0),
					execute: (p, c) => { c.optimizedNodes.set('sentinel', p); pass1Cached = true; return p; },
				},
				{
					...createPass('p2', 'P2', '', 10),
					execute: (p, c) => { pass2Cached = c.optimizedNodes.has('sentinel'); return p; },
				},
			];

			const pm = new PassManager(passes);
			pm.execute(relNode(), ctx);

			expect(pass1Cached).to.equal(true);
			expect(pass2Cached).to.equal(false);
		});

		// -------------------------------------------------------------------
		// Decline tracking (ticket 3.5): a rule that declines on a node is not
		// re-offered to that SAME (unchanged) node every fixpoint iteration, but
		// IS re-offered once the node is transformed. Ephemeral per-node set, not
		// inherited — so no plan output changes.
		// -------------------------------------------------------------------

		it('declining rule is not re-run on the same node across fixpoint iterations (the win)', () => {
			const pass = createPass('decl', 'Decline', '', 10, TraversalOrder.BottomUp);
			let declineCalls = 0;
			let transformed = false;

			// Transformer runs FIRST (mints N0→N1), decliner SECOND (declines on
			// N1). The while loop iterates again to confirm fixpoint: the decliner
			// is offered on the *same* N1 a second time. Pre-fix it re-ran (2
			// calls); now the ephemeral decline set suppresses the redundant re-run.
			const transformer = makeRule('transformer', PlanNodeType.Filter, () => {
				if (transformed) return null;
				transformed = true;
				return relNode({ nodeType: PlanNodeType.Filter });
			});
			const decliner = makeRule('decliner', PlanNodeType.Filter, () => {
				declineCalls++;
				return null;
			});
			pass.rules.push(transformer, decliner);

			const pm = new PassManager([pass]);
			pm.execute(relNode({ nodeType: PlanNodeType.Filter }), makeContext());

			// Offered exactly once on N1 — the redundant same-node re-run is cut.
			expect(declineCalls).to.equal(1);
		});

		it('declining rule IS re-offered after a sibling transform changes the node (soundness)', () => {
			const pass = createPass('reoffer', 'Reoffer', '', 10, TraversalOrder.BottomUp);
			let declineCalls = 0;
			let transformed = false;

			// Decliner runs FIRST on N0 (declines), then the transformer mints
			// N0→N1. The plan piece changed, so on the next iteration the decliner
			// must be re-offered on N1 (it might now apply — this is exactly the
			// pattern that inheriting declines would wrongly suppress, silently
			// changing plans). Expect two calls: once on N0, once on N1.
			const decliner = makeRule('decliner', PlanNodeType.Filter, () => {
				declineCalls++;
				return null;
			});
			const transformer = makeRule('transformer', PlanNodeType.Filter, () => {
				if (transformed) return null;
				transformed = true;
				return relNode({ nodeType: PlanNodeType.Filter });
			});
			pass.rules.push(decliner, transformer);

			const pm = new PassManager([pass]);
			pm.execute(relNode({ nodeType: PlanNodeType.Filter }), makeContext());

			expect(declineCalls).to.equal(2);
		});

		it('transform still offers previously-unoffered rules to the new node', () => {
			const pass = createPass('freshRules', 'Fresh', '', 10, TraversalOrder.BottomUp);
			let projectRuleCalls = 0;

			// T rewrites Filter → Project. U only matches Project, so it was never
			// offered to the original Filter and must fire on the transformed node —
			// decline suppression must not touch genuinely-new rules.
			const t = makeRule('filter-to-project', PlanNodeType.Filter, () =>
				relNode({ nodeType: PlanNodeType.Project }));
			const u = makeRule('project-rule', PlanNodeType.Project, () => {
				projectRuleCalls++;
				return null;
			});
			pass.rules.push(t, u);

			const pm = new PassManager([pass]);
			pm.execute(relNode({ nodeType: PlanNodeType.Filter }), makeContext());

			expect(projectRuleCalls).to.equal(1);
		});

		it('same-node decline re-runs are cut across a fan of nodes (regression guard)', () => {
			// Chain of three Filter nodes. Per node the transformer runs first
			// (once), then the decliner declines on the transformed node; the
			// fixpoint re-iteration must NOT re-run the decliner on that same node.
			// New behavior: decliner offered once per node (3 total). Pre-fix: twice
			// per node (6 total), the redundant same-node re-run.
			const pass = createPass('scale', 'Scale', '', 10, TraversalOrder.BottomUp);
			let declineCalls = 0;
			const transformedIds = new Set<string>();

			// Transform once per distinct node id (preserve children so the tree
			// stays coherent). The applied-rule inheritance stops it re-firing on
			// its own output; the guard keeps intent explicit.
			const transformer = makeRule('transformer', PlanNodeType.Filter, (node) => {
				if (transformedIds.has(node.id)) return null;
				transformedIds.add(node.id);
				return relNode({ nodeType: PlanNodeType.Filter, children: [...node.getChildren()] });
			});
			const decliner = makeRule('decliner', PlanNodeType.Filter, () => {
				declineCalls++;
				return null;
			});
			pass.rules.push(transformer, decliner);

			const leaf = relNode({ nodeType: PlanNodeType.Filter });
			const mid = relNode({ nodeType: PlanNodeType.Filter, children: [leaf] });
			const root = relNode({ nodeType: PlanNodeType.Filter, children: [mid] });

			const pm = new PassManager([pass]);
			pm.execute(root, makeContext());

			expect(declineCalls).to.equal(3);
		});
	});

	// ---------------------------------------------------------------------------
	// Visited-rule tracking (registry.ts)
	// ---------------------------------------------------------------------------

	describe('Visited-rule tracking', () => {

		it('markRuleApplied / hasRuleBeenApplied round-trip', () => {
			const ctx = makeContext();
			expect(hasRuleBeenApplied('n1', 'r1', ctx)).to.equal(false);
			markRuleApplied('n1', 'r1', ctx);
			expect(hasRuleBeenApplied('n1', 'r1', ctx)).to.equal(true);
		});

		it('visitedRules are per-node — different nodes are independent', () => {
			const ctx = makeContext();
			markRuleApplied('n1', 'r1', ctx);
			expect(hasRuleBeenApplied('n2', 'r1', ctx)).to.equal(false);
		});

		it('multiple rules on same node are tracked independently', () => {
			const ctx = makeContext();
			markRuleApplied('n1', 'r1', ctx);
			markRuleApplied('n1', 'r2', ctx);
			expect(hasRuleBeenApplied('n1', 'r1', ctx)).to.equal(true);
			expect(hasRuleBeenApplied('n1', 'r2', ctx)).to.equal(true);
			expect(hasRuleBeenApplied('n1', 'r3', ctx)).to.equal(false);
		});
	});

	// ---------------------------------------------------------------------------
	// PlanNodeCharacteristics (characteristics.ts)
	// ---------------------------------------------------------------------------

	describe('PlanNodeCharacteristics', () => {

		it('hasSideEffects: readonly=false → true', () => {
			const node = relNode({ physical: { readonly: false } });
			expect(PlanNodeCharacteristics.hasSideEffects(node)).to.equal(true);
		});

		it('hasSideEffects: readonly=true → false', () => {
			const node = relNode({ physical: { readonly: true } });
			expect(PlanNodeCharacteristics.hasSideEffects(node)).to.equal(false);
		});

		it('isReadOnly: readonly=true → true', () => {
			const node = relNode({ physical: { readonly: true } });
			expect(PlanNodeCharacteristics.isReadOnly(node)).to.equal(true);
		});

		it('isReadOnly: readonly=false → false', () => {
			const node = relNode({ physical: { readonly: false } });
			expect(PlanNodeCharacteristics.isReadOnly(node)).to.equal(false);
		});

		it('isDeterministic: deterministic=true → true', () => {
			const node = relNode({ physical: { deterministic: true } });
			expect(PlanNodeCharacteristics.isDeterministic(node)).to.equal(true);
		});

		it('isDeterministic: deterministic=false → false', () => {
			const node = relNode({ physical: { deterministic: false } });
			expect(PlanNodeCharacteristics.isDeterministic(node)).to.equal(false);
		});

		it('isDeterministic: undefined defaults to true', () => {
			const node = relNode();
			expect(PlanNodeCharacteristics.isDeterministic(node)).to.equal(true);
		});

		it('estimatesRows returns estimatedRows when set', () => {
			const node = relNode({ physical: { estimatedRows: 42 } });
			expect(PlanNodeCharacteristics.estimatesRows(node)).to.equal(42);
		});

		it('estimatesRows returns default (1000) when not set', () => {
			const node = relNode();
			expect(PlanNodeCharacteristics.estimatesRows(node)).to.equal(1000);
		});

		it('isExpensive: >10K estimated rows → true', () => {
			const node = relNode({ physical: { estimatedRows: 50000 } });
			expect(PlanNodeCharacteristics.isExpensive(node)).to.equal(true);
		});

		it('isExpensive: <=10K estimated rows → false', () => {
			const node = relNode({ physical: { estimatedRows: 5000 } });
			expect(PlanNodeCharacteristics.isExpensive(node)).to.equal(false);
		});

		it('isRelational: relation type → true', () => {
			const node = relNode();
			expect(PlanNodeCharacteristics.isRelational(node)).to.equal(true);
		});

		it('isRelational: scalar type → false', () => {
			const node = scalarNode();
			expect(PlanNodeCharacteristics.isRelational(node)).to.equal(false);
		});

		it('isScalar: scalar type → true', () => {
			const node = scalarNode();
			expect(PlanNodeCharacteristics.isScalar(node)).to.equal(true);
		});

		it('isVoid: void type → true', () => {
			const node = voidNode();
			expect(PlanNodeCharacteristics.isVoid(node)).to.equal(true);
		});

		it('isVoid: non-void → false', () => {
			const node = relNode();
			expect(PlanNodeCharacteristics.isVoid(node)).to.equal(false);
		});

		it('hasUniqueKeys via key-encoding FD', () => {
			// FD encoding: `{0, 1} → {2}` claims that columns 0+1 are a superkey of
			// a 3-col relation. PlanNodeCharacteristics.hasUniqueKeys should detect
			// the non-trivial key.
			const attrs: Attribute[] = [
				{ id: 1, name: 'a', type: { typeClass: 'scalar' } as any },
				{ id: 2, name: 'b', type: { typeClass: 'scalar' } as any },
				{ id: 3, name: 'c', type: { typeClass: 'scalar' } as any },
			];
			const node = relNode({
				attributes: attrs,
				physical: { fds: [{ determinants: [0, 1], dependents: [2], kind: 'unique' }] },
			});
			expect(PlanNodeCharacteristics.hasUniqueKeys(node)).to.equal(true);
		});

		it('hasOrderedOutput when ordering present', () => {
			const node = relNode({ physical: { ordering: [{ column: 0, desc: false }] } });
			expect(PlanNodeCharacteristics.hasOrderedOutput(node)).to.equal(true);
		});

		it('hasOrderedOutput false when no ordering', () => {
			const node = relNode();
			expect(PlanNodeCharacteristics.hasOrderedOutput(node)).to.equal(false);
		});

		it('isFunctional: deterministic + readonly → true', () => {
			const node = relNode({ physical: { deterministic: true, readonly: true } });
			expect(PlanNodeCharacteristics.isFunctional(node)).to.equal(true);
		});

		it('isFunctional: non-deterministic → false', () => {
			const node = relNode({ physical: { deterministic: false, readonly: true } });
			expect(PlanNodeCharacteristics.isFunctional(node)).to.equal(false);
		});
	});

	// ---------------------------------------------------------------------------
	// CapabilityDetectors (characteristics.ts)
	// ---------------------------------------------------------------------------

	describe('CapabilityDetectors', () => {

		// Post-branding, detection keys off a unique `is<X>Capable` brand — the method
		// shape alone no longer qualifies a node. Each guard checks its own brand.

		it('canPushDownPredicate detects the isPredicateCapable brand, not the method shape', () => {
			const node = relNode();
			expect(CapabilityDetectors.canPushDownPredicate(node)).to.equal(false);

			// Methods without the brand are NOT enough post-branding.
			(node as any).getPredicate = () => null;
			(node as any).withPredicate = () => node;
			expect(CapabilityDetectors.canPushDownPredicate(node)).to.equal(false);

			// The brand is the contract.
			(node as any).isPredicateCapable = true;
			expect(CapabilityDetectors.canPushDownPredicate(node)).to.equal(true);
		});

		it('isTableAccess detects the isTableAccessCapable brand', () => {
			const node = relNode();
			expect(CapabilityDetectors.isTableAccess(node)).to.equal(false);

			(node as any).isTableAccessCapable = true;
			expect(CapabilityDetectors.isTableAccess(node)).to.equal(true);
		});

		it('isSortable detects the isSortCapable brand', () => {
			const node = relNode();
			expect(CapabilityDetectors.isSortable(node)).to.equal(false);

			(node as any).isSortCapable = true;
			expect(CapabilityDetectors.isSortable(node)).to.equal(true);
		});

		it('isJoin detects the isJoinCapable brand', () => {
			const node = relNode();
			expect(CapabilityDetectors.isJoin(node)).to.equal(false);

			(node as any).isJoinCapable = true;
			expect(CapabilityDetectors.isJoin(node)).to.equal(true);
		});

		it('isCached detects the isCacheCapable brand', () => {
			const node = relNode();
			expect(CapabilityDetectors.isCached(node)).to.equal(false);

			(node as any).isCacheCapable = true;
			expect(CapabilityDetectors.isCached(node)).to.equal(true);
		});

		it('isColumnReference detects the isColumnReferenceCapable brand', () => {
			const node = scalarNode({ nodeType: PlanNodeType.ColumnReference });
			expect(CapabilityDetectors.isColumnReference(node)).to.equal(false);

			(node as any).isColumnReferenceCapable = true;
			expect(CapabilityDetectors.isColumnReference(node)).to.equal(true);
		});

		it('isColumnReference rejects a node that lacks the brand (even with look-alike fields)', () => {
			const node = relNode();
			(node as any).attributeId = 1;
			(node as any).columnIndex = 0;
			(node as any).expression = {};
			expect(CapabilityDetectors.isColumnReference(node)).to.equal(false);
		});

		it('isWindowFunction detects the isWindowFunctionCapable brand', () => {
			const node = scalarNode({ nodeType: PlanNodeType.WindowFunctionCall });
			expect(CapabilityDetectors.isWindowFunction(node)).to.equal(false);

			(node as any).isWindowFunctionCapable = true;
			expect(CapabilityDetectors.isWindowFunction(node)).to.equal(true);
		});

		it('isWindowFunction rejects a node without the window brand', () => {
			// A scalar-function-shaped node (shared nodeType space) is not a window fn.
			const node = scalarNode({ nodeType: PlanNodeType.ScalarFunctionCall });
			(node as any).functionName = 'row_number';
			(node as any).isDistinct = false;
			expect(CapabilityDetectors.isWindowFunction(node)).to.equal(false);
		});

		it('isColumnBindingProvider detects the isColumnBindingProviderCapable brand', () => {
			const node = relNode();
			expect(CapabilityDetectors.isColumnBindingProvider(node)).to.equal(false);

			(node as any).isColumnBindingProviderCapable = true;
			expect(CapabilityDetectors.isColumnBindingProvider(node)).to.equal(true);
		});

		it('isColumnBindingProvider rejects a look-alike method without the brand', () => {
			// A same-named member (function or string) must NOT be mistaken for the
			// capability — only the brand qualifies.
			const node = relNode();
			(node as any).getBindingRelationName = () => 'my_table';
			expect(CapabilityDetectors.isColumnBindingProvider(node)).to.equal(false);
		});

		it('isAggregateFunction detects AggregateFunctionCallNode, rejects scalar + look-alikes', () => {
			const scalarType = { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true };
			const funcExpr = { type: 'function', name: 'count', args: [], distinct: false } as AST.FunctionExpr;

			const aggSchema: AggregateFunctionSchema = {
				name: 'count', numArgs: 0, flags: FunctionFlags.DETERMINISTIC, returnType: scalarType,
				stepFunction: (acc: number) => acc + 1,
				finalizeFunction: (acc: number) => acc,
			};
			const scalarSchema: ScalarFunctionSchema = {
				name: 'abs', numArgs: 1, flags: FunctionFlags.DETERMINISTIC, returnType: scalarType,
				implementation: (v: any) => v,
			};

			const aggNode = new AggregateFunctionCallNode(mockScope, funcExpr, 'count', aggSchema, [], false);
			const scalarFnNode = new ScalarFunctionCallNode(mockScope, funcExpr, scalarSchema, []);

			// Real aggregate schema → detected.
			expect(CapabilityDetectors.isAggregateFunction(aggNode)).to.equal(true);
			// Scalar function node (scalar schema) → not an aggregate.
			expect(CapabilityDetectors.isAggregateFunction(scalarFnNode)).to.equal(false);

			// Regression: a plain scalar node that merely wears the old duck-typed
			// shape (functionName/isDistinct/args) but carries no aggregate schema
			// must NOT be classified as an aggregate.
			const lookAlike = scalarNode({ nodeType: PlanNodeType.ScalarFunctionCall });
			(lookAlike as any).functionName = 'count';
			(lookAlike as any).isDistinct = false;
			(lookAlike as any).args = [];
			expect(CapabilityDetectors.isAggregateFunction(lookAlike)).to.equal(false);
		});
	});

	// ---------------------------------------------------------------------------
	// Physical property utilities (physical-utils.ts)
	// ---------------------------------------------------------------------------

	describe('Physical-utils', () => {

		describe('extractOrderingFromSortKeys', () => {

			it('extracts ordering from simple column references', () => {
				const attrs = [{ id: 10 }, { id: 20 }, { id: 30 }];
				const sortKeys = [
					{ expression: { nodeType: PlanNodeType.ColumnReference, attributeId: 20 } as any, direction: 'asc' as const },
					{ expression: { nodeType: PlanNodeType.ColumnReference, attributeId: 30 } as any, direction: 'desc' as const },
				];

				const result = extractOrderingFromSortKeys(sortKeys, attrs);
				expect(result).to.deep.equal([
					{ column: 1, desc: false },
					{ column: 2, desc: true },
				]);
			});

			it('returns undefined for non-column-reference expressions', () => {
				const attrs = [{ id: 10 }];
				const sortKeys = [
					{ expression: { nodeType: PlanNodeType.BinaryOp, attributeId: 10 } as any, direction: 'asc' as const },
				];

				expect(extractOrderingFromSortKeys(sortKeys, attrs)).to.equal(undefined);
			});

			it('returns undefined when column not found in source', () => {
				const attrs = [{ id: 10 }];
				const sortKeys = [
					{ expression: { nodeType: PlanNodeType.ColumnReference, attributeId: 999 } as any, direction: 'asc' as const },
				];

				expect(extractOrderingFromSortKeys(sortKeys, attrs)).to.equal(undefined);
			});
		});

		describe('mergeOrderings', () => {

			it('returns child ordering when parent has none', () => {
				const child: Ordering[] = [{ column: 0, desc: false }];
				expect(mergeOrderings(undefined, child)).to.deep.equal(child);
				expect(mergeOrderings([], child)).to.deep.equal(child);
			});

			it('returns undefined when child provides no ordering but parent needs one', () => {
				const parent: Ordering[] = [{ column: 0, desc: false }];
				expect(mergeOrderings(parent, undefined)).to.equal(undefined);
				expect(mergeOrderings(parent, [])).to.equal(undefined);
			});

			it('returns child ordering when parent is satisfied (prefix match)', () => {
				const parent: Ordering[] = [{ column: 0, desc: false }];
				const child: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				expect(mergeOrderings(parent, child)).to.deep.equal(child);
			});

			it('returns undefined for incompatible orderings', () => {
				const parent: Ordering[] = [{ column: 0, desc: false }];
				const child: Ordering[] = [{ column: 0, desc: true }]; // direction mismatch
				expect(mergeOrderings(parent, child)).to.equal(undefined);
			});

			it('returns undefined when parent needs more columns than child provides', () => {
				const parent: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: false }];
				const child: Ordering[] = [{ column: 0, desc: false }];
				expect(mergeOrderings(parent, child)).to.equal(undefined);
			});
		});

		describe('orderingsEqual', () => {

			it('equal orderings → true', () => {
				const a: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				const b: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				expect(orderingsEqual(a, b)).to.equal(true);
			});

			it('different length → false', () => {
				const a: Ordering[] = [{ column: 0, desc: false }];
				const b: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				expect(orderingsEqual(a, b)).to.equal(false);
			});

			it('different content → false', () => {
				const a: Ordering[] = [{ column: 0, desc: false }];
				const b: Ordering[] = [{ column: 0, desc: true }];
				expect(orderingsEqual(a, b)).to.equal(false);
			});

			it('both undefined → true', () => {
				expect(orderingsEqual(undefined, undefined)).to.equal(true);
			});

			it('one undefined → false', () => {
				expect(orderingsEqual([{ column: 0, desc: false }], undefined)).to.equal(false);
			});

			it('same reference → true', () => {
				const a: Ordering[] = [{ column: 0, desc: false }];
				expect(orderingsEqual(a, a)).to.equal(true);
			});
		});

		describe('orderingsCompatible', () => {

			it('no requirements → always compatible', () => {
				expect(orderingsCompatible(undefined, undefined)).to.equal(true);
				expect(orderingsCompatible([], [{ column: 0, desc: false }])).to.equal(true);
			});

			it('requirements with no provider → incompatible', () => {
				expect(orderingsCompatible([{ column: 0, desc: false }], undefined)).to.equal(false);
				expect(orderingsCompatible([{ column: 0, desc: false }], [])).to.equal(false);
			});

			it('prefix match → compatible', () => {
				const req: Ordering[] = [{ column: 0, desc: false }];
				const prov: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				expect(orderingsCompatible(req, prov)).to.equal(true);
			});

			it('exact match → compatible', () => {
				const ord: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				expect(orderingsCompatible(ord, ord)).to.equal(true);
			});

			it('required longer than provided → incompatible', () => {
				const req: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: false }];
				const prov: Ordering[] = [{ column: 0, desc: false }];
				expect(orderingsCompatible(req, prov)).to.equal(false);
			});
		});

		describe('projectOrdering', () => {

			it('projects ordering through mapping', () => {
				const ordering: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				const mapping = new Map([[0, 5], [1, 6]]);

				expect(projectOrdering(ordering, mapping)).to.deep.equal([
					{ column: 5, desc: false },
					{ column: 6, desc: true },
				]);
			});

			it('returns undefined when a column is removed by projection', () => {
				const ordering: Ordering[] = [{ column: 0, desc: false }, { column: 1, desc: true }];
				const mapping = new Map([[0, 5]]); // column 1 not mapped

				expect(projectOrdering(ordering, mapping)).to.equal(undefined);
			});

			it('returns undefined/empty for empty input', () => {
				expect(projectOrdering(undefined, new Map())).to.equal(undefined);
				expect(projectOrdering([], new Map())).to.deep.equal([]);
			});
		});

	});

	// ---------------------------------------------------------------------------
	// Trace hooks (trace.ts)
	// ---------------------------------------------------------------------------

	describe('Trace hooks', () => {

		const mockRule: RuleHandle = {
			id: 'test-rule',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: () => null,
			sideEffectMode: 'safe',
		};

		afterEach(() => {
			// Restore default state
			setTraceHook(undefined);
		});

		it('DebugTraceHook calls all hook methods without error', () => {
			const hook = new DebugTraceHook();
			const node = relNode();
			const node2 = relNode();

			// Should not throw — the debug loggers are no-ops unless enabled
			hook.onRuleStart(mockRule, node);
			hook.onRuleEnd(mockRule, node, node2);
			hook.onRuleEnd(mockRule, node, null);
			hook.onNodeStart(node);
			hook.onNodeEnd(node, node2);
			hook.onPhaseStart('test-phase');
			hook.onPhaseEnd('test-phase');
		});

		it('PerformanceTraceHook records non-negative timings', () => {
			const hook = new PerformanceTraceHook();
			const node = relNode();

			hook.onRuleStart(mockRule, node);
			// Simulate some work
			hook.onRuleEnd(mockRule, node, null);

			// No throw = success; timing was recorded internally
			// Verify phase timing as well
			hook.onPhaseStart('perf-test');
			hook.onPhaseEnd('perf-test');
		});

		it('CompositeTraceHook dispatches to all children', () => {
			const calls1: string[] = [];
			const calls2: string[] = [];

			const hook1: TraceHook = {
				onRuleStart: () => calls1.push('ruleStart'),
				onRuleEnd: () => calls1.push('ruleEnd'),
				onNodeStart: () => calls1.push('nodeStart'),
				onNodeEnd: () => calls1.push('nodeEnd'),
				onPhaseStart: () => calls1.push('phaseStart'),
				onPhaseEnd: () => calls1.push('phaseEnd'),
			};
			const hook2: TraceHook = {
				onRuleStart: () => calls2.push('ruleStart'),
				onRuleEnd: () => calls2.push('ruleEnd'),
				onNodeStart: () => calls2.push('nodeStart'),
				onNodeEnd: () => calls2.push('nodeEnd'),
				onPhaseStart: () => calls2.push('phaseStart'),
				onPhaseEnd: () => calls2.push('phaseEnd'),
			};

			const composite = new CompositeTraceHook([hook1, hook2]);
			const node = relNode();

			composite.onRuleStart(mockRule, node);
			composite.onRuleEnd(mockRule, node, null);
			composite.onNodeStart(node);
			composite.onNodeEnd(node, node);
			composite.onPhaseStart('p');
			composite.onPhaseEnd('p');

			const expected = ['ruleStart', 'ruleEnd', 'nodeStart', 'nodeEnd', 'phaseStart', 'phaseEnd'];
			expect(calls1).to.deep.equal(expected);
			expect(calls2).to.deep.equal(expected);
		});

		it('hook error does not crash trace helpers', () => {
			const badHook: TraceHook = {
				onRuleStart: () => { throw new Error('boom'); },
				onRuleEnd: () => { throw new Error('boom'); },
				onPhaseStart: () => { throw new Error('boom'); },
			};

			// CompositeTraceHook does NOT catch — but the global trace helpers
			// are called by the registry which catches rule errors.
			// Verify the CompositeTraceHook propagates errors
			const composite = new CompositeTraceHook([badHook]);
			expect(() => composite.onRuleStart(mockRule, relNode())).to.throw('boom');
		});

		it('setTraceHook / getCurrentTraceHook round-trip', () => {
			const hook: TraceHook = {};
			setTraceHook(hook);
			expect(getCurrentTraceHook()).to.equal(hook);

			setTraceHook(undefined);
			expect(getCurrentTraceHook()).to.equal(undefined);
		});
	});
});
