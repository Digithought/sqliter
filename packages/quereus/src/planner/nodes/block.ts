import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode } from './plan-node.js';
import type { BaseType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { SqlParameters } from '../../common/types.js';

/**
 * Represents a block of one or more statements to be executed in sequence.
 * This is the root of most SQL query plans.
 */
export class BlockNode extends PlanNode {
  override readonly nodeType = PlanNodeType.Block;

  constructor(
    scope: Scope,
    public readonly statements: PlanNode[],
    /** Snapshot of parameters utilized by the block. */
    public readonly parameters: SqlParameters,
    estimatedCostOverride?: number
  ) {
    // Self-cost only: the statements are getChildren(), so their subtree costs
    // flow in via getTotalCost(). The block's own sequencing overhead is negligible.
    super(scope, estimatedCostOverride ?? 0.01);
  }

  getType(): BaseType {
    // A block doesn't have a well-defined type; it's context-dependent
    return { typeClass: 'void' };
  }

  getChildren(): readonly PlanNode[] {
    return this.statements;
  }

  getRelations(): readonly RelationalPlanNode[] {
    return this.statements.filter(s => s.getType().typeClass === "relation") as unknown as readonly RelationalPlanNode[];
  }

  override toString(): string {
    return `${this.statements.length} statements`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      numStatements: this.statements.length,
      statementTypes: this.statements.map(stmt => stmt.nodeType),
      parameters: Object.keys(this.parameters)
    };
  }

  get estimatedRows(): number | undefined {
    return this.getRelations().reduce((acc, s) => acc + (s.estimatedRows ?? 0), 0);
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    // Return same instance if nothing changed
    if (newChildren.length === this.statements.length &&
        newChildren.every((child, i) => child === this.statements[i])) {
      return this;
    }

    return new BlockNode(
      this.scope,
      [...newChildren],
      this.parameters
    );
  }
}
