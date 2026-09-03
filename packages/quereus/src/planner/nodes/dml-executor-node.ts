import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type PhysicalProperties, type ScalarPlanNode, type RowDescriptor, isRelationalNode, asScalarNodes } from './plan-node.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { ConflictResolution } from '../../common/constants.js';
import { RowOp } from '../../common/types.js';
import type { ConstraintCheck, NotNullDefaultPlan } from './constraint-check-node.js';

/**
 * Represents a planned UPSERT clause for INSERT operations.
 * This contains the pre-built plan nodes for ON CONFLICT DO UPDATE handling.
 */
export interface UpsertClausePlan {
	/** Conflict target column indices (matches PK if undefined) */
	conflictTargetIndices?: number[];
	/**
	 * Per-conflict-target-column enforcement collation NAME, index-aligned with
	 * {@link conflictTargetIndices} (an `undefined` entry means BINARY). This is the
	 * collation the targeted constraint *enforces* under — a PK column def's collation,
	 * or a UNIQUE constraint's `uniqueEnforcementCollations` (which prefers an
	 * index-derived per-column COLLATE) — not merely the column's declared collation.
	 * Resolved to comparison functions at emit time; consumed by the runtime
	 * conflict-target match so a collation-equal conflict (e.g. NOCASE case-variant)
	 * routes to the DO UPDATE / DO NOTHING arm instead of aborting. Set only when
	 * {@link conflictTargetIndices} is set.
	 */
	conflictTargetCollations?: (string | undefined)[];
	/** Action: 'nothing' skips the row, 'update' performs column updates */
	action: 'nothing' | 'update';
	/**
	 * For 'update' action: column assignments.
	 * Key is column index, value is the expression node to evaluate.
	 * Expressions can reference:
	 * - NEW.* (proposed insert values) via newRowDescriptor
	 * - unqualified column names (existing row values) via existingRowDescriptor
	 */
	assignments?: Map<number, ScalarPlanNode>;
	/**
	 * Column indices whose entry in {@link assignments} is an implicit
	 * generated-column recompute rather than a user-written SET, listed in
	 * `generatedColumnTopoOrder`. The runtime evaluates these in a SECOND pass,
	 * after the user assignments have been applied and coerced into the updated
	 * row, so a generated column derives from the post-update image (and a
	 * generated-from-generated column sees the freshly computed value).
	 *
	 * Their expressions bind bare column names to the EXISTING-row attributes —
	 * the same attributes the user assignments read — but the second pass
	 * re-binds those attribute ids to the composed row via a cloned descriptor.
	 */
	generatedAssignmentColumns?: number[];
	/** For 'update' action: optional WHERE condition plan */
	whereCondition?: ScalarPlanNode;
	/** Row descriptor for NEW.* references (proposed insert values) */
	newRowDescriptor?: RowDescriptor;
	/** Row descriptor for existing row references (conflict row) */
	existingRowDescriptor?: RowDescriptor;
}

/**
 * UPDATE-shaped row validation for an INSERT's `on conflict … do update` arm.
 *
 * The arm composes its row *inside* the executor and writes it directly, so it can
 * never reach the statement's ConstraintCheckNode (which is INSERT-shaped, and sits
 * above the executor, seeing only the proposed insert row). This carries what
 * `buildUpdateStmt` would have built for the same write: OLD = the conflicting stored
 * row, NEW = the composed row.
 *
 * One set is shared by every clause of a multi-clause statement — the checks are a
 * property of the table and the operation, not of the clause. The clause only decides
 * *which* row is composed; the row is bound at runtime.
 *
 * Set only when at least one clause takes the `update` action.
 */
export interface UpsertUpdateValidation {
	/** UPDATE-scoped CHECKs plus child-side and parent-side FK checks. */
	checks: ConstraintCheck[];
	/** Flat OLD|NEW descriptor the checks' column references bind through. */
	flatRowDescriptor: RowDescriptor;
	/** DEFAULT evaluators for NOT NULL columns — per-constraint REPLACE substitution. */
	notNullDefaults: NotNullDefaultPlan[];
}

/**
 * Executes actual database insert/update/delete operations after constraint validation.
 * This node performs the actual vtab.update operations and yields the affected rows.
 * All data transformations (defaults, conversions, etc.) happen before this node.
 */
