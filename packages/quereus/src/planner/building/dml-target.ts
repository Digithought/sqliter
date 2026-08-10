import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { MutableViewLike } from '../mutation/single-source.js';
import { raiseMutationDiagnostic } from '../mutation/mutation-diagnostic.js';
import { flattenCteBody } from '../mutation/cte-flatten.js';
import { isRecursiveCte } from './with.js';

/**
 * Resolve a DML target identifier against the statement's own leading WITH clause,
 * returning an ephemeral {@link MutableViewLike} over the named CTE's body — the
 * adapter the view-mutation substrate routes through exactly as for a named view —
 * or `undefined` when the target is not a CTE (a schema table / view / MV, whose
 * dispatch is unchanged).
 *
 * A CTE name **shadows** a same-named schema table / view / MV as a write target,
 * matching read semantics (a CTE shadows a base table in FROM). So the three DML
 * builders call this *ahead* of their `getView` / `getMaintainedTable` /
 * `buildTableReference` dispatch; a match short-circuits to the ephemeral substrate.
 *
 * Behavior:
 *  - No leading WITH, or a schema-qualified target (`main.t` — a CTE is never
 *    schema-qualified) → `undefined` (ordinary schema dispatch).
 *  - Name miss against `withClause.ctes` → `undefined`.
 *  - A genuinely-recursive (self-referential) target → the structured `recursive-cte`
 *    diagnostic (never a generic table-not-found miss). Gated on the actual recursive
 *    shape ({@link isRecursiveCte}), so a `with recursive` clause whose *target* member
 *    is a plain non-self-referential body is still writable.
 *  - Otherwise → an ephemeral view-like over the CTE body.
 *
 * The CTE body itself is re-planned by the substrate against its own base table(s);
 * the caller threads the statement's CTEs into the planning context so any
 * sibling-CTE read in the user `where` / `set` / source resolves.
 *
 * **Multi-level body.** When the body is a single-source projection-and-filter that reads
 * ANOTHER (prior) sibling CTE, {@link flattenCteBody} collapses the linear chain down to a
 * flat body over the terminal base table, so the substrate sees a genuine single base-table
 * body (byte-equivalent to collapsing the chain into one CTE). The target's OWN name is passed
 * as the shadow-out name so the load-bearing `with base as (… from base) …` case stays
 * terminal; a non-updateable intermediate in the chain rejects with its own body-shape reason.
 * When nothing inlines, `flattenCteBody` returns `cte.query`'s identity unchanged.
 */
export function resolveCteTarget(
	ctx: PlanningContext,
	table: AST.IdentifierExpr,
	withClause: AST.WithClause | undefined,
): MutableViewLike | undefined {
	// No leading WITH, or a schema-qualified name (a bare CTE reference can never be
	// schema-qualified): not a CTE target — leave it to the schema lookups.
	if (!withClause || table.schema) return undefined;

	const cte = withClause.ctes.find(c => c.name.toLowerCase() === table.name.toLowerCase());
	if (!cte) return undefined;

	// A recursive (self-referential) CTE has no recoverable single base operation —
	// reject with the structured reason rather than the generic table-not-found miss
	// the schema dispatch would otherwise raise downstream.
	if (isRecursiveCte(withClause.recursive, cte)) {
		raiseMutationDiagnostic({
			reason: 'recursive-cte',
			table: cte.name,
			message: `cannot write through common table expression '${cte.name}': a recursive CTE has no recoverable base operation`,
		});
	}

	return {
		name: cte.name,
		// Cosmetic for an ephemeral target: only lens / dependency lookups read it,
		// and both are suppressed (ephemeral) or return undefined (no schema object).
		// The current schema name keeps any leaked diagnostic readable.
		schemaName: ctx.schemaManager.getCurrentSchemaName(),
		// Flatten a single-source multi-level chain (`with a …, t as (select * from a) …`) down
		// to a flat body over the terminal base table; the target's own name shadows out so its
		// own same-named FROM source stays the real table. A non-chain body is returned unchanged.
		selectAst: flattenCteBody(ctx, cte.query, ctesBefore(withClause, cte), cte.name),
		columns: cte.columns,
		ephemeral: true,
		// Marks this as a CTE-name target (vs an inline subquery), gating the
		// user-predicate self-read eager-capture path in the view-mutation builder.
		cteTarget: true,
		noun: 'common table expression',
	};
}

