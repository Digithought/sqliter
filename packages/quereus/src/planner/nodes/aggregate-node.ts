import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode, type PhysicalProperties } from './plan-node.js';
import { ColumnReferenceNode } from './reference.js';
import { addFd, addSingletonFd, projectConstantBindings, projectDomainConstraints, projectFds, superkeyToFd } from '../util/fd-utils.js';
import type { ConstantBinding, DomainConstraint, FunctionalDependency } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { formatExpressionList } from '../../util/plan-formatter.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { AggregationCapable } from '../framework/characteristics.js';
import { aggregateCost } from '../cost/index.js';
import { aggregateRowsFrom, physicalSourceRows } from '../util/row-estimates.js';
import { disambiguateColumnNames } from '../util/output-names.js';

export interface AggregateExpression {
  expression: ScalarPlanNode;
  alias: string;
}

/**
 * Shared FD/EC propagation for aggregate nodes.
 *
 * Output columns 0..groupCount-1 correspond to the GROUP BY expressions.
 * Only bare column references map back to a source column index; other
 * expressions drop out of the mapping (and any FD/EC referencing them).
 *
 * A source FD `X → Y` survives only if every column in `X ∪ Y` maps to a
 * group-by output column. Equivalence classes project the same way.
 *
 * In addition, the aggregate emits the key-encoding FD:
 *   - GROUP BY non-empty: `{0..groupCount-1} → (all_other_output_cols)`.
 *   - GROUP BY empty:     `∅ → all_output_cols` (singleton: one row total).
 *
 * `outputColumnCount` is the aggregate node's total output-column count. It is
 * always exactly `groupCount + aggregateCount`: aggregate nodes advertise (and
 * emit) only their GROUP BY + aggregate columns. Source columns needed for
 * HAVING / correlated access flow through the runtime row-descriptor context,
 * never as output columns, so they do not appear here.
 */
export function propagateAggregateFds(
  sourceAttrIndex: ReadonlyMap<number, number>,
  groupBy: readonly ScalarPlanNode[],
  sourcePhysical: PhysicalProperties | undefined,
  outputColumnCount: number,
): {
  fds?: ReadonlyArray<FunctionalDependency>;
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
  constantBindings?: ReadonlyArray<ConstantBinding>;
  domainConstraints?: ReadonlyArray<DomainConstraint>;
} {
  const groupCount = groupBy.length;

  if (groupCount === 0) {
    // Single-group aggregate: emit the singleton FD if there is at least one
    // output column. Source-side FDs do not survive — every source row collapses
    // into one output row, so per-row source determinations no longer apply.
    const fds = addSingletonFd([], outputColumnCount);
    return {
      fds: fds.length > 0 ? fds : undefined,
    };
  }

  const map = new Map<number, number>();
  groupBy.forEach((expr, outIdx) => {
    if (expr instanceof ColumnReferenceNode) {
      const srcIdx = sourceAttrIndex.get(expr.attributeId) ?? -1;
      if (srcIdx >= 0 && !map.has(srcIdx)) map.set(srcIdx, outIdx);
    }
  });

  let fds = projectFds(sourcePhysical?.fds ?? [], map);

  // Emit the group-key FD `{0..groupCount-1} → (all_other_output_cols)`. The
  // group-by columns are a unique key on the aggregate output (one row per
  // distinct group), so they functionally determine every other output column.
  const groupKey = Array.from({ length: groupCount }, (_, i) => i);
  const keyFd = superkeyToFd(groupKey, outputColumnCount);
  if (keyFd) {
    fds = addFd(fds, keyFd, { keyHints: [groupKey] });
  }

  const projectedEquiv: number[][] = [];
  for (const cls of sourcePhysical?.equivClasses ?? []) {
    const mapped: number[] = [];
    for (const c of cls) {
      const out = map.get(c);
      if (out !== undefined && !mapped.includes(out)) mapped.push(out);
    }
    if (mapped.length >= 2) projectedEquiv.push(mapped.sort((a, b) => a - b));
  }

  // Constant bindings on GROUP BY columns survive; aggregate-output columns get
  // none (they are computed expressions, not in the column-mapping).
  const projectedBindings = projectConstantBindings(sourcePhysical?.constantBindings ?? [], map);
  const projectedDomains = projectDomainConstraints(sourcePhysical?.domainConstraints ?? [], map);

  return {
    fds: fds.length > 0 ? fds : undefined,
    equivClasses: projectedEquiv.length > 0 ? projectedEquiv : undefined,
    constantBindings: projectedBindings.length > 0 ? projectedBindings : undefined,
    domainConstraints: projectedDomains.length > 0 ? projectedDomains : undefined,
  };
}

