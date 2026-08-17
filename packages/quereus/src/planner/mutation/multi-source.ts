import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { resolveReferencedColumns } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type TableDescriptor, type RelationalComponentRef } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import type { SqlValue } from '../../common/types.js';
import { sqlValueIdentical } from '../../util/comparison.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import { analyzeBodyLineage } from './backward-body.js';
import { buildExpression } from '../building/expression.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { JoinNode, type ExistenceColumnSpec } from '../nodes/join-node.js';
import { EXISTENCE_FLAG_TYPE } from '../nodes/join-utils.js';
import { captureKeyEquality, type KeyColumnInfo } from './capture-correlation.js';
import { FilterNode } from '../nodes/filter.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { combineAnd, flattenAnd, makeViewColumnDescend, assertTopLevelViewColumns, raiseUnknownViewColumn, SELF_ALIAS, assertReturningStarQualifier } from './single-source.js';
import { transformExpr, cloneExpr, mapQueryExprUniform, substituteNewRefs, transformScopedExpr, transformAliasScopedExpr, type ScopeContext } from './scope-transform.js';
import { requireValidatedNewRefIndex } from '../analysis/authored-inverse.js';

/**
 * Multi-source view-mediated DML decomposition — the **key-preserving join**
 * acceptance case of the view-mutation substrate (docs/vu-operators.md
 * § Inner Join, § Outer Joins; docs/view-updateability.md § Multi-Base-Table Mutations).
 *
 * Scope: a view body that is an **n-way (≥2) equi-join** of base tables — `inner`,
 * `left`, or `full` — including composite-PK sides and **self-joins** (one base table
 * under two or more distinct aliases) — written through with `update` / `delete` /
 * `insert`. **LEFT** and **RIGHT** outer joins are admitted for the
 * **statically-expressible** cases: preserved-side update passthrough,
 * delete-to-the-preserved-side, and insert routing (both-side / preserved-only /
 * presence-gated non-preserved member). RIGHT is the exact **mirror** of LEFT — the
 * right operand of a `right` join is preserved, the left operand is null-extended — and
 * the runtime now executes a RIGHT join (`outer-join-right-full-runtime`), so a
 * RIGHT-join view is both readable and writable. **FULL** is admitted only to carry its
 * precise conservative diagnostics (no preserved side, so all writes reject and the
 * surfaces report all-`NO`; FULL write-through — a preserved anchor for a body that is
 * null-extended per row — is a separable future concern). The one outer-join case that
 * needs new runtime — an UPDATE of a **non-preserved** column (a per-row matched-update /
 * null-extended-insert branch) — defers with `unsupported-outer-join-update`
 * (`view-write-optional-member-transitions`). The body is
 * **planned once**
 * (`analyzeJoinView`); its `PhysicalProperties.updateLineage` (threaded by
 * `view-mutation-physical-lineage`) routes each output column to its owning base
 * table. Each per-base SET/value is still lowered to an AST `BaseOp` so the ordinary
 * base-table builders are reused verbatim (the documented lower-risk path — the base
 * builders stay untouched), but **row identification no longer round-trips through a
 * re-planned AST body**: every affected view row's base-PK identities are captured
 * ONCE up-front, built as plan nodes directly over the already-planned join body
 * (`Project_{k<side>}(Filter_{idPred}(joinNode))` — the derived backward walk the
 * docs name, § Round-Trip Laws and the Derived Backward Walk), materialized before
 * any base op fires, and each base op reads its identifying values back from that
 * `__vmupd_keys` set:
 *
 * ```sql
 * -- view: select j1.id as id, j1.a as a, j2.c as c
 * --       from tj1 j1 join tj2 j2 on j2.id = j1.t2id
 * update jv set a = 5, c = 9 where id = 3
 *   -- capture (plan nodes over the planned join body, materialized once):
 *   --   __vmupd_keys = π_{j1.id as k0, j2.id as k1}( σ_{id = 3}( tj1 ⋈ tj2 ) )
 *   ->  update tj1 set a = 5 where id in (select k0 from __vmupd_keys)
 *       update tj2 set c = 9 where id in (select k1 from __vmupd_keys)
 * ```
 *
 * The capture reconstructs the row-identifying predicate (each owning side's base PK)
 * from the planned join body — exactly the predicate the optimizer already proves a
 * key over — so a side whose own PK is hidden by the projection (`tj2.id` above) is
 * still addressable, and a both-sides write is mutation-order-independent (the
 * FK-parent op cannot rewrite a predicate column out from under the FK-child op).
 * UPDATE RETURNING re-queries the same planned `joinNode` (post-mutation, restricted
 * to the captured identities); DELETE RETURNING projects the planned body `root` (the
 * `pre` OLD image). The body is planned once and reused — no second `buildSelectStmt`
 * / `cloneFromClause` of it for identification or RETURNING.
 *
 * Multi-source **`insert`** is analysed here (`analyzeMultiSourceInsert`) but *built* by
 * `building/view-mutation-builder.ts` (`buildMultiSourceInsert`), because it needs the
 * plan-level shared-surrogate envelope rather than an AST `BaseOp`: the shared join key is
 * not a view column, so it is sourced from the anchor key column's declared `default` once
 * per row at the envelope and threaded into the active base inserts via the equivalence
 * class (§ Mutation Context). For an outer join the **non-preserved** side is an *optional*
 * member of the fan-out — dropped when its columns are absent (the preserved-only insert),
 * presence-gated per row when supplied (the both-side insert).
 *
 * **Deferred, rejected here with a structured diagnostic:**
 * - UPDATE of a non-preserved outer-join column — `unsupported-outer-join-update`.
 * - INSERT of only non-preserved columns with no preserved anchor — `null-extended-create-conflict`.
 * - cross / set-op / aggregate / window bodies — `unsupported-*`.
 * - comma (implicit) joins, `select *` join bodies, and cross-side `set` value
 *   references — each a precise diagnostic.
 * - composite **shared-key insert** (the surrogate envelope threads a single-column
 *   key) — `unsupported-decomposition-key`. (Composite-PK *identification* on the
 *   update/delete capture path IS supported here; only the insert envelope's shared
 *   key stays single-column.)
 */

/**
 * The shared identity-capture CTE name for a multi-source (n-way inner-join) UPDATE /
 * multi-side DELETE fan-out. Each affected view row's base-PK identities are
 * materialized ONCE — *before* any base op fires — into `rctx.tableContexts` under a
 * shared descriptor. *Every* per-side base op reads its identifying values back from
 * this set via a correlated EXISTS (`exists (select 1 from __vmupd_keys k where
 * k.k<side>_<j> = <side>.<pk<j>> …)`) instead of a live re-query of the join body, so
 * the first op cannot empty the join — or rewrite a predicate column — out from under
 * a later op's identifying subquery (a mutation-order-independent identity). The same
 * capture backs the UPDATE RETURNING re-query (docs/vu-operators.md § Inner Join,
 * docs/view-updateability.md § `returning`).
 *
 * The capture relation carries one column **per side per PK column**, named
 * `k<sideIndex>_<pkColumnOrdinal>` ({@link keyColumnName}) — so a composite-PK side
 * contributes `k<side>_0, k<side>_1, …`. This flattened per-side-per-column shape is
 * what generalizes the substrate past the retired single-column `(k0, k1)` tuple.
 *
 * Two invariants keep the capture sound now that a key column may be nullable
 * (`docs/schema.md` § Primary-key nullability — NULL is an ordinary, self-equal key value):
 *
 * 1. **Correlation is NULL-safe per nullable key column.** Every reader correlates a
 *    captured key column through {@link captureKeyEquality}: plain `=` for a column
 *    declared NOT NULL (index-friendly), `left = right or (left is null and right is
 *    null)` for a nullable one — so a row keyed NULL stays addressable.
 * 2. **"Had no join partner" is carried explicitly.** For each captured non-preserved
 *    (outer-join) side the capture projects a boolean **match marker**
 *    (`m<side>` — {@link matchFlagName}), an {@link ExistenceColumnSpec} flag set by the
 *    join runtime from the actual null-extension decision. The outer-join branches read
 *    the marker — never "all of the side's captured key columns are NULL", which a real
 *    partner keyed NULL would satisfy too. A NULL marker (the flag itself null-extended
 *    by an enclosing outer join) reads as false.
 */
export const MS_UPDATE_KEYS_CTE = '__vmupd_keys';

/**
 * The capture column name for side `sideIndex`'s `j`-th PK column. A single-column-PK
 * side yields just `k<side>_0`; a composite-PK side yields `k<side>_0, k<side>_1, …`.
 */
export function keyColumnName(sideIndex: number, j: number): string {
	return `k${sideIndex}_${j}`;
}

/**
 * The capture column name of side `sideIndex`'s **match marker** — the boolean
 * "did this non-preserved side have a join partner" flag the capture projects
 * alongside the side's `k<side>_<j>` key columns (invariant 2 of
 * {@link MS_UPDATE_KEYS_CTE}). Minted only for captured non-preserved sides;
 * readers and the capture projection both derive the name here so they cannot
 * drift. Namespace-disjoint from `k<side>_<j>` and the `srcN` value aliases.
 */
export function matchFlagName(sideIndex: number): string {
	return `m${sideIndex}`;
}

/**
 * The AST predicate reading side `sideIndex`'s capture match marker as "this side had
 * NO join partner": `k.m<side> is null or not k.m<side>`. A NULL marker — the flag
 * itself null-extended by an enclosing outer join in an n-way body — must read as
 * false ("no partner"), so the declared NOT NULL of {@link EXISTENCE_FLAG_TYPE} is
 * deliberately not assumed here.
 */
function matchFlagIsFalse(sideIndex: number): AST.Expression {
	const flag = (): AST.ColumnExpr => ({ type: 'column', name: matchFlagName(sideIndex), table: 'k' });
	return {
		type: 'binary',
		operator: 'OR',
		left: { type: 'unary', operator: 'IS NULL', expr: flag() } as AST.UnaryExpr,
		right: { type: 'unary', operator: 'NOT', expr: flag() } as AST.UnaryExpr,
	};
}

// --- shape model ----------------------------------------------------------

/** One base-table side of the join. */
interface JoinSide {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	/** AST alias (lowercased) the body uses for this source, or the table name. */
	readonly alias: string;
	/**
	 * True when this side is **preserved** by the join shape — an inner-join side, or
	 * the preserved side of a LEFT/RIGHT outer join (the left of `left`, the right of
	 * `right`). A **non-preserved** side (`preserved: false`) is potentially
	 * null-extended: the right of a `left`, the left of a `right`, and *both* sides of
	 * a `full` outer join (§ Outer Joins). The per-op routing keys off this: an UPDATE
	 * defers a non-preserved-column write, a DELETE routes to preserved side(s), an
	 * INSERT treats a non-preserved side as an optional (presence-gated) member.
	 */
	readonly preserved: boolean;
	/**
	 * The enclosing outer join's ON predicate — the *guard* under which this
	 * non-preserved side's columns are real (the row is null-extended when the guard
	 * fails). Absent for a preserved side, and for an outer join expressed with USING
	 * (no AST `Expression` guard). Surfaced from the planned join shape for future
	 * per-row materialization; v1 routing does not consume it.
	 */
	readonly guard?: AST.Expression;
}

/** One output column of the join view body, by backward lineage. */
interface OutColumn {
	/** Output (view) column name, lowercased. */
	readonly name: string;
	/** Output (view) column name in its original display spelling (for `returning *`). */
	readonly displayName: string;
	/** Index into `sides` of the owning base table (base-writable columns only). */
	readonly sideIndex?: number;
	/** Owning base column name (base-writable columns only). */
	readonly baseColumn?: string;
	/**
	 * True for a `base` lineage site — an identity/rename projection OR a
	 * non-identity invertible transform (`inverse` present). Writable on update: an
	 * `inverse` column lowers its assigned value through {@link inverse} (§ Scalar
	 * Invertibility). A `computed` / `null-extended` site is read-only (`false`).
	 */
	readonly writable: boolean;
	/**
	 * True when the owning site is an outer-join **non-preserved** (null-extended)
	 * base column. Distinguishes a deferred outer-join column (base lineage present,
	 * but the write needs per-row materialization — `unsupported-outer-join-update`)
	 * from a genuinely computed column (no base lineage — `no-inverse`). A
	 * null-extended base column is still **insertable** (the both-sides envelope
	 * supplies it), so it carries {@link sideIndex} / {@link baseColumn}.
	 */
	readonly nullExtended: boolean;
	/**
	 * Backward inverse closure for a non-identity invertible base site — maps a
	 * *written* (view-domain) value to the base column's value (e.g. `cv + 1` ⇒
	 * `w ↦ w - 1`). Absent for an identity/rename column. Insert through such a
	 * column is NOT supported (the shared-surrogate envelope writes raw values) —
	 * see {@link analyzeMultiSourceInsert}.
	 */
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	/**
	 * Domain predicate (base terms) an `inverse` profile restricts to; conjoined
	 * into the row-identifying predicate on update (§ Scalar Invertibility). No
	 * shipped profile produces one yet (`x ± k` is unrestricted), so it is
	 * currently always absent.
	 */
	readonly domain?: AST.Expression;
	/**
	 * Set for an outer-join `existence` (`exists … as`) flag column. It maps to **no
	 * base column** ({@link sideIndex} / {@link baseColumn} stay undefined), so it is
	 * not a base-write target; instead a write to it is a per-row insert/delete of the
	 * named component (§ Existence columns). `existenceSide` is the resolved
	 * non-preserved side it reifies the match of — the side the flag-flip materializes
	 * (`true`) or removes (`false`). The write router keys off this presence.
	 */
	readonly existenceComponent?: RelationalComponentRef;
	/** The non-preserved side index the existence flag drives (present iff {@link existenceComponent}). */
	readonly existenceSide?: number;
	/**
	 * Set for an authored (`with inverse`) column — writable through the put
	 * expressions, one base assignment per put, each routed to its owning join side
	 * ({@link sideIndex} / {@link baseColumn} stay undefined: there is no single
	 * verbatim base column). `newRefIndex` maps a put's `new.<name>` references to
	 * output column indexes of this analysis's `outColumns`
	 * (docs/vu-inverses.md § Authored inverses).
	 */
	readonly authored?: {
		readonly puts: ReadonlyArray<{ readonly sideIndex: number; readonly baseColumn: string; readonly expr: AST.Expression }>;
		readonly newRefIndex: ReadonlyMap<string, number>;
	};
}

export interface JoinViewAnalysis {
	readonly sel: AST.SelectStmt;
	/** The base-table sides (≥2), in AST source order; routing is keyed by index 0..n-1. */
	readonly sides: readonly JoinSide[];
	/** View column name (lowercased) -> its base-term replacement expression. */
	readonly viewColToBaseRef: ReadonlyMap<string, AST.Expression>;
	readonly outColumns: readonly OutColumn[];
	/**
	 * The planned view body (the source of `updateLineage`). Reused by the DELETE
	 * RETURNING re-query (the OLD view image, projected `pre` over `root`) — so the
	 * body is planned **once** rather than re-expanded through the view name.
	 */
	readonly root: RelationalPlanNode;
	/**
	 * The raw `JoinNode` inside {@link root} (the ON-condition join, *before* the
	 * body's σ/projection). The capture's identifying relation and the UPDATE
	 * RETURNING re-query are built directly on top of it (Filter + Project plan
	 * nodes) instead of re-planning a cloned AST body — the derived backward walk
	 * the docs name (§ Round-Trip Laws and the Derived Backward Walk).
	 */
	readonly joinNode: JoinNode;
	/**
	 * The join's combined column scope (`ctx.outputScopes.get(joinNode)`), which
	 * resolves both alias-qualified (`j1.id`) and unqualified base columns — the
	 * exact scope `buildSelectStmt` used when planning the body. Reused to build the
	 * identifying predicate / PK projections / RETURNING columns as `ScalarPlanNode`s
	 * over {@link joinNode}, so resolution is byte-identical to the retired re-plan.
	 */
	readonly joinScope: Scope;
}

// --- entry ----------------------------------------------------------------

/**
 * True when the view body is a join (and so routes to this multi-source path
 * rather than the single-source spine). Cheap AST peek — no plan built.
 *
 * A **compound (set-op) body** returns `false` even when its left-most leg's FROM is a
 * join (`select … from a join b … union …`): a set-op body routes to the set-op write path
 * (`set-op.ts`), never this multi-source join spine, whose capture/lineage walk reads only
 * the leg's `JoinNode` and silently ignores the surrounding compound — mishandling it
 * (`set-op-write-multisource-leg-reject`). Excluding it here lets such a body fall through to
 * the single-source spine's clean `classifyViewBody` reject (the intent
 * `propagate.ts` already documents). The set-op path itself detects a multi-source LEG by
 * calling this same predicate on the **leg** SELECT (which carries no `compound`).
 */
export function isJoinBody(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.from) return false;
	if (selectAst.compound) return false;
	return selectAst.from.length > 1 || selectAst.from.some(f => f.type === 'join');
}

/**
 * Non-throwing AST shape check — the boolean shadow of {@link collectJoinSources}'s
 * acceptance: `true` iff the body is a single explicit **n-way (≥2) equi-join** — `inner`,
 * `left`, `right`, or `full` (RIGHT is the exact mirror of LEFT; FULL has no preserved
 * side, so it self-conservatizes downstream; see {@link collectJoinSources}) with an ON
 * (or USING) predicate over plain base tables (the
 * exact multi-source shape `propagate()` decomposes), including **composite-PK sides** and
 * **self-joins** (one base table under two or more distinct aliases). Every other
 * multi-table body — cross / comma (implicit) / subquery- or function-source — returns
 * `false`.
 *
 * Shared with the static updateability surfaces (`deriveViewInfo` /
 * `deriveColumnInfo` in `func/builtins/schema.ts`): they gate on this so they
 * agree with what a real mutation through the view accepts. An outer join is now
 * **partially** writable (preserved-side update, delete-to-preserved, insert), so it is
 * decomposable here; those surfaces read per-column `null-extended` lineage to report a
 * non-preserved column non-updatable (the matching deferral). The throwing
 * {@link collectJoinSources} stays the substrate's source of truth; this mirrors only its
 * AST-level shape gate (it does not re-check DISTINCT/LIMIT/`select *`, which are deeper
 * semantic rejects handled downstream — PK shape is no longer a reject now that composite
 * keys are admitted).
 */
export function isDecomposableJoinBody(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.from) return false;
	const from = selectAst.from;
	if (from.length !== 1 || from[0].type !== 'join') return false;

	let tableCount = 0;
	const visit = (fc: AST.FromClause): boolean => {
		switch (fc.type) {
			case 'table':
				tableCount += 1;
				return true;
			case 'join': {
				// INNER / LEFT / RIGHT / FULL join with an explicit ON predicate or a USING column
				// list. RIGHT is now **admitted**: the runtime reads a RIGHT join and write-through
				// recognition mirrors LEFT (the right of a `right` is preserved, the left
				// null-extended; `view-write-right-join-readmit`). FULL is admitted but has no
				// preserved side, so it self-conservatizes downstream (no false positive); FULL
				// write-through is a separable future concern.
				const accepted = fc.joinType === 'inner' || fc.joinType === 'left' || fc.joinType === 'right' || fc.joinType === 'full';
				if (!accepted || (!fc.condition && !(fc.columns && fc.columns.length > 0))) return false;
				return visit(fc.left) && visit(fc.right);
			}
			default:
				return false; // subquery / function source — not a plain base table
		}
	};
	if (!visit(from[0])) return false;

	// ≥2 plain base tables. A self-join (the same base table under distinct aliases) is
	// now accepted; routing is alias-keyed downstream, so the table names need not be
	// distinct here.
	return tableCount >= 2;
}

/**
 * True iff `selectAst` is a decomposable join body ({@link isDecomposableJoinBody}) whose
 * joins are **all INNER**. The set-op join-leg compose
 * (`set-op-write-multisource-leg-compose`) ships INNER join legs — the gate is purely
 * `joinType`-based, so a non-equi (theta) INNER join is admitted identically to an equi-join.
 * An OUTER (left/right/full) join leg's set-op write composition is deferred. The set-op
 * recognizers gate on this so a body with an outer-join leg reports the conservative
 * all-`NO` static surface AND rejects the dynamic write cleanly (never an internal error),
 * matching exactly. A cross / no-ON join (not decomposable) likewise fails this and is
 * deferred — agreeing with `analyzeJoinView`'s downstream reject.
 */
export function isInnerJoinBody(selectAst: AST.QueryExpr): boolean {
	if (!isDecomposableJoinBody(selectAst)) return false;
	const from = (selectAst as AST.SelectStmt).from!;
	const allInner = (fc: AST.FromClause): boolean =>
		fc.type !== 'join' || (fc.joinType === 'inner' && allInner(fc.left) && allInner(fc.right));
	return allInner(from[0]);
}

/**
 * Decompose a multi-source (n-way `inner`/`left`/`full` join) view mutation into
 * an ordered `BaseOp[]`. Throws a structured diagnostic for any unsupported shape.
 */
export function propagateMultiSource(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): BaseOp[] {
	// Validate the join shape first (this rejects cross/comma joins, non-table sources,
	// etc. with a `cannot write through view` diagnostic), so every unsupported join —
	// including an `insert` through one — surfaces the precise shape reason before the
	// op-specific handling. Outer joins are admitted: an UPDATE of a non-preserved column
	// defers (`unsupported-outer-join-update`), DELETE routes to the preserved side(s).
	const analysis = analyzeJoinView(ctx, view);
	switch (req.op) {
		case 'update': return decomposeUpdate(ctx, view, analysis, req.stmt);
		case 'delete': return decomposeDelete(ctx, view, analysis, req.stmt);
		case 'insert':
			// Insert needs the plan-level shared-surrogate envelope, so it is built
			// directly by `building/view-mutation-builder.ts` (`buildMultiSourceInsert`,
			// off `analyzeMultiSourceInsert` below), not lowered to AST BaseOps here.
			// `buildViewMutation` routes a join insert there before `propagate` runs,
			// so this case is unreachable on the supported path.
			raiseMutationDiagnostic({
				reason: 'unsupported-multisource-insert',
				table: view.name,
				message: `internal: multi-source insert must be built via buildMultiSourceInsert, not propagate`,
			});
	}
}

// --- INSERT (shared-surrogate envelope analysis) --------------------------

/**
 * One base side of a multi-source insert, fully resolved: the base columns it
 * writes (shared key first, then the supplied view columns it owns) and, for
 * each, the index into the materialized envelope row supplying the value.
 */
