import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { AddConstraintNode } from '../nodes/add-constraint-node.js';
import { AlterTableNode, type AddColumnBackfill, type AddColumnCheck } from '../nodes/alter-table-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { PlanNode, type VoidNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { buildRowDefaultScope } from './default-scope.js';
import { validateDeterministicDefault, validateDeterministicGenerated } from '../validation/determinism-validator.js';
import { tryFoldLiteral } from '../../parser/utils.js';
import { inferType } from '../../types/registry.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { astToString, expressionToString } from '../../emit/ast-stringify.js';
import { validateReservedTags, type TagSite } from '../../schema/reserved-tags.js';
import { validateAddColumnGeneratedRefs } from '../../schema/table.js';
import { columnTagDiagnostics, raiseStmtTagDiagnostics } from './tag-diagnostics.js';
import { planViewBody } from './create-view.js';
import { schemaAuthoredContext } from './schema-authored-context.js';

export function buildAlterTableStmt(
  ctx: PlanningContext,
  stmt: AST.AlterTableStmt,
): VoidNode {
  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, ctx);
  const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  // Canonical, fully-qualified SQL for the whole statement, rendered ONCE here — the one
  // place that holds the parsed action and the resolved table together. Rendered from a
  // SYNTHETIC statement whose table identifier is rebuilt from the resolved TableSchema,
  // not from `stmt.table` as the user wrote it: an unqualified `alter table orders …`
  // must not become a statement a receiver resolves against a different default schema.
  // Same qualification rule as `generateTableDDL` / the schema differ's synthetic ALTER
  // (schema-differ.ts), so the two wire sources agree. The runtime arms thread it to the
  // module (`SchemaChangeInfo.ddl` / `renameTable`'s `ddl`) and onto the public
  // schema-change event.
  //
  // NOTE: rendered for EVERY arm, including the four that never announce anything (the tag
  // arms, `set`/`drop maintained`) — `set maintained as <select>` therefore stringifies its
  // whole SELECT body for a string nobody reads. Free today: ALTER is not a hot path and
  // each statement builds once. If those arms ever start carrying a rendering cost that
  // matters, render lazily and hand the arms a thunk instead of a string.
  const { schemaName, name: tableName } = tableReference.tableSchema;
  const canonicalStmt: AST.AlterTableStmt = {
    type: 'alterTable',
    table: schemaName.toLowerCase() === 'main'
      ? { type: 'identifier', name: tableName }
      : { type: 'identifier', name: tableName, schema: schemaName },
    action: stmt.action,
  };
  const sql = astToString(canonicalStmt);

  switch (stmt.action.type) {
    case 'addConstraint': {
      // Reject a typo'd / mis-sited reserved `quereus.*` tag on the constraint at
      // plan-build, mirroring CREATE TABLE's named-constraint leg and SET TAGS — a
      // bad tag can't be silently stored when introduced via ALTER ... ADD CONSTRAINT.
      raiseStmtTagDiagnostics(
        validateReservedTags(stmt.action.constraint.tags, 'physical-constraint'),
        stmt,
      );

      // Convert RowOp[] (e.g., ['insert','update']) to bitmask understood by runtime.
      const operations = stmt.action.constraint.operations ?? ['insert','update'];

      const constraintWithBitmask = {
        ...stmt.action.constraint,
        operations
      };

      return new AddConstraintNode(
        ctx.scope,
        tableReference,
        constraintWithBitmask,
        sql,
      );
		}

    case 'renameTable':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameTable',
        newName: stmt.action.newName,
      }, sql);

    case 'renameColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameColumn',
        oldName: stmt.action.oldName,
        newName: stmt.action.newName,
      }, sql);

    case 'addColumn': {
      const column = stmt.action.column;
      // Reject a typo'd / mis-sited reserved `quereus.*` tag on the new column or any
      // of its inline named constraints at plan-build, before any heavier backfill /
      // check compilation — shares CREATE TABLE's per-column accumulation
      // (`columnTagDiagnostics`) so the two authoring surfaces can't drift.
      raiseStmtTagDiagnostics(columnTagDiagnostics(column), stmt);
      // Validate the DEFAULT through the shared DDL validator (bind params / bare
      // columns / non-determinism rejected; `new.<column>` accepted with its build
      // deferred). This runs before building the backfill so a bare-column default
      // is rejected here rather than silently resolving against the existing columns
      // the backfill scope exposes. DEFAULT only: a GENERATED ALWAYS AS expression is
      // written with bare column references by definition, so this validator would
      // reject every legal one. Its determinism is checked inside
      // `buildAddColumnBackfill` instead, with the generated-flavoured validator.
      const defaultConstraint = column.constraints?.find(c => c.type === 'default');
      if (defaultConstraint?.expr) {
        const hasMutationContext = !!tableReference.tableSchema.mutationContext
          && tableReference.tableSchema.mutationContext.length > 0;
        ctx.schemaManager.validateAddColumnDefault(
          defaultConstraint.expr, column.name, tableReference.tableSchema.name, hasMutationContext,
        );
      }
      const backfill = buildAddColumnBackfill(ctx, tableReference, column);
      // For the per-row (evaluator) path — a non-foldable DEFAULT or a GENERATED ALWAYS AS
      // expression — enforce any CHECK on the new column against each backfilled row by
      // compiling the predicates here and evaluating them inside the per-row backfill hook
      // (mirrors the NOT NULL per-row path) — a violating row aborts the ALTER before any
      // tree/batch swap. The literal-default path is left to the post-backfill scan
      // (`validateBackfillAgainstChecks`), so checks are only compiled when a backfill is
      // present.
      const checks = backfill ? buildAddColumnChecks(ctx, tableReference, column) : undefined;
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'addColumn',
        column,
        backfill,
        checks,
      }, sql);
		}

    case 'dropColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropColumn',
        name: stmt.action.name,
      }, sql);

    case 'dropConstraint':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropConstraint',
        name: stmt.action.name,
      }, sql);

    case 'renameConstraint':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameConstraint',
        oldName: stmt.action.oldName,
        newName: stmt.action.newName,
      }, sql);

    case 'alterPrimaryKey':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'alterPrimaryKey',
        columns: stmt.action.columns,
      }, sql);

    case 'alterColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'alterColumn',
        columnName: stmt.action.columnName,
        setNotNull: stmt.action.setNotNull,
        setDataType: stmt.action.setDataType,
        setDefault: stmt.action.setDefault,
        setCollation: stmt.action.setCollation,
      }, sql);

    case 'setTags': {
      // Validate any reserved `quereus.*` tags at the matching site so a typo
      // (e.g. `quereus.expose_implicit_indx`) fails loudly here rather than being
      // stored. The CREATE / declarative paths route tags through the same registry.
      const target = stmt.action.target;
      const site: TagSite =
        target.kind === 'column' ? 'physical-column'
        : target.kind === 'constraint' ? 'physical-constraint'
        : 'physical-table';
      // Routed through the shared helper (rather than the policy call inline) so every
      // plan-build tag surface raises through one site and a sited error here now
      // carries the statement's source location too.
      raiseStmtTagDiagnostics(validateReservedTags(stmt.action.tags, site), stmt);
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'setTags',
        target,
        mode: stmt.action.mode,
        tags: stmt.action.tags,
      }, sql);
    }

    case 'dropTags': {
      // DROP TAGS removes tags by key, so there is NO reserved-tag value
      // validation here (dropping a reserved key is legitimate — it removes an
      // override). Resolve the same target plumbing as setTags and let the
      // SchemaManager raise NOTFOUND atomically when a listed key is absent.
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropTags',
        target: stmt.action.target,
        keys: stmt.action.keys,
      }, sql);
    }

    case 'setMaintained': {
      // SET MAINTAINED AS <body> — attach / re-attach a derivation. Reuse the
      // CREATE VIEW body gate so a DML body or non-relational body is rejected
      // here with the same sited diagnostics as CREATE MATERIALIZED VIEW. The
      // full shape check (arity/names/types/collations/PK) and the reconcile
      // run in the emitter against the LIVE catalog state — deliberately not
      // here: the build-time schema may be a cached statement's snapshot, and
      // a shape mismatch over the implicit form is no longer an error but a
      // reshape-on-attach (attachMaintainedDerivation), so a build-time arity
      // gate would block legitimate reshapes.
      const tableSchema = tableReference.tableSchema;
      // Home-schema body path: the derivation's unqualified source names must
      // resolve next to the table the derivation attaches to.
      planViewBody(ctx, tableSchema.name, stmt.action.select, tableSchema.schemaName);
      // Mirror the create-form gate: a generated column would silently diverge
      // from its expression once the body supplies every column's value.
      const generated = tableSchema.columns.find(c => c.generated);
      if (generated) {
        throw new QuereusError(
          `cannot attach derivation to '${tableSchema.name}': column '${generated.name}' is generated — a maintained table's columns are all derived by the body`,
          StatusCode.ERROR,
          undefined,
          stmt.table.loc?.start.line,
          stmt.table.loc?.start.column,
        );
      }
      // The module is the table's identity (no `using` clause on attach); it
      // must be able to host a maintained backing.
      if (!tableSchema.vtabModule?.getBackingHost) {
        throw new QuereusError(
          `cannot attach derivation to '${tableSchema.name}': module '${tableSchema.vtabModuleName}' cannot host a maintained table (it does not implement the backing-host capability)`,
          StatusCode.UNSUPPORTED,
          undefined,
          stmt.table.loc?.start.line,
          stmt.table.loc?.start.column,
        );
      }
      return new AlterTableNode(ctx.scope, tableReference, {
        // Any `with defaults (…)` rides inside stmt.action.select.
        type: 'setMaintained',
        columns: stmt.action.columns,
        select: stmt.action.select,
      }, sql);
    }

    case 'dropMaintained':
      // Maintained-ness is checked in the emitter against the LIVE table (the
      // build-time schema may be a cached statement's snapshot).
      return new AlterTableNode(ctx.scope, tableReference, { type: 'dropMaintained' }, sql);

    default:
      throw new QuereusError(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `Unknown ALTER TABLE action: ${(stmt.action as any).type}`,
        StatusCode.INTERNAL
      );
  }
}

