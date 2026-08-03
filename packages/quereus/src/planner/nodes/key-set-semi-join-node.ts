import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type BinaryRelationalNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { hashJoinCost } from '../cost/index.js';
import { estimateJoinRows } from './join-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { SeqScanNode, IndexScanNode } from './table-access-nodes.js';
import type { AccessPath } from '../../vtab/index-descriptor.js';

/**
 * Admissible target leaves: a plain sequential scan, or an ordering-only index
 * walk (`plan=0`, no constraints) — which reads every row exactly like a full
 * scan and differs only in emission order. Whether that emission order is
 * something an ancestor may depend on is settled by
 * {@link seekPreservesTargetOrder}, not by the leaf shape (see
 * `rule-key-set-seek`'s gates). Memory-vtab tables always advertise a
 * primary-key ordering, so their bare scans are ordering-only IndexScans —
 * admitting only SeqScan would make this node unreachable there.
 */
export type KeySetTargetNode = SeqScanNode | IndexScanNode;

/**
 * Engine ceiling on the number of seek keys a runtime-materialized key set may
 * deliver to a module as a multi-seek. Matches the store module's own
 * `MAX_MULTI_SEEK_KEYS`; above this the runtime always falls back to scanning
 * the target, which the module was promised (`RuntimeSetSpec.maxCount`).
 */
export const RUNTIME_SET_MAX_KEYS = 1000;

/**
 * True when the multi-seek this pushdown describes emits in exactly the target
 * leaf's own walk order, so the node may claim the leaf's `ordering` /
 * `monotonicOn` regardless of which branch the runtime picks.
 *
 * The equivalence: the scan branch leaves the leaf's `FilterInfo` untouched, so
 * rows arrive in the walk index's key order; the seek branch replaces it with a
 * `plan=5` multi-seek whose engine-wide contract is that rows come back in the
 * *scanned structure's own key order*, never seek-argument order (pinned by
 * `test/vtab/multiseek-key-order.spec.ts`, honoured by both backends). When the
 * seek index IS the walk index, the seek branch therefore emits a subsequence
 * of the scan branch's stream — and a subsequence of an ordered stream is still
 * ordered (a subsequence of a monotonic stream is still monotonic, strictness
 * included: dropping rows cannot create a tie). So under that condition both
 * branches satisfy the leaf's advertised order and the node may claim it.
 *
 * Restricted to a single-column index: for a composite index the seek would be
 * a leading-column *prefix* window, and "structure key order within a prefix
 * window" is not pinned by any current test. It costs nothing today — the
 * memory module declines a runtime-set `IN` on the leading column of a
 * composite key, and the literal form plans as a scan + Filter, so the
 * composite case is unreachable through either path. Relax the clause when a
 * module actually claims a leading-column multi-seek on a composite index, and
 * pin the prefix-window order first.
 */
export function seekPreservesTargetOrder(
	target: KeySetTargetNode,
	pushdown: KeySetPushdown,
): boolean {
	// A SeqScan advertises no ordering at all — nothing to preserve, nothing to prove.
	if (!(target instanceof IndexScanNode)) return false;
	const walk = target.filterInfo.accessPath;
	if (walk?.kind !== 'index' || walk.plan !== 'scan') return false;
	// The load-bearing clause: the seek index is the walk index.
	if (walk.index.name !== pushdown.accessPath.index.name) return false;
	const keyColumns = pushdown.accessPath.index.keyColumns;
	if (keyColumns.length !== 1) return false;
	// The advertised order must actually describe the index's key order — this
	// rejects a leaf whose `providesOrdering` says something else (including a
	// reverse walk, whose advertised direction flips against the key column's).
	const ordering = target.providesOrdering;
	if (!ordering || ordering.length !== 1) return false;
	return ordering[0].column === keyColumns[0].columnIndex
		&& ordering[0].desc === (keyColumns[0].desc === true);
}

/** How the target's access path is rewritten when the runtime decides to seek. */
export interface KeySetPushdown {
	/** Index name as it must appear in idxStr (the module's own spelling). */
	readonly indexName: string;
	/** Structured identity of that index — always `{ kind: 'index', plan: 'multiSeek' }`. */
	readonly accessPath: Extract<AccessPath, { kind: 'index' }>;
	/** Table column index the seek is on (the index's leading key column). */
	readonly seekColumnIndex: number;
	/** true ⇒ the index's leading key column is DESC, so keys sort descending. */
	readonly seekDescending: boolean;
	/** Engine ceiling the module accepted. Above this the runtime scans instead. */
	readonly maxKeys: number;
	/** Seek iff the materialized distinct key count is ≤ this (module-cost break-even). */
	readonly breakEvenKeys: number;
}

/**
 * Physical semi join that materializes the key-source side into a set once, then
 * streams the target and probes each row against the set — exactly what the hash
 * semi join arm it replaces does — and additionally, when the materialized distinct
 * key count is small enough (≤ min(maxKeys, breakEvenKeys)), rewrites the target
 * leaf's `FilterInfo` at runtime into an ordinary single-column `plan=5`
 * multi-seek so the storage backend reads only the matching rows.
 *
 * The probe never goes away: pushdown only changes how many rows the target
 * emits. An over-fetching seek is trimmed by the probe; a skipped pushdown
 * degrades to that unconditional probe over the untouched walk. The plan-time
 * gates in `rule-key-set-seek` exist to make an under-fetch (rows the seek fails
 * to return, which the probe cannot resurrect) impossible.
 */
export class KeySetSemiJoinNode extends PlanNode implements BinaryRelationalNode {
	override readonly nodeType = PlanNodeType.KeySetSemiJoin;

