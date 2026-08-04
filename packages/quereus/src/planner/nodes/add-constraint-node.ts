import type { Scope } from '../scopes/scope.js';
import { VoidNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type * as AST from '../../parser/ast.js';

/**
 * Represents adding a constraint to an existing table.
 * This is a DDL operation that modifies the table schema at runtime.
 */
export class AddConstraintNode extends VoidNode {
  override readonly nodeType = PlanNodeType.AddConstraint;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly constraint: AST.TableConstraint,
    /**
     * Canonical, fully-qualified SQL of the whole statement, rendered at plan-build
     * time from the resolved table reference (see `buildAlterTableStmt`). Threaded to
     * `module.alterTable` as `SchemaChangeInfo.ddl` and onto the public
     * schema-change event — same contract as `AlterTableNode.sql`.
     */
    public readonly sql: string,
  ) {
    super(scope);
  }

  override getRelations(): readonly [TableReferenceNode] {
    return [this.table];
  }

  override toString(): string {
    const constraintType = this.constraint.type.toUpperCase();
    const constraintName = this.constraint.name || 'unnamed';
    return `ADD CONSTRAINT ${constraintName} ${constraintType}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      constraintType: this.constraint.type,
      constraintName: this.constraint.name,
      hasOperations: !!this.constraint.operations,
      operations: this.constraint.operations,
    };
  }

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
