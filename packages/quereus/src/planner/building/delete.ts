import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DeleteNode } from '../nodes/delete-node.js';
import { buildTableReference } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { RegisteredScope } from '../scopes/registered.js';
import { AliasedScope } from '../scopes/aliased.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOpFlag, type RowConstraintSchema } from '../../schema/table.js';
import { ReturningNode, type ReturningProjection } from '../nodes/returning-node.js';
import { expandReturningStar } from './returning-star.js';
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import { buildConstraintChecks } from './constraint-builder.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { buildParentSideFKChecks, getBatchableRestrictFks } from './foreign-key-builder.js';
import { validateReturningQualifiers } from '../validation/returning-qualifier-validator.js';
import { isCommittedSchemaRef } from './schema-resolution.js';
import { buildViewMutation } from './view-mutation-builder.js';
import { isMaintainedTable, maintainedTableViewLike } from '../../schema/derivation.js';
import { isViewSchema } from '../../schema/view.js';
import { validateReservedTags } from '../../schema/reserved-tags.js';
import { raiseStmtTagDiagnostics } from './tag-diagnostics.js';
import { buildWithContext } from './select-context.js';
import { resolveCteTarget, contextForCteTarget, resolveSubqueryTarget } from './dml-target.js';
import { schemaAuthoredContext } from './schema-authored-context.js';

