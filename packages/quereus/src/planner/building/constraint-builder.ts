import type { PlanningContext } from '../planning-context.js';
import type { TableSchema, RowConstraintSchema } from '../../schema/table.js';
import { RowOpFlag, writeRowRelationCorrelation } from '../../schema/table.js';
import type { Attribute, RowDescriptor } from '../nodes/plan-node.js';
import type { ConstraintCheck, NotNullDefaultPlan } from '../nodes/constraint-check-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { buildExpression } from './expression.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { hasRelationalDescendant } from '../analysis/scalar-subqueries.js';
import { TableReferenceNode } from '../nodes/reference.js';
import * as AST from '../../parser/ast.js';
import { validateDeterministicConstraint } from '../validation/determinism-validator.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { stripSelfQualifierInCheckExpression } from '../../schema/rename-rewriter.js';
import { buildColumnSourceResolver } from '../../schema/column-source-resolver.js';
import { cloneExpr } from '../mutation/scope-transform.js';

/**
 * Determines if a constraint should be checked for the given operation
 */
function shouldCheckConstraint(constraint: RowConstraintSchema, operation: RowOpFlag): boolean {
  // Check if the current operation is in the constraint's operations bitmask
  return (constraint.operations & operation) !== 0;
}

/**
 * Builds constraint check expressions at plan time.
 * This allows the optimizer to see and optimize constraint expressions.
 */
