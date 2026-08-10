import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type Attribute, isRelationalNode, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { LimitCapable } from '../framework/characteristics.js';
import { CastNode, CollateNode, LiteralNode } from './scalar.js';
import { addSingletonFd } from '../util/fd-utils.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Represents a LIMIT/OFFSET operation.
 * It takes an input relation and returns at most 'limit' rows, skipping 'offset' rows.
 */
export class LimitOffsetNode extends PlanNode implements UnaryRelationalNode, LimitCapable {
	override readonly nodeType = PlanNodeType.LimitOffset;
	readonly isLimitCapable = true as const;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly limit: ScalarPlanNode | undefined,
		public readonly offset: ScalarPlanNode | undefined,
		estimatedCostOverride?: number
	) {
		// Self-cost only: the source (and limit/offset exprs) flow in via
		// getChildren(). Slicing rows is negligible self work.
		super(scope, estimatedCostOverride ?? 0.01);
	}

	// LimitCapable interface
	getLimitExpression(): ScalarPlanNode | undefined {
		return this.limit;
	}

	getOffsetExpression(): ScalarPlanNode | undefined {
		return this.offset;
	}

	getType(): RelationType {
		// LIMIT/OFFSET preserves the type of the source relation
		return this.source.getType();
	}

	getAttributes(): readonly Attribute[] {
		// LIMIT/OFFSET preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly PlanNode[] {
		const children: PlanNode[] = [this.source];
		if (this.limit) children.push(this.limit);
		if (this.offset) children.push(this.offset);
		return children;
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	/**
	 * Resolve the LIMIT expression to a compile-time-constant numeric value, or
	 * `undefined` when it is not a known constant. Peels `CastNode`/`CollateNode`
	 * to find a `LiteralNode`, mirroring `literalSqlValueOf` in `fd-utils.ts`.
	 *
	 * `Number(value)` coercion matches the emitter (`runtime/emit/limit-offset.ts`).
	 * A literal NULL means "no limit" (the emitter treats it as `Infinity`), so it
	 * is reported as non-constant. A non-finite / non-numeric literal is likewise
	 * not constant-known. A parameter / expression / subquery limit stays
	 * undefined — those are unknown at plan time.
	 */
	private constantLimit(): number | undefined {
		if (this.limit === undefined) return undefined;
		let cur: ScalarPlanNode = this.limit;
		while (cur instanceof CastNode || cur instanceof CollateNode) {
			cur = cur.operand;
		}
		if (!(cur instanceof LiteralNode)) return undefined;
		const v = cur.expression.value;
		if (v instanceof Promise) return undefined;
		// Literal NULL ⇒ unbounded (emitter uses Infinity), not a ≤1-row constant.
		if (v === null) return undefined;
		const n = Number(v);
		if (!Number.isFinite(n)) return undefined;
		return n;
	}

	get estimatedRows(): number | undefined {
		return this.rowsFrom(this.source.estimatedRows);
	}

	/**
	 * The LIMIT/OFFSET row estimate as a pure function of the source cardinality,
	 * shared by the logical getter and `computePhysical` (which feeds it the
	 * PHYSICAL source count) so the two cannot drift apart.
	 */
	private rowsFrom(sourceRows: number | undefined): number | undefined {
		if (sourceRows === undefined) return undefined;

		const limit = this.constantLimit();
		if (limit !== undefined && limit >= 0) {
			// Exact upper bound: at most `limit` rows survive. OFFSET only removes
			// rows, so `min(sourceRows, limit)` is sound regardless of offset.
			return Math.min(sourceRows, limit);
		}

		// Non-constant limit: keep the existing heuristic (no limit ⇒ source rows).
		if (this.limit) {
			return Math.min(sourceRows, 100);
		}
		return sourceRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];

		// A compile-time-constant LIMIT ≤ 1 (including LIMIT 0) is provably ≤1-row,
		// so emit the singleton `∅ → all_cols` FD alongside the source FDs. OFFSET
		// does not gate this — it only removes rows. Merge (don't replace): the
		// empty key subsumes all source keys, and the read surface normalizes.
		let fds = sourcePhysical?.fds;
		const limit = this.constantLimit();
		if (limit !== undefined && limit <= 1) {
			fds = addSingletonFd(sourcePhysical?.fds ?? [], this.getAttributes().length);
		}

		return {
			estimatedRows: this.rowsFrom(physicalSourceRows(sourcePhysical, this.source)),
			ordering: sourcePhysical?.ordering,
			// LIMIT/OFFSET preserves FDs/ECs/bindings — slicing rows doesn't break
			// per-row determinations.
			fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			// Slicing rows keeps a per-row inclusion claim — INDs pass through.
			inds: sourcePhysical?.inds,
			// LIMIT/OFFSET preserves monotonicOn — slicing a sorted prefix preserves ordering.
			monotonicOn: sourcePhysical?.monotonicOn,
		};
	}

	override toString(): string {
		const parts: string[] = [];
		if (this.limit) parts.push(`LIMIT ${formatExpression(this.limit)}`);
		if (this.offset) parts.push(`OFFSET ${formatExpression(this.offset)}`);
		return parts.join(' ');
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {};

		if (this.limit) {
			props.limit = formatExpression(this.limit);
		}

		if (this.offset) {
			props.offset = formatExpression(this.offset);
		}

		return props;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 1 + (this.limit ? 1 : 0) + (this.offset ? 1 : 0);
		if (newChildren.length !== expectedLength) {
			quereusError(`LimitOffsetNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, ...restChildren] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('LimitOffsetNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Parse optional limit and offset from remaining children
		let newLimit: ScalarPlanNode | undefined = undefined;
		let newOffset: ScalarPlanNode | undefined = undefined;
		let childIndex = 0;

		if (this.limit) {
			newLimit = restChildren[childIndex] as ScalarPlanNode;
			childIndex++;
		}
		if (this.offset) {
			newOffset = restChildren[childIndex] as ScalarPlanNode;
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const limitChanged = newLimit !== this.limit;
		const offsetChanged = newOffset !== this.offset;

		if (!sourceChanged && !limitChanged && !offsetChanged) {
			return this;
		}

		// Create new instance preserving attributes (limit/offset preserves source attributes)
		return new LimitOffsetNode(
			this.scope,
			newSource as RelationalPlanNode,
			newLimit,
			newOffset
		);
	}
}
