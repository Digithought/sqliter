import type * as AST from '../../parser/ast.js';
import { spineCloneAst } from '../../util/ast-spine-clone.js';
import { eq, objectRefKeySchema, rewriteEach, type ResolveColumnInSource, type ResolveObjectRef, type RowImageContext } from './shared.js';

/**
 * Scope-aware, in-place column-rename walkers: propagate `ALTER TABLE … RENAME
 * COLUMN` into dependent object ASTs (view bodies, CHECK expressions, partial
 * index predicates, column DEFAULT / generated expressions), plus the
 * read-only column-reference probes built on them. What a bare, unbound
 * `new.` / `old.` qualifier means is NOT tied to the entry point: every entry
 * point takes an explicit {@link RowImageContext} argument, threaded to the
 * position in the tree; see {@link matchesRowImage}.
 */

interface ScopeFrame {
	/**
	 * Lowercase qualifier → resolved object key, one entry per FROM source: the
	 * source's alias when it carries one, its bare table / exposing-CTE name
	 * otherwise. Every entry BINDS unqualified column names in this frame (an
	 * alias adds a qualifier; it does not remove the source's columns from
	 * scope — a bare `x` under `from t a` binds `t.x` exactly as it would under
	 * `from t`) and every entry is usable AS a qualifier. Correspondingly, an
	 * aliased source does NOT register its bare name: `select t.x from t a`
	 * doesn't plan, so nothing here may claim it does.
	 */
	qualifiers: Map<string, string>;
	/** Lowercase CTE names declared in this WITH that re-expose the renamed column. */
	ctesExposingRenamed: Set<string>;
	/** Lowercase CTE names declared in this WITH (regardless of whether they re-expose). */
	ctesInScope: Set<string>;
	/**
	 * Lowercase qualifier names in this frame (alias if the source is
	 * aliased, otherwise the source name) that resolve to a non-exposing
	 * shadowing CTE and therefore must NOT be treated as a direct reference
	 * to the renamed real table for qualified column refs.
	 */
	ctesShadowingSource: Set<string>;
	/**
	 * Real-table sources in this frame's FROM, under their RESOLVED identity
	 * (the object key plus its lowercase schema/name parts). Used by the
	 * unqualified-scope walk to ask whether an inner FROM source exposes the
	 * renamed column — if it does, the unqualified ref binds there and an
	 * outer seed binding to the renamed table must not capture it. Aliased and
	 * unaliased real sources alike are recorded, in step with `qualifiers`
	 * binding both. Subquery / function-source / CTE-shadowed sources are NOT
	 * recorded (the rewriter can't ask the callback about those without
	 * recursive analysis).
	 */
	realSources: Array<{ key: string; schemaLower: string; nameLower: string }>;
}

// ──────────────────────────────────────────────────────────────────────
// Column rename
// ──────────────────────────────────────────────────────────────────────

/**
 * Rewrite column references inside a full statement/expression AST, resolving
 * unqualified refs against the FROM scopes the walk descends (no implicit seed,
 * unlike {@link renameColumnInCheckExpression}). The walk descends a select
 * body's trailing `with defaults (…)` clause ({@link AST.SelectStmt.defaults}),
 * whose entry exprs evaluate in the body's FROM scope.
 *
 * `rowImage` says what a bare, unbound `new.` / `old.` qualifier means in the
 * walked expression — independent of the (absent) seed; see
 * {@link RowImageContext} and {@link matchesRowImage}. A view / assertion body
 * is `'none'` (no written-row context — `new.x` is an ordinary table
 * reference); another table's CHECK / DEFAULT / generated body is `'foreign'`
 * (written-row context whose image belongs to that table, so the qualifier
 * names nothing this walk cares about).
 *
 * When `resolveColumnInSource` is supplied, the scope walk consults it at each
 * inner FROM frame so an unqualified ref that legitimately binds to a like-named
 * column on a subquery's own FROM source is NOT false-captured by an enclosing
 * binding (e.g. a `with defaults` expr `cap + (select max(cap) from lim)` under
 * a `t.cap` rename must leave the inner `lim.cap` untouched). The same callback
 * infrastructure backs {@link renameColumnInCheckExpression}; both the forward
 * propagation (live schema lookup) and the differ's inverse reconcile
 * (declared-side resolver) pass it so the two stay in parity.
 */
export function renameColumnInAst(
	node: AST.AstNode | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	rowImage: RowImageContext,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!node) return false;
	const state: ColumnRewriteState = {
		tableName: tableName.toLowerCase(),
		oldCol: oldColName.toLowerCase(),
		newCol: newColName,
		resolveRef: resolve,
		targetKey,
		scopeStack: [],
		changed: false,
		resolveColumnInSource,
		rowImage,
	};
	visitColumnRename(node, state);
	return state.changed;
}

/**
 * Rewrite a column reference inside a CHECK expression. Unlike
 * `renameColumnInAst`, this entry point seeds the scope stack with an
 * implicit unaliased binding to `tableName` so top-level unqualified
 * `ColumnExpr` nodes resolve to the owning table. CHECK expressions
 * cannot reference other tables at top level, so the implicit binding
 * is safe there.
 *
 * When `resolveColumnInSource` is supplied, the scope walk consults it at
 * each inner FROM frame: if any real-table source in that frame exposes
 * `oldColName`, the unqualified ref binds inside the subquery and the
 * walk stops before reaching the seed. This stops the rewriter from
 * false-positively rewriting an inner unqualified ref that legitimately
 * binds to a like-named column on the subquery's FROM (e.g.
 * `check ((select min(v) from u) > 0)` when `u` also has a `v` column).
 *
 * Limitation: subquery / function-source inner sources are not asked (the
 * rewriter would need recursive column-set inference on their bodies), so an
 * unqualified ref binding only through one of those falls through to the seed.
 * An ALIASED real source is asked like any other — an alias adds a qualifier,
 * it does not take the source's columns out of scope. `renameColumnInAst`
 * shares the same callback (passed by the view-body callers) and the same
 * residual.
 *
 * The seed and the `new.` / `old.` **row-image** namespace are INDEPENDENT: the
 * seed answers how *unqualified* refs bind, while the explicit `rowImage`
 * argument answers what a bare, unbound `new.` / `old.` qualifier names (see
 * {@link RowImageContext}). A CHECK / DEFAULT / generated body of the renamed
 * table itself passes `'own'` — those expressions evaluate against the row
 * being written, so `check (new.a > 0)` (`docs/sql-ddl.md` § CHECK Constraints)
 * names the owning table's row image and matches. A partial-index predicate is
 * seeded too but passes `'none'`: it describes rows already stored, with no
 * written-row context.
 *
 * The `'own'` match is scope-**aware**, not depth-blind, because `new` and `old`
 * are not reserved words in this parser: `create table "new" (…)` is legal, so a
 * CHECK may legitimately contain `(select max("new".a) from "new")`. The match
 * therefore requires that no FROM/WITH frame above the seed rebind the
 * qualifier — see `matchesRowImage`.
 */