export interface MsInsertSide {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	readonly targetColumns: readonly string[];
	readonly envelopeIndices: readonly number[];
	/**
	 * Envelope indices whose non-null presence gates this side's insert per row — a
	 * non-preserved (outer-join optional) member inserts only for rows that supply ≥1
	 * of its columns (§ Outer Joins — Inserts). Empty ⇒ unconditional (a preserved /
	 * inner side, always inserted). Reuses the decomposition fan-out's presence gate
	 * (`buildDecompositionMemberInsert`).
	 */
	readonly presenceGateIndices: readonly number[];
	/**
	 * Set when this side's shared-key (FK-child) column must be threaded conditionally:
	 * `keyTargetIndex` is its position in `targetColumns` (0 — the key is pushed first
	 * when `needsSharedKey`), and `groups` is an AND-of-(OR-within) list of envelope
	 * indices — one inner group per presence-gated FK-parent partner — that gates the
	 * key. When all referenced presence-gated partners are absent for a row, the key
	 * column projects null (the correct "no partner" marker), so the FK does not dangle
	 * (§ Outer Joins — Inserts). Absent ⇒ the key threads unconditionally (a
	 * parent/anchor side, or a key shared only among always-active sides).
	 */
	readonly keyGate?: { readonly keyTargetIndex: number; readonly groups: readonly (readonly number[])[] };
	/**
	 * Per-side constant-FD insert-defaults lifted from the join body's σ (where-clause)
	 * equality constants (§ Inner Join — Inserts; the multi-source analog of the single-
	 * source § Selection rule). Each entry supplies an omitted σ-constrained base column its
	 * σ value, so the inserted row satisfies the view predicate and is visible through the
	 * view. Unlike the minted shared key these are NOT envelope-sourced — they are per-row
	 * **constants**, so they carry their literal node directly and ride the side's
	 * `ProjectNode` as a compiled constant (`buildExpression`), needing no envelope column.
	 * Because the projection rides the side (not the VALUES rows), this also supports a
	 * **SELECT-source** insert (a strict capability gain over the single-source path, which
	 * defers σ-defaulting for SELECT sources). Empty/absent ⇒ no σ-constrained columns this
	 * side. A σ over the side's shared join key is skipped (the EC thread owns that value).
	 */
	readonly sigmaDefaults?: readonly { readonly baseColumn: string; readonly valueExpr: AST.Expression }[];
}

/**
 * The plan-agnostic decomposition of a multi-source inner-join INSERT, consumed
 * by `buildMultiSourceInsert`. The **envelope** is the per-row augmented source:
 * its leading columns are the supplied view columns (`suppliedColumns`, in
 * user-source order), optionally followed by a surrogate shared key sourced from
 * the anchor key column's declared `default` (`keyDefault`). Each side reads its
 * values back out of that one materialized envelope, so the default is evaluated
 * exactly once per row and the value threads across both base inserts via the
 * equivalence class (docs/vu-mutation-context.md § Mutation Context).
 */
export interface MsInsertAnalysis {
	readonly suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[];
	/** Sides ordered FK-parent before FK-child (the FK-safe insert order). */
	readonly orderedSides: readonly MsInsertSide[];
	/**
	 * The anchor key column's declared `default`, evaluated once per produced row at
	 * the envelope (with `mutation_ordinal()` in scope) and threaded into every side's
	 * key column via the equivalence class. Set only when the shared key is **not**
	 * directly supplied; absent ⇒ a supplied view column threads the key.
	 */
	readonly keyDefault?: AST.Expression;
	/**
	 * The schema owning the ANCHOR BASE TABLE the {@link keyDefault} was declared on —
	 * which may differ from the view's schema. It is the schema the default's own
	 * unqualified relation names resolve against (`schemaAuthoredContext`), so it must
	 * travel with the expression. Set exactly when `keyDefault` is.
	 */
	readonly keyDefaultSchemaName?: string;
}

/**
 * Decompose an n-way key-preserving INSERT into the per-side base inserts plus the
 * shared-surrogate envelope they fan out from. Throws a structured diagnostic for any
 * unsupported shape (computed target column, a not-null base column with no value, a
 * non-equi-join key, …). The shared key remains **single-column**: a side contributing a
 * composite shared key to the join's equivalence class is rejected with
 * `unsupported-decomposition-key` (the envelope threads one key value per row).
 *
 * **Outer joins** (§ Outer Joins — Inserts): a **non-preserved** side is an *optional*
 * member of the fan-out. A side whose columns are all absent emits no insert (it is
 * dropped); a non-preserved side that IS supplied is presence-gated per row (it inserts
 * only for rows supplying ≥1 of its columns). The shared key is minted/threaded only when
 * ≥2 sides are active (the preserved-only case is a single preserved insert — the row
 * reads back null-extended); an insert supplying *only* non-preserved columns, with no
 * preserved anchor row to attach to, is rejected `null-extended-create-conflict` (v1).
 */
export function analyzeMultiSourceInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): MsInsertAnalysis {
	rejectReturning(view, stmt.returning);
	const analysis = analyzeJoinView(ctx, view);
	const { sides, outColumns } = analysis;
	const keyColumns = extractJoinKeyColumns(view, analysis.sel, sides);

	// Constant-FD insert-defaults from the join body's σ (where-clause): each `column =
	// literal` conjunct, resolved to its owning join side, is lifted as a per-side
	// insert-default (the side-aware analog of single-source `extractFilterConstants`). An
	// omitted σ-constrained column is then supplied its σ constant so the inserted row
	// satisfies the view predicate and is visible through the view; an explicit value that
	// contradicts the constant rejects at plan time below (§ Inner Join — Inserts).
	const filterConstants = extractJoinFilterConstants(analysis.sel.where, sides);

	// Supplied view columns: the explicit list, or every base-routed (identity, rename,
	// or outer-join null-extended) view output column. An `inverse`-profile column
	// (writable on the UPDATE path) is NOT insertable — the shared-surrogate envelope
	// writes supplied values to base columns verbatim, with no hook to apply the column's
	// inverse, so an inserted `cv1` would land raw in `cv`. Excluding it from the implicit
	// set lets it fall to its base default / not-null check; an explicit supply is
	// rejected below. A non-preserved (null-extended) base column IS insertable here (the
	// both-sides envelope supplies it), so it is included even though it is read-only on
	// the UPDATE path.
	const suppliedNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: outColumns.filter(c => c.sideIndex !== undefined && c.baseColumn !== undefined && !c.inverse).map(c => c.name);

	// One supplied envelope column. A base-routed column carries `sideIndex`/`baseColumn`;
	// an **existence** (`exists … as`) flag carries neither — it is a per-row *routing
	// directive* (`existenceFlag`) on its non-preserved `existenceSide`, never stored to a
	// base, but kept as an (unused) envelope column so the materialized source's arity still
	// matches the user's VALUES (§ Existence columns — Inserts).
	interface Supplied {
		readonly name: string;
		readonly type: ScalarType;
		readonly sideIndex?: number;
		readonly baseColumn?: string;
		readonly isKey: boolean;
		readonly existenceSide?: number;
		readonly existenceFlag?: boolean;
	}
	const supplied: Supplied[] = suppliedNames.map((rawName, columnIndex): Supplied => {
		const name = rawName.toLowerCase();
		const out = outColumns.find(c => c.name === name);
		// An existence flag is consumed as a routing directive, not stored. Pull its uniform
		// boolean literal out of the VALUES source (`true` ⇒ insert the non-preserved side;
		// `false` ⇒ omit it / preserved-only). It stays an envelope column for arity but is
		// never a base target (no `sideIndex`/`baseColumn`).
		if (out?.existenceComponent) {
			if (out.existenceSide === undefined) {
				raiseMutationDiagnostic({
					reason: 'unsupported-outer-join-update',
					column: rawName,
					table: view.name,
					message: `cannot insert through view '${view.name}': the existence column '${rawName}' does not resolve to a single non-preserved side (an ambiguous / full-outer existence shape is deferred)`,
				});
			}
			const existenceFlag = existenceInsertFlag(view, stmt, columnIndex, rawName);
			return { name, type: EXISTENCE_FLAG_TYPE, isKey: false, existenceSide: out.existenceSide, existenceFlag };
		}
		// Evaluating an authored (`with inverse`) column's puts through the multi-source
		// shared-surrogate envelope is deferred (the envelope projects supplied columns
		// verbatim per side; per-row put evaluation over it is a follow-up — recorded in
		// docs/vu-inverses.md § Authored inverses). Name the deferral precisely
		// rather than letting it fall into the generic non-insertable reject below.
		if (out?.authored) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert through view '${view.name}': column '${rawName}' carries an authored inverse (WITH INVERSE); evaluating authored puts through a join view's insert envelope is deferred — insert into the base tables directly`,
			});
		}
		// A base-routed column (identity/rename or outer-join null-extended) carries
		// `sideIndex` + `baseColumn`; a computed column does not, and an `inverse` column
		// cannot store a raw value. Either of the latter is non-insertable.
		if (!out || out.inverse || out.sideIndex === undefined || !out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert through view '${view.name}': column '${rawName}' is computed (non-invertible), a transformed (invertible) column, or not a base column, so it cannot receive an inserted value`,
			});
		}
		const sideIndex = out.sideIndex;
		const baseCol = columnByName(sides[sideIndex].schema, out.baseColumn);
		const isKey = out.baseColumn.toLowerCase() === keyColumns[sideIndex].toLowerCase();
		return { name, sideIndex, baseColumn: out.baseColumn, type: columnSchemaToScalarType(baseCol), isKey };
	});

	// A FULL outer join has no preserved anchor side to mint/thread the shared key from
	// (every side is null-extended per row), so a statically-routed insert is not
	// expressible — defer it (the static `view_info` surface short-circuits the same body
	// to all-`NO`).
	const hasPreservedSide = sides.some(s => s.preserved);
	if (!hasPreservedSide) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': a FULL outer join has no preserved anchor side to mint/thread the shared key from; inserting through a full-outer view is deferred`,
		});
	}

	// Existence directives (§ Existence columns — Inserts): an `exists … as` flag forces its
	// non-preserved side active (`true`) or inactive (`false`), overriding the columns-
	// supplied inference. A `false` directive on a side whose columns ARE supplied, or a
	// `true`+`false` collision, contradicts — reject rather than silently pick one.
	const forcedActive = new Set<number>();
	const forcedInactive = new Set<number>();
	for (const s of supplied) {
		if (s.existenceSide === undefined) continue;
		(s.existenceFlag ? forcedActive : forcedInactive).add(s.existenceSide);
	}
	const baseSupplied = supplied.filter((s): s is Supplied & { sideIndex: number; baseColumn: string } => s.sideIndex !== undefined);
	const suppliedSides = new Set(baseSupplied.map(s => s.sideIndex));
	for (const i of forcedInactive) {
		if (forcedActive.has(i) || suppliedSides.has(i)) {
			raiseMutationDiagnostic({
				reason: 'conflicting-assignment',
				table: view.name,
				message: `cannot insert through view '${view.name}': an existence flag is false (omit base table '${sides[i].schema.name}') but the same insert ${forcedActive.has(i) ? 'also sets that flag true' : 'supplies one of its columns'} — the two contradict`,
			});
		}
	}

	// Active sides: a preserved (or inner) side is always inserted (the anchor row); a
	// non-preserved (outer) side is active when ≥1 of its columns is supplied OR an
	// existence flag forces it (`true`). A `false` directive forces it inactive even if a
	// stray column slipped through (already rejected above). An absent non-preserved side
	// emits no insert (the per-row null-extension semantics).
	const isActive = (i: number): boolean =>
		forcedInactive.has(i) ? false : (forcedActive.has(i) || sides[i].preserved || suppliedSides.has(i));
	const activeIndices = sides.map((_, i) => i).filter(isActive);

	// Non-preserved-only reject (§ Outer Joins — Inserts): activating only a non-preserved
	// side (columns supplied or `hasB = true`), with no preserved anchor row to mint/thread
	// the shared key from, is not yet expressible (the envelope sources the key from the
	// preserved anchor).
	const anyNonPreservedActive = sides.some((s, i) => !s.preserved && isActive(i));
	const anyPreservedSupplied = baseSupplied.some(s => sides[s.sideIndex].preserved);
	if (anyNonPreservedActive && !anyPreservedSupplied) {
		raiseMutationDiagnostic({
			reason: 'null-extended-create-conflict',
			table: view.name,
			message: `cannot insert through view '${view.name}': only non-preserved-side columns were supplied through the outer join, with no preserved-side row to attach to; supply the preserved side's columns too (the shared key is minted/threaded from the preserved anchor)`,
		});
	}

	// The shared key relates two or more active sides; with only one active side (the
	// preserved-only insert) no key is needed — the single side inserts and the row reads
	// back null-extended.
	const needsSharedKey = activeIndices.length >= 2;

	// The shared key is either directly supplied (a supplied view column maps to a
	// join-key base column) or sourced from the anchor key column's declared `default`,
	// evaluated once per row at the envelope and EC-threaded into the active sides. The
	// engine mints nothing of its own — the basis author declares the policy
	// (docs/vu-mutation-context.md § Mutation Context).
	const suppliedKeys = supplied.filter(s => s.isKey);
	if (suppliedKeys.length > 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the shared join key is exposed by more than one view column (${suppliedKeys.map(s => `'${s.name}'`).join(', ')}); supply it through a single view column`,
		});
	}
	const suppliedKeyIndex = supplied.findIndex(s => s.isKey);
	let keyDefault: AST.Expression | undefined;
	let keyDefaultSchemaName: string | undefined;
	let keyEnvelopeIndex = -1;
	if (needsSharedKey) {
		if (suppliedKeyIndex >= 0) {
			keyEnvelopeIndex = suppliedKeyIndex;
		} else {
			keyEnvelopeIndex = supplied.length; // the default-sourced column is appended last
			// The anchor is the FK-root among the **active** sides (so a dropped optional
			// member never seeds the surrogate); its key column's declared default sources
			// the minted value.
			const anchorIndex = orderSides(sides).find(isActive)!;
			const anchorKeyCol = columnByName(sides[anchorIndex].schema, keyColumns[anchorIndex]);
			keyDefault = requireKeyDefault(view, sides[anchorIndex].schema, anchorKeyCol);
			// The default is schema-authored on the anchor BASE table, not on the view —
			// carry its owning schema so the build narrows the path to the right one.
			keyDefaultSchemaName = sides[anchorIndex].schema.schemaName;
		}
	}

	// Per active side: the shared key (when needed) plus the supplied view columns it
	// owns. A non-preserved active side carries a presence gate over its supplied columns.
	//
	// When a non-preserved side IS active but a *given row's* supplied values are all null
	// (its presence gate fails for that row), that row's non-preserved insert is dropped.
	// An FK-child side that threads the minted key into its join column unconditionally
	// would then point that FK column at a key with no partner row (a dangling reference —
	// an FK violation under enforcement, a latent spooky-join otherwise). The per-row
	// conditional key thread below (`keyGate`) closes that: the FK-child's key column is
	// nulled for exactly the rows whose presence-gated partner is absent, so the
	// preserved row reads back cleanly null-extended with no dangling FK. The *statically*
	// absent case (a non-preserved side with NO supplied columns) needs no gate — it is
	// inactive ⇒ no key is threaded at all.
	// σ-constant contradiction reject (the supplied-and-contradicting case): when an
	// explicit insert value lands on a σ-constrained base column AND contradicts its
	// constant, reject `predicate-contradiction` at plan time — parity with single-source
	// `checkContradiction`. Match a supplied entry by its resolved (sideIndex, baseColumn)
	// so a *renamed* view column is covered (the supplied entry carries the base column,
	// not the view spelling). Only literal VALUES cells are provable; a non-literal cell, a
	// parameter, or a SELECT source is unprovable ⇒ skipped (proceed), exactly as single-
	// source. The user supplies the value, so no σ-default is appended for it.
	for (const fc of filterConstants) {
		const idx = supplied.findIndex(s => s.sideIndex === fc.sideIndex && s.baseColumn !== undefined && s.baseColumn.toLowerCase() === fc.baseColumn.toLowerCase());
		if (idx >= 0) checkJoinFilterContradiction(stmt.source, idx, fc, view);
	}

	const specByIndex = new Map<number, MsInsertSide>();
	for (const sideIndex of activeIndices) {
		const side = sides[sideIndex];
		const targetColumns: string[] = [];
		const envelopeIndices: number[] = [];
		if (needsSharedKey) {
			targetColumns.push(keyColumns[sideIndex]);
			envelopeIndices.push(keyEnvelopeIndex);
		}
		const presenceGateIndices: number[] = [];
		supplied.forEach((s, idx) => {
			// An existence directive (no `baseColumn`/`sideIndex`) is never stored — it is an
			// unused envelope column. Base columns route to their owning side as before.
			if (s.sideIndex !== sideIndex || s.baseColumn === undefined) return;
			if (needsSharedKey && s.isKey) return; // the key is threaded above
			targetColumns.push(s.baseColumn);
			envelopeIndices.push(idx);
			if (!side.preserved) presenceGateIndices.push(idx);
		});
		// σ-default routing (the not-supplied, owning-side-active case): a σ-constrained base
		// column this side owns that the insert did NOT supply is defaulted to its σ constant
		// — appended as a constant projection on the side (the builder compiles `valueExpr`),
		// NOT an envelope column. The shared join key is skipped (`keyColumns[sideIndex]` — the
		// EC/key thread owns that value; a σ on a join key is degenerate); a supplied column is
		// skipped (the user's value wins, contradiction-checked above). The σ default is a
		// per-row constant, never added to `presenceGateIndices`, so it never makes an
		// otherwise-absent optional side "present". An inactive side reaches neither this loop
		// nor a default (no base row to default into — the documented structural residual).
		const sigmaDefaults: { baseColumn: string; valueExpr: AST.Expression }[] = [];
		for (const fc of filterConstants) {
			if (fc.sideIndex !== sideIndex) continue;
			if (fc.baseColumn.toLowerCase() === keyColumns[sideIndex].toLowerCase()) continue;
			if (supplied.some(s => s.sideIndex === sideIndex && s.baseColumn !== undefined && s.baseColumn.toLowerCase() === fc.baseColumn.toLowerCase())) continue;
			if (sigmaDefaults.some(d => d.baseColumn.toLowerCase() === fc.baseColumn.toLowerCase())) continue;
			sigmaDefaults.push({ baseColumn: fc.baseColumn, valueExpr: fc.valueExpr });
		}
		// A σ default legitimately covers a NOT-NULL-without-default base column (e.g. `where
		// color='red'` covering a NOT NULL `color`), so fold the σ-default columns into the
		// covered set BEFORE the NOT-NULL assertion.
		assertNoMissingNotNull(view, side.schema, [...targetColumns, ...sigmaDefaults.map(d => d.baseColumn)]);
		specByIndex.set(sideIndex, { table: side.table, schema: side.schema, targetColumns, envelopeIndices, presenceGateIndices, ...(sigmaDefaults.length > 0 ? { sigmaDefaults } : {}) });
	}

	// Per-row conditional key thread (the FK-dangling-key fix). With the key MINTED and
	// threaded, any active side `S` that declares a foreign key onto a presence-gated active
	// partner `P` must NOT point its key (FK) column at the shared key for a row where `P` is
	// per-row absent (its presence gate fails, dropping its insert) — otherwise `S`'s row
	// references a freshly minted key with no partner row. Gate `S`'s key column on the AND,
	// over each such partner, of that partner's presence predicate (the OR of its supplied
	// columns being non-null — its own `presenceGateIndices`), nulling the key when all such
	// partners are absent. A parent/anchor side (whose key is its own referenced PK)
	// declares no FK onto the partner ⇒ no gate ⇒ its key threads unconditionally (nulling
	// a NOT NULL PK would be wrong); a key shared only among always-active sides likewise
	// stays unconditional. The key sits at target index 0 (pushed first under
	// `needsSharedKey`).
	//
	// A *supplied* shared key (a view column carries it, `suppliedKeyIndex >= 0`) is NEVER
	// gated: the value is the user's explicit reference, which may point at a PRE-EXISTING
	// parent the insert does not touch (`pv` left null because the parent already exists), so
	// nulling it would silently discard the user's key and orphan the child. The both-side-
	// create "no partner ⇒ no key" reasoning holds only for the engine-minted key, whose
	// referent exists iff this insert creates it; for a supplied key, FK enforcement is the
	// correct validator of a dangling reference (an honest error beats a silent null).
	if (needsSharedKey && suppliedKeyIndex < 0) {
		for (const sideIndex of activeIndices) {
			const groups: number[][] = [];
			for (const partnerIndex of activeIndices) {
				if (partnerIndex === sideIndex) continue;
				const partner = specByIndex.get(partnerIndex)!;
				if (partner.presenceGateIndices.length === 0) continue; // an always-active partner
				if (!sideDeclaresFkOnto(sides[sideIndex], sides[partnerIndex])) continue;
				groups.push([...partner.presenceGateIndices]);
			}
			// `groups.length >= 2` is the under-determined multi-parent shape: this FK-child
			// threads its SINGLE shared key column into ≥2 presence-gated (outer-joined)
			// parents (`cc.pr references p1(pp) references p2(qq)`, both LEFT-joined and
			// supplied). One key value `K` must satisfy two FK constraints at once, so a
			// both-create row needs BOTH parents present; a partial-supply row (one parent's
			// value null) nulls `pr` entirely via the AND-gate, yet the present parent still
			// materializes through its own presence filter — silently losing the supplied
			// value and orphaning that parent. We cannot statically prove every row supplies
			// all parents, so the shape is rejected rather than threaded as a broken AND-gated
			// key (§ Outer Joins — Inserts; the per-parent-key-columns generalization is future
			// work). The single-parent (`groups.length === 1`) gate below is the shipped,
			// tested `ojv2` behavior and is unaffected.
			if (groups.length >= 2) {
				raiseMutationDiagnostic({
					reason: 'unsupported-decomposition-key',
					table: view.name,
					message: `cannot insert through view '${view.name}': the FK-child side '${sides[sideIndex].schema.name}' threads a single shared key into ${groups.length} optional (outer-joined) parents; one key column cannot reference some-but-not-all of them per row (a multi-parent shared-key insert is not yet supported — supply all parents, or split into per-parent key columns)`,
				});
			}
			if (groups.length > 0) {
				const spec = specByIndex.get(sideIndex)!;
				specByIndex.set(sideIndex, { ...spec, keyGate: { keyTargetIndex: 0, groups } });
			}
		}
	}

	const order = orderSides(sides).filter(i => specByIndex.has(i));
	return {
		suppliedColumns: supplied.map(s => ({ name: s.name, type: s.type })),
		orderedSides: order.map(i => specByIndex.get(i)!),
		keyDefault,
		keyDefaultSchemaName,
	};
}