/**
 * Compile the per-row backfill of an ADD COLUMN that carries a per-row value source:
 * a DEFAULT that does not fold to a literal (e.g. `new.<col>`), or a GENERATED ALWAYS
 * AS expression (whatever its VIRTUAL / STORED spelling — this engine materializes a
 * generated value at write time either way). Mirrors the single-source INSERT
 * row-expansion and the view-write key default: the expression is built against the
 * table's *existing* columns as the "supplied" row, so both `new.<col>` and the bare
 * `<col>` a generated expression uses resolve to the existing row's sibling during
 * backfill. Returns `undefined` when the column carries neither, or for a
 * literal-folding DEFAULT (the module bulk-writes that from the column's
 * `defaultValue`), so the common case allocates nothing.
 */
function buildAddColumnBackfill(
  ctx: PlanningContext,
  tableReference: TableReferenceNode,
  columnDef: AST.ColumnDef,
): AddColumnBackfill | undefined {
  // A column declares a DEFAULT or a GENERATED ALWAYS AS, never both —
  // `columnDefToSchema` rejects the pair — so at most one arm applies.
  const generatedExpr = columnDef.constraints?.find(c => c.type === 'generated')?.generated?.expr;
  const defaultExpr = columnDef.constraints?.find(c => c.type === 'default')?.expr;
  const sourceExpr = generatedExpr ?? defaultExpr;
  if (!sourceExpr) return undefined;
  // Literal / NULL DEFAULTs fold and are bulk-written by the module — no per-row node.
  // Deliberately NOT taken on the generated arm: a generated column has no
  // `defaultValue` for the module to bulk-write, so short-circuiting a constant
  // generated expression (`generated always as (2)`) would leave every existing row
  // NULL. The generated arm always builds the per-row node.
  if (!generatedExpr && tryFoldLiteral(sourceExpr) !== undefined) return undefined;

  const tableSchema = tableReference.tableSchema;
  // Report a bad generated expression the way CREATE TABLE reports it, before the
  // compile below turns an unresolvable (or self-referencing) name into a generic
  // "Column not found".
  if (generatedExpr) {
    validateAddColumnGeneratedRefs(generatedExpr, columnDef.name, tableSchema.columns, tableSchema.name);
  }
  // Fresh attributes for the existing columns, referenced only by this expression's
  // column refs and resolved at runtime via the row slot the emitter installs over
  // each existing row. Minting fresh (rather than reusing the table reference's
  // attributes) keeps the node self-contained so the optimizer can't dangle it.
  const rowAttrs: Attribute[] = tableSchema.columns.map(column => ({
    id: PlanNode.nextAttrId(),
    name: column.name,
    type: columnSchemaToScalarType(column),
    sourceRelation: 'add-column-backfill',
  }));
  const rowScope = buildRowDefaultScope(ctx.scope, tableSchema.columns, rowAttrs);
  // Schema-authored SQL, wrapped exactly as the three DML builders wrap theirs, so the
  // backfill expression resolves bare relation names against the altered table's own
  // schema — not whatever path the ALTER runs on. The CTE half of the wrapper is inert
  // here (ALTER is not an `AST.QueryExpr`, so it can neither be a CTE body nor carry a
  // `with` clause of its own); the schema-path half is the load-bearing part.
  const node = buildExpression(
    { ...schemaAuthoredContext(ctx, tableSchema.schemaName), scope: rowScope },
    sourceExpr,
  ) as ScalarPlanNode;

  // Same validator each arm's write-path build site uses, so an ALTER accepts exactly
  // what the equivalent CREATE TABLE + INSERT accepts. Both honour
  // `nondeterministic_schema`, so the escape hatch is unchanged.
  if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
    if (generatedExpr) {
      validateDeterministicGenerated(node, columnDef.name, tableSchema.name);
    } else {
      validateDeterministicDefault(node, columnDef.name, tableSchema.name);
    }
  }

  const rowDescriptor: RowDescriptor = [];
  rowAttrs.forEach((attr, index) => { rowDescriptor[attr.id] = index; });

  // The evaluated value has to reach storage in the new column's declared form, exactly as an
  // INSERT's would. Skip the conversion when the expression's static type already IS that type
  // (identity comparison — the registry hands out one shared LogicalType instance per type),
  // mirroring `buildRowCoercion`: re-converting an already-converted value is destructive for
  // JSON. See `AddColumnBackfill.coerceTo`.
  const newColumnType = inferType(columnDef.dataType);
  const coerceTo = node.getType().logicalType === newColumnType ? undefined : newColumnType;
  return { node, rowDescriptor, coerceTo };
}

