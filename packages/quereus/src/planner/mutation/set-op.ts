import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { ScalarType } from '../../common/datatype.js';
import type { SqlValue } from '../../common/types.js';
import type { CollationResolver } from '../../types/logical-type.js';
import { isRelationalNode, type RelationalPlanNode, type ScalarPlanNode, type ConstantBinding, type DomainConstraint } from '../nodes/plan-node.js';
import { checkSatisfiability, type SatResult } from '../analysis/sat-checker.js';
import { splitConjuncts } from '../analysis/predicate-conjuncts.js';
import { SetOperationNode } from '../nodes/set-operation-node.js';
import { buildSelectStmt } from '../building/select.js';
import { buildExpression } from '../building/expression.js';
import { FilterNode } from '../nodes/filter.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import { propagate, type BaseOp, type MutableViewLike, type MutationRequest } from './propagate.js';
import { MS_UPDATE_KEYS_CTE, isJoinBody, isInnerJoinBody, analyzeJoinView, analyzeMultiSourceInsert, decomposeUpdate, decomposeDelete, buildMultiSourceKeyCapture, capturedSideIndices, withKeyCapture, type MultiSourceKeyCapture, type JoinViewAnalysis } from './multi-source.js';
import { cloneExpr, transformExpr } from './scope-transform.js';
import { bodyPlanningContext } from './body-context.js';
import { unwrapPassthroughSubquery } from '../util/set-op-wrapper.js';

/**
 * Set-operation membership-column write decomposition — the **first set-op view
 * writability** in the engine (docs/vu-setops.md § Set-operation membership writes).
 *
 * The read half (`set-op-membership-read`) reifies a binary set operation's branch
 * provenance as first-class `existence`-sited boolean columns and, per row, computes
 * a runtime membership probe (`inA ≡ tuple ∈ A`). This module delivers the write
 * payoff: a membership column **is** the branch presence, and *writing* it drives the
 * branch's existence:
 *
 * ```sql
 * -- U = select id, x from A union exists left as inA, exists right as inB select id, x from B
 * update U set inB = true  where id = 3   -- a row in A only ⇒ INSERT it into B
 * update U set inB = false where id = 3   -- a row in B      ⇒ DELETE the matching B row
 * ```
 *
 * **The substrate (Halloween-safe via an up-front capture).** Every affected view
 * row — its data columns AND its membership-probe flags — is captured ONCE
 * (`buildSetOpCapture`), *before* any branch op fires, into the same context-backed
 * key relation the multi-source path uses ({@link MS_UPDATE_KEYS_CTE}). The per-branch
 * ops then read that immutable capture rather than re-scanning the view (which reads
 * the very branches being written), so a branch insert/delete can never perturb the
 * affected set out from under a sibling branch op. The capture rides the existing
 * `ViewMutationNode.identityCapture` side input + the void/drain runtime path — no new
 * runtime substrate (see `runtime/emit/view-mutation.ts`).
 *
 * **A branch is itself a view body — routed per-branch via recursive `propagate`.**
 * Each operand of the set operation is a relational sub-plan (`select … from B`). A
 * **single-source** branch's per-branch op is lowered to an AST `BaseOp` against a
 * **synthetic branch view-like** and run back through {@link propagate} — reusing the
 * single-source spine verbatim (the branch's own σ predicate, renames, and base routing are
 * honored by its spine).
 *
 * A **multi-source (INNER join) branch/leg** ({@link isInnerJoinBody}) is **composed** rather
 * than routed through plain {@link propagate} (`set-op-write-multisource-leg-compose`): plain
 * `propagate` builds NO capture, so its emitted multi-source predicates (`k<side>_<j>`) would
 * bind to the outer set-op capture (view-output columns) — the internal `k.k0_0 isn't a column`
 * error. Instead the fan builds the join branch itself (mirroring `buildViewMutation`'s
 * orchestration): {@link analyzeJoinView} + {@link decomposeUpdate}/{@link decomposeDelete} +
 * {@link buildMultiSourceKeyCapture} build an **inner per-branch base-PK capture** under a fresh
 * `__vmupd_keys$N` name (minted monotonically — two join branches never collide), filtered by the
 * SAME {@link buildMemberExists} predicate (so it scans the OUTER set-op capture), and bubble it
 * up on {@link SetOpWritePlan.nestedCaptures} (materialized outer-first then inner, via
 * `ViewMutationNode.nestedCaptures`). INSERT into a join branch is deferred to
 * `set-op-write-multisource-leg-insert` (needs the plan-level shared-surrogate envelope) — a clean
 * reject + `is_insertable_into = NO`; an OUTER (left/right/full) / cross / non-equi join leg is
 * likewise deferred (a clean classification reject). A branch that bottoms out in a base table emits one base op; a branch
 * that is itself a `SetOperationNode` (a **subtree operand**, `nestable-flagged-set-ops`)
 * recurses *here* for the unambiguous fan-out — a data-column UPDATE, a DELETE, and a
 * `set <subtreeFlag> = false` drop fan out to every member leaf, sharing the ONE up-front
 * capture (`fanBranchDataUpdate` / `fanBranchDelete`, detected via {@link analyzeSetOpBranches}).
 * A **union / union all** subtree fans freely (a leaf ⊆ the subtree). An **`except` /
 * `intersect`** subtree fan is **membership-gated** (`set-op-membership-nested-except`): a leaf
 * can hold rows the subtree excludes, so the recursion AND-s the captured subtree-membership
 * boundary flag (`exists <branch> as <flag>`) into each leaf's member-exists, restricting the
 * fan to genuine members — one conjunct per non-union boundary descended. A flag-less non-union
 * boundary has no boundary probe to gate on and stays deferred (rejected).
 * The genuinely ambiguous inserts into a subtree — `set <subtreeFlag> = true`, a
 * surfaced-inner-flag write, and insert-through routing into a subtree side — have no single
 * deterministic target leaf (product-coordinate addressing) and are rejected, pointing at
 * `set-op-membership-nested`.
 *
 * **A LEFT operand can be a subtree too** (`set-op-leftwrap-write`). A parenthesized LEFT
 * compound operand — `(A∪B) union[…] (C∪D)`, a *parallel-sibling* shape — is lifted by the parser
 * into a `select * from (A∪B) as values_N` passthrough wrapper so the SELECT-level `compound` slot
 * can host the outer operator. {@link buildBranch} **unwraps** that wrapper (via
 * {@link unwrapBranchSelect}, the same {@link unwrapPassthroughSubquery} predicate the read/plan
 * path uses) so the wrapped left operand is a first-class subtree operand — its data cols,
 * `isNested`, and fan-out recursion all derive from the inner compound, exactly as the
 * (always-direct) right compound operand. So the unambiguous fan-out (data UPDATE / DELETE /
 * `set <subtreeFlag> = false`) reaches the LEFT subtree's leaves, while the ambiguous inserts
 * into it stay deferred (`set-op-membership-nested`). The static surfaces walk both operands too.
 *
 * **Per-branch correlation.** A fan-out / membership-delete op identifies the branch's
 * affected rows by a correlated `exists (select 1 from __vmupd_keys k where <k matches
 * the branch row's data tuple>)` — a NULL-safe full-data-tuple match (set operations
 * treat `NULL = NULL` as equal, and the engine has no `IS NOT DISTINCT FROM`, so each
 * column is matched `k.c = b.c or (k.c is null and b.c is null)`). The branch's own
 * columns are qualified with the synthetic branch-view name so {@link propagate}'s
 * single-source correlation (the `__vm_self` self-alias) binds them to the lowered base
 * row; the `k.*` capture columns stay unqualified-to-the-branch and resolve to the
 * injected `__vmupd_keys` relation. The membership-INSERT branch instead reads the
 * captured rows **absent** from the branch via the probe flag (`where not k.<flag>`),
 * so a `set <flag> = true` is a clean no-op for rows already present (and across
 * operators — `except`'s always-false right flag inserts every visible row, `intersect`'s
 * always-true flags insert none).
 *
 * **Scope.** union / union all / except / intersect membership writes, data-column fan-out,
 * delete fan-out, and insert-through, at any nesting depth for the unambiguous fan-out
 * operations (data UPDATE / DELETE / `set <subtreeFlag> = false`). The ambiguous inserts
 * into a subtree (`set <subtreeFlag> = true`, surfaced-inner-flag writes, insert-through into
 * a subtree side) are `set-op-membership-nested` (product-coordinate addressing); non-literal
 * boolean membership writes and the `strict` unspecified-case policy stay deferred.
 */

/**
 * True iff `selectAst` is a **binary set-operation body carrying ≥1 membership flag**
 * (`<setop> exists <branch> as <name>`) — the shape this write path decomposes. An
 * AST peek (no plan built), the write-side shadow of the read half's combinator. A
 * plain (flag-less) set-op body returns `false` and keeps rejecting `unsupported-set-op`
 * through the single-source spine (there is no membership column to address a branch by).
 * `diff` is excluded (the parser already rejects membership on it).
 */
export function isSetOpMembershipBody(selectAst: AST.QueryExpr): boolean {
	return selectAst.type === 'select'
		&& !!selectAst.compound
		&& selectAst.compound.op !== 'diff'
		&& !!selectAst.compound.existence
		&& selectAst.compound.existence.length > 0;
}

/**
 * True iff a set-op membership body is reportable-writable by the static surfaces — the
 * no-plan shadow of {@link analyzeSetOpView}'s pre-write rejections: an outer LIMIT/OFFSET
 * (the body is not decomposable — a write would escape the limited window), a non-SELECT
 * right operand, a `select *` leg, or a computed (non-plain-column) leg. Lets the
 * `column_info` / `view_info` static surfaces gate the membership-writable claim on the SAME
 * shape the dynamic write enforces, instead of reporting writable from the membership flag's
 * presence alone.
 *
 * **Recursive** (`nestable-flagged-set-ops`): an operand is branch-writable iff it is a
 * plain-leg leaf OR a (recursively) branch-writable set-op body — so a nested view reports
 * `is_updatable` / `is_deletable` = YES, agreeing with the dynamic accept (data + delete
 * fan-out recurse through a subtree operand). Inserts into a subtree are deferred, so
 * insertability is gated separately on {@link setOpHasSubtreeOperand}.
 */
export function isSetOpBranchWritable(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.compound) return false;
	return isSetOpBodyWritable(selectAst);
}

/**
 * True iff a set-op body (its compound + both operands) is recursively branch-writable.
 * Mirrors the dynamic write's pre-write rejections at this level — an outer LIMIT/OFFSET
 * (a write would escape the window), then each operand checked via {@link isOperandWritable}.
 *
 * Threads each operand's **boundary-flag presence** (`exists <branch> as <flag>` declared on
 * THIS compound for that side) into {@link isOperandWritable}: an `except` / `intersect` subtree
 * operand is writable only when its side carries a boundary flag to gate the fan on, mirroring
 * the dynamic `gateFlagForNonUnionSubtree` requirement.
 */
function isSetOpBodyWritable(selectAst: AST.SelectStmt): boolean {
	if (!selectAst.compound) return false;
	if (selectAst.limit || selectAst.offset) return false;
	const ex = selectAst.compound.existence ?? [];
	const leftFlag = ex.some(e => e.branch === 'left');
	const rightFlag = ex.some(e => e.branch === 'right');
	return isOperandWritable(leftBranchSelect(selectAst), leftFlag)
		&& isOperandWritable(selectAst.compound.select, rightFlag);
}

/**
 * True iff an operand (a compound leg) is recursively branch-writable: a (recursively)
 * writable set-op body, OR a plain-column leaf (the shape that round-trips a base column
 * through the branch's single-source spine). A non-SELECT operand, a `select *` leg, or a
 * computed leg is non-writable — the dynamic write rejects all three.
 *
 * `hasGatingFlag` is whether the parent compound declared a boundary membership flag for this
 * operand's side. A **union / union all** subtree ignores it (a leaf ⊆ the subtree, so the
 * leaf-presence correlation already implies membership — no gate needed). An **`except` /
 * `intersect`** subtree is writable IFF `hasGatingFlag` (the captured boundary flag gates the
 * fan to genuine members — `set-op-membership-nested-except`); a flag-less non-union boundary
 * stays deferred, so this returns `false`, agreeing with the dynamic reject. Leaf operands
 * ignore `hasGatingFlag`.
 */
function isOperandWritable(operand: AST.QueryExpr, hasGatingFlag: boolean): boolean {
	if (operand.type !== 'select') return false;
	// Unwrap a parenthesized LEFT compound operand's `select * from (compound)` wrapper so it is
	// classified as the subtree it is, mirroring the dynamic `buildBranch` unwrap — a no-op on a
	// direct operand (`set-op-leftwrap-write`).
	const effective = unwrapBranchSelect(operand);
	if (effective.compound && effective.compound.op !== 'diff') {
		// An except / intersect subtree needs a boundary flag to gate the membership fan on.
		if (!isUnionLikeSubtree(effective.compound.op) && !hasGatingFlag) return false;
		return isSetOpBodyWritable(effective);
	}
	// A leaf operand's data columns must be plain (optionally renamed) base columns; on top of
	// that it is writable when it is single-source OR a **multi-source INNER join leg** (the
	// join-leg compose — `set-op-write-multisource-leg-compose`, which builds an inner per-branch
	// capture chained off the outer set-op capture). An OUTER (left/right/full) / cross join leg is
	// deferred, so it reports non-writable here — matching the dynamic `buildBranch` reject exactly.
	// (`isInnerJoinBody` keys only on `joinType`, so a NON-EQUI inner join is admitted and composes,
	// exactly as the standalone join-view path and the flag-less route admit it.) This recurses to
	// leaves at every depth, so a
	// nested join leaf is classified too. Insertability through a join leg is deferred separately
	// (gated in `schema.ts`).
	if (tryBranchColumnNames(effective) === null) return false;
	return !isJoinBody(effective) || isInnerJoinBody(effective);
}