/**
 * The uniform boolean directive an `exists … as` existence column supplies on a
 * multi-source INSERT — `true` ⇒ insert the non-preserved side, `false` ⇒ omit it
 * (preserved-only). The flag is a *routing directive*, decided at plan time, so it must
 * be a boolean literal that is the **same** across every inserted VALUES row (a per-row
 * branch on the written value, or a SELECT/DML source whose value is not statically
 * known, is deferred — `unsupported-outer-join-update` / `unsupported-source`).
 * `columnIndex` is the flag's position in the explicit column list, hence its position in
 * each VALUES tuple.
 */
function existenceInsertFlag(view: MutableViewLike, stmt: AST.InsertStmt, columnIndex: number, columnName: string): boolean {
	if (stmt.source.type !== 'values') {
		raiseMutationDiagnostic({
			reason: 'unsupported-source',
			column: columnName,
			table: view.name,
			message: `cannot insert through view '${view.name}': the existence column '${columnName}' is a routing directive that must be a literal in a VALUES source (a SELECT/DML source's per-row value is deferred)`,
		});
	}
	let flag: boolean | undefined;
	for (const row of stmt.source.values) {
		const cell = row[columnIndex];
		const b = cell ? asBooleanLiteral(cell) : undefined;
		if (b === undefined) {
			raiseMutationDiagnostic({
				reason: 'unsupported-outer-join-update',
				column: columnName,
				table: view.name,
				message: `cannot insert through view '${view.name}': the existence column '${columnName}' must be a boolean literal (true/false); a non-literal per-row directive is deferred`,
			});
		}
		if (flag === undefined) flag = b;
		else if (flag !== b) {
			raiseMutationDiagnostic({
				reason: 'unsupported-outer-join-update',
				column: columnName,
				table: view.name,
				message: `cannot insert through view '${view.name}': the existence column '${columnName}' must be uniform across the inserted rows (a per-row mix of true/false is deferred)`,
			});
		}
	}
	// An empty VALUES list cannot reach here (the parser requires ≥1 row); default false.
	return flag ?? false;
}

/** One cross-side `column = column` equality recovered from a join ON / USING clause. */
interface CrossSideEquality { readonly sideA: number; readonly colA: string; readonly sideB: number; readonly colB: string; }

/**
 * Walk every nested `JoinClause`'s ON predicate (flattened on AND) and USING column
 * list across the n-way join tree, collecting cross-side `column = column` equalities
 * (each operand resolving to a *different* side via {@link resolveColumnSide}). The
 * shared backward read the insert envelope's shared-key extraction relies on — it must
 * see ALL conjunctions (not just the outermost join's ON), since for `a join b on …
 * join c on …` only the last ON is on `from[0]`.
 */
function collectCrossSideEqualities(from: readonly AST.FromClause[], sides: readonly JoinSide[]): CrossSideEquality[] {
	const out: CrossSideEquality[] = [];
	const sidesUnder = (fc: AST.FromClause): number[] => {
		switch (fc.type) {
			case 'table': {
				const alias = (fc.alias ?? fc.table.name).toLowerCase();
				const idx = sides.findIndex(s => s.alias === alias);
				return idx >= 0 ? [idx] : [];
			}
			case 'join':
				return [...sidesUnder(fc.left), ...sidesUnder(fc.right)];
			default:
				return [];
		}
	};
	const visit = (fc: AST.FromClause): void => {
		if (fc.type !== 'join') return;
		visit(fc.left);
		visit(fc.right);
		if (fc.condition) {
			for (const conj of flattenAnd(fc.condition)) {
				if (conj.type !== 'binary' || conj.operator !== '=') continue;
				if (conj.left.type !== 'column' || conj.right.type !== 'column') continue;
				const sa = resolveColumnSide(conj.left, sides);
				const sb = resolveColumnSide(conj.right, sides);
				if (sa === undefined || sb === undefined || sa === sb) continue;
				out.push({ sideA: sa, colA: conj.left.name, sideB: sb, colB: conj.right.name });
			}
		}
		// USING (c, …): each named column equates the same-named column on the left and
		// right operands. The operands may be nested joins, so locate the unique owning
		// side under each (a column present on exactly one side of each operand subtree).
		if (fc.columns) {
			const ownerUnder = (operand: AST.FromClause, col: string): number | undefined => {
				const owners = sidesUnder(operand).filter(i => sides[i].schema.columns.some(c => c.name.toLowerCase() === col.toLowerCase()));
				return owners.length === 1 ? owners[0] : undefined;
			};
			for (const colName of fc.columns) {
				const sa = ownerUnder(fc.left, colName);
				const sb = ownerUnder(fc.right, colName);
				if (sa === undefined || sb === undefined || sa === sb) continue;
				out.push({ sideA: sa, colA: colName, sideB: sb, colB: colName });
			}
		}
	};
	visit(from[0]);
	return out;
}

/**
 * The per-side shared-key base columns of an n-way inner equi-join, aligned to `sides`
 * by index. Walks every ON conjunction / USING column ({@link collectCrossSideEqualities})
 * and requires they connect all sides into a **single** shared-key equivalence class
 * with exactly one key column per side (the surrogate the decomposition threads through
 * the envelope's equivalence class). A side contributing more than one column to the EC
 * is the deferred multi-column-surrogate shape — rejected `unsupported-decomposition-key`;
 * a join that does not relate every side through one shared value (a chained / multi-key
 * join) is rejected `unsupported-join`.
 */
function extractJoinKeyColumns(view: MutableViewLike, sel: AST.SelectStmt, sides: readonly JoinSide[]): string[] {
	const equalities = collectCrossSideEqualities(sel.from!, sides);
	if (equalities.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the join must carry an explicit equi-join ON/USING predicate naming the shared key`,
		});
	}

	// Per side: the distinct columns it contributes to a cross-side equality.
	const perSideCols: Array<Set<string>> = sides.map(() => new Set<string>());
	// Union-find over `<side>:<col>` keys — proves a single shared-key equivalence class.
	const parent = new Map<string, string>();
	const ensure = (k: string): void => { if (!parent.has(k)) parent.set(k, k); };
	const find = (k: string): string => { ensure(k); let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
	const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };
	const nodeKey = (side: number, col: string): string => `${side}:${col.toLowerCase()}`;
	for (const eq of equalities) {
		perSideCols[eq.sideA].add(eq.colA);
		perSideCols[eq.sideB].add(eq.colB);
		union(nodeKey(eq.sideA, eq.colA), nodeKey(eq.sideB, eq.colB));
	}

	const keyCols = sides.map((side, i): string => {
		const cols = [...perSideCols[i]];
		if (cols.length === 0) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `cannot insert through view '${view.name}': base table '${side.schema.name}' is not related to the shared join key by any equi-join predicate`,
			});
		}
		if (cols.length > 1) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-key',
				table: view.name,
				message: `cannot insert through view '${view.name}': base table '${side.schema.name}' contributes a composite shared key (${cols.join(', ')}); a multi-column shared-key insert envelope is not yet supported`,
			});
		}
		return cols[0];
	});

	// All sides' key columns must belong to ONE equivalence class — a single shared value
	// threaded into every side via the EC. A chain (`a.x=b.y join … b.z=c.w`) yields
	// disjoint key classes that no single surrogate can thread.
	const root0 = find(nodeKey(0, keyCols[0]));
	for (let i = 1; i < sides.length; i++) {
		if (find(nodeKey(i, keyCols[i])) !== root0) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `cannot insert through view '${view.name}': the join does not relate all base tables through a single shared key (a chained / multi-key join insert is not yet supported)`,
			});
		}
	}
	return keyCols;
}

/**
 * One base column pinned to a constant by the join body's σ (where-clause), resolved to
 * its owning join side — the multi-source, side-aware analog of single-source
 * `FilterConstant`.
 */
interface JoinFilterConstant {
	readonly sideIndex: number;
	/** The side's base column name in canonical (schema) case. */
	readonly baseColumn: string;
	/** The literal RHS node — cloned into the side projection at the build. */
	readonly valueExpr: AST.Expression;
	/** The folded literal value for the contradiction check; `undefined` ⇒ unprovable. */
	readonly value: SqlValue | undefined;
}

/**
 * Lift the join body's σ (`where`) `column = literal` equality conjuncts as per-side
 * constant-FD insert-defaults — the side-aware analog of single-source
 * `extractFilterConstants`. Each conjunct's column operand is resolved to its owning join
 * side via {@link resolveColumnSide} (which handles alias-qualified `sv1.color` AND
 * unqualified columns, returning `undefined` for ambiguous/unresolved — skipped
 * conservatively, parity with {@link joinCorrelatesMutualFk}); the side's canonical base-
 * column name is resolved via {@link columnByName}. Only a **literal** RHS is lifted (parity
 * with single-source — a `where color = :p` parameter, or a `col = col` / non-equality
 * conjunct, is not a constant-FD producer and is skipped). The σ-constrained column is
 * frequently projected away (`color` is not a view output column), so re-scanning the AST
 * — rather than reading the planned body's output attributes — is the established write-path
 * pattern.
 */
function extractJoinFilterConstants(where: AST.Expression | undefined, sides: readonly JoinSide[]): JoinFilterConstant[] {
	const out: JoinFilterConstant[] = [];
	if (!where) return out;
	for (const conj of flattenAnd(where)) {
		if (conj.type !== 'binary' || conj.operator !== '=') continue;
		const colSide = conj.left.type === 'column' ? conj.left : conj.right.type === 'column' ? conj.right : undefined;
		const litSide = conj.left.type === 'literal' ? conj.left : conj.right.type === 'literal' ? conj.right : undefined;
		if (!colSide || !litSide) continue;
		const sideIndex = resolveColumnSide(colSide, sides);
		if (sideIndex === undefined) continue; // ambiguous / unresolved — skip conservatively
		const baseCol = columnByName(sides[sideIndex].schema, colSide.name);
		const value = litSide.value instanceof Promise ? undefined : litSide.value;
		out.push({ sideIndex, baseColumn: baseCol.name, valueExpr: litSide, value });
	}
	return out;
}

/**
 * Reject an insert literal cell that contradicts a join-σ constant — the multi-source
 * analog of single-source `checkContradiction`. Walks every VALUES row's `columnIndex`
 * cell (the supplied entry's position in the envelope/VALUES tuple) and rejects
 * `predicate-contradiction` when a literal cell ≠ the σ constant. A non-literal cell, a
 * parameter, an unprovable constant (`fc.value === undefined`), or a non-VALUES (SELECT)
 * source is skipped (unprovable ⇒ proceed).
 */
function checkJoinFilterContradiction(source: AST.QueryExpr, columnIndex: number, fc: JoinFilterConstant, view: MutableViewLike): void {
	if (source.type !== 'values' || fc.value === undefined) return;
	for (const row of source.values) {
		const cell = row[columnIndex];
		if (!cell || cell.type !== 'literal' || cell.value instanceof Promise) continue;
		if (!sqlValueIdentical(cell.value, fc.value)) {
			raiseMutationDiagnostic({
				reason: 'predicate-contradiction',
				column: fc.baseColumn,
				table: view.name,
				message: `insert into view '${view.name}' contradicts its selection predicate on column '${fc.baseColumn}'`,
			});
		}
	}
}

/** Reject a not-null base column with no declared default that no envelope value covers. */
function assertNoMissingNotNull(view: MutableViewLike, schema: TableSchema, targetColumns: readonly string[]): void {
	const covered = new Set(targetColumns.map(c => c.toLowerCase()));
	for (const col of schema.columns) {
		if (col.generated || !col.notNull || col.defaultValue !== null) continue;
		if (covered.has(col.name.toLowerCase())) continue;
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: col.name,
			table: view.name,
			message: `cannot insert through view '${view.name}': base table '${schema.name}' column '${col.name}' is NOT NULL with no default and no value supplied through the view`,
		});
	}
}

/**
 * The anchor key column's declared `default` — the surrogate's per-row source —
 * evaluated once per produced row at the envelope (with `mutation_ordinal()` in
 * scope) and threaded into both sides via the equivalence class. The engine no
 * longer invents a surrogate: a key that is neither supplied nor defaulted raises
 * `no-default` with the migration recipe.
 */
function requireKeyDefault(view: MutableViewLike, schema: TableSchema, keyCol: ColumnSchema): AST.Expression {
	if (keyCol.defaultValue === null) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: keyCol.name,
			table: view.name,
			message: `cannot insert through view '${view.name}': the shared key '${schema.name}.${keyCol.name}' is neither supplied nor declares a DEFAULT; declare a default (e.g. \`default (coalesce((select max(${keyCol.name}) from ${schema.name}), 0) + mutation_ordinal())\`) or supply the key through a view column`,
			suggestion: `declare a DEFAULT on '${schema.name}.${keyCol.name}', or expose the key as a supplied view column`,
		});
	}
	return keyCol.defaultValue;
}

function columnByName(schema: TableSchema, name: string): ColumnSchema {
	const col = schema.columns.find(c => c.name.toLowerCase() === name.toLowerCase());
	if (!col) {
		raiseMutationDiagnostic({ reason: 'no-base-lineage', table: schema.name, column: name, message: `column '${name}' not found on base table '${schema.name}'` });
	}
	return col;
}

// --- analysis -------------------------------------------------------------

export function analyzeJoinView(ctx: PlanningContext, view: MutableViewLike): JoinViewAnalysis {
	if (view.selectAst.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' has a ${view.selectAst.type.toUpperCase()} body, which has no recoverable base operation`,
		});
	}
	const sel = view.selectAst;

	// LIMIT / OFFSET / DISTINCT escape the predicate-conjoin rewrite — reject (as
	// the single-source spine does) rather than silently widen the write.
	if (sel.limit || sel.offset) {
		raiseMutationDiagnostic({
			reason: 'unsupported-limit',
			table: view.name,
			message: `cannot write through view '${view.name}': a LIMIT/OFFSET join body is not decomposable (a mutation would escape the limited window)`,
		});
	}
	if (sel.distinct) {
		raiseMutationDiagnostic({
			reason: 'unsupported-distinct',
			table: view.name,
			message: `cannot write through view '${view.name}': a DISTINCT join body has no 1:1 base-row lineage`,
		});
	}

	const sources = collectJoinSources(view, sel.from!);

	// Explicit projections only: a `select *` over a join is rejected here (before
	// the shared backward read) so it surfaces the join-specific diagnostic rather
	// than the generic projection/attribute arity mismatch (column→base routing
	// relies on a 1:1 projection list).
	if (sel.columns.some(c => c.type === 'all')) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': list the join's output columns explicitly (a 'select *' join body is not yet decomposable)`,
		});
	}

	// Plan the body ONCE and read its threaded `updateLineage` through the shared
	// backward-walk consumer (`analyzeBodyLineage`) — the same n-way reader the
	// decomposition fan-out consumes (§ Round-Trip Laws and the Derived Backward
	// Walk). The raw JoinNode + its column scope and the per-side routing layer on
	// top.
	const { root, tableRefsById, viewColToBaseRef, columns } = analyzeBodyLineage(ctx, view);

	// The raw JoinNode + its combined column scope, captured from the SINGLE plan of
	// the body above. The identity capture and RETURNING re-query build their
	// identifying / projection plan nodes directly on top of these (no AST re-plan of
	// the join body for row identification — § Round-Trip Laws and the Derived
	// Backward Walk). `joinScope` is the exact scope `buildSelectStmt` resolved the
	// body's own predicate/projections against (set into `ctx.outputScopes` during
	// `buildJoin`), so reusing it makes base-term resolution byte-identical to the
	// retired re-plan.
	const joinNode = findJoinNode(view, root);
	const joinScope = ctx.outputScopes.get(joinNode);
	if (!joinScope) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the planned join body did not expose a resolvable column scope`,
		});
	}

	// Map each AST source's **alias** to its planned `TableReferenceNode` by resolving
	// the alias-qualified PK column through the join's combined scope (the same scope the
	// body's own projections resolved against) to the producing attribute → its owning
	// `TableReferenceNode`. A by-table-NAME match is ambiguous for a self-join (two
	// sources share one table name); the alias is the discriminator, and each alias is a
	// distinct scan node post-plan, so resolving through the scope pins the right ref.
	// `attrToTableRef` inverts every base ref's attribute ids (which the inner join
	// preserves up to its output) so a resolved column reference identifies its source.
	const attrToTableRef = new Map<number, TableReferenceNode>();
	for (const ref of tableRefsById.values()) {
		for (const attr of ref.getAttributes()) attrToTableRef.set(attr.id, ref);
	}
	const schemaByTableName = new Map<string, TableSchema>();
	for (const ref of tableRefsById.values()) schemaByTableName.set(ref.tableSchema.name.toLowerCase(), ref.tableSchema);

	const sides: JoinSide[] = sources.map((src): JoinSide => {
		const alias = (src.source.alias ?? src.source.table.name).toLowerCase();
		const schema = schemaByTableName.get(src.source.table.name.toLowerCase());
		if (!schema) {
			raiseMutationDiagnostic({
				reason: 'no-base-lineage',
				table: view.name,
				message: `cannot write through view '${view.name}': base table '${src.source.table.name}' did not resolve in the planned body`,
			});
		}
		const ref = resolveSourceTableRef(ctx, joinScope, schema, alias, attrToTableRef, view);
		return { table: ref, schema: ref.tableSchema, alias, preserved: src.preserved, ...(src.guard ? { guard: src.guard } : {}) };
	});

	const sideByTableId = new Map<number, number>();
	sides.forEach((s, idx) => sideByTableId.set(Number(s.table.id), idx));

	// The existence flag's `RelationalComponentRef` carries the JoinNode CHILD's
	// plan-node id (best-effort — an *aliased* source wraps the scan in an `AliasNode`,
	// so the child id is the wrapper's, not the scan's). Map every body node id to the
	// SOLE `TableReferenceNode` beneath it so a flag's component id resolves through the
	// wrapper to its scan node, then to its side index (§ Existence columns).
	const nodeToSoleTableRef = buildNodeToSoleTableRef(root);

	// Route each shared backward column onto its owning join side. An inner-join body
	// never null-extends (`nullExtended` always false); an outer-join body marks the
	// non-preserved side's columns `nullExtended: true` (the join-predicate-guarded
	// site `deriveJoinUpdateLineage` wraps) — still base-routed, but read-only on
	// update (the deferred materialization) and insertable as an optional member.
	const outColumns: OutColumn[] = columns.map((bc): OutColumn => {
		if (bc.baseTableId !== undefined && bc.baseColumn !== undefined) {
			const sideIndex = sideByTableId.get(bc.baseTableId);
			return {
				name: bc.name,
				displayName: bc.displayName,
				sideIndex,
				baseColumn: bc.baseColumn,
				writable: sideIndex !== undefined && !bc.nullExtended,
				nullExtended: bc.nullExtended,
				...(bc.inverse ? { inverse: bc.inverse } : {}),
				...(bc.domain ? { domain: bc.domain } : {}),
			};
		}
		if (bc.existenceComponent) {
			const existenceSide = resolveExistenceSide(bc.existenceComponent, nodeToSoleTableRef, sideByTableId, sides);
			return {
				name: bc.name,
				displayName: bc.displayName,
				// Not a base-column write — its write is an insert/delete effect on the
				// component side, routed by `decomposeUpdate` off `existenceComponent`.
				writable: false,
				nullExtended: false,
				existenceComponent: bc.existenceComponent,
				...(existenceSide !== undefined ? { existenceSide } : {}),
			};
		}
		// An authored (`with inverse`) column: resolve each put's owning base relation
		// to its join side — the same ownership routing every other put rides. A put
		// whose relation is not a join side (defensive; the lineage routed it through a
		// body TableReferenceNode) degrades the column to read-only.
		if (bc.authored) {
			const puts: { sideIndex: number; baseColumn: string; expr: AST.Expression }[] = [];
			let routable = true;
			for (const p of bc.authored.puts) {
				const sideIndex = sideByTableId.get(p.table);
				if (sideIndex === undefined) { routable = false; break; }
				puts.push({ sideIndex, baseColumn: p.baseColumn, expr: p.expr });
			}
			if (routable) {
				return {
					name: bc.name,
					displayName: bc.displayName,
					writable: true,
					nullExtended: false,
					authored: { puts, newRefIndex: bc.authored.newRefIndex },
				};
			}
		}
		return { name: bc.name, displayName: bc.displayName, writable: false, nullExtended: false };
	});

	return { sel, sides, viewColToBaseRef, outColumns, root, joinNode, joinScope };
}

/**
 * Resolve one AST join source (by its `alias`) to its planned `TableReferenceNode`.
 * Probes with the source's first PK column (or first column if keyless) qualified by
 * the alias, resolved through the join's combined `joinScope` — the inner join
 * preserves the producing base scan's attribute id up to its output, so the resolved
 * `ColumnReferenceNode`'s attribute id pins the alias's owning `TableReferenceNode`
 * via `attrToTableRef`. This is what disambiguates a **self-join** (two sources sharing
 * one table name but distinct aliases → distinct scan nodes).
 */
function resolveSourceTableRef(
	ctx: PlanningContext,
	joinScope: Scope,
	schema: TableSchema,
	alias: string,
	attrToTableRef: ReadonlyMap<number, TableReferenceNode>,
	view: MutableViewLike,
): TableReferenceNode {
	const pk = schema.primaryKeyDefinition;
	const probeColName = (pk.length > 0 ? schema.columns[pk[0].index] : schema.columns[0])?.name;
	if (!probeColName) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': base table '${schema.name}' (alias '${alias}') has no columns to resolve its join side`,
		});
	}
	const probe = buildExpression({ ...ctx, scope: joinScope }, { type: 'column', name: probeColName, table: alias } as AST.ColumnExpr);
	if (!(probe instanceof ColumnReferenceNode)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': join source alias '${alias}' did not resolve to a base column reference in the planned body`,
		});
	}
	const ref = attrToTableRef.get(probe.attributeId);
	if (!ref) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': join source alias '${alias}' did not resolve to a base table in the planned body`,
		});
	}
	return ref;
}

/**
 * The single `JoinNode` inside a planned n-way inner-join body — the outermost
 * `JoinNode` reached from the root (the body's plan is `Project(Filter?(Join…))`; for
 * an n-way join the outermost JoinNode transitively contains the nested ones). Reused
 * (not re-planned) as the source the identifying-capture / RETURNING relations build
 * on; the nested joins ride inside it via its own `getRelations()`.
 */
