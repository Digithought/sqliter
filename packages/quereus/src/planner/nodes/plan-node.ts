import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { BaseType, RelationType, ScalarType } from '../../common/datatype.js';
import type { Expression } from '../../parser/ast.js';
import type { OutputValue, Row, SqlValue } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

/**
 * Information about an attribute the relation is monotonically ordered on.
 * Stronger than `ordering`: meaningful only for total-order-preserving sources
 * (vtab access plans that advertise it; sort nodes; certain merge operators)
 * and survives only the propagation rules documented in characteristics.ts.
 */
export interface MonotonicOnInfo {
  /** Attribute over which the relation is ordered. Stable across plan transformations. */
  readonly attrId: number;
  /** True iff the relation guarantees no two rows share the value of attrId. */
  readonly strict: boolean;
  /** Direction; default 'asc'. */
  readonly direction: 'asc' | 'desc';
}

/**
 * A functional dependency on a relational node's output columns: when the
 * values of `determinants` are fixed, the values of `dependents` are also
 * fixed for every row.
 *
 * Column indices are output-column indices.
 *
 * - `determinants` empty means "constant": the dependents take a single value
 *   for every row in the relation. An FD `∅ → all_cols` is the canonical
 *   marker for an "at-most-one-row" relation.
 * - A unique key `K` is encoded as the FD `K → (all_cols \ K)` with
 *   `kind: 'unique'`. Consumers ask "is K row-unique?" via
 *   `isUniqueDeterminant(K, fds, columnCount, isSet)` from
 *   `planner/util/fd-utils.ts`; pure value coverage (no uniqueness claim) is
 *   `closureCoversAll`.
 * - The set is non-canonical — only the FDs each operator can prove are
 *   stored. Use `computeClosure` to derive what a set of attributes implies.
 * - The full-relation case (`K = all_cols`, i.e. set semantics with no smaller
 *   discoverable key) is communicated via `RelationType.isSet`, not an FD.
 * - `guard`, when present, restricts the FD to predicates that entail every
 *   clause in the conjunction. A guarded FD never participates in closure;
 *   `FilterNode` activates it (strips the guard) when its predicate implies
 *   the guard, after which it propagates as an ordinary unconditional FD.
 */
export interface FunctionalDependency {
  /** Determinant column indices in the node's output. Empty array means "constant" (no row variation). */
  readonly determinants: readonly number[];
  /** Dependent column indices in the node's output. Non-empty. */
  readonly dependents: readonly number[];
  /** When defined, the FD only activates if a surrounding predicate entails every clause. */
  readonly guard?: GuardPredicate;
  /** Optional provenance tag — informational for diagnostics, ignored by dedup. */
  readonly source?: ConstraintProvenance;
  /**
   * Set on the mirror FDs `{a}→{b}` / `{b}→{a}` emitted from a column-to-column
   * value-equality body (`a = b`). Distinguishes a genuine value-equality (whose
   * endpoints hold equal values) from a coincidental mutual-determination mirror
   * (e.g. two partial UNIQUE indexes, or `b = a+1` + `a = b-1` checks) that is
   * structurally identical but is NOT an equality. Currently only set on the
   * GUARDED value-equality FDs from an implication-form CHECK (`recognizeGuardedBody`),
   * so that `FilterNode` guard-activation can soundly lift the equality as an EC
   * upon activation (ticket `fd-guarded-activation-key-bag-overclaim`). Ignored by
   * dedup, like `source`.
   */
  readonly valueEquality?: boolean;
  /**
   * Uniqueness provenance. REQUIRED — there is no implicit third state.
   *
   * - `'unique'`: the relation has at most one row per distinct
   *   determinant-tuple (for a guarded FD: restricted to rows satisfying the
   *   guard). This is a semantic claim about THIS relation, not a historical
   *   note about where the FD came from — any transform that can break
   *   row-uniqueness of the determinant set (fan-out) MUST downgrade to
   *   `'determination'`.
   * - `'determination'`: only the value claim — rows agreeing on the
   *   determinants agree on the dependents. Never implies row-uniqueness.
   *
   * Required (not optional) on purpose: every construction site must decide
   * which claim it is making, and a transform that rebuilds FD objects without
   * spreading the original fails to typecheck instead of silently losing the
   * marker (the `valueEquality`-through-`shiftFds` trap). Like `source` and
   * `valueEquality`, `kind` is ignored by structural dedup (`fdsEqual`) —
   * `addFd` merges equal-determinant entries with an "'unique' wins" rule.
   */
  readonly kind: 'unique' | 'determination';
}

/**
 * An inclusion dependency (IND): a guarantee that for every row of THIS
 * relation, the tuple formed by `cols` exists in another relation's
 * `target.targetCols`. The *propagated* companion to the FK-declaration-bound
 * helpers in `planner/util/ind-utils.ts` — see `docs/optimizer-fd.md` section
 * "Inclusion Dependency Tracking" for the seeding source and per-operator
 * propagation table.
 *
 * Asserts *existence* of a tuple in another relation — strictly weaker than,
 * and orthogonal to, an FD's *determination* of columns within this relation. A
 * false IND (**over-claim**) is unsound: it asserts a row exists that does not,
 * which would silently mis-prove coverage downstream. A missing IND
 * (**under-claim**) only forgoes an optimization. Therefore every propagation
 * rule is conservative — drop when unsure.
 */
export interface InclusionDependency {
  /** Output-column indices on THIS relation whose tuple is guaranteed to exist in `target`. */
  readonly cols: readonly number[];
  readonly target: IndTarget;
  /**
   * true: a NULL in any of `cols` excludes that row from the guarantee (MATCH
   * SIMPLE / nullable FK). false: total — every row's `cols` tuple is present in
   * the target.
   */
  readonly nullRejecting: boolean;
}

/**
 * The referenced side of an {@link InclusionDependency}. `targetCols` index
 * into the *target* relation (NOT this relation's output), so projection/shift
 * never remap them.
 *
 * - `table`: `child.cols ⊆ table.targetCols`, where `targetCols` is a key of
 *   that table. The FK-seeded form the coverage prover (Wave 2) reasons over.
 * - `relation`: a basis relation addressed by a stable symbolic id the lens
 *   compiler mints — the Wave-3 lens existence-anchor injection
 *   (`computeExistenceAnchorInds` in `schema/lens-compiler.ts`) mints it, one per
 *   mandatory non-anchor member (`anchor.key ⊆ member.key`), recorded on
 *   `LensSlot.injectedInds` and read by the lens prover off the slot — it does not
 *   ride the general per-operator IND propagation. The variant keeps the surface
 *   enforcement-ready (an obligation/discharge consumer can ride it later without
 *   raising the propagation bar — obligations come from the authoritative
 *   declaration, never from the propagated set).
 */
