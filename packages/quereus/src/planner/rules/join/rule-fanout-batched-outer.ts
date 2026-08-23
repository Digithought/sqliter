/**
 * Rule: Fan-out Batched Outer
 *
 * Flips an already-formed `FanOutLookupJoinNode` from the default `serial` outer
 * mode to `batched` (cross-row pipelined) when the cost model says overlapping
 * lookups *across* outer rows pays off. This is the recognition rule that
 * *chooses* the batched runtime (`runFanOutLookupJoinBatched`); the runtime
 * itself landed in `parallel-fanout-lookup-join-batched-outer`.
 *
 * **Why a post-pass, not a formation-time decision.** `rule-fanout-lookup-join`
 * forms the node in `PassId.Structural`; this rule runs in `PassId.Post-
 * Optimization` (in the `eager-prefetch-probe` / `async-gather`
 * neighborhood) after physical-pass selection has finalized leaf
 * `expectedLatencyMs` / `estimatedRows` / `concurrencySafe`. Matching the
 * already-built `FanOutLookupJoinNode` keeps the batched decision a single,
 * isolated rewrite rather than another recognition path.
 *
 * **When batched wins.** Batched mode helps when there are *many outer rows but
 * few branches per row* — the per-row branch count under-saturates the global
 * in-flight budget, so admitting more outer rows ahead of the emit frontier is
 * the only way to fill it. All of the following must hold:
 *
 *   - **Budget under-saturated per row:** `branchCount < outerBatchConcurrency`.
 *     When a single row's branches already meet/exceed the global budget,
 *     cross-row admission buys nothing (the budget is full from one row).
 *   - **High-latency branches:** the slowest branch's `expectedLatencyMs` clears
 *     `tuning.parallel.batchedOuterThresholdMs`. This is 0 on every memory-vtab
 *     leaf, so the rule is **inert by design on local-only plans** — the golden
 *     sweep is unaffected, same discipline as `gatherThresholdMs` /
 *     `prefetchProbeThresholdMs`.
 *   - **Large outer cardinality:** `outer.estimatedRows >= batchedOuterMinRows`,
 *     so cross-row overlap dominates the reorder-buffer + per-row-fork overhead.
 *     An unknown estimate fails the gate (never flip on a missing statistic).
 *
 * **Cross branches are out of scope.** A cross (1:n) branch's batched outer
 * mode is owned by `parallel-fanout-lookup-join-cross-mode`; this rule only
 * flips clusters whose branches are all `atMostOne-*`. A node carrying any
 * `cross` or `cross-left` branch is left serial (both are 1:n cross factors).
 *
 * **Outer-source isolation (load-bearing correctness).** The batched driver
 * pumps the outer source *concurrently* with in-flight per-row branch forks —
 * unlike serial mode, which fully resolves one outer row before pulling the
 * next. The scheduler runs every instruction against one shared
 * `RuntimeContext`, so a raw outer sub-plan that mutates `rctx.context` during
 * the pump (installing a row slot, etc.) would (a) risk a torn read for any
 * branch reading that entry and (b) throw a strict-fork violation when the
 * fan-out is nested under another fork (so `rctx.context` is strict-wrapped) and
 * the live row forks hold the bump counter. To neutralize both, this rule wraps
 * the outer in an `EagerPrefetchNode` when it flips to batched: the prefetch
 * pump runs the outer sub-plan against its *own* forked context (mutations land
 * on the fork, never on the shared `rctx.context` the row forks bump), and the
 * batched pump merely drains the prefetch buffer — a pure buffer read that never
 * touches `rctx.context`. So **batched implies prefetch** (the reverse does not
 * hold; `eager-prefetch-probe` uses the node independently). The prefetch buffer
 * also feeds the read-ahead window the batched driver consumes across rows, so
 * the two compose rather than duplicate work. The branch correlations are
 * already safe by construction: `rule-fanout-lookup-join` only clusters branches
 * (spine + correlated scalar-aggregate subqueries) that reference the *outer
 * row's* attributes, which the batched driver isolates per row in its own boxed
 * slot.
 *
 * **Outer concurrency gate.** Because the prefetch pump iterates the outer
 * concurrently with branch lookups, the outer must advertise
 * `physical.concurrencySafe === true` (mirroring `eager-prefetch-probe` /
 * `async-gather`). Serial mode never overlapped these, so this gate is
 * batched-specific.
 *
 * **Idempotence.** After the rewrite `outerMode === 'batched'`, so a second
 * firing returns null immediately.
 *
 * **Two callers, one flip.** The gates, the prefetch wrap and the node rebuild
 * live in {@link toBatchedOuter}; this rule is a thin wrapper over it, and
 * `rule-join-physical-selection` calls it directly to turn an index-nested-loop
 * candidate into a priced one-branch batched fan-out. One owner means the two
 * callers cannot drift, and — because a one-branch fan-out left in serial mode
 * is strictly worse than the join it replaces (per-row forking, no overlap) —
 * the selection rule never enters a serial fan-out into its comparison: if
 * this function declines, there is no batched candidate at all.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext } from '../../framework/context.js';
import type { OptimizerTuning } from '../../optimizer-tuning.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FanOutLookupJoinNode, isCrossBranchMode } from '../../nodes/fanout-lookup-join-node.js';
import { EagerPrefetchNode } from '../../nodes/eager-prefetch-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:fanout-batched-outer');

/**
 * Best-available row estimate for the fan-out's outer. Single-source relays now
 * carry the leaf's `physical.estimatedRows` upward (`physicalSourceRows`), but not
 * every wrapper does — a CTE reference or a set operation in between stamps
 * nothing — so a value can be present on the leaf's `physical` yet undefined above
 * it. Read the node's own estimate first, then descend single-relation
 * pass-throughs (alias/filter/sort/…) to recover the leaf's estimate. A
 * multi-relation node (a join outer in a subquery cluster) returns `undefined`,
 * which the caller treats as failing the cardinality gate.
 */