function findJoinNode(view: MutableViewLike, root: PlanNode): JoinNode {
	let found: JoinNode | undefined;
	const visit = (n: PlanNode): void => {
		if (found) return;
		if (n instanceof JoinNode) { found = n; return; }
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	if (!found) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the planned body did not contain a join node`,
		});
	}
	return found;
}

/**
 * Map every node in a planned body to the SOLE `TableReferenceNode` reachable beneath
 * it. Resolves an existence flag's `RelationalComponentRef` — which names the JoinNode
 * child's plan-node id, an `AliasNode` wrapper for an *aliased* source — back to its
 * scan node. A node spanning two or more base tables is left unmapped (size ≠ 1).
 */
function buildNodeToSoleTableRef(root: PlanNode): Map<number, TableReferenceNode> {
	const out = new Map<number, TableReferenceNode>();
	const visit = (n: PlanNode): TableReferenceNode[] => {
		if (n instanceof TableReferenceNode) { out.set(Number(n.id), n); return [n]; }
		const refs: TableReferenceNode[] = [];
		for (const child of n.getRelations()) refs.push(...visit(child));
		const uniqueIds = new Set(refs.map(r => Number(r.id)));
		if (uniqueIds.size === 1) out.set(Number(n.id), refs[0]);
		return refs;
	};
	visit(root);
	return out;
}

/**
 * Resolve an existence flag's component to the non-preserved join side it drives. The
 * component names the JoinNode child's plan-node id; resolve it through any wrapper to
 * its scan node ({@link buildNodeToSoleTableRef}) → side index. Falls back to the unique
 * non-preserved side when the id does not resolve (v1: a single LEFT join has exactly
 * one such side). Returns `undefined` only when the side is genuinely ambiguous (≠1
 * non-preserved side — e.g. a parser-rejected FULL); the write router then defers.
 */
function resolveExistenceSide(
	component: RelationalComponentRef,
	nodeToSoleTableRef: ReadonlyMap<number, TableReferenceNode>,
	sideByTableId: ReadonlyMap<number, number>,
	sides: readonly JoinSide[],
): number | undefined {
	if (component.kind === 'join-side') {
		const ref = nodeToSoleTableRef.get(component.table);
		const direct = ref ? sideByTableId.get(Number(ref.id)) : undefined;
		if (direct !== undefined) return direct;
	}
	const nonPreserved = sides.flatMap((s, i) => s.preserved ? [] : [i]);
	return nonPreserved.length === 1 ? nonPreserved[0] : undefined;
}

/** One base-table source of the join body, with its preserved/guard classification. */
interface JoinSourceInfo {
	readonly source: AST.TableSource;
	/** False when an enclosing outer join potentially null-extends this source. */
	readonly preserved: boolean;
	/** The conjoined ON predicate(s) of the enclosing outer join(s) that null-extend it. */
	readonly guard?: AST.Expression;
}

/**
 * Collect the join's base-table sources (in AST declaration order), validating the body
 * is an **n-way (>=2) equi-join** over plain base tables — `inner`, `left`, `right`, or
 * `full` (RIGHT is the mirror of LEFT; FULL has no preserved side, so it self-
 * conservatizes downstream; no comma/implicit cross join, no subquery or function
 * sources). A **self-join**
 * — the same base table under distinct aliases — is accepted (routing is alias-keyed
 * downstream); USING joins are accepted alongside ON joins. The declaration order is the
 * alias-declaration order the substrate serializes per-side ops in (§ Cycles, Self-Joins).
 *
 * Each source is tagged **preserved** / **non-preserved** by walking the join tree and
 * tracking which branch each table sits on: the right of a `left`, the left of a `right`,
 * and both sides of a `full` are non-preserved (potentially null-extended), carrying the
 * enclosing outer join's ON predicate as their guard (§ Outer Joins). An inner join
 * propagates its parents' classification unchanged. This is the AST-shape dual of the
 * planned body's `null-extended` lineage (which `analyzeJoinView` cross-checks per column).
 */
function collectJoinSources(view: MutableViewLike, from: readonly AST.FromClause[]): JoinSourceInfo[] {
	if (from.length !== 1 || from[0].type !== 'join') {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': only an explicit 'JOIN ... ON/USING' body is decomposable (a comma/implicit cross join is not)`,
		});
	}

	const out: JoinSourceInfo[] = [];
	// `nonPreserved` is true when an enclosing outer join can null-extend the subtree;
	// `guards` are those outer joins' ON predicates (conjoined onto each leaf's guard).
	const visit = (fc: AST.FromClause, nonPreserved: boolean, guards: readonly AST.Expression[]): void => {
		switch (fc.type) {
			case 'table':
				out.push({
					source: fc,
					preserved: !nonPreserved,
					guard: guards.reduce<AST.Expression | undefined>((acc, g) => combineAnd(acc, g), undefined),
				});
				return;
			case 'join': {
				const hasPredicate = !!fc.condition || (!!fc.columns && fc.columns.length > 0);
				// RIGHT is **admitted** (`view-write-right-join-readmit`): the runtime reads a
				// RIGHT join and its preserved/non-preserved classification is the exact mirror of
				// LEFT (the right operand of a `right` is preserved, the left null-extended — see
				// the per-side recursion below), so the substrate routes it symmetrically (it keys
				// off `JoinSide.preserved`, not source order). FULL is accepted only to carry
				// through to its precise conservative diagnostics (it has no preserved side, so it
				// never falsely advertises); FULL write-through is a separable future concern.
				const acceptedType = fc.joinType === 'inner' || fc.joinType === 'left' || fc.joinType === 'right' || fc.joinType === 'full';
				if (!acceptedType || !hasPredicate) {
					raiseMutationDiagnostic({
						reason: 'unsupported-join',
						table: view.name,
						message: `cannot write through view '${view.name}': only INNER/LEFT/RIGHT/FULL joins with an ON/USING predicate are decomposable (got '${fc.joinType}'${hasPredicate ? '' : ' without ON/USING'})`,
					});
				}
				// USING joins carry no AST `Expression` guard — only an explicit ON predicate
				// is surfaced as the null-extension guard (v1 routing does not consume it).
				const guardsWith = fc.condition ? [...guards, fc.condition] : guards;
				switch (fc.joinType) {
					case 'inner':
						visit(fc.left, nonPreserved, guards);
						visit(fc.right, nonPreserved, guards);
						break;
					case 'left':
						visit(fc.left, nonPreserved, guards);
						visit(fc.right, true, guardsWith);
						break;
					case 'right':
						// Mirror of `left`: the left operand of a RIGHT join is null-extended
						// (non-preserved), the right operand is preserved.
						visit(fc.left, true, guardsWith);
						visit(fc.right, nonPreserved, guards);
						break;
					case 'full':
						visit(fc.left, true, guardsWith);
						visit(fc.right, true, guardsWith);
						break;
				}
				return;
			}
			default:
				raiseMutationDiagnostic({
					reason: 'nested-view',
					table: view.name,
					message: `cannot write through view '${view.name}': join sources must be plain base tables (a subquery / function source in the join is not yet supported)`,
				});
		}
	};
	visit(from[0], false, []);

	if (out.length < 2) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': a decomposable join needs at least two base tables (found ${out.length})`,
		});
	}
	return out;
}

/**
 * Scope guard for the multi-source path — parity with the single-source spine
 * (`single-source.ts` § `assertTopLevelViewColumns`). A top-level `where` / `set`
 * reference that is not a join-view output column would otherwise pass through
 * `substituteViewColumns` unmapped and re-bind against a base table in the
 * identifying subquery's join body (the same encapsulation leak). `outColumns`
 * already enumerates every projected view column (computed ones included, marked
 * non-writable), so it is the view's exposed column set.
 */
function guardTopLevelScope(expr: AST.Expression, analysis: JoinViewAnalysis, view: MutableViewLike): void {
	assertTopLevelViewColumns(
		expr,
		new Set(analysis.outColumns.map(c => c.name)),
		analysis.outColumns.map(c => c.displayName),
		view,
	);
}

// --- UPDATE ---------------------------------------------------------------

/**
 * A partner-side base column a cross-source SET value reads (`update v set a.x = b.y`),
 * captured into `__vmupd_keys` so the lowered single-table UPDATE can read it back. The
 * `expr` is the read column in base terms (alias-qualified — `b.y`), projected into the
 * capture over the join body's scope under the stable `alias` (`src0`, `src1`, …); the
 * rewritten value (`select <alias> from __vmupd_keys k where <ownerPk = capture>`) reads
 * it correlated by the owning side's PK. Because the capture materializes **before** any
 * base op fires, the read-back value is the **pre-mutation** partner value — robust to a
 * both-sides update that also rewrites it (docs/vu-operators.md § Inner Join).
 */
export interface CrossSourceValue {
	readonly alias: string;
	readonly expr: AST.Expression;
}

export function decomposeUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.UpdateStmt, sourceValues?: CrossSourceValue[], captureRelationName: string = MS_UPDATE_KEYS_CTE): BaseOp[] {
	// RETURNING through a multi-source update is supported, but the rows are not
	// recoverable from the per-side base ops (the view row spans both tables), so
	// the builder (`view-mutation-builder.ts`) supplies them via a re-query of the
	// planned join body; the base ops themselves carry no RETURNING.

	// Each assignment routes to its owning base side by lineage, unconditionally —
	// there is no statement-level base-set override (the routing tags were removed;
	// a per-row presence/membership column expresses any non-default routing).

	// Scope guard: top-level `where` references must name view columns (parity with
	// the single-source spine — a base-only name must not leak through the join body).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);

	// Cross-source SET values (`set a.x = b.y`) ride the same `__vmupd_keys` capture:
	// each partner-side base column the SET reads is projected into the capture under a
	// stable `srcN` alias, and the reference is rewritten to a correlated scalar read of
	// it (keyed by the owning side's PK). The carrier is the `sourceValues` out-param the
	// builder threads into `buildMultiSourceKeyCapture`; absent it (the legacy
	// `propagateMultiSource` path, unreachable from build) cross-source values stay
	// rejected by `stripSideQualifier`'s throw.
	const srcDedup = new Map<string, string>();
	// Project an arbitrary base-term expression into the up-front `__vmupd_keys` capture
	// under a stable `srcN` alias (deduped by `key`), returning that alias. The carrier is
	// the `sourceValues` out-param the builder threads into the capture, so each projection
	// is materialized pre-mutation over the join body. Backs both the cross-source SET reads
	// and the outer-join non-preserved materialization (the captured assigned value + the EC
	// join key). Absent ⇒ the legacy non-build path, which keeps deferring those shapes.
	const registerCapturedExpr = sourceValues
		? (key: string, expr: AST.Expression): string => {
			const existing = srcDedup.get(key);
			if (existing) return existing;
			const alias = `src${sourceValues.length}`;
			srcDedup.set(key, alias);
			sourceValues.push({ alias, expr });
			return alias;
		}
		: undefined;
	const registerCrossSource = sourceValues
		? (col: AST.ColumnExpr): string => {
			const key = `${(col.table ?? '').toLowerCase()}.${col.name.toLowerCase()}`;
			const existing = srcDedup.get(key);
			if (existing) return existing;
			const alias = `src${sourceValues.length}`;
			srcDedup.set(key, alias);
			sourceValues.push({ alias, expr: { type: 'column', name: col.name, table: col.table } });
			return alias;
		}
		: undefined;

	// Route each assignment to its owning base side (one entry per side, index 0..n-1).
	const perSide: Array<{ column: string; value: AST.Expression }[]> = analysis.sides.map(() => []);
	// Non-preserved (outer-join null-extended) assignments, keyed by their owning side: each
	// rides a matched-UPDATE (pushed into `perSide`, its captured PK non-null) plus a single
	// null-extended-INSERT op (built after the per-side loop, one per non-preserved side,
	// carrying every column assigned on that side). § Outer Joins — Updates.
	const nullExtendedBySide = new Map<number, Array<{ baseColumn: string; valAlias: string }>>();
	// Existence-flag writes (§ Existence columns): writing an `exists … as` flag drives the
	// non-preserved side's existence. `set hasB = true` materializes the side for the
	// null-extended partition (the matched-update path's null-extended INSERT with no
	// assigned columns — the EC join key + base defaults); `set hasB = false` deletes the
	// matched partition. Tracked by the non-preserved side they drive.
	const existenceInsertSides = new Set<number>();
	const existenceDeleteSides = new Set<number>();
	// `new.<x>` in an authored put binds the WRITTEN view row: when `x` is also
	// assigned in this statement, that assignment's value (every embedded RHS reads
	// the pre-update join row, so cross-references are order-independent); otherwise
	// the column's forward read image. First occurrence wins on a duplicate target —
	// the base builder's duplicate-assignment backstop rejects the statement anyway.
	// Keyed by out-column index (the `newRefIndex` domain).
	const assignedValueByIdx = new Map<number, AST.Expression>();
	stmt.assignments.forEach(a => {
		const i = analysis.outColumns.findIndex(c => c.name === a.column.toLowerCase());
		if (i >= 0 && !assignedValueByIdx.has(i)) assignedValueByIdx.set(i, a.value);
	});
	for (const asg of stmt.assignments) {
		const out = analysis.outColumns.find(c => c.name === asg.column.toLowerCase());
		if (!out) {
			// Not a view column at all — the same encapsulation-leak guard as the
			// top-level `where` scan (distinct from a computed view column below).
			raiseUnknownViewColumn(asg.column, view, analysis.outColumns.map(c => c.displayName));
		}
		// An `exists … as` existence flag (no base column): writing it is the explicit
		// insert/delete-of-the-component effect. `true` ⇒ insert the non-preserved side for
		// the null-extended partition; `false` ⇒ delete the matched partition. Reuses the
		// non-preserved-column update substrate (capture + null-extended INSERT / captured-key
		// DELETE), so the runtime is reused, not extended (§ Existence columns).
		if (out.existenceComponent) {
			if (!registerCapturedExpr) {
				raiseMutationDiagnostic({
					reason: 'unsupported-outer-join-update',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the existence column '${asg.column}' drives a per-row insert/delete of the non-preserved side, which needs the capture carrier`,
				});
			}
			if (out.existenceSide === undefined) {
				raiseMutationDiagnostic({
					reason: 'unsupported-outer-join-update',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the existence column '${asg.column}' does not resolve to a single non-preserved side (an ambiguous / full-outer existence shape is deferred)`,
				});
			}
			const npSideIndex = out.existenceSide;
			// RETURNING is not recoverable through an existence-flip (the post-mutation
			// re-query identifies by the captured non-preserved PK — null for a freshly
			// materialized row, deleted for a removed one), so reject it (parity with the
			// non-preserved-column update).
			if (stmt.returning && stmt.returning.length > 0) {
				raiseMutationDiagnostic({
					reason: 'returning-through-view',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': RETURNING is not supported on an existence-flag write '${asg.column}' — the materialized/deleted non-preserved row is not recoverable by the captured-identity re-query`,
				});
			}
			const flag = asBooleanLiteral(asg.value);
			if (flag === undefined) {
				raiseMutationDiagnostic({
					reason: 'unsupported-outer-join-update',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the existence column '${asg.column}' must be assigned a boolean literal (true/false); a per-row branch on a non-literal value is deferred`,
				});
			}
			if (flag) {
				// `true`: materialize the non-preserved side for the null-extended partition.
				// Ensure a (possibly empty) `nullExtendedBySide` entry so the post-loop emits
				// the materialization INSERT; a same-side `set` folds its columns into it.
				existenceInsertSides.add(npSideIndex);
				if (!nullExtendedBySide.has(npSideIndex)) nullExtendedBySide.set(npSideIndex, []);
			} else {
				// `false`: delete the matched partition (captured non-preserved PK non-null).
				existenceDeleteSides.add(npSideIndex);
			}
			continue;
		}
		// A non-preserved (outer-join null-extended) base column splits per row (§ Outer
		// Joins — Updates on a non-preserved-side column): where the non-preserved side
		// matched it is an ordinary base update; where the row is null-extended (no match) it
		// is rewritten as an insert on that side. Both ride the up-front `__vmupd_keys`
		// capture, materialized pre-mutation over the join body, and both partition on the
		// capture's explicit MATCH MARKER (invariant 2 of MS_UPDATE_KEYS_CTE): the matched
		// op correlates only marker-true capture rows; the null-extended op fires for the
		// marker-false rows. The assigned value is captured ONCE (so both branches read the
		// identical pre-mutation value), and the matched op reads it back keyed NULL-safely
		// on the non-preserved PK. Needs the capture carrier; the legacy
		// `propagateMultiSource` path (no carrier) keeps deferring with
		// `unsupported-outer-join-update`.
		if (out.nullExtended && out.sideIndex !== undefined && out.baseColumn) {
			if (!registerCapturedExpr) {
				raiseMutationDiagnostic({
					reason: 'unsupported-outer-join-update',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': column '${asg.column}' is backed by the non-preserved side of an outer join (base table '${analysis.sides[out.sideIndex].schema.name}'); the per-row matched-update / null-extended-insert materialization needs the capture carrier`,
				});
			}
			// RETURNING through a non-preserved-side update IS supported: the post-mutation
			// re-query (`buildMultiSourceUpdateReturning`) re-keys its identity EXISTS off the
			// stable preserved-side PK (a per-non-preserved-side matched-OR-null disjunction),
			// so a freshly-materialized null-extended row — whose non-preserved PK was captured
			// NULL — surfaces via its preserved-side equalities instead of being dropped by a
			// `NULL = <minted pk>` match (`view-write-outer-join-nonpreserved-returning`). The
			// existence-flag RETURNING reject above stays — `set hasB = false` deletes the
			// matched partition, which neither disjunction branch recovers.
			// The assigned value's top-level references must name view columns (parity with
			// the preserved path); the value is then lowered to base terms over the join body
			// and captured pre-mutation, so a same- or cross-side read resolves uniformly.
			guardTopLevelScope(asg.value, analysis, view);
			const npSide = analysis.sides[out.sideIndex];
			const baseValue = substituteViewColumns(ctx, asg.value, analysis.viewColToBaseRef, view, analysis.sides);
			const valAlias = registerCapturedExpr(`neval:${out.sideIndex}:${out.baseColumn.toLowerCase()}`, baseValue);
			// Matched rows: a per-side UPDATE reading the captured value back, correlated by
			// the non-preserved side's PK (`buildCapturedKeyPredicate` restricts the op to
			// matched rows via the capture's match marker; `matchedOnly` gates this read-back
			// the same way, so a null-extended capture row — key columns NULL — cannot feed a
			// target row whose key genuinely holds NULL). The read-back is `min`-de-duped per
			// non-preserved partner: when N preserved rows share one existing partner, that
			// partner's PK matches all N capture rows, so a bare scalar read would error
			// `Scalar subquery returned more than one row` — `min` collapses the
			// shared-partner group to one value (a no-op for a constant / np-only SET).
			perSide[out.sideIndex].push({ column: out.baseColumn, value: capturedValueSubquery(valAlias, out.sideIndex, requireKeyColumns(view, npSide), 'min', SELF_ALIAS, captureRelationName, true) });
			// Null-extended rows: accumulate the (column, captured value) for this side's
			// single materialization insert, built after the loop.
			let list = nullExtendedBySide.get(out.sideIndex);
			if (!list) { list = []; nullExtendedBySide.set(out.sideIndex, list); }
			list.push({ baseColumn: out.baseColumn, valAlias });
			continue;
		}
		// Lower a view-term value expression onto one owning side: gate cross-source
		// reads + 1:many cardinality, substitute view columns to base terms, then strip
		// the owning side's qualifier (a partner-side read becomes a correlated read of
		// its captured pre-mutation value). Shared by the plain per-column route and the
		// authored put fan-out below.
		const lowerValueOntoSide = (valueViewTerms: AST.Expression, owningSideIndex: number, assignedCol: string): AST.Expression => {
			// Gate cross-source reads: a value that reads a partner-side view column is
			// admitted only when that column has `base` lineage (its value is recoverable
			// from a captured base column). A computed (non-base) partner column stays
			// rejected (`no-inverse`); a same-side read keeps the qualifier-strip path. Run
			// only when a capture carrier is threaded — the legacy path rejects wholesale.
			if (registerCrossSource) gateCrossSourceReads(valueViewTerms, owningSideIndex, analysis, view);
			const side = analysis.sides[owningSideIndex];
			// Cross-source cardinality gate (§ Inner Join, cross-source `set`): a cross-source
			// value `set owner.x = partner.y` is well-defined only when the owning side joins AT
			// MOST ONE partner row — else the capture's correlated read-back is multi-valued and
			// the runtime would error `Scalar subquery returned more than one row`. Reject the
			// 1:many direction at plan time, naming the cross-source ambiguity. Bound to this
			// assignment's owning side; memoized per partner side so the join equalities are
			// collected once. Threaded only on the capture-carrier path (symmetric with
			// `registerCrossSource`); the legacy path rejects cross-source wholesale before this.
			const cardinalityProven = new Map<number, boolean>();
			const gateCrossSourceCardinality = registerCrossSource
				? (partnerCol: AST.ColumnExpr): void => {
					const partnerIdx = resolveColumnSide(partnerCol, analysis.sides);
					if (partnerIdx === undefined || partnerIdx === owningSideIndex) return;
					let proven = cardinalityProven.get(partnerIdx);
					if (proven === undefined) {
						proven = ownerJoinsAtMostOnePartner(owningSideIndex, partnerIdx, analysis.sel, analysis.sides);
						cardinalityProven.set(partnerIdx, proven);
					}
					if (!proven) {
						const partnerTable = analysis.sides[partnerIdx].schema.name;
						raiseMutationDiagnostic({
							reason: 'cross-source-ambiguous-cardinality',
							column: assignedCol,
							table: view.name,
							message: `cannot write through view '${view.name}': the cross-source assignment of column '${assignedCol}' reads column '${partnerCol.name}' on base table '${partnerTable}', but the assigned side joins more than one '${partnerTable}' row (the join does not constrain '${partnerTable}' to a unique key), so the partner value is ambiguous — a cross-source \`set\` value is well-defined only when the assigned side joins at most one partner row`,
						});
					}
				}
				: undefined;
			// Rewrite the assigned value into base terms, then strip the owning side's
			// qualifier (the base UPDATE targets that table directly). A reference to a
			// partner side is rewritten to a correlated read of its captured pre-mutation
			// value (`registerCrossSource`); absent the carrier it is rejected.
			return stripSideQualifier(
				substituteViewColumns(ctx, valueViewTerms, analysis.viewColToBaseRef, view, analysis.sides),
				view, side, owningSideIndex, analysis.sides, registerCrossSource, gateCrossSourceCardinality,
			);
		};
		// An authored (`with inverse`) column lowers to one base assignment per put,
		// each routed to its owning join side — a two-sided target set yields two child
		// ops, atomic, FK-parent-first ordered by the shared `orderSides` below. Inside
		// each put, `new.<x>` binds the WRITTEN view row: the assigned value when `x`
		// is assigned in this statement (including this column itself), that view
		// column's name otherwise — still in VIEW terms — then the standard lowering
		// maps everything onto the put's side (the forward read image for non-assigned
		// columns; a cross-side read rides the same captured-read machinery as a
		// cross-source SET value). docs/vu-inverses.md § Authored inverses.
		if (out.authored) {
			const authored = out.authored;
			// The assigned VALUE's top-level references must name view columns (parity
			// with the plain route below).
			guardTopLevelScope(asg.value, analysis, view);
			for (const put of authored.puts) {
				const viewTermExpr = substituteNewRefs(put.expr, name => {
					const idx = requireValidatedNewRefIndex(authored.newRefIndex, name, asg.column);
					return assignedValueByIdx.get(idx)
						?? { type: 'column', name: analysis.outColumns[idx].displayName };
				});
				perSide[put.sideIndex].push({
					column: put.baseColumn,
					value: lowerValueOntoSide(viewTermExpr, put.sideIndex, out.displayName),
				});
			}
			continue;
		}
		if (!out.writable || out.sideIndex === undefined || !out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': column '${asg.column}' is a computed (non-invertible) expression and is read-only`,
			});
		}
		// The assigned VALUE's top-level references must name view columns too (parity
		// with the single-source spine). On a single-table side a base-only name would
		// otherwise re-bind in that table; across sides it would fail to resolve with a
		// generic error — the structured guard makes the diagnostic uniform either way.
		guardTopLevelScope(asg.value, analysis, view);
		const baseValue = lowerValueOntoSide(asg.value, out.sideIndex, out.displayName);
		// For an `inverse`-profile column the assigned value is in the VIEW domain;
		// apply the site's inverse to recover the BASE value (`cv1 = cv + 1` ⇒ the
		// write `cv1 = w` stores `cv = w - 1`). The base-term substitution + side-
		// qualifier strip above already produced the written value in base terms; the
		// inverse wraps that last (it expects a value already in base terms).
		const written = out.inverse ? out.inverse(baseValue) : baseValue;
		perSide[out.sideIndex].push({ column: out.baseColumn, value: written });
		// NB: a present `out.domain` (an `inverse`-profile restriction) would conjoin
		// into the identifying predicate. No shipped invertibility profile produces a
		// domain (`x ± k` is unrestricted over integers), and the capture path that now
		// backs EVERY side's identification (`__vmupd_keys`) does not yet thread
		// per-assignment domains — deferred uniformly until a domain-bearing profile
		// lands (§ Scalar Invertibility).
	}

	// Existence-flip contradiction (§ Existence columns): `set <npCol> = …, hasB = false`
	// cannot both delete the non-preserved side and write one of its columns; an np-column
	// write always emits a matched per-side UPDATE, so a non-empty `perSide[side]` on a
	// delete side is the contradiction. `hasB = true, hasB = false` (insert+delete the same
	// side) is the same conflict. Reject rather than silently picking one effect.
	for (const side of existenceDeleteSides) {
		if (perSide[side].length > 0 || existenceInsertSides.has(side)) {
			raiseMutationDiagnostic({
				reason: 'conflicting-assignment',
				table: view.name,
				message: `cannot write through view '${view.name}': an existence-flag write deletes base table '${analysis.sides[side].schema.name}' (the non-preserved side) while the same statement also writes one of its columns — the two effects contradict`,
			});
		}
	}

	// Every affected view row's base-PK identities are captured ONCE up-front (before
	// any base op fires) and each per-side op reads its identifying values back from
	// that captured set via a correlated EXISTS over `__vmupd_keys` (matching all of the
	// side's PK columns — composite keys included), a mutation-order-independent identity
	// built from the ALREADY-planned join body (the builder materializes the capture; see
	// `buildMultiSourceKeyCapture`). This unifies the single-side and both-sides paths
	// onto the same identity (no live re-query of a re-planned AST body): a both-sides
	// update's FK-parent op can no longer rewrite a predicate column out from under the
	// FK-child op, and a single-side op — having no ordering hazard — reads the same
	// pre-mutation set it would have re-queried live.

	// Order FK-parent before FK-child by the n-way FK topological sort (matches insert
	// ordering intent and avoids surprising mid-statement FK states); source order within
	// an FK-equivalence class (and for self-joins, whose mutual edges fall back to
	// alias-declaration order — § Cycles, Self-Joins).
	const order = orderSides(analysis.sides);
	const ops: BaseOp[] = [];
	for (const sideIndex of order) {
		const assignments = perSide[sideIndex];
		if (assignments.length === 0) continue;
		const side = analysis.sides[sideIndex];
		const where = buildCapturedKeyPredicate(view, side, sideIndex, captureRelationName);
		const statement: AST.UpdateStmt = {
			type: 'update',
			table: tableIdentifier(side.schema),
			// Synthesised collision-proof correlation name on the lowered per-side target
			// (mirrors the single-source spine): the base builder registers it as the
			// target's AliasedScope alias, so a `__vm_self.col` operand emitted by the
			// capture read-back / owning-strip qualifications above binds the outer target
			// row regardless of a user value subquery's own FROM.
			alias: SELF_ALIAS,
			assignments,
			where,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		ops.push({ table: side.table, op: 'update', statement });
	}

	// Materialize the null-extended rows: one insert per non-preserved side over the
	// captured partition (the affected rows whose non-preserved PK was captured null). The
	// matched UPDATE for the same side was already emitted by the per-side loop above (its
	// tag-allowance enforced there), so this only adds the create branch. § Outer Joins.
	for (const [sideIndex, cols] of nullExtendedBySide) {
		ops.push(buildNullExtendedInsert(ctx, view, analysis, sideIndex, cols, registerCapturedExpr!, stmt, captureRelationName));
	}

	// Existence-flip deletes (§ Existence columns): `set hasB = false` removes the matched
	// non-preserved rows — the captured-key EXISTS carries the capture's match-marker
	// conjunct (`buildCapturedKeyPredicate` on a non-preserved side), so a null-extended
	// capture row is excluded explicitly, not by its NULL key columns failing `=`. The
	// preserved side is untouched, so a deleted row reads back null-extended (`hasB` now
	// false).
	for (const sideIndex of existenceDeleteSides) {
		const side = analysis.sides[sideIndex];
		const where = buildCapturedKeyPredicate(view, side, sideIndex, captureRelationName);
		const statement: AST.DeleteStmt = {
			type: 'delete',
			table: tableIdentifier(side.schema),
			where,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		ops.push({ table: side.table, op: 'delete', statement });
	}

	if (ops.length === 0) {
		// No assignment routed (e.g. only computed columns) — caught above as
		// no-inverse, so this is unreachable; guard for safety.
		raiseMutationDiagnostic({
			reason: 'no-inverse',
			table: view.name,
			message: `cannot write through view '${view.name}': no writable base column targeted by the update`,
		});
	}
	return ops;
}

/**
 * Build the null-extended materialization INSERT for a non-preserved outer-join side:
 * `insert into <np> (<joinKey>, <set cols…>) select k.<jk>, min(k.<val…>) from __vmupd_keys k
 * where (k.m<np> is null or not k.m<np>) and k.<jk> is not null group by k.<jk>` (§ Outer
 * Joins — Updates). The `group by k.<jk>` de-dups per dangling join key so a shared missing
 * partner materializes exactly once (a fan-out of N preserved rows would otherwise
 * double-insert the partner PK); the value projections are `min` so each is single-valued
 * per group. It fires only for the affected rows the join null-extended — the capture's
 * match marker says "no partner" (invariant 2 of {@link MS_UPDATE_KEYS_CTE}; a real matched
 * partner keyed NULL keeps its marker true and is never re-materialized) — whose
 * preserved-side join key is non-null (a null key cannot seed a joinable row).
 * The new row carries the EC join key (so the preserved row joins it), the assigned
 * value(s) read from the same pre-mutation `__vmupd_keys` capture the matched UPDATE reads,
 * and base defaults for everything else; a NOT NULL base column without a default that no
 * value covers raises `null-extended-create-conflict`.
 *
 * Built as a pure AST `BaseOp` (an insert-from-select over `__vmupd_keys`, resolved by the
 * builder's `cteNodes` injection) — no new plan-node substrate: the existing
 * capture-materialize-then-drain machinery already supplies the pre-mutation partition.
 */
function buildNullExtendedInsert(
	_ctx: PlanningContext,
	view: MutableViewLike,
	analysis: JoinViewAnalysis,
	npSideIndex: number,
	cols: ReadonlyArray<{ baseColumn: string; valAlias: string }>,
	registerCapturedExpr: (key: string, expr: AST.Expression) => string,
	stmt: AST.UpdateStmt,
	captureRelationName: string = MS_UPDATE_KEYS_CTE,
): BaseOp {
	const npSide = analysis.sides[npSideIndex];
	const { npJoinColumn, preservedExpr } = outerJoinInsertKey(view, analysis, npSideIndex);
	const jkAlias = registerCapturedExpr(`nejk:${npSideIndex}`, preservedExpr);

	// Insert columns: the non-preserved join column (= the captured preserved-side join
	// value, so the preserved row joins the freshly materialized row) followed by each
	// assigned base column (= its captured value). The join column is threaded once.
	//
	// De-dup per dangling join key: a `group by k.<jkAlias>` collapses the N preserved rows
	// that share one missing partner to a single materialized row (else N rows projecting the
	// same join key would each insert the partner PK → `UNIQUE constraint failed`). The join
	// column projection IS the GROUP BY key (bare); each value column is wrapped in `min` so
	// it is single-valued per group — a no-op for a constant / np-only SET, a deterministic
	// pick for a value that differs per preserved row (mirrors the matched read-back's `min`).
	const targetColumns: string[] = [npJoinColumn];
	const projections: AST.ResultColumn[] = [
		{ type: 'column', expr: { type: 'column', name: jkAlias, table: 'k' }, alias: npJoinColumn },
	];
	const joinColLower = npJoinColumn.toLowerCase();
	for (const c of cols) {
		if (c.baseColumn.toLowerCase() === joinColLower) continue; // join column already threaded
		targetColumns.push(c.baseColumn);
		projections.push({ type: 'column', expr: { type: 'function', name: 'min', args: [{ type: 'column', name: c.valAlias, table: 'k' }] }, alias: c.baseColumn });
	}
	assertNullExtendedInsertCovered(view, npSide.schema, targetColumns);

	// Restrict to the null-extended partition: the capture's match marker says this side
	// had NO join partner (invariant 2 of MS_UPDATE_KEYS_CTE — never "every captured PK
	// column is null", which a real matched partner keyed NULL would satisfy too; a NULL
	// marker reads as false), and the preserved join key is non-null (a null key has no
	// joinable row to create).
	const conds: AST.Expression[] = [matchFlagIsFalse(npSideIndex)];
	conds.push({ type: 'unary', operator: 'IS NOT NULL', expr: { type: 'column', name: jkAlias, table: 'k' } } as AST.UnaryExpr);
	const where = conds.reduce((acc, c) => combineAnd(acc, c)!);

	const select: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ type: 'table', table: { type: 'identifier', name: captureRelationName }, alias: 'k' }],
		where,
		groupBy: [{ type: 'column', name: jkAlias, table: 'k' }],
	};
	const statement: AST.InsertStmt = {
		type: 'insert',
		table: tableIdentifier(npSide.schema),
		columns: targetColumns,
		source: select,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: npSide.table, op: 'insert', statement };
}