export type IndTarget =
  | { readonly kind: 'table'; readonly schema: string; readonly table: string; readonly targetCols: readonly number[] }
  | { readonly kind: 'relation'; readonly relationId: string; readonly targetCols: readonly number[] };

/**
 * Origin of an inferred constraint (FD / binding / domain). Optional and
 * informational — dedup helpers in `fd-utils.ts` compare structural fields
 * only, so identical constraints from different sources collapse to one and
 * the kept entry's provenance is whichever was merged first. When a declared
 * CHECK and a hoisted assertion produce structurally-identical contributions,
 * the table reference merges declared-check facts first, so `declared-check`
 * wins.
 */
export interface ConstraintProvenance {
  readonly kind: 'declared-check' | 'assertion';
  /** Lowercased assertion name when kind === 'assertion'. */
  readonly name?: string;
}

/**
 * Predicate guarding a conditional functional dependency. All clauses must be
 * entailed by the surrounding predicate (conjunctively) before the guarded FD
 * activates.
 */
export interface GuardPredicate {
  readonly clauses: readonly GuardClause[];
}

/**
 * Narrow guard-clause vocabulary recognized by predicate-implies-guard
 * checking. Each shape is something `extractEqualityFds` / EC / binding layers
 * can already reason about, so activation is a structural check.
 *
 * Shapes:
 * - `eq-literal` / `eq-column` / `is-null` — equality and null-test atoms.
 * - `range` — open or closed interval on one column, matching `DomainConstraint`
 *   range shape. Inclusivity flags for absent bounds are unobservable but
 *   stored conservatively as `false`. Discharge subsumption ("filter ⊆ guard")
 *   is via per-side bound comparison.
 * - `or-of` — flat disjunction of the other shapes; recognizers flatten nested
 *   `or-of` clauses at construction time so a sub-clause is never itself an
 *   `or-of`.
 *
 * `IN (lit, ...)` and `NOT col` shapes are pre-normalized at recognition time
 * into the same vocabulary (IN-list → `or-of [eq-literal]`, `NOT col` →
 * `eq-literal { col, value: 0 }`).
 */
export type GuardClause =
  | { readonly kind: 'eq-literal'; readonly column: number; readonly value: SqlValue }
  | { readonly kind: 'eq-column'; readonly left: number; readonly right: number }
  | { readonly kind: 'is-null'; readonly column: number; readonly negated: boolean }
  | {
      readonly kind: 'range';
      readonly column: number;
      readonly min?: SqlValue;
      readonly max?: SqlValue;
      readonly minInclusive: boolean;
      readonly maxInclusive: boolean;
    }
  | { readonly kind: 'or-of'; readonly clauses: readonly GuardClause[] };

/**
 * A pinned-constant value associated with a `ConstantBinding`. Either a
 * compile-time literal `SqlValue`, or a bound parameter identified by
 * `paramRef` (numeric 1-based index for `?`, string name for `:foo`-style).
 */
export type ConstantValue =
  | { readonly kind: 'literal'; readonly value: SqlValue }
  | { readonly kind: 'parameter'; readonly paramRef: string | number };

/**
 * Output columns pinned to a single value across every row of one execution.
 * Companion to `∅ → col` FDs: that FD records *that* a column is constant,
 * while a `ConstantBinding` additionally records *what value* it is pinned
 * to. Downstream rules (predicate inference through ECs, ordering pruning)
 * consume bindings directly instead of re-walking predicate ASTs.
 *
 * **The claim is "compares equal to", not "is stored as".** Every producer mints
 * a binding from an `=` conjunct or a declared CHECK, so what it records is:
 * *every surviving row satisfies `col = value` under `col`'s own declared
 * comparison*. For a column whose logical type compares by meaning rather than by
 * stored text (`timespan`: 'PT1H' = 'PT60M'; `json`: '{"a":1}' = '{ "a" : 1 }' —
 * see `docs/types.md` § "Semantic ordering") the rows may hold a DIFFERENT
 * spelling than `value`. A consumer that needs raw-value identity — byte
 * equality, a hash/serialization key, anything comparing the bound value outside
 * the column's own comparator — must NOT read a binding.
 *
 * Both current consumers need only the "compares equal to" reading:
 *  - `rules/predicate/rule-predicate-inference-equivalence.ts` re-synthesizes
 *    `otherCol = <value>` and types the synthesized literal from the TARGET
 *    attribute, so the comparison it emits is the target column's own. Sound
 *    only while the equivalence class it transfers along is itself
 *    semantic-ordering-gated at extraction (invariant OPT-051), so the target
 *    shares the source's type. Every extractor that mints one — the predicate,
 *    join, and CHECK/assertion sites — is gated; a new ungated minter would
 *    break this transfer.
 *  - `analysis/update-lineage.ts` (`deriveFilterAttributeDefaults`) uses the
 *    binding as the omitted-column default when inserting through a filtered
 *    view; it needs a value that SATISFIES the view predicate, which is exactly
 *    what the binding guarantees.
 */
export interface ConstantBinding {
  /** Output column indices pinned to `value`. */
  readonly attrs: readonly number[];
  readonly value: ConstantValue;
  /** Optional provenance tag — informational, ignored by dedup. */
  readonly source?: ConstraintProvenance;
}

/**
 * A bound on the values a single output column can take across every row of one
 * execution. Sourced from declared CHECK constraints at the table reference and
 * propagated like FDs/ECs/bindings — see `planner/util/fd-utils.ts` for the
 * merge/project/shift helpers.
 *
 * - `range`: an open or closed interval. `min`/`max` are absent for unbounded
 *   sides; `minInclusive`/`maxInclusive` are ignored when the corresponding
 *   bound is absent.
 * - `enum`: a finite set of allowed values.
 *
 * Multiple constraints may exist on the same column (and even on the same kind)
 * — intersection is deferred to the predicate-contradiction-detection ticket.
 */
