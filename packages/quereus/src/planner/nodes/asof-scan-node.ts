import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type BinaryRelationalNode, type PhysicalProperties, type Attribute, type MonotonicOnInfo, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { buildJoinAttributes, buildJoinRelationType } from './join-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Pair of attribute IDs identifying matching attributes on the left and right sides
 * of an asof scan (either the asof match attribute or a partition equi-pair).
 */
export interface AsofAttrPair {
	leftAttrId: number;
	rightAttrId: number;
}

/**
 * Physical plan node implementing a streaming asof scan.
 *
 * For each left row, emits a single right row matched against the left's match
 * value, optionally bucketed by partition keys. Two directions are supported:
 *
 *   - `direction = 'desc'`: latest right ≤ left.match (or strict <).
 *   - `direction = 'asc'`:  earliest right ≥ left.match (or strict >).
 *
 * Requires the right input to advertise `MonotonicOn(matchAttr)` (ascending)
 * and `accessCapabilities.asofRight`.
 *
 * Output attributes: left attributes followed by the projected right output
 * attributes (NULL-padded when `outer` and no match exists). The optional
 * `rightOutputAttrs` parameter lets the rule preserve attribute IDs from the
 * original logical JoinNode — without it, all of `right`'s attributes are
 * emitted unchanged.
 *
 * Two emitter strategies (selected by `rule-asof-strategy-select`):
 *
 *   - `'hash'` (default): bucket the right by partition key (`Map<string, Row[]>`),
 *     stream the left with per-bucket cursors. Memory O(R), latency = first
 *     emit after R fully arrives.
 *   - `'merge'`: co-stream both inputs in lockstep when both are pre-ordered
 *     by `[partition cols..., matchAttr]`. Memory O(1) (one in-flight
 *     partition), emits as left rows arrive.
 *
 * Cost: O(left.rows + right.rows) regardless of strategy — the difference is
 * constant factors / memory.
 */
