import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { type SqlValue, StatusCode } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { sqlValueIdentical } from '../../util/comparison.js';
import { buildSelectStmt } from '../building/select.js';
import { classifyViewBody } from './propagate.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import { deriveViewColumns, resolveBaseSite, type ViewColumn } from '../analysis/update-lineage.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import type { MultiSourceKeyCapture } from './multi-source.js';
import { requireValidatedNewRefIndex } from '../analysis/authored-inverse.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { transformExpr, cloneExpr, substituteNewRefs, transformScopedExpr, transformScopedQuery, transformAliasScopedQuery, type ScopeContext } from './scope-transform.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { bodyDefaults, isViewSchema } from '../../schema/view.js';
import { bodyPlanningContext } from './body-context.js';

/**
 * Single-source view-mediated DML rewriting (the single-source spine of the
 * view-mutation substrate).
 *
 * When an INSERT / UPDATE / DELETE targets a view whose body is a single-source
 * projection-and-filter, these helpers analyse the body and produce an
 * equivalent statement targeting the underlying base table. The base statement
 * is then planned by the ordinary base-table builder, so all constraint /
 * conflict / RETURNING / FK / mutation-context machinery is reused verbatim and
 * `getChangeScope()` / `Database.watch` see the base write with no extra wiring.
 *
 * These produce exactly one {@link import('./propagate.js').BaseOp} per call;
 * `propagate()` wraps the result and the builder (`building/view-mutation-builder.ts`)
 * re-plans it into a `ViewMutationNode`. Multi-source fan-out (more than one
 * base op) is the next phase.
 *
 * The same rewrite drives **materialized-view write-through**: every MV is
 * (post row-time consolidation) a single-source projection-and-filter — a strict
 * subset of the shape this classifier accepts — so DML targeting an MV name is
 * rewritten to its source `T` and re-planned identically; the existing row-time
 * maintenance hook then brings the backing into sync within the same statement
 * (reads-own-writes, rollback in lockstep). Hence the view parameter is the
 * minimal {@link MutableViewLike} structural shape both `ViewSchema` and a
 * maintained table's `maintainedTableViewLike` adapter satisfy — the rewrite
 * reads only `name` / `schemaName` / `selectAst` / `columns`. See
 * `docs/materialized-views.md` § Write boundary and `docs/view-updateability.md`.
 *
 * RETURNING-through-views is supported: {@link rewriteViewReturning} rewrites the
 * clause into base terms and attaches it to the rewritten base statement, so the
 * base op's own RETURNING machinery yields the view-projected post-mutation rows
 * (insert/update against NEW, delete against OLD; computed view columns
 * re-evaluated against the post-mutation base values).
 */

/**
 * The minimal view-schema surface the rewrite reads — satisfied by both
 * `ViewSchema` and a maintained table's `maintainedTableViewLike` adapter
 * (`schema/derivation.ts`). Keeping the parameter structural lets MV
 * write-through reuse the plain-view rewrite verbatim, with no MV-shaped
 * special-casing in the three builders.
 */
export interface MutableViewLike {
	readonly name: string;
	readonly schemaName: string;
	/** View body — any relation-producing QueryExpr. A SELECT body carries its own
	 *  trailing `with defaults (…)` clause ({@link AST.SelectStmt.defaults}), read
	 *  via {@link bodyDefaults}. */
	readonly selectAst: AST.QueryExpr;
	readonly columns?: ReadonlyArray<string>;
	/** View-level metadata tags — validated at the `view-ddl` site on mutation. */
	readonly tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * What to call this target in body-shape rejection diagnostics — `'view'`
	 * (the default for a plain {@link import('../../schema/view.js').ViewSchema})
	 * or `'materialized view'` (set by `maintainedTableViewLike`). Write-through
	 * presents a maintained table through this same adapter, so without it an
	 * unsupported-body reject (e.g. an aggregate-bodied MV) would misname the MV
	 * a "view". Only the `analyzeView` body-shape rejects consult it; the
	 * per-column rewrite diagnostics keep the generic "view" framing.
	 */
	readonly noun?: string;
	/**
	 * True when this view-like is a CTE body or inline FROM-subquery target, NOT a
	 * schema-registered view / MV. It carries no backing schema object, so
	 * {@link import('../building/view-mutation-builder.js').buildViewMutation} skips
	 * the two schema-object-coupled steps for it — the `view` schema-dependency
	 * recording (there is nothing to depend on, and the CTE body is re-planned from
	 * the statement AST every run) and the reserved-tag validation (an ephemeral
	 * target carries no {@link tags}). Every other substrate step already degrades
	 * correctly: each lens-slot / decomposition / set-op lookup keys on a schema
	 * object the CTE name has none of, so the single-source spine is taken for a
	 * plain projection-filter body. Diagnostics name the target by {@link noun}.
	 */
	readonly ephemeral?: boolean;
	/**
	 * True for an ephemeral **CTE-name** target (resolved by `resolveCteTarget`); an
	 * inline FROM-subquery target (`resolveSubqueryTarget`) leaves it undefined. Gates the
	 * user-predicate self-read eager-capture path (docs/vu-operators.md § Common
	 * Table Expressions — self-reference): a CTE name can appear unqualified in the user
	 * `where`/`set`/`returning` and self-read the target, resolving against an eager
	 * snapshot of the body; an inline subquery's alias does not (its predicate names the
	 * real base table directly and already round-trips). The capture path also requires
	 * the incoming planning context be target-EXCLUDED — in fact narrowed to the target's
	 * prior-sibling prefix (`contextForCteTarget`, a superset of target-exclusion), which
	 * only the CTE-name dispatch applies — so the flag both selects the case and asserts
	 * that precondition.
	 */
	readonly cteTarget?: boolean;
}

/**
 * Reserved, collision-proof correlation name synthesised onto the lowered
 * single-source UPDATE/DELETE target. The `__` internal-name convention (same family
 * as `__vmupd_keys` / `__shared_key`) guarantees it cannot collide with any
 * user-introduced FROM source, so a substituted subquery-descent base term qualified
 * with it (`__vm_self.col`) always binds the outer target row — even when the user
 * subquery FROM names the view's own base table. Lowered-target nesting cannot occur
 * (view-over-view / MV-over-MV / view-over-MV are all rejected by `analyzeView`, and a
 * user subquery is a plain SELECT that never re-lowers), so a single module-level
 * constant suffices: two `__vm_self`-aliased targets can never be in scope at once.
 *
 * The **multi-source** per-side lowered UPDATE (`multi-source.ts`) reuses this same
 * constant: each per-side op is a flat single-table base UPDATE, planned independently
 * through this same base builder and never co-scoped or nested with another lowered
 * target, so the same "at most one `__vm_self` in scope" invariant holds. The per-side
 * UPDATE carries `alias: SELF_ALIAS`, and its capture read-back owning-PK operands and
 * owning-side strip-to-bare refs are qualified with it, so a correlation reference
 * emitted inside a user value subquery binds the target row rather than re-binding to a
 * same-named column in the subquery's own FROM (the multi-source analog of the
 * single-source qualification below).
 */
export const SELF_ALIAS = '__vm_self';

/** A base column pinned to a constant by the view's selection predicate. */
interface FilterConstant {
	readonly baseColumnName: string;
	readonly valueExpr: AST.Expression;
	readonly value: SqlValue | undefined;
}

/**
 * A view column whose lineage resolves to a writable single base column — the
 * full writable-base set the UPDATE write path routes through: `identity` /
 * rename (`b as bc`), `passthrough` (an identity-on-value transform — `b collate
 * nocase as bc`, a no-op `cast(b as <same logical type>) as bc`; `inverse`
 * absent), and `inverse` (a non-identity invertible transform — `b + 1 as bp`;
 * `inverse` present). On the UPDATE write path the assigned value is routed to
 * {@link baseColumn}, run through {@link inverse} **only when present** (`bp = 9`
 * ⇒ `b = 9 - 1`); an identity / passthrough column stores the value verbatim
 * (there is no inverse — the stored value is unchanged). This mirrors the
 * multi-source spine, whose `OutColumn.writable` is likewise inverse-agnostic
 * (`base` site, not null-extended) and applies `inverse` only when present
 * (`multi-source.ts` `decomposeUpdate`). An `opaque` (non-invertible) /
 * null-extended column carries no entry here, so a write to it still raises
 * `no-inverse` via the `requireBaseColumn` fallback. **INSERT consults this map too**
 * (`rewriteViewInsert`): a column with a site whose `inverse` is *absent* — identity /
 * rename and passthrough — is insertable and stores its value verbatim; a site WITH an
 * `inverse` and a no-site (opaque) column stay non-insertable, matching the multi-source
 * contract (`outColumns.filter(c => c.writable && !c.inverse)`). The identity-only AST
 * `deriveViewColumns` model is still not widened — it remains the parity bridge only
 * (`test/property.spec.ts`); INSERT and UPDATE both read this richer site map instead.
 *
 * An **`authored`** site (`with inverse (col = expr, …)` on the result column —
 * docs/vu-inverses.md § Authored inverses) is writable AND insertable: the
 * write fans out through the authored put expressions (one base assignment / VALUES
 * cell per put), with each `new.<output-col>` reference resolved through
 * {@link AuthoredWritableSite.newRefIndex} — the assigned/supplied view value for
 * the written column, the column's forward read image otherwise.
 */
