import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { UpdateNode, type UpdateAssignment } from '../nodes/update-node.js';
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import { buildTableReference } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type RowDescriptor } from '../nodes/plan-node.js';
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
import { buildConstraintChecks, buildNotNullDefaults } from './constraint-builder.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { buildChildSideFKChecks, buildParentSideFKChecks, getBatchableRestrictFks } from './foreign-key-builder.js';
import { isCommittedSchemaRef } from './schema-resolution.js';
import { validateDeterministicGenerated } from '../validation/determinism-validator.js';
import { buildViewMutation } from './view-mutation-builder.js';
import { isMaintainedTable, maintainedTableViewLike } from '../../schema/derivation.js';
import { isViewSchema } from '../../schema/view.js';
import { validateReservedTags } from '../../schema/reserved-tags.js';
import { raiseStmtTagDiagnostics } from './tag-diagnostics.js';
import { buildWithContext } from './select-context.js';
import { resolveCteTarget, contextForCteTarget, resolveSubqueryTarget } from './dml-target.js';
import { schemaAuthoredContext } from './schema-authored-context.js';
import { buildMutationContextAttributes, buildMutationContextValues } from './mutation-context.js';

export function buildUpdateStmt(
  ctx: PlanningContext,
  stmt: AST.UpdateStmt,
  /**
   * Extra row-local CHECK constraints to enforce, already resolved in the target
   * table's column space — set only when the view-mutation substrate re-plans a
   * lens write onto its basis table (the logical `enforced-row-local` obligations
   * rewritten to basis terms; see `planner/mutation/lens-enforcement.ts`). Empty
   * for ordinary updates.
   */
  extraConstraints: ReadonlyArray<RowConstraintSchema> = [],
  /**
   * Whether this update is the basis-table spine of a write routed through a lens
   * view (the view-mutation builder sets it when the target view resolves to a lens
   * slot). Threaded onto the {@link DmlExecutorNode} so the runtime parent-side
   * **logical** FK machinery fires only for lens-routed writes — see that node's
   * `lensRouted` field. Default `false` for ordinary base-table updates.
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

  // Thread the statement's own leading WITH clause into scope. UPDATE previously
  // ignored `stmt.withClause` entirely, so even a CTE *read* in a WHERE/SET subquery
  // did not resolve; building it here closes that read gap AND makes a CTE-name DML
  // target resolvable. A WITH-less update with no parent CTEs gets the context back
  // unchanged (no overhead).
  const { contextWithCTEs } = buildWithContext(contextWithSchemaPath, stmt);

  // Inline subquery target: `update (select …) as v set …` routes the subquery body
  // through the same ephemeral view-like substrate (the dual of the CTE-name target).
  // Resolved BEFORE the CTE / schema dispatch — the synthetic `table.name` (= the user
  // alias) must not be re-resolved as a same-named CTE / schema object. The statement's
  // CTEs stay in scope (no own-name to shadow out), so a sibling-CTE read in the body
  // resolves. See docs/vu-operators.md § Common Table Expressions.
  const subqueryTarget = resolveSubqueryTarget(contextWithCTEs, stmt);
  if (subqueryTarget) {
    return buildViewMutation(contextWithCTEs, subqueryTarget, { op: 'update', stmt });
  }

  // CTE-name target: `with t as (…) update t …` writes through the CTE body via the
  // ephemeral view-like substrate, SHADOWING any same-named schema table/view/MV
  // (matching read-side FROM shadowing). Resolved ahead of the schema dispatch; a
  // recursive target is rejected here with the structured `recursive-cte` reason.
  // See docs/vu-operators.md § Common Table Expressions.
  const cteTarget = resolveCteTarget(contextWithCTEs, stmt.table, stmt.withClause);
  if (cteTarget) {
    return buildViewMutation(contextForCteTarget(contextWithCTEs, stmt.withClause!, cteTarget.name), cteTarget, { op: 'update', stmt });
  }

  // View- or materialized-view-mediated update: rewrite to target the underlying
  // base table and re-plan. An MV is a single-source projection-and-filter, so the
  // same rewrite routes write-through to its source `T`; the row-time maintenance
  // hook then syncs the backing. See docs/materialized-views.md § Write boundary.
  // Dispatch order is load-bearing: a maintained table (derivation-bearing)
  // must hit the view-mutation rewrite, never the direct table write.
  // An unqualified target resolves through the schema search path, exactly as an
  // unqualified read does (see `SchemaManager.findSchemaItem`).
  const updateTarget = ctx.schemaManager.findSchemaItem(stmt.table.name, stmt.table.schema, contextWithSchemaPath.schemaPath);
  const updateView = isViewSchema(updateTarget) ? updateTarget
    : (isMaintainedTable(updateTarget) ? maintainedTableViewLike(updateTarget) : undefined);
  if (updateView) {
    // Route through the view-mutation substrate (single-source = one base op).
    return buildViewMutation(contextWithCTEs, updateView, { op: 'update', stmt });
  }

  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, contextWithCTEs);
	const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  // Backstop on the RESOLVED table: the dispatch above and buildTableReference
  // walk the same path today, so this should be unreachable — but they are two
  // resolvers, and a direct write to a maintained table would corrupt derived
  // contents. Keep the belt: route any that slips through to the same rewrite.
  const updateResolved = tableReference.tableSchema;
  if (isMaintainedTable(updateResolved)) {
    return buildViewMutation(contextWithCTEs, maintainedTableViewLike(updateResolved), { op: 'update', stmt });
  }

  // Mutation context is driven by the TABLE's declaration, not by the statement — see
  // building/mutation-context.ts. Values are evaluated in the base scope, before the
  // table scope; a declared variable the statement omitted gets a NULL literal, and a
  // NOT NULL one fails at reference time from any default or CHECK that reads it.
  const contextAttributes = buildMutationContextAttributes(tableReference.tableSchema, stmt.contextValues);
  const mutationContextValues = buildMutationContextValues(contextWithCTEs, contextAttributes, stmt.contextValues);

  // Plan the source of rows to update. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = buildTableReference({ type: 'table', table: stmt.table }, contextWithCTEs);

  // Create a new scope with the table columns registered for column resolution.
  // Wrap with AliasedScope so correlated subqueries inside SET / WHERE / RETURNING
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
  // FROM names the same base table. Ordinary UPDATE never sets `stmt.alias`, so the
  // correlation name is the table name and the AliasedScope behaves identically.
  const correlationName = stmt.alias?.toLowerCase() ?? tableName;
  const tableScope = new AliasedScope(tableColumnScope, tableName, correlationName);

  // Create a new planning context with the updated scope for WHERE clause resolution.
  // Built off the CTE-aware context so `stmt.cteNodes` thread into the SET / WHERE
  // subquery builds — a CTE read in either now resolves (closes the prior read gap).
  const updateCtx = { ...contextWithCTEs, scope: tableScope };

  // Contexts for the table's OWN schema-authored SQL (generated-column recompute,
  // CHECK constraints, NOT NULL defaults, FK probes). Derived once here rather than
  // per call site; both clear the CTE namespace so none of that SQL can bind this
  // statement's common table expressions — its own leading `with` clause or ones it
  // inherited from an enclosing statement — and both narrow the schema path to the
  // target's own schema. `schemaAuthoredUpdateCtx` keeps the table scope so `new.` /
  // `old.` still resolve; `schemaAuthoredCtx` matches the bare `ctx` the FK builders
  // already took.
  const targetSchemaName = tableReference.tableSchema.schemaName;
  const schemaAuthoredUpdateCtx = schemaAuthoredContext(updateCtx, targetSchemaName);
  const schemaAuthoredCtx = schemaAuthoredContext(ctx, targetSchemaName);

  // IMPORTANT: Build assignments FIRST to ensure parameter indices match SQL text order.
  // SQL: UPDATE t SET col = ?1 WHERE id = ?2
  // The SET clause parameters must be resolved before WHERE clause parameters.
  // Authoritative backstop against assigning the same base column twice in one
  // UPDATE. This is the single place that catches all paths — a direct base
  // UPDATE (`set b=1, b=2`), the single-source lowered statement, and each
  // multi-source per-member lowered statement — since every lowered view write is
  // re-planned through here. Keyed on the user SET target name, so it runs before
  // the appended generated-column assignments (a generated column can't be SET, so
  // it never collides with a user target). The view spines add a friendlier,
  // view-aware diagnostic on top of this generic backstop.
  const seenTargets = new Set<string>();
  const assignments: UpdateAssignment[] = stmt.assignments.map(assign => {
    const targetKey = assign.column.toLowerCase();
    if (seenTargets.has(targetKey)) {
      throw new QuereusError(
        `duplicate assignment to column '${assign.column}' in UPDATE on '${tableReference.tableSchema.name}'`,
        StatusCode.ERROR
      );
    }
    seenTargets.add(targetKey);
    // Reject SET on generated columns
    const colIndex = tableReference.tableSchema.columnIndexMap.get(assign.column.toLowerCase());
    if (colIndex !== undefined && tableReference.tableSchema.columns[colIndex].generated) {
      throw new QuereusError(
        `Cannot UPDATE generated column '${assign.column}'`,
        StatusCode.ERROR
      );
    }
    const targetColumn: AST.ColumnExpr = { type: 'column', name: assign.column, table: stmt.table.name, schema: stmt.table.schema };
    return {
      targetColumn, // Keep as AST for now, emitter can resolve index
      value: buildExpression(updateCtx, assign.value),
    };
  });

  // Add implicit assignments for generated columns in topological order so
  // that a generated column referencing another generated column sees the
  // freshly-computed value when the runtime evaluates each in turn against
  // the in-place updated row.
  const genTopoOrder = tableReference.tableSchema.generatedColumnTopoOrder ?? [];
  for (const colIdx of genTopoOrder) {
    const col = tableReference.tableSchema.columns[colIdx];
    if (!col.generated || !col.generatedExpr) continue;
    const genNode = buildExpression(schemaAuthoredUpdateCtx, col.generatedExpr) as ScalarPlanNode;
    if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
      validateDeterministicGenerated(genNode, col.name, tableReference.tableSchema.name);
    }
    const targetColumn: AST.ColumnExpr = { type: 'column', name: col.name, table: stmt.table.name, schema: stmt.table.schema };
    assignments.push({ targetColumn, value: genNode, isGenerated: true });
  }

  // Now build the WHERE filter (parameters here get indices after SET clause parameters)
  if (stmt.where) {
    const filterExpression = buildExpression(updateCtx, stmt.where);
    sourceNode = new FilterNode(updateCtx.scope, sourceNode, filterExpression);
  }

  // Create OLD/NEW attributes for UPDATE (used for both RETURNING and non-RETURNING paths)
  const oldAttributes = tableReference.tableSchema.columns.map((col) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: columnSchemaToScalarType(col),
    sourceRelation: `OLD.${tableReference.tableSchema.name}`
  }));

  const newAttributes = tableReference.tableSchema.columns.map((col) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: columnSchemaToScalarType(col),
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
    schemaAuthoredUpdateCtx,
    tableReference.tableSchema,
    RowOpFlag.UPDATE,
    oldAttributes,
    newAttributes,
    flatRowDescriptor,
    contextAttributes,
    extraConstraints
  );

  // Build FK constraint checks if foreign_keys pragma is enabled
  if (ctx.db.options.getBooleanOption('foreign_keys')) {
    // Child-side: check new FK values reference valid parent rows
    const childFKChecks = buildChildSideFKChecks(
      schemaAuthoredCtx, tableReference.tableSchema, RowOpFlag.UPDATE,
      oldAttributes, newAttributes, contextAttributes
    );
    constraintChecks.push(...childFKChecks);
    // Parent-side: check no children reference old values being changed.
    // Skipped entirely when the batchability gate admits the statement — the
    // runtime DML executor then enforces every inbound RESTRICT FK with ONE
    // chunked probe per FK at the end-of-statement boundary instead of one
    // correlated NOT EXISTS per row (see getBatchableRestrictFks). UPDATE has
    // no statement-level OR clause, so the effective conflict resolution is the
    // ABORT default (matching the `undefined` onConflict on the DmlExecutorNode).
    if (getBatchableRestrictFks(ctx.db, tableReference.tableSchema, 'update', undefined, lensRouted) === undefined) {
      const parentFKChecks = buildParentSideFKChecks(
        schemaAuthoredCtx, tableReference.tableSchema, RowOpFlag.UPDATE,
        oldAttributes, newAttributes, contextAttributes
      );
      constraintChecks.push(...parentFKChecks);
    }
  }

  // Pre-build DEFAULT evaluators for NOT NULL columns (used by REPLACE substitution).
  const notNullDefaults = buildNotNullDefaults(
    schemaAuthoredUpdateCtx, tableReference.tableSchema, newAttributes, contextAttributes
  );

  if (stmt.returning && stmt.returning.length > 0) {
    // For RETURNING, create coordinated attribute IDs like we do for INSERT
    const returningScope = new RegisteredScope(updateCtx.scope);

    // Create attribute ID index for NEW columns (used for RETURNING projection)
    const newColumnAttributeIds: number[] = [];
    newAttributes.forEach((attr, columnIndex) => {
      newColumnAttributeIds[columnIndex] = attr.id;
    });

    tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
      const newAttributeId = newAttributes[columnIndex].id;
      const oldAttributeId = oldAttributes[columnIndex].id;
      // RETURNING comparisons resolve the column's declared collation, exactly
      // like a read-path query over the same schema.
      const columnType = columnSchemaToScalarType(tableColumn);

      // Register the unqualified column name in the RETURNING scope (defaults to NEW values)
      returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, newAttributeId, columnIndex));

      // Also register the table-qualified form (table.column) - defaults to NEW values
      const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
      returningScope.registerSymbol(tblQualified, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, newAttributeId, columnIndex));

      // Register NEW.column for UPDATE RETURNING (updated values)
      returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, newAttributeId, columnIndex));

      // Register OLD.column for UPDATE RETURNING (original values)
      returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, oldAttributeId, columnIndex));

      // Also register the lowered target's correlation-name-qualified form
      // (`<alias>.column` — the view-mutation SELF_ALIAS `__vm_self.column`, or a
      // user-written `update t as x`), defaulting to NEW like the table-qualified form.
      // A RETURNING subquery that correlates to the outer mutated row through that alias
      // must bind the STABLE NEW attribute (which stays in context throughout RETURNING
      // projection) rather than falling through to the target scan's transient row
      // context. Without this the ref resolves to the scan row, which an eager mutation
      // executor (e.g. the store backend) tears down before the subquery projects — so
      // the correlated lookup fails with "No row context found". Only added when the
      // correlation name differs from the table name (the alias case); otherwise the
      // table-qualified registration above already covers it.
      if (correlationName !== tableName) {
        returningScope.registerSymbol(`${correlationName}.${tableColumn.name.toLowerCase()}`, (exp, s) =>
          new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, newAttributeId, columnIndex));
      }
    });

    const returningProjections: ReturningProjection[] = [];
    for (const rc of stmt.returning) {
      if (rc.type === 'all') {
        // `*` / `t.*` expands in place to every column (NEW image via the returning
        // scope), each carrying its NEW attribute id like the named path below.
        returningProjections.push(...expandReturningStar(
          updateCtx, rc, returningScope, tableReference.tableSchema, stmt.alias, newColumnAttributeIds));
        continue;
      }

      // Infer alias from column name if not explicitly provided.
      // Preserve the spelling the user wrote so quoted identifiers like
      // [Name] / "Name" round-trip to the result column name unchanged.
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        alias = rc.expr.table
          ? `${rc.expr.table}.${rc.expr.name}`
          : rc.expr.name;
      }

      const columnIndex = tableReference.tableSchema.columns.findIndex(col => col.name.toLowerCase() === (rc.expr.type === 'column' ? rc.expr.name.toLowerCase() : ''));
      const projAttributeId = rc.expr.type === 'column' && columnIndex !== -1 ? newColumnAttributeIds[columnIndex] : undefined;

      returningProjections.push({
        node: buildExpression({ ...updateCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias,
        attributeId: projAttributeId
      });
    }

    // Create UpdateNode with both row descriptors for RETURNING coordination
    const updateNodeWithDescriptor = new UpdateNode(
      updateCtx.scope,
      tableReference,
      assignments,
      sourceNode,
      oldRowDescriptor,
      newRowDescriptor,
      flatRowDescriptor,
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor
    );

    // For returning, we still need to execute the update before projecting
    // Always inject ConstraintCheckNode for UPDATE operations (provides required metadata)
    const constraintCheckNode = new ConstraintCheckNode(
      updateCtx.scope,
      updateNodeWithDescriptor,
      tableReference,
      RowOpFlag.UPDATE,
      oldRowDescriptor,
      newRowDescriptor,
      flatRowDescriptor,
      constraintChecks,
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor,
      undefined, // onConflict — UPDATE has no statement-level OR clause; per-constraint defaults apply
      notNullDefaults.length > 0 ? notNullDefaults : undefined
    );

    const updateExecutorNode = new DmlExecutorNode(
      updateCtx.scope,
      constraintCheckNode,
      tableReference,
      'update',
      undefined, // onConflict — UPDATE has no statement-level OR clause
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor,
      undefined, // upsertClauses — UPDATE has none
      lensRouted
    );

    // Return the RETURNING results from the executed update
    return new ReturningNode(updateCtx.scope, updateExecutorNode, returningProjections);
  }

  // Step 1: Create UpdateNode that produces updated rows (but doesn't execute them)
  // Create newRowDescriptor and oldRowDescriptor for constraint checking with NEW/OLD references
  const updateNode = new UpdateNode(
    updateCtx.scope,
    tableReference,
    assignments,
    sourceNode,
    oldRowDescriptor,
    newRowDescriptor,
    flatRowDescriptor,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  // Step 2: inject constraint checking AFTER update row generation
  const constraintCheckNode = new ConstraintCheckNode(
    updateCtx.scope,
    updateNode,
    tableReference,
    RowOpFlag.UPDATE,
    oldRowDescriptor,
    newRowDescriptor,
    flatRowDescriptor,
    constraintChecks,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor,
    undefined, // onConflict — UPDATE has no statement-level OR clause; per-constraint defaults apply
    notNullDefaults.length > 0 ? notNullDefaults : undefined
  );

  const updateExecutorNode = new DmlExecutorNode(
    updateCtx.scope,
    constraintCheckNode,
    tableReference,
    'update',
    undefined, // onConflict — UPDATE has no statement-level OR clause
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor,
    undefined, // upsertClauses — UPDATE has none
    lensRouted
  );

  return new SinkNode(updateCtx.scope, updateExecutorNode, 'update');
}