/**
 * Build an ephemeral {@link MutableViewLike} from an inline parenthesized subquery DML
 * target (`update (select …) as v set …` / `delete from (select …) as v where …`), or
 * `undefined` when the statement carries no `targetSource` (an ordinary named / CTE
 * target — unchanged dispatch). This is the inline-subquery dual of
 * {@link resolveCteTarget}: per docs/view-updateability.md, a subquery in `from` is
 * structurally an inlined CTE, so the body routes through the SAME view-mutation
 * substrate via the same ephemeral adapter.
 *
 *  - `name` is the user's alias `v` — the substrate resolves the user `where`/`set`
 *    column refs (`v.col` and the bare form) against it, exactly as for a named view's
 *    own name.
 *  - `selectAst` is the parenthesized body, re-planned against its own base table(s).
 *  - `columns` carries the optional `as v(a,b)` rename list (the renamed names are what
 *    `where`/`set` reference; the body's own projection names are hidden).
 *
 * A **DML-bodied** inline target (`update (insert … returning …) as v …`) is rejected
 * up front: {@link import('../../parser/parser.js')}'s `subquerySource` admits a
 * RETURNING DML body in a FROM position, but it is not a meaningful *write* target — the
 * body must be a SELECT/VALUES-shaped relation with recoverable base lineage. (A
 * VALUES/`select`-with-no-base body still rejects downstream in `analyzeView`; this
 * guard adds a target-named fast-fail for the DML case.)
 *
 * The caller threads the statement's CTEs into the planning context so a sibling-CTE
 * read in the body / user `where` / `set` resolves. Unlike the CTE-name target, an
 * inline subquery has no own-name to shadow out of its body, so no `cteNodes` deletion
 * is needed.
 */
export function resolveSubqueryTarget(
	ctx: PlanningContext,
	stmt: AST.UpdateStmt | AST.DeleteStmt,
): MutableViewLike | undefined {
	const source = stmt.targetSource;
	if (!source) return undefined;

	const body = source.subquery;
	if (body.type === 'insert' || body.type === 'update' || body.type === 'delete') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: source.alias,
			message: `cannot write through inline subquery target '${source.alias}': a ${body.type.toUpperCase()} body has no recoverable base operation — the write target must be a SELECT-shaped relation`,
		});
	}

	return {
		name: source.alias,
		// Cosmetic for an ephemeral target (see resolveCteTarget): only lens / dependency
		// lookups read it, and both are suppressed (ephemeral) or return undefined.
		schemaName: ctx.schemaManager.getCurrentSchemaName(),
		// Flatten a single-source multi-level chain (`with t as (…) update (select … from t) …`)
		// down to the terminal base table. An inline subquery sees ALL the statement's CTEs (it
		// sits after the WITH clause) and has no own-name to shadow out. Non-chain bodies are
		// returned unchanged.
		selectAst: flattenCteBody(ctx, body, stmt.withClause?.ctes ?? [], undefined),
		columns: source.columns,
		ephemeral: true,
		noun: 'derived table',
	};
}

/** The CTEs of `withClause` defined strictly before `cte` — its in-scope prior siblings (the
 *  visibility prefix a CTE-name target's body may inline against). */
function ctesBefore(withClause: AST.WithClause, cte: AST.CommonTableExpr): AST.CommonTableExpr[] {
	const idx = withClause.ctes.indexOf(cte);
	return idx <= 0 ? [] : withClause.ctes.slice(0, idx);
}

