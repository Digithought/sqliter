import type * as AST from '../../parser/ast.js';
import { spineCloneAst } from '../../util/ast-spine-clone.js';
import { eq, objectRefKeySchema, rewriteEach, type ResolveColumnInSource, type ResolveObjectRef } from './shared.js';

/**
 * Scope-aware, in-place column-rename walkers: propagate `ALTER TABLE … RENAME
 * COLUMN` into dependent object ASTs (view bodies, CHECK expressions, partial
 * index predicates, column DEFAULT / generated expressions), plus the
 * read-only column-reference probes built on them. The seeded entry point
 * ({@link renameColumnInCheckExpression}) additionally owns the `new.` /
 * `old.` row-image namespace; see its doc comment.
 */

interface ScopeFrame {
	/**
	 * Lowercase unaliased qualifier name (a source's bare table name, or an
	 * exposing CTE's name) → resolved object key of the table it binds. A
	 * value equal to the walk's target key marks a binding to the renamed
	 * table, eligible for unqualified capture.
	 */
	unaliased: Map<string, string>;
	/** Lowercase alias → resolved object key of the underlying table. */
	aliasMap: Map<string, string>;
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
	 * outer seed binding to the renamed table must not capture it. Aliased
	 * subquery / function-source / CTE-shadowed sources are NOT recorded (the
	 * rewriter can't ask the callback about those without recursive analysis).
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
		matchRowImageQualifier: false,
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
 * Limitation: aliased subquery / function-source / CTE-projection inner
 * sources are not asked (the rewriter would need recursive column-set
 * inference on their bodies). `renameColumnInAst` shares the same callback
 * (passed by the view-body callers) and the same limitation.
 *
 * The seed also makes this walk the owner of the `new.` / `old.` **row-image**
 * namespace: a CHECK may name the row being written explicitly
 * (`check (new.a > 0)`, `check on delete (old.a > 0)` — `docs/sql-ddl.md`
 * § CHECK Constraints), and those qualifiers name the owning table's row, not
 * anything a FROM clause binds. So the qualified-ref case matches them too —
 * but only here, never through `renameColumnInAst`, where a `new.` ref belongs
 * to some other table's row image.
 *
 * That match is scope-**aware**, not depth-blind, because `new` and `old` are
 * not reserved words in this parser: `create table "new" (…)` is legal, so a
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
		matchRowImageQualifier: true,
	};
	const frame = emptyFrame();
	frame.unaliased.set(state.tableName, state.targetKey);
	state.scopeStack.push(frame);
	try {
		visitColumnRename(expr, state);
	} finally {
		state.scopeStack.pop();
	}
	return state.changed;
}

/**
 * Sentinel rename target for the two read-only column probes below. No user
 * column can hold this name, and the probe rewrites *to* it, so it can never
 * collide with anything the walk is looking for.
 */
const PROBE_COLUMN_NAME = '__quereus_column_probe__';

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
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!node) return false;
	return renameColumnInAst(
		spineCloneAst(node), tableName, columnName, PROBE_COLUMN_NAME,
		resolve, targetKey, resolveColumnInSource);
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
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!expr) return false;
	return renameColumnInCheckExpression(
		spineCloneAst(expr), tableName, columnName, PROBE_COLUMN_NAME,
		resolve, targetKey, resolveColumnInSource);
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
 * Sharing the seeded entry point also brings its `new.` / `old.` row-image match
 * along, which is inert here: a partial-index predicate describes rows already
 * stored, has no written-row context, and a predicate naming one would not plan
 * in the first place. Nothing to suppress — noted so the shared entry point does
 * not read as an oversight.
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
		expr, tableName, oldColName, newColName, resolve, targetKey, resolveColumnInSource));
}