export function renameColumnInCheckExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	rowImage: RowImageContext,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!expr) return false;
	const state: ColumnRewriteState = {
		tableName: tableName.toLowerCase(),
		oldCol: oldColName.toLowerCase(),
		newCol: newColName,
		resolveRef: resolve,
		targetKey,
		scopeStack: [],
		changed: false,
		resolveColumnInSource,
		rowImage,
	};
	const frame = emptyFrame();
	frame.qualifiers.set(state.tableName, state.targetKey);
	state.scopeStack.push(frame);
	try {
		visitColumnRename(expr, state);
	} finally {
		state.scopeStack.pop();
	}
	return state.changed;
}

/**
 * Sentinel rename target for the read-only column probes: the two below, and
 * the drop verb's republication fixpoint
 * (`schema/column-republication.ts`), which probes exposure the same way. No
 * user column can hold this name, and the probe rewrites *to* it, so it can
 * never collide with anything the walk is looking for.
 */
export const PROBE_COLUMN_NAME = '__quereus_column_probe__';

/**
 * Whether `node` refers to `tableName`.`columnName` — read-only with respect to
 * the caller's AST; a throwaway {@link spineCloneAst} copy is what gets
 * rewritten.
 *
 * Same equivalence {@link tableReferencedInAst} establishes for the table verb,
 * and for the same reason: "refers to" must mean "would have been rewritten by
 * `ALTER TABLE … RENAME COLUMN`", or a DROP guard built on it refuses a
 * different set of cases than the rename follows. See that function's comment
 * for why the column verb reaches it by clone+sentinel rather than by `dryRun`.
 *
 * `resolveColumnInSource` is **not optional in practice**: without it the walk
 * has no way to tell that an unqualified ref inside a subquery binds to a
 * like-named column on the subquery's own FROM source, and a caller asking
 * "does this body name `t.v`?" gets `true` for a body whose only `v` is
 * another table's. Every caller should pass the catalog-backed resolver
 * (`buildColumnSourceResolver`).
 *
 * NOTE: one spine clone plus one walk per probe, and the DROP COLUMN guard probes every
 * live assertion. Trivial at the handful-of-assertions scale schemas have today, and it
 * only runs on DDL; if a schema ever carries assertions by the hundred, filter by
 * `tableReferencedInAst` (no clone) before paying for the column probe.
 */
export function columnReferencedInAst(
	node: AST.AstNode | undefined,
	tableName: string,
	columnName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	rowImage: RowImageContext,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!node) return false;
	return renameColumnInAst(
		spineCloneAst(node), tableName, columnName, PROBE_COLUMN_NAME,
		resolve, targetKey, rowImage, resolveColumnInSource);
}

/**
 * {@link columnReferencedInAst} for an expression that resolves unqualified refs
 * against an implicit binding to `tableName` — a CHECK expression or a
 * partial-index predicate. Uses {@link renameColumnInCheckExpression}'s seeded
 * entry point so the probe answers for exactly the scope that expression is
 * planned in.
 */
export function columnReferencedInCheckExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	columnName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	rowImage: RowImageContext,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!expr) return false;
	return renameColumnInCheckExpression(
		spineCloneAst(expr), tableName, columnName, PROBE_COLUMN_NAME,
		resolve, targetKey, rowImage, resolveColumnInSource);
}

/**
 * Rewrite the renamed column inside every partial-index predicate of `indexes`,
 * in place. A predicate resolves unqualified refs against the indexed table
 * itself — the same implicit seed a CHECK expression uses — so
 * {@link renameColumnInCheckExpression} is the correct entry point here, not
 * {@link renameColumnInAst}.
 *
 * The predicate `Expression` is shared by reference between the catalog's
 * `TableSchema`, any module-local copy of it, and — for a unique partial index —
 * the `derivedFromIndex` UNIQUE constraint that carries the same predicate.
 * Rewriting in place keeps all of them in step; cloning would strand the derived
 * constraint on the old AST.
 *
 * Idempotent: once rewritten, nothing names `oldColName` any more, so a second
 * call with the same pair returns false without touching the AST.
 *
 * The parameter is structurally typed rather than `IndexSchema[]` so this module
 * stays free of catalog imports; `IndexSchema` satisfies it.
 *
 * Row-image mode is `'none'`: a partial-index predicate describes rows already
 * stored, so it has no written-row context and a bare `new.` / `old.` qualifier
 * there is an ordinary table reference — the same asymmetry
 * {@link import('./table-rename.js').renameTableInIndexPredicates} records by
 * passing no `rowImageContext`. (An indexed table literally named `new` still
 * matches through the seed binding, so this changes no answer for the case
 * that plans.)
 */
export function renameColumnInIndexPredicates(
	indexes: ReadonlyArray<{ readonly predicate?: AST.Expression }> | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	return rewriteEach(indexes, idx => idx.predicate, expr => renameColumnInCheckExpression(
		expr, tableName, oldColName, newColName, resolve, targetKey, 'none', resolveColumnInSource));
}

/**
 * Rewrite the renamed column inside every CHECK constraint expression of `checks`
 * belonging to the renamed table itself, in place. The seeded-scope entry point
 * applies for the same reason it does for a partial-index predicate: a CHECK
 * resolves unqualified refs against its owning table.
 *
 * Only pass the renamed table's OWN checks — a CHECK on a *different* table that
 * happens to reference the renamed table needs {@link renameColumnInAst}, whose
 * walk has no implicit seed. That own-table contract is also why the row-image
 * mode is hardcoded `'own'` here: a CHECK evaluates against the row being
 * written, whose image IS the renamed table's.
 */
export function renameColumnInCheckConstraints(
	checks: ReadonlyArray<{ readonly expr: AST.Expression }> | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	return rewriteEach(checks, cc => cc.expr, expr => renameColumnInCheckExpression(
		expr, tableName, oldColName, newColName, resolve, targetKey, 'own', resolveColumnInSource));
}