/**
 * True iff a subtree operand's set operator is **union-like** (`union` / `unionAll`), whose
 * result is a SUPERSET of each operand — every resident leaf row is a member, so the fan-out
 * needs no membership gate. `except` / `intersect` are NOT union-like: a leaf can hold rows the
 * subtree excludes, so their fan-out is gated on the captured subtree-membership boundary flag
 * (`set-op-membership-nested-except`). This helper branches the gate logic (no extra conjunct
 * for union-like, accumulate the boundary flag otherwise); a flag-less non-union boundary
 * remains the lone deferral.
 */
function isUnionLikeSubtree(op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'): boolean {
	return op === 'union' || op === 'unionAll';
}

/**
 * True iff a membership body has a **subtree (compound) operand** — an inner
 * `SetOperationNode` operand on EITHER side. Insert-through into a multi-leaf subtree has no
 * single deterministic target leaf (product-coordinate addressing — `set-op-membership-nested`),
 * so the static `is_insertable_into` surface gates to `NO` when this holds, while
 * data/delete fan-out (which touches every member leaf) stays writable. A parenthesized LEFT
 * compound operand is lifted into a `select * from (compound)` wrapper, so the left is unwrapped
 * before probing — a parallel-sibling view (`set-op-leftwrap-write`) also reports NO.
 */
export function setOpHasSubtreeOperand(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.compound) return false;
	const left = unwrapBranchSelect(leftBranchSelect(selectAst));
	return isSubtreeOperand(left) || isSubtreeOperand(selectAst.compound.select);
}

/** True iff an operand SELECT is itself a (non-diff) set-op subtree. */
function isSubtreeOperand(operand: AST.QueryExpr): boolean {
	return operand.type === 'select' && !!operand.compound && operand.compound.op !== 'diff';
}

/**
 * True iff EVERY multi-source (INNER join) leg/branch of this set-op body would accept an
 * implicit INSERT through the plan-level shared-surrogate envelope
 * (`set-op-write-multisource-leg-insert`). A body with NO join leg returns `true` (its
 * single-source legs are the existing insert-through path); a body with ≥1 join leg returns
 * `true` only when every such leg's `analyzeMultiSourceInsert` probe succeeds.
 *
 * A purely structural inner-vs-outer predicate is INSUFFICIENT: an inner equi-join leg can still
 * reject dynamically with `unsupported-decomposition-key` (a composite shared key — the CV shape),
 * `unsupported-join` (a non-equi ON), or `no-default` (the shared key is neither supplied nor
 * defaulted — e.g. the SJ self-join, whose anchor key `emp.mgr` has no default). So this re-derives
 * the branches the same way the dynamic write does (membership via {@link analyzeSetOpView}, else
 * {@link analyzeFlaglessSetOpView}) and probes each `isMultiSource` leg with
 * {@link analyzeMultiSourceInsert} under a synthetic implicit (empty-column) `InsertStmt`, in
 * try/catch — a leg that throws (composite key, non-equi, no-default, uncovered NOT NULL, …) ⇒
 * `false`. The empty `columns` makes `analyzeMultiSourceInsert` use the implicit supply set, and an
 * inner join leg has no existence columns, so the empty `values` is never read.
 *
 * This is only ever reached after {@link isSetOpBranchWritable} / {@link isSetOpFlaglessWritableBody}
 * already passed (an outer-join branch / non-flagless body short-circuits to the conservative
 * all-`NO` row upstream, never reaching here), so the branch re-derivation will not throw on the
 * body shape; only the per-leg `analyzeMultiSourceInsert` probe may. It must not leak a structured
 * diagnostic out of the read TVF, so every probe is caught.
 */
export function setOpJoinLegsInsertable(ctx: PlanningContext, view: MutableViewLike): boolean {
	const branches = isSetOpMembershipBody(view.selectAst)
		? analyzeSetOpView(ctx, view).branches
		: analyzeFlaglessSetOpView(ctx, view).legs.map(l => l.branch);
	for (const branch of branches) {
		if (!branch.isMultiSource) continue;
		const probeStmt: AST.InsertStmt = {
			type: 'insert',
			table: { type: 'identifier', name: branch.view.name },
			columns: [],
			source: { type: 'values', values: [] },
		};
		try {
			analyzeMultiSourceInsert(ctx, branch.view, probeStmt);
		} catch {
			return false; // a leg whose insert envelope rejects (composite / non-equi / no-default key)
		}
	}
	return true;
}

/**
 * The **surfaced inner-branch membership-flag names** of a (possibly nested) set-op body —
 * every flag declared on a subtree operand, surfaced as a readable-but-non-writable column of
 * the outer view. Returned in the plan's recursive `[L flags] ++ [R flags] ++ [own flags]`
 * attribute layout (`SetOperationNode.buildAttributes`), so this list lands element-for-element
 * on the plan-derived `analysis.surfacedInnerFlagNames` (`viewColNames` minus the leading data
 * cols and trailing own flags). Empty for a binary (non-nested) body. Writing one addresses a
 * branch *inside* a subtree operand (product-coordinate addressing), so `buildUpdate` rejects it
 * with a `set-op-membership-nested` diagnostic and the `column_info` surface reports it
 * `is_updatable = NO`.
 */
export function surfacedInnerFlagNames(selectAst: AST.QueryExpr): string[] {
	const out: string[] = [];
	if (selectAst.type === 'select' && selectAst.compound) {
		// Walk BOTH operands in plan layout order: `[L operand surfaced] ++ [R operand surfaced]`
		// (this node's OWN flags are `analysis.flags`, not surfaced-inner, and are excluded here).
		// The unwrap of a parenthesized LEFT compound operand's `select * from (compound)` wrapper
		// (`set-op-leftwrap-write`) lives INSIDE the recursion, so it applies uniformly at every
		// level — pass the raw left/right operands here, not pre-unwrapped.
		collectSubtreeFlagNames(leftBranchSelect(selectAst), out);
		collectSubtreeFlagNames(selectAst.compound.select, out);
	}
	return out;
}

/**
 * Collect every membership-flag name `operand` (and its deeper subtree operands) surfaces, in
 * the plan's recursive `[L flags] ++ [R flags] ++ [own flags]` attribute layout
 * (`SetOperationNode.buildAttributes`): descend the LEFT leg, then the RIGHT leg, THEN append
 * this node's OWN flags — so the result lands element-for-element on the plan-derived
 * `analysis.surfacedInnerFlagNames` regardless of which leg declared a flag, at any depth.
 *
 * Each operand is first unwrapped via {@link unwrapBranchSelect} (a no-op on a direct operand)
 * so a parenthesized LEFT compound operand's `select * from (compound)` wrapper is descended too
 * (`set-op-leftwrap-write`) — a flag declared on either leg of a left- OR right-side subtree is
 * reached, and a write to one rejects with the clean `set-op-membership-nested` diagnostic
 * rather than `unknown-view-column`.
 */
function collectSubtreeFlagNames(operand: AST.QueryExpr, out: string[]): void {
	if (operand.type !== 'select') return;
	const effective = unwrapBranchSelect(operand);
	if (!effective.compound || effective.compound.op === 'diff') return;
	collectSubtreeFlagNames(leftBranchSelect(effective), out);
	collectSubtreeFlagNames(effective.compound.select, out);
	for (const e of effective.compound.existence ?? []) out.push(e.name);
}

/** One membership flag declared on the set operation. */
interface MembershipFlag {
	readonly name: string;
	readonly side: 'left' | 'right';
}

/** One branch (operand) of the binary set operation, as a recursively-writable view body. */
interface SetOpBranch {
	readonly side: 'left' | 'right';
	/** Synthetic view-like wrapping the operand's SELECT — recursed through {@link propagate}. */
	readonly view: MutableViewLike;
	/** The operand's projected data-column names (positional, aligned to the view's data columns). */
	readonly dataColNames: readonly string[];
	/** This branch's declared membership flag, when one is declared. */
	readonly flag?: MembershipFlag;
	/**
	 * True iff this operand is itself a set-operation body (a subtree) — its `selectAst`
	 * carries a (non-diff) `compound`. A nested branch's fan-out (data UPDATE / DELETE /
	 * `= false` flip) recurses through {@link analyzeSetOpBranches} to its member leaves
	 * (sharing the one up-front capture); a **union** subtree fans freely, an **`except` /
	 * `intersect`** subtree fans **gated on its captured boundary flag**
	 * (`set-op-membership-nested-except`; a flag-less non-union boundary stays deferred). Its
	 * `= true` flip / insert-through route is rejected (a multi-leaf insert has no single
	 * deterministic target leaf — `set-op-membership-nested`).
	 */
	readonly isNested: boolean;
	/**
	 * True iff this branch is a non-nested **multi-source (INNER join) leg**
	 * (`set-op-write-multisource-leg-compose`). Its data/delete fan does NOT route through plain
	 * {@link propagate} (which builds no capture and would collide the inner multi-source capture
	 * with the outer set-op capture); instead it builds its own inner per-branch base-PK capture
	 * under a fresh `__vmupd_keys$N` name, chained off the outer set-op capture (the inner's
	 * `memberExists` filter scans the outer `__vmupd_keys`). Mutually exclusive with
	 * {@link isNested}. An OUTER (left/right/full) / cross / non-equi join leg is rejected at
	 * classification (deferred); its `= true` flip / insert-through is rejected
	 * (`set-op-write-multisource-leg-insert`).
	 */
	readonly isMultiSource: boolean;
}

interface SetOpAnalysis {
	readonly op: 'union' | 'unionAll' | 'intersect' | 'except';
	/** The planned view body root (its attributes are the view's output columns). */
	readonly root: RelationalPlanNode;
	/** A scope resolving every view output column name against {@link root}. */
	readonly viewColScope: Scope;
	/** Every view output column name (data columns then flag columns), positional. */
	readonly viewColNames: readonly string[];
	/** Every view output column's scalar type, positional with {@link viewColNames}. */
	readonly viewColTypes: readonly ScalarType[];
	/** Count of data (non-flag) columns (recursive `SetOperationNode.dataColumnCount()`). */
	readonly dataColCount: number;
	/** The data (non-flag) column names — `viewColNames.slice(0, dataColCount)`. */
	readonly dataColNames: readonly string[];
	readonly flags: readonly MembershipFlag[];
	/**
	 * Surfaced inner-branch flag names (the view columns that are neither data nor this
	 * node's own flags — `[L flags] ++ [R flags]` of a subtree operand). Writing one is
	 * deferred to `set-op-membership-nested`; `buildUpdate` rejects it with a clean
	 * diagnostic rather than `unknown-view-column` (it IS a view column).
	 */
	readonly surfacedInnerFlagNames: readonly string[];
	readonly branches: readonly [SetOpBranch, SetOpBranch];
}

/**
 * One active multi-source (INNER join) leg/branch INSERT to build via the plan-level
 * shared-surrogate envelope (`buildMultiSourceInsert`) and splice as a nested
 * `ViewMutationNode` child of the outer set-op write node (`set-op-write-multisource-leg-insert`).
 *
 * The set-op insert builders cannot call `buildMultiSourceInsert` (it lives in the building
 * layer, and `buildMultiSourceInsert` produces a whole `PlanNode`, not an AST `BaseOp`), so they
 * record this per-leg descriptor instead of routing to {@link propagate}; `buildSetOpMutation`
 * (beside `buildMultiSourceInsert`) turns each into a nested envelope-backed `ViewMutationNode`.
 * The `stmt`'s source is self-contained for an insert-through / flag-less VALUES insert, or a
 * SELECT over `__vmupd_keys` for a membership `set <flag> = true` flip (which reads the OUTER
 * set-op capture — `buildSetOpMutation` passes the capture-injected context so it resolves).
 */
export interface JoinLegInsert {
	/** The synthetic `__setop_*` / `__setop_legN` join-leg view-like the insert targets. */
	readonly view: MutableViewLike;
	/** The per-leg insert (VALUES self-contained, or a SELECT over `__vmupd_keys`). */
	readonly stmt: AST.InsertStmt;
}

/**
 * The decomposition of a set-op membership write: the ordered per-branch base ops plus
 * the up-front capture they read. `capture` is absent for insert-through (whose values
 * are self-contained — no affected-row read), present for every probe-driven write
 * (membership flip, data fan-out, delete fan-out).
 */
