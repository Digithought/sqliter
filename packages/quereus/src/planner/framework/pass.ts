/**
 * Optimization pass framework for multi-pass query optimization
 *
 * This framework enables rules to run in separate tree traversals,
 * allowing for proper sequencing of transformations that require
 * different traversal orders or multiple passes over the tree.
 */

import type { PlanNode } from '../nodes/plan-node.js';
import type { OptContext } from './context.js';
import type { RuleHandle } from './registry.js';
import { hasRuleBeenApplied, markRuleApplied, validateSideEffectMode } from './registry.js';
import { createLogger } from '../../common/logger.js';
import { performConstantFolding } from '../analysis/const-pass.js';
import { createRuntimeExpressionEvaluator, createRuntimeRelationalEvaluator } from '../analysis/const-evaluator.js';
import { MaterializationAdvisory } from '../cache/materialization-advisory.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

const log = createLogger('optimizer:framework:pass');

/**
 * Traversal order for optimization passes
 */
export enum TraversalOrder {
	/** Process children before parents */
	BottomUp = 'bottom-up',
	/** Process parents before children */
	TopDown = 'top-down',
}

/**
 * Definition of an optimization pass
 */
export interface OptimizationPass {
	/** Unique identifier for this pass */
	id: string;

	/** Human-readable name for logging */
	name: string;

	/** Description of what this pass does */
	description: string;

	/** Traversal order for this pass */
	traversalOrder: TraversalOrder;

	/** Rules that belong to this pass (will be populated by registration) */
	rules: RuleHandle[];

	/** Optional custom execution logic (default uses standard rule application) */
	execute?: (plan: PlanNode, context: OptContext) => PlanNode;

	/** Whether this pass is enabled (default: true) */
	enabled?: boolean;

	/** Order in which passes execute (lower numbers first) */
	order: number;
}

/**
 * Standard optimization passes
 */
export enum PassId {
	/** Pre-optimization constant folding */
	ConstantFolding = 'constant-folding',

	/** Structural transformations (pushdown, pullup, boundary sliding) */
	Structural = 'structural',

	/** Physical operator selection and implementation */
	Physical = 'physical',

	/** Post-optimization cleanup and caching */
	PostOptimization = 'post-opt',

	/** Cache materialization advisory — one whole-tree pass */
	Materialization = 'materialization',

	/** Re-derive plan estimates that a later-than-Physical pass invalidated */
	FinalEstimates = 'final-estimates',

	/** Final validation */
	Validation = 'validation',
}

/**
 * Create a standard optimization pass
 */
export function createPass(
	id: string,
	name: string,
	description: string,
	order: number,
	traversalOrder: TraversalOrder = TraversalOrder.BottomUp
): OptimizationPass {
	return {
		id,
		name,
		description,
		traversalOrder,
		rules: [],
		enabled: true,
		order
	};
}

/**
 * Create constant folding pass with custom execution
 */
function createConstantFoldingPass(): OptimizationPass {
	return {
		id: PassId.ConstantFolding,
		name: 'Constant Folding',
		description: 'Pre-evaluate constant expressions and fold them into the plan',
		traversalOrder: TraversalOrder.BottomUp,
		rules: [],
		enabled: true,
		order: 0,
		execute: (plan: PlanNode, context: OptContext) => {
			// Custom execution for constant folding
			const scalarEvaluator = createRuntimeExpressionEvaluator(context.db);
			const relationalEvaluator = createRuntimeRelationalEvaluator(context.db);
			const result = performConstantFolding(plan, scalarEvaluator, relationalEvaluator);
			log('Constant folding completed');
			return result;
		}
	};
}

