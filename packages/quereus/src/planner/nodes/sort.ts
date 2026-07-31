import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute, type MonotonicOnInfo, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { formatSortKey } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { extractOrderingFromSortKeys } from '../framework/physical-utils.js';
import type { SortCapable } from '../framework/characteristics.js';
import { ColumnReferenceNode } from './reference.js';
import { isUniqueDeterminant } from '../util/fd-utils.js';
import { sortCost } from '../cost/index.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Represents a sort key for ordering results
 */
export interface SortKey {
	/** The expression to sort by */
	expression: ScalarPlanNode;
	/** Sort direction */
	direction: 'asc' | 'desc';
	/** How to handle nulls */
	nulls?: 'first' | 'last';
}

/**
 * Represents a sort operation (ORDER BY clause).
 * It takes an input relation and sort keys,
 * and outputs rows sorted according to the keys.
 * This is a physical operation that materializes and sorts rows.
 */
export class SortNode extends PlanNode implements UnaryRelationalNode, SortCapable {
	override readonly nodeType = PlanNodeType.Sort;
	readonly isSortCapable = true as const;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly sortKeys: readonly SortKey[],
		estimatedCostOverride?: number
	) {
		// Self-cost only: getChildren() is `[source, ...sortKeys.map(k => k.expression)]`,
		// so BOTH the source and every sort-key expression are children — their
		// subtree costs flow in once via getTotalCost(). Self is the O(n log n)
		// sorting overhead alone; the key-expression evaluation cost must NOT be
		// folded in (as the prior `sortCost * keyCost` multiplier did — it would
		// re-count the key subtrees that already arrive as children).
		const sourceRows = source.estimatedRows ?? 1000;

		super(scope, estimatedCostOverride ?? sortCost(sourceRows));
	}

	getType(): RelationType {
		// Sort preserves the type of the source relation
		return this.source.getType();
	}

	getAttributes(): readonly Attribute[] {
		// Sort preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly PlanNode[] {
		// Return source first, then all sort key expressions
		return [this.source, ...this.sortKeys.map(key => key.expression)];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		// Sort doesn't change the number of rows
		return this.source.estimatedRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0]; // Source is first relation
		const sourceAttributes = this.source.getAttributes();

		// Extract ordering from sort keys if they are trivial column references
		const ordering = extractOrderingFromSortKeys(this.sortKeys, sourceAttributes);

		// Establish monotonicOn from the leading sort key when it is a trivial
		// column reference. Strict iff the input is provably row-unique on that
		// single column (`isUniqueDeterminant` — kind-aware, not mere coverage).
		let monotonicOn: readonly MonotonicOnInfo[] | undefined;
		if (this.sortKeys.length > 0) {
			const leadingKey = this.sortKeys[0];
			if (leadingKey.expression instanceof ColumnReferenceNode) {
				const leadAttrId = leadingKey.expression.attributeId;
				const leadIdx = this.source.getAttributeIndex().get(leadAttrId) ?? -1;
				if (leadIdx >= 0) {
					const strict = isUniqueDeterminant(new Set([leadIdx]), sourcePhysical?.fds, sourceAttributes.length, this.source.getType().isSet);
					monotonicOn = [{
						attrId: leadAttrId,
						direction: leadingKey.direction,
						strict,
					}];
				}
			}
		}

		return {
			// Sort doesn't change the row count — relay the source's PHYSICAL count.
			estimatedRows: physicalSourceRows(sourcePhysical, this.source),
			ordering,
			// Sort doesn't change which rows are in the relation — FDs/ECs/bindings/
			// INDs propagate unchanged.
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			inds: sourcePhysical?.inds,
			monotonicOn,
		};
	}

	override toString(): string {
		const keyDescriptions = this.sortKeys.map(key =>
			formatSortKey(key.expression, key.direction, key.nulls)
		).join(', ');
		return `ORDER BY ${keyDescriptions}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			sortKeys: this.sortKeys.map(key => ({
				expression: key.expression.toString(),
				direction: key.direction,
				nulls: key.nulls
			}))
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1 + this.sortKeys.length) {
			quereusError(`SortNode expects ${1 + this.sortKeys.length} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, ...newSortExpressions] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('SortNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const sortExpressionsChanged = newSortExpressions.some((expr, i) => expr !== this.sortKeys[i].expression);

		if (!sourceChanged && !sortExpressionsChanged) {
			return this;
		}

		// Build new sort keys array
		const newSortKeys = newSortExpressions.map((expr, i) => ({
			expression: expr as ScalarPlanNode,
			direction: this.sortKeys[i].direction,
			nulls: this.sortKeys[i].nulls
		}));

		// Create new instance preserving attributes (sort preserves source attributes)
		return new SortNode(
			this.scope,
			newSource as RelationalPlanNode,
			newSortKeys
		);
	}

	// SortCapable interface implementation
	getSortKeys(): readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }[] {
		return this.sortKeys.map(key => ({
			expression: key.expression,
			direction: key.direction,
			nulls: key.nulls
		}));
	}

	withSortKeys(keys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }[]): PlanNode {
		const newSortKeys: SortKey[] = keys.map(key => ({
			expression: key.expression,
			direction: key.direction,
			nulls: key.nulls
		}));

		// Check if anything changed
		const changed = newSortKeys.length !== this.sortKeys.length ||
			newSortKeys.some((key, i) =>
				key.expression !== this.sortKeys[i].expression ||
				key.direction !== this.sortKeys[i].direction ||
				key.nulls !== this.sortKeys[i].nulls
			);

		if (!changed) {
			return this;
		}

		return new SortNode(this.scope, this.source, newSortKeys);
	}
}
