import type { PlanningContext } from '../planning-context.js';
import type * as AST from '../../parser/ast.js';
import { CreateAssertionNode } from '../nodes/create-assertion-node.js';
import { buildAssertionViolationSql } from '../../schema/assertion.js';
import { buildSelectStmt } from './select.js';
import { Parser } from '../../parser/parser.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { storedBodyContext } from '../stored-body-context.js';

/**
 * Plans the assertion's violation query so a body that cannot resolve fails the
 * `CREATE ASSERTION` itself.
 *
 * Without this gate the create succeeds and the failure surfaces at COMMIT —
 * `AssertionEvaluator` recompiles EVERY live assertion on any commit that
 * touched any table, so one unresolvable body blocks writes to the whole
 * database, at some unrelated later statement, with an error that never names
 * the assertion.
 *
 * Strictness deliberately matches `CREATE VIEW`, which plans its body at build
 * time via {@link planViewBody}: whatever the planner rejects for a view body
 * (missing table, missing column, unknown function) is rejected here too, and
 * nothing more (a type mismatch such as `x + 'abc'` is not a planner error and
 * still creates).
 *
 * What is planned is the derived violation SQL round-tripped through
 * {@link buildAssertionViolationSql} + the parser, NOT the CHECK expression
 * directly. That text is exactly what the emitter stores and what the
 * commit-time evaluator re-parses and re-plans, so validating it also covers a
 * stringify/parse round trip that loses or mangles part of the expression —
 * planning the AST in hand would miss that.
 *
 * Build time, not emit time: statements execute one at a time (`apply schema`
 * runs each migration statement through its own `_execWithinTransaction`), so
 * the catalog left by every preceding statement is visible here, and a
 * rejection happens before any transaction start or catalog mutation — a clean
 * no-op.
 *
 * NOTE: no assertion-hoist suppression is needed (unlike the emitter's
 * dependency discovery, which calls `withSuppressedAssertionHoist`). Hoisting
 * is an optimizer pass; this path builds only, and the optimizer never runs
 * over the body here.
 *
 * NOTE: `CREATE ASSERTION` now plans its body twice — once here (build only)
 * and once in `emitCreateAssertion` for dependency discovery (build +
 * optimize). Immaterial today: creates are rare and the body is one small
 * query. If assertion creates ever show up hot (a large declarative schema
 * applied repeatedly), hang the node planned here on `CreateAssertionNode` and
 * have the emitter walk that instead of re-planning.
 */
function planAssertionBody(
	ctx: PlanningContext,
	schemaName: string,
	assertionName: string,
	check: AST.Expression,
): void {
	// Unqualified names in a stored body resolve against the assertion's own
	// schema first — the same home-schema rule `planViewBody` applies.
	const bodyCtx: PlanningContext = storedBodyContext(ctx, schemaName);
	try {
		const violationSql = buildAssertionViolationSql(check);
		const parsed = new Parser().parse(violationSql);
		if (parsed.type !== 'select') {
			throw new QuereusError(
				`violation query rendered as '${parsed.type}', expected a select`,
				StatusCode.INTERNAL,
			);
		}
		buildSelectStmt(bodyCtx, parsed);
	} catch (e) {
		const cause = e instanceof Error ? e : undefined;
		// Keep the underlying text — it is what names the missing table / column /
		// function — and prefix the assertion so the user knows which one failed.
		throw new QuereusError(
			`Cannot create assertion '${assertionName}': ${cause?.message ?? String(e)}`,
			e instanceof QuereusError ? e.code : StatusCode.ERROR,
			cause,
			check.loc?.start.line,
			check.loc?.start.column,
		);
	}
}

export function buildCreateAssertionStmt(ctx: PlanningContext, stmt: AST.CreateAssertionStmt): CreateAssertionNode {
	const sm = ctx.schemaManager;
	// Canonical schemaName (see SchemaManager.canonicalSchemaName) — it becomes
	// the assertion's stored home schema.
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	planAssertionBody(ctx, schemaName, stmt.name.name, stmt.check);
	return new CreateAssertionNode(ctx.scope, schemaName, stmt.name.name, stmt.check);
}