/**
 * The non-preserved side's join column + the preserved partner's join value for the
 * null-extended materialization insert. Walks the join's cross-side equalities
 * ({@link collectCrossSideEqualities}) for one connecting the non-preserved side to a
 * PRESERVED side: the non-preserved column is set to the preserved value, so the
 * materialized row joins back to the preserved row. A non-preserved side related to no
 * preserved side by an equi-join key cannot be materialized with a joinable key — rejected
 * `unsupported-outer-join-update`.
 *
 * Only a **single-column** join key is materializable: the insert threads exactly one
 * non-preserved join column, so a composite key (the non-preserved side equated on more
 * than one distinct column) would leave the extra predicate(s) unsatisfied — the freshly
 * inserted row would NOT join back to the preserved row (a silent non-join leaving a stray
 * unreachable row), so it is rejected `unsupported-outer-join-update`. Mirrors the
 * inner-join insert envelope's single-column shared-key restriction
 * ({@link extractJoinKeyColumns}); the matched-update branch (keyed on the full np PK) is
 * unaffected, but the whole non-preserved update rejects at plan time since the create
 * branch cannot be expressed (the conservative, data-independent precedent of
 * {@link assertNullExtendedInsertCovered}).
 */
function outerJoinInsertKey(
	view: MutableViewLike,
	analysis: JoinViewAnalysis,
	npSideIndex: number,
): { npJoinColumn: string; preservedExpr: AST.Expression } {
	const eqs = collectCrossSideEqualities(analysis.sel.from!, analysis.sides);
	// Every cross-side equality the non-preserved side participates in (its own column +
	// the partner side/column it is equated to).
	const npEqs = eqs.flatMap(eq => {
		if (eq.sideA === npSideIndex) return [{ npCol: eq.colA, partnerSide: eq.sideB, partnerCol: eq.colB }];
		if (eq.sideB === npSideIndex) return [{ npCol: eq.colB, partnerSide: eq.sideA, partnerCol: eq.colA }];
		return [];
	});
	// Reject a composite join key (the np side equated on >1 distinct column): the
	// single-column materialization insert cannot satisfy the extra predicate(s), so the
	// new row would not join back (a silent non-join). Distinct by np column name — the
	// same np column equated to several partners (a 3-way shared key) still threads once.
	const distinctNpCols = new Set(npEqs.map(e => e.npCol.toLowerCase()));
	if (distinctNpCols.size > 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-outer-join-update',
			table: view.name,
			message: `cannot write through view '${view.name}': the non-preserved side (base table '${analysis.sides[npSideIndex].schema.name}') is related to the join by a composite key (${[...distinctNpCols].join(', ')}); a null-extended row can only be materialized through a single-column join key`,
		});
	}
	const match = npEqs.find(e => analysis.sides[e.partnerSide].preserved);
	if (match) {
		return {
			npJoinColumn: match.npCol,
			preservedExpr: { type: 'column', name: match.partnerCol, table: analysis.sides[match.partnerSide].alias },
		};
	}
	return raiseMutationDiagnostic({
		reason: 'unsupported-outer-join-update',
		table: view.name,
		message: `cannot write through view '${view.name}': the non-preserved side (base table '${analysis.sides[npSideIndex].schema.name}') is not related to a preserved side by an equi-join key, so a null-extended row cannot be materialized with a joinable key`,
	});
}

/**
 * Reject a NOT NULL base column on the non-preserved side that the null-extended
 * materialization insert leaves unset (no default, no covering value) — the row cannot be
 * created. Mirrors {@link assertNoMissingNotNull} but raises `null-extended-create-conflict`
 * (the outer-join create-side diagnostic), distinguishing a missing materialization value
 * from an ordinary insert's missing column.
 */
function assertNullExtendedInsertCovered(view: MutableViewLike, schema: TableSchema, covered: readonly string[]): void {
	const set = new Set(covered.map(c => c.toLowerCase()));
	for (const col of schema.columns) {
		if (col.generated || !col.notNull || col.defaultValue !== null) continue;
		if (set.has(col.name.toLowerCase())) continue;
		raiseMutationDiagnostic({
			reason: 'null-extended-create-conflict',
			column: col.name,
			table: view.name,
			message: `cannot update through view '${view.name}': materializing a null-extended row on base table '${schema.name}' would leave NOT NULL column '${col.name}' (no default) unset, so the non-preserved-side row cannot be created`,
		});
	}
}

/**
 * The **preserved** side indices — the DELETE candidate set (§ Outer Joins —
 * Deletes: "deleting from the preserved side is the only way for the joined row to
 * disappear from the view"). For an inner join every side is preserved, so this is the
 * full set `0..n-1`. For a LEFT/RIGHT outer join it is the single
 * preserved side. A `full` outer join has *no* preserved side; the caller falls back to
 * the full candidate set there (every side is both preserved and non-preserved).
 */
function preservedSideIndices(sides: readonly JoinSide[]): number[] {
	return sides.flatMap((s, i) => s.preserved ? [i] : []);
}

/**
 * The correlated EXISTS identifying predicate a per-side base op routes on:
 * `exists (select 1 from __vmupd_keys k where k.k<side>_0 = <pk0> [and k.k<side>_1 =
 * <pk1> …])` — matching ALL of the side's PK columns (composite keys included) against
 * the up-front materialized key set (the both-sides-assigned UPDATE path, every
 * single-side update/delete, and the multi-side DELETE fan-out; see
 * {@link MS_UPDATE_KEYS_CTE}). Each per-column equality is NULL-safe when the key column
 * is declared nullable ({@link captureKeyEquality} — invariant 1), and a non-preserved
 * side additionally conjoins its match marker (`k.m<side>` — invariant 2) so only
 * MATCHED capture rows correlate. The right-hand `<pk_j>` are unqualified, so they bind to
 * the base op's own target table; `k.k<side>_<j>` reads the captured column. The builder
 * injects `__vmupd_keys` into the base op's planning `cteNodes` (resolving to the
 * context-backed key relation), so this is read by descriptor rather than re-querying
 * the join body. (EXISTS — not a row-value `IN` — to reuse the UPDATE RETURNING
 * re-query's correlation shape; one pattern.)
 */
function buildCapturedKeyPredicate(view: MutableViewLike, side: JoinSide, sideIndex: number, captureRelationName: string = MS_UPDATE_KEYS_CTE): AST.Expression {
	const keyCols = requireKeyColumns(view, side);
	const conds = keyCols.map((pk, j): AST.Expression => captureKeyEquality(
		{ type: 'column', name: keyColumnName(sideIndex, j), table: 'k' },
		{ type: 'column', name: pk.name },
		pk.nullable,
	));
	// A non-preserved (outer-join) side correlates only its MATCHED capture rows: the
	// capture's match marker (invariant 2 of MS_UPDATE_KEYS_CTE) is AND'd in, so a
	// null-extended capture row — whose captured key columns are NULL — cannot
	// NULL-safe-match a real partner row whose key genuinely holds NULL. A NULL marker
	// reads as false (the bare-column conjunct is not-true for NULL).
	if (!side.preserved) {
		conds.push({ type: 'column', name: matchFlagName(sideIndex), table: 'k' });
	}
	return {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: captureRelationName }, alias: 'k' }],
			where: conds.reduce((acc, c) => combineAnd(acc, c)!),
		},
	};
}

// --- identity capture (shared by both-sides UPDATE / multi-side DELETE base ops + UPDATE RETURNING) ---

/**
 * The up-front base-PK identity capture for a multi-source (n-way inner-join) UPDATE or
 * multi-side DELETE fan-out (docs/vu-operators.md § Inner Join; docs/view-updateability.md § `returning`).
 * Built ONCE and shared between the per-side base ops' identifying subqueries and (for
 * an UPDATE with RETURNING) the RETURNING re-query.
 *
 *  - `source`: the capture SELECT `select s0.pk0 as k0_0[, s0.pk1 as k0_1], s1.pk0 as
 *    k1_0, … from <body> where <idPredicate>` — the emitter materializes it into
 *    `rctx.tableContexts` under {@link descriptor} **before** any base op runs.
 *  - `descriptor`: the identity stitch shared between the materialized capture rows
 *    and every {@link InternalRecursiveCTERefNode} that reads them back.
 *  - `keyColumns`: the flattened `k<side>_<j>` column shape (one entry per requested
 *    side per PK column) each reader mints a key ref over — followed by one `m<side>`
 *    match marker per captured non-preserved side ({@link matchFlagName}) and any
 *    `srcN` captured-value projections.
 *  - `relationName`: the AST relation name this capture is injected under in `cteNodes`
 *    (and that every base-op predicate reads back via `from <relationName> k`). Absent ⇒
 *    {@link MS_UPDATE_KEYS_CTE} — the standalone multi-source / decomposition / set-op /
 *    CTE-self-read paths all use the shared default. A **nested** capture mints a fresh
 *    name so two captures can coexist by name in one lowered statement
 *    (`set-op-write-multisource-leg-compose`): the inner per-branch capture's readers and
 *    its injected ref agree on the fresh name while shadowing nothing under the default.
 */
export interface MultiSourceKeyCapture {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
	readonly keyColumns: readonly { readonly name: string; readonly type: ScalarType }[];
	readonly relationName?: string;
}

/**
 * Mint a context-backed key relation (`InternalRecursiveCTERefNode`) over a
 * capture's descriptor — what a multi-side base op's identifying `in`-subquery or
 * the RETURNING re-query's EXISTS scans `__vmupd_keys` through. Fresh attribute ids
 * per call (each ref lives in its own subtree); the **descriptor** identity is what
 * ties it to the rows the emitter materializes.
 *
 * `captureRelationName` is used for BOTH the node's display CTE name and every
 * attribute's `sourceRelation`, so a half-updated node can never keep the constant as
 * `sourceRelation` while the caller injects under a fresh name. It defaults to the
 * capture's own {@link MultiSourceKeyCapture.relationName} (falling back to
 * {@link MS_UPDATE_KEYS_CTE}), so a ref minted from a fresh-named capture is
 * self-consistent without the caller re-passing the name.
 */
export function makeMultiSourceKeyRef(
	scope: Scope,
	capture: MultiSourceKeyCapture,
	captureRelationName: string = capture.relationName ?? MS_UPDATE_KEYS_CTE,
): InternalRecursiveCTERefNode {
	const keyAttrs: Attribute[] = capture.keyColumns.map(c => ({
		id: PlanNode.nextAttrId(),
		name: c.name,
		type: c.type,
		sourceRelation: captureRelationName,
	}));
	const keyRelType: RelationType = {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false,
		columns: capture.keyColumns.map(c => ({ name: c.name, type: c.type })),
		keys: [],
		rowConstraints: [],
	};
	return new InternalRecursiveCTERefNode(scope, captureRelationName, keyAttrs, keyRelType, capture.descriptor);
}

/**
 * A planning context with `capture` injected into `cteNodes` under its relation name (the
 * capture's {@link MultiSourceKeyCapture.relationName}, defaulting to {@link MS_UPDATE_KEYS_CTE}),
 * so a base op's / inner capture's `from <relationName> k` reference resolves to the capture's
 * context-backed key relation (over the shared capture descriptor). The injected ref's own
 * name is pinned to the SAME `relationName` so the map key and the ref agree — a nested capture
 * injects under its fresh `__vmupd_keys$N` name while shadowing nothing under the default. A
 * fresh ref per call keeps each consumer's subtree from sharing a node instance.
 *
 * Shared by the multi-source UPDATE/DELETE builder (`view-mutation-builder.ts`) and the set-op
 * join-leg compose (`set-op.ts`, which injects the OUTER set-op capture so an inner per-branch
 * capture's `memberExists` filter resolves against it).
 */