export type DomainConstraint =
	| {
		readonly kind: 'range';
		/** Output column index. */
		readonly column: number;
		/** Lower bound, when known. */
		readonly min?: SqlValue;
		/** Upper bound, when known. */
		readonly max?: SqlValue;
		/** Lower bound is inclusive. Ignored when `min` is absent. */
		readonly minInclusive: boolean;
		/** Upper bound is inclusive. Ignored when `max` is absent. */
		readonly maxInclusive: boolean;
		/** Optional provenance tag — informational, ignored by dedup. */
		readonly source?: ConstraintProvenance;
	}
	| {
		readonly kind: 'enum';
		/** Output column index. */
		readonly column: number;
		readonly values: ReadonlyArray<SqlValue>;
		/** Optional provenance tag — informational, ignored by dedup. */
		readonly source?: ConstraintProvenance;
	};

/**
 * Backward update-provenance of one output attribute — the derived dual of the
 * forward FD walk (`docs/view-updateability.md` § The Update Site Model). Each
 * operator's backward method produces these by *reading* the forward
 * `PhysicalProperties.fds` it already emitted, never by re-deriving a parallel
 * walk. The plan-node-threaded generalization of `analysis/update-lineage.ts`'s
 * `ViewColumnLineage`, extended with the invertible-transform chain, the
 * outer-join `null-extended` case, and a machine-readable base reference.
 *
 * - `base` — traces to a base-table column through a chain of invertible scalar
 *   transforms. `inverse` (when present) maps a written value back to the base
 *   column's value; identity (absent) when the projection is a bare column /
 *   rename. `domain`, when present, is conjoined into the row-identifying
 *   predicate (sourced from an `inverse` profile's `domain`).
 * - `computed` — output of a non-invertible expression (or a generated column);
 *   read-only. Writes are rejected with the `no-inverse` diagnostic.
 * - `null-extended` — potentially null-extended by an outer join; a write needs
 *   materialization of the missing side (later phase). `guard` is the join
 *   predicate, `inner` the un-extended site on the non-preserved base.
 * - `authored` — the result column carries a `with inverse (col = expr, …)`
 *   clause: author-supplied put expressions computing base columns from the
 *   written view row (`new.<output-col>` refs). Writable AND insertable;
 *   overrides any registry-inferred site (authored wins —
 *   docs/vu-inverses.md § Authored inverses).
 */
export type UpdateSite =
	| {
			readonly kind: 'base';
			/** Producing `TableReferenceNode`'s plan-node id (numeric) — the relation discriminator for multi-source bodies. */
			readonly table: number;
			readonly baseColumn: string;
			readonly inverse?: (written: Expression) => Expression;
			readonly domain?: Expression;
		}
	| { readonly kind: 'computed'; readonly expr: Expression }
	| { readonly kind: 'null-extended'; readonly guard: Expression; readonly inner: UpdateSite }
	| {
			readonly kind: 'authored';
			/** One put per clause assignment, target-resolved to its owning base relation. */
			readonly puts: ReadonlyArray<AuthoredPut>;
			/**
			 * Lowercased `new.<name>` reference → output column index of the select that
			 * carries the clause. Index-keyed (not name-keyed) so an explicit
			 * `create view v(a, b)` column-list rename stays positionally stable.
			 */
			readonly newRefIndex: ReadonlyMap<string, number>;
		}
	| {
			/**
			 * An outer-join existence (`exists … as`) match flag — a clean `{true,false}`
			 * boolean reifying whether the referenced relational `component` matched the
			 * current row. Read-only in the read half (a write resolves to a non-writable
			 * site); the write half (`outer-join-existence-column`) turns an
			 * existence-flip into an insert/delete of that component. It has no base
			 * column — it is writable through an *effect*, not a base mapping.
			 */
			readonly kind: 'existence';
			/** The relational component whose match the flag reifies. */
			readonly component: RelationalComponentRef;
			/** The join-predicate guard (AST) the flag is the truth-value of. */
			readonly guard: Expression;
		};

/**
 * Generalized handle on a relational component an {@link UpdateSite} of kind
 * `existence` reifies the membership of — a join side, or a set-operation branch.
 * A discriminated union (never a hard-coded join side) precisely so the set-op
 * membership-column work can route through the same `existence` site.
 */
export type RelationalComponentRef =
	| {
			readonly kind: 'join-side';
			/** The non-preserved side's relational plan-node id (numeric; best-effort handle the write half refines to a `TableReferenceNode`). */
			readonly table: number;
			readonly side: 'left' | 'right';
		}
	| {
			/**
			 * A set-operation branch membership component (`set-op-membership-read`). The
			 * flag reifies whether the result tuple is a member of one immediate operand
			 * of a binary {@link SetOperationNode}. Read-only in the read half (the write
			 * half — `set-op-membership-write` — routes a membership-flip to a branch
			 * insert/delete via this ref).
			 */
			readonly kind: 'set-op-branch';
			/** The owning `SetOperationNode`'s plan-node id (numeric). */
			readonly setOp: number;
			/** Which immediate operand the flag's membership reifies. */
			readonly branch: 'left' | 'right';
		};

/**
 * One assignment of an `authored` {@link UpdateSite}: the target base column
 * (resolved through the child lineage to its producing `TableReferenceNode`)
 * plus the authored expression that computes it from the written view row
 * (`new.<output-col>` references, resolved via the site's `newRefIndex`).
 */
export interface AuthoredPut {
	/** Producing `TableReferenceNode`'s plan-node id of the target base column's relation. */
	readonly table: number;
	readonly baseColumn: string;
	/** The authored expression over `new.<output-col>` references (AST as written). */
	readonly expr: Expression;
}

/**
 * Build-time-validated `with inverse` metadata carried on a {@link import('./project-node.js').Projection}.
 * Produced by `analysis/authored-inverse.ts` (`validateAuthoredInverses`) when the
 * select's projections are built; consumed by `deriveProjectUpdateLineage`, which
 * resolves each `targetAttrId` through the child lineage into an `authored`
 * {@link UpdateSite} (authored wins over any registry-inferred site).
 */
export interface AuthoredInverseAssignment {
	/** Child (FROM-source) attribute id the assignment target resolved to at build time. */
	readonly targetAttrId: number;
	/** Target base column in its resolved display spelling (diagnostics). */
	readonly targetColumn: string;
	/** The authored expression over `new.<output-col>` references. */
	readonly expr: Expression;
}

