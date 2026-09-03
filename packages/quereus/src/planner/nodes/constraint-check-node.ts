import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor, type ScalarPlanNode, isRelationalNode, asScalarNodes } from './plan-node.js';
import type { PhysicalProperties } from './plan-node.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { RowOpFlag } from '../../schema/table.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import type { ConflictResolution } from '../../common/constants.js';
import type { Expression } from '../../parser/ast.js';

export interface ConstraintCheck {
  constraint: RowConstraintSchema;  // The constraint metadata
  expression: ScalarPlanNode;       // Pre-built expression node
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  needsDeferred: boolean;            // Whether this constraint must be deferred (subquery, committed ref, etc.)
  /** Constraint class for conflict-resolution dispatch at runtime. */
  kind?: 'check' | 'fk-child' | 'fk-parent';
  /** For 'fk-parent' UPDATE checks: parent-table column indices the FK references.
   *  When set, the runtime can skip the check when none of these indices changed. */
  referencedColumnIndices?: ReadonlyArray<number>;
  /**
   * Verbatim violation text for a SYNTHESIZED check whose expression would
   * otherwise be reported as-is and mean nothing to the user (nobody wrote it).
   * When set, `runtime/row-constraints.ts` reports this instead of deriving
   * `CHECK constraint failed: <name> (<expr>)` — on both the immediate and the
   * deferred (commit-time) path. Unset for user-written CHECKs, which keep the
   * derived message.
   */
  violationMessage?: string;
  /**
   * Mirrors {@link RowConstraintSchema.messageValued}: the expression evaluates
   * to NULL when satisfied and to the violation-message text when violated, so
   * the runtime inverts its pass test (failure iff non-NULL) and reports the
   * evaluated value itself — on both the immediate and the deferred path.
   */
  messageValued?: boolean;
}

/**
 * Pre-built default-value evaluator for a NOT NULL column with a DEFAULT clause.
 * Used by REPLACE-on-NOT-NULL substitution to fill the NEW slot when the user
 * supplied NULL for a NOT NULL column.
 */
export interface NotNullDefaultPlan {
  /** Index of the column in the table schema. */
  columnIndex: number;
  /** AST default expression (used as a fallback if the planned node is missing). */
  defaultExpr: Expression;
  /** Pre-built scalar node that evaluates the default in the current row context. */
  defaultNode: ScalarPlanNode;
}

/**
 * Represents constraint checking for DML operations.
 * This node validates constraints against rows flowing through it.
 */
