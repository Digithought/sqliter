import type * as AST from '../../parser/ast.js';
import { eq, objectRefKey, objectRefKeySchema, rewriteEach, type ResolveObjectRef, type TableRenameTarget } from './shared.js';

/**
 * Scope-aware, in-place table-reference walker: propagates
 * `ALTER TABLE … RENAME` into dependent object ASTs (view bodies, CHECK
 * expressions, assertion bodies, partial-index predicates, column DEFAULT /
 * generated expressions) and answers the read-only "does this AST reference
 * table X?" probe the DROP guards use.
 *
 * All three verbs are expressed over ONE traversal ({@link visitTableRefs}),
 * which reports every REAL table reference — one not shadowed by a CTE, a FROM
 * alias, or the `new.`/`old.` row image — to a sink. The rewrite sink renames
 * matching references in place; the probe sink records a match and stops the
 * walk; the collect sink ({@link collectTableRefsInAst}) keys every reference
 * for the reachability closure the DROP guards follow through view chains. One
 * traversal is the invariant, not an implementation detail: the DROP guards
 * must refuse exactly the references a rename would rewrite.
 *
 * All name comparisons are case-insensitive to match the Quereus catalog
 * rules. Walkers mutate the input AST and return whether anything changed, so
 * callers can skip cloning when nothing matched.
 */

/** Options for the table-reference walk, threaded from the entry points. */
export interface TableRenameOpts {
	/**
	 * The walked expression is evaluated against a WRITTEN ROW — a CHECK
	 * constraint or a column DEFAULT / generated body — so a bare `new.` /
	 * `old.` column qualifier names the row image, never a table called `new`
	 * or `old`. Suppression is scope-aware: it applies only while no FROM/WITH
	 * frame rebinds the qualifier (a subquery selecting from a real table
	 * named `new` still counts as a table reference), and never to a
	 * schema-qualified `main.new.a`, which is a real three-part reference.
	 *
	 * Deliberately NOT set for partial-index predicates: a predicate describes
	 * rows already stored and has no written-row context, so `new.x` there IS
	 * a table reference. (The column walker records the same asymmetry by
	 * passing row-image mode `'none'` for predicates.)
	 *
	 * A boolean where the column walker's
	 * {@link import('./shared.js').RowImageContext} is three-valued, and
	 * COMPLETE at two: this walker never *matches* a row image, only
	 * suppresses one, so the column walker's `'own'`/`'foreign'` split
	 * collapses — `false` maps to `'none'`, `true` to `'foreign'`. Like the
	 * column walker, the flag is overridden (to `true`) over `with inverse` /
	 * `with defaults` subtrees regardless of the entry-point value, because
	 * written-row context there is a property of the position, not the walk.
	 */
	rowImageContext?: boolean;
	/**
	 * The walked expression is SCHEMA-AUTHORED — a CHECK constraint, a column
	 * DEFAULT / generated body, or a partial-index predicate — so it plans under
	 * `schemaAuthoredContext` (`planner/building/schema-authored-context.ts`):
	 * its owning schema and NOTHING else, never the session schema path. Set by
	 * the three collection helpers below; absent for the stored bodies that DO
	 * plan under the home schema path (view bodies, materialized-view bodies,
	 * assertion checks).
	 *
	 * Suppresses the untouched-reference arm of {@link renameTableInAst}, for
	 * two reasons that agree:
	 *
	 * - Nothing is lost. That arm fires only when an unqualified name resolves
	 *   through to ANOTHER schema, which is precisely what this planning context
	 *   rejects — so it could only ever fire on a body the planner already
	 *   refuses to evaluate.
	 * - It keeps the walk IDEMPOTENT where idempotence is load-bearing. The
	 *   renamed table's own CHECK / predicate / column expressions are walked
	 *   more than once on purpose: `runRenameTable` rewrites them before the
	 *   catalog swap, `propagateTableRename` walks every table again afterwards,
	 *   and a persisting module rewrites the same shared ASTs inside its own
	 *   `renameTable` hook. The rewrite arm is idempotent by construction (after
	 *   it runs, nothing names `oldName`); the untouched arm is NOT, because a
	 *   reference the rewrite already turned into `newName` is indistinguishable
	 *   — to the resolvers — from one the new name captured. Confining that arm
	 *   to the once-walked home-path bodies is what keeps the two facts from
	 *   colliding.
	 */
	schemaAuthoredBody?: boolean;
}

