import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { transformExpr, cloneExpr, transformAliasScopedQuery } from './scope-transform.js';
import { combineAnd } from './single-source.js';
import { raiseMutationDiagnostic, type MutationDiagnosticReason } from './mutation-diagnostic.js';

/**
 * Multi-level CTE-body flattener (`docs/vu-operators.md` § Common Table
 * Expressions — multi-level CTE body).
 *
 * A CTE-name (or inline-subquery) DML target whose body is a single-source
 * projection-and-filter that reads ANOTHER CTE —
 *
 *   with a as (select id, color from ml), t as (select * from a) update t …
 *
 * — used to reject `no-base-lineage`: the body's FROM resolves to a `CTEReferenceNode`,
 * not a base `TableReferenceNode`, so the mutation-propagation walk found no recoverable
 * base operation. This module collapses such a **linear single-source chain** down to a
 * flat `SELECT … FROM <terminal base table> …` by *pure syntactic AST composition*
 * (projection substitution + filter conjunction), so the produced body is byte-equivalent
 * to collapsing the whole chain into one CTE body. Every downstream consumer — `analyzeView`,
 * `classifyViewBody`, the INSERT/UPDATE/DELETE rewriters, RETURNING — then runs unchanged on
 * a genuine single base-table body.
 *
 * Crucially the flattener does **no** lineage / inverse reasoning: it substitutes references
 * and conjoins filters. All the hard backward-composition (inverses, passthrough, authored
 * inverses, computed columns) is recovered by the existing planner when `analyzeView`
 * re-plans the flat body — so a `select id, v+1 as vp from ml2` inlined through two levels
 * still inverts `set vp = 9` to `v = 8`.
 *
 * Non-updateable INTERMEDIATES (an aggregate / distinct / limit / set-op / join CTE in the
 * chain) reject with *that intermediate's* body-shape reason, matching the diagnostic the
 * equivalent collapsed body (or single-level CTE of that shape) raises. A non-updateable
 * CONSUMER (the target body itself — `select sum(v) from a`) is carried through unchanged so
 * the FINAL `analyzeView` on the flattened body rejects it with the same reason a collapsed
 * body would.
 */

/**
 * Defensive cap on chain depth. Non-recursive CTEs cannot truly cycle under
 * definition-order visibility (a CTE inlines only against CTEs defined *before* it), but a
 * visited-set + depth cap guard against a pathological AST and convert it into a structured
 * diagnostic rather than a stack overflow.
 */
const MAX_FLATTEN_DEPTH = 64;

/**
 * Flatten a single-source CTE/subquery body's linear chain of sibling-CTE reads down to a
 * body over the terminal base table. Returns the ORIGINAL object identity when nothing is
 * inlined (the FROM is already a base table / view / MV, or not a single CTE source), so the
 * common single-level path is provably untouched.
 *
 * @param body       the target body (a CTE's `query` or an inline subquery's body).
 * @param visible    the CTEs that resolve in `body`'s FROM, **in definition order** (the
 *                   prefix of the WITH clause up to — and excluding — a CTE-name target).
 * @param targetName the CTE-name target's own name, which must NOT be inlined (its body's
 *                   same-named FROM source is the REAL outer table — the load-bearing shadow
 *                   case). Undefined for an inline-subquery target (no own-name to shadow).
 */
export function flattenCteBody(
	ctx: PlanningContext,
	body: AST.QueryExpr,
	visible: ReadonlyArray<AST.CommonTableExpr>,
	targetName?: string,
): AST.QueryExpr {
	return flattenSelect(ctx, body, visible, targetName, 0, new Set<string>());
}