/**
 * Create the materialization-advisory pass with custom execution.
 *
 * Runs the cache materialization advisory exactly ONCE over the whole plan.
 * `analyzeAndTransform` builds a single reference graph (parent counts are then
 * global — strictly more correct than the previous per-anchor-subtree-local
 * counts, which under-counted sharing that spanned two anchors) and walks every
 * descendant via `getChildren()`, wrapping each recommended relational node with
 * a `CacheNode`. This replaces the previous 12 per-anchor-type `RuleHandle`
 * registrations, each of which rebuilt a reference graph over its own subtree
 * (O(anchors) graph builds per optimize, now 1).
 *
 * Placement (order 35) is between PostOptimization (30) and Validation (40) so
 * the advisory runs AFTER the CacheNodes injected by `cte-optimization` are
 * already in place — it skips `nodeType === Cache`, so running last avoids
 * double-wrapping.
 *
 * Side-effect soundness (a custom `execute` bypasses `sideEffectMode`
 * validation, so the reasoning lives here rather than in a RuleHandle field):
 * the advisory does not explicitly consult `hasSideEffects` — soundness for
 * impure subtrees rests on CacheNode itself being a run-once fence
 * (materialize-on-first-read, replay thereafter), so a side-effect-bearing
 * subtree that the advisory would otherwise wrap runs exactly once instead of
 * per-reference. That is a count-change but order-preserving rewrite — and
 * matches the run-once contract the scalar / IN / EXISTS emitters apply
 * directly when their inner is impure (see `docs/runtime.md`).
 */
function createMaterializationPass(): OptimizationPass {
	return {
		id: PassId.Materialization,
		name: 'Materialization Advisory',
		description: 'Inject caching where reference analysis shows materialization pays off',
		traversalOrder: TraversalOrder.BottomUp,
		rules: [],
		enabled: true,
		order: 35,
		execute: (plan: PlanNode, context: OptContext) => {
			const advisory = new MaterializationAdvisory(context.tuning);
			return advisory.analyzeAndTransform(plan);
		},
	};
}

/**
 * Standard pass definitions
 */
export const STANDARD_PASSES: OptimizationPass[] = [
	createConstantFoldingPass(),

	createPass(
		PassId.Structural,
		'Structural Transformations',
		'Restructure the plan tree for optimal execution boundaries',
		10,
		TraversalOrder.TopDown
	),

	createPass(
		PassId.Physical,
		'Physical Selection',
		'Convert logical operators to physical implementations',
		20,
		TraversalOrder.BottomUp
	),

	createPass(
		PassId.PostOptimization,
		'Post-Optimization',
		'Final cleanup, materialization decisions, and caching',
		30,
		TraversalOrder.BottomUp
	),

	createMaterializationPass(),

	// Last plan-mutating pass. A node estimate is derived by a rule that holds an
	// OptContext (node accessors carry none), so any later pass that re-mints the
	// node it was stamped on drops the estimate with nothing behind it to restore
	// the number — `FilterNode.withChildren` dropping a stamped `selectivity`
	// because Materialization rewrote something inside the predicate is the case
	// that motivated this pass. Rules registered here re-derive such an estimate
	// against the FINAL node, so an estimate's survival no longer depends on which
	// pass happens to touch its node last. Nothing may be registered after this
	// pass except read-only checks; `test/optimizer/rule-manifest.spec.ts` asserts
	// that statically.
	createPass(
		PassId.FinalEstimates,
		'Final Estimates',
		'Re-derive plan estimates invalidated by a later pass rewriting inside a node',
		37,
		TraversalOrder.BottomUp
	),

	createPass(
		PassId.Validation,
		'Validation',
		'Validate the correctness of the optimized plan',
		40,
		TraversalOrder.BottomUp
	),
];

/**
 * Compute the maximum depth (number of edges from root to any leaf) of a plan.
 * Iterative so we cannot stack-overflow on the very inputs we are trying to plan.
 */
function planInputDepth(plan: PlanNode): number {
	let maxDepth = 0;
	const stack: Array<{ node: PlanNode; depth: number }> = [{ node: plan, depth: 0 }];
	while (stack.length > 0) {
		const top = stack.pop()!;
		if (top.depth > maxDepth) maxDepth = top.depth;
		const children = top.node.getChildren();
		for (const child of children) {
			stack.push({ node: child, depth: top.depth + 1 });
		}
	}
	return maxDepth;
}

/**
 * Per-pass scratch state. Carried alongside OptContext so the rule-firing
 * counter and effective depth budget are reset between passes.
 */
interface PassState {
	depthBudget: number;
	rulesFired: number;
	readonly maxRulesFired: number;
}

/**
 * Worklist frame for the iterative pass traversals. A 'visit' frame schedules
 * a node for first-time processing; a 'finalize' frame splices completed child
 * results back into its parent and (for bottom-up) applies rules afterward.
 *
 * `origNodeId` is the ORIGINAL pre-rule node id — the optimizedNodes cache is
 * keyed on it so cache hits short-circuit before any rule application.
 */
