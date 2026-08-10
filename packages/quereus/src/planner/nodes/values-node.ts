import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type ScalarPlanNode, type ZeroAryRelationalNode, type Attribute, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { Cached } from '../../util/cached.js';
import { formatScalarType } from '../../util/plan-formatter.js';
import { Row } from '../../common/types.js';
import { addSingletonFd } from '../util/fd-utils.js';

/**
 * Represents a VALUES clause, producing a relation from literal rows.
 */
export class ValuesNode extends PlanNode implements ZeroAryRelationalNode {
  override readonly nodeType = PlanNodeType.Values;

  private outputTypeCache: Cached<RelationType>;
  private attributesCache: Cached<Attribute[]>;

  constructor(
    scope: Scope,
    // Each inner array is a row, consisting of ScalarPlanNodes for each cell.
    public readonly rows: ReadonlyArray<ReadonlyArray<ScalarPlanNode>>,
    // Optional column names - if not provided, defaults to column_0, column_1, etc.
    public readonly columnNames?: ReadonlyArray<string>,
    estimatedCostOverride?: number,
    /** Optional predefined attributes for preserving IDs during optimization */
    predefinedAttributes?: Attribute[]
  ) {
    super(scope, estimatedCostOverride ?? rows.length * 0.01); // Small cost per row

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => {
      // If predefined attributes are provided, use them (for optimization)
      if (predefinedAttributes) {
        return predefinedAttributes.slice(); // Return a copy
      }

      return this.buildAttributes();
    });
  }

  private buildOutputType(): RelationType {
    if (this.rows.length === 0) {
      return {
        typeClass: 'relation',
        isReadOnly: true,
        isSet: true,
        columns: [],
        keys: [],
        rowConstraints: [],
      };
    }

    // Infer column types from the first row
    const firstRow = this.rows[0];
    const columns = firstRow.map((expr, index) => ({
      name: this.columnNames?.[index] ?? `column_${index}`,
      type: expr.getType(),
      generated: false,
    }));

    return {
      typeClass: 'relation',
      isReadOnly: true,
      isSet: false, // VALUES can have duplicate rows
      columns,
      keys: [], // VALUES doesn't have inherent keys
      rowConstraints: [],
    };
  }

  private buildAttributes(): Attribute[] {
    if (this.rows.length === 0) {
      return [];
    }

    // Create attributes for each column
    const firstRow = this.rows[0];
    return firstRow.map((expr, index) => ({
      id: PlanNode.nextAttrId(),
      name: this.columnNames?.[index] ?? `column_${index}`,
      type: expr.getType(),
      sourceRelation: `${this.nodeType}:${this.id}`
    }));
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getAttributes(): Attribute[] {
    return this.attributesCache.value;
  }

  getChildren(): readonly ScalarPlanNode[] {
    // All expressions in all rows are children in terms of planning dependencies
    return this.rows.flat();
  }

  getRelations(): readonly [] {
    return [];
  }

  computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
    // A VALUES clause with ≤1 row is provably ≤1-row, so emit the canonical
    // singleton `∅ → all_cols` FD. Multi-row VALUES remains a bag with no FDs.
    if (this.rows.length > 1) {
      return { estimatedRows: this.rows.length };
    }
    const fds = addSingletonFd([], this.getAttributes().length);
    return {
      estimatedRows: this.rows.length,
      fds: fds.length > 0 ? fds : undefined,
    };
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedLength = this.rows.flat().length;
    if (newChildren.length !== expectedLength) {
      throw new Error(`ValuesNode expects ${expectedLength} children, got ${newChildren.length}`);
    }

    // Type check
    for (const child of newChildren) {
      if (!('expression' in child)) {
        throw new Error('ValuesNode: all children must be ScalarPlanNodes');
      }
    }

    // Check if anything changed
    const flatChildren = this.rows.flat();
    const childrenChanged = newChildren.some((child, i) => child !== flatChildren[i]);
    if (!childrenChanged) {
      return this;
    }

    // Rebuild the rows structure
    const newRows: ScalarPlanNode[][] = [];
    let childIndex = 0;
    for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex++) {
      const rowLength = this.rows[rowIndex].length;
      const newRow = newChildren.slice(childIndex, childIndex + rowLength) as ScalarPlanNode[];
      newRows.push(newRow);
      childIndex += rowLength;
    }

    // Preserve original attribute IDs to maintain column reference stability
    const originalAttributes = this.getAttributes();

    // Create new instance with preserved attributes
    return new ValuesNode(
      this.scope,
      newRows,
      this.columnNames,
      undefined, // estimatedCostOverride
      originalAttributes // Preserve original attribute IDs
    );
  }

  get estimatedRows(): number {
    return this.rows.length;
  }

  override toString(): string {
    return `VALUES (${this.rows.length} rows)`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    if (this.rows.length === 0) {
      return {
        rows: [],
        numRows: 0
      };
    }

    const firstRow = this.rows[0];
    return {
      numRows: this.rows.length,
      numColumns: firstRow.length,
      columnTypes: firstRow.map(expr => formatScalarType(expr.getType())),
      rows: this.rows.map(row =>
        row.map(expr => expr.toString())
      )
    };
  }
}

/**
 * Represents a table literal (collapsed const), producing a relation from literal rows.
 */
export class TableLiteralNode extends PlanNode implements ZeroAryRelationalNode {
	override readonly nodeType = PlanNodeType.TableLiteral;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		// Each inner array is a row, consisting of literal values for each cell.
		public readonly rows: ReadonlyArray<Row> | AsyncIterable<Row>,
		// The number of rows in the literal.
		public readonly rowCount: number | undefined,
		// The relation type defining the structure and column types
		public readonly type: RelationType,
		/** Optional predefined attributes for preserving IDs during optimization */
		predefinedAttributes?: Attribute[],
	) {
		super(scope, 0.001); // Minimal cost

		this.attributesCache = new Cached(() => {
			if (predefinedAttributes) {
				return predefinedAttributes.slice();
			}
			return this.buildAttributes();
		});
	}

	private buildAttributes(): Attribute[] {
		return this.type.columns.map(column => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		}));
	}

	getType(): RelationType {
		return this.type;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly ScalarPlanNode[] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	computePhysical(): Partial<PhysicalProperties> {
		// Const-folding preserves the source's logical `type` (declared keys + isSet)
		// but drops its physical FDs. A ≤1-row literal therefore keeps the declared
		// empty key with no matching `∅ → all_cols` FD unless we re-emit it here —
		// the same independent-channel drift the leaf ≤1-row producers reconcile.
		// Detect ≤1-row via the materialized row count (mirrors `ValuesNode`).
		const colCount = this.getType().columns.length;
		if (this.rowCount !== undefined && this.rowCount <= 1) {
			const fds = addSingletonFd([], colCount);
			return { estimatedRows: this.rowCount, fds: fds.length > 0 ? fds : undefined };
		}
		return { estimatedRows: this.rowCount };
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length > 0) {
			throw new Error('TableLiteralNode does not accept children');
		}
		return this;
	}

	get estimatedRows(): number {
		return this.rowCount ?? 10;
	}

	override toString(): string {
		return `TABLE LITERAL (${this.rowCount} rows)`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const reltype = this.getType();
		return {
			numRows: this.rowCount,
			numColumns: reltype.columns.length,
			columnTypes: reltype.columns.map(col => formatScalarType(col.type)),
		};
	}
}
