import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor, type PhysicalProperties, isRelationalNode } from './plan-node.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { ColumnDef, RelationType } from '../../common/datatype.js';

/**
 * Represents an INSERT statement in the logical query plan.
 * RelationalPlanNode because this node may be a return value of a SELECT node.
 */
export class InsertNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Insert;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly targetColumns: ColumnDef[],
    public readonly source: RelationalPlanNode, // Could be ValuesNode or output of a SELECT
    public readonly flatRowDescriptor?: RowDescriptor, // For flat OLD/NEW row output
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

	override getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): readonly Attribute[] {
    // If we have a flatRowDescriptor, produce attributes that correspond to the flat OLD/NEW row structure
    if (this.flatRowDescriptor && Object.keys(this.flatRowDescriptor).length > 0) {
      // Create attributes for the flat row: OLD columns first, then NEW columns
      const attributes: Attribute[] = [];

      // Add attributes for each position in the flat row
      for (const attrIdStr in this.flatRowDescriptor) {
        const attrId = parseInt(attrIdStr);
        const flatIndex = this.flatRowDescriptor[attrId];

        // Determine if this is OLD or NEW based on index
        const tableColumnCount = this.table.tableSchema.columns.length;
        const isOld = flatIndex < tableColumnCount;
        const columnIndex = isOld ? flatIndex : flatIndex - tableColumnCount;
        const col = this.table.tableSchema.columns[columnIndex];

        attributes[flatIndex] = {
          id: attrId,
          name: col.name,
          type: {
            typeClass: 'scalar',
            logicalType: col.logicalType,
            nullable: isOld ? true : !col.notNull, // OLD values can be null, NEW follows column constraints
            isReadOnly: false
          },
          sourceRelation: `${isOld ? 'OLD' : 'NEW'}.${this.table.tableSchema.name}`
        };
      }

      return attributes;
    }

    // INSERT produces the same attributes as its source (for non-RETURNING cases)
    return this.source.getAttributes();
  }

  override getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  override getChildren(): readonly PlanNode[] {
    // Return the source relation as a child so optimizer can traverse it
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      throw new Error(`InsertNode expects 1 child (source), got ${newChildren.length}`);
    }

    const newSource = newChildren[0] as RelationalPlanNode;
    if (!isRelationalNode(newSource)) {
      throw new Error('InsertNode: child must be a RelationalPlanNode');
    }

    if (newSource === this.source) {
      return this;
    }

    return new InsertNode(
      this.scope,
      this.table,
      this.targetColumns,
      newSource,
      this.flatRowDescriptor,
      this.mutationContextValues,
      this.contextAttributes,
      this.contextDescriptor
    );
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

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    return {
      readonly: false,  // INSERT has side effects
      estimatedRows: physicalSourceRows(childrenPhysical?.[0], this.source),
    };
  }

  override toString(): string {
    return `INSERT INTO ${this.table.tableSchema.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      targetColumns: this.targetColumns.map(col => col.name)
    };

    if (this.flatRowDescriptor) {
      props.hasFlatRowDescriptor = true;
    }

    return props;
  }
}