export interface SetOpWritePlan {
	readonly baseOps: BaseOp[];
	readonly capture?: MultiSourceKeyCapture;
	/**
	 * The inner per-branch base-PK captures one per **multi-source (join) branch** the fan
	 * reached (`set-op-write-multisource-leg-compose`), accumulated in fan order. Each is built
	 * over its branch's planned join body, filtered by the SAME `buildMemberExists` predicate
	 * (which scans the outer {@link capture} via `__vmupd_keys`), under a fresh
	 * `__vmupd_keys$N` name so two join branches never collide. `buildSetOpMutation` injects each
	 * under its own name for the branch base ops and rides them on `ViewMutationNode.nestedCaptures`
	 * (materialized AFTER the outer capture). Absent / empty for a join-leg-free set-op write —
	 * which then lowers byte-identically to the pre-list substrate.
	 */
	readonly nestedCaptures?: MultiSourceKeyCapture[];
	/**
	 * The active multi-source (INNER join) leg/branch INSERTs to build via the plan-level
	 * shared-surrogate envelope and splice as nested `ViewMutationNode` children of the outer
	 * set-op write node (`set-op-write-multisource-leg-insert`). Populated by the three insert
	 * routes — membership `set <flag> = true` ({@link buildBranchMembershipInsert}), flag-less
	 * consistent-leg INSERT ({@link buildFlaglessInsert}), and VALUES insert-through
	 * ({@link buildInsertThrough}) — in place of the join-leg `propagate` (which would raise the
	 * internal `unsupported-multisource-insert`). `buildSetOpMutation` builds each via
	 * `buildMultiSourceInsert`. Absent / empty for a join-leg-free insert.
	 */
	readonly joinLegInserts?: JoinLegInsert[];
}

/** Decompose a set-op membership-column view mutation. Throws a structured diagnostic for unsupported shapes. */
export function buildSetOpWrite(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): SetOpWritePlan {
	const analysis = analyzeSetOpView(ctx, view);
	switch (req.op) {
		case 'insert': return buildInsertThrough(ctx, view, analysis, req.stmt);
		case 'update': return buildUpdate(ctx, view, analysis, req.stmt);
		case 'delete': return buildDelete(ctx, view, analysis, req.stmt);
	}
}

// --- analysis -------------------------------------------------------------

function analyzeSetOpView(ctx: PlanningContext, view: MutableViewLike): SetOpAnalysis {
	if (view.selectAst.type !== 'select' || !view.selectAst.compound) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': not a set-operation body`,
		});
	}
	const sel = view.selectAst;
	const compound = sel.compound!;
	if (compound.op === 'diff') {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': a DIFF (symmetric difference) body has no single addressable branch per row`,
		});
	}
	if (!compound.existence || compound.existence.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': a set-operation body is writable only through its membership columns; declare 'exists <branch> as <flag>' to address a branch`,
		});
	}

	// LIMIT / OFFSET on the outer compound would put the capture's filter above the
	// window — a write would escape it. Reject (parity with the join / single-source spine).
	if (sel.limit || sel.offset) {
		raiseMutationDiagnostic({
			reason: 'unsupported-limit',
			table: view.name,
			message: `cannot write through view '${view.name}': a LIMIT/OFFSET set-operation body is not decomposable (a write would escape the limited window)`,
		});
	}

	const flags: MembershipFlag[] = compound.existence.map(e => ({ name: e.name, side: e.branch }));

	// Plan the body ONCE: its root attributes are the view output columns (data columns
	// then the appended membership flags — `set-op-membership-read`'s combinator surface).
	// A STORED body plans on its own home-schema path (`bodyPlanningContext`); an
	// ephemeral CTE / inline-subquery target keeps the caller's `ctx`.
	const root = buildSelectStmt(bodyPlanningContext(ctx, view), sel);
	if (!isRelationalNode(root)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the set-operation body did not produce a relation`,
		});
	}
	const relRoot = root as RelationalPlanNode;
	const attrs = relRoot.getAttributes();
	const viewColNames = attrs.map(a => a.name);
	const viewColTypes = attrs.map(a => a.type);
	// Data-column count is the recursive DATA arity of the planned set operation
	// (`SetOperationNode.dataColumnCount()`), NOT `attrs.length - flags.length`: with a nested
	// (flagged) subtree operand, the surfaced inner flags inflate `attrs.length`, so subtracting
	// only the OWN flags would mis-count them as data columns (`nestable-flagged-set-ops`).
	const setOpNode = findSetOpNode(relRoot);
	if (!setOpNode) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the set-operation body produced no SetOperationNode`,
		});
	}
	const dataColCount = setOpNode.dataColumnCount();
	if (dataColCount <= 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the set operation exposes no data columns alongside its membership flags`,
		});
	}
	const dataColNames = viewColNames.slice(0, dataColCount);
	// Surfaced inner flags sit BETWEEN the data columns and this node's own flags in the
	// `[data] ++ [L flags] ++ [R flags] ++ [own flags]` layout — `viewColNames` minus the
	// leading data columns and the trailing own flags. Empty for a binary (non-nested) body.
	const surfacedInnerFlagNames = viewColNames.slice(dataColCount, viewColNames.length - flags.length);

	// A scope resolving each view output column name to its producing attribute over the
	// planned root — the same shape `createSetOperationScope` builds for the body itself,
	// reused here so the user predicate / capture projections resolve byte-identically.
	// Parented to `ctx.scope` so a user WHERE's parameters (`where id = ?`), CTE refs, and
	// other ambient symbols still resolve — a view output column shadows them (checked
	// first), and a base-only name still fails to resolve (the statement scope exposes no
	// base columns), so the encapsulation guard is unchanged.
	const viewColScope = new RegisteredScope(ctx.scope);
	attrs.forEach((attr, i) => {
		viewColScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
	});

	const branches: [SetOpBranch, SetOpBranch] = [
		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, flags, sel.schemaPath),
		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, flags, sel.schemaPath),
	];

	return { op: compound.op, root: relRoot, viewColScope, viewColNames, viewColTypes, dataColCount, dataColNames, surfacedInnerFlagNames, flags, branches };
}

/**
 * The `SetOperationNode` inside a planned body root — the root itself for a bare compound
 * body, else found by descending the relational spine (a body with an outer ORDER BY wraps
 * the set op in a `SortNode`). Its recursive `dataColumnCount()` is the data arity the
 * surfaced-inner-flag count subtraction (`attrs.length - flags.length`) over-counts.
 */
function findSetOpNode(node: RelationalPlanNode): SetOperationNode | undefined {
	if (node instanceof SetOperationNode) return node;
	for (const child of node.getRelations()) {
		const found = findSetOpNode(child);
		if (found) return found;
	}
	return undefined;
}

/**
 * Membership-free branch analysis of a nested (subtree) operand: its two inner branches,
 * built without the membership gate `analyzeSetOpView` enforces (a flag-less subtree has no
 * `compound.existence`). The data arity is the OUTER body's (`dataColCount`) — set
 * operations preserve data columns at every depth (the `SetOperationNode` constructor
 * enforces `dataArity(left) === dataArity(right)`), so an inner leaf has exactly the same
 * data columns the outer capture froze. Used by the data/delete fan-out recursion.
 */
function analyzeSetOpBranches(view: MutableViewLike, branchView: MutableViewLike, dataColCount: number): readonly [SetOpBranch, SetOpBranch] {
	const sel = branchView.selectAst as AST.SelectStmt;
	const compound = sel.compound!;
	const innerFlags: MembershipFlag[] = (compound.existence ?? []).map(e => ({ name: e.name, side: e.branch }));
	return [
		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, innerFlags, sel.schemaPath),
		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, innerFlags, sel.schemaPath),
	];
}

/** The left operand's SELECT — the compound statement stripped of its outer modifiers. */
function leftBranchSelect(sel: AST.SelectStmt): AST.SelectStmt {
	const { compound: _c, orderBy: _o, limit: _l, offset: _f, ...leftCore } = sel;
	return leftCore as AST.SelectStmt;
}

/**
 * The **effective** operand SELECT of a (possibly parenthesized-compound) operand: the inner
 * compound when `branchSelect` is a pure `select * from (<compound>) as values_N` passthrough
 * wrapper (the shape the parser lifts a parenthesized LEFT compound operand into,
 * `set-op-leftwrap-arity`), else `branchSelect` unchanged. Shared with the read/plan path
 * (`select-compound.ts`'s `unwrapToSelect`, via the same {@link unwrapPassthroughSubquery}
 * predicate) so neither path drifts on what a pure wrapper is.
 *
 * Threading it through {@link buildBranch} makes the wrapped LEFT operand a first-class subtree
 * operand for the write path's unambiguous fan-out (data UPDATE / DELETE / `set <flag> = false`),
 * exactly as the (always-direct) right compound operand already is (`set-op-leftwrap-write`). The
 * unwrap is a no-op on a direct operand (a leaf SELECT, or the right side's direct compound), so
 * applying it uniformly to both sides is safe. A non-SELECT inner (a `select * from (values…)`)
 * stays the wrapper and is rejected downstream as a `select *` leg.
 */
function unwrapBranchSelect(branchSelect: AST.SelectStmt): AST.SelectStmt {
	const inner = unwrapPassthroughSubquery(branchSelect);
	return inner && inner.type === 'select' ? inner : branchSelect;
}

/**
 * Stamp the compound's declared `with schema` path onto a leg that has none of its own. The
 * parser binds a trailing `with schema` clause to the WHOLE compound but attaches it only to
 * the leading leg's statement node (`isCompoundSubquery` suppression in `parser/parser.ts`), so
 * every other leg's body would otherwise plan on the view's plain home path instead of the
 * declared one (`bug-setop-right-leg-write-drops-declared-schema-path`). Identity when
 * `declaredPath` is `undefined` (no `with schema` clause on the definition) or `sel` already
 * carries its own path (a nested sub-compound's own clause always wins for its own legs).
 */
function withDeclaredPath(sel: AST.SelectStmt, declaredPath: string[] | undefined): AST.SelectStmt {
	if (!declaredPath || sel.schemaPath) return sel;
	return { ...sel, schemaPath: declaredPath };
}

/**
 * The **left-most leaf** SELECT of a (possibly nested, possibly wrapped) operand — the leg whose
 * projection positionally aligns to the set operation's data columns (a `SetOperationNode`
 * preserves its left child's column ids verbatim at every depth). A direct operand IS its own
 * leaf; a nested compound descends its left leg, unwrapping each `select * from (compound)`
 * wrapper. This is what {@link branchColumnNames} reads its data-column names from: a right-spine
 * nested operand's left leg is a direct leaf (so `branchSelect.columns` already named it), but a
 * LEFT-spine nested operand's left leg is itself wrapped (`set-op-leftwrap-write`), so a single
 * `.columns` read there would see the wrapper's `*` — the descent reaches the real leaf instead.
 */
function leftmostLeafSelect(branchSelect: AST.SelectStmt): AST.SelectStmt {
	let cur = unwrapBranchSelect(branchSelect);
	while (cur.compound && cur.compound.op !== 'diff') {
		cur = unwrapBranchSelect(leftBranchSelect(cur));
	}
	return cur;
}

/** The right operand's SELECT, stripped of any leg-local ORDER BY / LIMIT / OFFSET. */
function rightBranchSelect(view: MutableViewLike, right: AST.QueryExpr): AST.SelectStmt {
	if (right.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the right branch is a ${right.type.toUpperCase()} operand, which is not a recursively-writable body (v1 supports SELECT operands)`,
		});
	}
	const { orderBy: _o, limit: _l, offset: _f, ...core } = right;
	return core as AST.SelectStmt;
}

/**
 * Build one recursively-writable branch view-like from an operand SELECT. `declaredPath`, when
 * given, is the compound's declared `with schema` path — stamped onto the branch body via
 * {@link withDeclaredPath} when the body has no path of its own, so a non-leading leg (which
 * never carries the clause; the parser attaches it only to the leading leg's statement node)
 * still plans against the definition's declared schemas rather than the view's plain home path.
 */
function buildBranch(
	view: MutableViewLike,
	side: 'left' | 'right',
	branchSelect: AST.SelectStmt,
	dataColCount: number,
	flags: readonly MembershipFlag[],
	declaredPath?: string[],
): SetOpBranch {
	// Unwrap a parenthesized LEFT compound operand's `select * from (<compound>)` wrapper to its
	// inner compound, so a wrapped left operand is a first-class subtree operand (its data cols,
	// `isNested`, and recursion all derive from the inner) — `set-op-leftwrap-write`. A no-op on a
	// direct operand. Then stamp the compound's declared `with schema` path onto it when it has
	// none of its own — the leading leg's body keeps its path by parser accident, every other
	// leg's does not (`withDeclaredPath`).
	const effectiveSelect = withDeclaredPath(unwrapBranchSelect(branchSelect), declaredPath);
	// A subtree operand carries its own (non-diff) compound; its fan-out recurses to leaves.
	const isNested = !!effectiveSelect.compound && effectiveSelect.compound.op !== 'diff';
	// A non-nested **multi-source (INNER join) leg** is now writable for UPDATE / DELETE
	// (`set-op-write-multisource-leg-compose`): its data/delete fan builds an inner per-branch
	// base-PK capture chained off the outer set-op capture (a fresh `__vmupd_keys$N` name), so
	// the join branch decomposes through the multi-source machinery without colliding with the
	// outer capture. An OUTER (left/right/full) / cross join leg is deferred — reject it cleanly
	// here (never routing it to `propagate`, which would mishandle the un-composed capture).
	// (`isInnerJoinBody` keys only on `joinType`, so a NON-EQUI inner join is admitted and
	// composes here, exactly as the standalone join-view path admits it — not rejected.) A nested
	// (subtree) operand is NOT classified here: its join leaves are reached as non-nested branches
	// via `analyzeSetOpBranches` → `buildBranch` and classified at that depth, so this covers every
	// leaf at every nesting level.
	const isMultiSource = !isNested && isInnerJoinBody(effectiveSelect);
	if (!isNested && !isMultiSource && isJoinBody(effectiveSelect)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the ${side} branch is an OUTER (left/right/full) or cross join leg, which is not a plain INNER join — its set-op write composition is deferred (set-op-write-multisource-leg-compose ships inner-join legs)`,
		});
	}
	const dataColNames = branchColumnNames(view, side, effectiveSelect);
	if (dataColNames.length !== dataColCount) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the ${side} branch projects ${dataColNames.length} columns but the set operation exposes ${dataColCount} data columns`,
		});
	}
	const branchView: MutableViewLike = {
		name: `__setop_${side}`,
		schemaName: view.schemaName,
		selectAst: effectiveSelect,
		// Carry the target's ephemeral flag: a branch of an ephemeral CTE / inline-subquery
		// target is still part of the caller's statement, so its body must keep the caller's
		// schema path. Without this the branch would re-acquire the home path in
		// `bodyPlanningContext` off the (cosmetic) inherited `schemaName`.
		...(view.ephemeral ? { ephemeral: true } : {}),
	};
	const flag = flags.find(f => f.side === side);
	return { side, view: branchView, dataColNames, isNested, isMultiSource, ...(flag ? { flag } : {}) };
}

