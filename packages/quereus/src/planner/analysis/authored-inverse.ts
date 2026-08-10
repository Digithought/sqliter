import type * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import type { Attribute, AuthoredInverseAssignment, AuthoredInverseMeta, RelationalPlanNode } from '../nodes/plan-node.js';

/**
 * Build-time validation of the `with inverse (col = expr, …)` result-column
 * clause (docs/vu-inverses.md § Authored inverses). Position-independent:
 * it runs wherever a select carrying the clause is planned — top-level query,
 * view body, CTE, subquery-in-FROM — so a typo fails loud even when the relation
 * is never a write target. Four rules:
 *
 *  1. every assignment **target** resolves to exactly one column of the select's
 *     FROM sources (the same name set any body column ref resolves against);
 *  2. every **`new.<name>`** reference inside an assignment expression resolves
 *     to an output column of this select, by output name (case-insensitive);
 *  3. a non-`new.`-qualified column reference in an assignment expression's own
 *     scope is an error (the inverse is over the written row only — bare base
 *     columns are not in scope; subquery-local references are exempt, they
 *     resolve against the subquery's own FROM);
 *  4. the same target across two result columns of one select is an error (two
 *     puts for one base column is ill-defined). A duplicate *within* one clause
 *     is already a parse error.
 *
 * Until the relation is a write target the validated clause is inert metadata:
 * the returned per-column {@link AuthoredInverseMeta} rides the `Projection` into
 * `deriveProjectUpdateLineage`, which upgrades the column to a writable
 * `authored` UpdateSite.
 */

/** Source location helper for sited diagnostics (falls back to the clause expr). */
function locOf(expr: AST.Expression | undefined): { line?: number; column?: number } {
	return { line: expr?.loc?.start.line, column: expr?.loc?.start.column };
}

function raiseSited(message: string, expr: AST.Expression | undefined): never {
	const { line, column } = locOf(expr);
	throw new QuereusError(message, StatusCode.ERROR, undefined, line, column);
}

/** The output name of one (non-star) result column, matching `deriveViewColumns`. */
export function resultColumnOutputName(rc: AST.ResultColumnExpr): string {
	return rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : expressionToString(rc.expr));
}

/**
 * Resolve a `new.<name>` reference of an authored put expression against the
 * site's validated reference index. {@link validateAuthoredInverses} ran on the
 * same body AST when it was planned, so a miss here is an internal inconsistency,
 * not a user error. Shared by the single- and multi-source lowering spines.
 */
export function requireValidatedNewRefIndex(
	newRefIndex: ReadonlyMap<string, number>,
	name: string,
	assignedColumn: string,
): number {
	const idx = newRefIndex.get(name.toLowerCase());
	if (idx === undefined) {
		throw new QuereusError(
			`internal: WITH INVERSE reference 'new.${name}' (lowering an assignment to '${assignedColumn}') is missing from the validated reference index`,
			StatusCode.INTERNAL,
		);
	}
	return idx;
}

/**
 * The select's output column names in AST (lexical) order, with `*` / `t.*`
 * expanded from the FROM source's attributes — the same expansion + ordering
 * `deriveViewColumns` / the spine consumers use, so `newRefIndex` indexes line up
 * with their per-column arrays.
 */
function collectOutputNames(columns: readonly AST.ResultColumn[], sourceAttrs: readonly Attribute[]): string[] {
	const names: string[] = [];
	for (const rc of columns) {
		if (rc.type === 'all') {
			const matching = rc.table
				? sourceAttrs.filter(a => a.relationName && a.relationName.toLowerCase() === rc.table!.toLowerCase())
				: sourceAttrs;
			for (const attr of matching) names.push(attr.name);
		} else {
			names.push(resultColumnOutputName(rc));
		}
	}
	return names;
}

/**
 * Walk every column reference in the assignment expression's OWN scope (i.e. NOT
 * inside a subquery operand, whose references resolve against the subquery's own
 * FROM) plus every `new.`-qualified reference at ANY depth (a `new.` ref inside a
 * correlated subquery is still a written-row read). Mirrors the
 * `collectWriteRowColumns` walk in `building/view-mutation-builder.ts`.
 */