export interface AuthoredInverseMeta {
	readonly assignments: ReadonlyArray<AuthoredInverseAssignment>;
	/** Lowercased `new.<name>` reference → output column index of the carrying select. */
	readonly newRefIndex: ReadonlyMap<string, number>;
}

/**
 * Per-attribute insert-default provenance — the value used when an `insert`
 * through the relation omits the column. Sourced from constant-FD selection
 * predicates (`constant-fd`), declared base-column defaults (`base-default`),
 * or a view's `with defaults (col = expr, …)` clause (`view-insert-default` —
 * declared but not yet threaded: view defaults are realized in the write-through
 * rewrite, and `view_info`'s derivation folds clause columns directly; see
 * `deriveViewInfo`'s Divergence-1 note). The value is symbolic (literal,
 * parameter, or context binding).
 *
 * NOTE for the consumer: `value` lives in the **base** column's domain, not the
 * projected output domain. When the owning `UpdateSite` is `base` with an
 * `inverse` (a transformed column such as `b + 1`), an omitted-column insert sets
 * the base column to `value` directly (no written view value exists to invert),
 * so the projected column reads back as the forward transform of `value`. The
 * orchestrator owns this interpretation and cross-op default precedence.
 */
export interface AttributeDefault {
	readonly kind: 'constant-fd' | 'base-default' | 'view-insert-default';
	readonly value: Expression;
}

/**
 * Physical properties that execution nodes can provide or require
 */
export interface PhysicalProperties {
  /** Ordering of rows. Each element specifies a column index and sort direction */
  ordering?: { column: number; desc: boolean }[];

  /** Estimated number of rows this node will produce */
  estimatedRows?: number;

  /**
   * Functional dependencies that hold over the output stream. The canonical
   * representation of "what determines what" — unique keys are encoded as
   * FDs `K → (all_cols \ K)`, and `∅ → all_cols` encodes "at-most-one-row".
   * Use `computeClosure` / `isUniqueDeterminant` / `hasAnyKey` /
   * `hasSingletonFd` from `planner/util/fd-utils.ts` to query them.
   */
  fds?: ReadonlyArray<FunctionalDependency>;

  /**
   * Equivalence classes over the node's output columns. Each class is a set
   * of column indices known to hold equal values for every row. Derived from
   * equality predicates and equi-join conditions.
   */
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;

  /**
   * Output columns pinned to a known constant value within a single execution.
   * Mirrors `∅ → col` FDs but carries the *value* so downstream rules
   * (predicate inference, ordering pruning) can rewrite predicates without
   * re-walking the source predicate AST. Parameters (`?` / `:foo`) count as
   * constants here because they are bound once before iteration.
   */
  constantBindings?: ReadonlyArray<ConstantBinding>;

  /**
   * Per-column value bounds (range or enum) provable for every row in the
   * stream. Sourced from declared CHECK constraints at the table reference and
   * propagated through unary/binary operators using the same projection rules
   * as FDs/ECs/bindings. Multiple constraints on the same column may coexist;
   * intersection across constraints is deferred to a follow-up ticket.
   */
  domainConstraints?: ReadonlyArray<DomainConstraint>;

  /**
   * Inclusion dependencies that hold over the output stream: for each entry,
   * every row's `cols` tuple is guaranteed to exist in another relation's
   * `targetCols` (subject to `nullRejecting`). Seeded from declared foreign keys
   * at the table reference and propagated through joins/projections with
   * conservative drops — see `planner/util/fd-utils.ts` for the
   * merge/project/shift helpers and `docs/optimizer-fd.md` section "Inclusion
   * Dependency Tracking".
   *
   * Asserts *existence* of a tuple in another relation — strictly weaker than,
   * and orthogonal to, an FD's *determination* of columns within this relation
   * (`fds`). No consumer reads this surface yet; it is a parallel derivation
   * surface for the coverage prover (Wave 2) and lens existence anchors (Wave 3).
   */
  inds?: ReadonlyArray<InclusionDependency>;

  /**
   * Per-output-attribute backward update provenance — the *derived dual* of
   * `fds`. Populated by the TableReference / Project / Filter / Join backward
   * methods, each reading this same node's forward `fds` rather than
   * re-deriving its own. Keyed by `Attribute.id` (matching sibling per-attribute
   * maps). Consumed by the view-mutation orchestrator; surfaced through
   * `query_plan()` / EXPLAIN as a bounded `$map` summary. See `UpdateSite`.
   */
  updateLineage?: ReadonlyMap<number, UpdateSite>;

  /**
   * Per-attribute insert-default provenance (constant-FD selection defaults,
   * declared base defaults, view insert-defaults). Keyed by `Attribute.id`.
   * Companion to `updateLineage` — what fills an omitted insert column.
   */
  attributeDefaults?: ReadonlyMap<number, AttributeDefault>;

  /**
   * Attributes the relation is monotonically ordered on. Stronger than `ordering`:
   * meaningful only for total-order-preserving sources (vtab access plans that
   * advertise it; sort nodes; certain merge operators) and survives only the
   * propagation rules documented in characteristics.ts.
   *
   * `monotonicOn` strictly implies `ordering` on the same attribute in the same
   * direction; nodes are permitted (not required) to populate one from the other.
   */
  monotonicOn?: readonly MonotonicOnInfo[];

  /**
   * Capability flags advertised by the underlying access path. Unlike
   * `monotonicOn`, these are not relational characteristics — they describe
   * what the access path's iterator can be driven to do (ordinal seek for
   * pushed-down LIMIT/OFFSET, forward-only repositioning for asof joins).
   *
   * These survive only on the physical leaf node where the access plan was
   * resolved. Single-input pass-through nodes (Filter, LimitOffset, Alias,
   * etc.) MUST NOT propagate these — once another operator sits between the
   * vtab leaf and the consumer, the leaf's iterator is no longer the
   * consumer's iterator.
   */
  accessCapabilities?: {
    /** Path supports O(log N) seek to the kth monotonic row. Implies monotonicOn. */
    ordinalSeek?: boolean;
    /** Path can be driven as the right side of a streaming asof join. Implies monotonicOn. */
    asofRight?: boolean;
  };