/**
 * The planning context the view-mutation substrate uses for a CTE-name target: the
 * statement's CTE-threaded context narrowed to the target's **prior-sibling prefix** —
 * the target's OWN name **and every sibling defined at or after it** are removed from
 * `cteNodes`.
 *
 * `buildFrom` resolves a FROM name against `cteNodes` *before* the schema, so leaving
 * the target's own name in scope would make its body's same-named FROM source
 * self-resolve to the CTE instead of the real object — silently wrong for the
 * load-bearing shadow case `with base as (select … from base) update base …`, whose
 * body must reach the REAL `base` table. A non-recursive CTE cannot reference itself,
 * so SQL scopes its own name OUT of its body anyway.
 *
 * The same definition-order rule applies to **later** siblings: a non-recursive CTE is
 * visible only to siblings defined after it, so the target's body sees only its PRIOR
 * siblings — a later sibling is out of scope and a same-named FROM in the body binds the
 * real object instead (`with x as (select … from fwd), fwd as (…) update x …` writes
 * through to the real `fwd`). This mirrors {@link import('./with.js').buildCommonTableExpr},
 * which builds each body against the prior siblings only.
 *
 * PRIOR sibling CTEs stay in scope, so a prior-sibling read in the body still resolves.
 *
 * Two consequences for the shared user-clause context (body and user `where`/`set`/
 * `returning` share this one context in v1 — see
 * {@link import('./view-mutation-builder.js')}):
 *  - A user-clause read of a LATER-defined sibling resolves to a real same-named table
 *    (or errors table-not-found), not the later CTE — never silently wrong.
 *  - A user-clause self-read of the target name (`… where id in (select id from t)`)
 *    does NOT resolve the CTE here — the self-capture path (`ctxSelfRead`) re-adds the
 *    target name for that, leaving this context Halloween-safe.
 * See docs/vu-operators.md § Common Table Expressions.
 */
export function contextForCteTarget(
	ctx: PlanningContext,
	withClause: AST.WithClause,
	targetName: string,
): PlanningContext {
	if (!ctx.cteNodes?.size) return ctx;
	const target = targetName.toLowerCase();
	// The target itself + every sibling defined at-or-after it are out of scope inside the
	// target's body (a non-recursive CTE sees only PRIOR siblings). `resolveCteTarget`
	// already matched targetName, so idx is normally >= 0; guard the not-found case to a
	// no-op slice rather than slicing from the end.
	const idx = withClause.ctes.findIndex(c => c.name.toLowerCase() === target);
	if (idx < 0) return ctx;
	// NOTE: deletion is BY NAME, so a same-named definition inherited from an ENCLOSING
	// `with` clause is dropped along with the target's own. Unreachable today (it needs a
	// CTE-name DML target nested inside another clause that reuses the name); if that
	// combination becomes real, delete only the entries this clause contributed.
	const shadowed = new Set(withClause.ctes.slice(idx).map(c => c.name.toLowerCase()));
	const cteNodes = new Map(ctx.cteNodes);
	for (const name of shadowed) cteNodes.delete(name);
	return { ...ctx, cteNodes };
}

/**
 * True iff the user clauses of an UPDATE/DELETE **self-read** the CTE-name target
 * `targetName` — a FROM source named `targetName` (unqualified) appears in any subquery
 * reachable from the `where`, an assignment value, or a RETURNING expression. This is
 * the gate the view-mutation builder uses to build the eager self-read capture + split
 * planning context (docs/vu-operators.md § Common Table Expressions —
 * self-reference): the body is planned target-EXCLUDED (so a same-named base FROM reaches
 * the real table), while the user clause's self-read resolves `t` against a materialized
 * snapshot of the body — a Halloween-safe positive write. Absent a self-read this returns
 * false and the lowering is byte-identical to today (no extra materialization).
 *
 * A CTE name is never schema-qualified, so only an unqualified FROM-source name matches.
 * The scan descends nested subqueries / their FROM (incl. join legs, TVF args, subquery
 * sources) and compound / union legs; a DML…RETURNING subquery is not descended (the
 * capture path never lowers one).
 */