interface BaseWritableSite {
	readonly kind: 'base';
	readonly baseColumn: string;
	/** Present only for a non-identity `inverse` profile; absent for identity / passthrough. */
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	/** Domain restriction the profile carries (none shipped today — see analyzeView note). */
	readonly domain?: AST.Expression;
}

interface AuthoredWritableSite {
	readonly kind: 'authored';
	/** One put per clause assignment (single-source: every target lives on the one base table). */
	readonly puts: ReadonlyArray<{ readonly baseColumn: string; readonly expr: AST.Expression }>;
	/** Lowercased `new.<name>` → view-column index (positionally stable under a `v(a, b)` rename). */
	readonly newRefIndex: ReadonlyMap<string, number>;
}

type WritableSite = BaseWritableSite | AuthoredWritableSite;

interface ViewAnalysis {
	readonly baseTable: TableSchema;
	readonly viewColumns: readonly ViewColumn[];
	/** The view body's WHERE predicate (in base-column terms), if any. */
	readonly filterPredicate?: AST.Expression;
	readonly filterConstants: readonly FilterConstant[];
	/** view-column-name (lowercase) → replacement expression in base terms. */
	readonly columnMap: ReadonlyMap<string, AST.Expression>;
	/** view-column-name (lowercase) → writable-base write site (identity / passthrough / inverse). Consumed by the UPDATE SET path and by INSERT (which admits the inverse-absent subset). */
	readonly writableSites: ReadonlyMap<string, WritableSite>;
}

function columnExpr(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

function tableIdentifier(table: TableSchema): AST.IdentifierExpr {
	return { type: 'identifier', name: table.name, schema: table.schemaName };
}

/** Flatten a conjunction (`a AND b AND c`) into its conjuncts. */
export function flattenAnd(expr: AST.Expression): AST.Expression[] {
	if (expr.type === 'binary' && expr.operator === 'AND') {
		return [...flattenAnd(expr.left), ...flattenAnd(expr.right)];
	}
	return [expr];
}

/** Conjoin two optional predicates with AND. */
export function combineAnd(a: AST.Expression | undefined, b: AST.Expression | undefined): AST.Expression | undefined {
	if (a && b) return { type: 'binary', operator: 'AND', left: a, right: b };
	return a ?? b;
}

/**
 * Rewrite base-term column references so they resolve against the single base
 * table after the rewrite. The view body may qualify its base columns by the
 * source's alias or the base table name (`x.col` / `pa.col`); the rewritten
 * statement has exactly one source, so a top-level qualifier is dropped (an
 * unqualified reference resolves unambiguously). This normalizes the **view
 * body's own** projection / WHERE terms (already in base terms). The **user**
 * predicate / assigned-value descent (where a nested reference can name a *view*
 * column) is handled separately by {@link makeViewColumnDescend}.
 *
 * The rule is **depth-split**:
 *
 * - **top level** → strip the base-source qualifier to a bare name;
 * - **nested** (inside one of the fragment's own subqueries — a computed lineage
 *   term such as `(select lbl from gl where gl.id = gt.id)`, or the same shape in
 *   the body's WHERE) → **re-point** the base-source qualifier at
 *   `correlationName`, the lowered statement's correlation name.
 *
 * Stripping at depth would be wrong, not merely redundant: a bare name inside the
 * subquery re-binds to a same-named column of the subquery's OWN FROM by ordinary
 * innermost-scope rules (`gl.id = gt.id` → `id = id` → `gl.id = gl.id`), silently
 * writing the wrong rows. Re-pointing keeps the correlation to the target row. A
 * qualifier the subquery's own FROM binds is left local by the same innermost-scope
 * rule (the `aliasShadow` check), and an unqualified nested reference is left alone
 * — it is already correct by construction, since the subquery's FROM is copied
 * unchanged. This mirrors the multi-source spine's `stripSideQualifier`
 * (owning-side alias → `__vm_self`, at any depth, alias-scope-aware).
 *
 * `correlationName` defaults to the base table's own name: INSERT lowers onto the
 * bare base-table name, so the nested rewrite is a no-op there. UPDATE/DELETE pass
 * the synthesised {@link SELF_ALIAS} their lowered target carries.
 */
function normalizeBaseRefs(expr: AST.Expression, aliases: ReadonlySet<string>, correlationName: string): AST.Expression {
	const stripTop = (col: AST.ColumnExpr): AST.Expression | undefined =>
		col.table && aliases.has(col.table.toLowerCase()) ? { type: 'column', name: col.name } : undefined;
	const requalifyNested = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined => {
		if (!col.table) return undefined;
		const lcQual = col.table.toLowerCase();
		if (aliasShadow.has(lcQual) || !aliases.has(lcQual)) return undefined;
		// `schema` is cleared alongside the qualifier so a `main.gt.id` spelling cannot
		// produce `main.__vm_self.id` (the correlation name lives in no schema).
		return { ...col, table: correlationName, schema: undefined };
	};
	return transformExpr(expr, stripTop, (q) => transformAliasScopedQuery(q, requalifyNested));
}

/**
 * Build the closure that correlation-qualifies a substituted base *term* emitted
 * INSIDE a subquery operand of a single-source rewrite. An unqualified base term
 * there would re-bind to a same-named source the subquery's own FROM introduces
 * (innermost SQL scoping) instead of correlating to the outer UPDATE/DELETE target
 * row. Qualifying it with `qualifierName` makes it correlate to the outer row
 * regardless of what the subquery FROM defines. For UPDATE/DELETE the caller passes
 * the lowered target's synthesised collision-proof alias ({@link SELF_ALIAS}), so the
 * qualified term binds the outer row even when the subquery FROM names the view's own
 * base table; INSERT leaves it at the base table name (no target-row scan to collide
 * with). Default is the bare base table name.
 *
 * The qualification is **scope-aware and DEEP** (it rides the shared
 * {@link transformScopedExpr} descent over {@link makeBaseQualifyScope}): it
 * qualifies a base-table column at the replacement's top level, and descends into a
 * nested scalar subquery WITHIN the replacement (a computed lineage term such as
 * `(select x from oth where fk = id)`), qualifying only the lineage's own
 * correlation refs — a base column not shadowed by the lineage subquery's own FROM
 * — and leaving the lineage's genuinely-local columns alone. The multi-source
 * spine has its own analog (`makeSideQualifyScope` in multi-source.ts), which
 * qualifies a bare lineage leaf with its owning side's alias.
 *
 * Returns a fresh tree (does not mutate the shared `columnMap` entry).
 */
function makeBaseQualifier(
	ctx: PlanningContext,
	baseTable: TableSchema,
	qualifierName: string = baseTable.name,
): (repl: AST.Expression) => AST.Expression {
	const scope = makeBaseQualifyScope(baseTable, qualifierName);
	return (repl) => transformScopedExpr(ctx, scope, repl);
}

/**
 * The {@link ScopeContext} for the base-term correlation-qualifier — the
 * scope-aware DEEP qualify of a substituted base term. Its substitution qualifies
 * an unqualified BASE-table column that is not shadowed with `qualifierName` — the
 * lowered statement's correlation name (the synthesised {@link SELF_ALIAS} for
 * UPDATE/DELETE, the bare base table name for INSERT / multi-source). An
 * already-qualified ref, a non-base name (a lineage-local column such as the `x` /
 * `fk` a nested subquery's own FROM introduces), or a shadowed name is left untouched.
 * Restricting to base columns changes nothing for a `normalizeBaseRefs`-normalized
 * lineage (whose top-level refs are all base columns) and is the principled gate: only
 * the view's own base-term lineage is correlation-qualified, never a column a nested
 * source owns.
 *
 * The `if (col.table) return undefined` early return is deliberate and still right:
 * every base-source qualifier a definition fragment carries has already been resolved
 * upstream by {@link normalizeBaseRefs} — stripped at the fragment's top level,
 * re-pointed at the lowered correlation name inside the fragment's own subqueries — so
 * any qualified reference still standing when this scope runs is either that already-
 * correct correlation name or a user-authored qualifier naming a source of the enclosing
 * statement. Both must be left untouched.
 *
 * An unresolvable scope (`select *` / TVF / CTE) is **rejected** rather than
 * tainted-and-deferred: shadowing cannot be proven, so the term could over- or
 * under-qualify into a silent wrong write (`unresolvableScope: 'reject'`).
 */
function makeBaseQualifyScope(baseTable: TableSchema, qualifierName: string = baseTable.name): ScopeContext {
	const qualifier = qualifierName;
	const baseCols = new Set(baseTable.columns.map(c => c.name.toLowerCase()));
	return {
		makeSubstitute: (shadowed) => (col) => {
			if (col.table) return undefined;
			const name = col.name.toLowerCase();
			if (shadowed.has(name) || !baseCols.has(name)) return undefined;
			return { ...col, table: qualifier };
		},
		unresolvableScope: 'reject',
		rejectUnresolvableScope: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			message: `cannot write through view: a computed column's lineage contains a correlated subquery whose source columns are not statically resolvable (a 'select *' / table-valued function / unresolved source), so its correlation cannot be proven; restructure the view body`,
		}),
		rejectDmlSubquery: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			message: `cannot correlation-qualify a view lineage term: a data-modifying subquery (INSERT/UPDATE/DELETE) within it cannot be analysed`,
		}),
	};
}