/**
 * Compile the column-level CHECK predicates of an ADD COLUMN that backfills per row (a
 * non-foldable DEFAULT or a GENERATED ALWAYS AS expression), so they can be enforced per
 * backfilled row inside the backfill hook. Each
 * predicate is built against a row scope covering the table's *existing* columns plus the
 * *new* column, so a CHECK referencing the new column (bare `<col>` or `new.<col>`) and any
 * existing sibling resolves. The new column sits at position `existingColumns.length` in the
 * row descriptor; the emitter sets that slot to `[...existingRow, backfilledValue]` per row.
 * Returns `undefined` when the column carries no CHECK (the common case allocates nothing).
 */
function buildAddColumnChecks(
  ctx: PlanningContext,
  tableReference: TableReferenceNode,
  columnDef: AST.ColumnDef,
): AddColumnCheck | undefined {
  const checkConstraints = (columnDef.constraints ?? []).filter(c => c.type === 'check' && c.expr);
  if (checkConstraints.length === 0) return undefined;

  const tableSchema = tableReference.tableSchema;
  // Fresh attributes for the existing columns followed by the new column. The new column's
  // logical type / nullability come from the column def (same inference the schema builder
  // uses); refs in the CHECK resolve through the row slot the emitter installs per row.
  const existingAttrs: Attribute[] = tableSchema.columns.map(column => ({
    id: PlanNode.nextAttrId(),
    name: column.name,
    type: columnSchemaToScalarType(column),
    sourceRelation: 'add-column-check',
  }));
  const newColNotNull = (columnDef.constraints ?? []).some(c => c.type === 'notNull');
  // Carry the new column's declared collation so a CHECK comparison over it (e.g.
  // `c = 'ABC'` on a `collate nocase` column) resolves the same collation at backfill
  // time as it would at write time.
  const newColCollation = columnDef.constraints?.find(c => c.type === 'collate')?.collation;
  const newColAttr: Attribute = {
    id: PlanNode.nextAttrId(),
    name: columnDef.name,
    type: {
      typeClass: 'scalar' as const,
      logicalType: inferType(columnDef.dataType),
      nullable: !newColNotNull,
      isReadOnly: false,
      collationName: newColCollation,
      // From an explicit COLLATE constraint on the new column — 'declared' by definition.
      collationSource: newColCollation !== undefined ? 'declared' as const : undefined,
    },
    sourceRelation: 'add-column-check',
  };
  const rowAttrs = [...existingAttrs, newColAttr];
  const targetColumns = [...tableSchema.columns, { name: columnDef.name }];
  const rowScope = buildRowDefaultScope(ctx.scope, targetColumns, rowAttrs);

  // Schema-authored, same as the backfill expression above and as every CHECK the DML
  // builders compile: a bare relation name means the ALTERED table's own schema, not
  // whatever path the ALTER runs on.
  const checkCtx = { ...schemaAuthoredContext(ctx, tableSchema.schemaName), scope: rowScope };
  const predicates = checkConstraints.map(con => ({
    node: buildExpression(checkCtx, con.expr!) as ScalarPlanNode,
    name: con.name,
    exprText: expressionToString(con.expr!),
  }));

  const rowDescriptor: RowDescriptor = [];
  rowAttrs.forEach((attr, index) => { rowDescriptor[attr.id] = index; });
  return { predicates, rowDescriptor };
}