/**
 * Rewrite the renamed column inside the two expressions a `ColumnSchema` can carry —
 * a column DEFAULT (`b integer default (new.a + 1)`, however authored: inline, or via
 * `ALTER TABLE … ALTER COLUMN … SET DEFAULT`, which writes the same field) and a
 * generated column's body (`g integer generated always as (a + 1)`) — in place, for
 * every column of the renamed table itself.
 *
 * The seeded {@link renameColumnInCheckExpression} entry point with row-image mode
 * `'own'` is correct for both:
 *
 * - The implicit unaliased binding to the owning table is what makes a generated
 *   column's **bare** `a` resolve — it has no FROM clause to bind against, exactly like
 *   a CHECK.
 * - The `'own'` mode is what makes a default's `new.a` resolve. A default is evaluated
 *   against the row being written, so that qualifier names this table's row image, not
 *   anything a FROM binds.
 *
 * Case folding (`NEW.A`) and the shadowing edge (a real table literally named `new`,
 * reached from a subquery inside the expression) therefore behave exactly as they do for
 * a CHECK, because the same walk decides all three.
 *
 * Only pass the renamed table's OWN columns. A default on a *different* table can reach
 * this table only through a subquery, so an unqualified ref there must bind inside that
 * subquery's FROM — that caller wants {@link renameColumnInAst}, whose walk has no seed.
 *
 * Same sharing and idempotence story as {@link renameColumnInCheckConstraints}: a
 * module's rename hook rebuilds only the renamed column's `ColumnSchema` and keeps every
 * other one by reference, and even the rebuilt one carries the SAME expression nodes
 * (`buildConstraintsFromColumn` passes them into the reconstructed `ColumnDef` by
 * reference and `columnDefToSchema` assigns them straight back), so one in-place rewrite
 * reaches every holder and a second call with the same pair is a no-op.
 *
 * The parameter is structurally typed rather than `ColumnSchema[]` so this module stays
 * free of catalog imports; `ColumnSchema` satisfies it.
 */
export function renameColumnInColumnExpressions(
	columns: ReadonlyArray<{
		readonly defaultValue?: AST.Expression | null;
		readonly generatedExpr?: AST.Expression;
	}> | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	const rewrite = (expr: AST.Expression): boolean => renameColumnInCheckExpression(
		expr, tableName, oldColName, newColName, resolve, targetKey, 'own', resolveColumnInSource);
	// Both walks always run — `||` on the results, not short-circuited between them.
	const defaultsChanged = rewriteEach(columns, c => c.defaultValue ?? undefined, rewrite);
	const generatedChanged = rewriteEach(columns, c => c.generatedExpr, rewrite);
	return defaultsChanged || generatedChanged;
}

/**
 * Whether `body`'s top-level result columns publish the renamed column under
 * `newColName` — i.e. whether rewriting this body shifted the name its readers
 * see. Call AFTER the body rewrite: the predicate compares against the NEW
 * name, exactly as the CTE exposure analysis it shares its internals with
 * ({@link cteExposesRenamedColumn} / `isResultColumnExposure`). An explicit
 * result-column alias suppresses exposure; a bare projection of the renamed
 * column, or a `*` / `t.*` / `a.*` whose frame binds the target, exposes it —
 * a FROM alias is no obstacle, since it only changes which qualifier names the
 * source.
 *
 * An explicit view / materialized-view column list pins the published names
 * regardless of the body — that guard belongs at the call site
 * (`ViewSchema.columns` / `TableDerivation.columns` play the role
 * `cte.columns` plays inside the CTE analysis; this predicate never sees them).
 */
export function bodyExposesRenamedColumn(
	body: AST.QueryExpr | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!body) return false;
	const state: ColumnRewriteState = {
		tableName: tableName.toLowerCase(),
		oldCol: oldColName.toLowerCase(),
		newCol: newColName,
		resolveRef: resolve,
		targetKey,
		scopeStack: [],
		changed: false,
		resolveColumnInSource,
		// Exposure is a question about published output names, not row images —
		// `'none'` unconditionally (a `new.`-qualified projection is never a bare
		// passthrough, so the mode cannot matter to the answer).
		rowImage: 'none',
	};
	return queryExposesRenamedColumn(body, state);
}

/**
 * Sentinel target key for {@link bodyPublishesColumnNamed}'s throwaway walk
 * state: the frame machinery wants a rename target, but this probe must match
 * nothing — real object keys are `<schema>.<name>` built from identifiers,
 * which never contain a NUL.
 */
const PROBE_TARGET_KEY = '\u0000.\u0000';

/**
 * Whether `body`'s top-level result columns publish a column named
 * `columnName`, from ANY origin: an explicit alias, an unaliased bare
 * projection of a column so named (wherever it binds), or a `*` / `t.*` whose
 * bound real-table source exposes it (asked through `resolveColumnInSource`).
 *
 * The collision half of the rename-cascade pre-flight
 * (`runtime/emit/column-rename-cascade.ts`): run against the PRISTINE
 * (pre-rewrite) body with `columnName = newCol` — the rename target cannot
 * publish `newCol` before the rename, so anything found is necessarily a
 * DIFFERENT column the shifted name would collide with.
 *
 * Shares the walker's scope residual: a `*` over a subquery or function source
 * has no askable column set, so a publication arriving only that way is not
 * seen. A `*` over an aliased REAL source is seen — the alias binds like any
 * other qualifier.
 */
export function bodyPublishesColumnNamed(
	body: AST.QueryExpr | undefined,
	columnName: string,
	resolve: ResolveObjectRef,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!body || body.type !== 'select') return false;
	const select = body as AST.SelectStmt;
	const nameLower = columnName.toLowerCase();
	const state: ColumnRewriteState = {
		tableName: '\u0000',
		oldCol: '\u0000',
		newCol: '\u0000',
		resolveRef: resolve,
		targetKey: PROBE_TARGET_KEY,
		scopeStack: [],
		changed: false,
		resolveColumnInSource,
		rowImage: 'none',
	};
	const withFrame = analyzeWithFrame(select.withClause, state);
	state.scopeStack.push(withFrame);
	try {
		const frame = buildScopeFrame(select.from, state);
		for (const col of select.columns ?? []) {
			if (resultColumnPublishesName(col, frame, nameLower, resolveColumnInSource)) return true;
		}
		return false;
	} finally {
		state.scopeStack.pop();
	}
}

/** One result column's published-name test for {@link bodyPublishesColumnNamed}. */
function resultColumnPublishesName(
	col: AST.ResultColumn,
	frame: ScopeFrame,
	nameLower: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (col.type === 'all') {
		if (!resolveColumnInSource) return false;
		if (col.table === undefined) {
			return frame.realSources.some(src => resolveColumnInSource(src.schemaLower, src.nameLower, nameLower));
		}
		const key = frame.qualifiers.get(col.table.toLowerCase());
		if (key === undefined) return false;
		return frame.realSources.some(src => src.key === key
			&& resolveColumnInSource(src.schemaLower, src.nameLower, nameLower));
	}
	if (col.alias !== undefined) return col.alias.toLowerCase() === nameLower;
	return col.expr.type === 'column' && (col.expr as AST.ColumnExpr).name.toLowerCase() === nameLower;
}