function flattenSelect(
	ctx: PlanningContext,
	body: AST.QueryExpr,
	visible: ReadonlyArray<AST.CommonTableExpr>,
	targetName: string | undefined,
	depth: number,
	visited: ReadonlySet<string>,
): AST.QueryExpr {
	// A non-SELECT body (VALUES / DML) is terminal — `analyzeView` rejects it natively.
	if (body.type !== 'select') return body;
	const inlineSource = singleCteSource(body, visible, targetName);
	if (!inlineSource) return body; // terminal: FROM is not a single inlinable-CTE source
	const { inner, sourceName } = inlineSource;
	const innerFlat = flattenInner(ctx, inner, visible, depth, visited);
	return composeBody(ctx, body, innerFlat, inner, sourceName);
}

interface InlineSource {
	/** The sibling CTE whose body inlines into the consumer. */
	readonly inner: AST.CommonTableExpr;
	/** The name the consumer references the inner source by (its alias, else the table name). */
	readonly sourceName: string;
}

/**
 * If `body` is a single-source SELECT whose sole FROM source names a visible sibling CTE that
 * may be inlined, return that CTE and the name the body references it by; otherwise undefined
 * (the body is terminal — its FROM is a base table / view / MV, or it is not a plain
 * single-source SELECT).
 */
function singleCteSource(
	body: AST.SelectStmt,
	visible: ReadonlyArray<AST.CommonTableExpr>,
	targetName: string | undefined,
): InlineSource | undefined {
	// A body carrying its OWN with clause is scoped to that clause — do not cross-inline the
	// outer chain into it (treat as terminal; `analyzeView` proceeds/rejects). Low-risk corner.
	if (body.withClause) return undefined;
	if (!body.from || body.from.length !== 1) return undefined;
	const fc = body.from[0];
	if (fc.type !== 'table') return undefined;
	// A schema-qualified name (`main.a`) is never a bare CTE reference → a real object.
	if (fc.table.schema) return undefined;
	const lcName = fc.table.name.toLowerCase();
	// The CTE-name target's own name is shadowed OUT of its body — a same-named FROM source is
	// the REAL outer table, not the CTE (SQL's non-recursive CTE scoping). Leave it terminal.
	if (targetName && lcName === targetName.toLowerCase()) return undefined;
	const inner = visible.find(c => c.name.toLowerCase() === lcName);
	if (!inner) return undefined; // not a visible sibling CTE → terminal base/view/MV source
	return { inner, sourceName: fc.alias ?? fc.table.name };
}

/**
 * Flatten the body of an inlinable inner CTE down to a single base-table SELECT, gating its
 * shape FIRST so a non-updateable intermediate rejects with its own body-shape reason
 * (`composeBody` only carries projection + filter, so silently inlining an aggregate /
 * distinct / limit / set-op / join intermediate would DROP the disqualifying clause — hence
 * the explicit reject here rather than at the final `analyzeView`).
 */
function flattenInner(
	ctx: PlanningContext,
	inner: AST.CommonTableExpr,
	visible: ReadonlyArray<AST.CommonTableExpr>,
	depth: number,
	visited: ReadonlySet<string>,
): AST.SelectStmt {
	const lcName = inner.name.toLowerCase();
	if (visited.has(lcName) || depth >= MAX_FLATTEN_DEPTH) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: inner.name,
			message: `cannot write through common table expression chain: inlining '${inner.name}' exceeded the supported nesting depth or revisited a CTE (possible cycle)`,
		});
	}
	assertInlinableInner(inner);
	const prefix = ctesBefore(visible, inner);
	const nextVisited = new Set(visited);
	nextVisited.add(lcName);
	// `assertInlinableInner` proved a SELECT body whose FROM is a single base table or a
	// further CTE; `flattenSelect` returns a SELECT in both the terminal and composed cases.
	return flattenSelect(ctx, inner.query, prefix, undefined, depth + 1, nextVisited) as AST.SelectStmt;
}

/**
 * Reject an inner (intermediate) CTE whose body shape cannot be faithfully inlined — the
 * composition would silently drop the disqualifying clause. The reason mirrors `analyzeView` /
 * `classifyViewBody` so the chain rejects with the same diagnostic the equivalent collapsed
 * body or single-level CTE of that shape would. A SELECT whose FROM is a single `{type:'table'}`
 * source (a base table OR a further sibling CTE) passes — the recursion handles the latter.
 */