export class DmlExecutorNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.UpdateExecutor;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
    public readonly operation: RowOp,
    public readonly onConflict?: ConflictResolution, // Used for INSERT operations (legacy OR clause)
    public readonly mutationContextValues?: Map<string, ScalarPlanNode>, // Mutation context value expressions
    public readonly contextAttributes?: Attribute[], // Mutation context attributes
    public readonly contextDescriptor?: RowDescriptor, // Mutation context row descriptor
    public readonly upsertClauses?: UpsertClausePlan[], // UPSERT clause plans for INSERT operations
    /**
     * Plan-time marker: this executor is the basis-table spine of a write *routed
     * through a lens view* (set by the view-mutation builder when the target view
     * resolves to a lens slot). The runtime **parent-side logical FK** machinery —
     * the lens cascade walker, the lens RESTRICT pre-check, and the divergent-basis-FK
     * suppression — fires ONLY when this is true, so a basis-direct write bears solely
     * its physical (basis-declared) FK semantics. This makes the runtime side
     * consistent with the plan-time lens RESTRICT collector and the logical CHECK
     * collector, which already attach at the lens boundary only. Default `false`:
     * ordinary base-table DML, a plain updatable view / MV write-through (no lens
     * slot), and the multi-source / decomposition insert fan-out (no single basis
     * spine) all leave it unset.
     */
    public readonly lensRouted: boolean = false,
    /**
     * UPDATE-shaped validation for the `on conflict … do update` arm — see
     * {@link UpsertUpdateValidation}. Set only on an INSERT whose statement has at
     * least one `update`-action clause.
     */
    public readonly upsertUpdateValidation?: UpsertUpdateValidation,
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getAttributes(): readonly Attribute[] {
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  /** Upsert-clause expressions in canonical child order: per clause, assignments then WHERE. */
  private upsertExpressions(): ScalarPlanNode[] {
    const out: ScalarPlanNode[] = [];
    for (const clause of this.upsertClauses ?? []) {
      if (clause.assignments) out.push(...clause.assignments.values());
      if (clause.whereCondition) out.push(clause.whereCondition);
    }
    return out;
  }

  /**
   * The DO UPDATE arm's validation expressions, in canonical child order: CHECK / FK
   * expressions then NOT NULL DEFAULT evaluators. They MUST be children — the FK
   * existence probes are `not exists (…)` subqueries, which do not work unoptimized.
   */
  private validationExpressions(): ScalarPlanNode[] {
    const validation = this.upsertUpdateValidation;
    if (!validation) return [];
    return [
      ...validation.checks.map(c => c.expression),
      ...validation.notNullDefaults.map(d => d.defaultNode),
    ];
  }

  getChildren(): readonly PlanNode[] {
    return [
      this.source,
      ...this.upsertExpressions(),
      ...this.validationExpressions(),
      ...(this.mutationContextValues?.values() ?? []),
    ];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const upsertExprs = this.upsertExpressions();
    const validation = this.upsertUpdateValidation;
    const checkCount = validation?.checks.length ?? 0;
    const defaultCount = validation?.notNullDefaults.length ?? 0;
    const validationCount = checkCount + defaultCount;
    const validationExprs = this.validationExpressions();
    const ctxKeys = [...(this.mutationContextValues?.keys() ?? [])];
    const ctxExprs = [...(this.mutationContextValues?.values() ?? [])];
    const expected = 1 + upsertExprs.length + validationCount + ctxKeys.length;
    if (newChildren.length !== expected) {
      throw new Error(`UpdateExecutorNode expects ${expected} children, got ${newChildren.length}`);
    }

    const validationStart = 1 + upsertExprs.length;
    const ctxStart = validationStart + validationCount;
    const [newSource] = newChildren;
    const newUpsertExprs = asScalarNodes(newChildren.slice(1, validationStart), 'DmlExecutorNode upsert');
    const newValidationExprs = asScalarNodes(newChildren.slice(validationStart, ctxStart), 'DmlExecutorNode upsert validation');
    const newCtxExprs = asScalarNodes(newChildren.slice(ctxStart), 'DmlExecutorNode context');

    // Type check
    if (!isRelationalNode(newSource)) {
      throw new Error('UpdateExecutorNode: child must be a RelationalPlanNode');
    }

    // Return same instance if nothing changed
    const upsertUnchanged = newUpsertExprs.every((e, i) => e === upsertExprs[i]);
    const validationUnchanged = newValidationExprs.every((e, i) => e === validationExprs[i]);
    const ctxUnchanged = newCtxExprs.every((e, i) => e === ctxExprs[i]);
    if (newSource === this.source && upsertUnchanged && validationUnchanged && ctxUnchanged) {
      return this;
    }

    const newValidation: UpsertUpdateValidation | undefined = validation
      ? {
          checks: validation.checks.map((check, i) => ({ ...check, expression: newValidationExprs[i] })),
          flatRowDescriptor: validation.flatRowDescriptor,
          notNullDefaults: validation.notNullDefaults.map((d, i) => ({
            ...d,
            defaultNode: newValidationExprs[checkCount + i],
          })),
        }
      : undefined;

    // Slice rewritten expressions back into their clause slots, same order as getChildren/upsertExpressions.
    let cursor = 0;
    const newUpsertClauses = this.upsertClauses?.map(clause => {
      const next: UpsertClausePlan = { ...clause };
      if (clause.assignments) {
        next.assignments = new Map(
          [...clause.assignments.keys()].map(colIndex => [colIndex, newUpsertExprs[cursor++]] as const)
        );
      }
      if (clause.whereCondition) {
        next.whereCondition = newUpsertExprs[cursor++];
      }
      return next;
    });

    const newContextValues = this.mutationContextValues
      ? new Map(ctxKeys.map((k, i) => [k, newCtxExprs[i]] as const))
      : undefined;

    // Create new instance. lensRouted and upsertUpdateValidation MUST be carried
    // forward, or the optimizer drops the lens-routed parent-side FK semantics — and
    // the DO UPDATE arm's row validation — on any node rebuild.
    return new DmlExecutorNode(
      this.scope,
      newSource,
      this.table,
      this.operation,
      this.onConflict,
      newContextValues,
      this.contextAttributes,
      this.contextDescriptor,
      newUpsertClauses,
      this.lensRouted,
      newValidation
    );
  }

  /** Upper bound: rows emitted, which is the source count minus any skipped rows. */
  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `EXECUTE ${this.operation} ${this.table.tableSchema.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      operation: this.operation,
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
    };

    if (this.onConflict) {
      props.onConflict = this.onConflict;
    }

    if (this.lensRouted) {
      props.lensRouted = true;
    }

    if (this.upsertUpdateValidation) {
      props.upsertUpdateChecks = this.upsertUpdateValidation.checks.length;
      props.upsertUpdateNotNullDefaults = this.upsertUpdateValidation.notNullDefaults.length;
    }

    if (this.upsertClauses && this.upsertClauses.length > 0) {
      props.upsertClauses = this.upsertClauses.map(clause => {
        // `assignments` also carries the implicit generated-column recomputes; report
        // the user's SET count separately so a plan golden reads the statement, not
        // the target table's generated-column count.
        const generatedCount = clause.generatedAssignmentColumns?.length ?? 0;
        return {
          action: clause.action,
          hasConflictTarget: !!clause.conflictTargetIndices,
          hasWhere: !!clause.whereCondition,
          assignmentCount: (clause.assignments?.size ?? 0) - generatedCount,
          ...(generatedCount > 0 ? { generatedAssignmentCount: generatedCount } : {}),
        };
      });
    }

    return props;
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    return {
      readonly: false, // DML executor has side effects
      // At most one output row per source row — a row the executor skipped (`insert
      // or ignore` onto an existing key, `on conflict do nothing`) yields nothing,
      // so this is an upper bound. See "Data-modifying nodes" in
      // `planner/util/row-estimates.ts`; read from the PHYSICAL child.
      estimatedRows: physicalSourceRows(childrenPhysical[0], this.source),
      idempotent: false, // DML operations are generally not idempotent
      // Non-deterministic via the side-effect axis: a write changes
      // database state, so the executor cannot be folded by determinism-
      // gated machinery (CHECK / DEFAULT / generated columns / assertions).
      deterministic: false,
    };
  }
}
