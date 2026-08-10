import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type BinaryRelationalNode, type ScalarPlanNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { JoinCapable, PredicateSourceCapable } from '../framework/characteristics.js';
import { mergeJoinCost } from '../cost/index.js';
import type { JoinType } from './join-node.js';
import { buildJoinAttributes, buildJoinRelationType, describeEquiPairs, estimateJoinRows, joinPhysicalRows, propagateJoinMonotonicOn, propagateJoinFds, propagateJoinInds, valueFactPairs, type EquiJoinPair } from './join-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { analyzeJoinKeyCoverage, combineJoinKeys } from '../util/key-utils.js';

/**
 * Physical plan node implementing a merge join.
 *
 * Requires both inputs sorted on the equi-join columns. Performs a single
 * linear pass over both sides, collecting "runs" of equal keys and producing
 * the cross-product of matching runs.
 *
 * Cost: O(n + m) when inputs are already sorted; O(n log n + m log m) otherwise
 * (sort costs handled by upstream SortNodes inserted by the optimizer).
 */
export class MergeJoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable, PredicateSourceCapable {
	override readonly nodeType = PlanNodeType.MergeJoin;
	readonly isJoinCapable = true as const;
	readonly isPredicateSourceCapable = true as const;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		/** Left side (sorted on join keys) */
		public readonly left: RelationalPlanNode,
		/** Right side (sorted on join keys) */
		public readonly right: RelationalPlanNode,
		public readonly joinType: JoinType,
		/** Pre-extracted equi-join pairs (left.col = right.col) */
		public readonly equiPairs: readonly EquiJoinPair[],
		/** Non-equi remainder of the ON condition, if any */
		public readonly residualCondition?: ScalarPlanNode,
		/** Preserved attribute IDs from the logical JoinNode */
		public readonly preserveAttributeIds?: readonly Attribute[],
	) {
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;
		// Merge cost only (no sort cost here — SortNodes are inserted upstream if needed)
		// Self-cost only: children (left, right, residualCondition) flow in via
		// getTotalCost(). Self is the merge cost (no sort cost — SortNodes are
		// inserted upstream if needed).
		const cost = mergeJoinCost(leftRows, rightRows, false, false);
		super(scope, cost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private buildAttributes(): Attribute[] {
		return buildJoinAttributes(
			this.left.getAttributes(), this.right.getAttributes(),
			this.joinType, this.preserveAttributeIds,
		);
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	/** Pairs this join may mint value-level facts from — see {@link valueFactPairs}. */
	private factPairs(): readonly EquiJoinPair[] {
		return valueFactPairs(this.equiPairs);
	}

	getType(): RelationType {
		const leftType = this.left.getType();
		const rightType = this.right.getType();
		const leftIndex = this.left.getAttributeIndex();
		const rightIndex = this.right.getAttributeIndex();
		const indexPairs = this.factPairs().map(p => ({
			left: leftIndex.get(p.leftAttrId) ?? -1,
			right: rightIndex.get(p.rightAttrId) ?? -1,
		})).filter(p => p.left >= 0 && p.right >= 0);
		const keys = combineJoinKeys(leftType.keys, rightType.keys, this.joinType, leftType.columns.length, indexPairs);
		return buildJoinRelationType(leftType, rightType, this.joinType, keys);
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];
		const rightPhys = childrenPhysical[1];
		const leftAttrs = this.left.getAttributes();
		const leftIndex = this.left.getAttributeIndex();
		const rightIndex = this.right.getAttributeIndex();

		// Map attribute-ID-based equi-pairs to column-index-based pairs.
		// Value-fact consumers only — see `factPairs`.
		const factPairs = this.factPairs();
		const indexPairs = factPairs.map(p => ({
			left: leftIndex.get(p.leftAttrId) ?? -1,
			right: rightIndex.get(p.rightAttrId) ?? -1,
		}));

		// PHYSICAL child cardinalities — the logical getters read `undefined`
		// through a physical access node (see `physicalSourceRows`).
		const leftRows = physicalSourceRows(leftPhys, this.left);
		const rightRows = physicalSourceRows(rightPhys, this.right);

		const result = analyzeJoinKeyCoverage(
			this.joinType, leftPhys, rightPhys,
			this.left.getType(), this.right.getType(),
			indexPairs, leftRows, rightRows,
			leftAttrs.length,
		);

		// Merge join preserves left-side ordering
		const ordering = (this.joinType === 'semi' || this.joinType === 'anti' || this.joinType === 'inner' || this.joinType === 'cross')
			? leftPhys.ordering
			: undefined;

		const totalCols = this.getAttributes().length;
		const fdResult = propagateJoinFds(
			this.joinType, leftPhys, rightPhys, indexPairs,
			leftAttrs.length, totalCols, result.preservedKeys,
		);

		return {
			ordering,
			estimatedRows: joinPhysicalRows(this.joinType, result.estimatedRows, leftRows, rightRows),
			// MergeJoin physically guarantees monotonicOn on equi-pair attrIds when both
			// inputs were monotonic on their respective X (the merge join's whole point).
			// Value-discriminating pairs only: a NOCASE run collapses value-distinct
			// rows into one key run, so per-side value monotonicity is not preserved.
			monotonicOn: propagateJoinMonotonicOn(this.joinType, leftPhys, rightPhys, factPairs),
			fds: fdResult.fds,
			equivClasses: fdResult.equivClasses,
			constantBindings: fdResult.constantBindings,
			domainConstraints: fdResult.domainConstraints,
			inds: propagateJoinInds(this.joinType, leftPhys, rightPhys, leftAttrs.length),
		};
	}

	get estimatedRows(): number | undefined {
		return estimateJoinRows(this.left.estimatedRows, this.right.estimatedRows, this.joinType);
	}

	getChildren(): readonly PlanNode[] {
		const children: PlanNode[] = [this.left, this.right];
		if (this.residualCondition) children.push(this.residualCondition);
		return children;
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.residualCondition ? 3 : 2;
		if (newChildren.length !== expectedLength) {
			quereusError(`MergeJoinNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight, newResidual] = newChildren;

		if (!isRelationalNode(newLeft)) {
			quereusError('MergeJoinNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('MergeJoinNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newLeft === this.left && newRight === this.right &&
			(!this.residualCondition || newResidual === this.residualCondition)) {
			return this;
		}

		return new MergeJoinNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.joinType,
			this.equiPairs,
			newResidual as ScalarPlanNode | undefined,
			this.preserveAttributeIds
		);
	}

	// JoinCapable interface
	getJoinType(): JoinType { return this.joinType; }
	getJoinCondition(): ScalarPlanNode | undefined { return this.residualCondition; }
	getLeftSource(): RelationalPlanNode { return this.left; }
	getRightSource(): RelationalPlanNode { return this.right; }
	getUsingColumns(): readonly string[] | undefined { return undefined; }

	// PredicateSourceCapable
	getPredicates(): readonly ScalarPlanNode[] {
		return this.residualCondition ? [this.residualCondition] : [];
	}

	override toString(): string {
		const pairs = this.equiPairs.map(p => `${p.leftAttrId}=${p.rightAttrId}`).join(', ');
		return `${this.joinType.toUpperCase()} MERGE JOIN on [${pairs}]`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			joinType: this.joinType,
			algorithm: 'merge',
			equiPairs: describeEquiPairs(this.equiPairs),
			hasResidual: !!this.residualCondition,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows,
		};
	}
}