export class ConstraintCheckNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.ConstraintCheck;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
    public readonly operation: RowOpFlag,
    public readonly oldRowDescriptor: RowDescriptor | undefined,
    public readonly newRowDescriptor: RowDescriptor | undefined,
    public readonly flatRowDescriptor: RowDescriptor,
    public readonly constraintChecks: ConstraintCheck[],
    public readonly mutationContextValues?: Map<string, ScalarPlanNode>, // Mutation context value expressions
    public readonly contextAttributes?: Attribute[], // Mutation context attributes
    public readonly contextDescriptor?: RowDescriptor, // Mutation context row descriptor
    public readonly onConflict?: ConflictResolution, // Statement-level OR clause; resolves IGNORE/REPLACE/FAIL/ROLLBACK
    public readonly notNullDefaults?: ReadonlyArray<NotNullDefaultPlan>, // Pre-built DEFAULT evaluators for NOT NULL columns (used by REPLACE substitution)
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getAttributes(): readonly Attribute[] {
    // ConstraintCheck passes through the same attributes as its source
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    const children: PlanNode[] = [this.source];
    // Add all constraint expression nodes as children so optimizer can see them
    this.constraintChecks.forEach(check => {
      children.push(check.expression);
    });
    // Add NOT NULL DEFAULT evaluators so they participate in optimization too.
    if (this.notNullDefaults) {
      this.notNullDefaults.forEach(d => children.push(d.defaultNode));
    }
    // Add mutation context value expressions so the optimizer can rewrite them too.
    if (this.mutationContextValues) {
      children.push(...this.mutationContextValues.values());
    }
    return children;
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const constraintCount = this.constraintChecks.length;
    const defaultCount = this.notNullDefaults?.length ?? 0;
    const ctxKeys = [...(this.mutationContextValues?.keys() ?? [])];
    const expectedChildren = 1 + constraintCount + defaultCount + ctxKeys.length;
    if (newChildren.length !== expectedChildren) {
      throw new Error(`ConstraintCheckNode expects ${expectedChildren} children, got ${newChildren.length}`);
    }

    const newSource = newChildren[0];
    const newConstraintExprs = asScalarNodes(newChildren.slice(1, 1 + constraintCount), 'ConstraintCheckNode constraint');
    const newDefaultExprs = asScalarNodes(newChildren.slice(1 + constraintCount, 1 + constraintCount + defaultCount), 'ConstraintCheckNode default');
    const newCtxExprs = asScalarNodes(newChildren.slice(1 + constraintCount + defaultCount), 'ConstraintCheckNode context');

    // Type check the source
    if (!isRelationalNode(newSource)) {
      throw new Error('ConstraintCheckNode: first child must be a RelationalPlanNode');
    }

    // Return same instance if nothing changed
    const ctxExprs = [...(this.mutationContextValues?.values() ?? [])];
    const constraintsUnchanged = newConstraintExprs.every((expr, i) => expr === this.constraintChecks[i].expression);
    const defaultsUnchanged = !this.notNullDefaults
      || newDefaultExprs.every((expr, i) => expr === this.notNullDefaults![i].defaultNode);
    const ctxUnchanged = newCtxExprs.every((e, i) => e === ctxExprs[i]);
    if (newSource === this.source && constraintsUnchanged && defaultsUnchanged && ctxUnchanged) {
      return this;
    }

    // Rebuild constraint checks with new expressions
    const newConstraintChecks = this.constraintChecks.map((check, i) => ({
      ...check,
      expression: newConstraintExprs[i]
    }));

    const newNotNullDefaults = this.notNullDefaults
      ? this.notNullDefaults.map((d, i) => ({
          ...d,
          defaultNode: newDefaultExprs[i],
        }))
      : undefined;

    const newContextValues = this.mutationContextValues
      ? new Map(ctxKeys.map((k, i) => [k, newCtxExprs[i]] as const))
      : undefined;

    // Create new instance
    return new ConstraintCheckNode(
      this.scope,
      newSource as RelationalPlanNode,
      this.table,
      this.operation,
      this.oldRowDescriptor,
      this.newRowDescriptor,
      this.flatRowDescriptor,
      newConstraintChecks,
      newContextValues,
      this.contextAttributes,
      this.contextDescriptor,
      this.onConflict,
      newNotNullDefaults
    );
  }

  /**
   * Upper bound: the emitter yields at most one row per source row. It normally
   * yields exactly one (or throws), but a violation whose conflict action is
   * IGNORE makes `evaluateRowConstraints` return `{ skip: true }` and the row is
   * dropped. Rows EMITTED, per "Data-modifying nodes" in
   * `planner/util/row-estimates.ts`.
   */
  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    // Without this stamp the write family's relay stops here: the prep node below
    // has a real count, and the executor above reads `undefined` through this node.
    return { estimatedRows: physicalSourceRows(childrenPhysical[0], this.source) };
  }

  override toString(): string {
    const opName = this.operation === 1 ? 'INSERT' :
                   this.operation === 2 ? 'UPDATE' :
                   this.operation === 4 ? 'DELETE' : 'UNKNOWN';
    const constraintCount = this.constraintChecks.length;
    return `CHECK ${constraintCount} CONSTRAINTS ON ${opName}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const opName = this.operation === 1 ? 'INSERT' :
                   this.operation === 2 ? 'UPDATE' :
                   this.operation === 4 ? 'DELETE' : 'UNKNOWN';

    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      operation: opName,
      constraintCount: this.constraintChecks.length,
      constraintNames: this.constraintChecks.map(c => c.constraint.name || '_unnamed'),
      hasOldDescriptor: !!this.oldRowDescriptor,
      hasNewDescriptor: !!this.newRowDescriptor,
      onConflict: this.onConflict,
      notNullDefaults: this.notNullDefaults?.length ?? 0,
    };
  }
}