function forEachInverseRef(
	expr: AST.Expression,
	insideSubquery: boolean,
	visit: (col: AST.ColumnExpr, insideSubquery: boolean) => void,
): void {
	switch (expr.type) {
		case 'column':
			visit(expr, insideSubquery);
			return;
		case 'binary':
			forEachInverseRef(expr.left, insideSubquery, visit);
			forEachInverseRef(expr.right, insideSubquery, visit);
			return;
		case 'unary':
		case 'cast':
		case 'collate':
			forEachInverseRef(expr.expr, insideSubquery, visit);
			return;
		case 'function':
			expr.args.forEach(a => forEachInverseRef(a, insideSubquery, visit));
			return;
		case 'between':
			forEachInverseRef(expr.expr, insideSubquery, visit);
			forEachInverseRef(expr.lower, insideSubquery, visit);
			forEachInverseRef(expr.upper, insideSubquery, visit);
			return;
		case 'case':
			if (expr.baseExpr) forEachInverseRef(expr.baseExpr, insideSubquery, visit);
			expr.whenThenClauses.forEach(w => {
				forEachInverseRef(w.when, insideSubquery, visit);
				forEachInverseRef(w.then, insideSubquery, visit);
			});
			if (expr.elseExpr) forEachInverseRef(expr.elseExpr, insideSubquery, visit);
			return;
		case 'in':
			forEachInverseRef(expr.expr, insideSubquery, visit);
			if (expr.values) expr.values.forEach(v => forEachInverseRef(v, insideSubquery, visit));
			if (expr.subquery) forEachInverseQueryRef(expr.subquery, visit);
			return;
		case 'subquery':
			forEachInverseQueryRef(expr.query, visit);
			return;
		case 'exists':
			forEachInverseQueryRef(expr.subquery, visit);
			return;
		case 'windowFunction':
			// Window args / PARTITION BY / ORDER BY / frame bounds sit in the same
			// scalar scope as the assignment expression — mirror `transformExpr`'s
			// descent so a ref here is validated (and a `new.` ref registered) rather
			// than escaping to an internal error at lowering.
			expr.function.args.forEach(a => forEachInverseRef(a, insideSubquery, visit));
			if (expr.window) {
				(expr.window.partitionBy ?? []).forEach(p => forEachInverseRef(p, insideSubquery, visit));
				(expr.window.orderBy ?? []).forEach(ob => forEachInverseRef(ob.expr, insideSubquery, visit));
				const frame = expr.window.frame;
				for (const bound of [frame?.start, frame?.end]) {
					if (bound && (bound.type === 'preceding' || bound.type === 'following')) {
						forEachInverseRef(bound.value, insideSubquery, visit);
					}
				}
			}
			return;
		default:
			// literal / identifier / parameter / functionSource —
			// no column reference to validate.
			return;
	}
}

/** Descend into a subquery operand: every reference there is `insideSubquery`. */
function forEachInverseQueryRef(query: AST.QueryExpr, visit: (col: AST.ColumnExpr, insideSubquery: boolean) => void): void {
	if (query.type === 'select') {
		for (const rc of query.columns) {
			if (rc.type !== 'all') forEachInverseRef(rc.expr, true, visit);
		}
		for (const fc of query.from ?? []) forEachInverseFromRef(fc, visit);
		if (query.where) forEachInverseRef(query.where, true, visit);
		(query.groupBy ?? []).forEach(e => forEachInverseRef(e, true, visit));
		if (query.having) forEachInverseRef(query.having, true, visit);
		(query.orderBy ?? []).forEach(ob => forEachInverseRef(ob.expr, true, visit));
		if (query.limit) forEachInverseRef(query.limit, true, visit);
		if (query.offset) forEachInverseRef(query.offset, true, visit);
		if (query.compound) forEachInverseQueryRef(query.compound.select, visit);
		if (query.union) forEachInverseQueryRef(query.union, visit);
		return;
	}
	if (query.type === 'values') {
		query.values.forEach(row => row.forEach(e => forEachInverseRef(e, true, visit)));
	}
	// A DML subquery inside an inverse expression fails downstream when consumed;
	// nothing to validate here.
}