/**
 * Rewrite the renamed column inside every CHECK constraint expression of `checks`
 * belonging to the renamed table itself, in place. The seeded-scope entry point
 * applies for the same reason it does for a partial-index predicate: a CHECK
 * resolves unqualified refs against its owning table.
 *
 * Only pass the renamed table's OWN checks — a CHECK on a *different* table that
 * happens to reference the renamed table needs {@link renameColumnInAst}, whose
 * walk has no implicit seed.
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
		expr, tableName, oldColName, newColName, resolve, targetKey, resolveColumnInSource));
}

/**
 * Rewrite the renamed column inside the two expressions a `ColumnSchema` can carry —
 * a column DEFAULT (`b integer default (new.a + 1)`, however authored: inline, or via
 * `ALTER TABLE … ALTER COLUMN … SET DEFAULT`, which writes the same field) and a
 * generated column's body (`g integer generated always as (a + 1)`) — in place, for
 * every column of the renamed table itself.
 *
 * The seeded {@link renameColumnInCheckExpression} entry point is correct for both, for
 * the two halves of what the seed provides:
 *
 * - The implicit unaliased binding to the owning table is what makes a generated
 *   column's **bare** `a` resolve — it has no FROM clause to bind against, exactly like
 *   a CHECK.
 * - The seed also owns the `new.` / `old.` **row-image** namespace, which is what makes a
 *   default's `new.a` resolve. A default is evaluated against the row being written, so
 *   that qualifier names this table's row image, not anything a FROM binds.
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
		expr, tableName, oldColName, newColName, resolve, targetKey, resolveColumnInSource);
	// Both walks always run — `||` on the results, not short-circuited between them.
	const defaultsChanged = rewriteEach(columns, c => c.defaultValue ?? undefined, rewrite);
	const generatedChanged = rewriteEach(columns, c => c.generatedExpr, rewrite);
	return defaultsChanged || generatedChanged;
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
	 * Match `new.` / `old.` as this table's row image. Set only by the seeded
	 * entry point ({@link renameColumnInCheckExpression}), whose expression is
	 * evaluated against a row of `tableName` and therefore owns that namespace;
	 * the unseeded {@link renameColumnInAst} leaves it false, so a `new.` ref in
	 * some *other* table's CHECK is never mistaken for this table's row image.
	 */
	matchRowImageQualifier: boolean;
}