// --- view-column descent into subquery operands ---------------------------
//
// `transformExpr` rewrites a view-column reference at the top level of a user
// predicate / assigned value. A reference nested inside a `subquery` / `exists` /
// `in`-subquery operand resolves in the *lowered* base statement's scope, where
// it can silently re-bind to a same-named base column instead of the view
// column's true lineage. The descent below (the shared scope-transform over
// {@link makeViewScope}) rewrites such a nested reference to its base term — but
// scope-aware, so it neither mis-binds a reference a subquery-local source
// introduces (`in (select note from src)` where `src.note` exists) nor touches a
// base-alias-qualified reference. A reference it cannot prove correlated (an
// unresolvable subquery source) is rejected loudly rather than mis-bound silently.
// See `docs/vu-operators.md` § Selection.

/**
 * The {@link ScopeContext} for the view-column → base-term descent. A reference is
 * rewritten to its base-term lineage only when it is genuinely correlated to the
 * outer view row:
 *
 * - **qualified by the view name** → an unambiguous view-output reference;
 *   substitute (when the name is a known view column).
 * - **unqualified**, a known view column, and NOT shadowed by a source local to
 *   this (or an enclosing) subquery scope → correlated to the outer view row;
 *   substitute.
 * - **qualified by any other (base-alias) name**, or a name some local source
 *   introduces → left untouched.
 *
 * In a **tainted** scope (one whose local column names could not be resolved
 * statically) an unqualified view-column-named reference cannot be proven
 * correlated, so it is rejected with `unsupported-subquery-correlation` rather than
 * silently mis-bound — hence `unresolvableScope: 'taint'` (the substitution decides
 * per-reference once tainted, instead of rejecting the whole scope up front).
 *
 * When a replacement is emitted inside a subquery operand, `baseQualify`
 * correlation-qualifies its base terms (scope-aware and deep — see
 * {@link makeBaseQualifier}) so they bind to the outer (UPDATE/DELETE target) row
 * rather than re-binding to a same-named local source. The single-source rewriters
 * pass it; the multi-source spine passes its side-alias qualifier
 * (`makeSideQualifyScope`), which qualifies a bare lineage leaf with its owning
 * side's alias. `resolve` returns a fresh tree, never the shared `columnMap`
 * entry.
 */
function makeViewScope(
	columnMap: ReadonlyMap<string, AST.Expression>,
	viewName: string,
	view: MutableViewLike,
	baseQualify?: (repl: AST.Expression) => AST.Expression,
): ScopeContext {
	const lcView = viewName.toLowerCase();
	const resolve = (name: string): AST.Expression | undefined => {
		const repl = columnMap.get(name);
		if (!repl || !baseQualify) return repl;
		return baseQualify(repl);
	};
	return {
		makeSubstitute: (shadowed, tainted, aliasShadowed) => (col) => {
			const name = col.name.toLowerCase();
			if (col.table) {
				const lcQual = col.table.toLowerCase();
				// A view-name-qualified ref (`t.id`) is normally an unambiguous outer
				// view-output correlation, rewritten to its base-term lineage. BUT when the
				// SAME name is a locally-shadowed FROM alias — the user-predicate self-read
				// `select t.id from t` over the eager capture — `t.id` is the capture's own
				// column, not an outer correlation; leave it local (innermost-scope SQL
				// rules) so it binds to the captured snapshot rather than a de-correlated
				// `__vm_self`-qualified base term (docs/vu-operators.md § Common Table
				// Expressions — self-reference). Other ScopeContext implementers never reach
				// this branch with an aliased self-read (no own-name to shadow).
				if (aliasShadowed.has(lcQual)) return undefined;
				return lcQual === lcView ? resolve(name) : undefined;
			}
			if (shadowed.has(name)) return undefined;
			if (!columnMap.has(name)) return undefined;
			if (tainted) {
				raiseMutationDiagnostic({
					reason: 'unsupported-subquery-correlation',
					table: view.name,
					column: col.name,
					message: `cannot write through view '${view.name}': the reference '${col.name}' inside a subquery cannot be proven correlated to the view because the subquery's source columns are not statically resolvable (a 'select *' / table-valued function / unresolved source); qualify the reference with its base table or alias, or restructure the predicate`,
				});
			}
			return resolve(name);
		},
		unresolvableScope: 'taint',
		rejectDmlSubquery: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			table: view.name,
			message: `cannot write through view '${view.name}': a data-modifying subquery (INSERT/UPDATE/DELETE) in a predicate or assigned value cannot be analysed for view-column correlation`,
		}),
	};
}

/**
 * Build the `descend` transformer threaded into the top-level {@link transformExpr}
 * calls on a user predicate / assigned value, so a view-column reference nested in
 * a `subquery` / `exists` / `in`-subquery operand is rewritten scope-aware to its
 * base-term lineage. `columnMap` is the view-col (lowercase) → base-term map;
 * `viewName` is the view's own name (so a `view.col` qualifier is recognised).
 *
 * `baseQualify` is the single-source lowered statement's correlation qualifier
 * (built by {@link makeBaseQualifier} from the base table); the multi-source spine
 * passes its side-alias qualifier (`makeSideQualifyScope`), which qualifies a bare
 * lineage leaf with its owning side's alias. See {@link makeViewScope}.
 */
export function makeViewColumnDescend(
	ctx: PlanningContext,
	columnMap: ReadonlyMap<string, AST.Expression>,
	viewName: string,
	view: MutableViewLike,
	baseQualify?: (repl: AST.Expression) => AST.Expression,
): (query: AST.QueryExpr) => AST.QueryExpr {
	const scope = makeViewScope(columnMap, viewName, view, baseQualify);
	return (query) => transformScopedQuery(ctx, scope, query, new Set<string>(), false);
}

/**
 * Plan the view body, gate it for phase-1 mutability, and derive the
 * view→base column model. Throws a structured diagnostic on any unsupported
 * shape.
 *
 * `correlationName` is the name the lowered statement gives the base table, used to
 * re-point a base-source qualifier that appears INSIDE one of the copied definition
 * fragments' own subqueries ({@link normalizeBaseRefs}). UPDATE/DELETE pass the
 * synthesised {@link SELF_ALIAS} their lowered target carries; INSERT and the CTE
 * self-capture keep the default (they lower onto the bare base-table name, so the
 * re-point is a no-op).
 */