function assertInlinableInner(inner: AST.CommonTableExpr): void {
	const q = inner.query;
	const name = inner.name;
	if (q.type !== 'select') {
		reject('no-base-lineage', name, `cannot write through common table expression '${name}': its ${q.type.toUpperCase()} body has no recoverable base operation`);
	}
	// A body carrying its own WITH clause is scoped to that clause; inlining it would drop the
	// nested CTEs its FROM may reference. Reject cleanly rather than risk a dangling reference.
	if (q.withClause) {
		reject('no-base-lineage', name, `cannot write through common table expression '${name}': a body that carries its own WITH clause is not inlinable and is not updateable in phase 1`);
	}
	if (q.distinct) {
		reject('unsupported-distinct', name, `cannot write through common table expression '${name}': a DISTINCT intermediate has no 1:1 base-row lineage and is not updateable in phase 1`);
	}
	if (q.limit || q.offset) {
		reject('unsupported-limit', name, `cannot write through common table expression '${name}': a LIMIT/OFFSET intermediate is not updateable in phase 1 (a mutation would escape the limited window)`);
	}
	if (q.groupBy || q.having) {
		reject('unsupported-aggregate', name, `cannot write through common table expression '${name}': an aggregate/grouping intermediate is not updateable in phase 1`);
	}
	if (q.compound || q.union) {
		reject('unsupported-set-op', name, `cannot write through common table expression '${name}': a set-operation intermediate is not updateable in phase 1`);
	}
	if (!q.from || q.from.length !== 1) {
		reject('unsupported-join', name, `cannot write through common table expression '${name}': a multi-source (join) intermediate is not updateable in phase 1`);
	}
	const fc = q.from[0];
	if (fc.type === 'join') {
		reject('unsupported-join', name, `cannot write through common table expression '${name}': a join intermediate is not updateable in phase 1`);
	}
	if (fc.type !== 'table') {
		// A FROM subquery source / table-valued function — no recoverable base lineage.
		reject('no-base-lineage', name, `cannot write through common table expression '${name}': its body has no recoverable base table and is not updateable in phase 1`);
	}
}

/**
 * Compose the consumer body over the already-flattened inner body: substitute references to
 * the inner source with its defining expressions, conjoin the two filters, and re-point the
 * FROM at the terminal base table. The consumer's own shape clauses (`distinct` / `limit` /
 * `group by` / `compound` / …) ride through unchanged (carried by the spread, scalar clauses
 * substituted) so a non-updateable CONSUMER is still rejected — by the final `analyzeView`.
 */
function composeBody(
	ctx: PlanningContext,
	consumer: AST.SelectStmt,
	innerFlat: AST.SelectStmt,
	inner: AST.CommonTableExpr,
	sourceName: string,
): AST.SelectStmt {
	const lcSource = sourceName.toLowerCase();

	// The inner's output columns: output-name → defining expression (already in base terms).
	// `null` ⇒ the identity-strip fast path (`select *` inner with no rename): no map, no
	// schema touch — substitution merely drops the `sourceName.` qualifier.
	const innerColumns = resolveInnerColumns(ctx, innerFlat, inner);
	const { topSubst, nestedSubst } = makeSubstitutions(lcSource, innerColumns);
	// Alias-shadow-aware descent: a subquery nested in the consumer that re-binds `sourceName`
	// as a LOCAL FROM alias shadows it, so a `sourceName.`-qualified ref there is local to the
	// nested scope and is NOT rewritten to the inner CTE's defining term (silent-wrong otherwise).
	const descend = (q: AST.QueryExpr): AST.QueryExpr => transformAliasScopedQuery(q, nestedSubst);
	const sub = (e: AST.Expression): AST.Expression => transformExpr(e, topSubst, descend);

	const columns = composeColumns(consumer.columns, innerFlat.columns, innerColumns, sub);

	const consumerWhere = consumer.where ? sub(consumer.where) : undefined;
	const innerWhere = innerFlat.where ? cloneExpr(innerFlat.where) : undefined;
	const where = combineAnd(consumerWhere, innerWhere);

	return {
		...consumer,
		withClause: undefined,
		columns,
		from: cloneTableFrom(innerFlat.from),
		where,
		// Substitute the carried-over scalar shape clauses so they bind against the terminal
		// base table (a non-updateable consumer still rejects, but the plan must BUILD to reach
		// the reject). The `compound` / `union` legs ride untouched — a set-op consumer rejects
		// `unsupported-set-op` at the SetOperation node before any leg is evaluated.
		groupBy: consumer.groupBy?.map(sub),
		having: consumer.having ? sub(consumer.having) : undefined,
		orderBy: consumer.orderBy?.map(ob => ({ ...ob, expr: sub(ob.expr) })),
		limit: consumer.limit ? sub(consumer.limit) : undefined,
		offset: consumer.offset ? sub(consumer.offset) : undefined,
		defaults: mergeDefaults(innerFlat.defaults, consumer.defaults),
	};
}

