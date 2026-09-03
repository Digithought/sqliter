import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor, type PhysicalProperties, isRelationalNode } from './plan-node.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import { buildAttributesFromFlatDescriptor } from '../../util/row-descriptor.js';

/**
 * Represents a DELETE statement in the logical query plan.
 */
export class DeleteNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Delete;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly source: RelationalPlanNode, // Typically a FilterNode wrapping a TableReferenceNode
    public readonly oldRowDescriptor?: RowDescriptor, // For constraint checking
    public readonly flatRowDescriptor?: RowDescriptor,
    /**
     * Mutation context value expressions.
     *
     * NOTE: deliberately NOT exposed via `getChildren` (OPT-009): no emitter or rule reads
     * this map from this node — only `DmlExecutorNode` / `ConstraintCheckNode` consume it,
     * and they expose their copies. It is therefore a pass-through reference that goes
     * stale (holds pre-rewrite subtrees) once the optimizer rebuilds those nodes. If
     * anything ever starts reading it here, expose it as a child first.
     */
    public readonly mutationContextValues?: Map<string, ScalarPlanNode>,
    public readonly contextAttributes?: Attribute[], // Mutation context attributes
    public readonly contextDescriptor?: RowDescriptor, // Mutation context row descriptor
  ) {
    super(scope);
  }

	getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): readonly Attribute[] {
    if (this.flatRowDescriptor && Object.keys(this.flatRowDescriptor).length > 0) {
      return buildAttributesFromFlatDescriptor(this.flatRowDescriptor);
    }
    // Fallback to source attributes for backward compatibility
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides keys to be deleted, table is the target of deletions.
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    // Return the source relation as a child so optimizer can traverse it
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      throw new Error(`DeleteNode expects 1 child (source), got ${newChildren.length}`);
    }

    const newSource = newChildren[0] as RelationalPlanNode;
    if (!isRelationalNode(newSource)) {
      throw new Error('DeleteNode: child must be a RelationalPlanNode');
    }

    if (newSource === this.source) {
      return this;
    }

    return new DeleteNode(
      this.scope,
      this.table,
      newSource,
      this.oldRowDescriptor,
      this.flatRowDescriptor,
      this.mutationContextValues,
      this.contextAttributes,
      this.contextDescriptor
    );
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    return {
      readonly: false,  // DELETE has side effects
      // PHYSICAL source count, not the logical getter: by this pass the source is
      // an access node (or a wrapper over one) that declares no getter, so reading
      // `this.source.estimatedRows` here silently blanked the count.
      estimatedRows: physicalSourceRows(childrenPhysical[0], this.source),
    };
  }

  /**
   * Rows this node EMITS — one per source row (the emitter expands each source
   * row into a flat OLD/NEW row). See "Data-modifying nodes" in
   * `planner/util/row-estimates.ts` for why the whole write family counts emitted
   * rows and where the statement's user-visible count lives instead.
   */
  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `DELETE FROM ${this.table.tableSchema.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName
    };

    if (this.flatRowDescriptor) {
      props.hasFlatRowDescriptor = true;
    }

    return props;
  }
}