interface ColumnRewriteState {
	/** Lowercase bare name of the renamed table (seed qualifier, row-image and CTE bookkeeping). */
	tableName: string;
	oldCol: string;
	newCol: string;
	/** Planner-parity reference resolution under the walked body's home schema path. */
	resolveRef: ResolveObjectRef;
	/** Canonical key of the renamed table — what a reference must resolve to, to match. */
	targetKey: string;
	scopeStack: ScopeFrame[];
	changed: boolean;
	resolveColumnInSource?: ResolveColumnInSource;
	/**
	 * What a bare, unbound `new.` / `old.` qualifier names at the CURRENT
	 * position — the caller's mode for the walked expression, overridden to
	 * `'foreign'` while the walk descends a `with inverse` / `with defaults`
	 * subtree (whose `new.` refs belong to the enclosing select, never to any
	 * rename target — see the select arm of {@link visitColumnRename}). Decides
	 * only the unbound-bare case in {@link matchesRowImage}; an in-scope binding
	 * or a schema qualifier always wins first.
	 */
	rowImage: RowImageContext;
}

function emptyFrame(): ScopeFrame {
	return {
		qualifiers: new Map(),
		ctesExposingRenamed: new Set(),
		ctesInScope: new Set(),
		ctesShadowingSource: new Set(),
		realSources: [],
	};
}

function buildScopeFrame(from: AST.FromClause[] | undefined, state: ColumnRewriteState): ScopeFrame {
	const frame = emptyFrame();
	if (!from) return frame;
	for (const item of from) {
		collectFromBindings(item, state, frame);
	}
	return frame;
}

/**
 * Bind a FROM source's one qualifier in `frame`, FIRST-write-wins.
 *
 * The order only matters when two sources in one FROM claim the same qualifier
 * (`from t join u as t`), which is legal here — the planner accepts it and
 * resolves a qualified ref to the FIRST such source in FROM order (`select t.k
 * from t join u as t` reads `t`; `from u as t join t` reads `u`; a BARE `k` is
 * rejected as ambiguous either way). Measured against the engine, not assumed.
 * Skipping the overwrite is what keeps {@link resolveQualifierBinding} agreeing
 * with that, now that one map holds aliases and bare names together — a
 * two-map lookup used to answer alias-first, which matched the planner only
 * when the aliased source came first.
 *
 * First-wins matches how the planner resolves a qualified COLUMN, but the planner
 * expands a qualified STAR by name-matching every source, so `select t.* from u as
 * t join t` yields both sources' columns while this walk sees only `u` — the
 * engine disagreeing with itself about a duplicated qualifier, tracked by
 * `bug-duplicate-from-qualifier-resolves-inconsistently`. Making this walk match
 * the star would just pick the other side of the disagreement; the ticket's fix is
 * to reject the duplicate at build time, after which the question stops existing.
 */
function bindQualifier(frame: ScopeFrame, qualifierLower: string, key: string): void {
	if (!frame.qualifiers.has(qualifierLower)) frame.qualifiers.set(qualifierLower, key);
}

function collectFromBindings(
	item: AST.FromClause,
	state: ColumnRewriteState,
	frame: ScopeFrame,
): void {
	switch (item.type) {
		case 'table': {
			const ts = item as AST.TableSource;
			const name = ts.table.name.toLowerCase();
			// Unqualified reference to a CTE in scope — the CTE shadows any
			// same-named real table. Whether it re-exposes the renamed column
			// determines whether unqualified refs against this source rewrite.
			if (ts.table.schema === undefined && isCteInScope(state, name)) {
				if (isCteExposingInScope(state, name)) {
					// One qualifier either way — the alias when present, the CTE's
					// own name otherwise — and it both binds unqualified refs and
					// serves as a qualifier for refs like `a.k`.
					bindQualifier(frame, ts.alias ? ts.alias.toLowerCase() : name, state.targetKey);
				} else {
					// Shadowing-but-not-exposing: the source binds to the CTE
					// row source, not the renamed real table. Record the
					// qualifier (alias if present, otherwise the source name)
					// so qualified column refs against it don't short-circuit
					// to the renamed table.
					frame.ctesShadowingSource.add(ts.alias ? ts.alias.toLowerCase() : name);
				}
				// Shadowing-but-not-exposing: do not bind as the renamed table.
				break;
			}
			// Resolve the source the way the planner would for this body: home
			// schema path for an unqualified name, passthrough for a qualified
			// one. The KEY is what every capture / qualifier decision compares —
			// a bare `from t` binds the renamed table only when it RESOLVES to
			// it, and `from other_schema.t z` never does just because the bare
			// names collide.
			const key = state.resolveRef(ts.table.schema, ts.table.name);
			if (key === undefined) break;
			// The source's ONE qualifier: its alias when it has one, its bare
			// name otherwise. Either way it binds unqualified refs — an alias
			// does not take the source's columns out of scope — and either way
			// an aliased source stops answering to its bare name (`select t.x
			// from t a` does not plan, so `t` must not register).
			bindQualifier(frame, ts.alias ? ts.alias.toLowerCase() : name, key);
			// Record as a real-table source (under its RESOLVED schema) so the
			// unqualified-scope walk can ask whether this source exposes the
			// renamed column. Both aliased and unaliased real sources are
			// recorded — asking "does u expose col v" is the same question
			// regardless of any alias.
			frame.realSources.push({ key, schemaLower: objectRefKeySchema(key, name), nameLower: name });
			break;
		}
		case 'join': {
			const join = item as AST.JoinClause;
			collectFromBindings(join.left, state, frame);
			collectFromBindings(join.right, state, frame);
			break;
		}
		case 'subquerySource':
		case 'functionSource':
			// No askable column set without recursive inference on the inner
			// body, so these register no qualifier and no real source — the
			// residual tracked by
			// `bug-column-verbs-blind-to-star-over-subquery-source`.
			break;
	}
}

/**
 * Innermost-first walk: an inner non-exposing same-name CTE shadows an
 * outer exposing one, so a `ctesInScope` hit without a matching
 * `ctesExposingRenamed` entry wins. `isCteInScope` (below) intentionally
 * stays OR-shaped — it only gates "is this source a CTE rather than a
 * real table?", a question for which any enclosing CTE suffices.
 */
function isCteExposingInScope(state: ColumnRewriteState, name: string): boolean {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		if (frame.ctesExposingRenamed.has(name)) return true;
		if (frame.ctesInScope.has(name)) return false;
	}
	return false;
}

function isCteInScope(state: ColumnRewriteState, name: string): boolean {
	for (const frame of state.scopeStack) {
		if (frame.ctesInScope.has(name)) return true;
	}
	return false;
}

/**
 * Whether a BARE (unqualified) column ref at the current position binds the
 * renamed table. Innermost-first: a closer same-name CTE shadows an outer
 * binding to the renamed real table. When a `resolveColumnInSource` callback is
 * configured, also stop at any inner FROM frame whose real sources expose
 * `oldCol` — the unqualified ref binds inside that frame and an outer seed
 * binding must not capture it.
 *
 * Aliased and unaliased sources bind alike here, and the shadow scan over
 * `realSources` widens in step (it records both), so `from u b` still stops an
 * outer capture of a bare `x` that `u` exposes.
 */