  /**
   * Symbolic range bound that downstream rules / EXPLAIN can read off. Set by
   * rule-monotonic-range-access on physical leaves whose access plan walks a
   * MonotonicOn(x) path bounded by a recognized range predicate on x. The
   * lower/upper fields are absent for unbounded sides (half-open ranges).
   *
   * Non-relational: lives on the physical leaf where the access plan was
   * resolved. Pass-through nodes do NOT propagate it.
   */
  rangeBoundedOn?: {
    attrId: number;
    lower?: { op: '>=' | '>'; valueLiteral?: SqlValue };
    upper?: { op: '<=' | '<'; valueLiteral?: SqlValue };
  };

  /**
   * Whether this node is read-only (does not mutate external state).
   * false = has side effects, true = pure/read-only
   */
  readonly?: boolean;

  /**
   * Whether this node is deterministic - same inputs always produce same outputs.
   * Non-deterministic examples: random(), now(), sequence generators
   */
  deterministic?: boolean;

  /**
   * Whether this node is idempotent - calling twice in same transaction
   * leaves state as if called once. Only meaningful for non-readonly nodes.
   * Examples: INSERT with IGNORE, UPDATE with same values
   */
  idempotent?: boolean;

  /**
   * Whether this node directly produces a constant result (deterministic, readonly, and no dependencies).
	 * If this is true, the node should implement getValue() to return the constant value.
   */
  constant?: boolean;

  /**
   * Expected first-row latency in milliseconds for this subtree's iterator.
   * 0 (default) for local-only paths (memory vtab, in-process compute).
   * Non-zero for remote vtabs and any operator whose cost model declares it.
   * Consumed by rule-fanout-lookup-join's cost gate; consumers must not rely
   * on it for correctness (only as a fan-out savings hint).
   *
   * Propagation: unary/multi-input nodes inherit the max of children. Leaves
   * declare their own value via `computePhysical`. Remote-vtab leaves should
   * source this from their access plan; the in-tree default is 0 and the
   * fan-out cost gate is intentionally inert until a remote plugin populates it.
   */
  expectedLatencyMs?: number;

  /**
   * True when the subtree is safe to execute concurrently with siblings sharing
   * the same vtab connection. Defaults to true for read-only subtrees over
   * modules with `concurrencyMode !== 'serial'`. False when the subtree mutates
   * state, holds a non-reentrant cursor, or sits over a `'serial'` module that
   * does not have a per-branch connection available.
   *
   * Propagation: multi-input nodes inherit the AND of children — any non-safe
   * child poisons the parent. Leaves derive their own value from the
   * underlying module's concurrency mode and the subtree's readonly status.
   */
  concurrencySafe?: boolean;
}

// Derived properties (computed, not stored):
// functional = deterministic && readonly (safe for constant folding)
// sideEffects = !readonly (mutates external state)

/**
 * Default physical properties for plan nodes
 */
export const DEFAULT_PHYSICAL: PhysicalProperties = {
	deterministic: true,
	readonly: true,
	idempotent: true, // Default true for readonly nodes
	constant: false,
} as const;

/**
 * Monotonicity of a scalar expression with respect to a given input attribute.
 * Direction is "as the attribute's value increases, what happens to the expression":
 *   - 'increasing'    — strictly non-decreasing (compatible with `asc` ordering)
 *   - 'decreasing'    — strictly non-increasing
 *   - 'constant'      — does not depend on the attribute (flat in attrId)
 *   - 'non_monotone'  — depends on the attribute but provably not monotone
 *   - 'unknown'       — cannot prove a property; safe default
 *
 * Other inputs are held constant when reasoning about monotonicity in attrId.
 */
export type Monotonicity = 'increasing' | 'decreasing' | 'constant' | 'non_monotone' | 'unknown';

export interface InjectivityResult {
  /** True iff distinct values of the input attribute always produce distinct expression values
   *  (with all other inputs held constant). */
  readonly injective: boolean;
  /** Optional explanation for diagnostics. */
  readonly reason?: string;
}

export interface MonotonicityResult {
  readonly monotonicity: Monotonicity;
  readonly reason?: string;
}

/**
 * Equivalent half-open range on input x for a predicate `f(x) op c` where f is
 * monotone but lossy (e.g. `f(x) = date(x); f(x) = D` corresponds to a
 * one-day half-open range on x). `lowerInclusive ≤ x < upperExclusive`.
 *
 * The boundary computation is type-driven; see LogicalType.bucketBounds.
 */
export interface RangeRewrite {
  readonly lowerInclusive: SqlValue;
  readonly upperExclusive: SqlValue;
}

/** Conservative defaults for the scalar property surface. Exposed for tests / consumers. */
export const DEFAULT_INJECTIVITY: InjectivityResult = { injective: false } as const;
export const DEFAULT_MONOTONICITY: MonotonicityResult = { monotonicity: 'unknown' } as const;

/** Negate (flip) a monotonicity direction; constant/non_monotone/unknown pass through unchanged. */
export function negateMonotonicity(m: Monotonicity): Monotonicity {
	switch (m) {
		case 'increasing': return 'decreasing';
		case 'decreasing': return 'increasing';
		default: return m;
	}
}

/** Combine monotonicities for `a + b` (addition rules). */
export function addMonotonicity(a: Monotonicity, b: Monotonicity): Monotonicity {
	if (a === 'unknown' || b === 'unknown') return 'unknown';
	if (a === 'non_monotone' || b === 'non_monotone') return 'non_monotone';
	if (a === 'constant') return b;
	if (b === 'constant') return a;
	if (a === b) return a; // both increasing or both decreasing
	return 'unknown'; // mixed directions
}

/**
 * Represents a column with a unique identifier that persists across plan transformations
 */
export interface Attribute {
  /** Globally unique identifier for this column */
  id: number;
  /** Human-readable name (may not be unique) */
  name: string;
  /** Data type information */
  type: ScalarType;
  /** Source relation that originally produced this column */
  sourceRelation?: string;
  /** Relation name for qualified access (e.g. table name or alias) */
  relationName?: string;
}

/**
 * Row descriptor that maps attribute IDs to column indices in a row array
 */
export type RowDescriptor = number[]; // attributeId → columnIndex

/**
 * Function that returns a row when called
 */
export type RowGetter = () => Row;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type TableDescriptor = {
	// Just using the object's identity for now
};

export type TableGetter = () => AsyncIterable<Row>;

/**
 * Base class for all nodes in the logical query plan.
 * PlanNodes are immutable once constructed.
 */