export function buildConstraintChecks(
  ctx: PlanningContext,
  tableSchema: TableSchema,
  operation: RowOpFlag,
  oldAttributes: Attribute[],
  newAttributes: Attribute[],
  _flatRowDescriptor: RowDescriptor,
  contextAttributes: Attribute[] = [],
  /**
   * Extra CHECK constraints to enforce alongside the table's own — already
   * resolved in this table's column space. The lens layer threads its logical
   * `enforced-row-local` checks (rewritten from logical→basis terms) through here
   * so they fire on a write through the lens (see `planner/mutation/lens-enforcement.ts`).
   */
  additionalConstraints: ReadonlyArray<RowConstraintSchema> = []
): ConstraintCheck[] {
  // Build attribute ID mappings for column registration
  const newAttrIdByCol: Record<string, number> = {};
  const oldAttrIdByCol: Record<string, number> = {};

  newAttributes.forEach((attr, columnIndex) => {
    if (columnIndex < tableSchema.columns.length) {
      const column = tableSchema.columns[columnIndex];
      newAttrIdByCol[column.name.toLowerCase()] = attr.id;
    }
  });

  oldAttributes.forEach((attr, columnIndex) => {
    if (columnIndex < tableSchema.columns.length) {
      const column = tableSchema.columns[columnIndex];
      oldAttrIdByCol[column.name.toLowerCase()] = attr.id;
    }
  });

  // Filter constraints by operation (the table's own plus any threaded extras)
  const applicableConstraints = [...tableSchema.checkConstraints, ...additionalConstraints]
    .filter(constraint => shouldCheckConstraint(constraint, operation));

  const resolveColumnInSource = buildColumnSourceResolver(ctx.schemaManager);

  // Build expression nodes for each constraint
  return applicableConstraints.map(constraint => {
    // Create scope with OLD/NEW column access for constraint evaluation
    const constraintScope = new RegisteredScope(ctx.scope);

    // Register mutation context variables FIRST (so they shadow column names if conflicts exist)
    contextAttributes.forEach((attr, contextVarIndex) => {
      if (contextVarIndex < (tableSchema.mutationContext?.length || 0)) {
        const contextVar = tableSchema.mutationContext![contextVarIndex];
        const varNameLower = contextVar.name.toLowerCase();

        // Register both unqualified and qualified names
        constraintScope.registerSymbol(varNameLower, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
        );
        constraintScope.registerSymbol(`context.${varNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
        );
      }
    });

    // The per-relation write-row correlation for THIS op's target relation — the
    // decomposition analogue of `NEW`. A lens row-local CHECK rewritten over a multi-member
    // decomposition qualifies its write-row terms with `writeRowRelationCorrelation(owning
    // member)` instead of bare `NEW`, so two members spelling their value column the same
    // name (`w_id.val` / `w_name.val`) stay distinct. Registering `<corr>.<col>` against the
    // op's OWN target relation lets a CHECK whose terms all live on this member resolve here,
    // while a sibling-member term fails to resolve (a loud `Column not found`, not a silent
    // wrong answer) — fail-safe, matching the per-op gate's relation-identity routing. The
    // synthetic `__lens_new__…` name is not a reserved keyword but is vanishingly implausible
    // as a user-written FROM alias, so it does not collide with a real source in practice;
    // additive and inert for a non-lens / single-source write (whose rewrites stay on `NEW`
    // and never reference it).
    const writeRowCorr = writeRowRelationCorrelation(tableSchema.schemaName, tableSchema.name);

    // Register column symbols (similar to current emitConstraintCheck logic)
    tableSchema.columns.forEach((tableColumn, tableColIndex) => {
      const colNameLower = tableColumn.name.toLowerCase();

      // Register NEW.col and unqualified col (defaults to NEW for INSERT/UPDATE, OLD for DELETE)
      const newAttrId = newAttrIdByCol[colNameLower];
      if (newAttrId !== undefined) {
        // Write-time CHECK comparisons must resolve the column's declared
        // collation, matching read-path queries, ALTER backfill validation,
        // and assertion enforcement (all compile plain SQL over the schema).
        const newColumnType = columnSchemaToScalarType(tableColumn);

        // NEW.column
        constraintScope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttrId, tableColIndex));

        // Relation-qualified write-row correlation (lens decomposition rewrite) — the
        // `<corr>.<col>` analogue of `new.<col>` for this member relation.
        constraintScope.registerSymbol(`${writeRowCorr}.${colNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttrId, tableColIndex));

        // For INSERT/UPDATE, unqualified column defaults to NEW
        if (operation === RowOpFlag.INSERT || operation === RowOpFlag.UPDATE) {
          constraintScope.registerSymbol(colNameLower, (exp, s) =>
            new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttrId, tableColIndex));
        }
      }

      // Register OLD.col
      const oldAttrId = oldAttrIdByCol[colNameLower];
      if (oldAttrId !== undefined) {
        // OLD values can be NULL (especially for INSERT)
        const oldColumnType = columnSchemaToScalarType(tableColumn, { nullable: true });

        // OLD.column
        constraintScope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttrId, tableColIndex));

        // For DELETE, unqualified column defaults to OLD
        if (operation === RowOpFlag.DELETE) {
          constraintScope.registerSymbol(colNameLower, (exp, s) =>
            new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttrId, tableColIndex));
        }
      }
    });

    // Build the constraint expression using the specialized scope
    // Temporarily set the current schema to match the table's schema
    // This ensures unqualified table references in CHECK constraints resolve correctly
    const originalCurrentSchema = ctx.schemaManager.getCurrentSchemaName();
    const needsSchemaSwitch = tableSchema.schemaName !== originalCurrentSchema;

    if (needsSchemaSwitch) {
      ctx.schemaManager.setCurrentSchema(tableSchema.schemaName);
    }

    try {
      // The search path is already narrowed to the table's own schema by
      // `schemaAuthoredContext` (building/schema-authored-context.ts) — the ONE place that
      // decides it for every schema-authored expression kind. Every caller reaches here
      // through a context derived from it (`core/derived-row-validator.ts` included), so
      // do not re-narrow: a second copy is how the CHECK and the column DEFAULT on one
      // table drifted apart in the first place.
      const constraintCtx = { ...ctx, scope: constraintScope };

      // Fold table-qualified self-references (`check (t.qty > 0)`) to the bare
      // column form the row-context scope registers. Done as an AST rewrite on a
      // clone (never the stored constraint) rather than by seeding `<table>.<col>`
      // scope keys: this scope is an ancestor of every subquery planned inside
      // the CHECK, and qualified keys would shadow inner relations through join
      // peers' parent-chain fallback.
      let constraintExpr = constraint.expr;
      const stripped = cloneExpr(constraint.expr);
      if (stripSelfQualifierInCheckExpression(stripped, tableSchema.name, tableSchema.schemaName, resolveColumnInSource)) {
        constraintExpr = stripped;
      }

      const expression = buildExpression(
        constraintCtx,
        constraintExpr
      ) as ScalarPlanNode;

      // Validate that the constraint expression is deterministic — skip when
      // `nondeterministic_schema` is on; per-row resolution + replay-at-module
      // boundary keeps the capture safe even with non-det inside CHECKs.
      const constraintName = constraint.name ?? `_check_${tableSchema.name}`;
      if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
        validateDeterministicConstraint(expression, constraintName, tableSchema.name);
      }

      // Auto-defer when the expression reads a relation — a subquery of any shape
      // means the check cannot be decided from the mutating row alone — or when it
      // references committed.* state (which necessarily implies a subquery, but
      // this defensive check ensures committed-ref constraints are always deferred
      // even if subquery detection logic changes).
      const needsDeferred = hasRelationalDescendant(expression) || containsCommittedRef(expression);

      return {
        constraint,
        expression,
        deferrable: needsDeferred,
        initiallyDeferred: needsDeferred,
        needsDeferred,
        kind: 'check'
      } satisfies ConstraintCheck;
    } finally {
      // Restore original schema context
      if (needsSchemaSwitch) {
        ctx.schemaManager.setCurrentSchema(originalCurrentSchema);
      }
    }
  });
}

/**
 * Pre-builds DEFAULT-value evaluators for every NOT NULL column that has a
 * DEFAULT clause. The returned plans are consumed by the constraint-check
 * runtime when REPLACE substitutes a default for an explicitly-NULL value
 * (per SQLite OR REPLACE semantics on NOT NULL).
 *
 * Defaults are evaluated against the same scope used for CHECK constraints:
 * every column resolves as `new.<col>` (and unqualified, unless shadowed by a
 * mutation-context variable), so a NOT NULL default may read a sibling via
 * `new.<column>` just like the row-expansion path. Note the timing difference:
 * this substitution fires when REPLACE swaps in a default for an explicit NULL,
 * by which point the row is fully materialised — so `new.<col>` here sees the
 * final row value of *any* column, whereas the row-expansion path exposes only
 * the columns the INSERT actually supplied (omitted siblings are unresolved
 * there to avoid a default-evaluation-order race).
 *
 * Error attribution for a NOT NULL violation is NOT decided here: it happens at
 * check time in `checkNotNullConstraints` by column index (the first NOT-NULL
 * column with a NULL effective value), so don't look for it in this builder.
 */
export function buildNotNullDefaults(
  ctx: PlanningContext,
  tableSchema: TableSchema,
  newAttributes: Attribute[],
  contextAttributes: Attribute[] = [],
  /**
   * Parent scope for `new.<col>` resolution, threaded by a synthetic decomposition /
   * multi-source member insert (see {@link buildInsertStmt}'s `defaultRowContextScope`).
   * It exposes the **produced logical row's** supplied columns as `new.<col>`, so a NOT
   * NULL column's default can correlate on a sibling logical column the member's own base
   * table does not carry (e.g. an anchor key-column default
   * `default (select … where parent.key = new.<fk>)`). The member's own NEW columns are
   * registered below and shadow it. `undefined` (⇒ `ctx.scope`) for an ordinary insert.
   */
  defaultRowContextScope?: Scope,
): NotNullDefaultPlan[] {
  const result: NotNullDefaultPlan[] = [];

  for (let columnIndex = 0; columnIndex < tableSchema.columns.length; columnIndex++) {
    const column = tableSchema.columns[columnIndex];
    if (!column.notNull) continue;
    const defaultExpr = column.defaultValue;
    if (!defaultExpr || typeof defaultExpr !== 'object' || !('type' in defaultExpr)) continue;

    const scope = new RegisteredScope(defaultRowContextScope ?? ctx.scope);
    const reservedKeys = new Set<string>();

    // Mutation context variables first so they shadow column names if conflicts exist
    // (matches createRowExpansionProjection's resolution order).
    contextAttributes.forEach((attr, contextVarIndex) => {
      if (contextVarIndex < (tableSchema.mutationContext?.length || 0)) {
        const contextVar = tableSchema.mutationContext![contextVarIndex];
        const varNameLower = contextVar.name.toLowerCase();
        scope.registerSymbol(varNameLower, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
        );
        scope.registerSymbol(`context.${varNameLower}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
        );
        reservedKeys.add(varNameLower);
        reservedKeys.add(`context.${varNameLower}`);
      }
    });

    // Register NEW columns (DEFAULT can reference siblings as in row-expansion).
    // Skip the unqualified form when shadowed by a mutation context variable; the
    // qualified `new.<col>` form remains available.
    tableSchema.columns.forEach((col, idx) => {
      const attr = newAttributes[idx];
      if (!attr) return;
      const colType = columnSchemaToScalarType(col);
      const colKey = col.name.toLowerCase();
      if (!reservedKeys.has(colKey)) {
        scope.registerSymbol(colKey, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, colType, attr.id, idx)
        );
      }
      scope.registerSymbol(`new.${colKey}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, colType, attr.id, idx)
      );
    });

    const planningCtx = { ...ctx, scope };
    const defaultNode = buildExpression(planningCtx, defaultExpr as AST.Expression) as ScalarPlanNode;
    result.push({ columnIndex, defaultExpr: defaultExpr as AST.Expression, defaultNode });
  }

  return result;
}

/**
 * Walks the full expression tree (descending into subquery plan children)
 * to find any TableReferenceNode with readCommitted === true.
 * This is a defensive check: committed.* refs necessarily contain subqueries,
 * but this ensures they are always deferred even if subquery detection changes.
 */
function containsCommittedRef(expr: ScalarPlanNode): boolean {
  const stack: PlanNode[] = [expr];
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof TableReferenceNode && n.readCommitted) {
      return true;
    }
    for (const c of n.getChildren()) {
      stack.push(c);
    }
  }
  return false;
}