function unqualifiedRefBindsTarget(state: ColumnRewriteState): boolean {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		if (frame.ctesInScope.has(state.tableName)) return false;
		if (state.resolveColumnInSource && frame.realSources.length > 0) {
			for (const src of frame.realSources) {
				// The renamed table itself trivially exposes oldCol; defer to
				// the binding check below so we don't double-capture.
				if (src.key === state.targetKey) continue;
				if (state.resolveColumnInSource(src.schemaLower, src.nameLower, state.oldCol)) return false;
			}
		}
		if (frameBindsTarget(frame, state.targetKey)) return true;
	}
	return false;
}

/** Whether any source bound in `frame` resolves to `targetKey`. */
function frameBindsTarget(frame: ScopeFrame, targetKey: string): boolean {
	for (const key of frame.qualifiers.values()) {
		if (key === targetKey) return true;
	}
	return false;
}

/**
 * Resolve a bare column qualifier innermost-first against the scope stack:
 * the resolved key of the table it binds (through an alias, an unaliased
 * source, or an exposing CTE), `null` when it binds something that is not the
 * renamed real table and can never be (a non-exposing shadowing CTE, or a CTE
 * merely in scope), or `undefined` when nothing in scope binds it. The
 * innermost binding decides — standard SQL shadowing. Subquery / function
 * sources are not recorded (pre-existing limitation, shared with the
 * unqualified capture walk), so a qualifier bound only by one of those falls
 * through to the caller's seedless fallback.
 *
 * A qualifier claimed TWICE inside one FROM (`from t join u as t`) is legal and
 * resolves to the FIRST such source; {@link bindQualifier} is what makes that
 * true here, and it is a small IMPROVEMENT on the two-map lookup this replaced
 * (which answered alias-first, and so read `from t join u as t` as `u` where
 * the planner reads it as `t`).
 */
function resolveQualifierBinding(
	state: ColumnRewriteState,
	qualifierLower: string,
): string | null | undefined {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		const bound = frame.qualifiers.get(qualifierLower);
		if (bound !== undefined) return bound;
		if (frame.ctesShadowingSource.has(qualifierLower)) return null;
		if (frame.ctesInScope.has(qualifierLower)) return null;
	}
	return undefined;
}

/**
 * Whether a qualified column ref names a **row image** — `new.<col>` /
 * `old.<col>` in written-row context — and if so, whose. The three-way answer
 * mirrors {@link RowImageContext}:
 *
 * - `'own'`: the image is the walk's target table — the ref matches and the
 *   rename rewrites it (`check (new.a > 0)` on the renamed table itself).
 * - `'foreign'`: written-row context, but the image belongs to some OTHER
 *   relation (another table's CHECK / DEFAULT / generated body, or a
 *   `with inverse` expression whose `new.` names the enclosing select's output
 *   row) — the ref names nothing this walk cares about and must be IGNORED,
 *   not resolved as a table called `new`.
 * - `'none'`: no written-row context here — the qualifier is not a row image
 *   at all, and the caller falls through to ordinary table-reference
 *   resolution.
 *
 * A schema-qualified `main.new.a` is a real three-part table reference, never a
 * row image, so it answers `'none'` outright, as does any qualifier a FROM/WITH
 * frame rebinds (`new` and `old` are not reserved words — `create table "new"`
 * is legal, so `(select max("new".a) from "new")` must keep resolving as a
 * table). Callers reach this only for a qualifier nothing in scope binds, which
 * makes the rebind scan redundant there — kept as a cheap belt-and-braces guard
 * so this function is safe to call from any future site.
 *
 * `qualifierLower` is `col.table` already lowercased by the caller.
 */
function matchesRowImage(state: ColumnRewriteState, col: AST.ColumnExpr, qualifierLower: string): RowImageContext {
	if (state.rowImage === 'none') return 'none';
	if (col.schema !== undefined) return 'none';
	if (qualifierLower !== 'new' && qualifierLower !== 'old') return 'none';
	if (isQualifierReboundAboveSeed(state, qualifierLower)) return 'none';
	return state.rowImage;
}

/**
 * Whether any real FROM / WITH frame rebinds `qualifier` to a row source of its
 * own, which would make a `new.` / `old.` ref name that source rather than the
 * row image. `new` and `old` are not reserved words here — `create table "new"`
 * is legal — so this scan is what stops the row-image match from false-firing
 * inside `check ((select max("new".a) from "new") >= 0)`.
 *
 * The scan starts at index 1: frame 0 is the implicit seed
 * {@link renameColumnInCheckExpression} pushes for the owning table, which is
 * not a FROM binding and must not count as a rebind. All three ways a frame can
 * bind a qualifier are checked — a FROM source's own qualifier (its alias, or
 * its bare name when unaliased), a CTE name in scope, and a
 * shadowing-but-not-exposing CTE source.
 *
 * Deliberately "any enclosing frame wins" rather than innermost-first: a frame
 * only sits above index 0 while the walk is *inside* the subquery that pushed
 * it, so every such frame really does enclose the reference. A top-level
 * `new.a` in `check (new.a > 0 and (select count(*) from "new") >= 0)` is
 * visited with only the seed on the stack and still matches.
 *
 * NOTE: the residual is a *correlated* `new.<col>` written inside a subquery
 * that selects from a real table named `new` — left alone by both the rewrite
 * and the drop refusal, since the qualifier is ambiguous there anyway. If that
 * ever needs to resolve to the row image, it needs a spelling that distinguishes
 * the two (the SQL standard has none), not a change to this scan.
 */
function isQualifierReboundAboveSeed(state: ColumnRewriteState, qualifier: string): boolean {
	for (let i = 1; i < state.scopeStack.length; i++) {
		const frame = state.scopeStack[i];
		if (frame.qualifiers.has(qualifier)) return true;
		if (frame.ctesInScope.has(qualifier)) return true;
		if (frame.ctesShadowingSource.has(qualifier)) return true;
	}
	return false;
}

/**
 * Visit a subtree that is written-row context belonging to the ENCLOSING select
 * — a `with inverse` assignment expression or a `with defaults` entry
 * expression — with the row-image mode forced to `'foreign'`, restoring the
 * ambient mode after. The override is unconditional (not `||`-combined with the
 * ambient mode): even inside a seeded `'own'` walk, a nested select's inverse
 * expression's `new.` refs name THAT select's outputs, not the seeded table's
 * row image.
 */
function visitRowImageForeignSubtree(expr: AST.Expression, state: ColumnRewriteState): void {
	const ambient = state.rowImage;
	state.rowImage = 'foreign';
	try {
		visitColumnRename(expr, state);
	} finally {
		state.rowImage = ambient;
	}
}