export function withKeyCapture(ctx: PlanningContext, capture: MultiSourceKeyCapture): PlanningContext {
	const cteNodes = new Map(ctx.cteNodes ?? []);
	const relationName = capture.relationName ?? MS_UPDATE_KEYS_CTE;
	cteNodes.set(relationName, makeMultiSourceKeyRef(ctx.scope, capture, relationName));
	return { ...ctx, cteNodes };
}

/**
 * The distinct join-side indices the emitted base ops target (each base op carries the
 * planned side's `TableReferenceNode`), sorted ascending — the sides whose PKs the capture
 * must project so each op's `select k<side> from <relationName>` resolves. Shared by the
 * standalone multi-source UPDATE/DELETE builder (`view-mutation-builder.ts`) and the set-op
 * join-leg compose (`set-op.ts`), which each pass it straight to
 * {@link buildMultiSourceKeyCapture}.
 */
export function capturedSideIndices(baseOps: readonly BaseOp[], analysis: JoinViewAnalysis): number[] {
	const set = new Set<number>();
	for (const op of baseOps) {
		const i = analysis.sides.findIndex(s => s.table.id === op.table.id);
		if (i >= 0) set.add(i);
	}
	return [...set].sort((a, b) => a - b);
}

/** True when the `TableReferenceNode` with plan-node id `tableId` sits anywhere beneath `node`. */
function subtreeContainsTable(node: PlanNode, tableId: number): boolean {
	if (node instanceof TableReferenceNode) return Number(node.id) === tableId;
	return node.getRelations().some(child => subtreeContainsTable(child, tableId));
}

/**
 * Rebuild the capture's join tree with one synthetic {@link ExistenceColumnSpec} match
 * flag per requested non-preserved side (invariant 2 of {@link MS_UPDATE_KEYS_CTE}).
 * Each flag is appended at the **nearest enclosing join that null-extends its side** —
 * the join whose non-preserved child subtree contains the side's table — so the flag's
 * value is the actual null-extension decision for that side (`runtime/emit/join.ts`
 * sets it from the match bit, never from a re-evaluation of the ON predicate). For an
 * n-way body the ancestors are rebuilt around the flagged join; a flag minted below an
 * enclosing outer join is itself nullable-widened by the parent's attribute rebuild
 * (readers treat NULL as false). Attribute identity is preserved throughout: the
 * children are reused verbatim and only the `JoinNode` wrappers are re-created, with
 * each flag carrying a freshly minted stable attribute id.
 *
 * NOTE: a flag-bearing join is pinned to the nested-loop emitter (the existence-flag
 * guards disable physical join selection), so an outer-join write's capture forgoes
 * hash/merge join. The capture materializes once per statement; if outer-join view
 * writes over large bodies ever show up as slow, teach the physical joins to emit
 * match flags rather than weakening the guards.
 */
function rebuildJoinWithMatchFlags(
	view: MutableViewLike,
	root: JoinNode,
	sides: readonly JoinSide[],
	npSideIndices: readonly number[],
): { joinNode: JoinNode; flagsBySide: ReadonlyMap<number, ExistenceColumnSpec> } {
	const flagsBySide = new Map<number, ExistenceColumnSpec>();
	// Post-order: inner joins rebuild first, so each side is claimed at the NEAREST
	// join that null-extends it (a nested outer join claims before its ancestors).
	const rebuild = (node: RelationalPlanNode): RelationalPlanNode => {
		if (!(node instanceof JoinNode)) return node;
		const newLeft = rebuild(node.left) as RelationalPlanNode;
		const newRight = rebuild(node.right) as RelationalPlanNode;
		const nullExtends = (child: 'left' | 'right'): boolean =>
			(node.joinType === 'left' && child === 'right')
			|| (node.joinType === 'right' && child === 'left')
			|| node.joinType === 'full';
		const newSpecs: ExistenceColumnSpec[] = [];
		for (const i of npSideIndices) {
			if (flagsBySide.has(i)) continue;
			const tableId = Number(sides[i].table.id);
			const child = subtreeContainsTable(node.left, tableId) ? 'left'
				: subtreeContainsTable(node.right, tableId) ? 'right'
				: undefined;
			if (!child || !nullExtends(child)) continue;
			const spec: ExistenceColumnSpec = { attrId: PlanNode.nextAttrId(), name: matchFlagName(i), side: child };
			flagsBySide.set(i, spec);
			newSpecs.push(spec);
		}
		if (newLeft === node.left && newRight === node.right && newSpecs.length === 0) return node;
		return new JoinNode(
			node.scope, newLeft, newRight, node.joinType, node.condition,
			node.usingColumns, [...(node.existence ?? []), ...newSpecs],
		);
	};
	const rebuilt = rebuild(root) as JoinNode;
	// A non-preserved side is, by collectJoinSources' classification, null-extended by
	// SOME enclosing outer join — a missing claim means the planned tree and the AST
	// classification disagree.
	for (const i of npSideIndices) {
		if (!flagsBySide.has(i)) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `internal: cannot write through view '${view.name}': non-preserved side '${sides[i].schema.name}' did not resolve to a null-extending join for its match marker`,
			});
		}
	}
	return { joinNode: rebuilt, flagsBySide };
}

/**
 * Build the up-front identity capture: each affected view row's base-PK identities,
 * by the same identifying predicate the base ops route on (user WHERE → base ∧ body
 * WHERE). Built as **plan nodes directly over the ALREADY-planned join body**
 * (`analysis.joinNode` + `analysis.joinScope`) — `Project_{k<side>_<j>}(Filter_{idPred}
 * (joinNode))` — instead of re-planning a cloned AST FROM, so the body is planned
 * ONCE (§ Round-Trip Laws and the Derived Backward Walk). `preserveInputColumns=false`
 * ⇒ the materialized rows are exactly the requested key columns, positionally aligned
 * to the `k<side>_<j>` columns every reader scans back (`keyColumns` and the projection
 * derive from the same `sideIndices` order; a composite-PK side contributes one column
 * per PK column).
 *
 * `sideIndices` selects which sides' PKs to capture (each requires ≥1 PK column via
 * {@link requireKeyColumns}; a keyless side is rejected with `unsupported-join`). The
 * builder passes exactly the sides whose base ops read the capture (plus all sides, for
 * an UPDATE with RETURNING whose EXISTS correlates the full joined row), so a single-
 * side write never forces a PK on an untouched side.
 *
 * Op-agnostic: takes the user `where` directly (an UPDATE's or a DELETE's) — the
 * identifying predicate is the same either way.
 *
 * `captureRelationName` is the AST relation name the resulting capture is injected
 * under (and that the base-op predicates `decomposeUpdate`/`decomposeDelete` emit read
 * back); it is stamped onto the returned {@link MultiSourceKeyCapture.relationName} so
 * downstream injection/RETURNING read it from the capture object rather than
 * re-deriving the literal. Defaults to {@link MS_UPDATE_KEYS_CTE} — the standalone
 * multi-source path is byte-identical; a nested capture passes a fresh name.
 */
export function buildMultiSourceKeyCapture(
	ctx: PlanningContext,
	view: MutableViewLike,
	where: AST.Expression | undefined,
	analysis: JoinViewAnalysis,
	sideIndices: readonly number[],
	sourceValues?: readonly CrossSourceValue[],
	captureRelationName: string = MS_UPDATE_KEYS_CTE,
): MultiSourceKeyCapture {
	// The identifying predicate (user WHERE → base terms ∧ the body's own WHERE), built
	// as a ScalarPlanNode over the planned join body's own scope — the exact scope
	// `buildSelectStmt` resolved the body against. The body WHERE is conjoined
	// explicitly (the source is the raw `joinNode`, before the body's σ), so the
	// captured set is byte-identical to the retired re-plan over the cloned FROM.
	const idPredicateAst = buildIdentifyingPredicate(ctx, analysis, where, view);
	const predicate = idPredicateAst
		? buildExpression({ ...ctx, scope: analysis.joinScope }, idPredicateAst)
		: undefined;

	// Match markers (invariant 2 of MS_UPDATE_KEYS_CTE): the capture — and ONLY the
	// capture — reads the join through a rebuilt copy carrying one synthetic
	// `ExistenceColumnSpec` per captured non-preserved side, so "did this side have a
	// join partner" is materialized explicitly (set by the join runtime from the actual
	// null-extension decision) instead of being inferred from NULL key columns. The
	// rebuild preserves every pre-existing attribute id (`buildJoinAttributes` copies
	// the child attributes verbatim), so `analysis.joinScope` still resolves the
	// identifying predicate and PK projections against it; the RETURNING re-query keeps
	// reading `analysis.joinNode` unchanged and reads `k.m<side>` out of the capture.
	// An all-preserved (inner-join) capture rebuilds nothing — byte-identical shape.
	const npSideIndices = sideIndices.filter(i => !analysis.sides[i].preserved);
	const { joinNode: captureJoin, flagsBySide } = npSideIndices.length > 0
		? rebuildJoinWithMatchFlags(view, analysis.joinNode, analysis.sides, npSideIndices)
		: { joinNode: analysis.joinNode, flagsBySide: new Map<number, ExistenceColumnSpec>() };

	const filtered: RelationalPlanNode = predicate
		? new FilterNode(analysis.joinScope, captureJoin, predicate)
		: captureJoin;

	// One capture column per requested side per PK column: `k<side>_<j>`. A composite-PK
	// side projects all its PK columns; the readers' EXISTS correlate on the same set.
	const keyColumns: { name: string; type: ScalarType }[] = [];
	const projections: Projection[] = [];
	for (const i of sideIndices) {
		const side = analysis.sides[i];
		const pkCols = requireKeyColumns(view, side);
		pkCols.forEach((pk, j) => {
			const name = keyColumnName(i, j);
			keyColumns.push({ name, type: columnSchemaToScalarType(columnByName(side.schema, pk.name)) });
			projections.push({
				node: buildExpression({ ...ctx, scope: analysis.joinScope }, { type: 'column', name: pk.name, table: side.alias }),
				alias: name,
			});
		});
	}

	// Project each non-preserved side's match marker as a capture column (`m<side>`),
	// referenced directly by the flag's own attribute id — the scope knows nothing of the
	// synthetic flags. The attribute's type is read off the rebuilt join (nullable-widened
	// when an enclosing outer join can null-extend the flag itself; readers treat NULL as
	// false).
	if (npSideIndices.length > 0) {
		const captureAttrs = captureJoin.getAttributes();
		for (const i of npSideIndices) {
			const spec = flagsBySide.get(i)!;
			const columnIndex = captureAttrs.findIndex(a => a.id === spec.attrId);
			const flagType = captureAttrs[columnIndex].type;
			const name = matchFlagName(i);
			keyColumns.push({ name, type: flagType });
			projections.push({
				node: new ColumnReferenceNode(analysis.joinScope, { type: 'column', name }, flagType, spec.attrId, columnIndex),
				alias: name,
			});
		}
	}

	// Cross-source SET read values: project each partner base column the SET reads under
	// its stable `srcN` alias (over the same join-body scope), so every per-side base op's
	// correlated `select srcN from __vmupd_keys k where …` reads the captured pre-mutation
	// value. Appended AFTER the per-side PK columns, positionally aligned with the readers'
	// `keyColumns` (which are pushed in the same order).
	for (const sv of sourceValues ?? []) {
		const node = buildExpression({ ...ctx, scope: analysis.joinScope }, sv.expr);
		keyColumns.push({ name: sv.alias, type: node.getType() });
		projections.push({ node, alias: sv.alias });
	}

	const source = new ProjectNode(analysis.joinScope, filtered, projections, undefined, undefined, false);

	return { source, descriptor: {}, keyColumns, relationName: captureRelationName };
}

/**
 * Build the post-mutation RETURNING re-query for a multi-source UPDATE
 * (docs/view-updateability.md § `returning`). A re-query that matched by the *user
 * predicate* cannot recapture a row whose predicate column the update itself
 * rewrote (the changed row no longer matches), so this matches by the captured
 * **identity** instead: project the view-spelled, base-term RETURNING columns over
 * the post-mutation join body, restricted to the captured identities by a correlated
 * `exists (select 1 from __vmupd_keys k where <per-side identity>)` — so a row the
 * update pushed *out* of the view's filter (or whose predicate column it rewrote) is
 * still returned (single-source NEW semantics). It keeps only the structural join
 * ON-condition; the body/user WHERE is intentionally NOT re-applied.
 *
 * The per-side identity is **preserved-keyed**: a preserved side matches by per-PK-column
 * equality (`k.k<p>_<j> = s<p>.pk<j>`, NULL-safe per nullable key column —
 * {@link captureKeyEquality}), while a non-preserved (outer-join null-extended) side uses
 * a matched-OR-no-partner disjunction `(AND_j k.k<np>_<j> ≈ s<np>.pk<j>) OR (k.m<np> is
 * false-or-null)` keyed off the capture's **match marker** ({@link matchFlagName}). This
 * re-keys the re-query off the **stable preserved-side identity** so a freshly-materialized
 * null-extended row (whose marker was captured false) surfaces via its preserved-side
 * equalities alone, rather than being silently dropped by a `NULL = <minted pk>` match.
 * For an all-preserved (inner) join every side is plain equality over its NOT NULL key
 * columns — byte-identical to the prior behavior, so inner-join RETURNING is unchanged.
 *
 * Reads the shared {@link MultiSourceKeyCapture} the builder materializes
 * before the base ops fire (via its own freshly-minted key ref over the same
 * descriptor). The capture covers ALL sides for an UPDATE with RETURNING, so this
 * correlates the full joined row's identity.
 */
export function buildMultiSourceUpdateReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.UpdateStmt,
	capture: MultiSourceKeyCapture,
	analysis: JoinViewAnalysis,
): RelationalPlanNode {
	const returningCols = stmt.returning!;

	// Restrict the POST-mutation join body to the captured identities, built as plan
	// nodes over the ALREADY-planned `joinNode` (its structural ON-condition only —
	// the body/user WHERE is intentionally NOT re-applied) — no AST re-plan of the
	// body. The EXISTS subquery resolves `__vmupd_keys` via `cteNodes` to a fresh key
	// ref over the shared capture descriptor; `s<side>.pk<j>` correlate to the outer
	// join row through `joinScope`.
	//
	// The per-side identity predicate is AND'd over all sides:
	//  - a **preserved** side keys by per-PK-column equality (`AND_j k.k<side>_<j> =
	//    s<side>.pk<j>`, NULL-safe when the column is declared nullable) — its PK is
	//    stable across the mutation and uniquely identifies the view row (the premise
	//    that makes a non-preserved column updatable at all);
	//  - a **non-preserved** (outer-join null-extended) side keys by a matched-OR-no-
	//    partner disjunction `(AND_j k.k<np>_<j> ≈ s<np>.pk<j>) OR (k.m<np> is null or
	//    not k.m<np>)`.
	//
	// A *matched* capture row (marker true) takes the matched branch and finds the
	// stable np row (NULL-safe per nullable key column, so a partner genuinely keyed
	// NULL is still found); its no-partner branch is false. A *materialized
	// null-extended* capture row (marker false — it had no pre-mutation partner) takes
	// the no-partner branch, so it is identified by the preserved-side equalities ALONE
	// — surfacing the freshly-minted partner row (and a preserved-side update touching
	// a still-null-extended row, the latent partial-set bug #2). The marker — not "the
	// captured np PK is all NULL", which a real partner keyed NULL would satisfy too —
	// is what partitions the two branches (invariant 2 of MS_UPDATE_KEYS_CTE); a NULL
	// marker reads as false.
	const sideConds = analysis.sides.map((side, sideIndex): AST.Expression => {
		const pkCols = requireKeyColumns(view, side);
		const exact = pkCols.map((pk, j): AST.Expression => captureKeyEquality(
			{ type: 'column', name: keyColumnName(sideIndex, j), table: 'k' },
			{ type: 'column', name: pk.name, table: side.alias },
			pk.nullable,
		)).reduce((acc, c) => combineAnd(acc, c)!);
		if (side.preserved) return exact;
		// No-partner branch: the capture's match marker says this non-preserved side had
		// no pre-mutation join partner, so the row is identified by the preserved sides'
		// equalities alone.
		return { type: 'binary', operator: 'OR', left: exact, right: matchFlagIsFalse(sideIndex) } as AST.BinaryExpr;
	});
	// Read the capture's own relation name so a fresh-named capture's RETURNING re-query
	// reads back from (and injects under) the same relation its base ops do — the constant
	// is only the default the standalone path stamps.
	const captureRelationName = capture.relationName ?? MS_UPDATE_KEYS_CTE;
	const keyRef = makeMultiSourceKeyRef(ctx.scope, capture, captureRelationName);
	const existsPredicateAst: AST.Expression = {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: captureRelationName }, alias: 'k' }],
			where: sideConds.reduce((acc, c) => combineAnd(acc, c)!),
		},
	};
	const cteNodes = new Map(ctx.cteNodes ?? []);
	cteNodes.set(captureRelationName, keyRef);
	const existsNode = buildExpression({ ...ctx, scope: analysis.joinScope, cteNodes }, existsPredicateAst);
	const filtered = new FilterNode(analysis.joinScope, analysis.joinNode, existsNode);

	// Project the view-spelled, base-term RETURNING columns over the filtered join.
	return buildMultiSourceReturningProjection(ctx, view, analysis, filtered, returningCols);
}

/**
 * Build the multi-source RETURNING projection over a `filtered` join relation: lower
 * each RETURNING result column to its view-spelled, base-term form
 * ({@link buildReturningProjection}) and project it as a `ScalarPlanNode` over the
 * input through `analysis.joinScope`. `preserveInputColumns=false` ⇒ the output is
 * exactly the RETURNING columns. Shared by the UPDATE re-query (filter = the
 * post-mutation EXISTS-over-capture join) and the DELETE re-query (filter = the
 * pre-mutation identifying predicate over the raw join), which differ only in the
 * `filtered` input relation they pass.
 */
function buildMultiSourceReturningProjection(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: JoinViewAnalysis,
	filtered: RelationalPlanNode,
	returningCols: readonly AST.ResultColumn[],
): RelationalPlanNode {
	const projections: Projection[] = buildReturningProjection(ctx, view, analysis, returningCols).map((rc): Projection => {
		const col = rc as AST.ResultColumnExpr;
		return {
			node: buildExpression({ ...ctx, scope: analysis.joinScope }, col.expr),
			alias: col.alias,
		};
	});
	return new ProjectNode(analysis.joinScope, filtered, projections, undefined, undefined, false);
}

/**
 * Lower a multi-source UPDATE's RETURNING result columns to base terms over the
 * join body, preserving the **view spelling** of each output column. A bare view-
 * column ref substitutes to its base term aliased to the column's written spelling
 * (so a renamed view col `eid`→base `id` still surfaces as `eid`); a computed
 * RETURNING expression has its nested view-column refs substituted; `returning *`
 * expands to every view output column's base term aliased to its display name.
 */
function buildReturningProjection(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: JoinViewAnalysis,
	returningCols: readonly AST.ResultColumn[],
): AST.ResultColumn[] {
	const out: AST.ResultColumn[] = [];
	for (const rc of returningCols) {
		if (rc.type === 'all') {
			assertReturningStarQualifier(rc.table, view.name);
			for (const col of analysis.outColumns) {
				const baseExpr = analysis.viewColToBaseRef.get(col.name);
				if (!baseExpr) {
					raiseMutationDiagnostic({
						reason: 'returning-through-view',
						table: view.name,
						message: `cannot expand 'returning *' through view '${view.name}': no base term for column '${col.displayName}'`,
					});
				}
				out.push({ type: 'column', expr: cloneExpr(baseExpr), alias: col.displayName });
			}
		} else {
			// Scope guard: a top-level RETURNING reference must name a view column —
			// otherwise it would pass through `substituteViewColumns` unmapped and
			// re-bind against a base table in the re-query's join body (the same leak
			// the where/set guard closes). Parity with the single-source RETURNING guard.
			guardTopLevelScope(rc.expr, analysis, view);
			const substituted = substituteViewColumns(ctx, rc.expr, analysis.viewColToBaseRef, view, analysis.sides);
			// Preserve the user's view spelling as the output name: an explicit alias
			// wins; a bare column ref keeps its own name; otherwise leave it unnamed.
			const alias = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined);
			out.push({ type: 'column', expr: substituted, alias });
		}
	}
	return out;
}

// --- DELETE ---------------------------------------------------------------

/**
 * Build the pre-mutation RETURNING re-query for a multi-source DELETE
 * (docs/view-updateability.md § `returning`). The OLD view image of the rows about
 * to vanish: project the view-spelled, base-term RETURNING columns over the raw
 * `analysis.joinNode` restricted to the identifying predicate (user WHERE → base ∧
 * body WHERE — the same predicate the key capture and base ops route on). Captured
 * `pre` (before the base ops fire) so it reads the live base tables through the join.
 *
 * Building the projection in **base terms** (rather than referencing the planned
 * body `root`'s output attribute ids) is what fixes a computed view column: a
 * computed column has no surviving intermediate attribute id after project-merge, so
 * a by-id reference dangles — recomputing from base columns has nothing fragile to
 * reference. Mirrors {@link buildMultiSourceUpdateReturning}; they differ only in the
 * filter + timing.
 */
export function buildMultiSourceDeleteReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.DeleteStmt,
	analysis: JoinViewAnalysis,
): RelationalPlanNode {
	const idPredicateAst = buildIdentifyingPredicate(ctx, analysis, stmt.where, view);
	const predicate = idPredicateAst
		? buildExpression({ ...ctx, scope: analysis.joinScope }, idPredicateAst)
		: undefined;
	const filtered: RelationalPlanNode = predicate
		? new FilterNode(analysis.joinScope, analysis.joinNode, predicate)
		: analysis.joinNode;
	return buildMultiSourceReturningProjection(ctx, view, analysis, filtered, stmt.returning!);
}