function forEachInverseFromRef(fc: AST.FromClause, visit: (col: AST.ColumnExpr, insideSubquery: boolean) => void): void {
	switch (fc.type) {
		case 'table':
			return;
		case 'join':
			forEachInverseFromRef(fc.left, visit);
			forEachInverseFromRef(fc.right, visit);
			if (fc.condition) forEachInverseRef(fc.condition, true, visit);
			return;
		case 'functionSource':
			fc.args.forEach(a => forEachInverseRef(a, true, visit));
			return;
		case 'subquerySource':
			forEachInverseQueryRef(fc.subquery, visit);
			return;
	}
}

/**
 * Validate every `with inverse` clause of a select's column list against its
 * planned FROM source, and return the per-result-column metadata (keyed by the
 * `AST.ResultColumnExpr` object) for the projection builder to attach. Returns
 * an empty map when no column carries the clause (the common fast path).
 *
 * `source` is the select's planned FROM relation (post-WHERE) — its attributes
 * are the target-resolution namespace and the `*` expansion source.
 */
export function validateAuthoredInverses(
	columns: readonly AST.ResultColumn[],
	source: RelationalPlanNode,
): Map<AST.ResultColumnExpr, AuthoredInverseMeta> {
	const out = new Map<AST.ResultColumnExpr, AuthoredInverseMeta>();
	if (!columns.some(c => c.type === 'column' && c.inverse && c.inverse.length > 0)) return out;

	const sourceAttrs = source.getAttributes();
	const outputNames = collectOutputNames(columns, sourceAttrs);
	const outputIndexByName = new Map<string, number>();
	outputNames.forEach((n, i) => {
		const key = n.toLowerCase();
		if (!outputIndexByName.has(key)) outputIndexByName.set(key, i);
	});

	// Rule 4 cross-column state: resolved target attribute id → the result column
	// that first authored a put to it (object-keyed — two result columns may share
	// an output name, so a name comparison could mask a genuine collision).
	const targetOwner = new Map<number, { rc: AST.ResultColumnExpr; name: string }>();

	for (const rc of columns) {
		if (rc.type !== 'column' || !rc.inverse || rc.inverse.length === 0) continue;
		const colName = resultColumnOutputName(rc);
		const assignments: AuthoredInverseAssignment[] = [];
		const newRefIndex = new Map<string, number>();

		for (const a of rc.inverse) {
			// Rule 1: the target resolves to exactly one FROM-source column.
			const matches = sourceAttrs.filter(attr => attr.name.toLowerCase() === a.column.toLowerCase());
			if (matches.length === 0) {
				raiseSited(
					`result column '${colName}': WITH INVERSE target '${a.column}' does not resolve to a column of the FROM sources`,
					a.expr,
				);
			}
			if (matches.length > 1) {
				raiseSited(
					`result column '${colName}': WITH INVERSE target '${a.column}' is ambiguous across the FROM sources`,
					a.expr,
				);
			}
			const target = matches[0];

			// Rule 4: one put per base column across the whole select.
			const prior = targetOwner.get(target.id);
			if (prior !== undefined && prior.rc !== rc) {
				raiseSited(
					`result columns '${prior.name}' and '${colName}' both author a WITH INVERSE put to base column '${target.name}'; a base column may be targeted by at most one result column's inverse`,
					a.expr,
				);
			}
			targetOwner.set(target.id, { rc, name: colName });

			// Rules 2 + 3: reference discipline inside the assignment expression.
			forEachInverseRef(a.expr, false, (col, insideSubquery) => {
				const qualifier = col.table?.toLowerCase();
				if (qualifier === 'new') {
					const idx = outputIndexByName.get(col.name.toLowerCase());
					if (idx === undefined) {
						raiseSited(
							`result column '${colName}': WITH INVERSE reference 'new.${col.name}' does not resolve to an output column of this select`,
							a.expr,
						);
					}
					newRefIndex.set(col.name.toLowerCase(), idx);
					return;
				}
				if (!insideSubquery) {
					raiseSited(
						`result column '${colName}': WITH INVERSE expression references '${col.table ? `${col.table}.` : ''}${col.name}' without the NEW qualifier; an inverse expression is over the written view row only — reference output columns as new.<column>`,
						a.expr,
					);
				}
			});

			assignments.push({ targetAttrId: target.id, targetColumn: target.name, expr: a.expr });
		}

		out.set(rc, { assignments, newRefIndex });
	}
	return out;
}