function analyzeView(ctx: PlanningContext, view: MutableViewLike, correlationName?: string): ViewAnalysis {
	// Lens read-only gate: a logical table whose primary key is not reconstructible
	// at the lens boundary deploys read-only (the prover sets `LensSlot.readOnly`;
	// docs/lens.md § Coverage checklist). Reads still resolve through the registered
	// view; any mutation errors here with a precise diagnostic. The lookup only
	// matches a logical schema's lens slot — a plain view / MV (physical schema) has
	// none, so this never false-positives on ordinary view write-through.
	const lensSlot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	if (lensSlot?.readOnly) {
		raiseMutationDiagnostic({
			reason: 'lens-read-only',
			table: view.name,
			message: `cannot write through logical table '${view.schemaName}.${view.name}': its primary key is not reconstructible at the lens boundary, so it is read-only (deploy advisory lens.pk-not-reconstructible)`,
		});
	}

	if (view.selectAst.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `${view.noun ?? 'view'} '${view.name}' has a ${view.selectAst.type.toUpperCase()} body, which has no recoverable base operation`,
		});
	}
	const sel = view.selectAst;

	// Build the body plan and gate it (joins / aggregates / set-ops / recursive
	// CTEs / VALUES bodies are rejected here). A STORED body plans on its own
	// home-schema path, not the writing statement's — see `bodyPlanningContext`.
	const bodyCtx = bodyPlanningContext(ctx, view);
	const bodyPlan = buildSelectStmt(bodyCtx, sel);
	if (!isRelationalNode(bodyPlan)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `${view.noun ?? 'view'} '${view.name}' body did not produce a relation`,
		});
	}
	const classification = classifyViewBody(bodyPlan as RelationalPlanNode);
	if (classification.kind === 'rejected') {
		raiseMutationDiagnostic({
			reason: classification.reason,
			table: view.name,
			// Name the target by its kind (`view.noun`) so a body-shape reject on a
			// maintained table reads "materialized view 'm'", not the misleading
			// plain-view framing. A maintained table reaches this and the sibling
			// body-shape branches below — e.g. an aggregate-bodied MV here, or a
			// subquery-in-FROM MV at the single-base-source branch — so every
			// body-shape diagnostic in this function honours the noun.
			message: `cannot write through ${view.noun ?? 'view'} '${view.name}': ${classification.detail}`,
		});
	}
	const baseTable = classification.baseTable.tableSchema;

	// Single-level base-table source only: a body that sources another view/CTE
	// inlines to one table ref but its inner filters/projections live in the
	// plan, not in this view's selectAst — driving the rewrite from selectAst
	// would silently drop them. Reject (the inline-and-propagate generality is
	// a later phase).
	if (!sel.from || sel.from.length !== 1 || sel.from[0].type !== 'table') {
		raiseMutationDiagnostic({
			reason: 'nested-view',
			table: view.name,
			message: `cannot write through ${view.noun ?? 'view'} '${view.name}': only a single base-table source is supported in phase 1`,
		});
	}
	const fromTable = sel.from[0];
	// Resolve the body's source name on the BODY's own home path — the same path
	// `bodyPlanningContext` plans it under — not the writing statement's. A `temp`
	// view whose body names another `temp` view unqualified must be recognised as a
	// nested view and rejected cleanly, not mis-rewritten.
	const bodySource = ctx.schemaManager.findSchemaItem(
		fromTable.table.name,
		fromTable.table.schema,
		bodyCtx.schemaPath,
	);
	if (isViewSchema(bodySource)) {
		raiseMutationDiagnostic({
			reason: 'nested-view',
			table: view.name,
			message: `cannot write through ${view.noun ?? 'view'} '${view.name}': its body references another view; nested-view mutation is not yet supported`,
		});
	}
	// MV-over-MV (or a plain view over an MV): the body's single source is itself a
	// maintained table, whose contents are derived — user DML may not write it
	// directly. Write-through one level down (route to the inner MV's own
	// write-through + the maintenance cascade) is deferred; reject cleanly. The
	// source→backing maintenance cascade is unaffected — that is the read/maintain
	// direction; this guards only the MV-name *write* direction.
	// Checked both by name (on the body's home path, resolved above — the branch
	// above already threw for a view, so `bodySource` is a table or nothing) and
	// on the PLAN-resolved base table — the latter can reach a maintained table
	// one inlining level down that the name lookup misses.
	if (isMaintainedTable(bodySource) || isMaintainedTable(baseTable)) {
		raiseMutationDiagnostic({
			reason: 'nested-view',
			table: view.name,
			message: `cannot write through '${view.name}': its body reads a materialized view; `
				+ `write-through to a materialized-view-over-materialized-view is not yet supported — write the base source instead`,
		});
	}

	// LIMIT / OFFSET / DISTINCT are accepted by the plan-walk classifier as
	// pass-through operators (so it can still reach the base table), but the
	// predicate-conjoin rewrite cannot faithfully reproduce them: a row-count
	// window or duplicate-collapse is not capturable as a WHERE predicate, so a
	// mutation would affect base rows outside what the view exposes. Reject here
	// rather than silently widening the write. (Phase 2 substrate territory.)
	if (sel.limit || sel.offset) {
		raiseMutationDiagnostic({
			reason: 'unsupported-limit',
			table: view.name,
			message: `cannot write through ${view.noun ?? 'view'} '${view.name}': a LIMIT/OFFSET body is not decomposable in phase 1 (a mutation would escape the limited window)`,
		});
	}
	if (sel.distinct) {
		raiseMutationDiagnostic({
			reason: 'unsupported-distinct',
			table: view.name,
			message: `cannot write through ${view.noun ?? 'view'} '${view.name}': a DISTINCT body has no 1:1 base-row lineage and is not updateable in phase 1`,
		});
	}

	// Names that qualify the single base source inside the body — its alias (if
	// any) and the table name as written. References so qualified are normalized
	// to unqualified form when threaded into the rewritten single-source statement.
	const baseAliases = new Set<string>([fromTable.table.name.toLowerCase()]);
	if (fromTable.alias) baseAliases.add(fromTable.alias.toLowerCase());

	// Build the view-column lineage model from the projection list (shared with
	// the update-lineage analysis surface).
	const viewColumns = deriveViewColumns(sel, baseTable, view.columns);

	// Build the remap table: each view column → its base-term replacement
	// (computed expressions are normalized so any alias-qualified base column
	// resolves against the rewritten single-source statement).
	const lowerName = correlationName ?? baseTable.name;
	const columnMap = new Map<string, AST.Expression>();
	for (const vc of viewColumns) {
		columnMap.set(
			vc.name.toLowerCase(),
			vc.lineage.kind === 'base' ? columnExpr(vc.lineage.baseColumnName) : normalizeBaseRefs(vc.lineage.expr, baseAliases, lowerName),
		);
	}

	const filterConstants = extractFilterConstants(sel.where, baseTable);
	const filterPredicate = sel.where ? normalizeBaseRefs(sel.where, baseAliases, lowerName) : undefined;

	// Writable-base write sites (UPDATE SET + INSERT): read the threaded plan-node
	// `updateLineage` off the already-planned body and, per view column, capture
	// EVERY writable, non-null-extended base column (identity / passthrough /
	// inverse) with its optional backward `inverse` closure. This is the
	// single-source dual of what the multi-source spine consumes (whose
	// `OutColumn.writable` is likewise the inverse-agnostic `base`-not-null-extended
	// site). The identity-only AST readers (`deriveViewColumns` /
	// `classifyProjectionExpr` / `viewColumnsFromUpdateLineage`) are deliberately NOT
	// widened — their parity is pinned by `test/property.spec.ts` — so the richer
	// `base` chain is read separately here via the shared `resolveBaseSite`. The UPDATE
	// SET path routes any site (applying its `inverse` when present); INSERT
	// (`rewriteViewInsert`) admits only the inverse-absent subset (identity + passthrough,
	// stored verbatim). A passthrough (`collate` / no-op `cast`) or identity / rename
	// column carries no `inverse`; an `inverse` column carries its closure (UPDATE-only —
	// non-insertable); an `opaque` / null-extended column has no site, so a write to it
	// still raises `no-inverse` via `requireBaseColumn`.
	// `viewColumns[i]` ↔ `attrs[i]` holds because `deriveViewColumns` and the planned
	// projection expand `select *` identically (the parity `viewColumnsFromUpdateLineage`
	// relies on); a `*` column is pure identity, stored verbatim like any other.
	const relBody = bodyPlan as RelationalPlanNode;
	const attrs = relBody.getAttributes();
	const lineage = relBody.physical.updateLineage;
	const writableSites = new Map<string, WritableSite>();
	viewColumns.forEach((vc, i) => {
		const site = resolveBaseSite(lineage?.get(attrs[i]?.id));
		if (!site.writable || site.nullExtended) return;
		if (site.authored) {
			// An authored (`with inverse`) site — writable and insertable through its
			// put expressions. Single-source: every put target is a column of THE base
			// table (the lineage routed each through the sole TableReferenceNode), so
			// the table discriminator is dropped here.
			writableSites.set(vc.name.toLowerCase(), {
				kind: 'authored',
				puts: site.authored.puts.map(p => ({ baseColumn: p.baseColumn, expr: p.expr })),
				newRefIndex: site.authored.newRefIndex,
			});
			return;
		}
		if (site.baseColumn) {
			writableSites.set(vc.name.toLowerCase(), {
				kind: 'base',
				baseColumn: site.baseColumn,
				...(site.inverse ? { inverse: site.inverse } : {}),
				// No shipped invertibility profile produces a `domain` (`x ± k` is
				// unrestricted over integers), so this is always absent today. Threaded
				// for parity with multi-source (`multi-source.ts` decomposeUpdate), not
				// yet conjoined into the identifying predicate — the documented deferral.
				...(site.domain ? { domain: site.domain } : {}),
			});
		}
	});

	return { baseTable, viewColumns, filterPredicate, filterConstants, columnMap, writableSites };
}

/**
 * Build the eager **CTE self-read capture** for a CTE-name DML target whose user
 * clauses self-read the target name (docs/vu-operators.md § Common Table
 * Expressions — self-reference). The capture is the FULL body relation — every view
 * column, **unfiltered** (the self-read `from t` is the whole relation, exactly a
 * materialized CTE) — projected over the body planned under `ctx` (the **target-
 * excluded** body context, so the body's own `from base` reaches the REAL base table,
 * the load-bearing shadow case). It rides {@link import('../nodes/view-mutation-node.js').ViewMutationNode}'s
 * `identityCapture`, which the emitter materializes ONCE before any base op runs — so
 * the lowered base op's `from t` reads the pre-mutation snapshot, Halloween-safe by
 * construction.
 *
 * Mirrors `set-op.ts`'s `buildSetOpCapture`, minus the user-WHERE filter (the whole
 * relation, not just the affected rows — a self-read names the entire CTE). Returns a
 * {@link MultiSourceKeyCapture} so the readers reuse `makeMultiSourceKeyRef` /
 * `withCteCapture` and the existing `identityCapture` side-input substrate verbatim.
 *
 * Deliberately plans the body a SECOND time (alongside `analyzeView`'s own body plan,
 * threaded through `rewriteViewUpdate`/`Delete`): a localization tradeoff the ticket
 * accepts — the body is a cheap single-source projection-and-filter, and the capture's
 * projection over a freshly-planned root keeps the descriptor self-contained.
 */
