import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ZeroAryRelationalNode, type Attribute, PhysicalProperties, type ConstantNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { EmptyScope } from '../scopes/empty.js';
import type { Scope } from '../scopes/scope.js';
import type { Row } from '../../common/types.js';

/**
 * A dummy relational node that produces a single row with no columns.
 * Used as a source for SELECT statements without a FROM clause.
 */
export class SingleRowNode extends PlanNode implements ZeroAryRelationalNode, ConstantNode {
  override readonly nodeType = PlanNodeType.SingleRow;

  private static readonly singleInstance = new SingleRowNode(EmptyScope.instance); // HACK: null scope for singleton

  private readonly outputType: RelationType = {
    typeClass: 'relation',
    isReadOnly: true,
    isSet: true, // Single row is always a set
    columns: [],
    keys: [[]], // Represents a relation that can have at most one row
    rowConstraints: [],
  };

  private constructor(scope: Scope) { // Private constructor for singleton
    super(scope, 0.01); // Low cost - no IO
  }

  public static get instance(): SingleRowNode {
    return SingleRowNode.singleInstance;
  }

  getType(): RelationType {
    return this.outputType;
  }

  getAttributes(): Attribute[] {
    // Single row node has no columns, so no attributes
    return [];
  }

  getChildren(): readonly [] {
    return [];
  }

	getRelations(): readonly [] {
		return [];
	}

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      throw new Error(`SingleRowNode expects 0 children, got ${newChildren.length}`);
    }
    return this; // No children, so no change
  }

  get estimatedRows(): number {
    return 1;
  }

  override toString(): string {
    return `dual`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      description: 'Single row with no columns (dual table)',
      numRows: 1,
      numColumns: 0,
    };
  }

	override computePhysical(): Partial<PhysicalProperties> {
		// SingleRow has zero columns, so the singleton FD `∅ → all_cols` has no
		// dependents and isn't representable as an FD. The at-most-one-row
		// guarantee is communicated via `estimatedRows: 1` and `RelationType.isSet`.
		// This is the documented `colCount === 0` carve-out of the
		// independent-channel singleton law: the declared empty key needs no
		// matching FD because none can exist (see test/property.spec.ts).
		return {
			estimatedRows: 1,
			constant: true,
		};
	}

	async *getValue(): AsyncIterable<Row> {
		yield [];
	}
}