/** A real (non-shadowed) table reference the scope-aware walk found. */
interface TableRef {
	/**
	 * Schema qualifier of the reference. For a column-qualifier reference
	 * resolved through an unaliased FROM source, this is the SOURCE's schema
	 * as written (so `from other_schema.zap` + `zap.k` reports `other_schema`,
	 * not the bare qualifier); otherwise the schema as written on the
	 * reference itself. `undefined` = unqualified.
	 */
	schema: string | undefined;
	/** Table name as written. */
	name: string;
	/** Rewrite the reference's name in place. */
	setName: (next: string) => void;
	/**
	 * Add a schema qualifier to the reference in place. Present at exactly the
	 * sites where the reference RE-RESOLVES THROUGH THE CATALOG the next time
	 * the body is planned — a DML target, a FROM table source, a seedless bare
	 * column qualifier. ABSENCE IS A SIGNAL, not an omission: the other sites
	 * either carry their own written qualifier already (a schema-qualified
	 * column ref) or bind through a FROM frame rather than the catalog (a
	 * column qualifier bound to an unaliased source), so a qualifier there
	 * would be wrong or meaningless.
	 */
	qualify?: (schemaName: string) => void;
	/**
	 * Present only for a reference that binds through a FROM frame — an
	 * UNALIASED FROM source, or a bare column qualifier bound to one. Answers:
	 * would giving that source the bare name `next` collide with a qualifier
	 * visible where the SOURCE sits (a sibling entry in its own FROM frame, a
	 * sibling's alias, a CTE declared in an enclosing WITH, a binding
	 * contributed by an enclosing FROM frame) or introducible anywhere BELOW
	 * its select (a correlated qualifier bound to the source can sit inside an
	 * inner subquery, where an inner alias / source / CTE of that name would
	 * capture its new spelling)? Both emit sites must get the same answer, so
	 * it is evaluated at the source's own frame, never the walk's current
	 * depth — see {@link qualifierCollidesAt}. Like `qualify`, absence is a
	 * signal: an aliased source exposes its alias, which a rename never moves,
	 * so there is no collision to ask about.
	 */
	qualifierCollides?: (next: string) => boolean;
	/**
	 * FROM-source only, and only for a source with NO author-written alias:
	 * pin the pre-rename bare name as an explicit alias so qualifiers spelled
	 * that way keep binding this source. Absent on an aliased source — the
	 * rename cannot move an alias, so there is nothing to preserve.
	 */
	aliasAs?: (aliasName: string) => void;
	/**
	 * Present at the sites a CTE can capture the reference the next time the
	 * body is planned — an unqualified FROM source (any CTE in scope) and an
	 * unqualified DML target (the statement's own WITH only, mirroring
	 * `resolveCteTarget`). Answers whether the bare name `next` would bind a
	 * CTE there rather than the catalog. The catalog resolvers behind the
	 * rewrite post-condition cannot see CTEs, so this is what makes the sink
	 * schema-qualify a rewritten reference whose new name a CTE shadows — a
	 * schema-qualified source or target is never a CTE.
	 */
	cteShadows?: (next: string) => boolean;
}

/** Return `true` to stop the walk early (the read-only probe's short-circuit). */
type TableRefSink = (ref: TableRef) => boolean | void;

/**
 * One scope level of the walk. A WITH clause contributes a frame carrying
 * `ctes` (populated in declaration order while its members' bodies are
 * visited); a FROM clause contributes a frame carrying `bound`.
 */
interface TableScopeFrame {
	/** Lowercase CTE names this WITH declares, per visibility order. */
	ctes: Set<string>;
	/**
	 * Lowercase qualifier (alias, or unaliased source name) → the real
	 * unaliased table source it binds (schema as written + name), or `null`
	 * when the qualifier binds anything that is NOT directly the named real
	 * table: an alias (renaming a table never changes an alias), a CTE, or a
	 * subquery / function source.
	 */
	bound: Map<string, { schema: string | undefined; name: string } | null>;
	/**
	 * The select this FROM frame spans (set when the select arm pushes it), so
	 * {@link qualifierCollidesAt} can lazily collect the names the SUBTREE can
	 * introduce as qualifiers. A qualifier bound to this frame can sit deeper
	 * than the frame itself — inside a correlated subquery — where an inner
	 * alias / source / CTE of the new name would capture its new spelling even
	 * though nothing AT the frame binds that name.
	 */
	subtreeRoot?: AST.AstNode;
	/**
	 * Lazily memoized {@link collectIntroducedQualifierNames} over
	 * `subtreeRoot`. Memoization is what keeps the collision predicate a pure
	 * function of the frame for every consult (source emit and each bound
	 * qualifier emit), regardless of where in the visit order the first
	 * consult happens.
	 */
	introduced?: Set<string>;
}

interface TableRefWalkState {
	sink: TableRefSink;
	rowImage: boolean;
	stack: TableScopeFrame[];
	/** Set once the sink asks to stop; every visit entry checks it. */
	stop: boolean;
}

/**
 * `target.resolve` and the derived `targetKey` (`objectRefKey(target.schemaName,
 * target.oldName)`) decide matching for the rewrite and the probe below alike: a
 * reference matches when `resolve(ref.schema, ref.name)` — the reference's
 * planner-parity resolution under the WALKED BODY's home schema path — equals
 * `targetKey`. The bare-name equality check in front is a pure short-circuit:
 * the resolver echoes the name it is given into the key, so a reference spelled
 * differently can never resolve to the target.
 *
 * The rewrite additionally enforces a POST-CONDITION the probe does not need,
 * and it covers EVERY reference the walk reports — not only the ones it
 * rewrites:
 *
 * > Walking a body for a rename, every reference must mean after the statement
 * > exactly what it meant before.
 *
 * Both arms decide that the same way: re-resolve the reference under the same
 * home schema path against the catalog AS IT WILL BE AFTER THE RENAME
 * (`target.resolveAfter`) and compare with what it meant before.
 *
 * - A REWRITTEN reference must still yield the renamed object's key. When it
 *   would not — the bare new name is captured by an earlier schema on the
 *   body's home path — it is schema-qualified to the renamed schema via
 *   {@link TableRef.qualify}.
 * - An UNTOUCHED reference must still yield its own before-answer. A rename
 *   also CREATES a name, and that new name can capture a reference the walk
 *   never matched: a `temp`-owned body reading bare `k` (falling through to
 *   `main.k`, because `temp` holds no `k`) silently re-binds to `temp.k` the
 *   moment `alter table temp.other rename to k` lands, without its text ever
 *   mentioning the renamed table. When the answer would change, the reference
 *   is qualified to the schema its BEFORE-answer named — recovered from that
 *   key by {@link import('./shared.js').objectRefKeySchema}. This arm applies
 *   to the stored bodies that plan under the home schema path and is walked
 *   ONCE per body; {@link TableRenameOpts.schemaAuthoredBody} turns it off for
 *   the schema-authored expressions, which need it neither for correctness nor
 *   for the re-walks they are deliberately subjected to — see that flag.
 *
 * The post-condition also covers the FROM-frame namespace, not just the
 * catalog's: inside one body, the bare qualifier an unaliased FROM source
 * exposes must keep binding that source. When the rename would give a source a
 * name already visible as a qualifier where it sits ({@link
 * TableRef.qualifierCollides}), the source pins its pre-rename spelling as an
 * explicit alias ({@link TableRef.aliasAs}) and every column qualifier bound
 * through it keeps the old spelling — `from t join u as t2` becomes
 * `from t2 as t join u as t2` under `t → t2`, with `t.x` untouched. And when
 * the new name is shadowed by a CTE in scope at the source ({@link
 * TableRef.cteShadows}) — invisible to the catalog resolvers — the reference
 * is schema-qualified so it cannot re-bind to the CTE.
 *
 * Qualification is conditional in both arms, never eager, so the common
 * no-collision rename leaves body text (and a materialized view's `bodyHash`)
 * exactly as before. A qualified reference resolves by passthrough, so its
 * before- and after-answers are always equal and neither arm can fire on one;
 * only unqualified references ever gain a qualifier. And only the NEW name can
 * change meaning without being rewritten: removing the old name can only push a
 * resolution later, and the references that resolved to the removed entry are
 * exactly the ones the rewrite already matches — so there is no freed-name
 * direction to handle.
 *
 * ALREADY-BROKEN BODIES: the resolver answers a total function — a name held by
 * no schema on the path still gets a stable key, the home schema's — so a body
 * naming an object that exists nowhere reads `before = <home>.<name>`, and a
 * rename introducing that name in an earlier schema flips `after`. The
 * untouched arm then qualifies the reference to the home schema, PINNING the
 * pre-existing "no such table" failure rather than letting the body silently
 * start reading the new arrival. That is the invariant-faithful answer, so no
 * existence probe is added to dodge it (same reasoning as the seedless-qualifier
 * emit site below: it only ever fires on an already-unevaluable body).
 */