/**
 * The branch operand's projected column names (positional). v1 admits plain column
 * references (with optional rename) — the shape that round-trips a base column through
 * the branch's single-source spine. A `select *` leg or a computed projection is
 * rejected (the nested / computed-branch generality is deferred): a `*` has no static
 * name list to align positionally, and a computed leg column has no base column to
 * write a fanned-out value into.
 */
function branchColumnNames(view: MutableViewLike, side: 'left' | 'right', branchSelect: AST.SelectStmt): string[] {
	// The data-column names are the left-most leaf's projection (a set op preserves its left
	// child's column ids at every depth) — descend through a nested / left-wrapped operand so a
	// LEFT-spine compound branch derives names from its real leaf, not a wrapper's `*`.
	const leaf = leftmostLeafSelect(branchSelect);
	const names = tryBranchColumnNames(leaf);
	if (names) return names;
	// `tryBranchColumnNames` returned `null` ⇒ a `*` or computed leg; re-derive the
	// specific reason for the per-side diagnostic (the shared probe only yields the
	// boolean, so the static surface and this path cannot drift on what counts as writable).
	for (const rc of leaf.columns) {
		if (rc.type === 'all') {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				table: view.name,
				message: `cannot write through view '${view.name}': the ${side} branch uses 'select *'; list its columns explicitly so each maps to a writable branch column`,
			});
		}
		if (rc.expr.type !== 'column') {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				table: view.name,
				message: `cannot write through view '${view.name}': the ${side} branch projects a computed column; v1 supports plain (optionally renamed) base columns in a writable branch`,
			});
		}
	}
	// Unreachable: `tryBranchColumnNames` returns `null` only for a `*`/computed leg, both
	// handled above. Guard defensively rather than returning a wrong (empty) name list.
	raiseMutationDiagnostic({
		reason: 'unsupported-set-op',
		table: view.name,
		message: `cannot write through view '${view.name}': the ${side} branch is not a writable plain-column projection`,
	});
}

/**
 * The non-throwing core of {@link branchColumnNames}: the branch operand's projected
 * plain-column names (positional, honoring a leg rename via `rc.alias ?? rc.expr.name`),
 * or `null` when the leg is not a writable shape — a `select *` (`rc.type === 'all'`, no
 * static name list to align positionally) or a computed (`rc.expr.type !== 'column'`)
 * projection (no base column to write a fanned-out value into). Shared by the dynamic
 * write path and the static {@link isSetOpBranchWritable} probe so neither can drift on
 * what a writable leg is.
 */
function tryBranchColumnNames(branchSelect: AST.SelectStmt): string[] | null {
	const names: string[] = [];
	for (const rc of branchSelect.columns) {
		if (rc.type === 'all' || rc.expr.type !== 'column') return null;
		names.push(rc.alias ?? rc.expr.name);
	}
	return names;
}

// --- capture --------------------------------------------------------------

/**
 * Build the up-front affected-row capture: `Project_{all view cols}(Filter_{userWhere}
 * (setOpRoot))`, materialized ONCE before any branch op fires. Every probe-driven write
 * reads it back through {@link MS_UPDATE_KEYS_CTE}, so the data columns AND the
 * membership-probe flags are frozen at their pre-mutation values (Halloween-safe). The
 * capture column shape (one per view output column, by name) is what each branch op's
 * `k.<col>` reference and the membership-INSERT projection resolve against.
 */
function buildSetOpCapture(ctx: PlanningContext, analysis: SetOpAnalysis, where: AST.Expression | undefined): MultiSourceKeyCapture {
	const scope = analysis.viewColScope;
	const filtered: RelationalPlanNode = where
		? new FilterNode(scope, analysis.root, buildExpression({ ...ctx, scope }, cloneExpr(where)))
		: analysis.root;
	const projections: Projection[] = analysis.viewColNames.map(name => ({
		node: buildExpression({ ...ctx, scope }, { type: 'column', name } as AST.ColumnExpr),
		alias: name,
	}));
	const source = new ProjectNode(scope, filtered, projections, undefined, undefined, false);
	const keyColumns = analysis.viewColNames.map((name, i) => ({ name, type: analysis.viewColTypes[i] }));
	return { source, descriptor: {}, keyColumns };
}

// --- multi-source (join) branch composition -------------------------------

/**
 * The fan-wide state a multi-source (INNER join) branch threads through the data/delete fan
 * (`set-op-write-multisource-leg-compose`). It carries the OUTER set-op capture (each inner
 * per-branch capture's `memberExists` filter scans it via `__vmupd_keys`), accumulates the inner
 * captures in fan order (`captures`), and mints a fresh `__vmupd_keys$N` name per join branch via
 * a monotonic counter that **must not reset between branches** — two branches sharing a name
 * re-introduce the very collision this ticket resolves.
 */
interface JoinLegFan {
	readonly outerCapture: MultiSourceKeyCapture;
	readonly captures: MultiSourceKeyCapture[];
	/** Mint the next fresh inner capture name (`__vmupd_keys$1`, `$2`, …). */
	mintName(): string;
}

/** Build a fresh {@link JoinLegFan} over the up-front outer set-op capture. */
function makeJoinLegFan(outerCapture: MultiSourceKeyCapture): JoinLegFan {
	const captures: MultiSourceKeyCapture[] = [];
	let counter = 0;
	return { outerCapture, captures, mintName: () => `${MS_UPDATE_KEYS_CTE}$${++counter}` };
}

/**
 * Compose one multi-source (INNER join) branch's data UPDATE / DELETE: build the branch base ops
 * via the multi-source decomposer (referencing a fresh inner `__vmupd_keys$N` capture) PLUS the
 * inner per-branch base-PK capture itself, filtered by the branch's `memberExists` predicate (the
 * SAME data-tuple match against the OUTER set-op capture the single-source fan builds), and record
 * the inner capture into the fan accumulator. The inner capture is built under a context with the
 * OUTER capture injected (so its `memberExists` filter's `from __vmupd_keys` resolves), and over
 * the branch's planned join body (`analyzeJoinView`) — so the join leg decomposes through the
 * multi-source machinery without colliding with the outer capture.
 *
 * `decompose` selects UPDATE vs DELETE — both build `BaseOp[]` against the base tables whose
 * predicates read back the fresh inner capture; the inner capture's identity is the branch's
 * affected (captured-and-member-matched) rows. `branchStmt.where` IS the `memberExists` predicate,
 * reused verbatim as the inner capture's filter.
 */
function fanMultiSourceBranch(
	ctx: PlanningContext,
	branch: SetOpBranch,
	branchStmt: AST.UpdateStmt | AST.DeleteStmt,
	fan: JoinLegFan,
	decompose: (joinAnalysis: JoinViewAnalysis, name: string) => BaseOp[],
): BaseOp[] {
	const joinAnalysis = analyzeJoinView(ctx, branch.view);
	const name = fan.mintName();
	const baseOps = decompose(joinAnalysis, name);
	const sides = capturedSideIndices(baseOps, joinAnalysis);
	// Inject the OUTER set-op capture so the inner capture's `memberExists` filter (`exists (…
	// from __vmupd_keys k …)`) resolves against it; the inner capture is built over the branch's
	// planned join body under its own fresh name.
	const ctxWithOuter = withKeyCapture(ctx, fan.outerCapture);
	const capture = buildMultiSourceKeyCapture(ctxWithOuter, branch.view, branchStmt.where, joinAnalysis, sides, undefined, name);
	fan.captures.push(capture);
	return baseOps;
}

// --- UPDATE (membership flip + data fan-out) ------------------------------

interface DataAssignment {
	/** The data column's position (index into `analysis.dataColNames`). */
	readonly position: number;
	/** The assigned value (in view / data-column terms). */
	readonly value: AST.Expression;
}

function buildUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.UpdateStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);

	const flips = new Map<'left' | 'right', boolean>();
	const dataAssignments: DataAssignment[] = [];
	for (const asg of stmt.assignments) {
		const flag = analysis.flags.find(f => f.name.toLowerCase() === asg.column.toLowerCase());
		if (flag) {
			const value = asBooleanLiteral(asg.value);
			if (value === undefined) {
				raiseMutationDiagnostic({
					reason: 'unsupported-set-op',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the membership column '${asg.column}' must be assigned a boolean literal (true/false); a per-row branch on a non-literal value is deferred`,
				});
			}
			const existing = flips.get(flag.side);
			if (existing !== undefined && existing !== value) {
				raiseMutationDiagnostic({
					reason: 'conflicting-assignment',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the ${flag.side} branch's membership is assigned both true and false in one statement`,
				});
			}
			flips.set(flag.side, value);
			continue;
		}
		// A surfaced inner flag (`inB`/`inC`) IS a view column, but writing it addresses a
		// branch INSIDE a subtree operand (product-coordinate addressing) — deferred to
		// `set-op-membership-nested`. Reject with a clean diagnostic (NOT `unknown-view-column`,
		// which would mislead — the name resolves).
		if (analysis.surfacedInnerFlagNames.some(n => n.toLowerCase() === asg.column.toLowerCase())) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': '${asg.column}' is a surfaced inner-branch membership flag of a nested set operation; writing it addresses a branch inside a subtree operand (product-coordinate addressing) — deferred to set-op-membership-nested`,
			});
		}
		const position = analysis.dataColNames.findIndex(n => n.toLowerCase() === asg.column.toLowerCase());
		if (position < 0) {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': '${asg.column}' is not a data or membership column of the set operation`,
				suggestion: `view '${view.name}' exposes: ${analysis.viewColNames.join(', ')}.`,
			});
		}
		dataAssignments.push({ position, value: asg.value });
	}

	// Contradiction: a `false` flip removes the row from its branch, but a data
	// assignment fans out to every member branch (including that one). The two effects on
	// the same branch contradict (write a column of a row being deleted). Reject rather
	// than silently pick one (parity with the join-existence write's `set npCol, hasB=false`).
	const anyFalseFlip = [...flips.values()].some(v => v === false);
	if (anyFalseFlip && dataAssignments.length > 0) {
		raiseMutationDiagnostic({
			reason: 'conflicting-assignment',
			table: view.name,
			message: `cannot write through view '${view.name}': a membership-flag write removes a branch (= false) while the same statement also writes a data column that fans out to that branch — the two effects contradict`,
		});
	}

	const capture = buildSetOpCapture(ctx, analysis, stmt.where);
	// A multi-source (INNER join) branch the fan reaches builds its own inner per-branch capture
	// chained off this outer capture; the fan accumulates them (`set-op-write-multisource-leg-compose`).
	const fan = makeJoinLegFan(capture);
	const baseOps: BaseOp[] = [];
	// A `set <joinFlag> = true` membership flip into a multi-source (INNER join) branch is built via
	// the plan-level shared-surrogate envelope and spliced as a nested `ViewMutationNode` child; the
	// accumulator threads into `buildBranchMembershipInsert` (mirror of the `fan` threading) and
	// rides the plan (`set-op-write-multisource-leg-insert`). The nested envelope source reads the
	// OUTER `__vmupd_keys` capture (built above for every UPDATE), so `buildSetOpMutation`'s
	// capture-injected `opCtx` resolves its `from __vmupd_keys`.
	const joinLegInserts: JoinLegInsert[] = [];

	// Data fan-out: update the row in every member leaf, recursing through a subtree operand
	// to its leaves. The full-data-tuple `exists` correlation restricts each leaf update to
	// the rows actually present there (a non-member leaf matches no row), so the per-branch
	// membership is honored without an explicit flag gate.
	if (dataAssignments.length > 0) {
		for (const branch of analysis.branches) {
			baseOps.push(...fanBranchDataUpdate(ctx, view, analysis, branch, dataAssignments, stmt, fan));
		}
	}

	// Membership flips. `= true` inserts into the branch (rejected for a subtree — a
	// multi-leaf insert has no single target leaf); `= false` is a delete fan-out (recurses
	// through a subtree to drop the row from its resident leaves).
	for (const branch of analysis.branches) {
		const flip = flips.get(branch.side);
		if (flip === undefined) continue;
		if (flip) {
			baseOps.push(...buildBranchMembershipInsert(ctx, view, analysis, branch, dataAssignments, stmt, joinLegInserts));
		} else {
			baseOps.push(...fanBranchDelete(ctx, view, analysis, branch, stmt, fan));
		}
	}

	if (baseOps.length === 0 && joinLegInserts.length === 0) {
		// Unreachable: the parser requires ≥1 assignment, and every assignment routes to a
		// flip or a data fan-out above. Guard defensively. (A lone join-branch `= true` flip
		// produces no base op of its own — it splices a nested envelope child — so it is
		// admitted via the `joinLegInserts` arm.)
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the update names no writable set-operation column`,
		});
	}
	return {
		baseOps,
		capture,
		nestedCaptures: fan.captures.length > 0 ? fan.captures : undefined,
		joinLegInserts: joinLegInserts.length > 0 ? joinLegInserts : undefined,
	};
}

/**
 * The captured subtree-membership boundary flag to gate a delete / data fan-out into an
 * `except` / `intersect` subtree operand on — `branch.flag.name`, the `exists <branch> as
 * <flag>` the OUTER compound declared for this side (a view output column, present in the
 * capture, so `k.<flag>` probes "is this captured row a member of the subtree").
 *
 * Gating the recursion on this flag restores soundness: for `except` / `intersect` a leaf can
 * hold rows the subtree EXCLUDES (e.g. a row in both B and C is absent from `B except C`); if
 * an OUTER operand makes that row visible it enters the capture, and a blind fan-out would
 * delete / mutate it in the inner leaves even though it is NOT a subtree member. AND-ing
 * `k.<flag>` into the leaf member-exists restricts the fan to genuine members, making the
 * nested fan behave exactly like the proven binary `except` / `intersect` fan.
 *
 * A **flag-less** non-union boundary (`A union[inA] (B except C)` — no `inSub`) surfaces no
 * boundary probe column to gate on, so it stays **deferred**: reject cleanly, naming
 * `set-op-membership-nested-except` (kept greppable as the remaining deferral).
 */
function gateFlagForNonUnionSubtree(view: MutableViewLike, branch: SetOpBranch): string {
	if (branch.flag) return branch.flag.name;
	const op = (branch.view.selectAst as AST.SelectStmt).compound?.op;
	raiseMutationDiagnostic({
		reason: 'unsupported-set-op',
		table: view.name,
		message: `cannot write through view '${view.name}': a delete / data fan-out through a flag-less ${(op ?? 'set').toUpperCase()} subtree operand is deferred — without a declared subtree-membership flag ('exists <branch> as <flag>') there is no captured boundary probe to gate the fan on, so it could touch leaf rows the subtree excludes (set-op-membership-nested-except)`,
	});
}

/**
 * Accumulate the membership gate for descending into a nested (subtree) `branch`: a **union /
 * union all** subtree adds nothing (a leaf ⊆ the subtree, so leaf-presence already implies
 * membership), an **`except` / `intersect`** subtree contributes its captured boundary flag
 * (`set-op-membership-nested-except`; a flag-less non-union boundary throws, staying deferred).
 * Shared by {@link fanBranchDataUpdate} and {@link fanBranchDelete} so the two fan paths cannot
 * drift on the gate logic.
 */
function accumulateInnerGate(view: MutableViewLike, branch: SetOpBranch, gateFlags: readonly string[]): readonly string[] {
	const subOp = (branch.view.selectAst as AST.SelectStmt).compound!.op;
	return isUnionLikeSubtree(subOp)
		? gateFlags
		: [...gateFlags, gateFlagForNonUnionSubtree(view, branch)];
}

/**
 * Fan a data-column UPDATE out to one branch — recursing through a nested (subtree) operand
 * to its member leaves, else updating the leaf's member rows (matched via the shared capture).
 *
 * The recursion reuses the SINGLE up-front capture: a subtree's leaves share the outer's data
 * columns (nesting preserves them), so "update the leaf rows whose data tuple ∈ `__vmupd_keys`"
 * is the same frozen-capture correlation rebuilt against each inner branch — no second capture.
 * The positional `dataAssignments` fan unchanged (each re-mapped to the leaf's own column name
 * at that data position via `branch.dataColNames[da.position]`); the value is cloned fresh at
 * each leaf (its refs resolve against that leaf's columns when leg names match — the v1 caveat).
 */
function fanBranchDataUpdate(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	dataAssignments: readonly DataAssignment[],
	stmt: AST.UpdateStmt,
	fan: JoinLegFan,
	gateFlags: readonly string[] = [],
): BaseOp[] {
	if (branch.isNested) {
		const innerGate = accumulateInnerGate(view, branch, gateFlags);
		const baseOps: BaseOp[] = [];
		for (const inner of analyzeSetOpBranches(view, branch.view, analysis.dataColCount)) {
			baseOps.push(...fanBranchDataUpdate(ctx, view, analysis, inner, dataAssignments, stmt, fan, innerGate));
		}
		return baseOps;
	}
	const assignments: { column: string; value: AST.Expression }[] = dataAssignments.map(da => ({
		column: branch.dataColNames[da.position],
		value: cloneExpr(da.value),
	}));
	const updateStmt: AST.UpdateStmt = {
		type: 'update',
		table: { type: 'identifier', name: branch.view.name },
		assignments,
		where: buildMemberExists(analysis, branch, gateFlags),
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	// A multi-source (INNER join) branch routes through the join decomposer + an inner per-branch
	// capture (chained off the outer set-op capture) rather than plain `propagate` (which builds
	// no capture and would collide the inner capture with the outer). § set-op-write-multisource-leg-compose.
	if (branch.isMultiSource) {
		return fanMultiSourceBranch(ctx, branch, updateStmt, fan,
			(joinAnalysis, name) => decomposeUpdate(ctx, branch.view, joinAnalysis, updateStmt, undefined, name));
	}
	return propagate(ctx, branch.view, { op: 'update', stmt: updateStmt });
}

/**
 * `set <flag> = true`: insert the captured rows that are **absent** from this branch
 * (`where not k.<flag>`) into it. Composed same-statement data assignments flow into the
 * inserted projection (the new value); every other data column reads the captured row.
 */
function buildBranchMembershipInsert(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	dataAssignments: readonly DataAssignment[],
	stmt: AST.UpdateStmt,
	joinLegInserts: JoinLegInsert[],
): BaseOp[] {
	if (branch.isNested) {
		// `set <subtreeFlag> = true` would insert the row into a multi-leaf subtree (B∪C) —
		// "which leaf?" has no single deterministic answer (product-coordinate addressing).
		// Deferred to `set-op-membership-nested`. (The `= false` flip routes to the delete
		// fan-out, which IS unambiguous — it touches every member leaf.)
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			column: branch.flag?.name,
			table: view.name,
			message: `cannot write through view '${view.name}': 'set ${branch.flag?.name ?? '<flag>'} = true' inserts into a multi-leaf subtree operand, which has no single deterministic target leaf (product-coordinate addressing) — deferred to set-op-membership-nested`,
		});
	}
	if (!branch.flag) {
		// Unreachable on the flip path (a flip targets a declared flag's side), but guard.
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the ${branch.side} branch has no membership flag to insert through`,
		});
	}
	const assignedByPosition = new Map<number, AST.Expression>();
	for (const da of dataAssignments) assignedByPosition.set(da.position, da.value);

	const projections: AST.ResultColumn[] = analysis.dataColNames.map((uName, i): AST.ResultColumn => {
		const assigned = assignedByPosition.get(i);
		const expr = assigned !== undefined
			? qualifyDataRefsWithCapture(view, analysis, assigned)
			: ({ type: 'column', name: uName, table: 'k' } as AST.ColumnExpr);
		return { type: 'column', expr, alias: branch.dataColNames[i] };
	});
	const source: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
		// Only the captured rows NOT already in this branch — the probe makes a redundant
		// `= true` a clean no-op (and folds the per-operator semantics: `except`'s right
		// flag is always false ⇒ insert all, `intersect`'s flags are always true ⇒ none).
		where: { type: 'unary', operator: 'NOT', expr: { type: 'column', name: branch.flag.name, table: 'k' } } as AST.UnaryExpr,
	};
	const insertStmt: AST.InsertStmt = {
		type: 'insert',
		table: { type: 'identifier', name: branch.view.name },
		columns: [...branch.dataColNames],
		source,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	// A `set <flag> = true` flip into a multi-source (INNER join) branch is built via the
	// plan-level shared-surrogate envelope (`buildMultiSourceInsert`) and spliced as a nested
	// `ViewMutationNode` child — record the descriptor and produce NO base op of our own
	// (`set-op-write-multisource-leg-insert`). The `source` SELECT reads the OUTER `__vmupd_keys`
	// capture (`where not k.<flag>`), so the envelope reuses it verbatim; `buildSetOpMutation`
	// passes the capture-injected context so its `from __vmupd_keys` resolves. A single-source
	// branch lowers through `propagate`.
	if (branch.isMultiSource) {
		joinLegInserts.push({ view: branch.view, stmt: insertStmt });
		return [];
	}
	return propagate(ctx, branch.view, { op: 'insert', stmt: insertStmt });
}

/**
 * Fan a DELETE out to one branch — recursing through a nested (subtree) operand to its member
 * leaves, else deleting the leaf's matching rows (every captured row present there). Serves
 * both the `delete from V` fan-out and the `set <subtreeFlag> = false` subtree drop (a
 * delete fan-out into the subtree's leaves), so it takes either originating statement and
 * reads only its shared `contextValues` / `schemaPath` / `loc`. Reuses the SINGLE up-front
 * capture (the same frozen-data-tuple correlation, rebuilt against each inner branch).
 */