function visitColumnRename(node: AST.AstNode | undefined, state: ColumnRewriteState): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = buildScopeFrame(stmt.from, state);
				state.scopeStack.push(frame);
				try {
					// Capture pre-rewrite output names of UNALIASED bare projections: a
					// rename that rewrites one shifts the select's OUTPUT name with it, so
					// any `new.<old>` refs in sibling `with inverse` exprs must follow
					// (a `new.` ref is by view-output name; aliased / computed projections
					// keep their output name, so the body rewrite alone covers them).
					const preOutputNames = (stmt.columns ?? []).map(c =>
						c.type === 'column' && !c.alias && c.expr.type === 'column' ? c.expr.name : undefined);
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') visitColumnRename(c.expr, state);
					});
					// `with inverse` clauses: the assignment target is a bare base-column
					// name resolving against this select's FROM — exactly an unqualified
					// body ref, so it rides the same scope-aware walk via a synthetic
					// probe (the `with defaults` clause below uses the same pattern). The
					// assignment EXPR is written-row context regardless of the ambient
					// mode: its `new.<x>` refs name the enclosing select's OUTPUT row
					// (docs/sql-select.md § Result-column inverses), never any rename
					// target's row image and never a table called `new` — so the walk
					// descends it with the mode forced to `'foreign'` (the legitimate
					// output-name shift is applied separately by
					// {@link renameNewQualifiedRefs} after the body walk). The table
					// walker forces its own suppression over the same subtree.
					(stmt.columns ?? []).forEach(c => {
						if (c.type !== 'column' || !c.inverse?.length) return;
						c.inverse.forEach(a => {
							const probe: AST.ColumnExpr = { type: 'column', name: a.column };
							visitColumnRename(probe, state);
							if (probe.name !== a.column) {
								(a as { column: string }).column = probe.name;
								state.changed = true;
							}
							visitRowImageForeignSubtree(a.expr, state);
						});
					});
					// `with defaults` clause: each entry's `column` is a bare base-column
					// name of this select's FROM (a projected-away base column), so it
					// rides the same scope-aware synthetic probe as a `with inverse`
					// target; the entry's `expr` evaluates in the FROM frame already on
					// the scope stack, so it rewrites like any body expression (an inner
					// subquery in the expr pushes its own frame and disambiguates a
					// like-named column). A defaults entry is documented self-contained —
					// it cannot reference the inserted row (docs/sql-select.md § Insert
					// defaults) — but nothing enforces that at CREATE VIEW time, so the
					// walk pins the documented meaning the same way the inverse arm above
					// does: a bare unbound `new.` / `old.` there is inert, never a
					// reference to a table so named (such a ref could not plan anyway —
					// the lowered INSERT gives the expr no scope that binds `new`).
					(stmt.defaults ?? []).forEach(d => {
						const probe: AST.ColumnExpr = { type: 'column', name: d.column };
						visitColumnRename(probe, state);
						if (probe.name !== d.column) {
							(d as { column: string }).column = probe.name;
							state.changed = true;
						}
						visitRowImageForeignSubtree(d.expr, state);
					});
					const outputRenames = new Map<string, string>();
					(stmt.columns ?? []).forEach((c, i) => {
						const before = preOutputNames[i];
						if (before !== undefined && c.type === 'column' && c.expr.type === 'column' && c.expr.name !== before) {
							outputRenames.set(before.toLowerCase(), c.expr.name);
						}
					});
					// A star projection covering the renamed table exposes the old column
					// name as an OUTPUT name too — the rename shifts it exactly like an
					// unaliased bare projection, so sibling `new.<old>` refs must follow.
					// Skipped when an explicit projection still exposes the old name
					// (first-occurrence resolution keeps `new.<old>` bound to it).
					const hasInverseClauses = (stmt.columns ?? []).some(c => c.type === 'column' && !!c.inverse?.length);
					if (hasInverseClauses && !outputRenames.has(state.oldCol)) {
						const starCoversRenamed = (stmt.columns ?? []).some(c => {
							if (c.type !== 'all') return false;
							if (c.table === undefined) return frameBindsTarget(frame, state.targetKey);
							return frame.qualifiers.get(c.table.toLowerCase()) === state.targetKey;
						});
						const oldStillExposed = (stmt.columns ?? []).some(c => c.type === 'column'
							&& (c.alias
								? c.alias.toLowerCase() === state.oldCol
								: c.expr.type === 'column' && c.expr.name.toLowerCase() === state.oldCol));
						if (starCoversRenamed && !oldStillExposed) {
							outputRenames.set(state.oldCol, state.newCol);
						}
					}
					if (outputRenames.size > 0) {
						(stmt.columns ?? []).forEach(c => {
							if (c.type !== 'column' || !c.inverse?.length) return;
							c.inverse.forEach(a => {
								if (renameNewQualifiedRefs(a.expr, outputRenames)) state.changed = true;
							});
						});
					}
					(stmt.from ?? []).forEach(f => visitColumnRename(f, state));
					visitColumnRename(stmt.where, state);
					(stmt.groupBy ?? []).forEach(g => visitColumnRename(g, state));
					visitColumnRename(stmt.having, state);
					(stmt.orderBy ?? []).forEach(o => visitColumnRename(o.expr, state));
					visitColumnRename(stmt.limit, state);
					visitColumnRename(stmt.offset, state);
					visitColumnRename(stmt.union, state);
					if (stmt.compound) visitColumnRename(stmt.compound.select, state);
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				// Mirrors the planner's write-target rule (and the table walker's
				// `visitDmlTarget`): an unqualified target naming a member of the
				// statement's own leading WITH binds that CTE, not the renamed table.
				const targetIsCte = stmt.table.schema === undefined &&
					(stmt.withClause?.ctes ?? []).some(c => eq(c.name, stmt.table.name));
				const targetIsRenamed = !targetIsCte &&
					state.resolveRef(stmt.table.schema, stmt.table.name) === state.targetKey;
				if (targetIsRenamed && stmt.columns) {
					stmt.columns = stmt.columns.map(c => {
						if (c.toLowerCase() === state.oldCol) {
							state.changed = true;
							return state.newCol;
						}
						return c;
					});
				}
				if (targetIsRenamed) {
					(stmt.upsertClauses ?? []).forEach(uc => {
						if (uc.conflictTarget) {
							uc.conflictTarget = uc.conflictTarget.map(c => {
								if (c.toLowerCase() === state.oldCol) {
									state.changed = true;
									return state.newCol;
								}
								return c;
							});
						}
						if (uc.assignments) {
							for (const a of uc.assignments) {
								if (a.column.toLowerCase() === state.oldCol) {
									a.column = state.newCol;
									state.changed = true;
								}
							}
						}
					});
				}
				visitColumnRename(stmt.source, state);
				(stmt.upsertClauses ?? []).forEach(uc => {
					(uc.assignments ?? []).forEach(a => visitColumnRename(a.value, state));
					visitColumnRename(uc.where, state);
				});
				(stmt.returning ?? []).forEach(r => {
					if (r.type === 'column') visitColumnRename(r.expr, state);
				});
				(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				// Same write-target rule as the insert arm above.
				const targetIsCte = stmt.table.schema === undefined &&
					(stmt.withClause?.ctes ?? []).some(c => eq(c.name, stmt.table.name));
				const targetIsRenamed = !targetIsCte &&
					state.resolveRef(stmt.table.schema, stmt.table.name) === state.targetKey;
				if (targetIsRenamed) {
					for (const a of stmt.assignments) {
						if (a.column.toLowerCase() === state.oldCol) {
							a.column = state.newCol;
							state.changed = true;
						}
					}
				}
				// Push a scope frame so unqualified column refs in WHERE/RETURNING
				// resolve against the update target, bound under its resolved key.
				const frame = emptyFrame();
				const targetBinding = state.resolveRef(stmt.table.schema, stmt.table.name);
				if (targetBinding !== undefined) {
					frame.qualifiers.set(stmt.table.name.toLowerCase(), targetBinding);
				}
				state.scopeStack.push(frame);
				try {
					stmt.assignments.forEach(a => visitColumnRename(a.value, state));
					visitColumnRename(stmt.where, state);
					(stmt.returning ?? []).forEach(r => {
						if (r.type === 'column') visitColumnRename(r.expr, state);
					});
					(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = emptyFrame();
				const targetBinding = state.resolveRef(stmt.table.schema, stmt.table.name);
				if (targetBinding !== undefined) {
					frame.qualifiers.set(stmt.table.name.toLowerCase(), targetBinding);
				}
				state.scopeStack.push(frame);
				try {
					visitColumnRename(stmt.where, state);
					(stmt.returning ?? []).forEach(r => {
						if (r.type === 'column') visitColumnRename(r.expr, state);
					});
					(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => visitColumnRename(v, state)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitColumnRename(join.left, state);
			visitColumnRename(join.right, state);
			visitColumnRename(join.condition, state);
			break;
		}
		case 'functionSource': {
			(node as AST.FunctionSource).args.forEach(a => visitColumnRename(a, state));
			break;
		}
		case 'subquerySource': {
			visitColumnRename((node as AST.SubquerySource).subquery, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitColumnRename(e.left, state);
			visitColumnRename(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate':
			visitColumnRename((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		case 'function':
			(node as AST.FunctionExpr).args.forEach(a => visitColumnRename(a, state));
			break;
		case 'subquery':
			visitColumnRename((node as AST.SubqueryExpr).query, state);
			break;
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitColumnRename(wf.function, state);
			visitColumnRename(wf.window, state);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitColumnRename(p, state));
			(wd.orderBy ?? []).forEach(o => visitColumnRename(o.expr, state));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitColumnRename(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visitColumnRename(wt.when, state);
				visitColumnRename(wt.then, state);
			});
			visitColumnRename(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitColumnRename(ie.expr, state);
			(ie.values ?? []).forEach(v => visitColumnRename(v, state));
			visitColumnRename(ie.subquery, state);
			break;
		}
		case 'exists':
			visitColumnRename((node as AST.ExistsExpr).subquery, state);
			break;
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitColumnRename(be.expr, state);
			visitColumnRename(be.lower, state);
			visitColumnRename(be.upper, state);
			break;
		}
		case 'column': {
			const col = node as AST.ColumnExpr;
			if (col.name.toLowerCase() !== state.oldCol) break;
			if (col.table) {
				const qualifierLower = col.table.toLowerCase();
				let hit: boolean;
				if (col.schema !== undefined) {
					// A schema-qualified qualifier (`main.t.k`) can never be an
					// alias, a CTE, or the row image — resolve it directly.
					hit = state.resolveRef(col.schema, col.table) === state.targetKey;
				} else {
					const binding = resolveQualifierBinding(state, qualifierLower);
					if (binding !== undefined) {
						// The innermost binding decides: the renamed table's key,
						// another object's key, or null (a shadowing CTE). A table
						// genuinely named `new` / `old` that is bound in scope —
						// the seeded owning table included — resolves through its
						// binding, never through the row image.
						hit = binding === state.targetKey;
					} else {
						// An UNBOUND bare qualifier: the three-way row-image mode
						// decides (see {@link matchesRowImage}) — `'own'` matches
						// the walk's target, `'foreign'` is another relation's row
						// image and must be ignored (NOT resolved as a table called
						// `new`), `'none'` falls through to direct resolution, as
						// the planner would against the body's home schema path
						// (correlation the walk cannot see).
						const image = matchesRowImage(state, col, qualifierLower);
						hit = image === 'own' ? true
							: image === 'foreign' ? false
							: state.resolveRef(undefined, col.table) === state.targetKey;
					}
				}
				if (hit) {
					col.name = state.newCol;
					state.changed = true;
				}
			} else {
				if (unqualifiedRefBindsTarget(state)) {
					col.name = state.newCol;
					state.changed = true;
				}
			}
			break;
		}
		case 'table':
			// Table sources don't contain column names.
			break;
		default:
			break;
	}
}

/**
 * Push a with-frame that registers any CTEs in the given WITH clause that
 * re-expose the renamed column. CTEs are visited in declaration order so
 * later CTEs see earlier ones in the same WITH.
 *
 * For `with recursive`, each CTE's name is registered in `ctesInScope`
 * *before* its body is visited so self-references inside the recursive step
 * resolve to the CTE (not to a same-named renamed table). For non-recursive
 * WITH, the name is registered only after the body — a non-recursive body
 * must not see itself.
 *
 * Caller is responsible for popping the frame via `state.scopeStack.pop()`.
 */
function pushWithFrame(
	withClause: AST.WithClause | undefined,
	state: ColumnRewriteState,
): ScopeFrame {
	const frame = emptyFrame();
	state.scopeStack.push(frame);
	if (withClause) {
		for (const cte of withClause.ctes) {
			const nameLower = cte.name.toLowerCase();
			if (withClause.recursive) {
				frame.ctesInScope.add(nameLower);
			}
			visitColumnRename(cte.query, state);
			if (cteExposesRenamedColumn(cte, state)) {
				frame.ctesExposingRenamed.add(nameLower);
			}
			frame.ctesInScope.add(nameLower);
		}
	}
	return frame;
}

/**
 * Rebuild a with-frame's `ctesExposingRenamed` set for exposure analysis
 * without re-visiting CTE bodies (they were already visited).
 */
function analyzeWithFrame(
	withClause: AST.WithClause | undefined,
	state: ColumnRewriteState,
): ScopeFrame {
	const frame = emptyFrame();
	if (!withClause) return frame;
	state.scopeStack.push(frame);
	try {
		for (const cte of withClause.ctes) {
			if (cteExposesRenamedColumn(cte, state)) {
				frame.ctesExposingRenamed.add(cte.name.toLowerCase());
			}
			frame.ctesInScope.add(cte.name.toLowerCase());
		}
	} finally {
		state.scopeStack.pop();
	}
	return frame;
}

/**
 * Determine whether a CTE re-exposes the renamed column under name `state.newCol`
 * (the column has already been rewritten inside its body if the body referenced it).
 *
 * Returns false when:
 * - The CTE has an explicit column list (renaming the input to fixed names).
 * - The body is not a SELECT (INSERT/UPDATE/DELETE WITH RETURNING — out of scope).
 * - No passthrough result column references the renamed table's column.
 */
function cteExposesRenamedColumn(
	cte: AST.CommonTableExpr,
	state: ColumnRewriteState,
): boolean {
	if (cte.columns) return false;
	return queryExposesRenamedColumn(cte.query, state);
}

/**
 * The query-level core {@link cteExposesRenamedColumn} and the public
 * {@link bodyExposesRenamedColumn} share: whether `query`'s top-level result
 * columns publish the renamed column under `state.newCol`. Expects the body to
 * be ALREADY rewritten — the walk rewrites a CTE body before asking, and the
 * public entry point documents the same contract. For a compound body the
 * first arm's result list is what names the output, and that is what
 * `query.columns` holds here; a non-select body never exposes.
 */
function queryExposesRenamedColumn(query: AST.QueryExpr, state: ColumnRewriteState): boolean {
	if (query.type !== 'select') return false;
	const select = query as AST.SelectStmt;

	// Recreate the body's own with-frame so nested CTE refs in `select.from`
	// resolve correctly during exposure analysis.
	const bodyWithFrame = analyzeWithFrame(select.withClause, state);
	state.scopeStack.push(bodyWithFrame);
	try {
		const bodyFrame = buildScopeFrame(select.from, state);
		for (const col of select.columns ?? []) {
			if (isResultColumnExposure(col, bodyFrame, state)) return true;
		}
		return false;
	} finally {
		state.scopeStack.pop();
	}
}

function isResultColumnExposure(
	col: AST.ResultColumn,
	bodyFrame: ScopeFrame,
	state: ColumnRewriteState,
): boolean {
	if (col.type === 'all') {
		if (col.table === undefined) {
			return frameBindsTarget(bodyFrame, state.targetKey);
		}
		return bodyFrame.qualifiers.get(col.table.toLowerCase()) === state.targetKey;
	}
	if (col.alias !== undefined) return false;
	const expr = col.expr;
	if (expr.type !== 'column') return false;
	const colExpr = expr as AST.ColumnExpr;
	if (colExpr.name.toLowerCase() !== state.newCol.toLowerCase()) return false;
	if (colExpr.table === undefined) {
		return frameBindsTarget(bodyFrame, state.targetKey);
	}
	if (colExpr.schema !== undefined) {
		// Schema-qualified: never an alias — resolve directly.
		return state.resolveRef(colExpr.schema, colExpr.table) === state.targetKey;
	}
	return bodyFrame.qualifiers.get(colExpr.table.toLowerCase()) === state.targetKey;
}

/**
 * Rename `new.<old>` → `new.<new>` references inside a `with inverse` assignment
 * expression, for output columns whose name shifted under a column rename (an
 * unaliased bare projection of the renamed column). Uniform, depth-blind in-place
 * walk over the expression's object graph: the `new.` qualifier alone decides (it
 * is the reserved written-row namespace no FROM source legitimately shadows), so
 * no scope tracking applies — narrower and simpler than the scope-aware walkers
 * above. Returns whether any reference was rewritten.
 *
 * Depth-blind **on purpose**, unlike the row-image match in `matchesRowImage`.
 * The two look alike but answer different questions: this one rewrites by view
 * *output* name inside a `with inverse` expr, so no FROM scope tracking applies
 * (`new.` is the written-row namespace validation reserves there —
 * `planner/analysis/authored-inverse.ts` requires every `new.<x>` to resolve to
 * an output column of its own enclosing select), whereas a CHECK body may
 * contain a subquery selecting from a real table named `"new"` and so must
 * consult the scope stack.
 *
 * One boundary the depth-blind walk must still respect: a subquery inside the
 * expression may be a select carrying its OWN `with inverse` clause, whose
 * `new.` refs name THAT select's outputs (validation pins them there — they can
 * never reach the outer select's), so the walk skips `inverse` subtrees.
 * `inverse` is a property of {@link AST.ResultColumnExpr} only, and the walk's
 * roots are the OUTER clause's assignment exprs, so every `inverse` key met
 * in-walk belongs to a nested select. Correlated `new.<outer-output>` refs in
 * ORDINARY subqueries of the expression are still reached — the skip is the
 * clause, not the subquery.
 *
 * NOTE: `inverse` is skipped but `defaults` is not, deliberately — a nested
 * select's `with defaults` entry expr owns no written-row scope (the inverse
 * validation in `planner/analysis/authored-inverse.ts` never descends one, so a
 * `new.` ref there binds nothing either way) and shifting a ref inside one is
 * inert. If `with defaults` ever gains a written-row scope of its own, this walk
 * needs the same skip for `defaults`.
 */
function renameNewQualifiedRefs(expr: AST.Expression, renames: ReadonlyMap<string, string>): boolean {
	let changed = false;
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) {
			v.forEach(visit);
			return;
		}
		if (v === null || typeof v !== 'object') return;
		const n = v as Record<string, unknown>;
		if (n.type === 'column' && typeof n.table === 'string' && n.table.toLowerCase() === 'new'
			&& n.schema === undefined && typeof n.name === 'string') {
			const to = renames.get(n.name.toLowerCase());
			if (to !== undefined && to !== n.name) {
				n.name = to;
				changed = true;
			}
		}
		for (const key of Object.keys(n)) {
			if (key === 'loc' || key === 'inverse') continue;
			visit(n[key]);
		}
	};
	visit(expr);
	return changed;
}

// The former `renameTableInInsertDefaults` / `renameColumnInInsertDefaults`
// standalone clause rewriters are gone: `with defaults (…)` now rides inside the
// select body (`SelectStmt.defaults`), so the body walks above
// (`visitTableRename` / `visitColumnRename` select cases) descend it directly —
// the entry `expr` rewrites in the select's FROM scope frame and the entry
// `column` target rides the same scope-aware synthetic probe as a `with inverse`
// target. No seeded CHECK-expr scope / declared resolver is needed: the real
// FROM frame is on the scope stack, exactly as for any body reference.