export function renameTableInAst(
	node: AST.AstNode | undefined,
	target: TableRenameTarget,
	opts?: TableRenameOpts,
): boolean {
	if (!node) return false;
	const { oldName, newName, schemaName, resolve, resolveAfter } = target;
	const targetKey = objectRefKey(schemaName, oldName);
	const newTargetKey = objectRefKey(schemaName, newName);
	let changed = false;
	walkTableRefs(node, ref => {
		if (eq(ref.name, oldName) && resolve(ref.schema, ref.name) === targetKey) {
			// Qualifier-namespace guard, the FROM-frame twin of the catalog
			// post-condition below: the bare qualifier an unaliased source
			// exposes must keep binding that source. When the new name is
			// already visible as a qualifier where the source sits, the source
			// takes the new name but pins the OLD spelling as an explicit
			// alias, and every qualifier bound through it keeps that spelling.
			// Guarded on a real name change so a case-only rename never
			// self-collides on the source's own frame entry.
			//
			// NOTE: deliberately conservative — the source is aliased whenever
			// the new name is visible in scope, even when nothing in its
			// subtree actually spells it. Detecting real use would need a
			// second pass over the subtree; the extra alias is harmless and
			// only appears in a genuine collision. It is not free for a
			// MAINTAINED body, though: a pin changes the body text, hence the
			// `bodyHash`, hence forces a re-hash / regenerate on an MV whose
			// meaning did not change. If that ever shows up as churn on large
			// bodies, narrow the predicate to names the subtree actually
			// spells as a qualifier.
			const collides = !eq(oldName, newName) && (ref.qualifierCollides?.(newName) ?? false);
			if (collides && !ref.aliasAs) {
				// A column qualifier bound to a source the rename is about to
				// alias: the aliased source keeps exposing the old spelling,
				// so the qualifier keeps it too. The source's own emit (same
				// walk, same predicate) is what sets `changed`.
				return;
			}
			ref.setName(newName);
			changed = true;
			if (collides) ref.aliasAs?.(oldName);
			// Catalog post-condition — with one addition the catalog resolvers
			// cannot express: a CTE in scope at the source captures a bare
			// name before the catalog is ever consulted, so a rewritten
			// reference whose new name a CTE shadows must be schema-qualified
			// even when the catalog answer alone would leave it bare.
			if (ref.qualify && (resolveAfter(ref.schema, newName) !== newTargetKey || (ref.cteShadows?.(newName) ?? false))) {
				ref.qualify(schemaName);
			}
			return;
		}
		// The untouched arm (see the doc comment). Only a reference that
		// re-resolves through the catalog carries `qualify` — the rest bind
		// through a FROM frame and are preserved by qualifying their source.
		if (opts?.schemaAuthoredBody || !ref.qualify) return;
		// NOTE: asks the resolvers about EVERY reference, where the rewrite arm
		// above short-circuits on a bare-name compare first. The arm can in fact
		// only fire on a reference spelling `newName` — the two resolvers differ
		// only over `schemaName`'s name set, and the `oldName` direction is either
		// the rewrite arm's or unchanged — so an `eq(ref.name, newName)` guard here
		// would be equivalent and cheaper. Declined: it trades two Set lookups per
		// reference on a DDL-only path for a claim that silently loses coverage if
		// the `resolve`/`resolveAfter` pair ever differs more broadly than one
		// table rename. Add the guard if rename propagation over a schema-heavy
		// catalog ever measures hot.
		const before = resolve(ref.schema, ref.name);
		if (before === undefined || before === resolveAfter(ref.schema, ref.name)) return;
		ref.qualify(objectRefKeySchema(before, ref.name.toLowerCase()));
		changed = true;
	}, opts);
	return changed;
}