function fanBranchDelete(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	stmt: AST.UpdateStmt | AST.DeleteStmt,
	fan: JoinLegFan,
	gateFlags: readonly string[] = [],
): BaseOp[] {
	if (branch.isNested) {
		const innerGate = accumulateInnerGate(view, branch, gateFlags);
		const baseOps: BaseOp[] = [];
		for (const inner of analyzeSetOpBranches(view, branch.view, analysis.dataColCount)) {
			baseOps.push(...fanBranchDelete(ctx, view, analysis, inner, stmt, fan, innerGate));
		}
		return baseOps;
	}
	const deleteStmt: AST.DeleteStmt = {
		type: 'delete',
		table: { type: 'identifier', name: branch.view.name },
		where: buildMemberExists(analysis, branch, gateFlags),
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	// A multi-source (INNER join) branch routes through the join decomposer + an inner per-branch
	// capture (chained off the outer set-op capture); a single-source branch lowers via `propagate`.
	if (branch.isMultiSource) {
		return fanMultiSourceBranch(ctx, branch, deleteStmt, fan,
			(joinAnalysis, name) => decomposeDelete(ctx, branch.view, joinAnalysis, deleteStmt, name));
	}
	return propagate(ctx, branch.view, { op: 'delete', stmt: deleteStmt });
}

// --- DELETE (fan-out via the probe) ---------------------------------------

function buildDelete(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.DeleteStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	const capture = buildSetOpCapture(ctx, analysis, stmt.where);
	const fan = makeJoinLegFan(capture);
	const baseOps: BaseOp[] = [];
	// Delete from every member leaf at every depth — the fan recurses through a subtree
	// operand to its leaves (the full-tuple `exists` correlation restricts each leaf delete to
	// its resident rows, so a non-member leaf matches none). A multi-source (INNER join) branch
	// builds its own inner per-branch capture chained off this outer capture.
	for (const branch of analysis.branches) {
		baseOps.push(...fanBranchDelete(ctx, view, analysis, branch, stmt, fan));
	}
	return { baseOps, capture, nestedCaptures: fan.captures.length > 0 ? fan.captures : undefined };
}

// --- INSERT (insert-through, flag-routed) ---------------------------------

function buildInsertThrough(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.InsertStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	if (stmt.source.type !== 'values') {
		raiseMutationDiagnostic({
			reason: 'unsupported-source',
			table: view.name,
			message: `cannot insert through view '${view.name}': a set-operation insert routes by literal membership flags, so it requires a VALUES source (a SELECT/DML source's per-row routing is deferred)`,
		});
	}

	// Resolve each VALUES position to a data column or a membership flag. An explicit
	// column list maps by name; an omitted list maps positionally over the view's output
	// layout (data columns then flags).
	const layout = resolveInsertLayout(view, analysis, stmt);

	// The flags route the insert: a true flag activates its branch, a false flag omits it.
	// The flag value must be a uniform boolean literal across the inserted rows (a per-row
	// mix is deferred), mirroring the join-existence insert directive.
	const activeSides = new Set<'left' | 'right'>();
	for (const flag of analysis.flags) {
		const pos = layout.flagPositions.get(flag.name.toLowerCase());
		if (pos === undefined) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: flag.name,
				table: view.name,
				message: `cannot insert through view '${view.name}': the membership flag '${flag.name}' must be supplied to route the insert to its branch (a flag-less multi-branch insert is ambiguous)`,
			});
		}
		if (uniformBooleanFlag(view, stmt.source.values, pos, flag.name)) activeSides.add(flag.side);
	}
	if (activeSides.size === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot insert through view '${view.name}': no membership flag is true, so the inserted row would belong to no branch (set at least one 'exists' flag true)`,
		});
	}

	const baseOps: BaseOp[] = [];
	// A multi-source (INNER join) branch's VALUES insert is built via the plan-level
	// shared-surrogate envelope (`buildMultiSourceInsert`) and spliced as a nested
	// `ViewMutationNode` child rather than routed through `propagate` (which would raise the
	// internal `unsupported-multisource-insert`) — `set-op-write-multisource-leg-insert`.
	const joinLegInserts: JoinLegInsert[] = [];
	for (const branch of analysis.branches) {
		if (!activeSides.has(branch.side)) continue;
		if (branch.isNested) {
			// Routing a VALUES row into a multi-leaf subtree operand has no single deterministic
			// target leaf (product-coordinate addressing) — deferred to `set-op-membership-nested`.
			// A leaf-only active side still inserts normally.
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				table: view.name,
				message: `cannot insert through view '${view.name}': the active routing flag targets a multi-leaf subtree operand, which has no single deterministic target leaf for a VALUES row (product-coordinate addressing) — deferred to set-op-membership-nested`,
			});
		}
		const values = stmt.source.values.map(row => layout.dataPositions.map(p => cloneExpr(row[p])));
		const source: AST.SelectStmt | AST.ValuesStmt = { type: 'values', values };
		const insertStmt: AST.InsertStmt = {
			type: 'insert',
			table: { type: 'identifier', name: branch.view.name },
			columns: [...branch.dataColNames],
			source,
			onConflict: stmt.onConflict,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		// The VALUES source is self-contained (no outer capture); the nested envelope sources
		// its values straight from it. A single-source branch lowers through `propagate`.
		if (branch.isMultiSource) {
			joinLegInserts.push({ view: branch.view, stmt: insertStmt });
		} else {
			baseOps.push(...propagate(ctx, branch.view, { op: 'insert', stmt: insertStmt }));
		}
	}
	// Insert-through reads no existing row, so it needs no capture (self-contained values).
	return { baseOps, joinLegInserts: joinLegInserts.length > 0 ? joinLegInserts : undefined };
}

interface InsertLayout {
	/** VALUES positions of the data columns, in data-column order. */
	readonly dataPositions: number[];
	/** Membership flag name (lowercase) → its VALUES position. */
	readonly flagPositions: Map<string, number>;
}

/** Map the insert's column list (explicit or positional) onto data columns + membership flags. */
function resolveInsertLayout(view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.InsertStmt): InsertLayout {
	const flagNames = new Set(analysis.flags.map(f => f.name.toLowerCase()));
	const dataNames = new Set(analysis.dataColNames.map(n => n.toLowerCase()));

	const cols = stmt.columns && stmt.columns.length > 0 ? stmt.columns : analysis.viewColNames;
	const dataByName = new Map<string, number>(); // data col name → VALUES position
	const flagPositions = new Map<string, number>();
	cols.forEach((rawName, pos) => {
		const name = rawName.toLowerCase();
		if (flagNames.has(name)) {
			flagPositions.set(name, pos);
		} else if (dataNames.has(name)) {
			dataByName.set(name, pos);
		} else {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column',
				column: rawName,
				table: view.name,
				message: `cannot insert through view '${view.name}': '${rawName}' is not a data or membership column of the set operation`,
				suggestion: `view '${view.name}' exposes: ${analysis.viewColNames.join(', ')}.`,
			});
		}
	});

	// Data columns must be supplied in full (the branches need every data column to build
	// a row); a missing one is left to the branch's own NOT NULL / default handling only
	// when truly omittable — v1 requires the data columns be supplied for an insert-through.
	const dataPositions = analysis.dataColNames.map(name => {
		const pos = dataByName.get(name.toLowerCase());
		if (pos === undefined) {
			raiseMutationDiagnostic({
				reason: 'no-default',
				column: name,
				table: view.name,
				message: `cannot insert through view '${view.name}': data column '${name}' is not supplied; a set-operation insert-through requires every data column`,
			});
		}
		return pos;
	});
	return { dataPositions, flagPositions };
}

// --- helpers --------------------------------------------------------------

/**
 * The correlated `exists (select 1 from __vmupd_keys k where <k matches the branch row>)`
 * a fan-out / membership-delete routes on. The match is a NULL-safe full-data-tuple
 * comparison: each data column is `k.c = b.c or (k.c is null and b.c is null)` (set
 * operations treat `NULL = NULL` as equal; the engine has no `IS NOT DISTINCT FROM`).
 * The branch columns are qualified with the synthetic branch-view name so {@link propagate}
 * lowers them to the target row (`__vm_self`); the `k.*` columns resolve to the injected
 * `__vmupd_keys` relation.
 *
 * In the nested fan-out the OUTER `analysis` is threaded unchanged, so `k.*` keeps naming the
 * one outer capture's data columns while `branch.*` names the inner leaf's — sound because a
 * subtree preserves the data columns at every depth (`buildBranch`'s arity check guarantees
 * `branch.dataColNames.length === analysis.dataColCount`).
 *
 * **Membership gate** (`set-op-membership-nested-except`). For a **union / union all** subtree
 * a leaf's rows ⊆ the subtree's, so the frozen capture selects exactly the leaf rows to touch
 * and no extra conjunct is needed (`gateFlags` empty). For an **`except` / `intersect`** subtree
 * a leaf can hold rows the subtree EXCLUDES; if an outer operand makes such a row visible it
 * enters the capture, and a blind fan-out would touch it in the leaves even though it is NOT a
 * subtree member. To stay sound, each non-union boundary descended contributes its captured
 * **subtree-membership boundary flag** (the `exists <branch> as <flag>` the OUTER compound
 * declared for that side, a view output column present in `__vmupd_keys`); `gateFlags` AND-s a
 * fresh `k.<flag>` per accumulated boundary into the predicate, restricting the fan to genuine
 * members. Fresh `ColumnExpr` nodes are built per call because the gate is reused across leaves.
 */
function buildMemberExists(analysis: SetOpAnalysis, branch: SetOpBranch, gateFlags: readonly string[] = []): AST.Expression {
	let pred: AST.Expression | undefined;
	for (let i = 0; i < analysis.dataColCount; i++) {
		const colMatch = nullSafeEqual(
			{ type: 'column', name: analysis.dataColNames[i], table: 'k' },
			{ type: 'column', name: branch.dataColNames[i], table: branch.view.name },
		);
		pred = pred ? { type: 'binary', operator: 'AND', left: pred, right: colMatch } : colMatch;
	}
	// AND the accumulated subtree-membership boundary flags in. `dataColCount > 0`
	// (checked in `analyzeSetOpView`) guarantees `pred` is defined here.
	for (const flag of gateFlags) {
		const flagRef: AST.Expression = { type: 'column', name: flag, table: 'k' };
		pred = pred ? { type: 'binary', operator: 'AND', left: pred, right: flagRef } : flagRef;
	}
	return {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
			where: pred,
		},
	} as AST.ExistsExpr;
}

/** `a = b or (a is null and b is null)` — null-safe equality built from primitives. */
function nullSafeEqual(a: AST.ColumnExpr, b: AST.ColumnExpr): AST.Expression {
	const eq: AST.Expression = { type: 'binary', operator: '=', left: { ...a }, right: { ...b } };
	const bothNull: AST.Expression = {
		type: 'binary',
		operator: 'AND',
		left: { type: 'unary', operator: 'IS NULL', expr: { ...a } } as AST.UnaryExpr,
		right: { type: 'unary', operator: 'IS NULL', expr: { ...b } } as AST.UnaryExpr,
	};
	return { type: 'binary', operator: 'OR', left: eq, right: bothNull };
}

/**
 * Rewrite a composed data-assignment value (in view / data-column terms) so its column
 * references read the captured row (`k.<col>`) — the membership-INSERT projection runs
 * over `__vmupd_keys`, not the branch. A reference to a membership flag, or to a name
 * that is neither a data column, is rejected (a data value cannot read a routing flag).
 */
function qualifyDataRefsWithCapture(view: MutableViewLike, analysis: SetOpAnalysis, value: AST.Expression): AST.Expression {
	const dataNames = new Set(analysis.dataColNames.map(n => n.toLowerCase()));
	return transformExpr(value, (col) => {
		if (col.table) return undefined; // already qualified (e.g. a correlated outer ref) — leave it
		if (dataNames.has(col.name.toLowerCase())) return { type: 'column', name: col.name, table: 'k' };
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			column: col.name,
			table: view.name,
			message: `cannot write through view '${view.name}': the membership-insert value references '${col.name}', which is not a data column; a data value cannot read a membership flag`,
		});
	});
}

/**
 * The uniform boolean directive a membership flag supplies on an insert-through — `true`
 * activates its branch, `false` omits it. Must be the SAME boolean literal across every
 * inserted row (a per-row branch on the value is deferred — `set-op-membership-nested`).
 */
function uniformBooleanFlag(view: MutableViewLike, rows: readonly AST.Expression[][], position: number, flagName: string): boolean {
	let flag: boolean | undefined;
	for (const row of rows) {
		const cell = row[position];
		const b = cell ? asBooleanLiteral(cell) : undefined;
		if (b === undefined) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: flagName,
				table: view.name,
				message: `cannot insert through view '${view.name}': the membership flag '${flagName}' must be a boolean literal (true/false); a non-literal per-row directive is deferred`,
			});
		}
		if (flag === undefined) flag = b;
		else if (flag !== b) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: flagName,
				table: view.name,
				message: `cannot insert through view '${view.name}': the membership flag '${flagName}' must be uniform across the inserted rows (a per-row mix of true/false is deferred)`,
			});
		}
	}
	return flag ?? false;
}

/**
 * The boolean value of a literal membership assignment (`true`/`false`, or the numeric
 * `1`/`0` spellings), or `undefined` for any non-literal / non-boolean value (a per-row
 * branch on the written value is deferred). Mirrors the join-existence write's gate.
 */
function asBooleanLiteral(expr: AST.Expression): boolean | undefined {
	if (expr.type !== 'literal') return undefined;
	const v = expr.value;
	if (v === true || v === false) return v;
	if (v === 1 || v === 1n) return true;
	if (v === 0 || v === 0n) return false;
	return undefined;
}

/** RETURNING through a set-op membership write is not yet recoverable — reject. */
function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `cannot write through view '${view.name}': RETURNING is not yet supported on a set-operation membership write (the per-branch fan-out yields no single recoverable view row)`,
		});
	}
}

// ===========================================================================
// Flag-less predicate-honest set-op writes (`set-op-flagless-predicate-honest-writes`)
// ===========================================================================
//
// The **preferred** write surface over the `exists`-membership path above: a flag-less
// set-op body whose legs carry *regular projected columns* — plain base columns plus
// literal **discriminators** (`'red' as kind`) — is writable for INSERT (routed to the
// consistent legs), DELETE / data-UPDATE (fanned to the consistent legs), with the
// literal discriminators **read-only** (a `set kind = …` surfaces `no-inverse`).
//
// It reuses the membership substrate verbatim — the up-front Halloween-safe capture
// ({@link buildSetOpCapture}), the per-branch recursive {@link propagate} lowering, the
// member-exists correlation ({@link buildMemberExists}), and the fan helpers
// ({@link fanBranchDelete} / {@link fanBranchDataUpdate}). The ONE difference is the
// per-leg branch oracle: instead of a runtime membership-probe flag, a leg's eligibility
// is decided at PLAN time by {@link checkSatisfiability} over (the leg's σ-derived facts
// ∧ its literal-discriminator bindings ∧ the mutation's predicate) — `unsat ⇒ skip the
// leg`, `sat / unknown ⇒ include it` (honest fan-out over silent suppression; the checker
// never emits a false `unsat`).
//
// **Option B (localized FD-gap closure).** A projected literal does NOT emit a constant
// FD today (`ProjectNode.computePhysical` only *forwards* the child's bindings through the
// source→output map, and a pure literal has no source attribute), so the routing
// discriminator does not fall out of the FD framework for free. Rather than enhance the
// hot physical path (Option A), the per-leg oracle reads the leg AST's literal projections
// directly and synthesizes the discriminator `ConstantBinding`s itself, feeding them to the
// checker alongside the leg's *planned* physical bindings (which DO carry the σ-on-projected
// constant, e.g. `where color='red'` forwarded to a `color`-projecting output column — the
// pre-existing half) and the mutation predicate. No physical-path change.

/**
 * The write classification of one leg result column: a writable plain (optionally
 * renamed) base-column projection, a read-only literal **discriminator** (a literal —
 * peeling Cast/Collate, the regular-projected-column routing idiom), or `null` when the
 * column is a `select *` / computed projection that makes the leg non-writable.
 */
type LegColumnKind =
	| { readonly kind: 'column'; readonly name: string }
	| { readonly kind: 'literal'; readonly value: SqlValue }
	| null;

/** Peel Cast/Collate wrappers to expose an underlying AST literal value, else `undefined`. */
function peelToLiteral(expr: AST.Expression): SqlValue | undefined {
	let e = expr;
	while (e.type === 'cast' || e.type === 'collate') e = e.expr;
	if (e.type !== 'literal') return undefined;
	const v = e.value;
	if (v instanceof Promise) return undefined;
	return v;
}

/** Classify one leg result column (the shadow of {@link tryBranchColumnNames}, admitting literals). */
function legColumnKind(rc: AST.ResultColumn): LegColumnKind {
	if (rc.type === 'all') return null;
	if (rc.expr.type === 'column') return { kind: 'column', name: rc.alias ?? rc.expr.name };
	const lit = peelToLiteral(rc.expr);
	if (lit !== undefined) return { kind: 'literal', value: lit };
	return null; // a computed (non-literal) projection — not a writable / discriminator shape
}

/** The supported flag-less writable shape: a uniform union-like chain, or a binary intersect/except. */
interface FlaglessShape {
	readonly op: 'union' | 'unionAll' | 'intersect' | 'except';
	/** Each leg as a leaf SELECT (no compound), in plan-layout order (left-most first). */
	readonly legSelects: readonly AST.SelectStmt[];
}

/** Strip a leg's own ORDER BY / LIMIT / OFFSET (those belong to the outer compound), keeping `compound`. */
function stripLegModifiers(sel: AST.SelectStmt): AST.SelectStmt {
	const { orderBy: _o, limit: _l, offset: _f, ...core } = sel;
	return core as AST.SelectStmt;
}

/** True iff a leg projects ≥1 literal discriminator (a routing constant). */
function hasLiteralDiscriminator(leaf: AST.SelectStmt): boolean {
	return leaf.columns.some(rc => legColumnKind(rc)?.kind === 'literal');
}

/** True iff a leaf SELECT is a writable flag-less leg: single-source, no compound, ≥1 plain/literal column, all admitted. */
function isWritableLeafLeg(leaf: AST.SelectStmt): boolean {
	if (leaf.compound) return false;
	// A multi-source (join) leg is writable for UPDATE / DELETE when it is an INNER join
	// (`set-op-write-multisource-leg-compose`, which builds an inner per-branch capture chained
	// off the outer set-op capture). `isInnerJoinBody` keys only on `joinType`, so a non-equi
	// (theta) INNER join is admitted here exactly as on the membership and standalone paths. An
	// OUTER (left/right/full) / cross join leg is deferred: falling to `false` here drops the
	// WHOLE body out of the flag-less route (via `flaglessShape`'s per-leg walk) → conservative
	// all-`NO` static surface + the single-source spine's clean `unsupported-set-op` reject.
	// (Comma joins are unreachable — the reader rejects multiple FROM sources at build time.)
	if (isJoinBody(leaf) && !isInnerJoinBody(leaf)) return false;
	if (!leaf.columns || leaf.columns.length === 0) return false;
	return leaf.columns.every(rc => legColumnKind(rc) !== null);
}

/**
 * The flag-less writable shape of a set-op body, or `null` when it is not one. A pure AST
 * peek (no plan built), the write-side shadow of {@link isSetOpBranchWritable} that ADMITS
 * literal discriminators (which `tryBranchColumnNames` rejects). Returns `null` for any
 * existence flag anywhere (mutual exclusion with {@link isSetOpMembershipBody}), a `diff`
 * body, a non-SELECT operand, a `select *` / computed leg, or a shape v1 does not flatten:
 *  - a **union-like** (`union` / `unionAll`) chain of any depth → N flat legs;
 *  - a **binary** `intersect` / `except` (a single depth-1 compound) → 2 legs;
 *  - anything else (a deep / mixed intersect/except chain) → `null` (kept on the existing reject).
 *
 * Each leg is stamped with the compound's declared `with schema` path when it has none of its
 * own (`withDeclaredPath`) — same rationale as {@link buildBranch}: the parser binds a trailing
 * `with schema` clause to the whole compound but attaches it only to the leading leg.
 */
function flaglessShape(sel: AST.SelectStmt): FlaglessShape | null {
	if (!sel.compound || sel.compound.op === 'diff') return null;
	if (sel.compound.existence && sel.compound.existence.length > 0) return null;
	const topOp = sel.compound.op;
	const legs: AST.SelectStmt[] = [];
	let cur: AST.SelectStmt = sel;
	// The compound's declared `with schema` path, carried forward to every leg that doesn't
	// carry its own (`withDeclaredPath`) — the parser attaches the clause to the leading leg's
	// statement node only, so legs 2..n would otherwise plan on the view's plain home path.
	let declared = sel.schemaPath;
	for (;;) {
		const leftLeg = withDeclaredPath(unwrapBranchSelect(leftBranchSelect(cur)), declared);
		if (!isWritableLeafLeg(leftLeg)) return null;
		legs.push(leftLeg);
		const right = cur.compound!.select;
		if (right.type !== 'select') return null;
		const rightEff = withDeclaredPath(unwrapBranchSelect(stripLegModifiers(right)), declared);
		if (!rightEff.compound) {
			if (!isWritableLeafLeg(rightEff)) return null;
			legs.push(rightEff);
			// A union / union all needs ≥1 literal discriminator to route an insert honestly —
			// without one every leg is consistent with every row, so the routing is ambiguous
			// (the flag-less analog of the membership path's "a flag-less multi-branch insert is
			// ambiguous"). Such a body stays on the existing phase-1 reject. `intersect` / `except`
			// route by the OPERATOR (every leg / the left operand), so they need no discriminator.
			if (isUnionLikeSubtree(topOp) && !legs.some(hasLiteralDiscriminator)) return null;
			return { op: topOp, legSelects: legs };
		}
		// The chain continues: only a uniform union-like chain may descend past depth 1; an
		// intersect / except is supported only as a single binary compound (its associativity
		// matters and is deferred for chains).
		if (rightEff.compound.op !== topOp || !isUnionLikeSubtree(topOp)) return null;
		if (rightEff.compound.existence && rightEff.compound.existence.length > 0) return null;
		// A parenthesized sub-compound's own declared path (already preserved by
		// `withDeclaredPath` above) wins for its own legs as the chain continues.
		declared = rightEff.schemaPath ?? declared;
		cur = rightEff;
	}
}

/**
 * True iff `selectAst` is a flag-less set-op body writable through predicate-honest branch
 * dispatch (`set-op-flagless-predicate-honest-writes`). Mutually exclusive with
 * {@link isSetOpMembershipBody} (any `exists … as <flag>` takes the membership path); a
 * non-decomposable shape (outer LIMIT/OFFSET, `select *` / computed leg, deep intersect/except)
 * returns `false` and keeps rejecting `unsupported-set-op` through the single-source spine.
 */
export function isSetOpFlaglessWritableBody(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.compound) return false;
	if (selectAst.limit || selectAst.offset) return false;
	return flaglessShape(selectAst) !== null;
}