export abstract class PlanNode {
  private static nextId = 0;
  private static nextAttributeId = 0;

  readonly id: string;
  abstract readonly nodeType: PlanNodeType;

  /** Present if the node is a physical plan node */
  private _physical?: PhysicalProperties;

  constructor(
		/** The scope in which this node is planned. */
    public readonly scope: Scope,
	  /**
		 * Self-cost of executing this node itself, EXCLUDING its children
		 * (self-cost-only convention). Whole-subtree cost is `getTotalCost()`,
		 * which sums this node's `estimatedCost` with every child's total.
		 *
		 * A node constructor MUST NOT fold `child.getTotalCost()` or a child's
		 * `estimatedCost` into this value — doing so double-counts once
		 * `getTotalCost()` adds the children again, growing exponentially with
		 * nesting depth. Only the vtab leaf's own IndexInfo cost is a genuine
		 * self-cost (see `table-access-nodes.ts`). The static guard in
		 * `test/planner/cost-additivity.spec.ts` enforces this.
		 */
		public readonly estimatedCost = 0.01

	) {
    this.id = `${PlanNode.nextId++}`;
  }

  abstract getType(): BaseType;
  abstract getChildren(): readonly PlanNode[];

  /**
   * Default implementation of getRelations() that filters getChildren()
   * Can be overridden for performance if needed
   */
	getRelations(): readonly RelationalPlanNode[] {
    return this.getChildren()
    	.filter(isRelationalNode);
  }

  /**
   * Return this node with its children replaced by newChildren.
   * MUST keep attribute IDs stable unless the concrete node deliberately produces new columns.
   *
   * Implementations must:
   *   1. Verify arity (throw if length mismatch)
   *   2. Return `this` if nothing changed
   *   3. Otherwise construct a new instance copying all immutable properties
   */
  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;

  /**
   * Compute physical property overrides for this node
   * Called by the optimizer when converting logical to physical nodes.
   * @param children Physical properties of optimized children
   */
  computePhysical?(children: readonly PhysicalProperties[]): Partial<PhysicalProperties>;

  /**
   * Get the attributes (columns) produced by this relational node
   */
  getAttributes?(): readonly Attribute[];

  /** Cached attrId → index map; see getAttributeIndex(). */
  private _attributeIndexCache?: ReadonlyMap<number, number>;

  /**
   * Map from attribute id to its index in `getAttributes()`. Replaces the
   * ad-hoc `attrs.findIndex(a => a.id === …)` scans scattered across the
   * planner. Cached per instance; because PlanNodes are immutable, `withChildren`
   * mints a fresh instance and the cache rebuilds automatically.
   */
  getAttributeIndex(): ReadonlyMap<number, number> {
    if (!this._attributeIndexCache) {
      const map = new Map<number, number>();
      const attrs = this.getAttributes?.() ?? [];
      for (let i = 0; i < attrs.length; i++) {
        map.set(attrs[i].id, i);
      }
      this._attributeIndexCache = map;
    }
    return this._attributeIndexCache;
  }

  /**
   * Get map of attribute ID to producing scalar expression (for constant folding)
   * Only relational nodes that synthesize columns from expressions need implement this
   */
  getProducingExprs?(): Map<number, ScalarPlanNode>;

	/** Memoized whole-subtree cost; see getTotalCost(). */
	private _totalCostCache?: number;

	/**
	 * Whole-subtree cost: this node's self-cost (`estimatedCost`) plus every
	 * child's total cost, walking `getChildren()`. This is the ONLY place child
	 * costs are summed — node constructors store self-cost only (see
	 * `estimatedCost`), so a subtree's cost grows linearly, not exponentially,
	 * with nesting depth.
	 *
	 * Memoized per instance. Safe because PlanNodes are immutable: `withChildren`
	 * mints a fresh instance (with a fresh, empty cache), and no constructor calls
	 * `getTotalCost()`, so the first call always happens after the tree is fully
	 * built. The ONE in-place mutator — `RecursiveCTENode.setRecursiveCaseQuery` —
	 * clears the cache via `invalidateTotalCostCache()`.
	 */
	getTotalCost(): number {
		if (this._totalCostCache === undefined) {
			// Iterative post-order sum so an arbitrarily deep plan cannot overflow the
			// native call stack — matching the pass framework's iterative traversal
			// (framework/pass.ts). Populates every subtree node's `_totalCostCache`
			// bottom-up, so each child's total is cached before its parent sums it.
			PlanNode.computePostOrder(
				this,
				node => node._totalCostCache !== undefined,
				node => {
					// Sum children from 0 first, THEN add self — bit-identical to the
					// original `estimatedCost + children.reduce(..., 0)` order, so the
					// memoized total matches validateCostAdditivity's recomputation to
					// the last floating-point ULP.
					let childrenSum = 0;
					for (const child of node.getChildren()) {
						childrenSum += child._totalCostCache!;
					}
					node._totalCostCache = node.estimatedCost + childrenSum;
				},
			);
		}
		return this._totalCostCache!;
	}

	/**
	 * Clear the memoized total-cost. Needed only by nodes that mutate a child in
	 * place after construction (`RecursiveCTENode.setRecursiveCaseQuery`); the
	 * immutable `withChildren` path never needs it (it re-mints a fresh instance).
	 */
	protected invalidateTotalCostCache(): void {
		this._totalCostCache = undefined;
	}

