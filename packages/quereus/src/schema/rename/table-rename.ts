import type * as AST from '../../parser/ast.js';
import { eq, objectRefKey, rewriteEach, type ResolveObjectRef, type TableRenameTarget } from './shared.js';

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
	 * a table reference. (The column walker's seeded entry point records the
	 * same asymmetry from the other direction.)
	 */
	rowImageContext?: boolean;
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
 * The rewrite additionally enforces a POST-CONDITION the probe does not need:
 * after rewriting, re-resolving the reference under the same home schema path
 * against the catalog AS IT WILL BE AFTER THE RENAME (`target.resolveAfter`)
 * must still yield the renamed object's key. When it would not — the bare new
 * name is captured by an earlier schema on the body's home path — the reference
 * is schema-qualified via {@link TableRef.qualify}. Qualification is
 * conditional, not eager, so the common no-collision rename leaves body text
 * (and a materialized view's `bodyHash`) exactly as before. A qualified
 * reference holds the post-condition by construction (it only matched because
 * its written schema IS the renamed schema, and a qualified name resolves by
 * passthrough), so only unqualified references can ever qualify.
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
			ref.setName(newName);
			changed = true;
			if (ref.qualify && resolveAfter(ref.schema, newName) !== newTargetKey) {
				ref.qualify(schemaName);
			}
		}
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
 * doc comment.
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
		expr => renameTableInAst(expr, target));
}

/**
 * Rewrite the renamed table inside every CHECK constraint expression of `checks`,
 * in place. A CHECK may carry a table-qualified self-reference (`check (t.b > 0)`)
 * exactly as a partial-index predicate may, and a table rename must follow it.
 *
 * A CHECK is evaluated against a written row, so the walk runs with
 * {@link TableRenameOpts.rowImageContext}: a bare `new.a` / `old.a` names the
 * row image and survives even a rename of a table literally called `new`.
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
		expr => renameTableInAst(expr, target, { rowImageContext: true }));
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
 * row image, not a table called `new`.
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
		renameTableInAst(expr, target, { rowImageContext: true });
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
 * Returns the real unaliased table source it binds, `null` when it binds
 * something that is not directly a table name (an alias, a CTE, a subquery /
 * function source), or `undefined` when nothing in scope binds it.
 */
function resolveQualifier(
	state: TableRefWalkState,
	qualifierLower: string,
): { schema: string | undefined; name: string } | null | undefined {
	for (let i = state.stack.length - 1; i >= 0; i--) {
		const frame = state.stack[i];
		const binding = frame.bound.get(qualifierLower);
		if (binding !== undefined) return binding;
		// A CTE name in scope shadows the qualifier even without a FROM entry
		// (mirrors the column walker's rebind scan, which counts `ctesInScope`).
		if (frame.ctes.has(qualifierLower)) return null;
	}
	return undefined;
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

function visitTableRefs(node: AST.AstNode | undefined, state: TableRefWalkState): void {
	if (!node || state.stop) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = emptyTableFrame();
				(stmt.from ?? []).forEach(f => collectFromBindings(f, state, frame));
				state.stack.push(frame);
				try {
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') {
							visitTableRefs(c.expr, state);
							// A `with inverse` assignment expr can embed a subquery naming any
							// table; the assignment's target names a base COLUMN, untouched by a
							// table rename (same as the `with defaults` clause below). Both sit
							// in this body's FROM frame.
							(c.inverse ?? []).forEach(a => visitTableRefs(a.expr, state));
						}
					});
					// `with defaults` clause: each entry's `expr` (an inserted-row default) can
					// embed a subquery naming any table; the entry's `column` names a base
					// COLUMN, untouched by a table rename.
					(stmt.defaults ?? []).forEach(d => visitTableRefs(d.expr, state));
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
				emit(state, {
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
				});
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
			const binding = resolveQualifier(state, qualifierLower);
			if (binding === undefined) {
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
			} else if (binding !== null) {
				// Bound by an unaliased real table source: the qualifier IS that
				// table's name. Report under the SOURCE's identity so a source in
				// another schema doesn't match by bare name. No `qualify`: this
				// reference binds through the FROM frame, not the catalog —
				// qualifying the SOURCE (the `table` case above) is what preserves
				// resolution; the qualifier just needs the new bare name.
				emit(state, {
					schema: binding.schema,
					name: binding.name,
					setName: next => { col.table = next; },
				});
			}
			// binding === null: an alias / CTE / subquery / function source — the
			// qualifier is not a table name; nothing to report.
			break;
		}
		// Leaf nodes / DDL — nothing to recurse into for our purposes.
		default:
			break;
	}
}
