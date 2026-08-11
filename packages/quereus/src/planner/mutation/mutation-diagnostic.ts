import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Structured reason codes raised when a mutation cannot be propagated through a
 * view. The Phase-1 / 1b rows of the diagnostics union in
 * `docs/view-updateability.md`, plus the "body shape not handled yet" rejections
 * that keep the shipped contract honest (`93.2-view-mutation-pending`).
 */
export type MutationDiagnosticReason =
	// --- doc's structured diagnostics ---
	| 'no-inverse'                 // non-invertible scalar on an update path (Project)
	| 'unknown-view-column'        // a top-level where/set/returning ref names something that is not a column of the view (the encapsulation-leak guard)
	| 'no-default'                 // insert missing a NOT NULL column after the recovery chain
	| 'predicate-contradiction'    // insert violates the view's selection at plan time (Filter)
	| 'recursive-cte'              // recursive CTE as mutation target
	| 'default-target-not-found'   // a `with defaults (col = expr, …)` clause entry names a column that is neither a view nor a base column
	| 'mutual-fk-restrict-delete'  // a two-side join DELETE fan-out spans a mutual FK whose ON DELETE actions cannot be satisfied in ANY side order under immediate enforcement (deleting either side trips the other's RESTRICT, directly or transitively through a cascade); break the cycle by clearing the referencing column(s) first (deferring the constraint does not help — RESTRICT is always immediate)
	// --- "not yet shipped" body-shape rejections (Phase 2+) ---
	| 'unsupported-join'           // join body — Phase 2 / 4
	| 'unsupported-aggregate'      // aggregate / grouping body
	| 'unsupported-set-op'         // union / intersect / except body
	| 'unsupported-window'         // window function in body
	| 'unsupported-limit'          // LIMIT / OFFSET body — a mutation would escape the window
	| 'unsupported-distinct'       // DISTINCT body — not row-decomposable (no 1:1 base lineage)
	| 'no-base-lineage'            // VALUES body / no reachable base table
	| 'nested-view'                // body sources another view / CTE (inline-propagation deferred)
	| 'unsupported-body-cte-dml'   // the view body's own WITH clause defines a data-modifying block (`with m as (insert … returning …)`); the lowering carries the body's definitions into the base statement and cannot carry a DML one
	| 'unsupported-source'         // INSERT source shape we cannot thread filter defaults through yet
	| 'unsupported-multisource-insert' // INSERT into a join view — needs the shared-surrogate context (later phase)
	| 'cross-source-assignment'    // UPDATE value references a base table other than the column it assigns
	| 'cross-source-ambiguous-cardinality' // cross-source UPDATE value reads a partner column, but the assigned side joins MORE THAN ONE partner row (the join does not constrain the partner to a unique key), so the partner value is ambiguous (the 1:many cross-source `set` reject)
	| 'unsupported-outer-join-update' // UPDATE assigns a non-preserved (outer-join null-extended) column — the matched→update / null-extended→insert per-row branch needs runtime materialization (deferred to view-write-optional-member-transitions)
	| 'null-extended-create-conflict' // INSERT supplies only non-preserved-side columns through an outer join with no preserved-side row to attach to (the envelope mints/threads the shared key from the preserved anchor — v1 rejects the non-preserved-only insert)
	| 'conflicting-assignment'     // two SET targets lower to the same base column (e.g. two view columns over one base column); an UPDATE cannot assign one column twice
	| 'unsupported-subquery-correlation' // a view-column ref nested in a predicate/value subquery cannot be proven correlated (unresolvable source / select * / TVF / embedded DML)
	| 'returning-through-view'     // RETURNING projected through a view — Phase 6
	| 'lens-read-only'             // logical table whose PK is not reconstructible at the lens boundary
	| 'lens-set-level-conflict-resolution' // or replace / or ignore / upsert against a commit-time set-level lens key (needs a covering structure)
	| 'lens-row-local-unenforceable' // a row-local logical CHECK on a decomposition write cannot be evaluated on the logical row (the shared key is hidden/composite, so the post-write logical row cannot be addressed) — refuse loudly rather than skip enforcement
	// --- decomposition (lens multi-source put) fan-out, advertisement-driven ---
	| 'unsupported-decomposition-insert'    // internal guard: a decomposition INSERT is built via buildDecompositionInsert (envelope), not propagate
	| 'unsupported-decomposition-update'    // UPDATE targets a decomposition shared-key (identity) column, or assigns an optional/EAV member a non-constant value (which would need the per-row capture substrate) — the optional/EAV constant-value materialization itself is supported
	| 'unsupported-decomposition-predicate' // a decomposition DELETE/UPDATE WHERE references a non-anchor member — needs snapshot-consistent multi-member execution (deferred)
	| 'unsupported-decomposition-key'       // the single-column shared-key envelope cannot express this n-way shape: a decomposition member has a composite/absent shared key (v1 is single-column), OR a multi-source outer-join INSERT threads ONE shared key column into >1 presence-gated (optional) parent — one key value cannot reference some-but-not-all parents per row, so a partial-supply row would silently lose the value and orphan a parent (`view-write-outer-insert-shared-key-multi-parent-orphan`)
	| 'unsupported-decomposition-member';   // two decomposition members resolve to the same base relation (a self-decomposition) — member routing is ambiguous

/**
 * Structured mutation diagnostic. Mirrors the `MutationDiagnostic` shape in
 * `docs/view-updateability.md` (kept as `reason` + human `message` here; the
 * `planNodeId` field is omitted in Phase 1 since rejection happens at build
 * time before optimization assigns physical ids).
 */
export interface MutationDiagnostic {
	readonly reason: MutationDiagnosticReason;
	readonly message: string;
	/** The obstructing column, when one applies. */
	readonly column?: string;
	/** The base/view table involved, when one applies. */
	readonly table?: string;
	/** Copy-pasteable remediation fragment (e.g. a DEFAULT-declaration recipe). */
	readonly suggestion?: string;
}

/**
 * Error raised when view-mediated mutation propagation fails. Carries the
 * structured {@link MutationDiagnostic} on `.mutationDiagnostic` so callers can
 * inspect the machine-readable reason; the human message (with any suggestion
 * appended) is the `Error.message`.
 */
export class ViewMutationError extends QuereusError {
	readonly mutationDiagnostic: MutationDiagnostic;

	constructor(diagnostic: MutationDiagnostic, line?: number, column?: number) {
		const full = diagnostic.suggestion
			? `${diagnostic.message} ${diagnostic.suggestion}`
			: diagnostic.message;
		super(full, StatusCode.ERROR, undefined, line, column);
		this.name = 'ViewMutationError';
		this.mutationDiagnostic = diagnostic;
	}
}

/** Build and throw a {@link ViewMutationError}. */
export function raiseMutationDiagnostic(diagnostic: MutationDiagnostic, line?: number, column?: number): never {
	throw new ViewMutationError(diagnostic, line, column);
}