/**
 * Whether `node` refers to the table/view identified by `targetKey` (spelled
 * `name`) — read-only, nothing is mutated.
 *
 * Deliberately the SAME traversal {@link renameTableInAst} uses — both are
 * sinks over {@link visitTableRefs} — so "refers to" can never drift from
 * "would have been rewritten by a rename". That equivalence is the whole
 * point: the DROP guard refuses exactly the cases `ALTER TABLE … RENAME`
 * would have followed. In particular, a body whose `with <name> as (…)`
 * merely SHADOWS the probed name is not a reference — the walk skips it for
 * both verbs. The probe's sink stops the walk at the first match.
 *
 * The column-level probes ({@link import('./column-rename.js').columnReferencedInAst},
 * {@link import('./column-rename.js').columnReferencedInCheckExpression}) reach
 * the same equivalence a different way — a real rename, to a sentinel name,
 * over a throwaway clone — because the column walker has ~8 mutation points
 * and a CTE-re-exposure branch that reads the new name; see their comments.
 */
export function tableReferencedInAst(
	node: AST.AstNode | undefined,
	name: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	opts?: TableRenameOpts,
): boolean {
	if (!node) return false;
	let found = false;
	walkTableRefs(node, ref => {
		if (eq(ref.name, name) && resolve(ref.schema, ref.name) === targetKey) {
			found = true;
			return true;
		}
	}, opts);
	return found;
}

/**
 * Every real (non-shadowed) table / view reference in `node`, keyed the way
 * {@link renameTableInAst} and {@link tableReferencedInAst} key their target:
 * `resolve(ref.schema, ref.name)`, the reference's planner-parity resolution
 * under the WALKED BODY's home schema path.
 *
 * The collect-all THIRD sink over the same {@link walkTableRefs} traversal, so
 * it inherits the scope-awareness of the other two for free: a body whose
 * `with t as (…)` merely SHADOWS the name contributes no `<schema>.t` key, a FROM
 * alias contributes nothing, and a `new.` / `old.` row-image qualifier under
 * {@link TableRenameOpts.rowImageContext} contributes nothing. That matters
 * more here than anywhere else — a collect-everything walk is exactly where
 * that property gets quietly lost, and the reachability closure built on this
 * ({@link import('../object-dependency-closure.js').reachableObjects}) turns
 * every key it yields into a refused DROP.
 *
 * The value is the object NAME the key was built from, lowercased. The
 * resolver echoes the name it is given into the key, so this is always
 * `ref.name.toLowerCase()`; it is returned rather than re-derived because a
 * schema name may itself contain a dot, which makes splitting a key by
 * separator scan wrong — see {@link import('./shared.js').objectRefKeySchema},
 * whose whole job is that split and which needs exactly this.
 */
export function collectTableRefsInAst(
	node: AST.AstNode | undefined,
	resolve: ResolveObjectRef,
	opts?: TableRenameOpts,
): Map<string, string> {
	const refs = new Map<string, string>();
	if (!node) return refs;
	walkTableRefs(node, ref => {
		const key = resolve(ref.schema, ref.name);
		// `undefined` means "no resolver could be consulted at all" — a reference
		// with no key is not something a closure can follow.
		if (key !== undefined) refs.set(key, ref.name.toLowerCase());
	}, opts);
	return refs;
}

/**
 * Rewrite the renamed table inside every partial-index predicate of `indexes`,
 * in place. A predicate may carry a table-qualified self-reference
 * (`create index ix on t (b) where t.b > 0`), which a table rename must follow.
 *
 * No {@link TableRenameOpts.rowImageContext}: a predicate describes rows
 * already stored, so `new.x` there is a real table reference — see the flag's
 * doc comment. {@link TableRenameOpts.schemaAuthoredBody} IS set: a predicate
 * plans under its owning schema alone, and this AST is one of the several the
 * rename walks more than once.
 *
 * Sharing and idempotence work exactly as in
 * {@link import('./column-rename.js').renameColumnInIndexPredicates}: the
 * predicate `Expression` is shared by reference with the catalog's
 * `TableSchema` and with a unique partial index's `derivedFromIndex` UNIQUE
 * constraint, so one in-place rewrite covers all of them, and a second call
 * with the same pair finds nothing naming `oldName` and returns false.
 */
export function renameTableInIndexPredicates(
	indexes: ReadonlyArray<{ readonly predicate?: AST.Expression }> | undefined,
	target: TableRenameTarget,
): boolean {
	return rewriteEach(indexes, idx => idx.predicate,
		expr => renameTableInAst(expr, target, { schemaAuthoredBody: true }));
}

/**
 * Rewrite the renamed table inside every CHECK constraint expression of `checks`,
 * in place. A CHECK may carry a table-qualified self-reference (`check (t.b > 0)`)
 * exactly as a partial-index predicate may, and a table rename must follow it.
 *
 * A CHECK is evaluated against a written row, so the walk runs with
 * {@link TableRenameOpts.rowImageContext}: a bare `new.a` / `old.a` names the
 * row image and survives even a rename of a table literally called `new`. It
 * also runs with {@link TableRenameOpts.schemaAuthoredBody}, for the same
 * reasons the predicate arm above does.
 *
 * Same sharing and idempotence story as {@link renameTableInIndexPredicates}: the
 * `expr` is the very AST the catalog's `TableSchema` holds, so one rewrite covers
 * every holder and a second call with the same pair is a no-op.
 */
export function renameTableInCheckConstraints(
	checks: ReadonlyArray<{ readonly expr: AST.Expression }> | undefined,
	target: TableRenameTarget,
): boolean {
	return rewriteEach(checks, cc => cc.expr,
		expr => renameTableInAst(expr, target, { rowImageContext: true, schemaAuthoredBody: true }));
}

