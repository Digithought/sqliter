import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Represents a DISTINCT operation that eliminates duplicate rows.
 * It takes an input relation and outputs unique rows.
 */
export class DistinctNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Distinct;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    estimatedCostOverride?: number
  ) {
    // Self-cost only: the source flows in via getChildren(). Self is the
    // deduplication cost (roughly O(n log n) for a sorting approach).
    const sourceRows = source.estimatedRows ?? 1;
    const deduplicationCost = sourceRows * Math.log2(Math.max(1, sourceRows));
    super(scope, estimatedCostOverride ?? deduplicationCost);
  }

  getType(): RelationType {
    // DISTINCT always produces a set (no duplicates)
    const sourceType = this.source.getType();
    return {
      ...sourceType,
      isSet: true
    };
  }

  getAttributes(): readonly Attribute[] {
    // DISTINCT preserves the same attributes as its source
    return this.source.getAttributes();
  }

  getChildren(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  get estimatedRows(): number | undefined {
    return this.rowsFrom(this.source.estimatedRows);
  }

  /**
   * DISTINCT's row estimate as a pure function of the source cardinality, so the
   * logical getter and `computePhysical` (which feeds it the PHYSICAL source
   * count) cannot drift apart.
   */
  private rowsFrom(sourceRows: number | undefined): number | undefined {
    // DISTINCT reduces the number of rows by eliminating duplicates
    // This is a rough estimate - in reality it depends on data distribution
    if (sourceRows === undefined) return undefined;
    if (sourceRows <= 1) return sourceRows;

    // Rough heuristic: assume some duplicates exist
    // More sophisticated planners would use column statistics
    return Math.max(1, Math.floor(sourceRows * 0.7));
  }

  override toString(): string {
    return 'DISTINCT';
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      // The "set semantics" claim lives on `RelationType.isSet`, which `getType()`
      // already sets to true. No separate logical-attribute key is needed.
      isSet: true,
    };
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    const sourcePhysical = childrenPhysical[0];

    // Distinct strengthens an already-monotonic input from non-strict to strict.
    // It does not establish ordering on its own.
    const sourceMonotonic = sourcePhysical?.monotonicOn;
    const monotonicOn = sourceMonotonic && sourceMonotonic.length > 0
      ? sourceMonotonic.map(m => ({ ...m, strict: true }))
      : undefined;

    // Distinct's "all-columns is a key" claim is communicated via
    // `RelationType.isSet` (set in getType()). FDs that the source proved on
    // proper subsets of the output (e.g., a PK FD) carry through unchanged.
    return {
      estimatedRows: this.rowsFrom(physicalSourceRows(sourcePhysical, this.source)),
      ordering: sourcePhysical?.ordering,
      monotonicOn,
      fds: sourcePhysical?.fds,
      equivClasses: sourcePhysical?.equivClasses,
      constantBindings: sourcePhysical?.constantBindings,
      domainConstraints: sourcePhysical?.domainConstraints,
      // Deduplication only removes rows — a per-row inclusion claim survives.
      inds: sourcePhysical?.inds,
    };
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      quereusError(`DistinctNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newSource] = newChildren;

    // Type check
    if (!isRelationalNode(newSource)) {
      quereusError('DistinctNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Return same instance if nothing changed
    if (newSource === this.source) {
      return this;
    }

    // Create new instance preserving attributes (distinct preserves source attributes)
    return new DistinctNode(
      this.scope,
      newSource as RelationalPlanNode
    );
  }
}