interface VisitFrame {
	kind: 'visit';
	node: PlanNode;
	depth: number;
}
interface FinalizeFrame {
	kind: 'finalize';
	origNodeId: string;
	currentNode: PlanNode;
	originalChildren: readonly PlanNode[];
	depth: number;
}
type Frame = VisitFrame | FinalizeFrame;

/**
 * Pass manager for coordinating multi-pass optimization
 */
export class PassManager {
	private passes: Map<string, OptimizationPass> = new Map();
	private sortedPasses: OptimizationPass[] = [];

	constructor(passes: readonly OptimizationPass[] = STANDARD_PASSES) {
		// Register standard (or provided) passes
		for (const pass of passes) {
			this.registerPass(pass);
		}
	}

	/**
	 * Register an optimization pass
	 *
	 * NOTE: `pass.rules` is taken as-is; only `addRuleToPass` runs
	 * `validateSideEffectMode` (see docs/invariants.md § OPT-001). Every pass ships with
	 * `rules: []`, so nothing bypasses the gate today. If a pass ever arrives pre-populated,
	 * validate each rule here.
	 */
	registerPass(pass: OptimizationPass): void {
		if (this.passes.has(pass.id)) {
			log('Warning: Overwriting existing pass %s', pass.id);
		}

		this.passes.set(pass.id, pass);
		this.updateSortedPasses();

		log('Registered pass %s (order: %d, traversal: %s)',
			pass.id, pass.order, pass.traversalOrder);
	}

	/**
	 * Get a pass by ID
	 */
	getPass(id: string): OptimizationPass | undefined {
		return this.passes.get(id);
	}

	/**
	 * Add a rule to a specific pass
	 */
	addRuleToPass(passId: string, rule: RuleHandle): void {
		validateSideEffectMode(rule);

		const pass = this.passes.get(passId);
		if (!pass) {
			throw new Error(`Unknown pass: ${passId}`);
		}

		// Avoid duplicate registrations by rule ID within a pass
		if (pass.rules.some(r => r.id === rule.id)) {
			log('Skipping duplicate rule %s for pass %s', rule.id, passId);
			return;
		}

		pass.rules.push(rule);
		log('Added rule %s to pass %s', rule.id, passId);
	}

	/**
	 * Get all passes in execution order
	 */
	getPasses(): readonly OptimizationPass[] {
		return this.sortedPasses;
	}

	/**
	 * Update sorted pass list after changes
	 */
	private updateSortedPasses(): void {
		this.sortedPasses = Array.from(this.passes.values())
			.filter(pass => pass.enabled !== false)
			.sort((a, b) => a.order - b.order);
	}

	/**
	 * Execute all passes on a plan
	 */
	execute(plan: PlanNode, context: OptContext): PlanNode {
		return this.executeUpTo(plan, context);
	}

	/**
	 * Execute passes up to and including the specified pass id
	 */
	executeUpTo(plan: PlanNode, context: OptContext, upToPassId?: string): PlanNode {
		let currentPlan = plan;
		for (const pass of this.sortedPasses) {
			log('Starting pass: %s', pass.name);
			// Cache is scoped to a single traversal/pass; do not reuse across passes.
			context.optimizedNodes.clear();

			if (pass.execute) {
				// Custom execution logic
				currentPlan = pass.execute(currentPlan, context);
			} else {
				// Standard rule-based execution
				currentPlan = this.executeStandardPass(currentPlan, context, pass);
			}

			log('Completed pass: %s', pass.name);
			if (upToPassId && pass.id === upToPassId) break;
		}
		return currentPlan;
	}

	/**
	 * Execute a standard rule-based pass
	 */
	private executeStandardPass(
		plan: PlanNode,
		context: OptContext,
		pass: OptimizationPass
	): PlanNode {
		// Depth budget scales with the input plan so wide ANDs / deep CASEs
		// don't trip on a shape-only descent. The floor keeps shallow inputs
		// at the historical default.
		const inputDepth = planInputDepth(plan);
		const depthBudget = Math.max(
			context.tuning.maxOptimizationDepth,
			inputDepth + context.tuning.optimizationDepthHeadroom
		);
		const state: PassState = {
			depthBudget,
			rulesFired: 0,
			maxRulesFired: context.tuning.maxRulesFired,
		};

		if (pass.traversalOrder === TraversalOrder.TopDown) {
			return this.traverseTopDown(plan, context, pass, state);
		} else {
			return this.traverseBottomUp(plan, context, pass, state);
		}
	}