	/**
	 * Iterative post-order walk over `getChildren()`, used by the memoizing
	 * bottom-up folds (`physical`, `getTotalCost`). Explicit worklist instead of
	 * recursion so a deep plan cannot overflow the native call stack.
	 *
	 * `isDone(node)` reports whether the node's memo is already populated — such a
	 * node is skipped (its subtree is not re-walked), which both preserves prior
	 * memoization and makes shared-subtree DAGs correct and O(1) on re-visit.
	 * `compute(node)` runs exactly once per not-yet-done node, AFTER all of its
	 * children have been computed, so it may read each child's memo directly.
	 */
	private static computePostOrder(
		root: PlanNode,
		isDone: (node: PlanNode) => boolean,
		compute: (node: PlanNode) => void,
	): void {
		const stack: { node: PlanNode; expanded: boolean }[] = [{ node: root, expanded: false }];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			const node = frame.node;
			if (isDone(node)) {
				// Already computed (memo hit, or reached again via a shared subtree).
				stack.pop();
				continue;
			}
			if (!frame.expanded) {
				// First visit: schedule children, then revisit this frame to compute.
				frame.expanded = true;
				const children = node.getChildren();
				for (let i = children.length - 1; i >= 0; i--) {
					stack.push({ node: children[i], expanded: false });
				}
			} else {
				// Revisit: every child is now done — compute and pop.
				stack.pop();
				compute(node);
			}
		}
	}

  visit(visitor: PlanNodeVisitor): void {
    // Iterative pre-order walk (visit before descending) so a deep plan cannot
    // overflow the native call stack. Children are pushed in reverse so they pop
    // left-to-right, preserving the original visitation order. Mirrors the
    // recursive version's semantics exactly — no per-node dedup, so a node
    // reachable by two paths is still visited once per path.
    const stack: PlanNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      visitor(node);
      const children = node.getChildren();
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }

	toString(): string {
		return `${this.nodeType} [${this.id}]`;
	}

	/**
   * Get logical properties for this node.
   * Override to provide node-specific logical information.
   */
  getLogicalAttributes(): Record<string, unknown> {
    return {};
  }

  /**
   * Is this scalar expression injective in the given input attribute?
   * Default is the conservative "no" — only meaningful for ScalarPlanNode subclasses
   * that override. Other inputs are assumed held constant when reasoning.
   */
  isInjectiveIn(_inputAttrId: number): InjectivityResult {
    return DEFAULT_INJECTIVITY;
  }

  /**
   * Monotonicity of this scalar expression in the given input attribute, with
   * other inputs held constant. Default is the conservative 'unknown'.
   */
  monotonicityIn(_inputAttrId: number): MonotonicityResult {
    return DEFAULT_MONOTONICITY;
  }

  /**
   * For monotone-but-lossy scalar transforms only: given a constant `c` from a
   * predicate `f(x) op c`, return the equivalent half-open range on x. Return
   * undefined when not applicable / unsafe. Implementations must be consistent
   * with `monotonicityIn`.
   */
  rangeRewriteIn(_inputAttrId: number, _constant: SqlValue): RangeRewrite | undefined {
    return undefined;
  }

	/** Infer and cache the physical properties of this node */
	get physical(): PhysicalProperties {
		if (!this._physical) {
			// Iterative post-order fold so a deep plan cannot overflow the native
			// call stack. Populates `_physical` bottom-up: every child's `_physical`
			// is set before its parent computes, so `computePhysicalFromChildren`
			// reads cached values (never a recursive `.physical` access).
			PlanNode.computePostOrder(
				this,
				node => node._physical !== undefined,
				node => node.computePhysicalFromChildren(),
			);
		}
		return this._physical!;
	}

	/**
	 * Compute and store this node's `_physical` from its children's already-cached
	 * `_physical`. Called by the `physical` getter's post-order walk once every
	 * child is populated. The defaults/override merge is identical to a direct
	 * recursive computation — only the child-physical source (cached, not a
	 * recursive `.physical` read) differs.
	 */
	private computePhysicalFromChildren(): void {
		const childrenPhysical = this.getChildren().map(child => child._physical!);

		// Get the node-specific overrides
		const propsOverride = this.computePhysical?.(childrenPhysical);

		// Derive defaults from children if there are any, else leaf defaults
		const defaults = childrenPhysical.length
			? {
				deterministic: childrenPhysical.every(child => child.deterministic),
				idempotent: childrenPhysical.every(child => child.idempotent),
				readonly: childrenPhysical.every(child => child.readonly),
				// constant: DON'T INHERIT - only ValueNodes can be directly constant
				// expectedLatencyMs: max of children — slowest child gates first-row
				// latency. 0 default for local-only paths.
				expectedLatencyMs: childrenPhysical.reduce(
					(acc, child) => Math.max(acc, child.expectedLatencyMs ?? 0),
					0,
				),
				// concurrencySafe: AND of children — any non-safe child poisons the
				// parent. Default true so missing values do not spuriously disable
				// parallelism; leaves that need stricter behavior set false.
				concurrencySafe: childrenPhysical.every(child => child.concurrencySafe !== false),
			}
			: DEFAULT_PHYSICAL;

		this._physical = { ...defaults, ...propsOverride };
	}

  /** Helper to generate unique attribute IDs */
  public static nextAttrId(): number {
    return PlanNode.nextAttributeId++;
  }

  /**
   * Check if a node is functional (pure and deterministic), safe for constant folding
   */
  public static isFunctional(physical: PhysicalProperties): boolean {
    return (physical.deterministic !== false) && (physical.readonly !== false);
  }

  /**
   * Check if a node has side effects (mutates external state)
   */
  public static hasSideEffects(physical: PhysicalProperties): boolean {
    return physical.readonly === false;
  }
}

export type PlanNodeVisitor = (node: PlanNode) => void;

/**
 * Base class for PlanNodes that do not produce a relational or scalar output,
 * typically used for DDL or other side-effecting operations.
 */
export abstract class VoidNode extends PlanNode {
  getType(): BaseType {
    // Indicates a non-relational, non-scalar result, e.g., status object or no output.
    return { typeClass: 'void' };
  }

