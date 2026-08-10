import type { Scope } from '../scopes/scope.js';
import { VoidNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type * as AST from '../../parser/ast.js';

/**
 * Represents creating a global integrity assertion.
 * This is a DDL operation that adds an assertion to the schema.
 */
export class CreateAssertionNode extends VoidNode {
  override readonly nodeType = PlanNodeType.CreateAssertion;

  constructor(
    scope: Scope,
    public readonly schemaName: string,
    public readonly name: string,
    public readonly checkExpression: AST.Expression,
  ) {
    super(scope);
  }

  override toString(): string {
    return `CREATE ASSERTION ${this.schemaName}.${this.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      schemaName: this.schemaName,
      name: this.name,
      checkExpression: this.checkExpression.toString?.() || 'complex expression',
    };
  }

  override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
    return { readonly: false };
  }
}