/**
 * Rewrite the renamed table inside the two expressions a `ColumnSchema` can carry —
 * a column DEFAULT (`w integer default ((select min(v) from u))`, however authored:
 * inline, or via `ALTER TABLE … ALTER COLUMN … SET DEFAULT`, which writes the same
 * field) and a generated column's body (`g integer generated always as ((select
 * min(u.v) from u) + id)`) — in place.
 *
 * Both expressions evaluate against the row being written, so the walk runs
 * with {@link TableRenameOpts.rowImageContext}: a default's `new.a` names the
 * row image, not a table called `new`. It also runs with
 * {@link TableRenameOpts.schemaAuthoredBody}, for the same reasons the two arms
 * above do.
 *
 * Unlike the column-rename counterpart
 * ({@link import('./column-rename.js').renameColumnInColumnExpressions}) there
 * is no seeded/unseeded split: {@link renameTableInAst} resolves nothing against an
 * implicit owning table, so the SAME entry point is correct for the renamed table's own
 * columns (a self-referencing default, `default ((select count(*) from t))`) and for
 * every other table's.
 *
 * Same sharing and idempotence story as {@link renameTableInCheckConstraints}: the
 * `Expression` is the very AST the catalog's `TableSchema` holds, so one in-place
 * rewrite reaches every holder and a second call with the same pair finds nothing
 * naming `oldName` and returns false.
 *
 * The parameter is structurally typed rather than `ColumnSchema[]` so this module stays
 * free of catalog imports; `ColumnSchema` satisfies it.
 */
export function renameTableInColumnExpressions(
	columns: ReadonlyArray<{
		readonly defaultValue?: AST.Expression | null;
		readonly generatedExpr?: AST.Expression;
	}> | undefined,
	target: TableRenameTarget,
): boolean {
	const rewrite = (expr: AST.Expression): boolean =>
		renameTableInAst(expr, target, { rowImageContext: true, schemaAuthoredBody: true });
	// Both walks always run — `||` on the results, not short-circuited between them.
	const defaultsChanged = rewriteEach(columns, c => c.defaultValue ?? undefined, rewrite);
	const generatedChanged = rewriteEach(columns, c => c.generatedExpr, rewrite);
	return defaultsChanged || generatedChanged;
}

// ──────────────────────────────────────────────────────────────────────
// The walk
// ──────────────────────────────────────────────────────────────────────

function walkTableRefs(node: AST.AstNode, sink: TableRefSink, opts?: TableRenameOpts): void {
	const state: TableRefWalkState = {
		sink,
		rowImage: opts?.rowImageContext ?? false,
		stack: [],
		stop: false,
	};
	visitTableRefs(node, state);
}

function emptyTableFrame(): TableScopeFrame {
	return { ctes: new Set(), bound: new Map() };
}

function emit(state: TableRefWalkState, ref: TableRef): void {
	if (state.stop) return;
	if (state.sink(ref) === true) state.stop = true;
}

/** Whether any enclosing WITH frame declares `nameLower` as a CTE. */
function isCteInScope(state: TableRefWalkState, nameLower: string): boolean {
	for (const frame of state.stack) {
		if (frame.ctes.has(nameLower)) return true;
	}
	return false;
}

/**
 * Resolve a bare column qualifier innermost-first against the scope stack.
 * `binding` is the real unaliased table source it binds, or `null` when it
 * binds something that is not directly a table name (an alias, a CTE, a
 * subquery / function source); `frameIndex` is the stack index of the frame
 * that bound it, so the collision predicate can be evaluated at the BINDING
 * frame's depth — a deeper frame binding the new name is inner to the source
 * and must not falsely trigger. Returns `undefined` when nothing in scope
 * binds the qualifier.
 */
function resolveQualifier(
	state: TableRefWalkState,
	qualifierLower: string,
): { binding: { schema: string | undefined; name: string } | null; frameIndex: number } | undefined {
	for (let i = state.stack.length - 1; i >= 0; i--) {
		const frame = state.stack[i];
		const binding = frame.bound.get(qualifierLower);
		if (binding !== undefined) return { binding, frameIndex: i };
		// A CTE name in scope shadows the qualifier even without a FROM entry
		// (mirrors the column walker's rebind scan, which counts `ctesInScope`).
		if (frame.ctes.has(qualifierLower)) return { binding: null, frameIndex: i };
	}
	return undefined;
}

/**
 * Whether `nameLower` is visible as a column qualifier at frame `limit` or any
 * enclosing frame — a FROM binding (an alias or an unaliased source's name) or
 * a CTE declaration.
 */
function qualifierVisibleUpTo(state: TableRefWalkState, nameLower: string, limit: number): boolean {
	for (let i = 0; i <= limit && i < state.stack.length; i++) {
		const frame = state.stack[i];
		if (frame.bound.has(nameLower) || frame.ctes.has(nameLower)) return true;
	}
	return false;
}

/**
 * The predicate behind {@link TableRef.qualifierCollides}, evaluated at the
 * SOURCE's own frame (its FROM frame for the source emit, the binding frame
 * for a bound column-qualifier emit — the same frame, so the two sites always
 * agree). `nameLower` collides when it is visible as a qualifier at or above
 * that frame, OR when the frame's select SUBTREE can introduce it (an inner
 * alias / source / CTE): a qualifier bound to the source can sit inside a
 * correlated subquery, where an inner binding of the new name would capture
 * its new spelling — `select t.x from t where exists (select 1 from other as
 * t2 where t2.id = t.id)` must not let `t → t2` re-bind the correlation.
 * Frame state was filled with pre-rewrite names before anything under the
 * FROM was visited, and the subtree set is memoized on first consult, so
 * every consult for one frame gets the same answer regardless of visit order.
 */
function qualifierCollidesAt(state: TableRefWalkState, nameLower: string, frameIndex: number): boolean {
	if (qualifierVisibleUpTo(state, nameLower, frameIndex)) return true;
	const frame = state.stack[frameIndex];
	if (!frame?.subtreeRoot) return false;
	frame.introduced ??= collectIntroducedQualifierNames(frame.subtreeRoot);
	return frame.introduced.has(nameLower);
}

