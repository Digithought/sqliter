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
 * scan and differs only in emission order, a property nothing above the hash
 * semi join this node replaces could have depended on (see
 * `rule-key-set-seek`'s leaf gate). Memory-vtab tables always advertise a
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
 * semi join it replaces does — and additionally, when the materialized distinct
 * key count is small enough (≤ min(maxKeys, breakEvenKeys)), rewrites the target
 * leaf's `FilterInfo` at runtime into an ordinary single-column `plan=5`
 * multi-seek so the storage backend reads only the matching rows.
 *
 * The probe never goes away: pushdown only changes how many rows the target
 * emits. An over-fetching seek is trimmed by the probe; a skipped pushdown
 * degrades to the hash semi join. The plan-time gates in `rule-key-set-seek`
 * exist to make an under-fetch (rows the seek fails to return, which the probe
 * cannot resurrect) impossible.
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

	/**
	 * `estimatedRows` over explicitly-supplied cardinalities, so `computePhysical`
	 * can feed it the PHYSICAL child counts (the logical getters read `undefined`
	 * through the physical access node this semi-join targets).
	 */
	private rowsFrom(targetRows: number | undefined, keyRows: number | undefined): number | undefined {
		return estimateJoinRows(targetRows, keyRows, 'semi');
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const targetPhysical = childrenPhysical[0];
		// The output is a row-subset of the target with identical attributes, so
		// the target's row-level facts survive: FDs, equivalence classes,
		// constant bindings, domain constraints, and INDs (all per-row claims
		// that hold on any subset).
		//
		// Deliberately NOT propagated: `ordering`, `monotonicOn`, and
		// `accessCapabilities`. Emission order depends on a decision made at
		// runtime — seek order (index-key order on the seek column) when
		// pushing, the leaf's native order when scanning — so claiming either
		// would let a Sort be elided that the plan actually needs. This is safe
		// with respect to what already ran: BloomJoinNode.computePhysical
		// propagates no ordering or monotonicOn either, so nothing above the
		// join this node replaces could have been built on the leaf's order —
		// losing those properties is the status quo, not a regression.
		return {
			estimatedRows: this.rowsFrom(
				physicalSourceRows(targetPhysical, this.left),
				physicalSourceRows(childrenPhysical[1], this.keySource),
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
			targetRows: this.left.estimatedRows,
			keySourceRows: this.keySource.estimatedRows,
		};
	}
}
