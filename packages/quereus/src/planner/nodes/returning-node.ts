import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { ColumnReferenceNode } from './reference.js';
import { expressionToString } from '../../util/ast-stringify.js';

export interface ReturningProjection {
  node: ScalarPlanNode;
  alias?: string;
}

/**
 * Represents a RETURNING clause that projects rows from a DML operation.
 * The executor performs the DML operation and yields the affected rows.
 */
export class ReturningNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Returning;

  constructor(
    scope: Scope,
    public readonly executor: RelationalPlanNode, // The DML operation that yields affected rows
    public readonly projections: ReadonlyArray<ReturningProjection>,
  ) {
    super(scope);
  }

    getType(): RelationType {
    // Return type is based on the projections, similar to ProjectNode
    // Build column names with proper duplicate handling
    const columnNames: string[] = [];
    const nameCount = new Map<string, number>();

    const columns = this.projections.map((proj, index) => {
      // Determine base column name
      let baseName: string;
      if (proj.alias) {
        baseName = proj.alias;
      } else if (proj.node instanceof ColumnReferenceNode) {
        // For column references, use the unqualified column name
        baseName = proj.node.expression.name;
      } else {
        // For expressions, use the string representation
        baseName = expressionToString(proj.node.expression);
      }

      // Handle duplicate names
      let finalName: string;
      const currentCount = nameCount.get(baseName) || 0;
      if (currentCount === 0) {
        // First occurrence - use the base name
        finalName = baseName;
      } else {
        // Subsequent occurrences - add numbered suffix
        finalName = `${baseName}:${currentCount}`;
      }
      nameCount.set(baseName, currentCount + 1);
      columnNames.push(finalName);

      return {
        name: finalName,
        type: proj.node.getType(),
        nullable: true // Conservative assumption
      };
    });

    return {
      typeClass: 'relation',
      columns,
      isSet: this.executor.getType().isSet, // Preserve set/bag semantics
      isReadOnly: false,
      keys: [], // No known keys for returning results
      rowConstraints: [], // No row constraints for returning results
    };
  }

    getAttributes(): Attribute[] {
    // Create attributes for the projected columns
    // Get the computed column names from the type
    const outputType = this.getType();

    // For each projection, preserve attribute ID if it's a simple column reference
    return this.projections.map((proj, index) => {
      // If this projection is a simple column reference, preserve its attribute ID
      if (proj.node instanceof ColumnReferenceNode) {
        return {
          id: proj.node.attributeId,
          name: outputType.columns[index].name, // Use the deduplicated name
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      } else {
        // For computed expressions, generate new attribute ID
        return {
          id: PlanNode.nextAttrId(),
          name: outputType.columns[index].name, // Use the deduplicated name
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      }
    });
  }

  getRelations(): readonly RelationalPlanNode[] {
    // Return the executor which is now a RelationalPlanNode
    return [this.executor];
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.projections.map(proj => proj.node);
  }

  get estimatedRows(): number | undefined {
    return this.executor.estimatedRows;
  }

  override toString(): string {
    const projList = this.projections.length > 3
      ? `${this.projections.length} columns`
      : this.projections.map(p => p.alias || 'expr').join(', ');
    return `RETURNING ${projList}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      executor: this.executor.nodeType,
      projectionCount: this.projections.length,
      projections: this.projections.map(proj => ({
        alias: proj.alias,
        expression: proj.node.toString()
      }))
    };
  }
}