export class AsofScanNode extends PlanNode implements BinaryRelationalNode {
	override readonly nodeType = PlanNodeType.AsofScan;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		/** Left (driving) input. */
		public readonly left: RelationalPlanNode,
		/** Right input. Must advertise MonotonicOn(matchAttr.right) and accessCapabilities.asofRight. */
		public readonly right: RelationalPlanNode,
		/** Asof match attribute pair. */
		public readonly matchAttr: AsofAttrPair,
		/** Equi-partition keys (zero or more). Empty array = single bucket. */
		public readonly partitionAttrs: readonly AsofAttrPair[],
		/** Strict (open) vs non-strict (closed) on the asof comparison. */
		public readonly strict: boolean,
		/**
		 * Direction of the asof match.
		 *   'desc' → largest right.match ≤ left.match (or < when strict)
		 *   'asc'  → smallest right.match ≥ left.match (or > when strict)
		 */
		public readonly direction: 'asc' | 'desc',
		/** LEFT JOIN semantics: emit unmatched left rows with NULL right columns. */
		public readonly outer: boolean,
		/**
		 * Column indices into `right`'s row to project for output. If undefined,
		 * all of `right`'s columns are emitted in order.
		 */
		public readonly rightOutputColumnIndices?: readonly number[],
		/**
		 * Attributes to expose for the right side of the output. When provided,
		 * these are used verbatim (preserving attribute IDs from the original
		 * logical JoinNode). Length must match `rightOutputColumnIndices` (or the
		 * full right attribute count when no projection is given).
		 */
		public readonly rightOutputAttrs?: readonly Attribute[],
		/**
		 * Emitter strategy. Default is `'hash'`; the strategy-select rule may
		 * upgrade to `'merge'` when both inputs are co-partition-ordered and the
		 * right's row count crosses the configured threshold.
		 */
		public readonly strategy: 'hash' | 'merge' = 'hash',
	) {
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;
		// Self-cost only: children (left, right) flow in via getTotalCost(). Self is
		// the O(L + R) per-row work.
		const cost = leftRows + rightRows;
		super(scope, cost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	/** Indices into the right row to emit, in output order. */
	getRightOutputColumnIndices(): readonly number[] {
		if (this.rightOutputColumnIndices) return this.rightOutputColumnIndices;
		return this.right.getAttributes().map((_, i) => i);
	}

	private buildAttributes(): Attribute[] {
		const leftAttrs = this.left.getAttributes();
		const rightAttrs = this.right.getAttributes();
		const rightCols = this.getRightOutputColumnIndices();

		// When `rightOutputAttrs` is supplied, use those verbatim alongside the left
		// attributes — they already encode the JoinNode's preserved IDs and any
		// nullability overrides for `outer`.
		if (this.rightOutputAttrs) {
			if (this.rightOutputAttrs.length !== rightCols.length) {
				quereusError(`AsofScanNode: rightOutputAttrs length ${this.rightOutputAttrs.length} != rightOutputColumnIndices length ${rightCols.length}`, StatusCode.INTERNAL);
			}
			return [...leftAttrs, ...this.rightOutputAttrs];
		}

		const projectedRightAttrs: Attribute[] = rightCols.map(idx => {
			if (idx < 0 || idx >= rightAttrs.length) {
				quereusError(`AsofScanNode: rightOutputColumnIndex ${idx} out of range [0,${rightAttrs.length})`, StatusCode.INTERNAL);
			}
			return rightAttrs[idx];
		});

		return buildJoinAttributes(leftAttrs, projectedRightAttrs, this.outer ? 'left' : 'inner');
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const leftType = this.left.getType();
		const rightAttrs = this.getAttributes().slice(this.left.getAttributes().length);
		const rightType: RelationType = {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: rightAttrs.map(a => ({ name: a.name, type: a.type })),
			keys: [],
			rowConstraints: [],
		};
		return buildJoinRelationType(leftType, rightType, this.outer ? 'left' : 'inner', []);
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];

		// AsofScan emits one row per left row in left's order — left's ordering and
		// monotonicOn carry through (right values are appended per row but don't
		// reorder the output).
		const monotonicOn: readonly MonotonicOnInfo[] | undefined = leftPhys?.monotonicOn;
		const ordering = leftPhys?.ordering;

		// FDs/ECs: inherit left's contributions on left's columns. The right side's
		// FDs are dropped — asof matches at most one right row and may NULL-pad in
		// outer mode, neither of which preserves right-side FDs. The asof condition
		// is an inequality, not an equality, so no equi-pair FDs are added.
		// Constant bindings follow the same rule (inherit left only).
		const fds = leftPhys?.fds;
		const equivClasses = leftPhys?.equivClasses;
		const constantBindings = leftPhys?.constantBindings;
		const domainConstraints = leftPhys?.domainConstraints;

		return {
			ordering,
			monotonicOn,
			// Asof emits one row per left row — relay the left side's PHYSICAL count
			// (its logical getter reads `undefined` through a physical access node).
			estimatedRows: physicalSourceRows(leftPhys, this.left),
			// Key-encoding FDs from left are not re-emitted here: appending right
			// values per left row doesn't preserve uniqueness on left's keys (the
			// asof match may be NULL-padded under `outer` and the right side has no
			// key contribution). `fds` carries forward left's non-key dependencies.
			fds,
			equivClasses,
			constantBindings,
			domainConstraints,
		};
	}

	get estimatedRows(): number | undefined {
		return this.left.estimatedRows;
	}

	getChildren(): readonly PlanNode[] {
		return [this.left, this.right];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`AsofScanNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight] = newChildren;

		if (!isRelationalNode(newLeft)) {
			quereusError('AsofScanNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('AsofScanNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newLeft === this.left && newRight === this.right) {
			return this;
		}

		return new AsofScanNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.matchAttr,
			this.partitionAttrs,
			this.strict,
			this.direction,
			this.outer,
			this.rightOutputColumnIndices,
			this.rightOutputAttrs,
			this.strategy,
		);
	}

	/**
	 * Return this node with `strategy` set to the given value. Returns `this`
	 * when the strategy is unchanged.
	 */
	withStrategy(strategy: 'hash' | 'merge'): AsofScanNode {
		if (strategy === this.strategy) return this;
		return new AsofScanNode(
			this.scope,
			this.left,
			this.right,
			this.matchAttr,
			this.partitionAttrs,
			this.strict,
			this.direction,
			this.outer,
			this.rightOutputColumnIndices,
			this.rightOutputAttrs,
			strategy,
		);
	}

	override toString(): string {
		// 'desc' → right ≤/< left; 'asc' → right ≥/> left.
		const op = this.direction === 'desc'
			? (this.strict ? '<' : '<=')
			: (this.strict ? '>' : '>=');
		const parts: string[] = [];
		parts.push(`right.${this.matchAttr.rightAttrId} ${op} left.${this.matchAttr.leftAttrId}`);
		for (const p of this.partitionAttrs) {
			parts.push(`right.${p.rightAttrId} = left.${p.leftAttrId}`);
		}
		return `${this.outer ? 'LEFT ' : ''}ASOF SCAN [${this.strategy}] on [${parts.join(', ')}]`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			outer: this.outer,
			strict: this.strict,
			direction: this.direction,
			strategy: this.strategy,
			matchAttr: { left: this.matchAttr.leftAttrId, right: this.matchAttr.rightAttrId },
			partitionAttrs: this.partitionAttrs.map(p => ({ left: p.leftAttrId, right: p.rightAttrId })),
			rightOutputColumnIndices: this.rightOutputColumnIndices ? [...this.rightOutputColumnIndices] : undefined,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows,
		};
	}
}