export function buildDeleteStmt(
  ctx: PlanningContext,
  stmt: AST.DeleteStmt,
  /**
   * Extra row constraints to enforce alongside the table's own — already resolved
   * in the target table's column space. Set only when the view-mutation substrate
   * re-plans a lens write onto its basis table: the lens **parent-side** FK
   * `NOT EXISTS` checks (the cross-slot dual of the child-side FK) ride this seam so
   * a delete through a logical parent enforces the RESTRICT existence check against
   * the logical child (see `planner/mutation/lens-enforcement.ts`).
   */
  additionalConstraints: ReadonlyArray<RowConstraintSchema> = [],
  /**
   * Whether this delete is the basis-table spine of a write routed through a lens
   * view (the view-mutation builder sets it when the target view resolves to a lens
   * slot). Threaded onto the {@link DmlExecutorNode} so the runtime parent-side
   * **logical** FK machinery fires only for lens-routed writes — see that node's
   * `lensRouted` field. Default `false` for ordinary base-table deletes.
   */
  lensRouted = false,
): PlanNode {
  // Statement-level WITH TAGS validates at the dml-stmt site on every authoring
  // path — base table, view/MV-mediated, nested DML (see buildInsertStmt).
  raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'dml-stmt'), stmt);

  // Block DML on committed pseudo-schema
  if (isCommittedSchemaRef(stmt.table.schema)) {
    throw new QuereusError(`Cannot modify committed-state table 'committed.${stmt.table.name}'`, StatusCode.ERROR);
  }

  // Apply schema path from statement if present
  const contextWithSchemaPath = stmt.schemaPath
    ? { ...ctx, schemaPath: stmt.schemaPath }
    : ctx;

  // Thread the statement's own leading WITH clause into scope. DELETE previously
  // ignored `stmt.withClause` entirely, so even a CTE *read* in a WHERE subquery did
  // not resolve; building it here closes that read gap AND makes a CTE-name DML target
  // resolvable. A WITH-less delete with no parent CTEs gets the context back unchanged.
  const { contextWithCTEs } = buildWithContext(contextWithSchemaPath, stmt);

  // Inline subquery target: `delete from (select …) as v where …` routes the subquery
  // body through the same ephemeral view-like substrate (the dual of the CTE-name
  // target). Resolved BEFORE the CTE / schema dispatch — the synthetic `table.name` (=
  // the user alias) must not be re-resolved as a same-named CTE / schema object. The
  // statement's CTEs stay in scope (no own-name to shadow out). See
  // docs/vu-operators.md § Common Table Expressions.
  const subqueryTarget = resolveSubqueryTarget(contextWithCTEs, stmt);
  if (subqueryTarget) {
    return buildViewMutation(contextWithCTEs, subqueryTarget, { op: 'delete', stmt });
  }

  // CTE-name target: `with t as (…) delete from t …` writes through the CTE body via
  // the ephemeral view-like substrate, SHADOWING any same-named schema table/view/MV
  // (matching read-side FROM shadowing). Resolved ahead of the schema dispatch; a
  // recursive target is rejected here with the structured `recursive-cte` reason.
  // See docs/vu-operators.md § Common Table Expressions.
  const cteTarget = resolveCteTarget(contextWithCTEs, stmt.table, stmt.withClause);
  if (cteTarget) {
    return buildViewMutation(contextForCteTarget(contextWithCTEs, stmt.withClause!, cteTarget.name), cteTarget, { op: 'delete', stmt });
  }

  // View- or materialized-view-mediated delete: rewrite to target the underlying
  // base table and re-plan. An MV is a single-source projection-and-filter, so the
  // same rewrite routes write-through to its source `T`; the row-time maintenance
  // hook then syncs the backing. See docs/materialized-views.md § Write boundary.
  // Dispatch order is load-bearing: a maintained table (derivation-bearing)
  // must hit the view-mutation rewrite, never the direct table write.
  // An unqualified target resolves through the schema search path, exactly as an
  // unqualified read does (see `SchemaManager.findSchemaItem`).
  const deleteTarget = ctx.schemaManager.findSchemaItem(stmt.table.name, stmt.table.schema, contextWithSchemaPath.schemaPath);
  const deleteView = isViewSchema(deleteTarget) ? deleteTarget
    : (isMaintainedTable(deleteTarget) ? maintainedTableViewLike(deleteTarget) : undefined);
  if (deleteView) {
    // Route through the view-mutation substrate (single-source = one base op).
    return buildViewMutation(contextWithCTEs, deleteView, { op: 'delete', stmt });
  }

  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, contextWithCTEs);
  const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  // Backstop on the RESOLVED table: the dispatch above and buildTableReference
  // walk the same path today, so this should be unreachable — but they are two
  // resolvers, and a direct write to a maintained table would corrupt derived
  // contents. Keep the belt: route any that slips through to the same rewrite.
  const deleteResolved = tableReference.tableSchema;
  if (isMaintainedTable(deleteResolved)) {
    return buildViewMutation(contextWithCTEs, maintainedTableViewLike(deleteResolved), { op: 'delete', stmt });
  }

  // Process mutation context assignments if present
  const mutationContextValues = new Map<string, ScalarPlanNode>();
  const contextAttributes: Attribute[] = [];

  if (stmt.contextValues && tableReference.tableSchema.mutationContext) {
    // Create context attributes
    tableReference.tableSchema.mutationContext.forEach((contextVar) => {
      contextAttributes.push({
        id: PlanNode.nextAttrId(),
        name: contextVar.name,
        type: {
          typeClass: 'scalar' as const,
          logicalType: contextVar.logicalType,
          nullable: !contextVar.notNull,
          isReadOnly: true
        },
        sourceRelation: `context.${tableReference.tableSchema.name}`
      });
    });

    // Build context value expressions (evaluated in the base scope, before table scope)
    stmt.contextValues.forEach((assignment) => {
      const valueExpr = buildExpression(contextWithCTEs, assignment.value) as ScalarPlanNode;
      mutationContextValues.set(assignment.name, valueExpr);
    });
  }

  // Plan the source of rows to delete. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = tableRetrieve; // Use the RetrieveNode as source

  // Create a new scope with the table columns registered for column resolution.
  // Wrap with AliasedScope so correlated subqueries inside WHERE / RETURNING
  // can reference the outer DML target via qualified `table.column` form. Parent on
  // the CTE-aware scope so a CTE-qualified column reference correlates too.
  const tableColumnScope = new RegisteredScope(contextWithCTEs.scope);
  const sourceAttributes = sourceNode.getAttributes();
  sourceNode.getType().columns.forEach((c, i) => {
    const attr = sourceAttributes[i];
    tableColumnScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
      new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
  });
  const tableName = tableReference.tableSchema.name.toLowerCase();
  // The view-mutation single-source lowering may carry a synthesised collision-proof
  // correlation name on the target (`stmt.alias`), so a substituted subquery-descent
  // base term qualified with it binds the outer target row even when the user subquery
  // FROM names the same base table. Ordinary DELETE never sets `stmt.alias`, so the
  // correlation name is the table name and the AliasedScope behaves identically.
  const correlationName = stmt.alias?.toLowerCase() ?? tableName;
  const tableScope = new AliasedScope(tableColumnScope, tableName, correlationName);

  // Create a new planning context with the updated scope for WHERE clause resolution.
  // Built off the CTE-aware context so `stmt.cteNodes` thread into the WHERE subquery
  // builds — a CTE read there now resolves (closes the prior read gap).
  const deleteCtx = { ...contextWithCTEs, scope: tableScope };

  // Contexts for the table's OWN schema-authored SQL (`check on delete` constraints,
  // parent-side FK probes). Derived once here rather than per call site; both clear the
  // CTE namespace so none of that SQL can bind this statement's common table
  // expressions — its own leading `with` clause or ones it inherited from an enclosing
  // statement. `schemaAuthoredDeleteCtx` keeps the table scope so `old.` still resolves;
  // `schemaAuthoredCtx` matches the bare `ctx` the FK builder already took (it narrows
  // the schema path itself).
  const schemaAuthoredDeleteCtx = schemaAuthoredContext(deleteCtx);
  const schemaAuthoredCtx = schemaAuthoredContext(ctx);

  if (stmt.where) {
    const filterExpression = buildExpression(deleteCtx, stmt.where);
    sourceNode = new FilterNode(deleteCtx.scope, sourceNode, filterExpression);
  }

  // Create OLD/NEW attributes for DELETE (OLD = actual values being deleted, NEW = all NULL)
  const oldAttributes = tableReference.tableSchema.columns.map((col) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: columnSchemaToScalarType(col),
    sourceRelation: `OLD.${tableReference.tableSchema.name}`
  }));

  const newAttributes = tableReference.tableSchema.columns.map((col) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    // NEW values are always NULL for DELETE
    type: columnSchemaToScalarType(col, { nullable: true }),
    sourceRelation: `NEW.${tableReference.tableSchema.name}`
  }));

  const { oldRowDescriptor, newRowDescriptor, flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

  // Build context descriptor if we have context attributes
  const contextDescriptor: RowDescriptor | undefined = contextAttributes.length > 0 ? [] : undefined;
  if (contextDescriptor) {
    contextAttributes.forEach((attr, index) => {
      contextDescriptor[attr.id] = index;
    });
  }

  // Build constraint checks at plan time
  const constraintChecks = buildConstraintChecks(
    schemaAuthoredDeleteCtx,
    tableReference.tableSchema,
    RowOpFlag.DELETE,
    oldAttributes,
    newAttributes,
    flatRowDescriptor,
    contextAttributes,
    additionalConstraints
  );

  // Build parent-side FK constraint checks if foreign_keys pragma is enabled.
  // Skipped entirely when the batchability gate admits the statement — the
  // runtime DML executor then enforces every inbound RESTRICT FK with ONE
  // chunked probe per FK at the end-of-statement boundary instead of one
  // correlated NOT EXISTS per row (see getBatchableRestrictFks). DELETE has no
  // statement-level OR clause, so the effective conflict resolution is the
  // ABORT default (matching the `undefined` onConflict on the DmlExecutorNode).
  if (ctx.db.options.getBooleanOption('foreign_keys')
    && getBatchableRestrictFks(ctx.schemaManager, tableReference.tableSchema, 'delete', undefined, lensRouted) === undefined) {
    const parentFKChecks = buildParentSideFKChecks(
      schemaAuthoredCtx, tableReference.tableSchema, RowOpFlag.DELETE,
      oldAttributes, newAttributes, contextAttributes
    );
    constraintChecks.push(...parentFKChecks);
  }

  // Mirror INSERT/UPDATE wiring: the DML prep node (DeleteNode) expands the
  // source row to the flat 2N OLD/NEW layout BEFORE ConstraintCheckNode runs,
  // so deferred CHECK constraints that reference NEW columns find them at the
  // expected flat indices (n..2n-1) even though they hold NULL for DELETE.
  const deleteNode = new DeleteNode(
    deleteCtx.scope,
    tableReference,
    sourceNode,
    oldRowDescriptor,
    flatRowDescriptor,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  const constraintCheckNode = new ConstraintCheckNode(
    deleteCtx.scope,
    deleteNode,
    tableReference,
    RowOpFlag.DELETE,
    oldRowDescriptor,
    newRowDescriptor,
    flatRowDescriptor,
    constraintChecks,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  // Add DML executor node to perform the actual database delete operations
  const dmlExecutorNode = new DmlExecutorNode(
    deleteCtx.scope,
    constraintCheckNode,
    tableReference,
    'delete',
    undefined, // onConflict not used for DELETE
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor,
    undefined, // upsertClauses — DELETE has none
    lensRouted
  );

  const resultNode: RelationalPlanNode = dmlExecutorNode;

  if (stmt.returning && stmt.returning.length > 0) {
    // Create returning scope with OLD/NEW attribute access
    const returningScope = new RegisteredScope(deleteCtx.scope);

    // Register OLD.* symbols (actual values being deleted)
    oldAttributes.forEach((attr, columnIndex) => {
      const tableColumn = tableReference.tableSchema.columns[columnIndex];
      returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
      );
    });

    // Register NEW.* symbols (always NULL for DELETE) and unqualified column names (default to OLD for DELETE)
    newAttributes.forEach((attr, columnIndex) => {
      const tableColumn = tableReference.tableSchema.columns[columnIndex];

      // NEW.column (always NULL for DELETE)
      returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
      );

      // Unqualified column (defaults to OLD for DELETE)
      const oldAttr = oldAttributes[columnIndex];
      returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
      );

      // Table-qualified form (table.column -> OLD for DELETE)
      const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
      returningScope.registerSymbol(tblQualified, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
      );

      // Correlation-name-qualified form (`<alias>.column` — the view-mutation SELF_ALIAS
      // `__vm_self.column`, or a user-written `delete from t as x`), defaulting to OLD
      // like the table-qualified form. A RETURNING subquery correlating to the outer
      // deleted row through that alias must bind the STABLE OLD attribute (live throughout
      // RETURNING projection) rather than falling through to the target scan's transient
      // row context, which an eager mutation executor (e.g. the store backend) tears down
      // before the subquery projects. Only added when the correlation name differs from
      // the table name; otherwise the table-qualified registration above covers it.
      if (correlationName !== tableName) {
        returningScope.registerSymbol(`${correlationName}.${tableColumn.name.toLowerCase()}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
        );
      }
    });

    // Build RETURNING projections in the OLD/NEW context. A `*` / `t.*` expands
    // in place; the unqualified symbols bind OLD for DELETE, so the star yields
    // the pre-deletion image.
    const returningProjections: ReturningProjection[] = [];
    for (const rc of stmt.returning) {
      if (rc.type === 'all') {
        returningProjections.push(...expandReturningStar(
          deleteCtx, rc, returningScope, tableReference.tableSchema, stmt.alias));
        continue;
      }

      // Validate qualifier usage on the AST before column resolution so the
      // NEW-in-DELETE guard fires before any "column not found" error.
      validateReturningQualifiers(rc.expr, 'DELETE');

      // Infer alias from column name if not explicitly provided.
      // Preserve the spelling the user wrote so quoted identifiers like
      // [Name] / "Name" round-trip to the result column name unchanged.
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        alias = rc.expr.table
          ? `${rc.expr.table}.${rc.expr.name}`
          : rc.expr.name;
      }

      returningProjections.push({
        node: buildExpression({ ...deleteCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias
      });
    }

    return new ReturningNode(deleteCtx.scope, dmlExecutorNode, returningProjections);
  }

	return new SinkNode(deleteCtx.scope, resultNode, 'delete');
}