	constructor(
		scope: Scope,
		/** The access leaf whose FilterInfo gets rewritten at runtime, verbatim. */
		public readonly target: KeySetTargetNode,
		/** Drained once into the key set. Uncorrelated + deterministic by rule gate. */
		public readonly keySource: RelationalPlanNode,
		/** Join key attribute on the target side. */
		public readonly targetAttrId: number,
		/** Join key attribute on the keySource side. */
		public readonly keyAttrId: number,
		public readonly pushdown: KeySetPushdown,
	) {
		// SeqScanNode only declares `estimatedRows` through RelationalPlanNode.
		const targetRows = (target as RelationalPlanNode).estimatedRows ?? 100;
		const keyRows = keySource.estimatedRows ?? 100;
		// Same self-cost the BloomJoinNode this replaces charged (build the key
		// set, probe every target row). The saving is in the *target's* row
		// count, which is not modelled at plan time — the seek-vs-scan decision
		// is deferred to runtime by design; do not invent a discount here.
		// NOTE: on the MERGE arm this also charges more than the MergeJoinNode it
		// replaces (0.8·keys + 0.4·target vs 0.3·(target+keys) — bounded at ~1.33×
		// for a large target), because the runtime work really is build-then-probe,
		// not a co-walk. Nothing behind PostOptimization's `impl` phase makes a
		// keep-or-drop decision on this number today; if a cost reader back there
		// (cache injection, the materialization advisory) ever starts flipping on
		// the delta, model the two arms separately rather than shading this one.
		super(scope, hashJoinCost(keyRows, targetRows));
	}

	// BinaryRelationalNode: probe side / build side, mirroring BloomJoinNode.
	get left(): RelationalPlanNode { return this.target; }
	get right(): RelationalPlanNode { return this.keySource; }

	getAttributes(): readonly Attribute[] {
		// Semi-join semantics: expose only the target side with unchanged ids
		// (mirrors buildJoinAttributes for 'semi').
		return this.target.getAttributes();
	}

	getType(): RelationType {
		// A row-subset of the target: columns and keys survive verbatim.
		return this.target.getType();
	}

	getChildren(): readonly PlanNode[] {
		return [this.target, this.keySource];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.target, this.keySource];
	}

	get estimatedRows(): number | undefined {
		return estimateJoinRows(this.left.estimatedRows, this.keySource.estimatedRows, 'semi');
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const targetPhysical = childrenPhysical[0];
		// The output is a row-subset of the target with identical attributes, so
		// the target's row-level facts survive: FDs, equivalence classes,
		// constant bindings, domain constraints, and INDs (all per-row claims
		// that hold on any subset).
		//
		// `ordering` and `monotonicOn` are claimed ONLY when
		// `seekPreservesTargetOrder` holds — then both runtime branches (the
		// untouched walk and the multi-seek over the same index) emit in the
		// leaf's own key order, so the claim is independent of the seek-vs-scan
		// decision; see that predicate's doc for the subsequence argument. The
		// predicate is DERIVED here rather than carried as a constructor flag:
		// later PostOptimization rules may rebuild the leaf through
		// `withChildren`, and a stale flag would be a wrong-order plan, while a
		// re-derivation against the current target cannot go stale. When it does
		// not hold, emission order depends on the runtime decision and claiming
		// either property would let a Sort be elided that the plan needs —
		// matching BloomJoinNode, which propagates neither.
		//
		// `accessCapabilities` stays dropped either way: those advertise a
		// leaf's ability to serve a later pushdown, and this node is not a leaf.
		// Dropping capabilities loses optimizations, never correctness.
		return {
			...(seekPreservesTargetOrder(this.target, this.pushdown)
				? { ordering: targetPhysical?.ordering, monotonicOn: targetPhysical?.monotonicOn }
				: {}),
			// Same formula as the logical getter, over the PHYSICAL child counts —
			// the logical getters read `undefined` through the physical access node
			// this semi-join targets.
			estimatedRows: estimateJoinRows(
				physicalSourceRows(targetPhysical, this.left),
				physicalSourceRows(childrenPhysical[1], this.keySource),
				'semi',
			),
			fds: targetPhysical?.fds,
			equivClasses: targetPhysical?.equivClasses,
			constantBindings: targetPhysical?.constantBindings,
			domainConstraints: targetPhysical?.domainConstraints,
			inds: targetPhysical?.inds,
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`KeySetSemiJoinNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		const [newTarget, newKeySource] = newChildren;
		if (!(newTarget instanceof SeqScanNode) && !(newTarget instanceof IndexScanNode)) {
			quereusError('KeySetSemiJoinNode: first child must be a SeqScanNode or IndexScanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newKeySource)) {
			quereusError('KeySetSemiJoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (newTarget === this.target && newKeySource === this.keySource) {
			return this;
		}
		return new KeySetSemiJoinNode(
			this.scope,
			newTarget,
			newKeySource as RelationalPlanNode,
			this.targetAttrId,
			this.keyAttrId,
			this.pushdown,
		);
	}

	override toString(): string {
		return `KEY SET SEMI JOIN on [${this.targetAttrId}=${this.keyAttrId}] via ${this.pushdown.indexName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			joinType: 'semi',
			algorithm: 'key-set',
			indexName: this.pushdown.indexName,
			seekColumnIndex: this.pushdown.seekColumnIndex,
			maxKeys: this.pushdown.maxKeys,
			breakEvenKeys: this.pushdown.breakEvenKeys,
			preservesTargetOrder: seekPreservesTargetOrder(this.target, this.pushdown),
			targetRows: this.left.estimatedRows,
			keySourceRows: this.keySource.estimatedRows,
		};
	}
}
