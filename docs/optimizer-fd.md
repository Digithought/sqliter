# Functional Dependency Tracking

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Functional dependencies (FDs) are the canonical surface for "what determines what" on a relational physical node's output. There is no separate `uniqueKeys` field — a unique key `K` is encoded as the FD `K → (all_cols \ K)`, and `∅ → all_cols` encodes the at-most-one-row claim.

This is the **forward** direction, and the [Key Soundness harness](architecture.md) backstops it: it never over-claims a key. The **backward** direction — view/lens update propagation (`put`) — reads this *same* per-node FD/EC/domain annotation rather than maintaining a parallel one, gated by a per-operator round-trip law (see [vu-roundtrip.md § Round-Trip Laws and the Derived Backward Walk](vu-roundtrip.md#round-trip-laws-and-the-derived-backward-walk)).

```typescript
export interface FunctionalDependency {
  readonly determinants: readonly number[]; // empty = "constant"
  readonly dependents: readonly number[];
  readonly guard?: GuardPredicate;          // when present, activation-gated
  readonly kind: 'unique' | 'determination'; // uniqueness provenance — REQUIRED
}

export interface GuardPredicate {
  readonly clauses: readonly GuardClause[]; // conjunctive
}

export type GuardClause =
  | { readonly kind: 'eq-literal'; readonly column: number; readonly value: SqlValue }
  | { readonly kind: 'eq-column'; readonly left: number; readonly right: number }
  | { readonly kind: 'is-null'; readonly column: number; readonly negated: boolean }
  | { readonly kind: 'range'; readonly column: number;
      readonly min?: SqlValue; readonly max?: SqlValue;
      readonly minInclusive: boolean; readonly maxInclusive: boolean }
  | { readonly kind: 'or-of'; readonly clauses: readonly GuardClause[] };

export type ConstantValue =
  | { readonly kind: 'literal'; readonly value: SqlValue }
  | { readonly kind: 'parameter'; readonly paramRef: string | number };

export interface ConstantBinding {
  readonly attrs: readonly number[];
  readonly value: ConstantValue;
}

export type DomainConstraint =
  | { readonly kind: 'range'; readonly column: number;
      readonly min?: SqlValue; readonly max?: SqlValue;
      readonly minInclusive: boolean; readonly maxInclusive: boolean }
  | { readonly kind: 'enum'; readonly column: number;
      readonly values: ReadonlyArray<SqlValue> };

interface PhysicalProperties {
  // ... ordering, estimatedRows, monotonicOn ...
  fds?: ReadonlyArray<FunctionalDependency>;
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
  constantBindings?: ReadonlyArray<ConstantBinding>;
  domainConstraints?: ReadonlyArray<DomainConstraint>;
}
```

Column indices are output-column indices. The FD list is **non-canonical** — each operator stores only what it can prove locally. Use `computeClosure(attrs, fds)` from `planner/util/fd-utils.ts` to derive what a set of attributes implies.

The "all-columns is a key" claim (DISTINCT, schema-set tables with no smaller key) has no non-trivial FD encoding — it is communicated via `RelationType.isSet`. A uniqueness fact can therefore live on any of three surfaces: declared `RelationType.keys`, the `PhysicalProperties.fds` FD set, or `RelationType.isSet`.

## `kind`: uniqueness provenance

> **Invariant:** [OPT-040](invariants.md#opt-040--a-fanning-join-downgrades-the-non-preserved-side), [OPT-044](invariants.md#opt-044--fd-identity-is-structural-unique-wins-on-merge), [OPT-054](invariants.md#opt-054--all-columns-key-ness-lives-on-isset)

Every FD carries a **required** `kind: 'unique' | 'determination'` field:

- **`'unique'`** — the relation has at most one row per distinct determinant tuple (for a guarded FD: restricted to rows satisfying the guard). This is a semantic claim about *this* relation, not a historical note about where the FD came from: any transform that can break determinant row-uniqueness (fan-out) **must downgrade** the FD to `'determination'`.
- **`'determination'`** — only the value claim: rows agreeing on the determinants agree on the dependents. Never implies row-uniqueness. In particular, a `∅ → col` constant pin is `'determination'` — a pinned column does **not** imply ≤1 row.

The field is required (not optional) on purpose: every construction site must decide which claim it makes, and a transform that rebuilds FD objects without spreading the original fails to typecheck instead of silently losing the marker.

**Kind at each construction site:**

| Site | Kind | Why |
| ---- | ---- | --- |
| `superkeyToFd` (declared / projected keys, join `preservedKeys`, aggregate group key, set-op data-cols key, lens key obligations, TVF-declared keys) | `unique` | Every caller passes a genuine key. |
| `singletonFd` / `addSingletonFd` (filter covered-key, values ≤1-row, `LIMIT 1`, pragma, analyze, declarative-schema, scalar aggregate, table-access) | `unique` | `∅` row-unique ⟺ ≤1 row — exactly what each caller proves. |
| Declared PK/UNIQUE seeding (`TableReferenceNode`) | `unique` | Declared keys. |
| Partial-UNIQUE guarded FDs (`partial-unique-extraction`) | `unique` | Row-unique *within the guard's scope* — the guarded-`'unique'` semantics. |
| CHECK-derived FDs (all shapes, guarded and unconditional; `check-extraction`, assertion hoist) | `determination` | A CHECK constrains values, never row counts. |
| Filter predicate equality FDs (`extractEqualityFds`: `{a}↔{b}`, `∅→col`) | `determination` | Equality / constant pins are value claims. |
| EC-expansion FDs (`expandEcsToFds`) | `determination` | Ephemeral closure reasoning over equalities. |
| Injective-pair FDs (`ProjectNode` / `ReturningNode`, `select id, id+1`) | `determination` | Injectivity is a value bijection; key-ness rides the projected key FDs. |
| Join equi-pair FDs (`propagateJoinFds`) | `determination` | Value equalities; uniqueness rides the preserved-key FDs. |

**Transforms preserve kind verbatim.** `shiftFds` (column relabel), `projectFds` (rows map 1:1; determinants must survive anyway), `stripGuard` (Filter activation — the activating filter's rows all satisfy the guard, and filtering only shrinks the row set), and the pass-through operators (Filter, Distinct, Sort, Limit, Cache) all carry `kind` — along with `source` and `valueEquality` — unchanged. Aggregate composes `projectFds` + `superkeyToFd`, which is sound: output rows are quotients of disjoint groups, so two output rows agreeing on a `'unique'` determinant would imply two source rows agreeing on it.

**Fan-out downgrades.** A fanning operator duplicates one side's rows, destroying determinant row-uniqueness while every value claim survives. `propagateJoinFds` downgrades a non-preserved side's surviving FDs — **guarded FDs included**: a guarded partial-unique FD crossing a fanning join is no longer row-unique even within its guard's scope — on the inner/cross/left/right arms (`full` already drops everything; semi/anti pass left rows ≤1:1 and preserve kinds). The AsyncGather `crossProduct` fold applies the same rule: a child's `'unique'` FDs stay `'unique'` only when every *other* child is provably ≤1-row. `FanoutLookupJoinNode` inherits the downgrade by delegating to `propagateJoinFds` with no preserved keys.

**Merge semantics: `'unique'` wins.** `fdsEqual` stays structural (`kind` is not compared, like `source` / `valueEquality`). When `addFd` merges entries with equal determinants and guards, the survivor's kind is `'unique'` if *either* side claims it — uniqueness is a property of the determinant set, so equal-determinant claims compose; a kept `'determination'` entry is upgraded in place when the subsumed newcomer is `'unique'`. `enforceCap` prefers keeping `'unique'` FDs over plain determinations when truncating (evicting a uniqueness witness is sound but causes under-claims).

**Producers emit value claims freely**, as `'determination'`. Soundness lives entirely on the read side — see *The reader rule* below.

## Collation gate on equality facts

> **Invariant:** [OPT-050](invariants.md#opt-050--equality-facts-require-a-value-discriminating-collation)

Every equality-derived fact above is a **value-level** claim, but a SQL equality only implies value equality when its effective comparison collation is value-discriminating — a NOCASE/RTRIM comparison passes value-*different* rows (`'Bob' = 'bob'` under NOCASE). Extraction is therefore gated per conjunct. The gate itself lives in `planner/analysis/comparison-collation.ts` in three input shapes — the same rule each time (both contributed collations BINARY, else both operands statically non-textual): `isValueDiscriminatingEquality` over two plan nodes, `isValueDiscriminatingTypePair` over two declared type slices (the `USING` join extractor, which has no operand expressions), and `isValueDiscriminatingAstComparison` over raw AST plus declared column metadata (CHECK / assertion extraction, which runs before plan nodes exist).

- **Effective collation is resolved exactly as the runtime does**, via the shared helpers in `planner/analysis/comparison-collation.ts`: the symmetric provenance lattice (explicit `COLLATE` > declared column collation > defaulted collation > BINARY; see `docs/types.md` § Comparison collation resolution) — a binary comparison resolves both operands' contributions (`emitComparisonOp`); `IN` merges the condition with every listed value / the subquery column (`emitIn`); each BETWEEN bound resolves against the tested expression independently (`emitBetween`). The access-path rule's collation-cover analysis (`effectivePredicateCollation`) is built on the same helpers, so plan-time facts and runtime behavior cannot drift. Note that constant folding preserves type metadata, so `'bob' COLLATE NOCASE` folds to a *literal whose type still carries NOCASE* — shape checks alone do not see the wrapper; the gates read operand **types**.
- **`extractEqualityFds`** (constant pins `∅ → col`, `col1 = col2` mirror FDs, EC pairs, constant bindings) extracts a conjunct only when it is value-discriminating (`isValueDiscriminatingEquality`): non-textual operands always qualify; textual operands require every contributed collation to be BINARY. A NOCASE-declared column's pin is *not* extracted — the declared-collation ≤1-row case flows through the independent covered-key path instead (below). This also gates what `rule-predicate-inference-equivalence` can infer and which omitted-insert defaults a filtered view contributes. Unlike the join equi-pair extractors, it carries **no** semantic-ordering gate, so a conjunct over a TIMESPAN/JSON operand still contributes facts that are value-false (`where d = 'PT60M'` also matches a `'PT1H'` row) — latent, not observable through any consumer today; see `docs/types.md` § "Semantic ordering" and `tickets/backlog/debt-filter-equality-facts-ignore-semantic-ordering`.
- **CHECK / assertion extraction** (`check-extraction.ts`, fed by `getCheckExtraction` and the assertion hoist) runs on raw AST + `TableSchema` before any plan nodes exist, so it uses the schema-level twin `isValueDiscriminatingAstComparison`: a bare column contributes its *declared* collation, a literal contributes BINARY, and any other operand contributes BINARY only when its subtree has no non-BINARY COLLATE wrapper and every column inside is BINARY-declared-or-non-textual. The gate **mirrors enforcement**: write-time CHECK evaluation resolves declared column collations (constraint-builder threads `collationName` into the NEW/OLD scope types) plus explicit wrappers — the same comparison read-path queries, ALTER backfill validation, and assertion enforcement compile. It applies to *every* value-level contribution — equality FDs/ECs/pins/bindings (all three `handleEquality` shapes, the guarded-body twins including the `valueEquality` mirror tags) **and domain constraints** (ranges, BETWEEN, IN enums: a text domain extracted from a NOCASE enforcement comparison over-claims for `ruleFilterContradiction` and the lens-prover's `enumerableDomain`). Guard *scopes* (`recognizeNegatedGuard`) are deliberately ungated: they only accept bare column/literal shapes, enforcement evaluates them under declared collations, and `buildPredicateFacts`' per-conjunct discharge gate already keeps filter rows within the declared-collation guard scope. A COLLATE wrapper inside a guard disjunct makes the whole CHECK unrecognized (pinned).
- **Covered-key detection** (`computeCoveredKeysForConstraints`): an equality constraint counts toward covering a candidate key only when its effective collation is BINARY or equals the constrained column's declared collation — the comparison must be at least as fine as the key's *enforcement* collation. This keeps the sound declared-collation case working (`where b = 'bob' and x = 1` over a NOCASE-declared PK genuinely implies ≤1 row) while rejecting the folded-NOCASE-literal shape.
- **OR-collapse gates**: both sites that collapse `col = lit OR col = lit …` — `predicate-normalizer.ts` `tryCollapseOrToIn`, which rewrites the *evaluated* predicate into an IN, and `constraint-extractor.ts` `tryExtractOrBranches`, which mints pushdown IN / OR_RANGE constraints — require every disjunct's effective comparison collation (written operand order) to **equal** the collation the collapsed form compares under: the column operand's own collation for IN (`effectiveInCollation`), the column's declared (index-ordering) collation for OR_RANGE specs. Strict equality, not the covered-key "BINARY or declared" rule — both directions are unsound otherwise (a NOCASE disjunct over a BINARY column under-matches after the rewrite; a BINARY disjunct over a NOCASE column over-matches). On any mismatch the **whole** OR stays residual — a completeness/performance loss only, like the >32-values bail. Plain literals carry no collation, so matched-collation collapses (including plain disjuncts over NOCASE-declared columns) are unaffected. The access-path rule's `effectivePredicateCollation` still resolves an OR `sourceExpression` to BINARY, but post-gate every surviving collapsed constraint's true collation equals the column's declared collation, so the collation-cover analysis is at worst conservative.
- **Join equi-pairs**: `extractEquiPairsFromCondition` (logical facts: key coverage, FD/EC propagation, FK alignment, join elimination, the coverage prover) requires value-discriminating equality *and* agreement on semantic ordering (`semanticOrderingsAgree` — see `docs/optimizer-joins.md` § Physical Join Algorithm Selection). `rules/join/equi-pair-extractor.ts` (physical hash/merge/bloom selection) keeps the semantic-ordering gate but does **not** gate on collation — it extracts every pair (a hash key resolves the pair's comparison collation through the symmetric lattice, so it matches exactly what `=` matches) and tags it with `collationsMatch` (merge join's admission bit) and `valueDiscriminating`; the physical join nodes (`BloomJoinNode` / `MergeJoinNode`) feed only `valueDiscriminating` pairs into `combineJoinKeys` / `analyzeJoinKeyCoverage` / `propagateJoinFds` / `propagateJoinMonotonicOn`, mirroring the logical extractor's gate. A `timespan_col = text_col` conjunct mints no pair in either extractor: the rows it matches (`'PT1H'` against `'PT60M'`) are not value-equal, so both the logical fact and the physical key would over-claim. Semantic-ordering-mixed and collation-*conflicting* conjuncts demote to the residual, where the canonical scalar comparison evaluates them. `COLLATE`-wrapped operands never form pairs in either extractor (operands must be bare column references) — a deliberate, pinned exclusion.
- **Key promotion from unique indexes** (`relationTypeFromTableSchema`): a `CREATE UNIQUE INDEX (col COLLATE x)` whose per-column collation is *finer* than the column's declared collation (e.g. BINARY index over a NOCASE column) is a real constraint but **not** a relation key — consumers interpret keys under output collations, and the finer index admits rows that are output-collation-equal. Promotion requires the index collation to equal the declared collation (or the declared collation to be BINARY).
- **`CollateNode` is deliberately not injective** (no `isInjectiveIn` override) even though COLLATE is value-injective: a passthrough would let `deriveProjectionColumnMap` land a key minted under the source collation on a column *published* under the COLLATE'd collation. Any future enablement needs a collation-strength gate at the key-propagation site (output collation at least as fine as the key's enforcement collation).

The Key Soundness property harness checks claimed keys under each key column's **output collation** (NOCASE folds case, RTRIM folds trailing spaces) over a mixed-case text zoo, so a regression in any of these gates surfaces as an observable over-claim.

## The reader rule: `isUniqueDeterminant`

> **Invariant:** [OPT-032](invariants.md#opt-032--coverage-is-not-uniqueness)

The single reader-side uniqueness primitive (`planner/util/fd-utils.ts`):

```typescript
isUniqueDeterminant(attrs, fds, columnCount, isSet): boolean
```

True iff `attrs` is provably row-unique on the relation: its FD closure covers every column **and uniqueness is reachable** —

- the relation is a **set** (two rows agreeing on `attrs` would agree on all columns = a duplicate, impossible in a set), or
- some **unguarded `kind: 'unique'` FD** has determinants ⊆ closure(attrs) (rows agreeing on `attrs` agree on that unique determinant set; ≤1 row per its tuple ⇒ ≤1 row per attrs-tuple).

Coverage alone — a determination-only closure path over a bag — proves nothing. An "an endpoint of the FD is a declared key" check is the one-FD special case of "a `'unique'` witness lies within the closure"; the reader rule strictly generalizes it. Guarded FDs participate in neither branch (`computeClosure` skips them; only unguarded `'unique'` FDs can witness).

Pure value coverage (no uniqueness claim) is available as `closureCoversAll(attrs, fds, columnCount)`. Closure-style consumers (ORDER BY pruning via `computeClosure`, GROUP BY simplification via `minimalCover`) deliberately use coverage: a determined trailing sort key / group column is redundant regardless of uniqueness.

All FD-surface uniqueness readers route through the primitive and take `isSet`: `deriveKeysFromFds(fds, columnCount, isSet)`, `hasAnyKey(fds, columnCount, isSet)`, `hasSingletonFd(fds, columnCount, isSet)` (≡ `isUniqueDeterminant(∅, …)` — constant pins on a bag do not claim ≤1-row; pinning every column of a *set* is a sound ≤1-row derivation), and the `isUnique` closure branch. Callers needing a positive uniqueness claim (sort/window strict-`monotonicOn`) call `isUniqueDeterminant` directly.

## `keysOf` / `isUnique`: the single uniqueness read path

> **Invariant:** [OPT-030](invariants.md#opt-030--uniqueness-is-read-through-one-surface)

Consumers must **not** hand-check all three surfaces. Read uniqueness through the two helpers in `planner/util/fd-utils.ts`, which reconcile them:

- `keysOf(rel): readonly (readonly number[])[]` — canonical, minimal, deduped candidate keys (each a sorted output-column-index array). It gathers, cheap → expensive: declared `keys`; the empty (≤1-row) key when `hasSingletonFd` holds; FD-derived keys (`deriveKeysFromFds`, kind-aware); and, **only if nothing smaller was found and `isSet` is true**, the all-columns fallback `[0..n-1]`. Result `[]` ⟺ the relation is a bag. The empty key `[]` subsumes all others. The `isSet` branch of the reader rule is what yields **derived keys above DISTINCT / GROUP BY**: a determination-covering `{a}` over a set is a genuine key (e.g. `select distinct a, b` over `check (b = a + 1)` carries key `[a]` above the DistinctNode).
- `isUnique(cols, rel): boolean` — true iff `cols` is a superkey: a superset of some `keysOf` entry, **or** a provably row-unique determinant per `isUniqueDeterminant`. An all-columns probe on a bag fails the rule on its own — no unique FD ⇒ false; if a unique FD exists, the relation cannot hold duplicate rows, so true is correct.

`rel` is anything with `getType()` and an optional `physical` (every `RelationalPlanNode` qualifies). Migrated consumers — `rule-distinct-elimination` (eliminate iff `keysOf(source).length > 0`), `rule-orderby-fd-pruning` (drop the whole Sort when the source is ≤1-row via `isAtMostOneRow(source)`; otherwise whole-tail prune once leading keys are `isUnique`), `rule-groupby-fd-simplification` (lift source keys into the cover) — all read through this surface, so the `isSet`/FD/declared representation can change later without touching them.

**Soundness vs completeness.** "100% accuracy" means **100% soundness** (never claim a key that does not hold — a correctness invariant; an over-claim makes DISTINCT/join elimination drop real rows) plus **best-effort completeness** (never *miss* a real key — NP-hard / data-dependent in general). Minimal-key derivation from a general FD set is the candidate-key enumeration problem (NP-hard in column count), so `keysOf` does **not** enumerate column subsets: `deriveKeysFromFds` seeds one candidate per existing FD, and the declared keys + all-columns fallback are always emitted regardless of FD cost. Over-capping enumeration loses **completeness only, never soundness**. The `test/property.spec.ts` "Key Soundness" harness is the empirical backstop for the soundness invariant.

## Equivalence classes

An **equivalence class** (EC) is a set of output column indices known to hold equal values for every row. ECs are derived from equality predicates (`col1 = col2` conjuncts in a Filter; equi-pairs in an inner join). They flow through operators alongside FDs — the per-operator table below applies to both. Two columns in the same EC can be freely substituted for each other in scalar expressions: that's what predicate-inference and ordering-pruning rules consume.

## Constant bindings

A **constant binding** (`ConstantBinding`) is a companion to a `∅ → col` FD: that FD says "this column is constant under this scope," while a binding additionally records **what value** it is pinned to. Bindings let consumers (predicate inference, ordering pruning) read off the value without re-walking the predicate AST.

Parameters are constants here. A `ParameterReferenceNode` is bound once before iteration and the same value is observed by every row — that matches the per-execution scope `computePhysical` describes, so `WHERE col = ?` produces both a `∅ → col` FD and a `ConstantBinding { attrs: [col], value: { kind: 'parameter', paramRef: ... } }`. Literal equality produces the same shape with `value.kind === 'literal'`.

Bindings are closed over equivalence classes: at every node that contributes bindings (Filter, inner join), if a binding pins column `c` to value `v` and there's an EC `{c, c2, ...}`, the binding's `attrs` are extended to cover every EC member. So `WHERE t.k = u.k AND t.k = 5` lands as a single binding `{ attrs: [t.k, u.k], value: literal 5 }` on the join's output — exactly the input the predicate-inference rule will read.

## Per-operator propagation

> **Invariant:** [OPT-042](invariants.md#opt-042--an-outer-join-drops-the-null-padded-sides-facts), [OPT-048](invariants.md#opt-048--dependency-facts-index-output-columns)

This table is canonical. [Rules § Key-driven row-count reduction](optimizer-rules.md#key-driven-row-count-reduction) restates the join arms from `analyzeJoinKeyCoverage`'s point of view; if the two ever disagree, this one is right.

| Operator                                  | FDs / ECs added or transformed                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `TableReferenceNode`                      | Seed `key → others` for each declared key (PK + UNIQUE), `kind: 'unique'`. Additionally seed FDs / EC pairs / constant bindings / `domainConstraints` from declared CHECK constraints **and from assertion-hoisted `not exists (…)` predicates** (cached per `TableSchema`); see *Check-derived contributions* below. CHECK / hoisted FDs fold **unconditionally** — they are `'determination'` (or guarded) claims and the kind-aware readers never read a determination as a uniqueness claim. EC pairs merge as always; bindings are then closed over the resulting EC list. |
| `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` | Pass child FDs/ECs through unchanged.                                                                                                |
| `RetrieveNode`                            | Pass source pipeline's FDs / ECs / constant bindings / ordering through unchanged. Retrieve is a marker for the module/Quereus execution boundary; its output is the source pipeline's output. |
| `FilterNode`                              | Inherit child. For each equality conjunct: `col = literal` or `col = ?` ⇒ `∅ → col` FD plus a `ConstantBinding`; `col1 = col2` ⇒ EC merge plus the bi-directional FDs, all folded **unconditionally** as `'determination'` (the kind-aware readers never read them as uniqueness claims). **Guard activation** (`activateGuardedFds`): a guarded source FD whose guard the predicate entails is stripped to its unconditional twin (`stripGuard`, kind-preserving) — unconditionally, with no endpoint gate. A guarded determination activates as a determination (harmless to the readers); a guarded `'unique'` FD (partial UNIQUE index) activates as `'unique'`, sound at the activating Filter because its rows all satisfy the guard and filtering only shrinks the row set — fan-out hazards are handled by the join-side kind downgrade, not here. A genuine value-equality additionally lifts its equality as an EC — that EC lift (and only it) keys off the `valueEquality` marker, because a coincidental mutual-determination mirror (two partial UNIQUE indexes on a 2-col table, or `b=a+1`+`a=b-1` checks) is structurally identical but is not an equality, so lifting an EC there would be unsound. Bindings are then closed over the resulting EC list. |
| `ProjectNode` / `ReturningNode`           | Project FDs/ECs through the source→output mapping built from (a) bare column-reference projections **and** (b) *injectively-derived* projections — scalar expressions that reference exactly one source attribute `a` (with all other leaves being `LiteralNode` / `ParameterReferenceNode`) and satisfy `ScalarPlanNode.isInjectiveIn(a).injective`. The derived column is treated as a synonym of `src(a)`: source keys/FDs/ECs flow through to its output index. Non-injective expressions still drop out. When both `a` and an injective derivation of `a` are projected (`SELECT id, id+1`), the helper copies the unique key onto the derived column, and additionally emits the bi-directional FDs between the bare and derived columns **unconditionally as `'determination'`** — a value bijection, never a uniqueness claim; the kind-aware readers refuse to derive a key from it on a bag (`SELECT -c, c` over a non-unique `c`). Built-in injectivity covers unary `±x`, `x ± const`, `const ± x`, and same-logical-type `CAST`; scalar functions opt in via the `injectiveOnArgs` trait on the `FunctionSchema`. **`isSet` soundness:** a projection that drops a row-distinguishing column turns a set into a bag (`select x from <set on (x,y)>` may repeat `x`), so `getType().isSet` is **not** inherited blindly — it is true only if a declared source key survives the projection, or the source is a set *and* every source column survives (the all-columns key survives). |
| `AliasNode`                               | Pass through unchanged.                                                                                                                     |
| `AssertedKeysNode`                        | Pass every child physical property through unchanged (pure pass-through; attribute IDs preserved), then **merge** a set of asserted declared-key FDs via `addFd`. This is the **lens boundary** FD producer (`docs/lens.md` § FD contribution to the optimizer): the declared-logical-key analogue of `TableReferenceNode`'s declared-key seeding, contributing a key the compiled view body alone may not surface (a lens-`proved`/`vacuous` key local propagation lost, or a row-time-`enforced` key answered by a basis covering structure). Soundness-gated by the lens obligation **kind** — `proved`/`vacuous` contribute an unconditional `key → others` (resp. `∅ → all_cols`); `enforced-set-level` `row-time` contributes a **guarded** `key → others [guard: key IS NOT NULL]` (a NULL-skipping `unique` is only conditionally unique); `commit-time` and non-key obligations contribute nothing (a mid-statement duplicate would make the FD unsound). The node vanishes at runtime (emits its source directly). |
| `DistinctNode`                            | Pass source FDs / ECs / constant bindings through unchanged. The "all-columns is a key" claim lives on `RelationType.isSet = true` set in `getType()` — `keysOf` reads it as the all-columns fallback key, which is what lets `rule-distinct-elimination` drop a redundant DISTINCT over an already-set source. |
| `LimitOffsetNode`                         | Pass source FDs / ECs / constant bindings / `domainConstraints` / `monotonicOn` through unchanged. When `LIMIT` is a **compile-time-constant** `≤ 1` (numeric `LiteralNode`, peeled through `CastNode`/`CollateNode`; `LIMIT 0` and `LIMIT 1` both qualify), the relation is provably ≤1-row, so `singletonFd(colCount)` (`∅ → all_cols`) is **merged onto** the source FDs (not replacing them) — letting empty-key-aware machinery (join coverage, DISTINCT elimination, ORDER-BY/GROUP-BY pruning) fire over a `LIMIT 1` source. `OFFSET` does not gate this (offset only removes rows). Parameter / expression / subquery / `NULL` limits stay pass-through (not known ≤1-row at plan time). `estimatedRows` is `min(sourceRows, L)` for a constant `L ≥ 0`. |
| `ValuesNode`                              | A VALUES clause with `rows.length ≤ 1` is provably ≤1-row and emits `singletonFd(colCount)` (`∅ → all_cols`). Multi-row VALUES remains a bag (no FDs). `estimatedRows` is `rows.length` in both branches. Note: all-literal VALUES is rewritten to `TableLiteralNode` by relational constant folding before the physical pass runs, so this propagation only fires for VALUES whose cells cannot be pre-evaluated (parameter references, non-deterministic functions, correlated subqueries). |
| `StreamAggregateNode` / `HashAggregateNode` / `AggregateNode` | A source FD `X → Y` survives only if `X` and `Y` are all column-reference GROUP BY columns; project to output indices. ECs project the same way. Additionally emit the group-key FD `{0..groupCount-1} → (all_other_out_cols)`; with no GROUP BY, emit the singleton `∅ → all_out_cols` instead. The final SELECT projection over a **non-bare** group expression (collated / arithmetic / any computed key) references this group output column **directly** (`buildFinalAggregateProjections`): a recompute would resolve the inner column to a base-table attribute id that is absent from the aggregate output, so `deriveProjectionColumnMap` could not map it and the group-key FD would be dropped at the projection (`keysOf(root) = []`). Referencing the aggregate column keeps the key, republished under exactly its grouping collation. |
| `JoinNode` / `BloomJoinNode` / `MergeJoinNode` (inner / cross) | `union(leftFds, shift(rightFds, leftCols))`, with a non-preserved (fanned-out) side's FDs — guarded ones included — first downgraded `'unique'` → `'determination'` (`downgradeUniqueFds`: the value claims survive for the closure consumers, and the kind-aware readers never read them as keys). For each equi-pair `(L, R')`: EC merge `L ≡ R'` plus the bi-directional FDs, emitted **unconditionally as `'determination'`** (uniqueness facts live exclusively on the preserved-key FDs). Constant bindings union both sides (right shifted), then close over the merged EC list — so a one-sided `t.k = 5` plus an equi-pair `t.k = u.k` lands as a single binding covering both columns. Preserved keys (incl. the empty ≤1-row key, see below) are layered on as `key → all_other_join_cols` FDs, `kind: 'unique'`. |
| Join (left outer)                         | Keep left's FDs/ECs/bindings only; drop right's and equi-pair contributions (NULL-padded rows can violate them). When the left side is **not** preserved (the equi-predicate covers no right key, so the join fans the left side out) its FDs — guarded included — are downgraded to `'determination'` (mirroring the inner/cross arm). Preserved left keys (incl. the empty key when both sides are ≤1-row) are layered on. |
| Join (right outer)                        | Mirror of left outer.                                                                                                                       |
| Join (full outer)                         | Drop both sides' FDs/ECs/bindings (conservative). No empty-key propagation — two non-matching ≤1-row sides produce two padded rows.        |
| Join (semi / anti)                        | Left's FDs/ECs/bindings survive (sourced via `keysOf`, so FD-derived and ≤1-row empty keys flow through); no right contribution.            |
| `KeySetSemiJoinNode`                      | Same shape as the semi join it replaces: the target (left) side's `fds` / `equivClasses` / `constantBindings` / `domainConstraints` / `inds` pass through verbatim (all per-row claims, and the output is a row-subset of the target); no key-source contribution. `ordering`, `monotonicOn`, and `accessCapabilities` are deliberately **not** propagated — emission order depends on the seek-vs-scan choice the node makes at runtime, so claiming either could elide a Sort the plan needs. Matches `BloomJoinNode`, which propagates neither. |
| Join (≤1-row empty-key propagation)       | A side is ≤1-row when `isUnique([], side)` holds (declared empty key, or `∅ → all` FD from a scalar aggregate / full-PK-equality filter). A ≤1-row side is always "key-covered" (`[] ⊆ any` eq-set), so the other side's keys survive even with no equi-pairs. When **both** sides are ≤1-row (inner / cross / left / right — *not* full outer), the join emits the empty key, materialized as the singleton `∅ → all_cols` FD via `superkeyToFd([])`. |
| `AsofScanNode`                            | Inherit left's FDs/ECs. Right's FDs are dropped (asof = at-most-one match, NULL-padded in outer mode). The asof condition is not an equality, so no equi-pair FDs. |
| `SetOperationNode`                        | Conservative: drop all physical FDs/ECs. Logical `getType().keys`: `intersect` / `except` keep the left side's keys (the result is a subset of left rows); `union` / `unionAll` drop them (the right side can reintroduce a left key's value, and UNION ALL duplicates) — set-ness of UNION/INTERSECT/EXCEPT is carried by `isSet`. Copying `leftType.keys` for a union would over-claim. |
| `WindowNode`                              | Pass source FDs/ECs through unchanged (window output columns are not in any new FDs — deferred).                                            |

`domainConstraints` propagate alongside `constantBindings` using the same projection / shift / drop rules: pass-through nodes (Filter, Distinct, Alias, Window, Sort, Limit, scan family) inherit them unchanged; Project/Returning/Aggregate keep only constraints whose column maps to an output column; inner/cross joins concat with shift; LEFT/RIGHT outer keep only the preserved side; FULL outer and SetOperation drop everything. Filter does **not** intersect domains with the filter predicate; multiple constraints on the same column may coexist (no implicit intersection at this layer).

## Inclusion Dependency Tracking

> **Invariant:** [OPT-056](invariants.md#opt-056--an-inclusion-dependency-is-dropped-when-unsure)

An **inclusion dependency** (IND) is a fourth dependency-family member of `PhysicalProperties`, sitting beside `fds` / `equivClasses` / `constantBindings` / `domainConstraints`. Where an FD asserts *determination within* this relation, an IND asserts *existence in another* relation: for every row of this node, the tuple formed by `cols` is guaranteed to appear in another relation's `targetCols`. It is strictly weaker than, and orthogonal to, an FD.

```typescript
interface InclusionDependency {
  readonly cols: readonly number[];     // output-column indices on THIS relation
  readonly target: IndTarget;
  readonly nullRejecting: boolean;      // true ⇒ a NULL in any `cols` excludes that row from the guarantee
}

type IndTarget =
  // child.cols ⊆ table.targetCols, where targetCols is a key of that table. The FK-seeded form.
  | { readonly kind: 'table'; readonly schema: string; readonly table: string; readonly targetCols: readonly number[] }
  // Minted by the lens existence-anchor injection.
  | { readonly kind: 'relation'; readonly relationId: string; readonly targetCols: readonly number[] };
```

`cols[i]` pairs *positionally* with `target.targetCols[i]`. `targetCols` index into the **target** relation, never this node's output, so projection and join-shift never remap them.

**Seeding source.** `TableReferenceNode` seeds one IND per declared foreign key whose referenced columns are exactly the parent's primary key (`seedTableForeignKeyInds` in `util/ind-utils.ts`): `cols` = the FK child columns (which equal output indices at a table reference), `target` = `{ table, schema, targetCols: parent PK }`, and `nullRejecting` = **(any FK child column nullable)** — the *same* bit `lookupCoveringFK` computes as `CoveringFKMatch.nullable`, factored into the shared `fkChildNullable` helper so the rule helper and the seeded property cannot diverge. A malformed FK referencing non-PK columns seeds nothing (mirrors `lookupCoveringFK`'s defensive PK cross-check).

**Soundness boundary (load-bearing).** A false IND (**over-claim**) is unsound — it asserts a row exists that does not, which would silently mis-prove coverage downstream. A missing IND (**under-claim**) only forgoes an optimization (the fallback path runs — safe). Therefore **every propagation rule is conservative: drop when unsure.** This matches the coverage prover's "a false `Covers` is unsound ⇒ be conservative" bar and the RI-trust assumption `ind-utils.ts` already makes (declared FKs treated as hard inclusion dependencies; `pragma foreign_keys` defaults on). The `test/optimizer/inclusion-dependencies.spec.ts` property/law harness is the empirical backstop: for representative optimized plans it materializes each relational node and asserts every propagated IND actually holds (each row's `cols` projection, excluding NULL-rejected rows, is present in the target's `targetCols` projection) — the IND analogue of the Key Soundness harness.

**Enforcement readiness.** Admitting a future runtime *enforcement* consumer (one that discharges an FK/lens obligation by checking the propagated set) does **not** raise the propagation bar, because enforcement obligations come from the authoritative FK/lens *declaration*, never from the propagated set. The propagated IND can only ever *add* a discharge opportunity (skip a redundant check) — and an under-claim there just runs the check. That asymmetry is why the propagation rules never have to be sound-for-enforcement, even though `IndTarget` also carries the `relation` variant minted by the lens existence-anchor injection (`schema/lens-compiler.ts`), which records `anchor.key ⊆ member.key` per mandatory member on the lens slot for the lens prover rather than for the general optimizer.

**Per-operator propagation** (helpers `projectInds` / `shiftInds` / `mergeInds` / `addInd` in `util/fd-utils.ts`, capped at `MAX_INDS_PER_NODE = 64`; join branch table in `propagateJoinInds`, `nodes/join-utils.ts`):

| Operator                                                       | INDs                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `TableReferenceNode`                                           | Seed one IND per declared FK→parent-PK (see *Seeding source* above).                                                                       |
| Scan family / `RetrieveNode` / `FilterNode` / `AliasNode` / `SortNode` / `DistinctNode` / `LimitOffsetNode` / `OrdinalSliceNode` / `EagerPrefetchNode` | Pass through unchanged. Row removal (filter, dedup, limit/slice, a row-reducing seek) preserves a per-row inclusion claim, so the claim survives on the surviving subset; `RetrieveNode` is a bit-for-bit boundary marker (without its pass-through the seeded INDs would be lost at every module boundary). |
| `ProjectNode` / `ReturningNode`                                | `projectInds`: **all-or-nothing** — drop an IND when *any* of its `cols` is projected away (no partial-dependent survival, unlike `projectFds`); remap survivors' `cols` to output indices; `target.targetCols` are **not** remapped. |
| Join (inner / cross)                                           | `union(leftInds, shiftInds(rightInds, leftCols))`.                                                                                         |
| Join (left)                                                    | Keep left INDs; **drop** the null-padded right side's INDs.                                                                                |
| Join (right)                                                   | Keep `shiftInds(rightInds, leftCols)`; drop left.                                                                                          |
| Join (semi / anti)                                             | Keep left INDs only (right columns are not in the output).                                                                                 |
| Join (full)                                                    | Drop both (either side can be NULL-padded).                                                                                                |
| `FanOutLookupJoinNode`                                         | Fold each branch through `propagateJoinInds` (inner/left per branch mode) exactly as FDs fold — keeps the outer's seeded INDs and unions each inner branch's shifted INDs. Without this the FK-seeded INDs are lost when `rule-fanout-lookup-join` rewrites the join chain into this node. |
| `AggregateNode` / `SetOperationNode` / `WindowNode`            | Emit none — these reshape relational identity.                                                                                             |
| `AsyncGatherNode` (crossProduct)                               | Could shift+merge like FDs, but **deferred** (no consumer) — left undefined with a code comment.                                           |

**Relationship to the FK-declaration helpers.** The propagated IND set is a **parallel derivation surface**, not a migration of `util/ind-utils.ts`. The three FK rules (`rule-anti-join-fk-empty`, `rule-semi-join-fk-trivial`, `rule-join-elimination`) and the `lookupCoveringFK` / `isRowPreservingPathToTable` helpers still consume the FK *declaration* directly — they need the nullability split and positional composite pairing that a coarse `child ⊆ parent` fact does not carry. The **only consumer** of `PhysicalProperties.inds` is the coverage prover: its inner/cross no-row-loss obligation tries the propagated IND surface first and falls back to the structural `lookupCoveringFK` check (see [Coverage proving](#coverage-proving) below). See [Optimizer Rules § Key-driven row-count reduction](optimizer-rules.md#key-driven-row-count-reduction) for the on-demand helpers and rules.

## Check-derived contributions

Declared `CHECK` constraints contribute to the table reference's physical properties in addition to declared keys. The walker (`planner/analysis/check-extraction.ts`, cached per `TableSchema` via `WeakMap`) recognizes a small set of syntactic shapes per check and decomposes through `AND`.

**Row-invariant gate.** Before any shape recognition, each check must qualify as a *row invariant* — a predicate every stored row image is guaranteed to satisfy, i.e. one enforced on every path a row can enter the table. Two **check-level** legs (they describe when the whole check runs) are both required: (1) its **operation mask covers both `insert` and `update`** — enforcement filters by `shouldCheckConstraint`, so e.g. a `check on insert (...)` never runs on UPDATE and an UPDATE can legally store a violating row (DELETE membership is irrelevant: a delete adds no row image; ALTER ADD CHECK backfill validation plus the `permitsGrandfatheredCheckViolators` consumer gate cover pre-existing rows); (2) it is **not deferred** (`deferrable` / `initiallyDeferred` — defensive: not declarable on a table CHECK today, but a deferred check is enforced at commit so same-transaction reads could see violating rows). A third leg — **no `old.` row-image reference** — is screened **per AND-conjunct** inside the conjunction walker, not at check level: `old.a = b` is a transition constraint over the previous row image, and OLD is NULL on the INSERT path, so even a default-mask `check (old.a = b)` admits rows violating the same-row reading. But under SQL ternary logic `C1 AND C2` is FALSE whenever `C2` is FALSE regardless of `C1`, so each `old.`-free conjunct independently holds over stored rows and extracts normally even when a sibling conjunct references OLD (e.g. `check ((old.id is null or id = old.id) and status in ('a','i'))` still contributes the `status` enum). The per-conjunct argument does **not** extend through OR: an `old.` ref anywhere inside a non-AND conjunct (one disjunct of an implication form, a BETWEEN bound, an IN list, a compound operand) kills that whole conjunct. `new.<col>` references are same-row over the stored NEW image and extract normally (the bare-name resolution in `columnIndexFromExpr` deliberately tolerates the qualifier), as do self-table qualifiers (`t.col`). Synthetic checks minted by the assertion hoist (`assertion-hoist-cache.ts`) carry the default `insert|update` mask so they pass the gate — an assertion holds for every stored row regardless of how it entered.

The per-check shape table. Every FD it emits is `kind: 'determination'` — a CHECK constrains values, never row counts — so all of them fold unconditionally; the kind-aware readers never read one as a uniqueness claim. That is what keeps a narrow `select distinct a, b` over a non-keyed `check (b = a + 1)` table from re-deriving `{a}` as a phantom key.

| Shape                            | Contribution                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `col1 = col2`                    | bi-directional FDs `{col1 ↔ col2}` plus EC pair `[col1, col2]`                      |
| `col = <literal>`                | FD `∅ → col` plus a literal `ConstantBinding`                                      |
| `col = <expr>` (single-col RHS)  | one-way FD `<other-col> → col` (no EC, no binding)                                 |
| `col >= lit` / `col > lit`       | range domain with `min` (inclusive on `>=`, exclusive on `>`)                      |
| `col <= lit` / `col < lit`       | range domain with `max`                                                            |
| `col BETWEEN lit AND lit`        | range domain with both bounds inclusive                                            |
| `col IN (lit, lit, ...)`         | enum domain                                                                        |
| `<expr-a> AND <expr-b>`          | recurse into both                                                                  |

Disjunctions (`OR`), `NOT`, subqueries, and any function call the schema marks non-deterministic skip the whole CHECK — with the **exception** of implication-form disjunctions covered in the next subsection. Schema validation already rejects non-deterministic functions in CHECK at CREATE TABLE time, so the in-cache extraction passes a `() => true` callback; the function-level callback exists for tests and future external callers.

## Guarded (conditional) FDs

A *guarded FD* `K → D | guard` activates only when a surrounding predicate entails every clause of `guard`. The canonical source is an implication-form CHECK such as `CHECK (status <> 'active' OR assigned_region = customer_region)` — read as "if `status = 'active'` then `assigned_region = customer_region`". The check extractor flattens the top-level `OR` chain, recognizes all-but-the-last disjunct as the negation of an equality / is-null clause, and emits guarded body FDs:

| Disjunct shape                | Negation = guard clause                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `col <> literal`              | `eq-literal { column, value }`                                |
| `col1 <> col2`                | `eq-column { left, right }`                                   |
| `col IS NOT NULL`             | `is-null { column, negated: false }` (guard = `col is null`)  |
| `col IS NULL`                 | `is-null { column, negated: true }`  (guard = `col is not null`) |
| `col <  literal`              | `range { col, min: lit, minInclusive: true,  maxInclusive: false }` (guard = `col >= lit`) |
| `col <= literal`              | `range { col, min: lit, minInclusive: false, maxInclusive: false }` (guard = `col > lit`)  |
| `col >  literal`              | `range { col, max: lit, maxInclusive: true,  minInclusive: false }` (guard = `col <= lit`) |
| `col >= literal`              | `range { col, max: lit, maxInclusive: false, minInclusive: false }` (guard = `col < lit`)  |

`lit op col` shapes are operand-flipped (`flipComparison` in `predicate-shape.ts`) so the column ends up on the left before the negation table above is applied. NULL literal bounds are rejected.

The body is recognized only as a guarded **equality** (bi-directional FDs for `col1 = col2`, `∅ → col` for `col = literal`, one-way for single-column expressions). No equivalence pairs, constant bindings, or domain constraints are lifted from a guarded body — those are unconditional facts and a guarded source cannot guarantee them.

**Partial UNIQUE indexes** are the second producer of guarded FDs. `CREATE UNIQUE INDEX (K) WHERE P` records a `predicate` on the synthesized `UniqueConstraintSchema`; `relationTypeFromTableSchema` skips it (a partial UNIQUE constraint is not a relation-level key), and `planner/analysis/partial-unique-extraction.ts` instead emits a guarded FD `K → (all_cols \ K) | P` per partial UC. The recognizer flattens `P`'s top-level `AND` and maps each conjunct to a guard clause:

| Conjunct shape                       | Guard clause                                            |
| ------------------------------------ | ------------------------------------------------------- |
| `col = literal`                      | `eq-literal { column, value }`                          |
| `literal = col`                      | same (normalized)                                       |
| `col1 = col2`                        | `eq-column { left, right }`                             |
| `col IS NULL`                        | `is-null { column, negated: false }`                    |
| `col IS NOT NULL`                    | `is-null { column, negated: true }`                     |
| `NOT col`  (declared NOT NULL + numeric only)  | `eq-literal { column, value: 0 }`  (SQL boolean FALSE)  |
| `col IN (lit, lit, …)`               | `or-of [eq-literal { col, lit_i } …]` (singleton collapses) |
| `col >  literal` / `literal <  col`  | `range { col, min: lit, minInclusive: false, maxInclusive: false }` |
| `col >= literal` / `literal <= col`  | `range { col, min: lit, minInclusive: true,  maxInclusive: false }` |
| `col <  literal` / `literal >  col`  | `range { col, max: lit, maxInclusive: false, minInclusive: false }` |
| `col <= literal` / `literal >= col`  | `range { col, max: lit, maxInclusive: true,  minInclusive: false }` |
| `col BETWEEN lit AND lit`            | `range { col, min, max, minInclusive: true, maxInclusive: true }` (`NOT BETWEEN` is rejected) |
| `a OR b OR …`                        | `or-of [recognize(a), recognize(b), …]` (flattens nested OR) |

The `or-of` variant is a flat disjunction — sub-clauses are themselves guard clauses from the first five rows, never another `or-of` (the recognizer flattens nested OR chains at construction time). Singleton OR / IN lists collapse to the underlying clause.

The `NOT col` rewrite to `col = 0` is sound under three-valued logic *for numeric columns*: SQLite encodes boolean FALSE as integer 0, and `WHERE NOT col` on a numeric column excludes both `col IS NULL` and `col = 0` rows. The producer rejects `NOT col` on nominally-nullable columns because the NOT-NULL gate (below) is syntactic — it doesn't recognize `NOT col` as a NULL-excluding witness. The producer additionally requires the column's logical type to be numeric: for TEXT, BLOB, and BOOLEAN columns the rewrite is unsound because the consumer matches `eq-literal { col, value: 0 }` via strict `sqlValueEquals` — TEXT `''` and boolean `false` are falsy under `NOT col` but compare unequal to integer 0, so the rewrite would activate the FD over rows the runtime UC never excluded. Both the producer (`partial-unique-extraction.ts`) and the consumer (`buildPredicateFacts` in `fd-utils.ts`) gate the rewrite the same way; the consumer still records `IS NOT NULL` for the column regardless of type (that's sound on its own).

If **any** conjunct fails to map, the whole FD is dropped — a partial guard would falsely activate over rows the unrecognized conjunct excludes. The NOT-NULL gate requires each UC column to be effectively non-NULL inside the partial scope: it qualifies if either (a) it is declared NOT NULL on the table, or (b) the partial predicate has a matching `col IS NOT NULL` conjunct — sound because that conjunct is itself one of the guard clauses, so discharge cannot activate the FD over rows where the column might be NULL. A nullable UC column whose `IS NOT NULL` is not in the predicate would admit multiple NULLs inside scope and is rejected.

Extraction is cached per `TableSchema` via `getPartialUniqueGuardedFds`. The downstream activation path is identical to the implication-form CHECK case: a Filter whose predicate entails `P` strips the guard and the FD becomes an ordinary key downstream, unlocking DISTINCT elimination, GROUP BY simplification, ORDER BY pruning, and FK→PK join elimination for queries inside the partial scope.

## Coverage proving

`planner/analysis/coverage-prover.ts` reuses this same clause vocabulary to decide whether an explicit materialized view *covers* a UNIQUE constraint — i.e. its materialized row set is observation-equivalent to the set of rows the constraint governs, keyed for a point lookup. The recognition rules (shape / projection / ordering / predicate alignment) and the soundness boundary are documented in [Derived-Row Constraints § Covering structures](mv-constraints.md#covering-structures). Two reusable pieces live alongside the partial-UNIQUE extractor:

- `recognizeConjunctiveClauses(expr, tableSchema, resolve?)` — a side-effect-free wrapper over the same conjunct recognizer used for guarded FDs (no new predicate shapes), decomposing a predicate AST into the `GuardClause` vocabulary above. The optional `resolve` injects a qualifier-aware column resolver (default: bare-name against `tableSchema`); the coverage prover passes one for join-body `WHERE` clauses so a lookup-side reference becomes an unrecognized conjunct rather than mis-resolving onto `T`.
- `guardClausesEntail(a, b)` — conservative conjunction entailment: every clause of `b` is entailed by some clause of `a` (clause-set superset, range subsumption on the same column, and `is not null` satisfied by any clause that pins the column non-NULL). A false result is always safe.

The prover reads the body's `WHERE` and `ORDER BY` from the **body AST**, not the optimized plan, because the optimizer absorbs a sargable `WHERE` into an index range seek and drops the `Sort` once an index supplies the order — so the plan understates the predicate and ordering. It uses the optimized plan only for the structural shape check and the output→base-column projection mapping (via stable attribute IDs). The AST column resolution is **qualifier-aware** for join bodies (`makeBodyColumnResolver`): `alias.col` resolves to a base-table `T` column only when `alias` denotes `T`'s reference (collected from the body FROM clause), and a bare `col` only when `T` has it and no lookup-side column shares the name; a term on a lookup-side column resolves to "not a `T` column", so an `ORDER BY` on it fails as `ordering-mismatch` and a `WHERE` on it as an unrecognized conjunct (`predicate-entailment`) instead of mis-mapping onto a same-named `T` column. This lets a 1:1 join whose lookup key reuses a UC column name (`line_items ⋈ products on l.sku = p.sku`) cover.

For a **join body**, the plan additionally drives the 1:1 admission test, two obligations. The **no-row-loss** obligation admits a join two ways: `T` on the row-preserving side of an outer join, **or** an `inner`/`cross` join whose equi-pairs are an inclusion dependency from the `T`-side relation to the lookup table's PK over a full-row-set lookup side (`innerJoinRetainsConstrainedTable`). The inclusion obligation is **IND-derived**: `indDerivedNoRowLoss` first consults the propagated `PhysicalProperties.inds` on the `T`-side subtree — admitting when a non-`nullRejecting` IND's `(cols → targetCols)` pairing matches the join's equi-pairs against the lookup parent's key — and falls back to the structural NOT-NULL-FK-on-`T` check (`lookupCoveringFK` + `!match.nullable`) when no IND discharges it. Both gate on the same preconditions (equi-only join, full parent row set via a `rangeBoundedOn`-aware scan walk, non-null inclusion to the parent's key), so they return **identical** verdicts on every single-FK shape (a `structuralOnly` seam on `proveCoverage` lets the equivalence test compare them directly); the seeded IND mirrors `lookupCoveringFK` exactly. The IND path's additional reach is **composition**: a multi-hop `T → M → P` chain carries a threaded IND (`M.cols ⊆ P.pk`) onto the `T ⋈ M` sub-frame via join propagation, discharging the outer `⋈ P` join that no single `lookupCoveringFK(T, P, …)` call can prove. Propagation alone carries the reaching IND for the left-deep chain — no transitive IND *closure* is needed. All of this leans on the same inclusion-dependency trust `rule-join-elimination`'s INNER branch relies on.

The **no-fan-out** obligation reads `isUnique(T.pk, topmostJoin)` against the **join-frame** FDs (`analyzeJoinKeyCoverage` → `propagateJoinFds` emit `T.pk → all_join_cols` exactly when each `T` row matches ≤1 lookup row) — deliberately not the projected body root, where `T`'s own PK FD would mask the fan-out once the lookup columns are projected away. A NOT-NULL FK→PK join satisfies both at once (the FK target is the unique PK). The link the prover records is informational.

### Effective-key proving ("body proves it")

`coverage-prover.ts` answers a **second, distinct** question via `proveEffectiveKeyUnique(root, keyColumns)`: is the body's *own output relation* provably unique on `keyColumns` (output-column indices) via its effective key? It delegates entirely to the unified `isUnique` surface (declared keys, FD-closure-derived keys, the all-columns/`isSet` fallback) and adds only an out-of-frame guard and a diagnostic result shape (`proved` | `not-a-key` | `out-of-frame`). This is the obligation primitive the [lens prover's `obligation: proved` class](lens.md#constraint-attachment) consumes — e.g. a `select x, y, sum(z) from t group by x, y` body whose group-key FD `{0,1} → {2}` (from `propagateAggregateFds`) makes the output intrinsically one row per `(x, y)`, vacuously satisfying a logical `unique(x, y)` at zero enforcement cost.

This is **not** a generalization of base-table `proveCoverage`, and is deliberately kept separate: an FD-derived output key cannot prove a *base-table* constraint. A `group by x` body's output is always unique on `x` whether or not the base table satisfies `unique(x)` — grouping collapses base-row duplicates, so two base rows with `x = 5` (a base violation) still yield one output row, masking the conflict. Aggregating bodies also drop the base PK, so the conflicting-base-row half of the covering contract is unrecoverable. `proveEffectiveKeyUnique` is therefore a proof about the **derived (output) relation's own** constraint; its soundness notes (ordering / PK-reconstruction irrelevant, NULL-skip by subsumption, superkey semantics) live in the module doc.

**Lens-attached constraints and the FD framework.** Because a logical table inlines into the plan as an ordinary registered `ViewSchema` over basis, the FD/key facts a logical constraint contributes ride the *existing* propagation path with no new optimizer surface: a basis NOT-NULL `unique`/PK becomes a relation key (`type-utils.ts`), propagates through the lens body's projection/join FDs, and is exactly what `proveEffectiveKeyUnique` reads when the [lens prover](lens.md#constraint-attachment) classifies a logical constraint as `proved`. A *proved* logical constraint thus needs no enforcement structure — the optimizer already knows the output is unique on its columns.

## Assertion-derived premises

> **Invariant:** [OPT-052](invariants.md#opt-052--provenance-is-informational)

`CREATE ASSERTION` whose CHECK matches the canonical *trivially universal* shape

```
not exists (select 1 from T [where P])
```

is treated as if `T` carried a per-row `check (not P)`. The classifier
(`planner/analysis/assertion-classifier.ts`) recognizes the shape syntactically
— a top-level `NOT` over an `EXISTS` subquery whose SELECT has exactly one
base-table FROM, no joins / GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET /
set ops, and an optional `where` clause that references only columns of `T`
(no correlated refs, no subqueries, no aggregates, no non-deterministic
calls). When all gates pass, the negated inner predicate `NOT P` is pushed
through De Morgan / comparison-flip rules (`negateAst`) and fed into the
existing `extractCheckConstraints` pipeline, producing FDs / EC pairs /
constant bindings / domain constraints exactly as a declared CHECK would.

Out of scope (silently falls through to commit-time enforcement):

- Existential assertions (`check (exists (...))`).
- Multi-table assertions / joined subqueries.
- Aggregate-form assertions (`(select count(*) from t) = 0`, `sum(qty) >= 0`).
- Unconditional-empty assertions (`not exists (select 1 from t)`) — would
  synthesize `check (false)`; deliberately not recognized.
- View-targeted assertions (only base `TableSchema` targets qualify).
- Non-deterministic calls inside the inner predicate.

Wiring lives in `TableReferenceNode.computePhysical`, which calls
`getAssertionHoistedConstraints(schemaManager, tableSchema)` from
`planner/analysis/assertion-hoist-cache.ts`. Results are cached per
`(SchemaManager, TableSchema)` via a `WeakMap`-backed registry and a
generation counter the registry bumps on every `assertion_added` /
`assertion_removed` / `assertion_modified` event from `SchemaChangeNotifier`
(see `schema/change-events.ts`). The cache compares generations on lookup
and recomputes on mismatch — so `DROP ASSERTION` invalidates the hoisted
view automatically.

Hoisted contributions tag each emitted FD / `ConstantBinding` /
`DomainConstraint` with `source = { kind: 'assertion', name }` (see
`ConstraintProvenance` in `plan-node.ts`). The dedup helpers in
`fd-utils.ts` compare structural fields only and ignore `source`, so when a
declared CHECK and a hoisted assertion produce structurally identical facts
the table reference (which merges declared first) keeps the
`declared-check`-flavored entry. Provenance is informational; downstream
rules ignore it.

**Soundness:** hoisted facts are an additive optimizer signal only.
`AssertionEvaluator` in `core/database-assertions.ts` continues to run the
violation query at COMMIT and remains the source of truth.

## Guard activation

> **Invariant:** [OPT-034](invariants.md#opt-034--closure-helpers-skip-guarded-fds), [OPT-036](invariants.md#opt-036--a-guard-is-discharged-only-at-the-producing-filter), [OPT-038](invariants.md#opt-038--projection-drops-an-fd-whose-guard-loses-a-column)

**Activation lives at `FilterNode.computePhysical`.** Before extracting predicate-derived FDs, the filter walks inherited FDs and asks `predicateImpliesGuard(predicate, fd.guard, ecs, bindings, attrIdToIndex, isColumnNonNullable, isColumnNumeric, declaredCollationOf)` — a conservative implication check that flattens the predicate's `AND` conjunction and matches each guard clause against direct conjuncts, equivalence classes, constant bindings, and (for `is-null negated:true`) the source column's nullability. `isColumnNumeric` gates the `NOT col → col = 0` rewrite (numeric columns only — see above); `declaredCollationOf` feeds the per-conjunct collation gate on the facts themselves (see below). When entailed, the guard is stripped and the FD becomes an ordinary unconditional FD downstream; otherwise the guarded FD passes through unchanged so a later Filter / Join can still activate it once additional facts land.

**Propagation rules:**

- `computeClosure` / `determines` / `closureCoversAll` / `isUniqueDeterminant` / `hasAnyKey` / `hasSingletonFd` / `deriveKeysFromFds` all **skip** guarded FDs — a guarded FD is not a closure-time fact, cannot prove a key claim, and cannot serve as a `'unique'` witness.
- `addFd` subsumption applies only when two FDs share the same guard; FDs with different guards (or one guarded and one not) coexist.
- `shiftFds` shifts guard column indices alongside determinants/dependents.
- `projectFds` drops a guarded FD whose guard references any column missing from the mapping — the guard would become unobservable and the FD could never re-activate downstream.
- Outer joins drop guarded FDs that sit on the NULL-padded side (along with that side's unconditional FDs), because NULL-padding can flip guard satisfaction.

Predicates `predicateImpliesGuard` recognizes today: `col = literal` / `col = col2` (and via EC closure), `col is null`, `col is not null`, column non-nullability from the type system, `col IN (lit, …)` (literal-only), `NOT col` (numeric columns only; rewritten to `col = 0`, paired with the same NOT-NULL claim — for TEXT/BLOB/BOOLEAN columns `NOT col` records only the `IS NOT NULL` fact), and per-column literal-bounded `<`/`<=`/`>`/`>=` plus `BETWEEN` — these accumulate into an intersected per-column filter range that discharges a `range` guard when the filter's range is a subset of the guard's (per-side comparison via `compareSqlValues` with BINARY collation). The range path checks the guard's column, every EC peer, and every binding-shared column. It can discharge an `or-of` guard either by entailing any single sub-clause directly, or — when every sub-clause is `eq-literal` on the same column — by checking that the filter pins that column (via `=`, IN-list, EC peer, or `ConstantBinding`) to a *subset* of the OR-set. `eq-literal` does not piggyback onto `range` (filter `col = 25` does not discharge a `range` guard); symbolic/parameter bounds and `NOT BETWEEN` remain out of scope.

**Discharge facts are collation-gated per conjunct** (`buildPredicateFacts`): a fact may only discharge a guard when the filter's runtime comparison keeps filter-rows ⊆ guard-scope-rows, and the guard scope is evaluated under the column's *declared* collation at index-maintenance time. `col = lit` facts require the conjunct's effective collation to be BINARY (value equality implies equality under any collation) or to equal the column's declared collation (the same comparison the scope uses; the strict `sqlValueEquals` literal match then under-claims at worst) — so a `b = 'bob' COLLATE NOCASE` filter does not discharge a BINARY `eq-literal{b,'bob'}` guard while admitting out-of-scope rows. `col1 = col2` facts require both columns' contributed collations to agree (any resolution order then matches the guard's). Range facts over TEXT bounds are stricter: because the subset check above compares bounds under BINARY, both the conjunct's effective collation **and** the column's declared collation must be BINARY — collated text ranges never discharge (a deliberate completeness loss, never a soundness one). Non-text bounds are collation-inert and ungated. Plain `col IN (…)` facts are inherently declared-collation-matched (`emitIn` compares under the bare condition column's own collation) but run through the same gate for future-proofing.

## Helper surface

> **Invariant:** [OPT-046](invariants.md#opt-046--addfd-is-the-only-fd-accumulation-path), [OPT-047](invariants.md#opt-047--addfd-deduplicates-by-subsumption-and-evicts-by-keykind-preference)

In `planner/util/fd-utils.ts`:

- `computeClosure(attrs, fds)` — iterative fixed-point.
- `determines(attrs, target, fds)` — closure-based check.
- `minimalCover(attrs, fds)` — greedy minimization.
- `mergeFds(a, b)`, `addFd(fds, next, opts?)` — subsumption-aware merge. `addFd`'s options carry `keyHints` (column-index sets known to be keys) for cap enforcement and `cap` for an explicit override (default `MAX_FDS_PER_NODE = 64`).
- `projectFds(fds, mapping)` — drop FDs that lose any determinant column. Dependents that don't map are filtered out (preserving the FD if at least one dependent survives); this is the rule that lets `∅ → all_cols` singleton claims survive projection.
- `superkeyToFd(key, columnCount)` — build `key → (all_cols \ key)` from a superkey, or `undefined` when `key` covers every column.
- `singletonFd(columnCount)` — build the `∅ → all_cols` "at-most-one-row" FD.
- `addSingletonFd(fds, columnCount)` — fold the `∅ → all_cols` singleton into `fds` via `addFd` (no-op returning a copy when `columnCount === 0`). The canonical **producer-side** helper: every `computePhysical` site proving a relation emits ≤1 row uses this rather than open-coding `singletonFd` + `addFd`.
- `closureCoversAll(attrs, fds, columnCount)` — pure value coverage; returns true on the trivial all-cols tautology and says nothing about row-uniqueness.
- `isUniqueDeterminant(attrs, fds, columnCount, isSet)` — the kind-aware uniqueness primitive (see *The reader rule* above). Use it whenever you need a positive uniqueness claim (e.g. strict-`monotonicOn` detection).
- `hasAnyKey(fds, columnCount, isSet)` — true iff the FD set encodes any non-trivial key; kind-aware.
- `hasSingletonFd(fds, columnCount, isSet)` — the kind-aware FD-surface ≤1-row test (`isUniqueDeterminant(∅, …)`), which `keysOf` calls internally. False for zero-column relations (the FD is unrepresentable there).
- `isAtMostOneRow(rel)` — the **node-level** ≤1-row predicate, defined as `isUnique([], rel)`. The named spelling consumers (join key-coverage, whole-Sort elimination) read. Does **not** capture a relation whose ≤1-row fact is known *only* via `estimatedRows === 1` (no declared empty key and no FD — a zero-column relation cannot carry the singleton FD), so callers needing that fallback keep their own check (`characteristics.guaranteesUniqueRows`).
- `deriveKeysFromFds(fds, columnCount, isSet)` — enumerate the minimal key sets from the FD set; a candidate qualifies only via `isUniqueDeterminant` (kind-aware).
- `shiftFds(fds, offset)` / `shiftEquivClasses(classes, offset)` — column index translation for joins.
- `mergeEquivClasses(a, b)` / `addEquivalence(classes, a, b)` — transitive-closure union of overlapping classes.
- `mergeConstantBindings(a, b)` — coalesce bindings sharing a `ConstantValue` by unioning `attrs`.
- `closeConstantBindingsOverEcs(bindings, ecs)` — extend each binding's `attrs` over every overlapping EC member (the predicate-inference surface).
- `projectConstantBindings(bindings, mapping)` / `shiftConstantBindings(bindings, offset)` — projection/translation mirrors of the FD/EC variants.
- `mergeDomainConstraints(a, b)` / `projectDomainConstraints(domains, mapping)` / `shiftDomainConstraints(domains, offset)` — analogous helpers for the `domainConstraints` surface. `merge` concatenates dropping structural duplicates; intersection of overlapping ranges/enums is **not** done here.
- `extractEqualityFds(predicate, attrIdToIndex)` — predicate walker used by `FilterNode`; returns FDs, EC pairs, and constant bindings (literals and parameters both contribute bindings).
- `extractCheckConstraints(checks, columnIndexMap, isDeterministic)` (in `planner/analysis/check-extraction.ts`) — schema-time AST walker used by `TableReferenceNode` to lift declared CHECK constraints into FDs / EC pairs / `ConstantBinding`s / `DomainConstraint`s. Cached per `TableSchema` via `getCheckExtraction`. Recognizes implication-form disjunctions and emits guarded FDs.
- `predicateImpliesGuard(predicate, guard, ecs, bindings, attrIdToIndex, isColumnNonNullable, isColumnNumeric)` — conservative implication check used by `FilterNode` to activate guarded FDs. `isColumnNumeric` gates the `NOT col → col = 0` rewrite so it only applies to numeric columns.
- `stripGuard(fd)` — return the unconditional twin of a guarded FD (used by Filter activation).

**De-dup / cap behavior:** `addFd` performs subsumption (drop existing FDs with the same determinants whose dependent set is a subset of the new one, and skip adding a new FD already subsumed). When the resulting list exceeds the cap, FDs whose determinants are not a subset of any `keyHints` entry passed by the caller are dropped first; truncations are logged at debug under `quereus:planner:fd`. `mergeConstantBindings` enforces the same cap and logs the same way.

`fdsEqual` compares structural fields only: `kind`, `source`, and `valueEquality` are **not** part of FD identity.

## Singleton equivalence

> **Invariant:** [OPT-058](invariants.md#opt-058--at-most-one-row-folds-through-addsingletonfd)

Three representations encode the same "≤1-row" fact: an empty-key `[]` in `RelationType.keys`, the null-determinant `∅ → all_cols` FD in `physical.fds`, and `isAtMostOneRow` (= `isUnique([])`) returning true. Producers fold the FD through the canonical `addSingletonFd` helper; node-level consumers read `isAtMostOneRow`; and the **Singleton equivalence** property law in the Key Soundness harness (`test/property.spec.ts`) pins the channels to agree. Walking every relational node in the optimized plan it asserts both implications: `isAtMostOneRow(node)` ⇒ `keysOf(node)` contains the empty key `[]`, and `hasSingletonFd(node.physical?.fds, colCount, isSet)` ⇒ `isAtMostOneRow(node)`. Because `keysOf` consults `hasSingletonFd` and `isAtMostOneRow` consults `keysOf`, both implications hold *by construction* on today's read surface — so this law is a regression guard against a future refactor of `keysOf` / `isUnique` / `hasSingletonFd` that breaks their reconciliation, **not** a check on producers.

The companion **independent-channel singleton law** (same harness) closes the producer gap: it reads the two channels a producer encodes ≤1-row on — the declared empty key in `RelationType.keys` and the `∅ → all_cols` FD in `physical.fds` — *against each other* directly, not through `keysOf`, so it **can** catch producer drift. Its forward invariant: any node declaring the empty key on ≥1 column must back it with the singleton FD (zero-column nodes are the carve-out — the FD has no dependents and is unrepresentable, so the claim rides `estimatedRows`/`isSet`, as on `SingleRowNode`). The reverse (FD ⇒ declared empty key) is *not* asserted — derived nodes (Filter over a covered key, `LIMIT 1`, scalar aggregate) add the FD physically without rewriting their inherited logical `keys`, so the FD channel is legitimately richer. The leaf producers that hand-declare the empty key — `PragmaNode`, `AnalyzePlanNode`, `ExplainSchemaNode`, and (zero-column) `SingleRowNode` — fold the matching FD via `addSingletonFd` in `computePhysical` so both channels agree. `AnalyzePlanNode` is the conditional case: it declares the empty key *and* the FD only for the single-table form (`ANALYZE <table>`), since bare `ANALYZE` emits one row per table (a bag). (Forward uniqueness facts are backstopped by the Key Soundness harness; the backward-direction analogue is the **View Round-Trip Laws** block in `test/property.spec.ts` — see [architecture.md](architecture.md) § Property-Based Tests.)

## Consumers

`ruleAggregatePredicatePushdown` ([Rules § Optimization Rules](optimizer-rules.md#optimization-rules)) consumes `physical.fds`: it uses `computeClosure` over the aggregate's output FDs to widen the set of pushable conjuncts on composite GROUP BYs.

`rulePredicateInferenceEquivalence` consumes `physical.constantBindings` × `physical.equivClasses`: for `SELECT ... FROM t JOIN u ON t.k = u.k WHERE t.k = 5`, the join contributes an EC `{t.k, u.k}` and the filter contributes a binding `{t.k → 5}`. The rule crosses them and emits a `u.k = 5` conjunct on the u-branch, which subsequent `predicate-pushdown` iterations carry into the leaf so the vtab can pick a seek over a scan. The same shape works for parameter bindings (`t.k = ?`) and chains transitively across multiple equi-joins.

## Rejected alternatives

- **Producer-side drop gates on determination FDs** (refuse to emit a single→single FD unless one endpoint is a declared key). They blocked the over-claim family only partially, and put the soundness burden on every producer. The reader rule subsumes them: an endpoint-is-key check is the one-FD special case of "a `'unique'` witness lies within the closure". Producers now emit value claims freely and the readers refuse to read a determination as uniqueness.
- **A separate `uniqueKeys` field on `PhysicalProperties`.** Two surfaces to keep in sync, and no way to express a partial or guarded key. Uniqueness is expressed as an FD with `kind: 'unique'`; the `[[]]` marker for "at most one row" is the `∅ → all_cols` FD.
- **An optional `kind` field.** A transform that rebuilt FD objects without spreading the original would silently lose the marker at runtime instead of failing to typecheck.
- **`isSuperkey` as the name for pure value coverage.** The name read as a uniqueness claim and invited exactly the misuse `isUniqueDeterminant` exists to prevent. The coverage helper is `closureCoversAll`.
- **Dropping a fanned-out join side's key FDs wholesale.** The value claims are still true after a fan-out and the closure consumers want them. Only the `'unique'` marker is unsound, so `downgradeUniqueFds` rewrites `kind` rather than deleting the FD.
- **A proper-subset guard on `isUnique`.** Unnecessary: an all-columns probe on a bag fails the reader rule on its own, and if a unique FD exists the relation cannot hold duplicate rows.
- **Transitive IND closure.** Join propagation alone carries the reaching inclusion dependency for the left-deep chain the coverage prover walks; a closure pass would add cost with no additional reach.
