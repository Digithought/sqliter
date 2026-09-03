import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { buildAttributesFromFlatDescriptor } from '../../util/row-descriptor.js';
import type { PhysicalProperties } from './plan-node.js';
import { physicalSourceRows } from '../util/row-estimates.js';

export interface UpdateAssignment {
  targetColumn: AST.ColumnExpr; // Could be resolved ColumnReferenceNode or just index
  value: ScalarPlanNode;
  /** True for auto-generated column recomputation assignments (evaluated after regular assignments) */
  isGenerated?: boolean;
}

/**
 * Represents an UPDATE statement in the logical query plan.
 */
export class UpdateNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Update;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly assignments: ReadonlyArray<UpdateAssignment>,
    public readonly source: RelationalPlanNode, // Typically a FilterNode wrapping a TableReferenceNode
    public readonly oldRowDescriptor: RowDescriptor, // For constraint checking
    public readonly newRowDescriptor: RowDescriptor, // For constraint checking
    public readonly flatRowDescriptor: RowDescriptor, // For flat OLD/NEW row attributes
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

  getAttributes(): Attribute[] {
    return buildAttributesFromFlatDescriptor(this.flatRowDescriptor);
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides rows to be updated, table is the target of updates.
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    // Return ALL child nodes: the source relation and the scalar assignment values
    return [this.source, ...this.assignments.map(a => a.value)];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedChildCount = 1 + this.assignments.length; // source + assignment values
    if (newChildren.length !== expectedChildCount) {
      throw new Error(`UpdateNode expects ${expectedChildCount} children (1 source + ${this.assignments.length} assignments), got ${newChildren.length}`);
    }

    // First child is the source
    const newSource = newChildren[0] as RelationalPlanNode;
    if (!isRelationalNode(newSource)) {
      throw new Error('UpdateNode: first child must be a RelationalPlanNode (source)');
    }

    // Remaining children are assignment values
    const newAssignmentValues = newChildren.slice(1);
    for (const child of newAssignmentValues) {
      if (!('expression' in child)) {
        throw new Error('UpdateNode: assignment children must be ScalarPlanNodes');
      }
    }

    // Check if anything changed
    const sourceChanged = newSource !== this.source;
    const assignmentsChanged = newAssignmentValues.some((child, i) => child !== this.assignments[i].value);

    if (!sourceChanged && !assignmentsChanged) {
      return this;
    }

    // Create new assignments with updated values
    const newAssignments = this.assignments.map((assignment, i) => ({
      targetColumn: assignment.targetColumn,
      value: newAssignmentValues[i] as ScalarPlanNode,
      isGenerated: assignment.isGenerated
    }));

    // Create new instance
    return new UpdateNode(
      this.scope,
      this.table,
      newAssignments,
      newSource,
      this.oldRowDescriptor,
      this.newRowDescriptor,
      this.flatRowDescriptor,
      this.mutationContextValues,
      this.contextAttributes,
      this.contextDescriptor
    );
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    return {
      readonly: false,  // UPDATE has side effects
      estimatedRows: physicalSourceRows(childrenPhysical?.[0], this.source),
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
    return `UPDATE ${this.table.tableSchema.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      assignments: this.assignments.map(assign => ({
        column: assign.targetColumn.name,
        value: formatExpression(assign.value)
      }))
    };
  }
}