/**
 * Every name `root`'s subtree can bind as a column qualifier or capture a FROM
 * source with, lowercased: FROM source bare names and aliases, subquery /
 * function-source aliases, CTE names, UPDATE/DELETE correlation names.
 * Deliberately position-blind and conservative — a name introduced in a
 * sibling subquery that could never actually shadow the consulted source still
 * counts, because the only cost of a false positive is a harmless explicit
 * alias on the renamed source. Structural recursion over plain objects/arrays
 * so unknown node kinds are walked rather than missed.
 */
function collectIntroducedQualifierNames(root: AST.AstNode): Set<string> {
	const names = new Set<string>();
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (node === null || typeof node !== 'object') return;
		const obj = node as Record<string, unknown>;
		switch (obj.type) {
			case 'table': {
				const ts = obj as unknown as AST.TableSource;
				names.add((ts.alias ?? ts.table.name).toLowerCase());
				break;
			}
			case 'subquerySource':
				names.add((obj as unknown as AST.SubquerySource).alias.toLowerCase());
				break;
			case 'functionSource': {
				const alias = (obj as unknown as AST.FunctionSource).alias;
				if (alias) names.add(alias.toLowerCase());
				break;
			}
			case 'commonTableExpr':
				names.add((obj as unknown as AST.CommonTableExpr).name.toLowerCase());
				break;
			case 'update':
			case 'delete': {
				const alias = (obj as unknown as AST.UpdateStmt | AST.DeleteStmt).alias;
				if (alias) names.add(alias.toLowerCase());
				break;
			}
			default:
				break;
		}
		for (const value of Object.values(obj)) visit(value);
	};
	visit(root);
	return names;
}

/**
 * Push a WITH frame and visit each member's body inside it, registering names
 * in the SAME visibility order the planner uses
 * ({@link import('../../planner/building/with.js').buildCommonTableExpr}) and
 * the column walker mirrors: a `with recursive` member registers its own name
 * BEFORE its body is visited (so the recursive leg's self-reference resolves
 * to the CTE, not a same-named real table); a non-recursive member registers
 * AFTER (its body must not see itself, only prior siblings — a forward
 * reference to a later sibling binds the real table and still rewrites).
 *
 * Caller is responsible for popping the frame (in a `finally`).
 */
function pushWithFrame(withClause: AST.WithClause | undefined, state: TableRefWalkState): void {
	const frame = emptyTableFrame();
	state.stack.push(frame);
	if (!withClause) return;
	for (const cte of withClause.ctes) {
		const nameLower = cte.name.toLowerCase();
		if (withClause.recursive) frame.ctes.add(nameLower);
		visitTableRefs(cte.query, state);
		frame.ctes.add(nameLower);
	}
}

/**
 * Collect the qualifiers a FROM clause binds into `frame`. Runs BEFORE the
 * frame is pushed (and before anything under the FROM is visited), so the
 * bindings reflect pre-rewrite names — every match still compares against the
 * old name.
 */
function collectFromBindings(
	item: AST.FromClause,
	state: TableRefWalkState,
	frame: TableScopeFrame,
): void {
	switch (item.type) {
		case 'table': {
			const ts = item as AST.TableSource;
			const nameLower = ts.table.name.toLowerCase();
			const bindsCte = ts.table.schema === undefined && isCteInScope(state, nameLower);
			if (ts.alias) {
				// The alias replaces the source name as the row's only qualifier;
				// renaming a table never changes an alias, so qualified refs
				// through it have nothing to rewrite even when the underlying
				// source IS the renamed table (the FROM source itself is still
				// reported as a reference by the visit below).
				frame.bound.set(ts.alias.toLowerCase(), null);
			} else {
				frame.bound.set(nameLower,
					bindsCte ? null : { schema: ts.table.schema, name: ts.table.name });
			}
			break;
		}
		case 'join': {
			const join = item as AST.JoinClause;
			collectFromBindings(join.left, state, frame);
			collectFromBindings(join.right, state, frame);
			break;
		}
		case 'subquerySource':
			frame.bound.set((item as AST.SubquerySource).alias.toLowerCase(), null);
			break;
		case 'functionSource': {
			const fs = item as AST.FunctionSource;
			// An unaliased function source contributes no qualifier.
			if (fs.alias) frame.bound.set(fs.alias.toLowerCase(), null);
			break;
		}
	}
}

/**
 * A DML target identifier. Mirrors the planner's write-target rule
 * ({@link import('../../planner/building/dml-target.js').resolveCteTarget}):
 * an UNQUALIFIED target name that matches a member of the statement's OWN
 * leading WITH clause binds that CTE — which shadows a same-named schema
 * object as a write target — so it is not a table reference; a
 * schema-qualified target never binds a CTE. Enclosing statements' CTEs do
 * NOT shadow a write target (the resolver consults only the statement's own
 * clause), so only `withClause` is checked here, not the scope stack.
 */
function visitDmlTarget(
	id: AST.IdentifierExpr,
	withClause: AST.WithClause | undefined,
	state: TableRefWalkState,
): void {
	if (state.stop) return;
	if (id.schema === undefined && (withClause?.ctes ?? []).some(c => eq(c.name, id.name))) return;
	emit(state, {
		schema: id.schema,
		name: id.name,
		setName: next => { id.name = next; },
		// A DML target re-resolves through the catalog when the body is next
		// planned, so it can carry the post-condition qualifier.
		qualify: schemaName => { id.schema = schemaName; },
		// The statement's OWN WITH can capture an unqualified target the rename
		// gives a member's name (`resolveCteTarget` binds it as a write target);
		// enclosing statements' CTEs cannot, so only `withClause` is consulted.
		cteShadows: next => id.schema === undefined && (withClause?.ctes ?? []).some(c => eq(c.name, next)),
	});
}