interface InnerColumn {
	readonly name: string;
	readonly expr: AST.Expression;
}

/**
 * Resolve the inner flattened body's output columns to `{ name, defining-expr }` pairs, or
 * `null` for the identity-strip fast path — a pure `select *` inner with no rename, where the
 * consumer's references resolve to the base table by simply dropping the source qualifier (no
 * schema lookup, no map). The only schema touch is a rename over a `select *` inner, which
 * needs the base table's column list to pair the renamed names with positions.
 */
function resolveInnerColumns(
	ctx: PlanningContext,
	innerFlat: AST.SelectStmt,
	inner: AST.CommonTableExpr,
): InnerColumn[] | null {
	const rename = inner.columns;
	if (isPureStar(innerFlat.columns)) {
		if (!rename || rename.length === 0) return null; // identity strip — no schema touch
		const baseCols = baseColumnsOf(ctx, innerFlat);
		if (!baseCols) {
			reject('no-base-lineage', inner.name, `cannot write through common table expression '${inner.name}': a column rename over a 'select *' body whose source columns are not statically resolvable cannot be inlined`);
		}
		if (baseCols.length !== rename.length) {
			reject('no-base-lineage', inner.name, `cannot write through common table expression '${inner.name}': its ${rename.length} renamed columns do not match the ${baseCols.length}-column base source`);
		}
		return rename.map((nm, i) => ({ name: nm, expr: columnExpr(baseCols[i]) }));
	}

	// Explicit projection: each output column maps to its (already base-term) defining
	// expression, named by the rename list when present, else by the column's own output name.
	const out: InnerColumn[] = [];
	innerFlat.columns.forEach((rc, i) => {
		if (rc.type === 'all') {
			// A `select *, extra` mix — too ambiguous to pair with a positional rename. The base
			// columns expand identity-named; reject if a rename is present (it cannot be aligned).
			if (rename && rename.length > 0) {
				reject('no-base-lineage', inner.name, `cannot write through common table expression '${inner.name}': a column rename over a 'select *, …' projection cannot be inlined`);
			}
			const baseCols = baseColumnsOf(ctx, innerFlat);
			if (!baseCols) {
				reject('no-base-lineage', inner.name, `cannot write through common table expression '${inner.name}': a 'select *' projection whose source columns are not statically resolvable cannot be inlined`);
			}
			for (const bc of baseCols) out.push({ name: bc, expr: columnExpr(bc) });
			return;
		}
		const name = rename?.[i] ?? rc.alias ?? inferredName(rc.expr);
		if (name === undefined) {
			reject('no-base-lineage', inner.name, `cannot write through common table expression '${inner.name}': an unnamed projection column cannot be referenced by an inlining consumer`);
		}
		out.push({ name, expr: rc.expr });
	});
	return out;
}