	private assertOptimizationDepth(state: PassState, depth: number): void {
		if (depth >= state.depthBudget) {
			quereusError(`Maximum optimization depth exceeded: ${depth} (budget ${state.depthBudget})`, StatusCode.ERROR);
		}
	}

	/**
	 * Finalize a parent frame: collect post-traversal child results, rewire if any
	 * child reference changed, memoize against the original node id, and push the
	 * finalized node back onto the result stack.
	 *
	 * Children were pushed in reverse on the work stack, so their finalized results
	 * land on `resultStack` in original left-to-right order — a tail slice of length
	 * `frame.originalChildren.length` is the correctly-ordered child array.
	 */
	private finalizeNode(
		frame: FinalizeFrame,
		resultStack: PlanNode[],
		context: OptContext,
		applyRulesAfter: { context: OptContext; pass: OptimizationPass; state: PassState } | null,
	): PlanNode {
		const n = frame.originalChildren.length;
		const newChildren = resultStack.splice(resultStack.length - n, n);

		let node = frame.currentNode;
		let childrenChanged = false;
		for (let i = 0; i < n; i++) {
			if (newChildren[i] !== frame.originalChildren[i]) {
				childrenChanged = true;
				break;
			}
		}
		if (childrenChanged) {
			node = node.withChildren(newChildren);
		}

		const finalized = applyRulesAfter
			? this.applyPassRules(node, applyRulesAfter.context, applyRulesAfter.pass, applyRulesAfter.state)
			: node;

		context.optimizedNodes.set(frame.origNodeId, finalized);
		return finalized;
	}

	/**
	 * Top-down traversal with rule application (iterative worklist).
	 *
	 * Rules fire on a node BEFORE descending; the post-rule node's children are
	 * what gets walked.
	 */
	private traverseTopDown(
		plan: PlanNode,
		context: OptContext,
		pass: OptimizationPass,
		state: PassState,
	): PlanNode {
		const workStack: Frame[] = [{ kind: 'visit', node: plan, depth: 0 }];
		const resultStack: PlanNode[] = [];

		while (workStack.length > 0) {
			const frame = workStack.pop()!;

			if (frame.kind === 'visit') {
				const cached = context.optimizedNodes.get(frame.node.id);
				if (cached) {
					resultStack.push(cached);
					continue;
				}

				this.assertOptimizationDepth(state, frame.depth);

				// Top-down: rules fire BEFORE descending.
				const postRule = this.applyPassRules(frame.node, context, pass, state);
				const children = postRule.getChildren();

				if (children.length === 0) {
					context.optimizedNodes.set(frame.node.id, postRule);
					resultStack.push(postRule);
					continue;
				}

				workStack.push({
					kind: 'finalize',
					origNodeId: frame.node.id,
					currentNode: postRule,
					originalChildren: children,
					depth: frame.depth,
				});

				for (let i = children.length - 1; i >= 0; i--) {
					workStack.push({ kind: 'visit', node: children[i], depth: frame.depth + 1 });
				}
			} else {
				// Top-down: rules already fired on entry — finalize without re-applying.
				const finalized = this.finalizeNode(frame, resultStack, context, null);
				resultStack.push(finalized);
			}
		}

		return resultStack[0];
	}

	/**
	 * Bottom-up traversal with rule application (iterative worklist).
	 *
	 * Children are processed first; rules fire on a node AFTER its rewritten
	 * children are spliced back in.
	 */
	private traverseBottomUp(
		plan: PlanNode,
		context: OptContext,
		pass: OptimizationPass,
		state: PassState,
	): PlanNode {
		const workStack: Frame[] = [{ kind: 'visit', node: plan, depth: 0 }];
		const resultStack: PlanNode[] = [];

		while (workStack.length > 0) {
			const frame = workStack.pop()!;

			if (frame.kind === 'visit') {
				const cached = context.optimizedNodes.get(frame.node.id);
				if (cached) {
					resultStack.push(cached);
					continue;
				}

				this.assertOptimizationDepth(state, frame.depth);

				const children = frame.node.getChildren();

				if (children.length === 0) {
					const result = this.applyPassRules(frame.node, context, pass, state);
					context.optimizedNodes.set(frame.node.id, result);
					resultStack.push(result);
					continue;
				}

				workStack.push({
					kind: 'finalize',
					origNodeId: frame.node.id,
					currentNode: frame.node,
					originalChildren: children,
					depth: frame.depth,
				});

				for (let i = children.length - 1; i >= 0; i--) {
					workStack.push({ kind: 'visit', node: children[i], depth: frame.depth + 1 });
				}
			} else {
				// Bottom-up: rules fire AFTER children are finalized.
				const finalized = this.finalizeNode(frame, resultStack, context, { context, pass, state });
				resultStack.push(finalized);
			}
		}

		return resultStack[0];
	}

