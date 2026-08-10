import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute, type PhysicalProperties, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Physical node representing a monotonic LIMIT/OFFSET pushdown over an
 * access path that advertises `supportsOrdinalSeek`. Replaces the
 * `LimitOffset(over Sort?(over scan))` shape when the optimizer can prove
 * the rewrite is safe.
 *
 * Semantics: emit at most `limitExpr` rows starting at the `offsetExpr`-th
 * row of `source` in the leaf's monotonic emit order. The leaf is expected
 * to honor the offset/limit through `FilterInfo.offset` / `FilterInfo.limit`;
 * the emitter forwards both to the underlying scan and then enforces the
 * row cap as a streaming guard.
 *
 * Children order: `[source, offsetExpr?, limitExpr?]`. Offset is first
 * because it is the field that distinguishes this node from a plain LIMIT.
 */
export class OrdinalSliceNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.OrdinalSlice;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		/** Attribute the leaf is monotonic on. Stable across plan transformations. */
		public readonly attrId: number,
		/** 0-based first-emitted ordinal. `undefined` ⇒ 0. */
		public readonly offsetExpr: ScalarPlanNode | undefined,
		/** Maximum rows to emit. `undefined` ⇒ unbounded. */
		public readonly limitExpr: ScalarPlanNode | undefined,
		/** Direction inherited from the leaf's `monotonicOn`. */
		public readonly direction: 'asc' | 'desc',
		estimatedCostOverride?: number,
	) {
		// Self-cost only: the source flows in via getChildren(). Slicing a monotonic
		// prefix is negligible self work.
		super(scope, estimatedCostOverride ?? 0.01);
	}

	getType(): RelationType {
		return this.source.getType();
	}

	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getChildren(): readonly PlanNode[] {
		const children: PlanNode[] = [this.source];
		if (this.offsetExpr) children.push(this.offsetExpr);
		if (this.limitExpr) children.push(this.limitExpr);
		return children;
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.rowsFrom(this.source.estimatedRows);
	}

	/**
	 * The slice's row estimate as a pure function of the source cardinality —
	 * shared with `computePhysical`, which feeds it the PHYSICAL source count.
	 */
	private rowsFrom(sourceRows: number | undefined): number | undefined {
		if (sourceRows === undefined) return undefined;
		// We don't know the literal value of limitExpr here; use a conservative cap.
		return this.limitExpr ? Math.min(sourceRows, 100) : sourceRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		// Slicing a sorted prefix preserves ordering, FDs/ECs, and monotonicOn.
		// accessCapabilities are NOT propagated past the slice — the slice consumed
		// the ordinal-seek capability.
		return {
			estimatedRows: this.rowsFrom(physicalSourceRows(sourcePhysical, this.source)),
			ordering: sourcePhysical?.ordering,
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			// Slicing a prefix only removes rows — the per-row inclusion claim survives.
			inds: sourcePhysical?.inds,
			monotonicOn: sourcePhysical?.monotonicOn,
		};
	}

	override toString(): string {
		const parts: string[] = ['ORDINAL SLICE'];
		if (this.offsetExpr) parts.push(`OFFSET ${formatExpression(this.offsetExpr)}`);
		if (this.limitExpr) parts.push(`LIMIT ${formatExpression(this.limitExpr)}`);
		parts.push(`(attr=${this.attrId} ${this.direction})`);
		return parts.join(' ');
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			attrId: this.attrId,
			direction: this.direction,
		};
		if (this.offsetExpr) props.offset = formatExpression(this.offsetExpr);
		if (this.limitExpr) props.limit = formatExpression(this.limitExpr);
		return props;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 1 + (this.offsetExpr ? 1 : 0) + (this.limitExpr ? 1 : 0);
		if (newChildren.length !== expectedLength) {
			quereusError(`OrdinalSliceNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, ...rest] = newChildren;
		if (!isRelationalNode(newSource)) {
			quereusError('OrdinalSliceNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		let newOffset: ScalarPlanNode | undefined;
		let newLimit: ScalarPlanNode | undefined;
		let idx = 0;
		if (this.offsetExpr) {
			newOffset = rest[idx++] as ScalarPlanNode;
		}
		if (this.limitExpr) {
			newLimit = rest[idx++] as ScalarPlanNode;
		}

		const sourceChanged = newSource !== this.source;
		const offsetChanged = newOffset !== this.offsetExpr;
		const limitChanged = newLimit !== this.limitExpr;
		if (!sourceChanged && !offsetChanged && !limitChanged) {
			return this;
		}

		return new OrdinalSliceNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.attrId,
			newOffset,
			newLimit,
			this.direction,
		);
	}
}