export function needsSelfCapture(stmt: AST.UpdateStmt | AST.DeleteStmt, targetName: string): boolean {
	const target = targetName.toLowerCase();
	const exprs: AST.Expression[] = [];
	if (stmt.where) exprs.push(stmt.where);
	if (stmt.type === 'update') for (const a of stmt.assignments) exprs.push(a.value);
	if (stmt.returning) for (const rc of stmt.returning) if (rc.type !== 'all') exprs.push(rc.expr);
	return exprs.some(e => exprReadsTarget(e, target));
}

/** True iff any subquery operand of `expr` reads a FROM source named `target`. */
function exprReadsTarget(expr: AST.Expression, target: string): boolean {
	switch (expr.type) {
		case 'binary':
			return exprReadsTarget(expr.left, target) || exprReadsTarget(expr.right, target);
		case 'unary':
		case 'cast':
		case 'collate':
			return exprReadsTarget(expr.expr, target);
		case 'function':
			return expr.args.some(a => exprReadsTarget(a, target));
		case 'between':
			return exprReadsTarget(expr.expr, target) || exprReadsTarget(expr.lower, target) || exprReadsTarget(expr.upper, target);
		case 'case':
			return (!!expr.baseExpr && exprReadsTarget(expr.baseExpr, target))
				|| expr.whenThenClauses.some(w => exprReadsTarget(w.when, target) || exprReadsTarget(w.then, target))
				|| (!!expr.elseExpr && exprReadsTarget(expr.elseExpr, target));
		case 'in':
			return exprReadsTarget(expr.expr, target)
				|| (!!expr.values && expr.values.some(v => exprReadsTarget(v, target)))
				|| (!!expr.subquery && queryReadsTarget(expr.subquery, target));
		case 'subquery':
			return queryReadsTarget(expr.query, target);
		case 'exists':
			return queryReadsTarget(expr.subquery, target);
		case 'windowFunction':
			return expr.function.args.some(a => exprReadsTarget(a, target))
				|| (!!expr.window?.partitionBy && expr.window.partitionBy.some(e => exprReadsTarget(e, target)))
				|| (!!expr.window?.orderBy && expr.window.orderBy.some(ob => exprReadsTarget(ob.expr, target)));
		default:
			// literal / identifier / parameter / functionSource — no subquery operand.
			return false;
	}
}

/** True iff a relation-producing subquery reads (anywhere) a FROM source named `target`. */
function queryReadsTarget(query: AST.QueryExpr, target: string): boolean {
	if (query.type === 'select') {
		return (!!query.from && query.from.some(fc => fromReadsTarget(fc, target)))
			|| query.columns.some(rc => rc.type !== 'all' && exprReadsTarget(rc.expr, target))
			|| (!!query.where && exprReadsTarget(query.where, target))
			|| (!!query.groupBy && query.groupBy.some(e => exprReadsTarget(e, target)))
			|| (!!query.having && exprReadsTarget(query.having, target))
			|| (!!query.orderBy && query.orderBy.some(ob => exprReadsTarget(ob.expr, target)))
			|| (!!query.limit && exprReadsTarget(query.limit, target))
			|| (!!query.offset && exprReadsTarget(query.offset, target))
			|| (!!query.compound && queryReadsTarget(query.compound.select, target))
			|| (!!query.union && queryReadsTarget(query.union, target));
	}
	if (query.type === 'values') {
		return query.values.some(row => row.some(e => exprReadsTarget(e, target)));
	}
	// A DML … RETURNING subquery — not descended (the capture path never lowers one).
	return false;
}

/** True iff a FROM clause names (or nests a subquery that reads) a source named `target`. */
function fromReadsTarget(fc: AST.FromClause, target: string): boolean {
	switch (fc.type) {
		case 'table':
			return !fc.table.schema && fc.table.name.toLowerCase() === target;
		case 'join':
			return fromReadsTarget(fc.left, target) || fromReadsTarget(fc.right, target)
				|| (!!fc.condition && exprReadsTarget(fc.condition, target));
		case 'functionSource':
			return fc.args.some(a => exprReadsTarget(a, target));
		case 'subquerySource':
			return queryReadsTarget(fc.subquery, target);
	}
}