	/**
	 * Apply all rules in a pass to a node
	 */
	private applyPassRules(
		node: PlanNode,
		context: OptContext,
		pass: OptimizationPass,
		state: PassState
	): PlanNode {
		let currentNode = node;
		let changed = true;

		// Rules that declined (returned null / the same node) on the *current*
		// node id. A declining rule is deterministic in its input node, so once it
		// declines on a given node it will decline again on the same node — no
		// point re-offering it every `while` fixpoint iteration. This set is
		// ephemeral (not stored on the context) and, crucially, is reset whenever
		// a transform mints a NEW node: the plan piece changed, so every decliner
		// gets a fresh shot on the new node (a rule that declined on the old shape
		// may well apply to the new one). Applied rules are handled separately by
		// `hasRuleBeenApplied` (they are inherited across the re-mint for loop
		// prevention); declines are not inherited, so no plan output changes vs.
		// re-scanning every iteration — only redundant same-node re-runs are cut.
		let declinedOnCurrent = new Set<string>();

		while (changed) {
			changed = false;

			for (const rule of pass.rules) {
				if (rule.nodeType !== currentNode.nodeType) continue;
				if (context.tuning.disabledRules?.has(rule.id)) continue;
				if (hasRuleBeenApplied(currentNode.id, rule.id, context)) continue;
				if (declinedOnCurrent.has(rule.id)) continue;

				const result = rule.fn(currentNode, context);
				if (result && result !== currentNode) {
					// NOTE: a rule is not re-offered its own output. marking the old node id
					// applied and then inheriting that applied-rule set onto the new node id
					// means `hasRuleBeenApplied` short-circuits `rule.id` on `result` too, so
					// the fixpoint loop above never re-invokes this rule on the node it just
					// produced. A rule that needs a fixpoint over its own rewrites (e.g. merging
					// an arbitrarily deep stack of nested nodes) must loop internally rather than
					// rely on the engine to re-offer it — see rule-filter-merge for the pattern.
					markRuleApplied(currentNode.id, rule.id, context);
					this.inheritVisitedRules(currentNode.id, result.id, context);
					state.rulesFired++;
					if (state.rulesFired > state.maxRulesFired) {
						quereusError(
							`Optimization pass ${pass.id} exceeded maxRulesFired (${state.maxRulesFired}); likely a non-converging rule`,
							StatusCode.ERROR
						);
					}
					log('Rule %s transformed node in pass %s', rule.id, pass.id);
					currentNode = result;
					// New node id — the plan piece changed, so re-offer every decliner.
					declinedOnCurrent = new Set();
					changed = true;
				} else {
					// Declined on this exact node id; suppress re-offering it until
					// the node changes (a transform resets the set above).
					// NOTE: this assumes a decline is a pure function of the node — a
					// rule that declines but mutates shared `context` state expecting
					// to re-apply on the *same unchanged* node next iteration would no
					// longer get that second look. No such rule exists today; if one
					// is added, exclude it here or key the skip on a context epoch.
					declinedOnCurrent.add(rule.id);
				}
			}
		}

		return currentNode;
	}

	private inheritVisitedRules(fromNodeId: string, toNodeId: string, context: OptContext): void {
		const from = context.visitedRules.get(fromNodeId);
		if (!from || from.size === 0) return;

		const existing = context.visitedRules.get(toNodeId);
		if (!existing) {
			context.visitedRules.set(toNodeId, new Set(from));
			return;
		}

		for (const id of from) {
			existing.add(id);
		}
	}
}