export function decomposeDelete(_ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.DeleteStmt, captureRelationName: string = MS_UPDATE_KEYS_CTE): BaseOp[] {
	// RETURNING through a multi-source delete is supported via a re-query of the
	// planned view body captured *before* the base delete fires (the builder); the
	// base op itself carries no RETURNING.

	// Scope guard: top-level `where` references must name view columns (parity with
	// the single-source spine).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);

	const sides = chooseDeleteSides(view, analysis);

	// Every base delete (single-side and multi-side fan-out alike) reads its
	// identifying values from the up-front identity capture the builder materializes
	// ONCE before any base op fires (a correlated EXISTS over `__vmupd_keys` matching
	// the side's PK columns), a mutation-order-independent set built from the
	// ALREADY-planned join body. So the first side's delete cannot empty the join out
	// from under a later side's identifying set (the predicate-honest multi-side
	// fan-out), and a single-side delete — having no ordering hazard — reads the same
	// pre-mutation set it would have re-queried live. (No live re-query of a re-planned
	// AST body.)

	// Order the base deletes. The **two-side fan-out over a 2-table join** orders by ON
	// DELETE action so the side whose removal clears the other's reference runs first
	// (`orderDeleteFanout`); a mutual FK whose actions no side order can satisfy under
	// immediate enforcement raises `mutual-fk-restrict-delete` at plan time — but ONLY
	// when the join provably correlates a mutual FK edge (the joined rows necessarily
	// cross-reference, so a RESTRICT necessarily fires). When the join correlates neither
	// edge (e.g. a join on non-FK columns), the schema-only reject is a data-independent
	// over-rejection: fall back to the fixed `[0, 1]` fan-out and defer to the runtime
	// RESTRICT pre-check (`runtime/foreign-key-actions.ts`) on the actual data.
	//
	// This plan-time mutual-FK analysis is **deliberately NOT generalized past two
	// sides** (§ Out of scope): an n-way (>2) delete uses the **reverse** FK-topological
	// order (FK-child before FK-parent) over the chosen sides — the FK-safe delete
	// direction — and defers any mutual-FK cycle wholesale to the runtime RESTRICT
	// pre-check. A single-side delete has no ordering hazard, so it keeps its trivial
	// order.
	let order: readonly number[];
	if (analysis.sides.length === 2 && sides.length === 2) {
		const fanoutOrder = orderDeleteFanout(analysis.sides);
		if (fanoutOrder === undefined) {
			if (joinCorrelatesMutualFk(analysis)) {
				const [a, b] = analysis.sides;
				raiseMutationDiagnostic({
					reason: 'mutual-fk-restrict-delete',
					table: view.name,
					message: `cannot delete through view '${view.name}': the joined row spans a mutual foreign key ('${a.schema.name}'↔'${b.schema.name}') whose ON DELETE actions cannot be satisfied in either order under immediate FK enforcement (deleting either side trips the other's RESTRICT, directly or transitively through a cascade); break the cycle outside the view — null out the referencing column(s) first, or restructure the offending ON DELETE action — before deleting through the view (a 'deferrable initially deferred' declaration does not help: RESTRICT is enforced immediately regardless)`,
				});
			}
			// No mutual FK edge is correlated by the join — defer to the runtime
			// RESTRICT pre-check on the real data via the fixed fan-out order.
			order = [0, 1];
		} else {
			order = fanoutOrder;
		}
	} else {
		// Single side, or an n-way (>2) fan-out. Delete in **reverse** FK-topological
		// order — FK-CHILD before FK-parent — so a child's referencing row is gone before
		// its parent row is deleted (the canonical columnar-split shape: each member's PK
		// references the anchor's). The forward (parent-first) order trips the parent's
		// inbound RESTRICT/NO-ACTION under immediate FK enforcement and aborts the whole
		// statement. Child-first is unconditionally FK-safe (deleting a referencing row
		// never trips a constraint on the referenced row, for any ON DELETE action), so it
		// is the right default for both RESTRICT and CASCADE; a mutual-FK cycle still
		// defers wholesale to the runtime RESTRICT pre-check. A single-side delete reverses
		// a one-element order (a no-op). The eager up-front key capture makes the order
		// purely an FK-enforcement concern — identity is fixed before any op fires.
		order = orderSides(analysis.sides).filter(i => sides.includes(i)).reverse();
	}
	const ops: BaseOp[] = [];
	for (const sideIndex of order) {
		const side = analysis.sides[sideIndex];
		const where = buildCapturedKeyPredicate(view, side, sideIndex, captureRelationName);
		const statement: AST.DeleteStmt = {
			type: 'delete',
			table: tableIdentifier(side.schema),
			where,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		ops.push({ table: side.table, op: 'delete', statement });
	}
	return ops;
}

/**
 * Pick the base side(s) a join delete routes to (§ Inner Join — Deletes). Deleting
 * one side of an inner equi-join already removes the joined row from the view, so the
 * common case resolves to a single side; the maximal-lenient case fans out to every
 * candidate side ("make this joined row not exist"). Returns 1 or more sides.
 *
 * The routing is **predicate/FK truth only** — there is no tag override (the routing
 * tags were removed; a per-row presence/membership column, e.g. the outer-join
 * existence column, expresses any non-default side explicitly):
 * 1. The candidate set is the **preserved** side(s) — deleting a preserved side is the
 *    only way the joined row leaves the view (§ Outer Joins — Deletes). An inner join
 *    is all-preserved; a `full` outer join has no preserved side, so its delete defers.
 * 2. If a foreign key proves the FK-many (child) side, that single side (deleting the
 *    child leaves the parent — the documented FK-style default; the FK resolves the
 *    ambiguity, so it is NOT a fan-out).
 * 3. Otherwise the deletion side is ambiguous and the (hardwired) lenient default
 *    **fans out to every candidate side** — the predicate-honest multi-side delete
 *    (see {@link decomposeDelete}'s eager key capture).
 */
function chooseDeleteSides(view: MutableViewLike, analysis: JoinViewAnalysis): number[] {
	// The candidate set is the **preserved** side(s) — deleting the preserved side is
	// the only way the joined row leaves the view (§ Outer Joins — Deletes). Inner
	// joins are all-preserved (⇒ the full set). A `full` outer join has no preserved
	// side (each side is both preserved and non-preserved per row), so a
	// statically-routed delete is not expressible — defer it.
	const candidates = preservedSideIndices(analysis.sides);
	if (candidates.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot delete through view '${view.name}': a FULL outer join has no preserved side to route the delete to (each side is both preserved and non-preserved per row); deleting through a full-outer view is deferred`,
		});
	}

	if (candidates.length === 1) return candidates;

	// A provable FK-child side resolves the ambiguity to that single side (deleting the
	// child leaves the parent). `fkChildIndex` is binary, so for an n-way (>2) join it
	// is undefined and the delete fans out.
	const childIndex = fkChildIndex(analysis.sides);
	if (childIndex !== undefined && candidates.includes(childIndex)) return [childIndex];

	// ≥2 residual candidates + no provable single-direction FK-child default: fan out to
	// every candidate side (the hardwired lenient, predicate-honest multi-side delete).
	return candidates;
}

// --- predicate / subquery construction ------------------------------------

/**
 * The combined base-term identifying predicate: the user's WHERE (rewritten from
 * view columns to base terms) conjoined with the view body's own WHERE (already
 * in base terms). Either may be absent.
 */
function buildIdentifyingPredicate(
	ctx: PlanningContext,
	analysis: JoinViewAnalysis,
	userWhere: AST.Expression | undefined,
	view: MutableViewLike,
): AST.Expression | undefined {
	const userBase = userWhere ? substituteViewColumns(ctx, userWhere, analysis.viewColToBaseRef, view, analysis.sides) : undefined;
	const bodyWhere = analysis.sel.where ? cloneExpr(analysis.sel.where) : undefined;
	return combineAnd(userBase, bodyWhere);
}

/**
 * Substitute references to view columns (unqualified, or qualified by the view's
 * own name) with their base-term replacement expression. References already
 * qualified by a base alias are left untouched. A view-column reference nested
 * inside a `subquery` / `exists` / `in`-subquery operand is rewritten too, via
 * the scope-aware {@link makeViewColumnDescend} descent.
 *
 * Every injected replacement is **side-alias-qualified** ({@link
 * makeSideQualifyScope}, threaded both into the top-level substitution and as the
 * descent's `baseQualify`). A body may legally project a partner column BARE
 * (`select c.cid as cid, cval, pv from c join p …` — `pv` unambiguous across the
 * sides), so its lineage leaf arrives unqualified, and an unqualified leaf emitted
 * inside a subquery operand would re-bind, by innermost-scope SQL rules, to a
 * same-named column of that subquery's own FROM instead of the join body — the
 * multi-source analog of the single-source correlation-qualification of
 * substituted terms (`makeBaseQualifier`). Qualifying at injection keeps every
 * scope decision in this walk: downstream, the qualifier strip
 * ({@link stripSideQualifier}) is qualifier-driven, and a bare leaf reaching it is
 * only ever a user-authored local/unknown name. The strip is **alias-scope-aware**
 * for the converse case this pass does not cover — a *user-authored*
 * alias-qualified ref whose qualifier collides with a side alias/table name but is
 * shadowed by an inner value-subquery's own FROM alias is left subquery-local there
 * (these injected lineage leaves carry side aliases a user subquery would not reuse,
 * so they are never the shadowed ones).
 */
function substituteViewColumns(
	ctx: PlanningContext,
	expr: AST.Expression,
	viewColToBaseRef: ReadonlyMap<string, AST.Expression>,
	view: MutableViewLike,
	sides: readonly JoinSide[],
): AST.Expression {
	const viewName = view.name.toLowerCase();
	const sideQualifyScope = makeSideQualifyScope(sides, view);
	const sideQualify = (repl: AST.Expression): AST.Expression => transformScopedExpr(ctx, sideQualifyScope, repl);
	const descend = makeViewColumnDescend(ctx, viewColToBaseRef, view.name, view, sideQualify);
	return transformExpr(expr, (col) => {
		if (col.table && col.table.toLowerCase() !== viewName) return undefined;
		const repl = viewColToBaseRef.get(col.name.toLowerCase());
		return repl ? sideQualify(repl) : undefined;
	}, descend);
}

/**
 * The {@link ScopeContext} that side-alias-qualifies a substituted base-term
 * lineage expression at injection time — the multi-source analog of the
 * single-source `makeBaseQualifyScope` (docs/vu-operators.md § Inner Join,
 * docs/view-updateability.md cross-source `set`). A bare, non-shadowed leaf is resolved by **unique column
 * ownership** across the join sides ({@link resolveColumnSide}, the exact rule
 * join-condition operands use) and qualified with the owning side's **alias** —
 * never the table name, so a self-join's distinct aliases stay distinct. A name
 * on NO side is a lineage-internal correlated/local name and stays bare; a name
 * on 2+ sides resolves to `undefined`, but such a bare body projection
 * (`select av …` with `av` on both sides) is already rejected as ambiguous at
 * body planning (analyzeBodyLineage → buildSelectStmt), so for genuine lineage
 * leaves that branch is unreachable — the bare pass-through serves only the
 * no-side case. Shadowing within the lineage's own nested subqueries is handled
 * by the shared scoped descent (a lineage term `(select x from oth where fk =
 * cid)` qualifies only its correlation ref `cid`; `x`/`fk`, shadowed by `oth`,
 * stay local).
 *
 * An unresolvable nested scope is **rejected** rather than tainted (matching
 * `makeBaseQualifyScope`): shadowing cannot be proven, so the term could over- or
 * under-qualify into a silent wrong write.
 */
function makeSideQualifyScope(sides: readonly JoinSide[], view: MutableViewLike): ScopeContext {
	return {
		makeSubstitute: (shadowed) => (col) => {
			if (col.table) return undefined;
			if (shadowed.has(col.name.toLowerCase())) return undefined;
			const side = resolveColumnSide(col, sides);
			if (side === undefined) return undefined;
			return { ...col, table: sides[side].alias };
		},
		unresolvableScope: 'reject',
		rejectUnresolvableScope: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			table: view.name,
			message: `cannot write through view '${view.name}': a view column's base-term lineage contains a correlated subquery whose source columns are not statically resolvable (a 'select *' / table-valued function / unresolved source), so its correlation cannot be proven; restructure the view body`,
		}),
		rejectDmlSubquery: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			table: view.name,
			message: `cannot write through view '${view.name}': a data-modifying subquery (INSERT/UPDATE/DELETE) within a view column's base-term lineage cannot be analysed`,
		}),
	};
}

/**
 * Rewrite the owning side's alias qualifier on a base-term assignment value to the lowered
 * UPDATE's `__vm_self` correlation alias ({@link SELF_ALIAS}), so it binds the single-table
 * UPDATE's target row directly even when nested in a user value subquery whose own FROM
 * carries a same-named column. A reference to **any other side** cannot
 * be expressed as a single-table SET, so it is either captured-and-rewritten (when a
 * `registerCrossSource` carrier is supplied — § Inner Join, cross-source `set`) or
 * rejected (`cross-source-assignment`, the legacy path). The strip is qualifier-driven
 * but **alias-scope-aware**: the route/strip decision reads a column's own table
 * qualifier, yet a qualifier shadowed by an inner value-subquery's FROM **alias** binds
 * to that inner source (innermost-scope SQL rules), so it is left local. The alias-shadow
 * set accumulates per nesting depth through the {@link transformAliasScopedExpr} descent
 * (the alias-only analog of the view-column descent's column-name shadowing); a nested
 * *owning*-side reference whose qualifier is NOT shadowed is still correlated to the
 * target row of the lowered UPDATE just like a top-level one.
 *
 * The **alias-shadow check fires first** (before the owning/other qualifier sets), so a
 * user-authored alias-qualified ref colliding with a side alias OR a side's table name
 * (`from things c` shadowing owning alias `c`; `from aux parent` shadowing a side's table
 * name `parent`) is left subquery-local — never stripped to bare, never mis-routed
 * through the capture. Injected base-term lineage leaves carry side aliases a user
 * subquery would not intentionally reuse, so they are never shadowed; the narrowing
 * affects only genuine user collisions.
 *
 * The owning-side qualifier set is checked **before** the other-side set, so a self-join
 * (where an `other` side shares the owning side's table name) still strips an owning-alias
 * reference; only a reference qualified by a *different alias* is the cross-source case.
 *
 * A **bare** leaf is left untouched — binding locally (a nested subquery's own FROM, or
 * the lowered single-table UPDATE's target) or failing loudly at build. The strip never
 * resolves a bare name against the view sides: every base-term lineage leaf was
 * side-alias-qualified when `substituteViewColumns` injected it
 * ({@link makeSideQualifyScope} — including a partner column the body projected bare, so
 * that read rides the qualified routing below at ANY non-shadowed nesting depth), and
 * resolving a bare name here would mis-route an inner-scope column whose name merely collides with a
 * partner base column (e.g. `(select psecret from t)` where the partner side also has a
 * `psecret`) to the partner's captured value.
 *
 * A cross-source read is rewritten to `(select <srcN> from __vmupd_keys k where
 * k.k<owningSide>_0 = __vm_self.<pk0> [and …])`: `registerCrossSource` projects the partner
 * column into the capture under `srcN` and returns the alias; the `<pk_j>` (qualified with
 * the lowered UPDATE's `__vm_self` correlation alias — {@link SELF_ALIAS}) bind to its own
 * target row, so each row reads the captured pre-mutation
 * partner value of its joined row. The cross-source gate (`gateCrossSourceReads`) has
 * already proved every reached partner column has `base` lineage.
 *
 * Before the rewrite, `gateCrossSourceCardinality` (when supplied) rejects the **1:many**
 * direction at plan time: the capture carries one `srcN` row per joined owner/partner pair,
 * so the correlated read-back is well-defined only when the owning side joins **at most one**
 * partner row ({@link ownerJoinsAtMostOnePartner}). Placed here — at the rewrite site — so it
 * covers a partner ref nested in a value subquery as well as a top-level one (both lower to
 * {@link capturedValueSubquery}).
 */
function stripSideQualifier(
	expr: AST.Expression,
	view: MutableViewLike,
	owning: JoinSide,
	owningSideIndex: number,
	allSides: readonly JoinSide[],
	registerCrossSource: ((col: AST.ColumnExpr) => string) | undefined,
	gateCrossSourceCardinality?: (partnerCol: AST.ColumnExpr) => void,
): AST.Expression {
	const owningQuals = new Set([owning.alias, owning.schema.name.toLowerCase()]);
	const otherQuals = new Set<string>();
	allSides.forEach((s, i) => {
		if (i === owningSideIndex) return;
		otherQuals.add(s.alias);
		otherQuals.add(s.schema.name.toLowerCase());
	});
	// The owning side's PK — the correlation a captured cross-source read binds on.
	// Resolved lazily (only a cross-source rewrite needs it).
	let owningPk: readonly KeyColumnInfo[] | undefined;
	// Route a partner-side base-column read through the up-front capture: project it into
	// `__vmupd_keys` under a stable `srcN` alias and rewrite the reference to a correlated
	// scalar read of it, keyed by the owning side's PK. Shared by the qualified-other branch
	// and the unqualified-partner branch (both lower identically; the `srcN` dedup key is
	// `<table>.<col>`, so a body mixing `a.av` and a partner-resolved bare `av` — qualified
	// here with the same alias — mints ONE capture column). Absent a capture carrier (the
	// legacy non-build path) reject `cross-source-assignment`.
	const routePartnerRead = (col: AST.ColumnExpr): AST.Expression => {
		if (!registerCrossSource) {
			raiseMutationDiagnostic({
				reason: 'cross-source-assignment',
				column: col.name,
				table: view.name,
				message: `cannot write through view '${view.name}': an update value references column '${col.name}' on a different base table than the column it assigns; cross-source assignment is not supported`,
			});
		}
		// Reject the 1:many direction at plan time before lowering to a (multi-valued)
		// correlated read of the capture (§ Inner Join, cross-source `set`).
		gateCrossSourceCardinality?.(col);
		const srcAlias = registerCrossSource(col);
		owningPk ??= requireKeyColumns(view, owning);
		// Qualify the owning-PK operands with the per-side UPDATE's collision-proof alias so
		// the read-back correlates to the target row even when this subquery nests inside a
		// user value subquery whose FROM has a same-named column (the bug-1 site).
		return capturedValueSubquery(srcAlias, owningSideIndex, owningPk, undefined, SELF_ALIAS);
	};
	// QUALIFIED-only substitution: an owning-alias ref is re-qualified to the lowered
	// target's `__vm_self` correlation alias; a partner-alias ref
	// routes through the capture; a BARE ref is left untouched (only ever a user-authored
	// local/unknown name — every lineage leaf arrives side-alias-qualified; see the
	// docstring). The route/strip decision is qualifier-driven but ALIAS-SCOPE-AWARE: a
	// qualifier shadowed by an inner value-subquery FROM alias (`aliasShadow`) binds to that
	// inner source by innermost-scope SQL rules, so it is left local — checked BEFORE the
	// side-qualifier sets, so an owning-/partner-/table-name collision with an inner alias
	// never strips or routes. Injected lineage leaves carry side aliases a user subquery
	// would not reuse, so they are never shadowed; only a user-authored alias-qualified ref
	// colliding with a side alias/table name is affected. The alias set accumulates per
	// nesting depth via `transformAliasScopedExpr` (mirrors the view-column descent's
	// column-name shadowing); at the top level it is empty, so behaviour is byte-identical
	// for every non-colliding statement.
	const substitute = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined => {
		if (!col.table) return undefined;
		const t = col.table.toLowerCase();
		if (aliasShadow.has(t)) return undefined;
		// Qualify the stripped owning ref with the per-side UPDATE's collision-proof alias
		// rather than emitting a bare column: a bare base-name ref nested in a user value
		// subquery whose FROM carries that base name would re-bind locally (the bug-2 site).
		if (owningQuals.has(t)) return { type: 'column', name: col.name, table: SELF_ALIAS };
		if (otherQuals.has(t)) return routePartnerRead(col);
		return undefined;
	};
	return transformAliasScopedExpr(expr, substitute);
}

/**
 * The correlated scalar read a cross-source SET value lowers to:
 * `(select <srcAlias> from __vmupd_keys k where k.k<owningSide>_0 = <pk0> [and …])`
 * — `<srcAlias>` is the capture projection of the partner base column; the unqualified
 * `<pk_j>` bind to the lowered UPDATE's own target row (the owning side), matching the
 * per-side identifying EXISTS so each target row reads the captured pre-mutation partner
 * value of its joined row. Composite owning keys conjoin one equality per PK column.
 *
 * `dedupAggregate` wraps the projection in that aggregate (`min(k.<srcAlias>)`) so the
 * correlated read is single-valued even when the owning PK matches MORE THAN ONE capture
 * row — the non-preserved-side fan-out case, where N preserved rows share one non-preserved
 * partner so its PK matches all N captures (§ Outer Joins). For a constant / np-only SET the
 * captured value is identical across the group so `min` is an exact no-op de-dup; for a
 * value that genuinely differs per preserved row it resolves the ambiguity deterministically
 * rather than erroring at runtime. The cross-source `set` callers leave it off (their gate
 * already proves at-most-one partner), keeping the bare-column form byte-identical.
 *
 * `correlationAlias` qualifies each owning-PK right operand (`<pk_j>` → `<alias>.<pk_j>`).
 * When this read-back nests inside a user value subquery whose own FROM introduces a
 * column named like the owning PK, a **bare** `<pk_j>` would re-bind to that inner column
 * by innermost-scope SQL rules (keying the read-back on the wrong value); qualifying it with
 * the lowered per-side UPDATE's collision-proof alias ({@link SELF_ALIAS}) binds the outer
 * target row instead. The multi-source per-side callers pass `SELF_ALIAS`; `decomposition.ts`
 * and any caller that omits it keep the bare form (byte-identical — composite keys still
 * qualify every conjunct only when supplied).
 *
 * `captureRelationName` is the relation the correlated read scans (`from <name> k`); it
 * defaults to {@link MS_UPDATE_KEYS_CTE} so the standalone multi-source and decomposition
 * callers are byte-identical, while a nested multi-source capture threads its fresh name.
 *
 * Correlation is NULL-safe per nullable owning-PK column ({@link captureKeyEquality} —
 * invariant 1 of {@link MS_UPDATE_KEYS_CTE}); `matchedOnly` additionally restricts the
 * read to matched capture rows via the owning side's match marker (invariant 2) — the
 * non-preserved matched read-back passes it so a null-extended capture row cannot
 * pollute the aggregate for a target row keyed NULL.
 */
export function capturedValueSubquery(srcAlias: string, owningSideIndex: number, owningPk: readonly KeyColumnInfo[], dedupAggregate?: string, correlationAlias?: string, captureRelationName: string = MS_UPDATE_KEYS_CTE, matchedOnly = false): AST.Expression {
	const conds = owningPk.map((pk, j): AST.Expression => captureKeyEquality(
		{ type: 'column', name: keyColumnName(owningSideIndex, j), table: 'k' },
		correlationAlias ? { type: 'column', name: pk.name, table: correlationAlias } : { type: 'column', name: pk.name },
		pk.nullable,
	));
	// `matchedOnly`: restrict the read to MATCHED capture rows via the owning side's
	// match marker (the non-preserved matched read-back). Without it, a null-extended
	// capture row — key columns all NULL — would NULL-safe-match a target row whose key
	// genuinely holds NULL and pollute the aggregate with the null-extended branch's value.
	if (matchedOnly) {
		conds.push({ type: 'column', name: matchFlagName(owningSideIndex), table: 'k' });
	}
	const colRef: AST.ColumnExpr = { type: 'column', name: srcAlias, table: 'k' };
	const projection: AST.Expression = dedupAggregate
		? { type: 'function', name: dedupAggregate, args: [colRef] }
		: colRef;
	return {
		type: 'subquery',
		query: {
			type: 'select',
			columns: [{ type: 'column', expr: projection }],
			from: [{ type: 'table', table: { type: 'identifier', name: captureRelationName }, alias: 'k' }],
			where: conds.reduce((acc, c) => combineAnd(acc, c)!),
		},
	};
}