/**
 * Build the two substitution closures threaded into the consumer rewrite:
 *  - `topSubst` rewrites a TOP-LEVEL reference to the inner source — bare (the body's single
 *    FROM source) or `sourceName`-qualified — to its inner defining expression.
 *  - `nestedSubst` (used inside subquery operands, where a bare name binds to the subquery's
 *    own scope) rewrites ONLY a `sourceName`-qualified correlation — and ONLY while `sourceName`
 *    is not shadowed by a nested FROM alias. A subquery that re-binds `sourceName` as a LOCAL
 *    FROM alias makes a `sourceName.`-qualified ref local to that scope (innermost-scope SQL
 *    rules), so it must NOT be rewritten to the inner CTE's defining term. The descent
 *    ({@link transformAliasScopedQuery}) threads the FROM-alias shadow set into `nestedSubst`.
 * The identity-strip path mirrors the same split: `topSubst` drops the `sourceName.` qualifier;
 * `nestedSubst` does too but only when `sourceName` is unshadowed. Bare names are left untouched
 * (they already resolve to the base table after the FROM re-point).
 */
function makeSubstitutions(
	lcSource: string,
	innerColumns: InnerColumn[] | null,
): { topSubst: (col: AST.ColumnExpr) => AST.Expression | undefined; nestedSubst: (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>) => AST.Expression | undefined } {
	if (innerColumns === null) {
		const stripTop = (col: AST.ColumnExpr): AST.Expression | undefined =>
			col.table && col.table.toLowerCase() === lcSource ? { type: 'column', name: col.name } : undefined;
		const stripNested = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined =>
			col.table && col.table.toLowerCase() === lcSource && !aliasShadow.has(lcSource) ? { type: 'column', name: col.name } : undefined;
		return { topSubst: stripTop, nestedSubst: stripNested };
	}
	const map = new Map<string, AST.Expression>();
	for (const ic of innerColumns) map.set(ic.name.toLowerCase(), ic.expr);
	// transformExpr clones the returned replacement, so handing back the shared `ic.expr` is safe.
	const lookup = (name: string): AST.Expression | undefined => map.get(name.toLowerCase());
	const topSubst = (col: AST.ColumnExpr): AST.Expression | undefined => {
		if (col.table) return col.table.toLowerCase() === lcSource ? lookup(col.name) : undefined;
		return lookup(col.name);
	};
	const nestedSubst = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined =>
		col.table && col.table.toLowerCase() === lcSource && !aliasShadow.has(lcSource) ? lookup(col.name) : undefined;
	return { topSubst, nestedSubst };
}

/**
 * Build the flattened body's projection. A pure `select *` consumer passes the inner's output
 * through (verbatim star for the identity case, else re-aliased to the inner output names — so
 * a rename rides through); an explicit consumer substitutes each column's expression, pinning
 * the consumer's output name as an alias so it survives the substitution.
 */
function composeColumns(
	consumerCols: AST.ResultColumn[],
	innerFlatCols: AST.ResultColumn[],
	innerColumns: InnerColumn[] | null,
	sub: (e: AST.Expression) => AST.Expression,
): AST.ResultColumn[] {
	if (isPureStar(consumerCols)) {
		if (innerColumns === null) return innerFlatCols.map(cloneResultColumn);
		return innerColumns.map(ic => ({ type: 'column', expr: cloneExpr(ic.expr), alias: ic.name }));
	}
	const out: AST.ResultColumn[] = [];
	for (const rc of consumerCols) {
		if (rc.type === 'all') {
			if (innerColumns === null) out.push({ type: 'all' });
			else for (const ic of innerColumns) out.push({ type: 'column', expr: cloneExpr(ic.expr), alias: ic.name });
			continue;
		}
		out.push({ type: 'column', expr: sub(rc.expr), alias: rc.alias ?? inferredName(rc.expr), inverse: cloneInverse(rc.inverse) });
	}
	return out;
}