/**
 * Visit the clauses an UPDATE / DELETE evaluates against its TARGET row — the
 * assignments, WHERE, RETURNING and mutation-context values — inside a frame
 * binding the statement's target correlation name.
 *
 * That name is a qualifier, never a table: it is the mandatory alias of an
 * inline subquery target (`update (select …) as v set … where v.k = 1`) or the
 * collision-proof one the view-mutation lowering synthesizes for a named
 * target. Renaming a table that happens to share it must leave `v.k` alone,
 * exactly as a FROM alias is left alone — and the alias itself never moves, so
 * rewriting the qualifier would only break the reference.
 */
function visitDmlTargetRowClauses(
	stmt: AST.UpdateStmt | AST.DeleteStmt,
	state: TableRefWalkState,
): void {
	const frame = emptyTableFrame();
	if (stmt.alias) frame.bound.set(stmt.alias.toLowerCase(), null);
	state.stack.push(frame);
	try {
		if (stmt.type === 'update') stmt.assignments.forEach(a => visitTableRefs(a.value, state));
		visitTableRefs(stmt.where, state);
		(stmt.returning ?? []).forEach(r => {
			if (r.type === 'column') visitTableRefs(r.expr, state);
		});
		(stmt.contextValues ?? []).forEach(cv => visitTableRefs(cv.value, state));
	} finally {
		state.stack.pop();
	}
}

/**
 * Visit a `with inverse` assignment expression or `with defaults` entry
 * expression with the row-image suppression forced ON, restoring the ambient
 * flag after — the table-walker twin of the column walker's
 * `visitRowImageForeignSubtree`. Unconditional on purpose: these subtrees are
 * written-row context of their enclosing select wherever the walk entered, so a
 * reached view body self-suppresses even though the entry point (rightly)
 * passed no `rowImageContext` for it.
 */
function visitRowImageSubtree(expr: AST.Expression, state: TableRefWalkState): void {
	const ambient = state.rowImage;
	state.rowImage = true;
	try {
		visitTableRefs(expr, state);
	} finally {
		state.rowImage = ambient;
	}
}

