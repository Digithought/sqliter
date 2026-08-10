import type * as AST from '../../parser/ast.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import type { Attribute, ScalarPlanNode } from '../nodes/plan-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { ReferenceCallback } from '../scopes/scope.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { schemaAuthoredContext } from './schema-authored-context.js';
import { validateDeterministicGenerated } from '../validation/determinism-validator.js';
import { stripSelfQualifierInSchemaExpression } from '../../schema/rename-rewriter.js';
import { buildColumnSourceResolver } from '../../schema/column-source-resolver.js';
import { cloneExpr } from '../mutation/scope-transform.js';
import { columnSchemaToScalarType } from '../type-utils.js';

/**
 * Compile one `generated always as (<expr>)` body against the row it is computed
 * from. THE one place that decides what a generated expression may name, so the
 * four sites that compile such a body — the INSERT row expansion, the
 * `on conflict do update` recompute, the UPDATE recompute, and the
 * `alter table … add column` backfill — accept exactly the same spellings. A
 * declaration `create table` (or `alter table`) accepts is therefore one every
 * subsequent write accepts.
 *
 * Accepted spellings, matching what the schema-time reference analysis
 * (`schema/generated-column-refs.ts`) already classifies as binding the owning
 * table's row:
 *
 * | spelling                        | how it resolves                                  |
 * |---------------------------------|--------------------------------------------------|
 * | `<col>`                         | registered below                                  |
 * | `<table>.<col>`                 | folded to `<col>` by the self-qualifier strip     |
 * | `<own-schema>.<table>.<col>`    | same                                              |
 * | `new.<col>`                     | registered below — an exact alias for the bare form|
 * | `old.<col>`                     | NOT registered: a generated value is computed from |
 * |                                 | the row being written; there is no old row         |
 * | any other qualifier             | falls through to the ordinary scope chain          |
 *
 * `new.<col>` is accepted rather than rejected because `alter table … add column`
 * already accepts and correctly backfills it, and because both `CHECK`
 * (`constraint-builder.ts`) and column `DEFAULT` (`default-scope.ts`) accept it —
 * for a `DEFAULT` it is the ONLY accepted spelling.
 *
 * MUTATION CONTEXT: unlike a `CHECK` or a column `DEFAULT`, a `with context`
 * variable does NOT shadow a same-named column here — the bare name always means
 * the column, and context variables are not registered at all. Two reasons: a
 * generated value is a pure function of the row being written and must compute
 * identically at every one of the four sites, and the `alter table … add column`
 * backfill has no mutation-context envelope to read (letting a context variable
 * capture the name would make a currently-working backfill fail); and the
 * schema-time analysis already rejects any bare name in a generated body that is
 * not a column of the table, so a generated body can only ever *collide* with a
 * context variable, never usefully name one. See docs/sql-ddl.md § Generated
 * Columns.
 */
export function buildGeneratedColumnExpr(
	ctx: PlanningContext,
	tableSchema: TableSchema,
	/** The generated column's name, for the determinism diagnostic. At
	 *  `add column` this is the column being declared, which is NOT yet in
	 *  `tableSchema.columns`. */
	columnName: string,
	generatedExpr: AST.Expression,
	/**
	 * The attributes carrying the row the expression computes from, index-aligned
	 * with `tableSchema.columns`. Each site supplies its own: the prior projection's
	 * output (INSERT, so a generated column referencing another sees the freshly
	 * computed value), the conflicting row (`do update`), the update source, or the
	 * pre-ALTER row (backfill).
	 */
	rowAttributes: ReadonlyArray<Attribute>,
): ScalarPlanNode {
	// Fold `<table>.<col>` / `<schema>.<table>.<col>` to the bare form the scope
	// registers, on a clone — never the stored AST. Done as a rewrite rather than by
	// seeding `<table>.<col>` scope keys for the reason `constraint-builder.ts`
	// documents: this scope is an ancestor of every subquery planned inside the body,
	// and qualified keys would let a join peer's parent-chain fallback resolve an
	// inner relation's qualified columns against the outer row context.
	//
	// NOTE: clones and walks the body on every plan build of a write to a table with
	// generated columns, exactly as the CHECK path does. Plan-build only (statements
	// are prepared once, not per row) and generated bodies are small; if this ever
	// shows up in a profile, cache the stripped form on the column schema.
	let expr = generatedExpr;
	const stripped = cloneExpr(generatedExpr);
	if (stripSelfQualifierInSchemaExpression(
		stripped, tableSchema.name, tableSchema.schemaName, buildColumnSourceResolver(ctx.db))) {
		expr = stripped;
	}

	const scope = new RegisteredScope(ctx.scope);
	// NOTE: a column whose quoted name contains a dot (`"new.a"` beside a column `a`)
	// makes the `new.` alias key collide with the bare key, and `registerSymbol`
	// rejects the duplicate — so every write to such a table fails to plan. Pre-exists
	// this builder on the CHECK (`constraint-builder.ts`) and `do update` SET scopes,
	// which key the same flat `<qualifier>.<name>` string namespace; tracked as
	// `bug-scope-symbol-keys-collide-with-dotted-column-names`. Do not paper over it
	// here — a local skip would silently pick one of the two columns.
	tableSchema.columns.forEach((column, columnIndex) => {
		const attr = rowAttributes[columnIndex];
		if (!attr) {
			// Every caller derives its row from `tableSchema.columns`, so a short array
			// is a caller bug. Failing loudly beats registering nothing: the missing
			// column name would fall through to the enclosing scope and bind whatever
			// happens to be there.
			quereusError(
				`Internal: generated column '${columnName}' on '${tableSchema.name}' has no row attribute for column '${column.name}' (index ${columnIndex}); row supplies ${rowAttributes.length} of ${tableSchema.columns.length}`,
				StatusCode.INTERNAL,
			);
		}
		// Resolve against the column's DECLARED type (which carries its declared
		// collation), so a generated expression comparing text resolves the same
		// collation a read-path query and a CHECK would — the row attribute's type
		// reflects whatever expression produced it.
		const columnType = columnSchemaToScalarType(column);
		const makeRef: ReferenceCallback = (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, attr.id, columnIndex);
		const colNameLower = column.name.toLowerCase();
		scope.registerSymbol(colNameLower, makeRef);
		scope.registerSymbol(`new.${colNameLower}`, makeRef);
	});

	// Schema-authored SQL: bare relation names inside the body resolve against the
	// TABLE's own schema and cannot bind the writing statement's CTEs, whichever site
	// is compiling it.
	const node = buildExpression(
		{ ...schemaAuthoredContext(ctx, tableSchema.schemaName), scope },
		expr,
	) as ScalarPlanNode;

	if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
		validateDeterministicGenerated(node, columnName, tableSchema.name);
	}

	return node;
}
