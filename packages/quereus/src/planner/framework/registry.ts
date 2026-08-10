/**
 * Rule handle types and per-node visited-rule tracking for the optimizer's
 * pass framework. Rule application itself lives in `PassManager` (`pass.ts`).
 */

import type { PlanNode } from '../nodes/plan-node.js';
import type { PlanNodeType } from '../nodes/plan-node-type.js';
import type { OptContext } from './context.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

/**
 * Rule function signature for optimization transformations
 */
export type RuleFn = (node: PlanNode, context: OptContext) => PlanNode | null;

/**
 * Rule phases for categorizing optimization rules
 */
export type RulePhase = 'rewrite' | 'impl';

/**
 * Required side-effect awareness declaration for every registered rule.
 *
 * - `'safe'` — the rule never moves, duplicates, drops, or merges any
 *   subtree it does not separately verify pure. Reordering scalar properties
 *   on an existing node, replacing a logical node with a physical one whose
 *   children survive in the same positions, and annotation-only transforms
 *   all qualify. The rule does not need to consult
 *   `PlanNodeCharacteristics.hasSideEffects` because its own structural shape
 *   guarantees side-effect preservation.
 *
 * - `'aware'` — the rule DOES move, duplicate, drop, or merge subtrees, and
 *   explicitly consults `PlanNodeCharacteristics.hasSideEffects` (or
 *   `subtreeHasSideEffects`) to refuse / weaken when any participating
 *   subtree carries a write. Includes rules that *intentionally* preserve
 *   side effects through run-once memoization (e.g. mutating-subquery-cache).
 *
 * This field is intentionally not optional: every future rule author has to
 * actively pick one. `PassManager.addRuleToPass` validates the choice via
 * `validateSideEffectMode` at registration time and rejects rules that fail to
 * declare. See `docs/optimizer.md` § Audit discipline.
 */
export type SideEffectMode = 'safe' | 'aware';

/**
 * Handle for registered optimization rules
 */
export interface RuleHandle {
	/** Unique identifier for this rule */
	id: string;
	/** Node type this rule applies to */
	nodeType: PlanNodeType;
	/** Phase classification */
	phase: RulePhase;
	/** Rule implementation function */
	fn: RuleFn;
	/**
	 * Side-effect awareness declaration — see {@link SideEffectMode}. Required:
	 * registration fails when omitted, so every rule author has to make an
	 * active choice rather than silently dropping a write.
	 */
	sideEffectMode: SideEffectMode;
}

/**
 * Check if a rule has already been applied to a node.
 *
 * Records only *transforming* applications (loop prevention), inherited across
 * a transform's re-mint by `PassManager.inheritVisitedRules`. A rule that
 * *declines* is tracked separately and ephemerally inside
 * `PassManager.applyPassRules` (per node id, not inherited) — see that method.
 */
export function hasRuleBeenApplied(nodeId: string, ruleId: string, context: OptContext): boolean {
	const nodeVisited = context.visitedRules.get(nodeId);
	return nodeVisited?.has(ruleId) ?? false;
}

/**
 * Mark a rule as applied to a node
 */
export function markRuleApplied(nodeId: string, ruleId: string, context: OptContext): void {
	if (!context.visitedRules.has(nodeId)) {
		context.visitedRules.set(nodeId, new Set());
	}
	context.visitedRules.get(nodeId)!.add(ruleId);
}

/**
 * Reject any rule registration that fails to declare `sideEffectMode`. The
 * field is typed as required, but plenty of call sites build rule handles
 * dynamically (object spreads, generated registries) where TypeScript can't
 * see through — this runtime check is the load-bearing audit gate. Exported
 * so the PassManager can apply the same validation when rules are pushed
 * directly into a pass's `rules` array.
 */
export function validateSideEffectMode(handle: RuleHandle): void {
	const mode = (handle as { sideEffectMode?: unknown }).sideEffectMode;
	if (mode !== 'safe' && mode !== 'aware') {
		quereusError(
			`Optimization rule '${handle.id}' is missing or has invalid sideEffectMode (got ${JSON.stringify(mode)}); ` +
			`every rule must declare 'safe' or 'aware'. See docs/optimizer.md § Audit discipline.`,
			StatusCode.INTERNAL,
		);
	}
}