/**
 * The flag-less view's **discriminator** column names — every data column projected as a
 * literal in ANY leg (read-only, `no-inverse` on UPDATE). The view's column names come from
 * the left-most leg (a set op takes its left child's names); a position is a discriminator
 * iff some leg pins it with a literal projection. Used by the `column_info` static surface
 * to report the discriminator `is_updatable = NO` (data / plain columns report YES).
 */
export function flaglessDiscriminatorColumnNames(selectAst: AST.QueryExpr): string[] {
	if (selectAst.type !== 'select') return [];
	const shape = flaglessShape(selectAst);
	if (!shape) return [];
	const first = shape.legSelects[0];
	const out: string[] = [];
	for (let i = 0; i < first.columns.length; i++) {
		const anyLiteral = shape.legSelects.some(leg => legColumnKind(leg.columns[i])?.kind === 'literal');
		if (!anyLiteral) continue;
		const rc = first.columns[i];
		const name = rc.type === 'column' ? (rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined)) : undefined;
		if (name) out.push(name);
	}
	return out;
}

/** One leg of a flag-less writable set-op body, with its plan-time routing oracle inputs. */
interface FlaglessLeg {
	/** The branch view-like + data-column names, reused with the membership fan helpers. */
	readonly branch: SetOpBranch;
	/** Data-column positions projecting a plain (writable) base column. */
	readonly plainPositions: readonly number[];
	/** Data-column positions projecting a literal discriminator (read-only). */
	readonly discriminatorPositions: readonly number[];
	/** A scope resolving each view data-column name to this leg's planned output attribute. */
	readonly scope: Scope;
	/** The leg's σ-forwarded physical bindings ++ the synthesized literal-discriminator bindings. */
	readonly bindings: readonly ConstantBinding[];
	/** The leg's planned physical domain constraints. */
	readonly domains: readonly DomainConstraint[];
	/**
	 * Every σ (`FilterNode.predicate`) conjunct in the leg body, fed to the oracle alongside
	 * the mutation predicate. A range σ (`where x < 5`) on a *projected* column does not forward
	 * as a `ConstantBinding`/`DomainConstraint` (filter passes domains through unchanged), so an
	 * out-of-range INSERT would otherwise route into the leg and land a phantom base row. These
	 * conjuncts close that gap: `x = 7 ∧ x < 5 ⇒ unsat ⇒ skip the leg`. Conjuncts on a
	 * non-projected column resolve to `attrIndex → undefined` and contribute nothing.
	 */
	readonly sigmaConjuncts: readonly ScalarPlanNode[];
	/** Maps a predicate `ColumnReferenceNode.attributeId` to this leg's output column index. */
	readonly attrIndex: (attrId: number) => number | undefined;
	/** The declared collation of this leg's output column `col`, for the checker. */
	readonly getCollation: (col: number) => string | undefined;
	/** Resolves those collation names against the owning database, so a collation registered
	 *  with `db.registerCollation(...)` is honored rather than silently degraded to BINARY —
	 *  which could mint a false `unsat` and skip a leg the incoming row belongs in. */
	readonly collationResolver: CollationResolver;
}

/** Decompose a flag-less set-op view mutation. Throws a structured diagnostic for unsupported shapes. */
export function buildFlaglessSetOpWrite(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): SetOpWritePlan {
	const { analysis, legs } = analyzeFlaglessSetOpView(ctx, view);
	switch (req.op) {
		case 'insert': return buildFlaglessInsert(ctx, view, analysis, legs, req.stmt);
		case 'update': return buildFlaglessUpdate(ctx, view, analysis, legs, req.stmt);
		case 'delete': return buildFlaglessDelete(ctx, view, analysis, legs, req.stmt);
	}
}

function analyzeFlaglessSetOpView(ctx: PlanningContext, view: MutableViewLike): { analysis: SetOpAnalysis; legs: FlaglessLeg[] } {
	if (view.selectAst.type !== 'select' || !view.selectAst.compound) {
		raiseMutationDiagnostic({ reason: 'unsupported-set-op', table: view.name, message: `cannot write through view '${view.name}': not a set-operation body` });
	}
	const sel = view.selectAst;
	const shape = flaglessShape(sel);
	if (!shape) {
		raiseMutationDiagnostic({ reason: 'unsupported-set-op', table: view.name, message: `cannot write through view '${view.name}': not a flag-less predicate-honest writable set-operation body` });
	}

	// Plan the body ONCE: a flag-less body has no flag columns, so the root attributes ARE
	// the view's data columns (positionally aligned to every leg's projection). A STORED
	// body plans on its own home-schema path (`bodyPlanningContext`).
	const root = buildSelectStmt(bodyPlanningContext(ctx, view), sel);
	if (!isRelationalNode(root)) {
		raiseMutationDiagnostic({ reason: 'no-base-lineage', table: view.name, message: `cannot write through view '${view.name}': the set-operation body did not produce a relation` });
	}
	const relRoot = root as RelationalPlanNode;
	const setOpNode = findSetOpNode(relRoot);
	if (!setOpNode) {
		raiseMutationDiagnostic({ reason: 'no-base-lineage', table: view.name, message: `cannot write through view '${view.name}': the set-operation body produced no SetOperationNode` });
	}
	const dataColCount = setOpNode.dataColumnCount();
	const attrs = relRoot.getAttributes();
	const dataColNames = attrs.map(a => a.name);
	const dataColTypes = attrs.map(a => a.type);

	// A scope resolving each view data-column name to its producing attribute over the planned
	// root — reused by `buildSetOpCapture` for the user-predicate / capture projections.
	const viewColScope = new RegisteredScope(ctx.scope);
	attrs.forEach((attr, i) => {
		viewColScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
	});

	const legs = shape.legSelects.map((legSel, i) => buildFlaglessLeg(ctx, view, legSel, i, dataColNames));
	// A `SetOpAnalysis`-shaped carrier so the membership fan helpers / capture builder are
	// reused verbatim. `branches` is a 2-tuple by type; the flag-less fan iterates `legs`
	// (which may be > 2) and never reads `branches`, so the first two legs satisfy the type.
	const branches: [SetOpBranch, SetOpBranch] = [legs[0].branch, legs[1].branch];
	const analysis: SetOpAnalysis = {
		op: shape.op, root: relRoot, viewColScope,
		viewColNames: dataColNames, viewColTypes: dataColTypes,
		dataColCount, dataColNames, surfacedInnerFlagNames: [], flags: [], branches,
	};
	return { analysis, legs };
}

/**
 * Build one flag-less leg: a synthetic branch view-like (its columns re-aliased to the view
 * data-column names so the member-exists correlation and the base ops align positionally),
 * plus the plan-time routing oracle inputs (the leg's planned σ-forwarded bindings + the
 * synthesized literal-discriminator bindings).
 */