function visitTableRefs(node: AST.AstNode | undefined, state: TableRefWalkState): void {
	if (!node || state.stop) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = emptyTableFrame();
				(stmt.from ?? []).forEach(f => collectFromBindings(f, state, frame));
				frame.subtreeRoot = stmt;
				state.stack.push(frame);
				try {
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') {
							visitTableRefs(c.expr, state);
							// A `with inverse` assignment expr can embed a subquery naming any
							// table; the assignment's target names a base COLUMN, untouched by a
							// table rename (same as the `with defaults` clause below). Both sit
							// in this body's FROM frame — but the expr is written-row context
							// of the ENCLOSING select regardless of the walk's entry point: a
							// bare unbound `new.<x>` there names an output column of this
							// select (docs/sql-select.md § Result-column inverses), never a
							// table called `new`, so the row-image suppression is forced over
							// the subtree (the column walker forces `'foreign'` over the same
							// one).
							(c.inverse ?? []).forEach(a => visitRowImageSubtree(a.expr, state));
						}
					});
					// `with defaults` clause: each entry's `expr` (an inserted-row default) can
					// embed a subquery naming any table; the entry's `column` names a base
					// COLUMN, untouched by a table rename. A defaults entry is documented
					// self-contained — it cannot reference the inserted row — but nothing
					// enforces that at CREATE VIEW time, so a bare unbound `new.` / `old.`
					// there is pinned inert the same way (column-walker parity; such a ref
					// could never plan as a table reference anyway).
					(stmt.defaults ?? []).forEach(d => visitRowImageSubtree(d.expr, state));
					(stmt.from ?? []).forEach(f => visitTableRefs(f, state));
					visitTableRefs(stmt.where, state);
					(stmt.groupBy ?? []).forEach(g => visitTableRefs(g, state));
					visitTableRefs(stmt.having, state);
					(stmt.orderBy ?? []).forEach(o => visitTableRefs(o.expr, state));
					visitTableRefs(stmt.limit, state);
					visitTableRefs(stmt.offset, state);
					// Set-op legs stay inside this select's frames (mirroring the column
					// walker): each leg is its own select and pushes its own frames on top.
					visitTableRefs(stmt.union, state);
					if (stmt.compound) visitTableRefs(stmt.compound.select, state);
				} finally {
					state.stack.pop();
				}
			} finally {
				state.stack.pop();
			}
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				visitDmlTarget(stmt.table, stmt.withClause, state);
				visitTableRefs(stmt.source, state);
				(stmt.upsertClauses ?? []).forEach(uc => {
					(uc.assignments ?? []).forEach(a => visitTableRefs(a.value, state));
					visitTableRefs(uc.where, state);
				});
				(stmt.returning ?? []).forEach(r => {
					if (r.type === 'column') visitTableRefs(r.expr, state);
				});
				(stmt.contextValues ?? []).forEach(cv => visitTableRefs(cv.value, state));
			} finally {
				state.stack.pop();
			}
			break;
		}
		case 'update':
		case 'delete': {
			const stmt = node as AST.UpdateStmt | AST.DeleteStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				// An inline subquery target (`update (select …) as v set …`): `table` is a
				// synthetic placeholder equal to the alias, not a table reference — the real
				// references live inside the subquery body. Visited OUTSIDE the target frame
				// below: the body cannot see its own correlation name.
				if (stmt.targetSource) visitTableRefs(stmt.targetSource, state);
				else visitDmlTarget(stmt.table, stmt.withClause, state);
				visitDmlTargetRowClauses(stmt, state);
			} finally {
				state.stack.pop();
			}
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => visitTableRefs(v, state)));
			break;
		}
		case 'table': {
			const ts = node as AST.TableSource;
			// A FROM source. An unqualified name that a CTE in scope declares binds
			// the CTE, not a same-named real table; a schema-qualified source
			// (`main.zap`) is never a CTE. The alias, if any, does not matter here —
			// `from zap z` still reads the real table.
			if (!(ts.table.schema === undefined && isCteInScope(state, ts.table.name.toLowerCase()))) {
				// The top of the stack IS this source's own FROM frame: `case 'table'`
				// is reachable only from a select's `from` array (directly or through
				// `join` — UPDATE/DELETE targets are typed `AST.SubquerySource`), and
				// the select arm pushes the FROM frame before visiting it.
				const sourceFrameIndex = state.stack.length - 1;
				const ref: TableRef = {
					schema: ts.table.schema,
					name: ts.table.name,
					setName: next => { ts.table.name = next; },
					// A FROM source re-resolves through the catalog, so it can carry
					// the post-condition qualifier. Column qualifiers bound through
					// this source are unaffected: their frame bindings were copied by
					// value BEFORE anything under the FROM was visited, and a
					// qualified `main.t2` source still exposes the bare qualifier
					// `t2` to the rows it produces.
					qualify: schemaName => { ts.table.schema = schemaName; },
					// The catalog resolvers cannot see a CTE capturing the new name.
					cteShadows: next => ts.table.schema === undefined && isCteInScope(state, next.toLowerCase()),
				};
				if (ts.alias === undefined) {
					// Only an unaliased source exposes its own name as a qualifier;
					// an aliased one exposes the alias, which a rename never moves.
					ref.qualifierCollides = next => qualifierCollidesAt(state, next.toLowerCase(), sourceFrameIndex);
					ref.aliasAs = aliasName => { ts.alias = aliasName; };
				}
				emit(state, ref);
			}
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitTableRefs(join.left, state);
			visitTableRefs(join.right, state);
			visitTableRefs(join.condition, state);
			break;
		}
		case 'functionSource': {
			const fs = node as AST.FunctionSource;
			fs.args.forEach(a => visitTableRefs(a, state));
			break;
		}
		case 'subquerySource': {
			const ss = node as AST.SubquerySource;
			visitTableRefs(ss.subquery, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitTableRefs(e.left, state);
			visitTableRefs(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate': {
			visitTableRefs((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		}
		case 'function': {
			(node as AST.FunctionExpr).args.forEach(a => visitTableRefs(a, state));
			break;
		}
		case 'subquery': {
			visitTableRefs((node as AST.SubqueryExpr).query, state);
			break;
		}
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitTableRefs(wf.function, state);
			visitTableRefs(wf.window, state);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitTableRefs(p, state));
			(wd.orderBy ?? []).forEach(o => visitTableRefs(o.expr, state));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitTableRefs(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visitTableRefs(wt.when, state);
				visitTableRefs(wt.then, state);
			});
			visitTableRefs(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitTableRefs(ie.expr, state);
			(ie.values ?? []).forEach(v => visitTableRefs(v, state));
			visitTableRefs(ie.subquery, state);
			break;
		}
		case 'exists': {
			visitTableRefs((node as AST.ExistsExpr).subquery, state);
			break;
		}
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitTableRefs(be.expr, state);
			visitTableRefs(be.lower, state);
			visitTableRefs(be.upper, state);
			break;
		}
		case 'column': {
			const col = node as AST.ColumnExpr;
			if (!col.table) break;
			if (col.schema !== undefined) {
				// A schema-qualified qualifier (`main.zap.k`) can never be a CTE, an
				// alias, or a row image — always a real table reference. No `qualify`:
				// it only matches when its written schema IS the renamed schema, so
				// the rewrite post-condition holds by construction (a qualified name
				// resolves by passthrough).
				emit(state, {
					schema: col.schema,
					name: col.table,
					setName: next => { col.table = next; },
				});
				break;
			}
			const qualifierLower = col.table.toLowerCase();
			const resolved = resolveQualifier(state, qualifierLower);
			if (resolved === undefined) {
				// Nothing in scope binds the qualifier: a seedless expression context
				// (a CHECK / index-predicate self-qualifier, or correlation the walk
				// cannot see). Treat as a direct table reference — except the row
				// image in a written-row context.
				if (state.rowImage && (qualifierLower === 'new' || qualifierLower === 'old')) break;
				emit(state, {
					schema: undefined,
					name: col.table,
					setName: next => { col.table = next; },
					// Seedless, so it re-resolves through the catalog and can carry
					// the post-condition qualifier. In practice this only ever fires
					// on an already-unevaluable body: a CHECK / DEFAULT plans under
					// its owning schema ONLY (`schemaAuthoredContext`), so a bare
					// qualifier that resolves by falling through to ANOTHER schema —
					// the only way the post-condition can fail here — is one the
					// planner already rejects. Harmless, arguably an improvement.
					qualify: schemaName => { col.schema = schemaName; },
				});
			} else if (resolved.binding !== null) {
				// Bound by an unaliased real table source: the qualifier IS that
				// table's name. Report under the SOURCE's identity so a source in
				// another schema doesn't match by bare name. No `qualify`: this
				// reference binds through the FROM frame, not the catalog —
				// qualifying the SOURCE (the `table` case above) is what preserves
				// resolution; the qualifier just needs the new bare name.
				const { binding, frameIndex } = resolved;
				emit(state, {
					schema: binding.schema,
					name: binding.name,
					setName: next => { col.table = next; },
					// Evaluated at the BINDING frame — the source's own depth — so
					// this answer always matches the source emit's (same frame,
					// same memoized subtree set). No `aliasAs`: when this fires,
					// the sink leaves the qualifier's old spelling in place and
					// the SOURCE gains the alias that keeps it bound.
					qualifierCollides: next => qualifierCollidesAt(state, next.toLowerCase(), frameIndex),
				});
			}
			// resolved.binding === null: an alias / CTE / subquery / function source
			// — the qualifier is not a table name; nothing to report.
			break;
		}
		// Leaf nodes / DDL — nothing to recurse into for our purposes.
		default:
			break;
	}
}