/** Merge two `with defaults (…)` lists, consumer winning on a column-name collision. */
function mergeDefaults(
	innerDefaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
	consumerDefaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
): ReadonlyArray<AST.ViewInsertDefault> | undefined {
	if (!innerDefaults && !consumerDefaults) return undefined;
	const byColumn = new Map<string, AST.ViewInsertDefault>();
	for (const d of innerDefaults ?? []) byColumn.set(d.column.toLowerCase(), d);
	for (const d of consumerDefaults ?? []) byColumn.set(d.column.toLowerCase(), d);
	return [...byColumn.values()].map(d => ({ ...d, expr: cloneExpr(d.expr) }));
}

// --- small AST helpers -----------------------------------------------------

/** True iff a projection list is a single bare/`a.*` star (full passthrough). */
function isPureStar(cols: AST.ResultColumn[]): boolean {
	return cols.length === 1 && cols[0].type === 'all';
}

/** The output name a projection expression carries when unaliased — a column name, else none. */
function inferredName(expr: AST.Expression): string | undefined {
	return expr.type === 'column' ? expr.name : undefined;
}

function columnExpr(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

/** The CTEs of `visible` defined strictly before `inner` (its in-scope prior siblings). */
function ctesBefore(visible: ReadonlyArray<AST.CommonTableExpr>, inner: AST.CommonTableExpr): AST.CommonTableExpr[] {
	const idx = visible.indexOf(inner);
	return idx <= 0 ? [] : visible.slice(0, idx);
}

/** Clone a (single terminal base-table) FROM clause, severing identifier sharing. */
function cloneTableFrom(from: AST.FromClause[] | undefined): AST.FromClause[] {
	return (from ?? []).map(fc => fc.type === 'table' ? { ...fc, table: { ...fc.table } } : { ...fc });
}

/** Structural clone of one projection column (used for the passthrough star case). The
 *  `with inverse` clause is deep-cloned too, severing all sharing with the source AST — the
 *  invariant the scope-transform clones uphold (in-place rewriters mutate the produced tree). */
function cloneResultColumn(rc: AST.ResultColumn): AST.ResultColumn {
	return rc.type === 'all' ? { ...rc } : { ...rc, expr: cloneExpr(rc.expr), inverse: cloneInverse(rc.inverse) };
}

/** Deep-clone a result column's `with inverse (col = expr, …)` list, severing expr sharing. */
function cloneInverse(
	inverse: ReadonlyArray<AST.ResultColumnInverse> | undefined,
): AST.ResultColumnInverse[] | undefined {
	return inverse?.map(a => ({ ...a, expr: cloneExpr(a.expr) }));
}

/**
 * The base table's column names for a flattened body whose FROM is one base table, or null.
 *
 * Path-aware (`findTable` against `ctx.schemaPath`), not a fixed-schema `getTable`: the
 * flattened body is planned on this same context, so a fixed-schema lookup would report
 * an off-current-schema base table as unresolvable and reject a rename-over-`select *`
 * chain the plan resolves fine — the same defect fixed in `scope-transform.ts`'s
 * `tableSourceColumnNames` (the FROM-source lookup behind `collectFromColumnNames`).
 *
 * Unlike that one this needs no home-schema swap. A CTE write target is EPHEMERAL — its
 * body comes from the caller's own statement, never from a stored view definition — so
 * the caller's search path IS the right environment and there is no `StoredBodyEnv` to
 * re-enter.
 */
function baseColumnsOf(ctx: PlanningContext, innerFlat: AST.SelectStmt): string[] | null {
	const fc = innerFlat.from?.[0];
	if (!fc || fc.type !== 'table') return null;
	const table = ctx.schemaManager.findTable(fc.table.name, fc.table.schema, ctx.schemaPath);
	return table ? table.columns.map(c => c.name) : null;
}

function reject(reason: MutationDiagnosticReason, table: string, message: string): never {
	raiseMutationDiagnostic({ reason, table, message });
}