function buildFlaglessLeg(
	ctx: PlanningContext,
	view: MutableViewLike,
	legSel: AST.SelectStmt,
	index: number,
	dataColNames: readonly string[],
): FlaglessLeg {
	const dataColCount = dataColNames.length;
	const kinds = legSel.columns.map(legColumnKind);
	if (kinds.length !== dataColCount || kinds.some(k => k === null)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op', table: view.name,
			message: `cannot write through view '${view.name}': a leg projects ${kinds.length} columns (expected ${dataColCount}) or a non-writable (\`select *\` / computed) column`,
		});
	}

	// Re-alias every leg column to the view data-column name at its position, so the synthetic
	// branch view exposes exactly the view's data columns (a plain base column round-trips
	// through `propagate`; a literal discriminator resolves to its constant). This makes the
	// member-exists `b.<col>` references and the base ops align regardless of the leg's own
	// aliases / base-column names.
	const aliasedColumns: AST.ResultColumn[] = legSel.columns.map((rc, i) => ({
		type: 'column', expr: (rc as AST.ResultColumnExpr).expr, alias: dataColNames[i],
	}));
	const effectiveSelect: AST.SelectStmt = { ...legSel, columns: aliasedColumns };
	// `ephemeral` rides along for the same reason as the flagged branch views above: a branch
	// of an ephemeral target keeps the caller's schema path, not the home path. Defensive here
	// — unlike the membership dispatch, the flag-less dispatch in `view-mutation-builder.ts` is
	// itself `!view.ephemeral`-gated, so no ephemeral target reaches this builder today.
	const branchView: MutableViewLike = {
		name: `__setop_leg${index}`, schemaName: view.schemaName, selectAst: effectiveSelect,
		...(view.ephemeral ? { ephemeral: true } : {}),
	};
	// A flag-less join leg is always an INNER join here: `isWritableLeafLeg` (the recognizer
	// `flaglessShape` gated on) admits only single-source or INNER-join legs, so an outer / cross
	// leg never reaches this builder (the body falls out of the flag-less route).
	const branch: SetOpBranch = { side: index === 0 ? 'left' : 'right', view: branchView, dataColNames: [...dataColNames], isNested: false, isMultiSource: isJoinBody(legSel) };

	const plainPositions = kinds.flatMap((k, i) => k!.kind === 'column' ? [i] : []);
	const discriminatorPositions = kinds.flatMap((k, i) => k!.kind === 'literal' ? [i] : []);

	// Plan the leg body for the oracle: its output attributes carry the σ-forwarded constant
	// bindings / domains (the pre-existing half — a `where color='red'` over a `color`-projecting
	// leg forwards `∅ → color='red'` to the output column). The synthesized discriminator
	// bindings (Option B) close the projected-literal gap. The leg is part of the same stored
	// body, so it plans on the same home-schema path (`bodyPlanningContext`).
	const planned = buildSelectStmt(bodyPlanningContext(ctx, view), effectiveSelect);
	if (!isRelationalNode(planned)) {
		raiseMutationDiagnostic({ reason: 'no-base-lineage', table: view.name, message: `cannot write through view '${view.name}': a leg did not produce a relation` });
	}
	const legRoot = planned as RelationalPlanNode;
	const legAttrs = legRoot.getAttributes();
	const attrIdToIndex = new Map<number, number>();
	legAttrs.forEach((a, i) => attrIdToIndex.set(a.id, i));
	const scope = new RegisteredScope(ctx.scope);
	legAttrs.forEach((attr, i) => {
		scope.registerSymbol(dataColNames[i].toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
	});

	const discriminatorBindings: ConstantBinding[] = [];
	kinds.forEach((k, i) => {
		if (k!.kind === 'literal' && k!.value !== null) {
			discriminatorBindings.push({ attrs: [i], value: { kind: 'literal', value: k!.value } });
		}
	});
	const physical = legRoot.physical;
	const bindings: ConstantBinding[] = [...(physical.constantBindings ?? []), ...discriminatorBindings];
	const domains = physical.domainConstraints ?? [];
	const sigmaConjuncts = collectFilterConjuncts(legRoot);

	return {
		branch, plainPositions, discriminatorPositions, scope, bindings, domains, sigmaConjuncts,
		attrIndex: (attrId) => attrIdToIndex.get(attrId),
		getCollation: (col) => legAttrs[col]?.type.collationName,
		collationResolver: ctx.db.getCollationResolver(),
	};
}

/**
 * Collect every leg-body σ predicate as a flat conjunct list: each `FilterNode.predicate` in
 * the leg's relational subtree (walked via `getRelations()`) split into its AND-conjuncts. Every
 * collected conjunct is a fact that must hold for a row resident in this leg, so feeding them all
 * to the oracle can only ever push the verdict toward `unsat` on a real contradiction (the checker
 * never emits a false `unsat`). A conjunct referencing a column this leg does not project resolves
 * to `attrIndex → undefined` and contributes nothing.
 */
function collectFilterConjuncts(root: RelationalPlanNode): ScalarPlanNode[] {
	const out: ScalarPlanNode[] = [];
	const visit = (node: RelationalPlanNode): void => {
		if (node instanceof FilterNode) out.push(...splitConjuncts(node.predicate));
		for (const child of node.getRelations()) visit(child);
	};
	visit(root);
	return out;
}

/**
 * The per-leg branch oracle (`set-op-flagless-predicate-honest-writes`): is a row satisfying
 * `predicate` possible in this leg? Feeds the mutation predicate (in view data-column terms,
 * resolved against the leg's planned attributes) as conjuncts, alongside the leg's σ-forwarded
 * + literal-discriminator bindings, into {@link checkSatisfiability}. `unsat` ⇒ skip the leg;
 * `sat` / `unknown` ⇒ include it (the checker never emits a false `unsat`). A `predicate` of
 * `undefined` (no WHERE / no supplied values) is unconstrained ⇒ `sat`.
 */
function legConsistency(ctx: PlanningContext, leg: FlaglessLeg, predicate: AST.Expression | undefined): SatResult {
	let conjuncts: ScalarPlanNode[] = [];
	if (predicate) {
		const node = buildExpression({ ...ctx, scope: leg.scope }, cloneExpr(predicate));
		conjuncts = splitConjuncts(node);
	}
	// Fold the leg's own σ conjuncts in alongside the mutation predicate: a range σ on a
	// projected column (`where x < 5`) is invisible to the bindings/domains the leg forwards,
	// so a supplied value that provably violates it (`x = 7`) only contradicts here ⇒ `unsat`
	// ⇒ skip the leg (no phantom base row). Non-projected-column conjuncts are inert.
	return checkSatisfiability(
		[...conjuncts, ...leg.sigmaConjuncts], leg.domains, leg.bindings,
		leg.attrIndex, leg.getCollation, leg.collationResolver,
	);
}

// --- flag-less INSERT (route to the consistent legs) ----------------------

interface FlaglessInsertLayout {
	/** View data-column position → its index in each VALUES row. Omitted columns are absent. */
	readonly valueIndexByDataPos: ReadonlyMap<number, number>;
}

function resolveFlaglessInsertLayout(view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.InsertStmt): FlaglessInsertLayout {
	const cols = stmt.columns && stmt.columns.length > 0 ? stmt.columns : analysis.dataColNames;
	const map = new Map<number, number>();
	cols.forEach((rawName, vi) => {
		const pos = analysis.dataColNames.findIndex(n => n.toLowerCase() === rawName.toLowerCase());
		if (pos < 0) {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column', column: rawName, table: view.name,
				message: `cannot insert through view '${view.name}': '${rawName}' is not a column of the set operation`,
				suggestion: `view '${view.name}' exposes: ${analysis.dataColNames.join(', ')}.`,
			});
		}
		map.set(pos, vi);
	});
	return { valueIndexByDataPos: map };
}

/** The existence predicate of one VALUES row: `∧ <dataCol> = <suppliedValue>` over the supplied columns. */
function rowExistencePredicate(analysis: SetOpAnalysis, layout: FlaglessInsertLayout, row: readonly AST.Expression[]): AST.Expression | undefined {
	let pred: AST.Expression | undefined;
	for (const [pos, vi] of layout.valueIndexByDataPos) {
		const eq: AST.Expression = {
			type: 'binary', operator: '=',
			left: { type: 'column', name: analysis.dataColNames[pos] } as AST.ColumnExpr,
			right: row[vi],
		};
		pred = pred ? { type: 'binary', operator: 'AND', left: pred, right: eq } : eq;
	}
	return pred;
}

/** The legs a flag-less INSERT routes into by operator: `except` inserts the left operand only. */
function fanLegsForInsert(op: SetOpAnalysis['op'], legs: readonly FlaglessLeg[]): readonly FlaglessLeg[] {
	return op === 'except' ? [legs[0]] : legs;
}

function buildFlaglessInsert(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, legs: readonly FlaglessLeg[], stmt: AST.InsertStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	if (stmt.source.type !== 'values') {
		raiseMutationDiagnostic({
			reason: 'unsupported-source', table: view.name,
			message: `cannot insert through view '${view.name}': a flag-less set-operation insert routes by the supplied discriminator values, so it requires a VALUES source (a SELECT/DML source's per-row routing is deferred)`,
		});
	}
	const values = stmt.source.values;
	const layout = resolveFlaglessInsertLayout(view, analysis, stmt);
	const baseOps: BaseOp[] = [];
	// A multi-source (INNER join) leg's INSERT is built via the plan-level shared-surrogate
	// envelope (`buildMultiSourceInsert`) and spliced as a nested `ViewMutationNode` child rather
	// than routed through `propagate` (which would raise the internal `unsupported-multisource-insert`)
	// — `set-op-write-multisource-leg-insert`. The VALUES source is self-contained.
	const joinLegInserts: JoinLegInsert[] = [];
	for (const leg of fanLegsForInsert(analysis.op, legs)) {
		// Per-row routing: a row inserts into this leg unless provably inconsistent with it.
		const rows = values.filter(row => legConsistency(ctx, leg, rowExistencePredicate(analysis, layout, row)) !== 'unsat');
		if (rows.length === 0) continue;
		// Only the leg's PLAIN (writable) columns that are supplied flow into the base insert;
		// the literal discriminators are determined by the leg projection / σ (omitted base
		// columns are recovered by the leg's `where`-constant FD insert-defaulting).
		const supplied = leg.plainPositions.filter(pos => layout.valueIndexByDataPos.has(pos));
		if (supplied.length === 0) continue; // an all-literal / unsupplied leg has no base row to write
		const colNames = supplied.map(pos => analysis.dataColNames[pos]);
		const valueRows = rows.map(row => supplied.map(pos => cloneExpr(row[layout.valueIndexByDataPos.get(pos)!])));
		const source: AST.SelectStmt | AST.ValuesStmt = { type: 'values', values: valueRows };
		const insertStmt: AST.InsertStmt = {
			type: 'insert',
			table: { type: 'identifier', name: leg.branch.view.name },
			columns: colNames,
			source,
			onConflict: stmt.onConflict,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		if (leg.branch.isMultiSource) {
			joinLegInserts.push({ view: leg.branch.view, stmt: insertStmt });
		} else {
			baseOps.push(...propagate(ctx, leg.branch.view, { op: 'insert', stmt: insertStmt }));
		}
	}
	if (baseOps.length === 0 && joinLegInserts.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op', table: view.name,
			message: `cannot insert through view '${view.name}': the supplied values are consistent with no writable leg (the row would belong to no branch)`,
		});
	}
	// Insert-through reads no existing row, so it needs no capture (self-contained values).
	return { baseOps, joinLegInserts: joinLegInserts.length > 0 ? joinLegInserts : undefined };
}

// --- flag-less DELETE / data-UPDATE (fan to the consistent legs) ----------

/** The legs a flag-less DELETE / data-UPDATE fans to: every consistent leg (`except` fans the left only). */
function fanLegsForFanOut(ctx: PlanningContext, op: SetOpAnalysis['op'], legs: readonly FlaglessLeg[], where: AST.Expression | undefined): FlaglessLeg[] {
	const consistent = legs.filter(l => legConsistency(ctx, l, where) !== 'unsat');
	if (op === 'except') return consistent.includes(legs[0]) ? [legs[0]] : [];
	return consistent;
}

function buildFlaglessDelete(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, legs: readonly FlaglessLeg[], stmt: AST.DeleteStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	const capture = buildSetOpCapture(ctx, analysis, stmt.where);
	const fan = makeJoinLegFan(capture);
	const baseOps: BaseOp[] = [];
	for (const leg of fanLegsForFanOut(ctx, analysis.op, legs, stmt.where)) {
		baseOps.push(...fanBranchDelete(ctx, view, analysis, leg.branch, stmt, fan));
	}
	return { baseOps, capture, nestedCaptures: fan.captures.length > 0 ? fan.captures : undefined };
}

function buildFlaglessUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, legs: readonly FlaglessLeg[], stmt: AST.UpdateStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	// A literal discriminator is read-only (it has no base inverse). Reject a write to one
	// up front with `no-inverse` (Finding 5) — NOT silently routed.
	const discriminators = new Set<number>();
	for (const leg of legs) for (const p of leg.discriminatorPositions) discriminators.add(p);
	const dataAssignments: DataAssignment[] = [];
	for (const asg of stmt.assignments) {
		const position = analysis.dataColNames.findIndex(n => n.toLowerCase() === asg.column.toLowerCase());
		if (position < 0) {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column', column: asg.column, table: view.name,
				message: `cannot write through view '${view.name}': '${asg.column}' is not a column of the set operation`,
				suggestion: `view '${view.name}' exposes: ${analysis.dataColNames.join(', ')}.`,
			});
		}
		if (discriminators.has(position)) {
			raiseMutationDiagnostic({
				reason: 'no-inverse', column: asg.column, table: view.name,
				message: `cannot write through view '${view.name}': '${asg.column}' is a literal discriminator column (it routes rows to a branch and has no base-column inverse) — it is read-only`,
			});
		}
		dataAssignments.push({ position, value: asg.value });
	}
	const capture = buildSetOpCapture(ctx, analysis, stmt.where);
	const fan = makeJoinLegFan(capture);
	const baseOps: BaseOp[] = [];
	for (const leg of fanLegsForFanOut(ctx, analysis.op, legs, stmt.where)) {
		baseOps.push(...fanBranchDataUpdate(ctx, view, analysis, leg.branch, dataAssignments, stmt, fan));
	}
	return { baseOps, capture, nestedCaptures: fan.captures.length > 0 ? fan.captures : undefined };
}