export function buildCteSelfCapture(ctx: PlanningContext, view: MutableViewLike): MultiSourceKeyCapture {
	// Gate + derive the view-column model (names honour a `t(a,b)` rename via
	// `deriveViewColumns`; an unsupported body shape rejects here just as the lowering's
	// own `analyzeView` would).
	const analysis = analyzeView(ctx, view);
	const sel = view.selectAst as AST.SelectStmt; // analyzeView already proved a SELECT body
	// Matches `analyzeView`'s own body context exactly (for a CTE target — always ephemeral
	// here — that is `ctx` verbatim, so the caller's path is preserved).
	const bodyPlan = buildSelectStmt(bodyPlanningContext(ctx, view), sel) as RelationalPlanNode;
	const attrs = bodyPlan.getAttributes();

	// One capture column per view column, positionally aligned to the body plan's
	// attributes (the `viewColumns[i] ↔ attrs[i]` parity `analyzeView` relies on). The
	// renamed name is the capture column name, so a self-read `from t` exposes the
	// renamed columns; the type/id come from the planned attribute.
	const projections: Projection[] = analysis.viewColumns.map((vc, i) => {
		const attr = attrs[i];
		const node = new ColumnReferenceNode(ctx.scope, { type: 'column', name: vc.name }, attr.type, attr.id, i);
		return { node, alias: vc.name };
	});
	// preserveInputColumns=false → the materialized rows are exactly the view columns.
	const source = new ProjectNode(ctx.scope, bodyPlan, projections, undefined, undefined, false);
	const keyColumns = analysis.viewColumns.map((vc, i) => ({ name: vc.name, type: attrs[i].type }));
	return { source, descriptor: {}, keyColumns };
}

/** Extract `baseColumn = literal` bindings from the view's selection predicate. */
function extractFilterConstants(where: AST.Expression | undefined, baseTable: TableSchema): FilterConstant[] {
	const out: FilterConstant[] = [];
	if (!where) return out;
	for (const conj of flattenAnd(where)) {
		if (conj.type !== 'binary' || conj.operator !== '=') continue;
		const colSide = conj.left.type === 'column' ? conj.left : conj.right.type === 'column' ? conj.right : undefined;
		const litSide = conj.left.type === 'literal' ? conj.left : conj.right.type === 'literal' ? conj.right : undefined;
		if (!colSide || !litSide) continue;
		const baseCol = baseTable.columns.find(c => c.name.toLowerCase() === colSide.name.toLowerCase());
		if (!baseCol) continue;
		const value = litSide.value instanceof Promise ? undefined : litSide.value;
		out.push({ baseColumnName: baseCol.name, valueExpr: litSide, value });
	}
	return out;
}

function findViewColumn(analysis: ViewAnalysis, name: string, view: MutableViewLike): ViewColumn {
	const vc = analysis.viewColumns.find(c => c.name.toLowerCase() === name.toLowerCase());
	if (!vc) {
		// A `set` target / `insert` target column that is not a view column at all —
		// the same encapsulation-leak guard the top-level `where` / `returning` scan
		// applies (a base-only column must not be writable through the view). Computed
		// view columns ARE found here and surface the `no-inverse` diagnostic instead.
		raiseUnknownViewColumn(name, view, analysis.viewColumns.map(c => c.name));
	}
	return vc;
}

/**
 * Visit every column reference at the TOP LEVEL of a scalar expression — i.e. NOT
 * descending into a `subquery` / `exists` / `in`-subquery operand (those nested
 * references resolve in the lowered base scope and are handled scope-aware by
 * {@link makeViewColumnDescend}; the nested-rebind correctness ticket
 * `view-mutation-single-source-subquery-base-term-local-rebind` owns them). The
 * structure mirrors {@link transformExpr} exactly, minus the subquery descent.
 */
function forEachTopLevelColumn(expr: AST.Expression, visit: (col: AST.ColumnExpr) => void): void {
	switch (expr.type) {
		case 'column':
			visit(expr);
			return;
		case 'binary':
			forEachTopLevelColumn(expr.left, visit);
			forEachTopLevelColumn(expr.right, visit);
			return;
		case 'unary':
		case 'cast':
		case 'collate':
			forEachTopLevelColumn(expr.expr, visit);
			return;
		case 'function':
			expr.args.forEach(a => forEachTopLevelColumn(a, visit));
			return;
		case 'between':
			forEachTopLevelColumn(expr.expr, visit);
			forEachTopLevelColumn(expr.lower, visit);
			forEachTopLevelColumn(expr.upper, visit);
			return;
		case 'case':
			if (expr.baseExpr) forEachTopLevelColumn(expr.baseExpr, visit);
			expr.whenThenClauses.forEach(w => { forEachTopLevelColumn(w.when, visit); forEachTopLevelColumn(w.then, visit); });
			if (expr.elseExpr) forEachTopLevelColumn(expr.elseExpr, visit);
			return;
		case 'in':
			forEachTopLevelColumn(expr.expr, visit);
			if (expr.values) expr.values.forEach(v => forEachTopLevelColumn(v, visit));
			// expr.subquery is a nested scope — intentionally not descended.
			return;
		default:
			// subquery / exists — nested scope, not validated here.
			// literal / identifier / parameter / windowFunction / functionSource —
			// no top-level column reference to validate.
			return;
	}
}

/**
 * Raise the structured `unknown-view-column` diagnostic for a reference that names
 * something the view does not expose. `displayColumns` is the view's exposed column
 * list (in display spelling) for the suggestion.
 */
export function raiseUnknownViewColumn(spelling: string, view: MutableViewLike, displayColumns: readonly string[]): never {
	raiseMutationDiagnostic({
		reason: 'unknown-view-column',
		column: spelling,
		table: view.name,
		message: `cannot write through view '${view.name}': '${spelling}' is not a column of the view`,
		suggestion: `view '${view.name}' exposes: ${displayColumns.join(', ')}.`,
	});
}

/**
 * Enforce **view-column scope** on the TOP-LEVEL references of a user `where` /
 * `returning` clause (the `set` targets are guarded separately at their resolution
 * point). Without this, a name that is not a view column passes through the
 * view→base remap unmapped and silently re-binds against the underlying base
 * table(s) — an encapsulation leak letting a column the view projects away be
 * filtered / returned. A reference must name a column the view exposes, optionally
 * qualified by the view's own name; a bare base-column name (`secret`), a renamed
 * column's base spelling (`label` for a `… as note` projection), or a view-qualified
 * unknown (`sv.secret`) are all rejected. A computed view column passes here (it IS
 * a view column) so a write to it still surfaces the existing `no-inverse`
 * diagnostic. Shared by the single-source spine and the multi-source join path so
 * the two read consistently.
 */
/** Single-source convenience: build the scope sets from a {@link ViewAnalysis}. */
function guardTopLevelScope(expr: AST.Expression, analysis: ViewAnalysis, view: MutableViewLike): void {
	assertTopLevelViewColumns(
		expr,
		new Set(analysis.viewColumns.map(c => c.name.toLowerCase())),
		analysis.viewColumns.map(c => c.name),
		view,
	);
}

export function assertTopLevelViewColumns(
	expr: AST.Expression,
	viewColumnNames: ReadonlySet<string>,
	displayColumns: readonly string[],
	view: MutableViewLike,
): void {
	const lcView = view.name.toLowerCase();
	forEachTopLevelColumn(expr, (col) => {
		const qualifier = col.table?.toLowerCase();
		const known = viewColumnNames.has(col.name.toLowerCase());
		if ((qualifier !== undefined && qualifier !== lcView) || !known) {
			raiseUnknownViewColumn(col.table ? `${col.table}.${col.name}` : col.name, view, displayColumns);
		}
	});
}

/** Resolve a view column to a writable base column, rejecting computed columns. */
function requireBaseColumn(vc: ViewColumn): string {
	if (vc.lineage.kind === 'computed') {
		raiseMutationDiagnostic({
			reason: 'no-inverse',
			column: vc.name,
			message: `cannot write through view: column '${vc.name}' is a computed (non-invertible) expression and is read-only`,
		});
	}
	return vc.lineage.baseColumnName;
}

/**
 * Resolve an insert-default column name (from the body's `with defaults (col = expr, …)`
 * clause) to its base column. The name may be a base column (the documented
 * projected-away case) or a view column with `base` lineage. An unknown name is
 * a structured `default-target-not-found` — a typo must fail loudly, not silently
 * no-op. `spelling` names the offending clause entry in the diagnostic.
 */