/**
 * Reject a cross-source value read whose partner-side view column is **not** `base`
 * (computed / non-invertible) — its value is not recoverable from a captured base
 * column, so the cross-source rewrite cannot carry it (`no-inverse`; an outer-join
 * `null-extended` partner is already rejected wholesale upstream). A same-side read (the
 * column reads only the assigned side) is left to the qualifier strip; a `base` partner
 * column is admitted and captured. Walks only the value's top-level column references
 * (the scope `guardTopLevelScope` already proved are view columns); a reference nested in
 * a value subquery is left to the qualifier strip's per-leaf handling.
 *
 * Known asymmetry (deliberate, conservative): because this walks top level only, a
 * computed partner read nested in a value subquery is *admitted* via the per-leaf
 * capture — which is value-correct (leaves captured pre-mutation, scalar applied on
 * read) — while the same read at the top level is rejected here. `no-inverse` is only
 * a hard requirement for a computed column as an assignment *target*; admitting the
 * top-level read through the same capture is the intended unification, pending an
 * audit of mixed owning/partner leaves under an owning-site inverse. See
 * docs/view-updateability.md § cross-source `set` values.
 */
function gateCrossSourceReads(value: AST.Expression, owningSideIndex: number, analysis: JoinViewAnalysis, view: MutableViewLike): void {
	forEachTopLevelColumnRef(value, (col) => {
		const vco = analysis.outColumns.find(c => c.name === col.name.toLowerCase());
		if (!vco) return; // guardTopLevelScope already proved top-level refs are view columns
		const readSides = viewColumnReadSides(vco, analysis);
		const crossSource = [...readSides].some(s => s !== owningSideIndex);
		if (crossSource && !vco.writable) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: vco.displayName,
				table: view.name,
				message: `cannot write through view '${view.name}': the update value reads computed column '${vco.displayName}' on a different base table than the column it assigns; a cross-source read requires the partner column to have base lineage`,
			});
		}
	});
}

/**
 * The set of join-side indices a view column's value reads. A `base` site reads only
 * its owning side; a computed site reads every side its base-term expression's column
 * leaves resolve to (so a same-side computed read stays admissible while a cross-source
 * computed read is rejected).
 */
function viewColumnReadSides(vco: OutColumn, analysis: JoinViewAnalysis): Set<number> {
	if (vco.writable && vco.sideIndex !== undefined) return new Set([vco.sideIndex]);
	const sides = new Set<number>();
	const expr = analysis.viewColToBaseRef.get(vco.name);
	if (expr) {
		forEachColumnRefDeep(expr, (col) => {
			const s = resolveColumnSide(col, analysis.sides);
			if (s !== undefined) sides.add(s);
		});
	}
	return sides;
}

/** Observe every TOP-LEVEL column reference in an expression (no subquery descent). */
function forEachTopLevelColumnRef(expr: AST.Expression, fn: (col: AST.ColumnExpr) => void): void {
	transformExpr(expr, (col) => { fn(col); return undefined; });
}

/** Observe every column reference in an expression, descending into subqueries. */
function forEachColumnRefDeep(expr: AST.Expression, fn: (col: AST.ColumnExpr) => void): void {
	const observe = (col: AST.ColumnExpr): AST.Expression | undefined => { fn(col); return undefined; };
	transformExpr(expr, observe, (q) => mapQueryExprUniform(q, observe));
}

// --- helpers --------------------------------------------------------------

function tableIdentifier(table: TableSchema): AST.IdentifierExpr {
	return { type: 'identifier', name: table.name, schema: table.schemaName };
}

/**
 * The boolean value of a literal existence-flag assignment (`set hasB = true|false`), or
 * `undefined` for any non-literal / non-boolean value — a per-row branch on the *written*
 * value is deferred (§ Existence columns, v1). Accepts the boolean literals `true`/`false`
 * and the numeric `1`/`0` spellings (integers lower to `bigint` here).
 */
function asBooleanLiteral(expr: AST.Expression): boolean | undefined {
	if (expr.type !== 'literal') return undefined;
	const v = expr.value;
	if (v === true || v === false) return v;
	if (v === 1 || v === 1n) return true;
	if (v === 0 || v === 0n) return false;
	return undefined;
}

/**
 * The side's primary-key columns (≥1), in declaration order, each carrying its
 * **declared nullability** — the per-side identifying key the capture projects and
 * the base ops' EXISTS correlates on, NULL-safely per nullable column
 * ({@link captureKeyEquality}). Composite keys are admitted (each PK column
 * contributes a `k<side>_<j>` capture column); a keyless table is the only reject
 * (`unsupported-join`).
 */
function requireKeyColumns(view: MutableViewLike, side: JoinSide): KeyColumnInfo[] {
	const pk = side.schema.primaryKeyDefinition;
	if (pk.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': base table '${side.schema.name}' has no primary key; multi-source identifying predicates need a key`,
		});
	}
	return pk.map(def => {
		const col = side.schema.columns[def.index];
		return { name: col.name, nullable: !col.notNull };
	});
}

/**
 * True when `fk` (declared on `child`) targets `parent` — the shared FK-match
 * predicate: case-insensitive `referencedTable` against the parent's name, with an
 * absent `referencedSchema` defaulting to the child's own schema. The single source
 * of truth for "does this declared FK reference that side", reused by
 * {@link fkChildIndex}, {@link inboundDeleteAction}, and {@link edgeCorrelated}.
 */
function fkTargetsSide(fk: ForeignKeyConstraintSchema, child: JoinSide, parent: JoinSide): boolean {
	return fk.referencedTable.toLowerCase() === parent.schema.name.toLowerCase()
		&& (fk.referencedSchema ?? child.schema.schemaName).toLowerCase() === parent.schema.schemaName.toLowerCase();
}

/** True when `child` declares any foreign key onto `parent`. */
function sideDeclaresFkOnto(child: JoinSide, parent: JoinSide): boolean {
	return (child.schema.foreignKeys ?? []).some(fk => fkTargetsSide(fk, child, parent));
}

/**
 * Index of the FK-child (many) side of a **two-side** join: the side declaring a
 * foreign key onto the other. `undefined` when no FK is provable, both sides reference
 * each other (mutual), or the join is not two-sided (the binary FK-child concept does
 * not generalize past two sides — the n-way delete fan-out / `orderSides` topo sort
 * handle >2). Used by the two-side delete routing ({@link chooseDeleteSides}).
 */
function fkChildIndex(sides: readonly JoinSide[]): number | undefined {
	if (sides.length !== 2) return undefined;
	const zeroRefsOne = sideDeclaresFkOnto(sides[0], sides[1]);
	const oneRefsZero = sideDeclaresFkOnto(sides[1], sides[0]);
	if (zeroRefsOne && !oneRefsZero) return 0;
	if (oneRefsZero && !zeroRefsOne) return 1;
	return undefined;
}

/**
 * Side execution order: an FK **topological sort** over the n sides — every FK-parent
 * precedes its FK-child — stable by source order within an FK-equivalence class. A
 * mutual FK (each side referencing the other, e.g. a self-join's two aliases of one
 * self-referencing table) forms a cycle with no zero-in-degree head; it is broken by
 * lowest source index, i.e. it falls back to **alias-declaration order** (§ Cycles,
 * Self-Joins). The two-side binary order (`[parent, child]` / `[0, 1]`) is the n=2
 * specialization of this.
 */
function orderSides(sides: readonly JoinSide[]): number[] {
	const n = sides.length;
	// parents[child] = set of side indices the child must follow (its declared FK parents).
	const parents: Array<Set<number>> = sides.map(() => new Set<number>());
	for (let child = 0; child < n; child++) {
		for (let parent = 0; parent < n; parent++) {
			if (child !== parent && sideDeclaresFkOnto(sides[child], sides[parent])) parents[child].add(parent);
		}
	}
	const placed = new Set<number>();
	const order: number[] = [];
	while (order.length < n) {
		// Lowest-index unplaced side all of whose (non-self, unplaced-cycle-aside) parents
		// are already placed.
		let pick = -1;
		for (let i = 0; i < n; i++) {
			if (placed.has(i)) continue;
			if ([...parents[i]].every(p => placed.has(p))) { pick = i; break; }
		}
		// A cycle (mutual FK) leaves no ready node — break it by lowest unplaced index
		// (source / alias-declaration order).
		if (pick === -1) {
			for (let i = 0; i < n; i++) if (!placed.has(i)) { pick = i; break; }
		}
		order.push(pick);
		placed.add(pick);
	}
	return order;
}

/**
 * The governing ON DELETE action of FK(s) declared on `child` that reference
 * `parent` — i.e. the action that fires when a `parent` row is deleted. When more
 * than one such FK runs between the same ordered pair, the **most-blocking** action
 * governs (immediate enforcement fires every referencing FK): `restrict` over
 * `cascade` over `setNull`/`setDefault` over absent (`undefined` — no FK on `child`
 * references `parent`). Mirrors the FK-match predicate in {@link fkChildIndex} (same
 * `referencedTable` / `referencedSchema` comparison).
 */
function inboundDeleteAction(child: JoinSide, parent: JoinSide): AST.ForeignKeyAction | undefined {
	let governing: AST.ForeignKeyAction | undefined;
	for (const fk of child.schema.foreignKeys ?? []) {
		if (!fkTargetsSide(fk, child, parent)) continue;
		if (fk.onDelete === 'restrict') return 'restrict';        // most-blocking — governs outright
		if (fk.onDelete === 'cascade') governing = 'cascade';
		else if (governing !== 'cascade') governing = fk.onDelete;  // setNull / setDefault, unless a cascade already won
	}
	return governing;
}

/**
 * True when deleting side `X` first (then the other side `Y`) does **not** abort
 * under immediate FK enforcement + the transitive RESTRICT pre-walk
 * (`runtime/foreign-key-actions.ts` `assertTransitiveRestrictsForParentMutation`).
 * `inboundX` governs deleting X (the action of the FK referencing X); `inboundY`
 * governs deleting Y. Deleting X first is feasible iff X carries no inbound
 * reference, or its inbound action *clears* Y's reference without tripping a RESTRICT:
 *  - `inboundX` absent — nothing references X, so its delete is unconstrained;
 *  - `inboundX ∈ {setNull, setDefault}` — Y's reference is cleared (no cascade, no RESTRICT);
 *  - `inboundX === cascade` **and** `inboundY !== restrict` — the cascade into Y does
 *    not recurse into a RESTRICT (Y's only inbound child here is X, the root, via `inboundY`).
 * `inboundX === restrict` ⇒ Y still references X ⇒ NOT deletable-first.
 */
function deletableFirst(inboundX: AST.ForeignKeyAction | undefined, inboundY: AST.ForeignKeyAction | undefined): boolean {
	if (inboundX === undefined) return true;
	if (inboundX === 'setNull' || inboundX === 'setDefault') return true;
	return inboundX === 'cascade' && inboundY !== 'restrict';
}

/**
 * The feasible base-delete order for the two-side DELETE fan-out, or `undefined`
 * when a mutual FK's ON DELETE actions cannot be satisfied in *any* order under
 * immediate enforcement (the caller raises `mutual-fk-restrict-delete`). Reached
 * only at `fkChildIndex(sides) === undefined` (no FK either way, or a mutual FK): a
 * no-FK pair has both inbound actions absent ⇒ side0 deletable-first ⇒ `[0, 1]`
 * (unchanged); a both-cascade mutual FK likewise keeps `[0, 1]`. Prefers `[0, 1]`
 * when side0 is deletable-first so the no-FK / symmetric paths stay order-stable.
 */
function orderDeleteFanout(sides: readonly JoinSide[]): readonly number[] | undefined {
	const inbound0 = inboundDeleteAction(sides[1], sides[0]); // governs deleting side0
	const inbound1 = inboundDeleteAction(sides[0], sides[1]); // governs deleting side1
	if (deletableFirst(inbound0, inbound1)) return [0, 1];
	if (deletableFirst(inbound1, inbound0)) return [1, 0];
	return undefined;
}

/**
 * Canonical (order-independent) key for a cross-side column equality, so a join
 * conjunct written either way (`b.aref = a.aid` or `a.aid = b.aref`) hashes the
 * same and an edge lookup need not know which operand the join named first.
 */
function crossEqualityKey(sideA: number, colA: string, sideB: number, colB: string): string {
	const a = `${sideA}:${colA.toLowerCase()}`;
	const b = `${sideB}:${colB.toLowerCase()}`;
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Resolve a join-condition column operand to its owning side index (`0..n-1`), or
 * `undefined` when the reference cannot be pinned to exactly one side. An explicit
 * `.table` qualifier matches a side's `alias` (already lowercased) or `schema.name`
 * (alias preferred, so a self-join's distinct aliases resolve unambiguously even
 * though the table names collide); an unqualified ref resolves by **unique** ownership
 * of `col.name` across the sides' columns. An ambiguous / unresolved ref returns
 * `undefined` (conservative — a term that cannot be placed cannot prove correlation).
 */
function resolveColumnSide(col: AST.ColumnExpr, sides: readonly JoinSide[]): number | undefined {
	const qualifier = col.table?.toLowerCase();
	if (qualifier !== undefined) {
		const idx = sides.findIndex(s => s.alias === qualifier || s.schema.name.toLowerCase() === qualifier);
		return idx < 0 ? undefined : idx;
	}
	const colName = col.name.toLowerCase();
	const owners = sides.flatMap((s, i) => s.schema.columns.some(c => c.name.toLowerCase() === colName) ? [i] : []);
	return owners.length === 1 ? owners[0] : undefined;
}

/**
 * True when the **owning** side (the side a cross-source `set` assigns) provably joins
 * **at most one** row of the **partner** side (the side the SET value reads), across the
 * view's join — the cardinality proof that makes a cross-source `set` value well-defined
 * (§ Inner Join, cross-source `set`). The up-front `__vmupd_keys` capture carries one
 * `srcN` row per joined owner/partner pair, so the per-row correlated read-back
 * ({@link capturedValueSubquery}) is single-valued only when the owning side joins at most
 * one partner. The **reverse** (1:many) direction returns multiple `srcN` rows for a fixed
 * owner PK and would fail at runtime with the generic `Scalar subquery returned more than
 * one row`; the caller rejects it at plan time instead with a diagnostic that names the
 * cross-source ambiguity.
 *
 * The proof: collect the join's **direct** owner↔partner `column = column` equalities
 * ({@link collectCrossSideEqualities} already walks every nested ON predicate and USING
 * list across the n-way tree), gather the **partner-side** columns they pin, and check
 * whether some **unique key** of the partner table is a subset of that pinned set — fixing
 * each column of a unique key to a per-owner-row value admits ≤1 partner row. Partner
 * unique keys considered: the PRIMARY KEY; every **non-partial** UNIQUE constraint; every
 * **non-partial** UNIQUE index. A **partial** unique key (one carrying a `predicate`) does
 * not bound the rows outside its predicate scope, so it does not prove global at-most-one
 * and is NOT counted. NULL semantics need no special handling — a `=` join only matches
 * non-null equal values and a unique key bounds each non-null value to ≤1 row. That holds
 * even for a nullable key column (key membership does not imply NOT NULL — `docs/schema.md`
 * § Primary-key nullability): key equality is NULL-self-equal, so uniqueness over the pinned
 * non-null values is if anything stronger.
 *
 * This is the inverse of the FK-correlation reasoning {@link edgeCorrelated} the delete
 * path uses, but **FK is not required** — the proof is purely partner-side uniqueness (the
 * canonical FK-child-reads-parent case is subsumed: the FK references the parent's PK and
 * the join equates the child's FK column to it, so the parent's PK ⊆ the pinned set).
 * **Multi-hop / transitive** cross-source (owner and partner not directly joined) pins no
 * partner column ⇒ NOT proven ⇒ the caller rejects (conservative: this only over-rejects,
 * never falsely accepts; a transitive value-determinacy proof is a possible follow-up).
 */
function ownerJoinsAtMostOnePartner(
	ownerIdx: number,
	partnerIdx: number,
	sel: AST.SelectStmt,
	sides: readonly JoinSide[],
): boolean {
	const partner = sides[partnerIdx];
	// The partner-side columns the join pins equal to an owner-side value (lowercased).
	const partnerEquatedCols = new Set<string>();
	for (const eq of collectCrossSideEqualities(sel.from!, sides)) {
		if (eq.sideA === ownerIdx && eq.sideB === partnerIdx) partnerEquatedCols.add(eq.colB.toLowerCase());
		else if (eq.sideB === ownerIdx && eq.sideA === partnerIdx) partnerEquatedCols.add(eq.colA.toLowerCase());
	}
	if (partnerEquatedCols.size === 0) return false; // no direct owner↔partner equality — not proven (e.g. multi-hop)

	// A non-empty unique-key column set all of whose columns the join pins ⇒ ≤1 partner row.
	const provesAtMostOne = (cols: readonly string[]): boolean =>
		cols.length > 0 && cols.every(c => partnerEquatedCols.has(c.toLowerCase()));

	// The partner's PRIMARY KEY.
	const pkNames = partner.schema.primaryKeyDefinition.map(def => partner.schema.columns[def.index].name);
	if (provesAtMostOne(pkNames)) return true;

	// Non-partial UNIQUE constraints (a partial UNIQUE bounds uniqueness only within its predicate scope).
	for (const uc of partner.schema.uniqueConstraints ?? []) {
		if (uc.predicate) continue;
		if (provesAtMostOne(uc.columns.map(idx => partner.schema.columns[idx].name))) return true;
	}

	// Non-partial UNIQUE indexes (e.g. a CREATE UNIQUE INDEX not mirrored as a constraint).
	for (const idx of partner.schema.indexes ?? []) {
		if (!idx.unique || idx.predicate) continue;
		if (provesAtMostOne(idx.columns.map(c => partner.schema.columns[c.index].name))) return true;
	}

	return false;
}

/**
 * True when the FK on side `childIdx` referencing side `parentIdx` is **correlated**
 * by the join — i.e. the join's cross-side equalities force the child's FK column(s)
 * equal to the parent's referenced column(s) for *every* `(childCol, refCol)` pair,
 * so a joined partner necessarily references the deleted row (a RESTRICT necessarily
 * fires). Matches the same `referencedTable` / `referencedSchema` predicate as
 * {@link fkChildIndex}; any one matching FK whose whole column pairing is equated
 * makes the edge correlated.
 */
function edgeCorrelated(
	childIdx: number,
	parentIdx: number,
	crossEqualities: ReadonlySet<string>,
	sides: readonly JoinSide[],
): boolean {
	const child = sides[childIdx];
	const parent = sides[parentIdx];
	return (child.schema.foreignKeys ?? []).some(fk => {
		if (!fkTargetsSide(fk, child, parent)) return false;
		const refIndices = resolveReferencedColumns(fk, parent.schema);
		if (refIndices.length !== fk.columns.length) return false;
		return fk.columns.every((childColIdx, i) => {
			const childCol = child.schema.columns[childColIdx].name;
			const refCol = parent.schema.columns[refIndices[i]].name;
			return crossEqualities.has(crossEqualityKey(childIdx, childCol, parentIdx, refCol));
		});
	});
}

/**
 * Whether the view's join **provably correlates at least one mutual FK edge** — the
 * gate on the plan-time `mutual-fk-restrict-delete` reject (§ Inner Join — Deletes).
 * Reached only when {@link orderDeleteFanout} found no feasible order (a mutual FK
 * whose actions no order can satisfy). The two mutual edges mirror the
 * {@link fkChildIndex} match: edgeA = the FK on side0 referencing side1, edgeB = the
 * FK on side1 referencing side0. An edge is *correlated* when the join's cross-side
 * column equalities force that FK's child column(s) equal to the parent's referenced
 * column(s) — so the joined partner necessarily references the deleted row and a
 * RESTRICT necessarily fires.
 *
 * Cross-side equalities are collected from the join ON condition (`sel.from[0]` is the
 * single `join`) **and** the body WHERE, flattened on `AND`, keeping each conjunct
 * that is `column = column` with both operands resolving to *different* sides
 * ({@link resolveColumnSide}; an unresolved/ambiguous/same-side term is skipped —
 * conservatively, it cannot prove correlation).
 *
 * Returns `true` iff **at least one** edge is correlated. A non-FK join (or a join on
 * non-FK columns) correlates neither edge ⇒ `false`, and the caller falls back to the
 * fixed-order fan-out, deferring to the runtime RESTRICT pre-check on the real data.
 * This is a strict *reduction* of over-rejection, not perfect precision: a join that
 * correlates one edge whose *other* edge's FK columns happen to be NULL at delete time
 * is still rejected (indistinguishable at plan time from the (fo-h) data-referencing
 * shape — accepted residual conservatism).
 */
function joinCorrelatesMutualFk(analysis: JoinViewAnalysis): boolean {
	const conjuncts: AST.Expression[] = [];
	const join = analysis.sel.from?.[0];
	if (join && join.type === 'join' && join.condition) conjuncts.push(...flattenAnd(join.condition));
	if (analysis.sel.where) conjuncts.push(...flattenAnd(analysis.sel.where));

	const crossEqualities = new Set<string>();
	for (const conj of conjuncts) {
		if (conj.type !== 'binary' || conj.operator !== '=') continue;
		if (conj.left.type !== 'column' || conj.right.type !== 'column') continue;
		const leftSide = resolveColumnSide(conj.left, analysis.sides);
		const rightSide = resolveColumnSide(conj.right, analysis.sides);
		if (leftSide === undefined || rightSide === undefined || leftSide === rightSide) continue;
		crossEqualities.add(crossEqualityKey(leftSide, conj.left.name, rightSide, conj.right.name));
	}

	return edgeCorrelated(0, 1, crossEqualities, analysis.sides)
		|| edgeCorrelated(1, 0, crossEqualities, analysis.sides);
}

/**
 * RETURNING through a multi-source **insert** is not yet supported: it would need
 * the per-row minted shared surrogate threaded into the projected rows, which the
 * envelope materialization does not yet expose to a RETURNING projection. Reject
 * with a structured diagnostic (single- and multi-source update/delete RETURNING
 * are supported; see the builder).
 */
function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through a multi-source (join) insert into view '${view.name}' is not yet supported`,
		});
	}
}