  getChildren(): readonly PlanNode[] {
    return []; // No direct child plan nodes in the execution sense
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`);
    }
    return this; // No children, so no change
  }

	getRelations(): readonly RelationalPlanNode[] {
    return []; // Does not operate on input relations
  }
}

/**
 * Base interface for PlanNodes that produce a relation (a set of rows).
 * Note: this is an interface that concrete RelationalNode classes will implement.
 */
export interface RelationalPlanNode extends PlanNode {
  /** Estimated number of rows this node will output. */
  readonly estimatedRows?: number;

  getType(): RelationType;

  /**
   * Get the attributes (columns) produced by this relational node
   * Each attribute has a unique ID that persists across plan transformations
   */
  getAttributes(): readonly Attribute[];

  /** Map from attribute id to its index in getAttributes(). Cached on PlanNode. */
  getAttributeIndex(): ReadonlyMap<number, number>;
}

/**
 * Characteristically check if a node is relational (can be cached)
 */
export function isRelationalNode(node: PlanNode): node is RelationalPlanNode {
	return node.getType().typeClass === 'relation';
}

/**
 * Base interface for PlanNodes that produce a scalar value (Expression Nodes).
 * Note: this is an interface that concrete ScalarNode classes will implement.
 *
 * The injectivity / monotonicity / rangeRewrite methods all have safe defaults
 * on `PlanNode`, so concrete classes opt in by overriding only the cases they
 * can prove. Conservatively defaulting to "unknown / not injective" is critical:
 * downstream optimizer rules treat these as load-bearing correctness claims.
 */
export interface ScalarPlanNode extends PlanNode {
	readonly expression: Expression;
  getType(): ScalarType;
  isInjectiveIn(inputAttrId: number): InjectivityResult;
  monotonicityIn(inputAttrId: number): MonotonicityResult;
  rangeRewriteIn(inputAttrId: number, constant: SqlValue): RangeRewrite | undefined;
}

/**
 * Characteristically check if a node is a scalar node
 */
export function isScalarNode(node: PlanNode): node is ScalarPlanNode {
	return node.getType().typeClass === 'scalar';
}

/**
 * Narrow a slice of rewritten `withChildren` input to scalars, failing loudly instead of
 * casting. `label` names the node and slot, e.g. `'ConstraintCheckNode constraint'`.
 */
export function asScalarNodes(nodes: readonly PlanNode[], label: string): ScalarPlanNode[] {
	return nodes.map((node, i) => {
		if (!isScalarNode(node)) {
			throw new Error(`${label} child ${i + 1} must be a ScalarPlanNode, got ${node.nodeType}`);
		}
		return node;
	});
}

// --- Arity-based Base Abstractions (Interfaces, to be implemented by concrete node classes) ---

/** A relational plan node that has no relational inputs (a leaf in the relational algebra tree).
 * Will not have scalar inputs either - this is either TableDee or TableDum, projection can be used to compute columns
 */
export interface ZeroAryRelationalNode extends RelationalPlanNode {
  // No specific 'inputs' property at this base level, concrete nodes will define sources.
  getRelations(): readonly [];
}

/** A relational plan node that operates on a single relational input. */
export interface UnaryRelationalNode extends RelationalPlanNode {
  readonly source: RelationalPlanNode;
  getRelations(): readonly [RelationalPlanNode];
}

/** A relational plan node that operates on two relational inputs. */
export interface BinaryRelationalNode extends RelationalPlanNode {
  readonly left: RelationalPlanNode;
  readonly right: RelationalPlanNode;
  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode];
}

/** A scalar plan node that has no scalar inputs (a leaf in an expression tree).
 * May have relational input(s) e.g. EXISTS, IN, etc.
 */
export interface ZeroAryScalarNode extends ScalarPlanNode {
  // No specific 'operands' property at this base level.
  getChildren(): readonly [];
}

/** A scalar plan node that operates on a single scalar input. */
export interface UnaryScalarNode extends ScalarPlanNode {
  readonly operand: ScalarPlanNode;
  getChildren(): readonly [ScalarPlanNode];
}

/** A scalar plan node that operates on two scalar inputs. */
export interface BinaryScalarNode extends ScalarPlanNode {
  readonly left: ScalarPlanNode;
  readonly right: ScalarPlanNode;
  getChildren(): readonly [ScalarPlanNode, ScalarPlanNode];
}

/** A scalar plan node that operates on three scalar inputs. */
export interface TernaryScalarNode extends ScalarPlanNode {
  getChildren(): readonly [ScalarPlanNode, ScalarPlanNode, ScalarPlanNode];
}

/** A scalar plan node that operates on N scalar inputs. */
export interface NaryScalarNode extends ScalarPlanNode {
  readonly operands: ReadonlyArray<ScalarPlanNode>;
  getChildren(): readonly ScalarPlanNode[];
}

// --- Concrete Arity-Based Base Classes ---

/**
 * Base class for relational nodes with no relational inputs (leaf nodes)
 */
export abstract class ZeroAryRelationalBase extends PlanNode implements ZeroAryRelationalNode {
  abstract getType(): RelationType;
  abstract getAttributes(): readonly Attribute[];

  getChildren(): readonly PlanNode[] {
    return [];
  }

  getRelations(): readonly [] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
			quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`);
    }
    return this;
  }
}

/**
 * Base class for relational nodes with one relational input
 */
export abstract class UnaryRelationalBase extends PlanNode implements UnaryRelationalNode {
  abstract readonly source: RelationalPlanNode;
  abstract getType(): RelationType;
  abstract getAttributes(): readonly Attribute[];

  getChildren(): readonly PlanNode[] {
    return [this.source];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for relational nodes with two relational inputs
 */
export abstract class BinaryRelationalBase extends PlanNode implements BinaryRelationalNode {
  abstract readonly left: RelationalPlanNode;
  abstract readonly right: RelationalPlanNode;
  abstract getType(): RelationType;
  abstract getAttributes(): readonly Attribute[];

  getChildren(): readonly PlanNode[] {
    return [this.left, this.right];
  }

  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
    return [this.left, this.right];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with no scalar inputs (leaf expressions)
 */
export abstract class ZeroAryScalarBase extends PlanNode implements ZeroAryScalarNode {
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly [] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`);
    }
    return this;
  }
}

/**
 * Base class for scalar nodes with one scalar input
 */
export abstract class UnaryScalarBase extends PlanNode implements UnaryScalarNode {
  abstract readonly operand: ScalarPlanNode;
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly [ScalarPlanNode] {
    return [this.operand];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with two scalar inputs
 */
export abstract class BinaryScalarBase extends PlanNode implements BinaryScalarNode {
  abstract readonly left: ScalarPlanNode;
  abstract readonly right: ScalarPlanNode;
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly [ScalarPlanNode, ScalarPlanNode] {
    return [this.left, this.right];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with three scalar inputs
 */
export abstract class TernaryScalarBase extends PlanNode implements TernaryScalarNode {
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;
  abstract getChildren(): readonly [ScalarPlanNode, ScalarPlanNode, ScalarPlanNode];

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with N scalar inputs
 */
export abstract class NaryScalarBase extends PlanNode implements NaryScalarNode {
  abstract readonly operands: ReadonlyArray<ScalarPlanNode>;
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly ScalarPlanNode[] {
    return this.operands;
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * A node that directly produces a constant result (deterministic, readonly, and no dependencies).
 * If the node is constant (literal value), it should implement getValue() to return the constant value.
 */
export interface ConstantNode extends PlanNode {
	getValue(): OutputValue;
}