function resolveDefaultForColumn(analysis: ViewAnalysis, colName: string, view: MutableViewLike, spelling: string): string {
	const baseCol = analysis.baseTable.columns.find(c => c.name.toLowerCase() === colName);
	if (baseCol) return baseCol.name;
	const vc = analysis.viewColumns.find(c => c.name.toLowerCase() === colName);
	if (vc && vc.lineage.kind === 'base') return vc.lineage.baseColumnName;
	raiseMutationDiagnostic({
		reason: 'default-target-not-found',
		column: colName,
		table: view.name,
		message: `cannot write through view '${view.name}': ${spelling} names column '${colName}', which is not a column of the view or its base table '${analysis.baseTable.name}'`,
	});
}

/** Build a substitution fn that remaps view column references to base terms. */
function remapper(analysis: ViewAnalysis): (col: AST.ColumnExpr) => AST.Expression | undefined {
	return (col) => analysis.columnMap.get(col.name.toLowerCase());
}

// --- INSERT ---------------------------------------------------------------

export function rewriteViewInsert(ctx: PlanningContext, stmt: AST.InsertStmt, view: MutableViewLike): AST.InsertStmt {
	const analysis = analyzeView(ctx, view);

	// A view column is INSERTABLE iff it has a writable base site with NO inverse:
	// `identity` / rename and `passthrough` (`b collate nocase`, no-op `cast`), whose
	// inserted value is stored verbatim. An `inverse` column (a site WITH an inverse) and
	// an `opaque` computed column (no site) are NOT insertable — the lowering writes the
	// value raw, with no hook to apply an inverse. This is exactly the multi-source
	// contract (`outColumns.filter(c => c.writable && !c.inverse)`), so the single- and
	// multi-source INSERT spines now admit the identical set. (A bare "has a site" gate
	// would wrongly admit an inverse column; the `inverse === undefined` check is load-bearing.)
	// An AUTHORED (`with inverse`) column is the exception that supplies exactly that
	// hook: it IS insertable — its puts are evaluated per VALUES row below — so the
	// insertability gate is lifted for authored sites only (registry-`inverse` columns
	// stay non-insertable; docs/vu-inverses.md § Authored inverses).
	const insertableBaseColumn = (name: string): string | undefined => {
		const site = analysis.writableSites.get(name.toLowerCase());
		return site?.kind === 'base' && site.inverse === undefined ? site.baseColumn : undefined;
	};
	const authoredSiteOf = (name: string): AuthoredWritableSite | undefined => {
		const site = analysis.writableSites.get(name.toLowerCase());
		return site?.kind === 'authored' ? site : undefined;
	};

	// Target view columns: the explicit list, or every non-generated INSERTABLE view
	// column (display order preserved) — verbatim-insertable or authored. An exposed
	// `inverse` / `opaque` computed column is omitted from the implicit set so it falls
	// to its base default / NOT NULL check (matching multi-source) rather than erroring.
	const targetNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: analysis.viewColumns
			.filter(vc => !vc.generated && (insertableBaseColumn(vc.name) !== undefined || authoredSiteOf(vc.name) !== undefined))
			.map(vc => vc.name);

	if (targetNames.some(name => authoredSiteOf(name) !== undefined)) {
		return rewriteAuthoredViewInsert(ctx, stmt, view, analysis, targetNames, insertableBaseColumn, authoredSiteOf);
	}

	// Resolve each target to its writable base column: an insertable writable site
	// (identity + passthrough) routes to its base column; otherwise fall back to
	// `requireBaseColumn` (the identity base column, or `no-inverse` for an inverse /
	// opaque column). `findViewColumn` stays the unknown-view-column guard on the fallback.
	const baseColumns = targetNames.map(name =>
		insertableBaseColumn(name) ?? requireBaseColumn(findViewColumn(analysis, name, view)));

	// Merge the view's constant-FD defaults: a base column pinned by the
	// selection predicate is supplied automatically when omitted, and a
	// user-supplied literal that contradicts the pin is rejected at plan time.
	const { appendColumns, appendExprs } = collectAppendedDefaults(
		analysis, view, baseColumns,
		(fc, idx) => checkContradiction(stmt.source, idx, fc, view),
	);

	const finalColumns = [...baseColumns, ...appendColumns];

	let source: AST.QueryExpr = stmt.source;
	if (appendExprs.length > 0) {
		if (stmt.source.type !== 'values') {
			raiseMutationDiagnostic({
				reason: 'unsupported-source',
				table: view.name,
				message: `cannot write through view '${view.name}': supplying selection-predicate defaults requires a VALUES source in phase 1`,
			});
		}
		source = {
			type: 'values',
			values: stmt.source.values.map(row => [...row, ...appendExprs.map(cloneExpr)]),
		};
	}

	return {
		type: 'insert',
		table: tableIdentifier(analysis.baseTable),
		columns: finalColumns,
		source,
		onConflict: stmt.onConflict,
		upsertClauses: stmt.upsertClauses,
		contextValues: stmt.contextValues,
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view),
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

/**
 * Collect the appended omitted-insert defaults shared by both INSERT lowerings:
 * constant-FD selection pins first, then the body's `with defaults (…)` clause
 * entries — each only for a base column the insert left unsupplied
 * (docs/vu-operators.md § Projection step 5, docs/vu-inverses.md § View defaults).
 * `suppliedBaseColumns` are the base columns the insert targets directly
 * (verbatim targets AND authored put targets — an authored target takes the
 * inverse-computed value ahead of any default for that column: it is a supplied
 * value, not an omission). `onPinnedSupplied` fires for a constant-FD pin whose
 * base column IS supplied, with the index into `suppliedBaseColumns` (the plain
 * path uses it for the literal-contradiction check; the authored path checks
 * only its verbatim subset).
 */
function collectAppendedDefaults(
	analysis: ViewAnalysis,
	view: MutableViewLike,
	suppliedBaseColumns: readonly string[],
	onPinnedSupplied: (fc: FilterConstant, suppliedIndex: number) => void,
): { appendColumns: string[]; appendExprs: AST.Expression[] } {
	const appendColumns: string[] = [];
	const appendExprs: AST.Expression[] = [];
	const isSupplied = (baseCol: string): boolean =>
		suppliedBaseColumns.some(b => b.toLowerCase() === baseCol.toLowerCase())
		|| appendColumns.some(b => b.toLowerCase() === baseCol.toLowerCase());
	for (const fc of analysis.filterConstants) {
		const idx = suppliedBaseColumns.findIndex(b => b.toLowerCase() === fc.baseColumnName.toLowerCase());
		if (idx >= 0) {
			onPinnedSupplied(fc, idx);
		} else {
			appendColumns.push(fc.baseColumnName);
			appendExprs.push(fc.valueExpr);
		}
	}

	// Omitted-insert defaults (the body's trailing `with defaults (…)` clause),
	// applied ahead of the base column's declared default: the clause fills only a
	// column the insert and the constant-FD chain left omitted — an explicit user
	// value or a stronger predicate pin always wins. The clause value is already an
	// AST expression — no text re-lowering. Pushing the schema-held node is safe:
	// the VALUES rewrite clones per row.
	for (const d of bodyDefaults(view.selectAst) ?? []) {
		const baseCol = resolveDefaultForColumn(analysis, d.column.toLowerCase(), view, `'with defaults (${d.column} = …)'`);
		if (isSupplied(baseCol)) continue;
		appendColumns.push(baseCol);
		appendExprs.push(d.expr);
	}
	return { appendColumns, appendExprs };
}

/**
 * The INSERT lowering when ≥1 target view column carries an authored inverse
 * (docs/vu-inverses.md § Authored inverses). Per VALUES row, each authored
 * column contributes one cell per put: the authored expression with `new.<x>`
 * bound to the supplied (post-view-defaulting) row values — the row's cell when
 * `x` is a target column, the appended default expression when `x`'s base column
 * is default-filled, NULL otherwise. Verbatim targets keep their cells; the
 * appended defaults ride last, exactly as on the plain path. A SELECT source is
 * rejected (the per-row cell substitution needs VALUES — same v1 boundary as the
 * appended-defaults rewrite).
 */
function rewriteAuthoredViewInsert(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
	view: MutableViewLike,
	analysis: ViewAnalysis,
	targetNames: readonly string[],
	insertableBaseColumn: (name: string) => string | undefined,
	authoredSiteOf: (name: string) => AuthoredWritableSite | undefined,
): AST.InsertStmt {
	if (stmt.source.type !== 'values') {
		raiseMutationDiagnostic({
			reason: 'unsupported-source',
			table: view.name,
			message: `cannot insert through view '${view.name}': a column with an authored inverse (WITH INVERSE) requires a VALUES source in phase 1 (each put expression is evaluated per supplied row)`,
		});
	}
	const values = stmt.source.values;

	// Classify each target, preserving its source-cell index. The unknown-column /
	// no-inverse guards mirror the plain path (`findViewColumn` + `requireBaseColumn`).
	interface VerbatimTarget { readonly baseColumn: string; readonly srcIndex: number }
	interface AuthoredTarget { readonly viewColumn: string; readonly site: AuthoredWritableSite }
	const verbatim: VerbatimTarget[] = [];
	const authored: AuthoredTarget[] = [];
	// Base column (lowercased) → the view column that supplies it — two supplied view
	// columns landing on one base column (an authored put colliding with a verbatim
	// target or another put) is ill-defined, mirroring the UPDATE collision guard.
	const baseOwner = new Map<string, string>();
	const claimBase = (baseColumn: string, viewColumn: string): void => {
		const key = baseColumn.toLowerCase();
		const prior = baseOwner.get(key);
		if (prior !== undefined) {
			raiseMutationDiagnostic({
				reason: 'conflicting-assignment',
				column: baseColumn,
				table: view.name,
				message: `cannot insert through view '${view.name}': columns '${prior}' and '${viewColumn}' both supply base column '${baseColumn}'`,
			});
		}
		baseOwner.set(key, viewColumn);
	};
	targetNames.forEach((name, srcIndex) => {
		const site = authoredSiteOf(name);
		if (site) {
			for (const put of site.puts) claimBase(put.baseColumn, name);
			authored.push({ viewColumn: name, site });
			return;
		}
		const baseColumn = insertableBaseColumn(name) ?? requireBaseColumn(findViewColumn(analysis, name, view));
		claimBase(baseColumn, name);
		verbatim.push({ baseColumn, srcIndex });
	});

	// Appended defaults over the FULL supplied base set (verbatim + authored puts):
	// an authored put target is a supplied value, so it shadows any `with defaults`
	// entry / constant-FD pin for that base column. The literal-contradiction check
	// applies only to verbatim targets (an authored cell is computed, not a literal).
	const suppliedBase = [...verbatim.map(v => v.baseColumn), ...authored.flatMap(a => a.site.puts.map(p => p.baseColumn))];
	const { appendColumns, appendExprs } = collectAppendedDefaults(analysis, view, suppliedBase, (fc, suppliedIndex) => {
		const v = verbatim.find(t => t.baseColumn.toLowerCase() === suppliedBase[suppliedIndex].toLowerCase());
		if (v) checkContradiction(stmt.source, v.srcIndex, fc, view);
	});

	// `new.<x>` binding for one row: the supplied cell when `x` is a target view
	// column; the appended default expression when `x` resolves to a default-filled
	// base column (the post-view-defaulting row image); NULL otherwise. `x` is a
	// SELECT-output name, so it bridges POSITIONALLY through the site's validated
	// `newRefIndex` to the view column (an explicit `create view v(a, b)` column
	// list renames outputs — a name lookup against `targetNames` would mis-bind).
	const targetIndexByName = new Map<string, number>();
	targetNames.forEach((n, i) => {
		if (!targetIndexByName.has(n.toLowerCase())) targetIndexByName.set(n.toLowerCase(), i);
	});
	const appendExprFor = (name: string): AST.Expression | undefined => {
		const baseCol = insertableBaseColumn(name);
		if (baseCol === undefined) return undefined;
		const ai = appendColumns.findIndex(b => b.toLowerCase() === baseCol.toLowerCase());
		return ai >= 0 ? appendExprs[ai] : undefined;
	};

	const finalColumns = [
		...verbatim.map(v => v.baseColumn),
		...authored.flatMap(a => a.site.puts.map(p => p.baseColumn)),
		...appendColumns,
	];
	const newValues = values.map(row => {
		if (row.length !== targetNames.length) {
			raiseMutationDiagnostic({
				reason: 'unsupported-source',
				table: view.name,
				message: `cannot insert through view '${view.name}': a VALUES row supplies ${row.length} value(s) but ${targetNames.length} view column(s) are targeted`,
			});
		}
		const resolveNewFor = (a: AuthoredTarget) => (name: string): AST.Expression => {
			const idx = requireValidatedNewRefIndex(a.site.newRefIndex, name, a.viewColumn);
			const viewName = analysis.viewColumns[idx]?.name;
			const ti = viewName !== undefined ? targetIndexByName.get(viewName.toLowerCase()) : undefined;
			if (ti !== undefined) return row[ti];
			return (viewName !== undefined ? appendExprFor(viewName) : undefined) ?? { type: 'literal', value: null };
		};
		return [
			...verbatim.map(v => row[v.srcIndex]),
			...authored.flatMap(a => a.site.puts.map(p => substituteNewRefs(p.expr, resolveNewFor(a)))),
			...appendExprs.map(cloneExpr),
		];
	});

	return {
		type: 'insert',
		table: tableIdentifier(analysis.baseTable),
		columns: finalColumns,
		source: { type: 'values', values: newValues },
		onConflict: stmt.onConflict,
		upsertClauses: stmt.upsertClauses,
		contextValues: stmt.contextValues,
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view),
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

/** Reject an insert literal that contradicts a selection-predicate constant. */
function checkContradiction(source: AST.QueryExpr, columnIndex: number, fc: FilterConstant, view: MutableViewLike): void {
	if (source.type !== 'values' || fc.value === undefined) return;
	for (const row of source.values) {
		const cell = row[columnIndex];
		if (!cell || cell.type !== 'literal' || cell.value instanceof Promise) continue;
		if (!sqlValueIdentical(cell.value, fc.value)) {
			raiseMutationDiagnostic({
				reason: 'predicate-contradiction',
				column: fc.baseColumnName,
				table: view.name,
				message: `insert into view '${view.name}' contradicts its selection predicate on column '${fc.baseColumnName}'`,
			});
		}
	}
}

// --- UPDATE ---------------------------------------------------------------

export function rewriteViewUpdate(ctx: PlanningContext, stmt: AST.UpdateStmt, view: MutableViewLike, descendCtx?: PlanningContext): AST.UpdateStmt {
	// SELF_ALIAS is the lowered target's correlation name, so a base-source qualifier
	// inside a copied definition fragment's own subquery (`… where gl.id = gt.id`) is
	// re-pointed to it and still correlates to the row being updated.
	const analysis = analyzeView(ctx, view, SELF_ALIAS);
	const substitute = remapper(analysis);
	// Qualify substituted subquery-descent base terms with the lowered target's
	// synthesised alias (SELF_ALIAS) so they correlate to the outer target row even
	// when the user subquery FROM names the view's own base table (the same-base-table
	// self-reference corner). The lowered statement carries `alias: SELF_ALIAS` below.
	//
	// `descendCtx` (a CTE-name DML target's `ctxSelfRead` — the body context with the
	// target name re-added to `cteNodes`, resolving to the eager capture) drives ONLY
	// the user-clause subquery descent, so a self-read `from t` resolves `t`'s columns
	// against the capture (a clean shadowing local source). `analyzeView` keeps planning
	// the BODY under the target-EXCLUDED `ctx` (so the body's own `from base` reaches the
	// real table — the load-bearing shadow case). Absent it, `descendCtx ?? ctx` is the
	// byte-identical no-self-read path.
	const descend = makeViewColumnDescend(descendCtx ?? ctx, analysis.columnMap, view.name, view, makeBaseQualifier(ctx, analysis.baseTable, SELF_ALIAS));

	// Scope guard: `set` targets, assigned values, and the top-level `where`
	// references must name view columns (a base-only name must not leak through to
	// the underlying table).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);
	// View-aware collision guard: two distinct view columns may lower to one base
	// column (e.g. `select id, b, b+1 as bp` → `set b=5, bp=100`, or a duplicate
	// rename `b, b as b2` → `set b=1, b2=2`). The base backstop in building/update.ts
	// would reject these but report the base column twice; detect it here so the
	// message names both view columns the user actually wrote. Rejected
	// unconditionally — value-agreement (`set b=5, b2=5`) is not softened.
	const seenBaseColumns = new Map<string, string>(); // base column (lower) → first view-column spelling
	const recordBaseColumn = (baseColumn: string, viewColumn: string): void => {
		const key = baseColumn.toLowerCase();
		const prior = seenBaseColumns.get(key);
		if (prior !== undefined) {
			raiseMutationDiagnostic({
				reason: 'conflicting-assignment',
				column: baseColumn,
				table: view.name,
				message: `cannot write through view '${view.name}': columns '${prior}' and '${viewColumn}' both target base column '${baseColumn}'; an UPDATE cannot assign one column twice`,
			});
		}
		seenBaseColumns.set(key, viewColumn);
	};
	// `new.<x>` binds the WRITTEN view row: when `x` is also assigned in this
	// statement, that assignment's value (every embedded RHS reads the pre-update
	// row, exactly like the sibling assignment's own lowering — so cross-references
	// are order-independent); otherwise the column's forward read image. First
	// occurrence wins on a duplicate target — the collision guard below rejects the
	// statement anyway. Keyed by view-column index (the `newRefIndex` domain).
	const assignedValueByIdx = new Map<number, AST.Expression>();
	stmt.assignments.forEach(a => {
		const i = analysis.viewColumns.findIndex(c => c.name.toLowerCase() === a.column.toLowerCase());
		if (i >= 0 && !assignedValueByIdx.has(i)) assignedValueByIdx.set(i, a.value);
	});
	const assignments = stmt.assignments.flatMap(asg => {
		// Enforce view-column scope on the SET target (an unknown / base-only name is
		// rejected here; a computed view column is found and surfaces `no-inverse` below).
		const vc = findViewColumn(analysis, asg.column, view);
		// The assigned VALUE's top-level references must also name view columns — a
		// base-only name on the RHS would otherwise read a column the view projects
		// away (the same encapsulation leak as the `where` / `set`-target guard).
		guardTopLevelScope(asg.value, analysis, view);
		const site = analysis.writableSites.get(asg.column.toLowerCase());
		// An authored (`with inverse`) column lowers to ONE base assignment per put:
		// inside each authored expression, `new.<x>` becomes the assigned value when
		// `x` is assigned in this statement (including `x` = this column) and that
		// view column's name otherwise — still in VIEW terms — then the standard
		// view→base lowering maps everything to base terms (the forward read image
		// for the non-assigned columns). The result is a plain base-table `set` per
		// target riding the existing spine (docs/vu-inverses.md § Authored
		// inverses).
		if (site?.kind === 'authored') {
			return site.puts.map(put => {
				const viewTermExpr = substituteNewRefs(put.expr, name => {
					const idx = requireValidatedNewRefIndex(site.newRefIndex, name, asg.column);
					return assignedValueByIdx.get(idx) ?? columnExpr(analysis.viewColumns[idx].name);
				});
				const lowered = transformExpr(viewTermExpr, substitute, descend);
				recordBaseColumn(put.baseColumn, asg.column);
				return { column: put.baseColumn, value: lowered };
			});
		}
		const loweredValue = transformExpr(asg.value, substitute, descend);
		// Route the SET target through the full writable-base set (identity / passthrough
		// / inverse), mirroring the multi-source spine. An `inverse`-profile column (e.g.
		// `b + 1 as bp`) runs the lowered value through the site's `inverse` (`set bp = 9`
		// ⇒ `set b = 9 - 1`); an identity / passthrough column (`b collate nocase as bc`,
		// no-op `cast`) has no inverse and stores the value verbatim. The inverse expects
		// a value already in base terms, so it wraps the lowered value LAST (after
		// base-term substitution). `findViewColumn` above stays the unknown-column guard;
		// only an opaque `computed` column reaches `requireBaseColumn` (→ `no-inverse`).
		if (site) {
			recordBaseColumn(site.baseColumn, asg.column);
			return [{ column: site.baseColumn, value: site.inverse ? site.inverse(loweredValue) : loweredValue }];
		}
		const baseColumn = requireBaseColumn(vc);
		recordBaseColumn(baseColumn, asg.column);
		return [{ column: baseColumn, value: loweredValue }];
	});

	const userWhere = stmt.where ? transformExpr(stmt.where, substitute, descend) : undefined;
	const where = combineAnd(userWhere, analysis.filterPredicate ? cloneExpr(analysis.filterPredicate) : undefined);

	return {
		type: 'update',
		table: tableIdentifier(analysis.baseTable),
		// Synthesised collision-proof correlation name on the lowered target; the base
		// builder registers it as the target's AliasedScope alias so an `__vm_self.col`
		// term (emitted by the SELF_ALIAS qualifier above, incl. in RETURNING subqueries)
		// binds the outer target row regardless of the user subquery FROM.
		alias: SELF_ALIAS,
		assignments,
		where,
		contextValues: stmt.contextValues,
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view, SELF_ALIAS, descendCtx),
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

// --- DELETE ---------------------------------------------------------------

export function rewriteViewDelete(ctx: PlanningContext, stmt: AST.DeleteStmt, view: MutableViewLike, descendCtx?: PlanningContext): AST.DeleteStmt {
	// SELF_ALIAS is the lowered target's correlation name — see {@link rewriteViewUpdate}.
	const analysis = analyzeView(ctx, view, SELF_ALIAS);
	const substitute = remapper(analysis);
	// Qualify substituted subquery-descent base terms with the lowered target's
	// synthesised alias (SELF_ALIAS) so they correlate to the outer target row even
	// when the user subquery FROM names the view's own base table (the same-base-table
	// self-reference corner). The lowered statement carries `alias: SELF_ALIAS` below.
	// `descendCtx` (a CTE self-read `ctxSelfRead`) drives the user-WHERE subquery descent
	// so a self-read `from t` resolves to the eager capture; see {@link rewriteViewUpdate}.
	const descend = makeViewColumnDescend(descendCtx ?? ctx, analysis.columnMap, view.name, view, makeBaseQualifier(ctx, analysis.baseTable, SELF_ALIAS));

	// Scope guard: top-level `where` references must name view columns.
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);
	const userWhere = stmt.where ? transformExpr(stmt.where, substitute, descend) : undefined;
	const where = combineAnd(userWhere, analysis.filterPredicate ? cloneExpr(analysis.filterPredicate) : undefined);

	return {
		type: 'delete',
		table: tableIdentifier(analysis.baseTable),
		// Synthesised collision-proof correlation name on the lowered target; see
		// rewriteViewUpdate for the rationale (binds `__vm_self.col` to the outer row).
		alias: SELF_ALIAS,
		where,
		contextValues: stmt.contextValues,
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view, SELF_ALIAS, descendCtx),
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

/**
 * Rewrite a view-mediated RETURNING clause into base terms so it rides the base
 * op's own RETURNING machinery. The returned rows are projected through the
 * **view's** column list (not the base table's): each view-column reference is
 * substituted to its base-term lineage and the user's view-term output name is
 * preserved as the result-column alias. The base builder then evaluates the
 * clause against NEW (insert/update) or OLD (delete), i.e. the post-mutation
 * (or, for delete, the deleted) base row — so computed view columns re-evaluate
 * against the post-mutation base values. `returning *` expands to every view
 * column. Returns `undefined` for an absent/empty clause.
 *
 * OLD/NEW qualifiers on a view-column reference are not honored through a view
 * (the qualifier is dropped, so the base op's default NEW/OLD binding applies);
 * the documented surface is unqualified / view-qualified view columns.
 *
 * `correlationName` is the lowered target's correlation name used to qualify
 * substituted base terms emitted inside a RETURNING subquery (a RETURNING subquery can
 * correlate to the target row the same way a WHERE subquery can). UPDATE/DELETE pass
 * the synthesised {@link SELF_ALIAS}; INSERT leaves it at the base table name (default).
 */

/** Shared guard for `RETURNING <q>.*` through a view — validates the qualifier against the view name. */
export function assertReturningStarQualifier(rcTable: string | undefined, viewName: string): void {
	if (rcTable && rcTable.toLowerCase() !== viewName.toLowerCase()) {
		throw new QuereusError(
			`Table '${rcTable}' not found in FROM clause for qualified RETURNING *`,
			StatusCode.ERROR,
		);
	}
}

export function rewriteViewReturning(
	ctx: PlanningContext,
	returning: AST.ResultColumn[] | undefined,
	analysis: ViewAnalysis,
	view: MutableViewLike,
	correlationName: string = analysis.baseTable.name,
	/** A CTE self-read `ctxSelfRead` driving the RETURNING-subquery descent so a
	 *  self-read `from t` resolves to the eager capture (the capture is materialized
	 *  before the base op, so the RETURNING re-projection reads the frozen snapshot).
	 *  Absent it, `descendCtx ?? ctx` is the byte-identical no-self-read path. */
	descendCtx?: PlanningContext,
): AST.ResultColumn[] | undefined {
	if (!returning || returning.length === 0) return undefined;
	const substitute = remapper(analysis);
	const descend = makeViewColumnDescend(descendCtx ?? ctx, analysis.columnMap, view.name, view, makeBaseQualifier(ctx, analysis.baseTable, correlationName));
	const out: AST.ResultColumn[] = [];
	for (const rc of returning) {
		if (rc.type === 'all') {
			// RETURNING * (or `view.*`) → every view column, projected through its
			// base-term lineage and named by the view column.
			assertReturningStarQualifier(rc.table, view.name);
			for (const vc of analysis.viewColumns) {
				const baseExpr = analysis.columnMap.get(vc.name.toLowerCase());
				if (baseExpr) out.push({ type: 'column', expr: cloneExpr(baseExpr), alias: vc.name });
			}
			continue;
		}
		// Scope guard: a top-level `returning` reference must name a view column —
		// the same encapsulation guard as `where` / `set` (a base-only column the
		// view projects away must not leak through RETURNING).
		guardTopLevelScope(rc.expr, analysis, view);
		// Preserve the user's view-term output name BEFORE rewriting to base terms,
		// so the result column is named as written (the view column / its alias),
		// not the underlying base column.
		const alias = rc.alias ?? deriveReturningName(rc.expr);
		out.push({ type: 'column', expr: transformExpr(rc.expr, substitute, descend), alias });
	}
	return out;
}

/** The output name for an unaliased RETURNING expression (view-term spelling). */
function deriveReturningName(expr: AST.Expression): string {
	if (expr.type === 'column') return expr.table ? `${expr.table}.${expr.name}` : expr.name;
	return expressionToString(expr);
}