function outerRowEstimate(node: RelationalPlanNode): number | undefined {
	const direct = node.physical?.estimatedRows ?? node.estimatedRows;
	if (direct !== undefined) return direct;
	const relations = node.getRelations();
	if (relations.length === 1) return outerRowEstimate(relations[0]);
	return undefined;
}

/**
 * The serial→batched flip: every gate, the `EagerPrefetchNode` wrap and the
 * node rebuild, in one function so no caller can obtain batched mode without
 * the wrap (the wrap is load-bearing correctness — see the module comment's
 * *Outer-source isolation*). Returns null when any gate declines, including on
 * a node that is already batched (idempotence — `ruleFanOutBatchedOuter` later
 * re-visits nodes `rule-join-physical-selection` already flipped).
 */
export function toBatchedOuter(
	node: FanOutLookupJoinNode,
	tuning: OptimizerTuning['parallel'],
): FanOutLookupJoinNode | null {
	if (node.outerMode === 'batched') return null; // idempotence

	const branchCount = node.branches.length;

	// Cross-branch batched outer is owned by the cross-mode ticket; only flip
	// clusters whose branches are all at-most-one. `cross-left` is a 1:n cross
	// factor too, so it is excluded on the same grounds as `cross`.
	if (node.branches.some(b => isCrossBranchMode(b.mode))) return null;

	// Budget under-saturation: batched only helps when one row's branches leave
	// global-budget headroom for *more* outer rows to fill.
	if (branchCount >= tuning.outerBatchConcurrency) return null;

	// Latency gate: the slowest branch must clear the threshold. Inert on
	// memory-vtab plans (expectedLatencyMs = 0 throughout).
	let maxLatency = 0;
	for (const b of node.branches) {
		const l = b.child.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	if (maxLatency < tuning.batchedOuterThresholdMs) return null;

	// Cardinality gate: enough outer rows for cross-row overlap to amortize the
	// reorder-buffer / per-row-fork overhead. Unknown estimate fails the gate.
	const outerRows = outerRowEstimate(node.outer);
	if (outerRows === undefined || outerRows < tuning.batchedOuterMinRows) return null;

	// Concurrency gate: the prefetch pump iterates the outer concurrently with
	// branch lookups, so the outer must be proven concurrency-safe.
	if (node.outer.physical.concurrencySafe !== true) return null;

	// Side-effect gate: batched outer pump runs the outer concurrently with
	// in-flight per-row branch forks — interleaves outer-side writes. Pairs
	// with the module-level `physical.concurrencySafe` gate above.
	if (!PlanNodeCharacteristics.isConcurrencySafe(node.outer)) return null;
	for (const b of node.branches) {
		if (!PlanNodeCharacteristics.isConcurrencySafe(b.child)) return null;
	}

	// Wrap the outer in EagerPrefetch (isolation + read-ahead feed) unless it is
	// already prefetched. Sized to `maxOuterReadAhead` — the outer-read-ahead
	// bound this node's batched driver works against.
	const outer = node.outer.nodeType === PlanNodeType.EagerPrefetch
		? node.outer
		: new EagerPrefetchNode(node.scope, node.outer, tuning.maxOuterReadAhead);

	log(
		'Flipping FanOutLookupJoin %s to batched outer mode (branches=%d, maxLatency=%d ms, outerRows=%s, globalCap=%d)',
		node.id, branchCount, maxLatency, String(outerRows), tuning.outerBatchConcurrency,
	);

	return new FanOutLookupJoinNode(
		node.scope,
		outer,
		node.branches,
		node.concurrencyCap,
		node.preserveAttributeIds,
		'batched',
	);
}

export function ruleFanOutBatchedOuter(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof FanOutLookupJoinNode)) return null;
	return toBatchedOuter(node, context.tuning.parallel);
}