function emptyFrame(): ScopeFrame {
	return {
		unaliased: new Map(),
		aliasMap: new Map(),
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
					if (ts.alias) {
						frame.aliasMap.set(ts.alias.toLowerCase(), state.targetKey);
					} else {
						// Unqualified refs capture here, and the CTE name acts as
						// an implicit qualifier for refs like "a.k" — both bind
						// the renamed table's key through the CTE.
						frame.unaliased.set(name, state.targetKey);
						frame.aliasMap.set(name, state.targetKey);
					}
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
			if (ts.alias) {
				frame.aliasMap.set(ts.alias.toLowerCase(), key);
			} else {
				frame.unaliased.set(name, key);
			}
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
			// Aliased; these don't contribute the renamed underlying table for
			// unqualified resolution purposes.
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
 * Innermost-first walk: a closer same-name CTE shadows an outer unaliased
 * binding to the renamed real table. When a `resolveColumnInSource`
 * callback is configured, also stop at any inner FROM frame whose real
 * sources expose `oldCol` — the unqualified ref binds inside that frame
 * and an outer seed binding must not capture it.
 */
function isTableInUnaliasedScope(state: ColumnRewriteState): boolean {
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
		if (frameBindsTargetUnaliased(frame, state.targetKey)) return true;
	}
	return false;
}

/** Whether any unaliased binding in `frame` resolves to `targetKey`. */
function frameBindsTargetUnaliased(frame: ScopeFrame, targetKey: string): boolean {
	for (const key of frame.unaliased.values()) {
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
 */
function resolveQualifierBinding(
	state: ColumnRewriteState,
	qualifierLower: string,
): string | null | undefined {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		const viaAlias = frame.aliasMap.get(qualifierLower);
		if (viaAlias !== undefined) return viaAlias;
		const viaSource = frame.unaliased.get(qualifierLower);
		if (viaSource !== undefined) return viaSource;
		if (frame.ctesShadowingSource.has(qualifierLower)) return null;
		if (frame.ctesInScope.has(qualifierLower)) return null;
	}
	return undefined;
}

/**
 * Whether a qualified column ref names the **row image** of the table this
 * seeded walk was entered for — `new.<col>` / `old.<col>` inside one of its own
 * CHECK expressions. Only the seeded entry point sets
 * `matchRowImageQualifier`; see {@link renameColumnInCheckExpression} for why
 * that scoping is what keeps another table's `new.` ref out of this match.
 *
 * A schema-qualified `main.new.a` is a real three-part table reference, never a
 * row image, so it is excluded outright.
 *
 * `qualifierLower` is `col.table` already lowercased by the caller.
 */
function matchesRowImage(state: ColumnRewriteState, col: AST.ColumnExpr, qualifierLower: string): boolean {
	if (!state.matchRowImageQualifier) return false;
	if (col.schema !== undefined) return false;
	if (qualifierLower !== 'new' && qualifierLower !== 'old') return false;
	return !isQualifierReboundAboveSeed(state, qualifierLower);
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
 * not a FROM binding and must not count as a rebind. All four ways a frame can
 * bind a qualifier are checked — an unaliased source, an alias, a CTE name in
 * scope, and a shadowing-but-not-exposing CTE source.
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
		if (frame.unaliased.has(qualifier)) return true;
		if (frame.aliasMap.has(qualifier)) return true;
		if (frame.ctesInScope.has(qualifier)) return true;
		if (frame.ctesShadowingSource.has(qualifier)) return true;
	}
	return false;
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
					// probe (the `with defaults` clause below uses the same pattern); the
					// assignment expr rewrites like any body expression.
					(stmt.columns ?? []).forEach(c => {
						if (c.type !== 'column' || !c.inverse?.length) return;
						c.inverse.forEach(a => {
							const probe: AST.ColumnExpr = { type: 'column', name: a.column };
							visitColumnRename(probe, state);
							if (probe.name !== a.column) {
								(a as { column: string }).column = probe.name;
								state.changed = true;
							}
							visitColumnRename(a.expr, state);
						});
					});
					// `with defaults` clause: each entry's `column` is a bare base-column
					// name of this select's FROM (a projected-away base column), so it
					// rides the same scope-aware synthetic probe as a `with inverse`
					// target; the entry's `expr` evaluates in the inserted-row context of
					// the FROM table — exactly the FROM frame already on the scope stack —
					// so it rewrites like any body expression (an inner subquery in the
					// expr pushes its own frame and disambiguates a like-named column).
					(stmt.defaults ?? []).forEach(d => {
						const probe: AST.ColumnExpr = { type: 'column', name: d.column };
						visitColumnRename(probe, state);
						if (probe.name !== d.column) {
							(d as { column: string }).column = probe.name;
							state.changed = true;
						}
						visitColumnRename(d.expr, state);
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
							const boundToRenamed = frameBindsTargetUnaliased(frame, state.targetKey)
								|| [...frame.aliasMap.values()].includes(state.targetKey);
							if (c.table === undefined) return boundToRenamed;
							const q = c.table.toLowerCase();
							return frame.aliasMap.get(q) === state.targetKey
								|| frame.unaliased.get(q) === state.targetKey;
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
					frame.unaliased.set(stmt.table.name.toLowerCase(), targetBinding);
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
					frame.unaliased.set(stmt.table.name.toLowerCase(), targetBinding);
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
					} else if (matchesRowImage(state, col, qualifierLower)) {
						// Row-image match applies only to an UNBOUND `new.` /
						// `old.` qualifier in a seeded (written-row) walk.
						hit = true;
					} else {
						// Nothing in scope binds the qualifier: a seedless
						// expression context (correlation the walk cannot see).
						// Resolve directly, as the planner would against the
						// body's home schema path.
						hit = state.resolveRef(undefined, col.table) === state.targetKey;
					}
				}
				if (hit) {
					col.name = state.newCol;
					state.changed = true;
				}
			} else {
				if (isTableInUnaliasedScope(state)) {
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
	const query = cte.query;
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
			return frameBindsTargetUnaliased(bodyFrame, state.targetKey);
		}
		const qualLower = col.table.toLowerCase();
		return bodyFrame.unaliased.get(qualLower) === state.targetKey
			|| bodyFrame.aliasMap.get(qualLower) === state.targetKey;
	}
	if (col.alias !== undefined) return false;
	const expr = col.expr;
	if (expr.type !== 'column') return false;
	const colExpr = expr as AST.ColumnExpr;
	if (colExpr.name.toLowerCase() !== state.newCol.toLowerCase()) return false;
	if (colExpr.table === undefined) {
		return frameBindsTargetUnaliased(bodyFrame, state.targetKey);
	}
	if (colExpr.schema !== undefined) {
		// Schema-qualified: never an alias — resolve directly.
		return state.resolveRef(colExpr.schema, colExpr.table) === state.targetKey;
	}
	const qualLower = colExpr.table.toLowerCase();
	return bodyFrame.unaliased.get(qualLower) === state.targetKey
		|| bodyFrame.aliasMap.get(qualLower) === state.targetKey;
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
 * *output* name inside a `with inverse` expr, whose grammar admits no FROM
 * clause that could rebind `new`, whereas a CHECK body may contain a subquery
 * selecting from a real table named `"new"` and so must consult the scope stack.
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
			if (key === 'loc') continue;
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