/**
 * Logical node representing an aggregate operation.
 * Requires transformation to StreamAggregateNode or HashAggregateNode by optimizer.
 */
export class AggregateNode extends PlanNode implements UnaryRelationalNode, AggregationCapable {
  override readonly nodeType = PlanNodeType.Aggregate;
  readonly isAggregationCapable = true as const;

  private outputTypeCache: Cached<RelationType>;
  private attributesCache: Cached<Attribute[]>;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly groupBy: readonly ScalarPlanNode[],
    public readonly aggregates: readonly AggregateExpression[],
    estimatedCostOverride?: number,
    public readonly preserveAttributeIds?: readonly Attribute[]
  ) {
    // Self-cost only: the source (and group-by/aggregate exprs) flow in via
    // getChildren(). Self is a modeled aggregate cost (mirrors estimatedRows'
    // group-count heuristic); the prior `source.getTotalCost()` double-counted.
    const sourceRows = source.estimatedRows ?? 1000;
    const outputRows = groupBy.length > 0 ? Math.max(1, Math.floor(sourceRows / 2)) : 1;
    super(scope, estimatedCostOverride ?? aggregateCost(sourceRows, outputRows));

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => this.buildAttributes());
  }

  // Helper function to extract a meaningful name from a GROUP BY expression
  private getGroupByColumnName(expr: ScalarPlanNode, index: number): string {
    // If it's a column reference, use the column name
    if (expr.nodeType === PlanNodeType.ColumnReference) {
      const colRef = expr as ColumnReferenceNode;
      return colRef.expression.name;
    }
    // Otherwise, use a generic name
    return `group_${index}`;
  }

  /**
   * The published output names: GROUP BY keys then aggregates, with duplicates
   * numbered (`a`, `a:1`) exactly like a ProjectNode's.
   *
   * `GROUP BY l.a, r.a` gives both keys the base name `a`, and this node is the
   * query root whenever the SELECT list already agrees with the aggregate's own
   * layout (no capping projection is built) — so without the suffix a result-row
   * object would carry one `a` and drop the other column's value.
   *
   * Only the *type* names are disambiguated; {@link buildAttributes} keeps the
   * base names, which `createAggregateOutputScope` reads to decide that a bare
   * `a` is ambiguous across two group keys.
   */
  private buildColumnNames(): string[] {
    return disambiguateColumnNames([
      ...this.groupBy.map((expr, index) => this.getGroupByColumnName(expr, index)),
      ...this.aggregates.map(agg => agg.alias)
    ]);
  }

  private buildOutputType(): RelationType {
    // Build the output relation type based on group by columns and aggregates
    const names = this.buildColumnNames();
    const columns = [
      // Group by columns come first
      ...this.groupBy.map((expr, index) => ({
        name: names[index],
        type: expr.getType(),
        generated: false
      })),
      // Then aggregate columns
      ...this.aggregates.map((agg, index) => ({
        name: names[this.groupBy.length + index],
        type: agg.expression.getType(),
        generated: true
      }))
    ];

    // Determine if result is a set
    // - Without GROUP BY: always produces exactly 1 row, so it's a set
    // - With GROUP BY: produces one row per unique group, so it's a set
    const isSet = true;

    return {
      typeClass: 'relation',
      columns,
      keys: [], // No keys for aggregate results
      rowConstraints: [], // No row constraints for aggregate results
      isReadOnly: true,
      isSet
    };
  }

  private buildAttributes(): Attribute[] {
    // If we have preserved attribute IDs, use them
    if (this.preserveAttributeIds) {
      return this.preserveAttributeIds.slice(); // Return a copy
    }

    const attributes: Attribute[] = [];

    // Group by columns come first
    this.groupBy.forEach((expr, index) => {
      const name = this.getGroupByColumnName(expr, index);
      attributes.push({
        id: PlanNode.nextAttrId(),
        name,
        type: expr.getType(),
        sourceRelation: `${this.nodeType}:${this.id}`,
        relationName: 'aggregate' // AggregateNode creates new relation context
      });
    });

    // Then aggregate columns
    this.aggregates.forEach((agg) => {
      attributes.push({
        id: PlanNode.nextAttrId(),
        name: agg.alias,
        type: agg.expression.getType(),
        sourceRelation: `${this.nodeType}:${this.id}`,
        relationName: 'aggregate' // AggregateNode creates new relation context
      });
    });

    return attributes;
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getAttributes(): readonly Attribute[] {
    return this.attributesCache.value;
  }

  getChildren(): readonly PlanNode[] {
    return [this.source, ...this.groupBy, ...this.aggregates.map(agg => agg.expression)];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedLength = 1 + this.groupBy.length + this.aggregates.length;
    if (newChildren.length !== expectedLength) {
      quereusError(`AggregateNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newSource, ...restChildren] = newChildren;
    const newGroupBy = restChildren.slice(0, this.groupBy.length);
    const newAggregateExpressions = restChildren.slice(this.groupBy.length);

    // Type check
    if (!isRelationalNode(newSource)) {
      quereusError('AggregateNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Check if anything changed
    const sourceChanged = newSource !== this.source;
    const groupByChanged = newGroupBy.some((expr, i) => expr !== this.groupBy[i]);
    const aggregatesChanged = newAggregateExpressions.some((expr, i) => expr !== this.aggregates[i].expression);

    if (!sourceChanged && !groupByChanged && !aggregatesChanged) {
      return this;
    }

    // Build new aggregates array
    const newAggregates = newAggregateExpressions.map((expr, i) => ({
      expression: expr as ScalarPlanNode,
      alias: this.aggregates[i].alias
    }));

    // Create new instance that preserves original attribute IDs
    return new AggregateNode(
      this.scope,
      newSource as RelationalPlanNode,
      newGroupBy as ScalarPlanNode[],
      newAggregates,
      undefined, // estimatedCostOverride
      this.getAttributes() // Preserve original attribute IDs
    );
  }

  get estimatedRows(): number | undefined {
    return this.rowsFrom(this.source.estimatedRows);
  }

  private rowsFrom(sourceRows: number | undefined): number | undefined {
    // The logical node is deliberately more conservative than its physical
    // counterparts about how much a GROUP BY collapses: 2 rows per group, not 10.
    return aggregateRowsFrom(sourceRows, this.groupBy.length > 0, 2);
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    const sourcePhysical = childrenPhysical[0];
    const { fds, equivClasses, constantBindings, domainConstraints } = propagateAggregateFds(
      this.source.getAttributeIndex(),
      this.groupBy,
      sourcePhysical,
      this.getAttributes().length,
    );

    return {
      estimatedRows: this.rowsFrom(physicalSourceRows(sourcePhysical, this.source)),
      ordering: sourcePhysical?.ordering,
      fds,
      equivClasses,
      constantBindings,
      domainConstraints,
    };
  }

  override toString(): string {
    const parts: string[] = [];

    if (this.groupBy.length > 0) {
      parts.push(`GROUP BY ${formatExpressionList(this.groupBy)}`);
    }

    if (this.aggregates.length > 0) {
      const aggregatesStr = this.aggregates.map(agg =>
        `${agg.expression.toString()} AS ${agg.alias}`
      ).join(', ');
      parts.push(`AGG ${aggregatesStr}`);
    }

    return parts.join('  ');
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {};

    if (this.groupBy.length > 0) {
      props.groupBy = this.groupBy.map(expr => expr.toString());
    }

    if (this.aggregates.length > 0) {
      props.aggregates = this.aggregates.map(agg => ({
        expression: agg.expression.toString(),
        alias: agg.alias
      }));
    }

    return props;
  }

  // AggregationCapable interface implementation
  getGroupingKeys(): readonly ScalarPlanNode[] {
    return this.groupBy;
  }

  getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string; attributeId: number }[] {
    const attributes = this.getAttributes();
    const groupByCount = this.groupBy.length;

    return this.aggregates.map((agg, index) => ({
      expr: agg.expression,
      alias: agg.alias,
      attributeId: attributes[groupByCount + index].id
    }));
  }

  requiresOrdering(): boolean {
    return this.groupBy.length > 0; // Only requires ordering if we have GROUP BY
  }

  canStreamAggregate(): boolean {
    return true; // AggregateNode can always be converted to streaming
  }

	getSource(): RelationalPlanNode {
		return this.source;
	}
}
