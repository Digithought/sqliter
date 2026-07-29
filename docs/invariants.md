# Invariant Register

A single file holding **only** statements the code must satisfy. It is meant to be read
end-to-end against the implementation in one sitting, a few times a year. The topic docs
keep the exposition and explain *why*; this register is the **normative text**. When the
two disagree, the register wins and the topic doc is wrong.

An entry earns its place only if all four hold: it states a property the **code** upholds
(not a description of behaviour, not advice); violating it is a **bug**, not a missed
optimization; it fits in **120 words** without its topic doc; and it names a **concrete
code site**. Cost-model constants, the rule catalog, performance advice, and rejected
alternatives are deliberately absent.

Each entry carries:

- `code:` — one or more `` `path` — `symbol` `` pointers at the implementation.
- `guard:` — exactly one. A test, a runtime assertion, or `none — <reason>`.
- `doc:` — the topic-doc section that explains it.

`scripts/check-docs.mjs` (`yarn docs:check`) machine-checks the *pointers*: every `code:`
path exists, every named symbol still appears in it, every `doc:` link resolves. It never
checks that an invariant **holds** — that is what `guard:` is for. So a rename or deletion
fails the build and forces someone to re-read the entry; a semantic regression does not.

IDs ascend within an area and gaps are expected: a retired invariant's number is never
reused. Back-links from the topic docs use the full heading slug
(`invariants.md#opt-014--an-attribute-id-is-originated-exactly-once`), not the short
`#opt-014` form, which GitHub does not mint.

See [Documentation Conventions § The invariant register](doc-conventions.md#the-invariant-register).

## OPT — Query optimizer

### OPT-001 — Every rule declares `sideEffectMode`

- code: `packages/quereus/src/planner/framework/registry.ts` — `validateSideEffectMode`
- code: `packages/quereus/src/planner/framework/pass.ts` — `addRuleToPass`
- guard: `packages/quereus/test/optimizer/side-effect-audit.spec.ts` — `Registry guardrail: unannotated rules are rejected`
- doc: [Optimizer § Audit discipline](optimizer.md#audit-discipline-sideeffectmode)

Every rule handed to `PassManager.addRuleToPass` declares `sideEffectMode: 'safe' | 'aware'`.
Registration throws otherwise. The field is typed as required, but rule handles are built by
spread and by generated registries where TypeScript cannot see through, so the runtime check
is the load-bearing audit gate — not a belt over a proven property. This invariant is
self-guarding: `validateSideEffectMode` raises `QuereusError(INTERNAL)` at registration.

### OPT-002 — An `'aware'` rule consults the side-effect signal

- code: `packages/quereus/src/planner/framework/characteristics.ts` — `subtreeHasSideEffects`
- code: `packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts`
- guard: `packages/quereus/test/optimizer/side-effect-audit.spec.ts` — `Side-effect audit: rules must refuse on impure subtrees`
- doc: [Optimizer § The two declarations](optimizer.md#the-two-declarations)

A rule that moves, duplicates, drops, or merges a subtree it has not separately proven pure
declares `'aware'` and consults a purity signal, refusing or weakening when a participating
subtree carries a write. Usually that signal is `PlanNodeCharacteristics.hasSideEffects` /
`subtreeHasSideEffects`; `scalar-subquery-cache` instead refuses on `isFunctional`
(`physical.readonly` **and** deterministic), which is strictly stronger. `'safe'` is the
counter-claim that the transform's structural shape preserves side effects by itself. One
`'aware'` rule, `cte-optimization`, consults nothing: it wraps the subtree in a run-once
`CacheNode`, which preserves the write.

### OPT-003 — A static guard checks every `'aware'` rule's source for a purity signal

- code: `packages/quereus/src/planner/optimizer.ts`
- guard: `packages/quereus/test/optimizer/side-effect-audit.spec.ts` — `OPT-003 static guard: every 'aware' rule consults a side-effect signal`
- doc: [Optimizer § The two declarations](optimizer.md#the-two-declarations)

OPT-002's behavioural guard covers the fold rules only; this static guard closes the rest.
It reads `optimizer.ts`, resolves every `'aware'` rule's `fn:` to its source file, and fails
if that file names none of `hasSideEffects`, `subtreeHasSideEffects`, `isConcurrencySafe`,
`isFunctional`, `physical.readonly`. `cte-optimization` is allowlisted there with its
reason. The check is textual: it proves a rule *mentions* a signal, not that it acts on it
correctly.

### OPT-004 — A custom-`execute` pass argues its own soundness

- code: `packages/quereus/src/planner/framework/pass.ts` — `createMaterializationPass`
- guard: none — a pass supplies its own traversal, so no registration-time check sees the transforms it performs; a violation shows up as a lost or duplicated write, not a crash.
- doc: [Optimizer § Pass 3.5: Materialization Advisory](optimizer.md#pass-35-materialization-advisory-single-whole-tree-pass-order-35)

A pass carrying a custom `execute` has an empty `rules` array, so it never passes through
`addRuleToPass` and OPT-001's gate never fires on it. Its side-effect soundness argument
must therefore live in a comment at the pass definition. `createMaterializationPass` is the
one live instance; its argument is that `CacheNode` is a run-once fence, so a subtree the
advisory wraps executes exactly once rather than once per reference — a count-changing but
order-preserving rewrite.

### OPT-006 — Parallel-track rules refuse an impure branch

- code: `packages/quereus/src/planner/framework/characteristics.ts` — `isConcurrencySafe`
- code: `packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts`
- guard: `packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts` — `Parallel-track refusal: AsyncGather(unionAll)`
- doc: [Optimizer § Parallel-track side-effect refusal](optimizer.md#parallel-track-side-effect-refusal)

Every rule that introduces an `AsyncGatherNode`, `EagerPrefetchNode`,
`FanOutLookupJoinNode`, or `FanOutBatchedOuterNode` checks each participating branch on two
gates and returns `null` if either fails: `branch.physical.concurrencySafe === true` (the
module's concurrency contract) and `PlanNodeCharacteristics.isConcurrencySafe(branch)` (side-effect
freedom). Refusal, not fallback: the serial plan underneath is already correct. Driving a
write concurrently with a sibling branch violates the per-connection lock under every
module concurrency mode except `'fully-reentrant'`, which no module advertises.

### OPT-008 — Plan nodes are immutable

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `withChildren`
- guard: none — no cheap mechanical check; an in-place mutation surfaces as a stale cached `physical` or `getTotalCost()` value producing a wrong plan, never as a crash.
- doc: [Optimizer § Immutable Plan Nodes](optimizer.md#immutable-plan-nodes)

A `PlanNode` is never mutated after construction. A transform re-mints — `withChildren`
returns a fresh instance with fresh, empty `physical` and total-cost caches — rather than
writing through an existing node. The single sanctioned in-place mutator is
`RecursiveCTENode.setRecursiveCaseQuery()`, which exists because the recursive case cannot
be built before the node it references; it explicitly invalidates the caches it dirties
(see OPT-018).

### OPT-010 — Visited rules are inherited across a re-mint; declines are not

- code: `packages/quereus/src/planner/framework/pass.ts` — `inheritVisitedRules`
- guard: `packages/quereus/test/planner/framework.spec.ts` — `Visited-rule tracking`
- doc: [Optimizer § Rule Application Control](optimizer.md#rule-application-control)

When a rule transforms a node, `PassManager` copies the original node's applied-rule set onto
the freshly-minted node, so an applied rule is never re-offered its own output — that is what
terminates the per-node fixpoint loop. The *decline* set is the mirror image: it is scoped to
one unchanged node id and is **reset the instant any rule transforms the node**. Inheriting
declines would suppress a rule that becomes applicable only after a sibling rule reshapes the
node, silently changing the chosen plan.

### OPT-012 — `withChildren` preserves attribute IDs

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `withChildren`
- guard: `packages/quereus/test/optimizer/attribute-id-stability.spec.ts` — `Attribute ID stability`
- doc: [Optimizer § Attribute ID Preservation](optimizer.md#attribute-id-preservation)

A node reconstructed by `withChildren` republishes the same attribute IDs its original
published. Column identity is by stable attribute ID, never by name or output position, so a
rewrite that re-mints an ID orphans every `ColumnReferenceNode` above it and every
`RowDescriptor` the emitter builds from `getAttributes()`. A rule that must change a node's
output shape rebuilds it explicitly (`AggregateNode.preserveAttributeIds`,
`EmptyRelationNode`'s attribute-carrying constructor), rather than relying on generic
reconstruction.

### OPT-014 — An attribute ID is originated exactly once

- code: `packages/quereus/src/planner/analysis/attribute-provenance.ts` — `computeAttributeProvenance`
- guard: `packages/quereus/test/planner/attribute-provenance.spec.ts` — `computeAttributeProvenance`
- doc: [Optimizer § Attribute provenance](optimizer.md#attribute-provenance)

An attribute ID is *originated* by exactly one node — the deepest relational node that
outputs it and whose direct relational children do not — and may then be *forwarded*
verbatim by any number of ancestors. The invariant is "originated once", not "appears once":
joins concatenate both sides' IDs, set operations mirror the left child's, and `ProjectNode`
forwards a source ID for a bare column-reference projection. Two distinct nodes originating
the same ID, or one node listing an ID twice, is a genuine bug and throws
`QuereusError(INTERNAL)`.

### OPT-016 — `estimatedCost` is self-cost only

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `getTotalCost`
- code: `packages/quereus/src/planner/validation/plan-validator.ts` — `validateCostAdditivity`
- guard: `packages/quereus/test/planner/cost-additivity.spec.ts` — `Cost model: self-cost-only additivity`
- doc: [Optimizer § Self-cost-only convention](optimizer.md#self-cost-only-convention)

`PlanNode.estimatedCost` holds the node's own incremental cost, excluding its children.
`getTotalCost()` is the sole place child costs are summed. A constructor that folds
`child.getTotalCost()` or a child's `estimatedCost` into its own self-cost double-counts once
`getTotalCost()` sums the children again, compounding with nesting depth and changing which
plan the optimizer picks. Costs are abstract units, lower is better, finite, and `>= 0`; a
transform that changes a node's shape recomputes rather than inherits. The one leaf reading an
`estimatedCost` is the vtab access node's own `xBestIndex` cost. See
`tickets/complete/1-planner-cost-model-double-count.md`.

### OPT-018 — The total-cost memo is invalidated on mutation

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `invalidateTotalCostCache`
- guard: `packages/quereus/test/planner/cost-additivity.spec.ts` — `total invalidates when the recursive case is swapped`
- doc: [Optimizer § Self-cost-only convention](optimizer.md#self-cost-only-convention)

`getTotalCost()` is memoized per instance. That is sound only because nodes are immutable
(OPT-008) and no constructor calls it, so the first call always happens after the subtree is
fully built. Any in-place mutator that changes a node's children must call
`invalidateTotalCostCache()`. `RecursiveCTENode.setRecursiveCaseQuery()` is the one such
mutator today. A stale memo does not throw — it silently prices a subtree at its
pre-mutation cost.

### OPT-020 — No logical-only node reaches emission

- code: `packages/quereus/src/planner/validation/plan-validator.ts` — `validatePhysicalNodeType`
- guard: `packages/quereus/test/planner/validation.spec.ts` — `Logical-only node type Retrieve`
- doc: [Retrieve § Physicalization invariant](optimizer-retrieve.md#physicalization-invariant)

By the end of the Physical Selection pass every `RetrieveNode` has been rewritten to a
concrete access node (`SeqScanNode`, `IndexScanNode`, `IndexSeekNode`, `EmptyResultNode`) or
to a `RemoteQueryNode`, and every logical `AggregateNode` to a `StreamAggregateNode` or
`HashAggregateNode`. Neither has an emitter. `validatePhysicalNodeType` is a runtime
assertion, but it runs only under `tuning.debug.validatePlan`, which defaults to `false` in
production — so in a release build a surviving logical node surfaces as a missing-emitter
error, not as this message.

### OPT-022 — A Retrieve pipeline holds only supported operations

- code: `packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts` — `fallbackIndexSupports`
- code: `packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts`
- guard: `packages/quereus/test/optimizer/remote-grow-retrieve.spec.ts` — `Retrieve growth with supports() (remote query)`
- doc: [Retrieve § Supported-only placement policy](optimizer-retrieve.md#supported-only-placement-policy)

Everything beneath a `RetrieveNode` is an operation the module committed to executing —
`supports()` accepted the candidate pipeline, or the index-style `getBestAccessPlan()`
fallback did. Anything else stays above the boundary as a residual. Both rules that move work
across the boundary construct a supported-only fragment and leave the remainder above;
neither pushes a predicate speculatively. Growth over a `supports()` module is purely
structural; the index-style fallback additionally demands the access plan beat a sequential
scan, or provide the required ordering, before `fallbackIndexSupports` returns an assessment.
Either way the decision is a function of the plan alone, so a given plan always reaches the
same segment boundary — which is what makes the later join-enumeration cost comparisons
meaningful.

### OPT-023 — Nothing is pushed into a Retrieve whose access path is committed

- code: `packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts` — `isIndexStyleContext`
- guard: `packages/quereus/test/filter-lost-under-index-order.spec.ts` — `Filter conjunct lost under index ordering`
- doc: [Retrieve § Supported-only placement policy](optimizer-retrieve.md#supported-only-placement-policy)

Once a `Retrieve` carries an index-style `moduleCtx`, that context — not `Retrieve.source` —
is what `rule-select-access-path` physicalizes, so a fragment placed below the boundary
afterwards would execute nowhere and the query would return unfiltered rows. Pushdown
therefore declines outright and leaves the `Filter` above the boundary, where grow-retrieve
re-probes `getBestAccessPlan()` with the constraint on the next fixed-point iteration and
residualizes whatever the module declines — so nothing is lost by declining. `Retrieve.source`
stays populated for the readers that still walk it (binding collection, and the constraint
sweep in `trySortAbsorbViaIndexOrdering`); it is dead only as an *execution* channel.

### OPT-024 — An unconsumed seek constraint is reattached

- code: `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` — `reattachUnconsumedConstraints`
- guard: `packages/quereus/test/vtab/overclaiming-module.spec.ts` — `over-claiming module: planner reattaches unconsumed filters`
- doc: [Optimizer § The `handledFilters` contract](optimizer.md#the-handledfilters-contract)

`handledFilters[i] = true` promises the module enforces filter `i`, and the only channel is
`FilterInfo.constraints` — the seek bounds `rule-select-access-path` builds. Since the rule
consumes at most one filter per column per role, a module that over-claims would leave a
filter enforced nowhere. So the rule reattaches, as a residual `Filter`, every seek-family
constraint it claimed-but-did-not-consume. An over-claiming module therefore costs a
redundant filter, never a wrong answer. Filters outside the seek family (`IS NULL`, `LIKE`,
`NOT IN`, …) are never pushed into `FilterInfo`, so a module claiming one is taken at its
word.

### OPT-030 — Uniqueness is read through one surface

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `keysOf`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `isUnique`
- guard: `packages/quereus/test/optimizer/keysof-isunique.spec.ts` — `keysOf / isUnique (unified uniqueness surface)`
- doc: [Functional Dependencies § keysOf / isUnique](optimizer-fd.md#keysof--isunique-the-single-uniqueness-read-path)

A uniqueness fact can live on three surfaces — declared `RelationType.keys`, the
`PhysicalProperties.fds` FD set, and `RelationType.isSet`. A consumer never hand-checks them.
It reads `keysOf(rel)`, `isUnique(cols, rel)`, `isAtMostOneRow(rel)`, or the underlying
`isUniqueDeterminant`, all in `fd-utils.ts`, which reconcile the three. Over-claiming a key is
a correctness bug — DISTINCT elimination and join elimination drop real rows; under-claiming
only forgoes an optimization. Routing every read through one place is what lets the three
representations change without auditing every consumer.

### OPT-032 — Coverage is not uniqueness

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `closureCoversAll`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `isUniqueDeterminant`
- guard: `packages/quereus/test/fd-determination-reader-side-rule.spec.ts` — `isUniqueDeterminant (kind-aware uniqueness reachability)`
- doc: [Functional Dependencies § The reader rule](optimizer-fd.md#the-reader-rule-isuniquedeterminant)

`closureCoversAll(attrs, fds, columnCount)` is a pure **value** claim: rows agreeing on
`attrs` agree everywhere. Over a bag that proves nothing about row-uniqueness. A set of
columns is row-unique only when `isUniqueDeterminant` holds — coverage **and** uniqueness is
reachable, meaning the relation is a set, or some unguarded `kind: 'unique'` FD has its
determinants inside `closure(attrs)`. Producers may emit value claims freely as
`kind: 'determination'`; the entire soundness burden sits on the reader. Closure-shaped
consumers (ORDER BY pruning, GROUP BY simplification) want coverage and use it deliberately.

### OPT-034 — Closure helpers skip guarded FDs

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `computeClosure`
- guard: `packages/quereus/test/optimizer/conditional-fds.spec.ts` — `fd-utils: guarded FD helpers`
- doc: [Functional Dependencies § Guard activation](optimizer-fd.md#guard-activation)

A guarded FD — one carrying a `GuardPredicate`, minted by an implication-form CHECK or a
partial UNIQUE index — holds only over rows satisfying its guard. It is therefore not a
closure-time fact. `computeClosure`, `determines`, `closureCoversAll`, `isUniqueDeterminant`,
`hasAnyKey`, `hasSingletonFd`, and `deriveKeysFromFds` all skip it, and it can never serve as
the `'unique'` witness. A conditional uniqueness claim proves no key for a subtree that has
not discharged the condition.

### OPT-036 — A guard is discharged only at the producing Filter

- code: `packages/quereus/src/planner/nodes/filter.ts` — `activateGuardedFds`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `predicateImpliesGuard`
- guard: `packages/quereus/test/optimizer/conditional-fds.spec.ts` — `predicateImpliesGuard`
- doc: [Functional Dependencies § Guard activation](optimizer-fd.md#guard-activation)

Guard discharge happens in `FilterNode.computePhysical` and nowhere else: the filter asks
`predicateImpliesGuard` whether its own predicate entails every guard clause and, if so,
replaces the FD with its unconditional twin via `stripGuard`. A consumer must never discharge
a guard itself. Activation is sound at the producing Filter because its rows all satisfy the
guard and filtering only shrinks the row set; an activated `'unique'` FD that later crosses a
fanning join is downgraded there (OPT-040), not weakened here. An unentailed guarded FD passes
through unchanged so a higher Filter can still activate it.

### OPT-038 — Projection drops an FD whose guard loses a column

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `projectFds`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `shiftFds`
- guard: `packages/quereus/test/optimizer/conditional-fds.spec.ts` — `projectFds`
- doc: [Functional Dependencies § Guard activation](optimizer-fd.md#guard-activation)

`projectFds` drops a guarded FD whose guard references any column absent from the output
mapping: the guard becomes unobservable, so no downstream Filter could ever discharge it, and
a fact nobody can activate is worse than useless — it survives cap eviction while carrying no
information. `shiftFds` shifts guard column indices alongside determinants and dependents.
`addFd`'s subsumption applies only between FDs with equal guards; a guarded and an unguarded
twin coexist.

### OPT-040 — A fanning join downgrades the non-preserved side

- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `downgradeUniqueFds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinFds`
- guard: `packages/quereus/test/fanning-join-fd-overclaim.spec.ts` — `fanning-join FD over-claim: optimizer blast radius`
- doc: [Functional Dependencies § kind: uniqueness provenance](optimizer-fd.md#kind-uniqueness-provenance)

A join whose equi-predicate covers no key of the opposite side duplicates that side's rows.
On the inner, cross, left, and right arms, `propagateJoinFds` rewrites every surviving FD of a
non-preserved side from `kind: 'unique'` to `'determination'` — **guarded FDs included**, since
a partial-unique key is no longer row-unique inside its own guard scope once fanned out. The
value claims stay true and closure consumers still want them, so the FD is downgraded, not
deleted. Semi and anti pass left rows at most 1:1 and preserve kinds verbatim; full outer
drops everything.

### OPT-042 — An outer join drops the null-padded side's facts

- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinFds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinInds`
- guard: `packages/quereus/test/optimizer/fd-propagation.spec.ts` — `FD propagation per operator`
- doc: [Functional Dependencies § Per-operator propagation](optimizer-fd.md#per-operator-propagation)

A left outer join keeps only the left side's FDs, equivalence classes, constant bindings,
domain constraints, and inclusion dependencies; the right side's, and every equi-pair-derived
fact, are dropped. NULL padding of an unmatched row violates them all, and a guard referencing
a padded column would become activatable for the wrong rows. Right outer mirrors it. Full
outer drops both sides — including the at-most-one-row empty key, because two non-matching
one-row sides produce two padded rows.

### OPT-044 — FD identity is structural; `'unique'` wins on merge

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `fdsEqual`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addFd`
- guard: `packages/quereus/test/optimizer/fd-kind.spec.ts` — `FD kind provenance`
- doc: [Functional Dependencies § kind: uniqueness provenance](optimizer-fd.md#kind-uniqueness-provenance)

`fdsEqual` compares determinants, dependents, and guard, order-insensitively. It ignores
`kind`, `source`, and `valueEquality` — those are not part of FD identity. When `addFd` merges
two entries it finds equal, or subsumes one under the other, the survivor's `kind` is
`'unique'` if either input claimed it: uniqueness is a property of the determinant set, so
equal-determinant claims compose. `kind` is a required field precisely so a transform that
rebuilds an FD without spreading the original fails to typecheck instead of silently losing
the marker.

### OPT-046 — `addFd` is the only FD accumulation path

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addFd`
- guard: `packages/quereus/test/optimizer/fd-propagation.spec.ts` — `OPT-046 static guard: addFd is the only FD accumulation path`
- doc: [Functional Dependencies § Helper surface](optimizer-fd.md#helper-surface)

FDs are accumulated through `addFd` / `mergeFds`, never by pushing onto the array — pushing
directly skips both subsumption and cap enforcement. The guard scans `planner/**` — all but
`util/fd-utils.ts`, which *is* the sanctioned path — for a `.push(` onto an FD-named
receiver, with a short allowlist for local candidate lists that are handed to `addFd` (or to
an FD reasoning helper) by their consumer. It keys on receiver names, so it is a smoke alarm
rather than a proof; if the allowlist ever needs to grow past a handful of entries, delete
the guard rather than maintain it.

### OPT-047 — `addFd` deduplicates by subsumption and evicts by key/kind preference

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addFd`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `MAX_FDS_PER_NODE`
- guard: `packages/quereus/test/optimizer/fd-propagation.spec.ts` — `OPT-047: addFd dedupes by subsumption and evicts by key/kind preference`
- doc: [Functional Dependencies § Helper surface](optimizer-fd.md#helper-surface)

`addFd` performs subsumption before appending: an existing same-determinant, same-guard FD
whose dependents are a subset of the newcomer's is dropped, and a newcomer already subsumed
by an existing FD is skipped; a dropped-or-subsumed `'unique'` twin upgrades the survivor's
kind. It also enforces `MAX_FDS_PER_NODE = 64`; cap eviction keeps
FDs whose determinants lie inside a caller-supplied `keyHints` set first, and within each
partition prefers `'unique'` over `'determination'` — evicting a uniqueness witness is sound
but causes downstream under-claims. Truncations log on `quereus:planner:fd`.

### OPT-048 — Dependency facts index output columns

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `projectFds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinFds`
- guard: none — the two index spaces are both `number`, so nothing type-checks the difference; a mix-up reads a neighbouring column's facts and yields a wrong plan.
- doc: [Optimizer Conventions § Functional Dependencies, Equivalence Classes, Bindings](optimizer-conventions.md#functional-dependencies-equivalence-classes-bindings)

Every FD, equivalence class, constant binding, domain constraint, and inclusion dependency
indexes **output-column positions on the node carrying it** — never attribute IDs, never
source-relation positions. Crossing a Project, Returning, Aggregate, or join boundary goes
through `projectFds` / `shiftFds` and their equivalence-class, binding, domain, and IND
mirrors, rather than a hand-written index map. The one exception is an
`InclusionDependency.target.targetCols`, which indexes the *target* relation and is therefore
never remapped by projection or join shift.

### OPT-050 — Equality facts require a value-discriminating collation

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `extractEqualityFds`
- code: `packages/quereus/src/planner/analysis/comparison-collation.ts`
- guard: `packages/quereus/test/planner/collation-soundness.spec.ts` — `Collation soundness of plan-time equality facts`
- doc: [Functional Dependencies § Collation gate on equality facts](optimizer-fd.md#collation-gate-on-equality-facts)

An equality-derived fact — a `∅ → col` constant pin, a `col1 = col2` mirror FD, an
equivalence class, a constant binding, a domain constraint — is a **value** claim, and a SQL
equality only implies value equality when its effective comparison collation discriminates
values. `'Bob' = 'bob'` holds under NOCASE. So each conjunct is gated: extraction happens only
when every contributed collation on a textual operand is BINARY. Effective collation is
resolved at plan time exactly as the runtime resolves it, through the shared helpers in
`comparison-collation.ts`, so plan-time facts and runtime behaviour cannot drift.

### OPT-052 — Provenance is informational

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `ConstraintProvenance`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `fdsEqual`
- guard: `packages/quereus/test/optimizer/assertion-as-premise.spec.ts` — `OPT-052 static guard: provenance is informational`
- doc: [Functional Dependencies § Assertion-derived premises](optimizer-fd.md#assertion-derived-premises)

An FD, constant binding, or domain constraint may carry a `source` tag recording where it came
from (`'declared-check'`, `{ kind: 'assertion', name }`, …). No rule branches on it. The dedup
helpers compare structural fields only and ignore it, so when a declared CHECK and a hoisted
assertion produce structurally identical facts, whichever merged first survives. The tag
exists for diagnostics and for explaining a plan, not for driving one. The guard scans
`planner/rules/**` for the identifier `ConstraintProvenance` — not for `.source` reads, since
`node.source` is a plan node's child pointer that rules read constantly — on the reasoning
that a rule cannot do anything useful with the tag without naming its type.

### OPT-054 — All-columns key-ness lives on `isSet`

- code: `packages/quereus/src/common/datatype.ts` — `isSet`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `keysOf`
- guard: `packages/quereus/test/optimizer/keysof-isunique.spec.ts` — `falls back to the all-columns key for a set with no smaller key`
- doc: [Functional Dependencies § kind: uniqueness provenance](optimizer-fd.md#kind-uniqueness-provenance)

"All output columns together form a key" has no non-trivial FD encoding, so it lives on
`RelationType.isSet` and never in `physical.fds`. DISTINCT and a schema-set table with no
smaller key set it. The kind-aware readers take it as an explicit parameter
(`isUniqueDeterminant(…, isSet)`, `hasAnyKey(…, isSet)`), and `keysOf` emits the all-columns
fallback key only when nothing smaller was found. There is no `PhysicalProperties.uniqueKeys`
field; the at-most-one-row marker is the `∅ → all_cols` FD (OPT-058).

### OPT-056 — An inclusion dependency is dropped when unsure

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `projectInds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinInds`
- guard: `packages/quereus/test/optimizer/inclusion-dependencies.spec.ts` — `IND soundness (no over-claim)`
- doc: [Functional Dependencies § Inclusion Dependency Tracking](optimizer-fd.md#inclusion-dependency-tracking)

An inclusion dependency asserts that every row's `cols` tuple appears in another relation's
`targetCols`. A false one is unsound — it mis-proves coverage downstream; a missing one only
forgoes an optimization. Every propagation rule therefore drops when unsure: `projectInds` is
all-or-nothing (an IND losing *any* of its `cols` is dropped, unlike `projectFds`, which keeps
an FD with a surviving dependent), outer joins drop the padded side, full outer drops both, and
`AggregateNode` / `SetOperationNode` / `WindowNode` emit none.

### OPT-058 — At-most-one-row folds through `addSingletonFd`

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addSingletonFd`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `isAtMostOneRow`
- guard: `packages/quereus/test/property.spec.ts` — `checkSingletonEquivalence`
- doc: [Functional Dependencies § Singleton equivalence](optimizer-fd.md#singleton-equivalence)

Three channels encode "this relation has at most one row": an empty key in
`RelationType.keys`, the `∅ → all_cols` FD, and `isAtMostOneRow(rel)`. A producer folds the
fact in through `addSingletonFd`; a consumer reads `isAtMostOneRow`. A node declaring the
empty key on one or more columns must back it with the singleton FD. The reverse does not
hold: a Filter over a covered key, a `LIMIT 1`, or a scalar aggregate adds the FD without
rewriting its inherited logical keys.

## MV — Materialized views

The read-side rewrite and the coverage prover are optimizer concerns, not MV ones: a view no
query rewrites onto is still correct. See
[Optimizer Rule Families](optimizer-rule-families.md#materialized-view-query-rewrite-read-side).

### MV-001 — A materialized view is a faster plain view

- code: `packages/quereus/src/core/database-materialized-views.ts` — `maintainRowTime`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `materializeView`
- guard: `packages/quereus/test/incremental/maintenance-equivalence.spec.ts` — `read(MV) == evaluate(body) across random mutations, in-txn and after rollback`
- doc: [Materialized Views § Why one model](materialized-views.md#why-one-model)

Reading a materialized view returns exactly what evaluating its body against the current
sources returns — mid-statement, mid-transaction, and after a rollback. The equivalence is
observational and immediate, not eventual: there is one maintenance model (row-time), no
refresh-policy knob, and no interval in which a view and its body disagree. Every other
entry in this area is a consequence of this one. `REFRESH` exists to recover a view whose
maintenance a schema change detached (MV-022), never to schedule freshness.

### MV-002 — Maintenance rides the writing statement's transaction

- code: `packages/quereus/src/core/database-materialized-views.ts` — `maintainRowTime`
- code: `packages/quereus/src/vtab/backing-host.ts` — `applyMaintenance`
- guard: `packages/quereus/test/mv-backing-module.spec.ts` — `a transaction rollback reverts the mem2 backing in lockstep with the source`
- doc: [Materialized-View Maintenance § Synchronous, transactional, per-statement](mv-maintenance.md#synchronous-transactional-per-statement)

Maintenance is driven from the runtime DML write boundary and writes the backing
connection's *pending* transaction state, so the backing delta commits and rolls back in
lockstep with the source write under the Database's coordinated commit. There is no
post-commit window, no asynchronous drift, and therefore no divergence-detection or
self-heal machinery anywhere in the subsystem. A maintenance failure fails the source
statement.

### MV-003 — Inverse-projection maintenance applies per row, immediately

- code: `packages/quereus/src/core/database-materialized-views-plans.ts` — `BackingConnectionCache`
- code: `packages/quereus/src/core/database-materialized-views.ts` — `findRowTimeCoveringStructure`
- guard: `packages/quereus/test/covering-structure.spec.ts` — `a bare-DDL covering MV is row-time and is used for enforcement`
- doc: [Materialized-View Maintenance § Synchronous, transactional, per-statement](mv-maintenance.md#synchronous-transactional-per-statement)

The per-statement `BackingConnectionCache` amortizes *connection resolution* only: each
source row's `'inverse-projection'` backing ops apply immediately, never buffered for an
end-of-statement flush. This is load-bearing: covering-UNIQUE enforcement runs inside the
source table's `update()` and scans the backing, so a later row of the same statement
must observe an earlier row's write (`insert into t values (1,'a'),(2,'a')` over a
covering `unique(x)` detects the duplicate); a coalescing buffer would break enforcement
unless the probe also read it. Every other arm defers to the end-of-statement flush
(MV-004), sound because only an inverse-projection MV can be a covering structure —
`findRowTimeCoveringStructure` declines every other plan kind, so no enforcement read
consults a deferred backing.

### MV-004 — The residual arms and full-rebuild defer per statement, and are never covering structures

- code: `packages/quereus/src/core/database-materialized-views.ts` — `flushDeferredMaintenance`
- code: `packages/quereus/src/core/database-materialized-views.ts` — `assertFlushRounds`
- guard: `packages/quereus/test/incremental/maintenance-equivalence.spec.ts` — `a multi-row statement flushes ONCE with statement-wide key dedup (no per-row dispatch)`
- doc: [Materialized-View Maintenance § Synchronous, transactional, per-statement](mv-maintenance.md#synchronous-transactional-per-statement)

Running the floor per source row would cost O(rows × body); so a full-rebuild plan is
dirtied per row and rebuilt once per statement, and a residual plan's affected binding
keys accumulate (deduped) and recompute once per distinct key at the same flush — inside
the statement-atomicity savepoint (and on the `OR FAIL` throw path). Recompute-from-live-state
is last-write-wins, so the flush-time recompute equals the last per-row recompute. This
does not weaken MV-003: a deferred backing is never read mid-statement — the conflict
probe consults only `'inverse-projection'` backings, which stay per-row-immediate. The
flush is a worklist over the producer→consumer DAG; `shouldDegradeToRebuild` re-costs the
statement and demotes to one `'replace-all'` rebuild when per-key residuals cost more.

### MV-005 — An MV-over-MV cascade completes in the originating transaction

- code: `packages/quereus/src/core/database-materialized-views.ts` — `maintainRowTime`
- code: `packages/quereus/src/core/database-materialized-views.ts` — `assertCascadeDepth`
- guard: `packages/quereus/test/materialized-view-cascade.spec.ts` — `a transaction of cascade writes is visible mid-statement and reverts the whole chain on rollback`
- doc: [Materialized-View Maintenance § MV-over-MV cascade](mv-maintenance.md#mv-over-mv-cascade)

A maintenance write into a maintained table is itself a row change, routed back through
`maintainRowTime` for every view reading that table. A view's sources are fixed at create
and its producers must already exist, so the dependency graph is acyclic and the
depth-first recursion is DAG-ordered: a producer's backing is fully written before its
consumers run. Every level commits or rolls back with the originating write. `assertCascadeDepth`
is a defense-in-depth backstop for the structurally impossible cycle, not a load-bearing bound.

### MV-006 — No body is rejected for its shape

- code: `packages/quereus/src/core/database-materialized-views-plan-builders.ts` — `tryBuildBoundedDeltaArm`
- code: `packages/quereus/src/core/database-materialized-views-plan-builders.ts` — `buildFullRebuildPlan`
- guard: `packages/quereus/test/materialized-view-diagnostics.spec.ts` — `names the MV + reason and steers to view / create-table, not the backing table or a refresh policy`
- doc: [Materialized-View Maintenance § Maintenance strategy](mv-maintenance.md#maintenance-strategy)

Maintenance coverage is total. A body matching no bounded-delta arm falls through to the
always-correct full-rebuild floor; no relational operator — join, outer join, set
operation, recursive CTE, `DISTINCT`, window, `LIMIT` — is grounds for rejection. Exactly
five create-time rejections exist, all non-shape: a non-deterministic body (absent `pragma
nondeterministic_schema`); a bag with no provable unique key and no coarsened lineage key;
a body with no relational output; a body reading no source table; and a full-rebuild-only
body whose largest source exceeds `materialized_view_rebuild_row_threshold`. Adding an
unconditional sixth is a breaking change. MV-008 adds host-conditional gates, inert by default.

### MV-007 — The strategy gate can be slow, never wrong

- code: `packages/quereus/src/planner/cost/index.ts` — `selectMaintenanceStrategy`
- code: `packages/quereus/src/planner/cost/index.ts` — `isFullRebuildPathological`
- guard: `packages/quereus/test/incremental/maintenance-equivalence.spec.ts` — `read(MV) == evaluate(body) across random mutations, in-txn and after rollback`
- doc: [Materialized-View Maintenance § Maintenance strategy](mv-maintenance.md#maintenance-strategy)

Strategy selection is a backward (maintenance-direction) cost argmin over the body's
*structurally sound* strategies, and an empty sound set resolves to the floor. So every
strategy the gate may pick maintains the body correctly, and a mis-estimated cost only
makes maintenance slower — never a backing that disagrees with the body. The one place
cost becomes a *rejection* is MV-006's size threshold, firing only when full-rebuild is
the sole sound strategy.

Soundness membership is *declaration-driven*, never name-driven: `'delta-aggregate'`
joins the sound set exactly when every stored aggregate column's declared algebra
(`AggregateFunctionSchema.algebra` — merge/negate/decode, plus the exact-domain and
multiplicity-witness checks) qualifies; no builtin-aggregate name list is consulted — a
UDAF with a lawful algebra qualifies, a builtin without one does not.

### MV-008 — The replicable-derivation gate is host-conditional and not locally waivable

- code: `packages/quereus/src/vtab/backing-host.ts` — `requiresReplicableDerivations`
- code: `packages/quereus/src/core/database-materialized-views-analysis.ts` — `nonReplicableDerivationError`
- guard: `packages/quereus/test/materialized-view-replicable.spec.ts` — `Materialized view replicable-determinism gate`
- doc: [Materialized-View Maintenance § Maintenance strategy](mv-maintenance.md#maintenance-strategy)

A backing host whose storage replicates across peers declares `requiresReplicableDerivations`;
the create then rejects a body using any function or collation not asserted bit-identical
across peers, platforms, and application versions. Built-ins auto-qualify. This sits beside,
not inside, the determinism gate — a replicating host's bit-identity requirement is strictly
stronger than per-database determinism — so `pragma nondeterministic_schema` does not lift
it. A host declaring the flag must resolve its capability surface eagerly, before any late
backing-materialization seam; the attach core converts a violation into a loud `INTERNAL`
error.

### MV-009 — A materialized view is exactly one schema object

- code: `packages/quereus/src/schema/derivation.ts` — `MaintainedTableSchema`
- code: `packages/quereus/src/schema/derivation.ts` — `TableDerivation`
- guard: `packages/quereus/test/logic/51-materialized-views.sqllogic`
- doc: [Materialized Views § Substrate: a maintained table](materialized-views.md#substrate-a-maintained-table)

A materialized view is realized as an ordinary `TableSchema` registered under the view's
own name, carrying a `TableDerivation`. There is no separate hidden backing object: the
"backing table" the host capability operates on *is* that table. One catalog name, one
physical incarnation, occupying the ordinary table namespace — `create table x` over a
maintained table `x` errors, and `schema()` lists it exactly once. Identity, storage module,
tags, and the physical key live on the table; the derivation carries the body and its
maintenance state.

### MV-010 — The maintained relation is always a set

- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `deriveBackingShape`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `materializedViewNotASetError`
- guard: `packages/quereus/test/materialized-view-diagnostics.spec.ts` — `a duplicate-producing body fails the set contract with a non-leaking diagnostic`
- doc: [Materialized Views § Primary key inference](materialized-views.md#primary-key-inference)

The maintained table's logical key is the body's own key, so each body row maps to exactly
one stored row. A body with no provable unique key has no row identity to materialize on
and is rejected (MV-006); a body that nonetheless produces duplicates fails the set
contract at fill rather than silently collapsing rows onto a colliding backing key. The
single carve-out is the coarsened backing key (MV-011), where the stored key is
deliberately coarser than row identity.

### MV-011 — A coarsened backing key is derived once and read by both sides

- code: `packages/quereus/src/planner/analysis/coarsened-key.ts` — `deriveCoarsenedBackingKey`
- guard: `packages/quereus/test/coarsened-backing-key.spec.ts` — `keys the backing on the coarsened lineage key and stamps the record`
- doc: [Materialized Views § Coarsened backing keys](materialized-views.md#coarsened-backing-keys)

The collation-weakening parallel-migration shape produces a keyless body whose source key
survives through value-preserving passthrough lineage. Such a body is keyed on that
coarsened lineage key rather than rejected. The key the maintenance plan admits and the key
the backing shape is built with come from the *same* `deriveCoarsenedBackingKey` call over
the same fully-optimized body, so they agree by construction. Colliding rows then
last-write-win under the floor's collation-keyed diff — a deliberate weakening of MV-010,
reported through the coarsening-collision telemetry.

### MV-012 — A maintained table is read-only to user DML

- code: `packages/quereus/src/runtime/emit/dml-executor.ts` — `assertNotMaintainedTableTarget`
- code: `packages/quereus/src/schema/derivation.ts` — `maintainedTableViewLike`
- guard: `packages/quereus/test/mv-dml-executor-backstop.spec.ts` — `stops throwing once the derivation is detached (structural keying, not by name)`
- doc: [Materialized Views § Write boundary (write-through)](materialized-views.md#write-boundary-write-through)

Nothing but the privileged backing surface writes a maintained table's rows. `INSERT` /
`UPDATE` / `DELETE` naming a materialized view is rewritten to target its source, through
the same view-mutation rewrite a plain view uses — checked both at name dispatch and again
on the schema-path-resolved table. Behind that, the runtime DML executor rejects any
mutation plan whose target still carries a derivation, keyed structurally on the derivation
rather than on the name. The privileged surface bypasses both by construction: it never
routes through the DML executor.

### MV-013 — `bodyHash` is the identity of the definition

- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `computeBodyHash`
- guard: `packages/quereus/test/maintained-table-migration-capstone.spec.ts` — `a body change with unchanged shape is a single re-attach (content refresh, not a recreate)`
- doc: [Materialized Views § Declarative-schema integration](materialized-views.md#declarative-schema-integration)

`computeBodyHash` over the canonical definition is what the declarative differ compares. A
changed body re-attaches the derivation and refreshes the contents; an unchanged body is a
no-op, so re-applying a schema never rebuilds. Anything that rewrites the body without
changing what it means — most importantly rename propagation (MV-023) — must recompute the
hash on the rewritten form, or the differ reports a phantom body change on the next apply.
The catalog persists DDL, not the hash, so import recomputes it from the same formula.

### MV-014 — Every privileged operation routes through the backing host

- code: `packages/quereus/src/vtab/backing-host.ts` — `BackingHost`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `resolveBackingHost`
- guard: `packages/quereus/test/mv-backing-module.spec.ts` — `create places the backing in mem2; maintenance, refresh, and drop all stay there`
- doc: [Backing-host capability](mv-backing-host.md#backing-host-capability)

The engine never reaches into the hosting module's internals. Maintenance writes, the
create/refresh fill, and the UNIQUE enforcement scan all route through the module-neutral
`BackingHost` capability, which a module advertises by implementing
`VirtualTableModule.getBackingHost`. Every materialized-view semantic in this area — row-time
maintenance, reads-own-writes, commit/rollback lockstep, the MV-over-MV cascade, covering
enforcement, refresh, rename propagation, drop — holds regardless of which module hosts the
table. The memory module is the default and the reference implementation.

### MV-015 — A backing host owes ordered, keyed storage

- code: `packages/quereus/src/vtab/backing-host.ts` — `scanEffective`
- guard: `packages/quereus/test/vtab/backing-host.spec.ts` — `scanEffective honors equalityPrefix as a leading-PK range and descending order`
- doc: [Backing-host capability](mv-backing-host.md#backing-host-capability)

A module that advertises the capability must provide primary-key-ordered storage with
O(log n) keyed upsert, delete, and point lookup, plus an ordered prefix-range scan that
seeks to a leading-key equality prefix, walks in key order, and terminates early. That cost
contract is what keeps every maintenance arm and the covering-UNIQUE prefix probe
module-agnostic; the engine does not gate per arm. A module that cannot provide the ordered
prefix scan must not advertise the capability at all — there is no partial conformance.

### MV-016 — `applyMaintenance` reports exactly the changes it realized

- code: `packages/quereus/src/vtab/backing-host.ts` — `applyMaintenance`
- code: `packages/quereus/src/util/comparison.ts` — `rowsValueIdentical`
- guard: `packages/quereus/test/vtab/backing-host.spec.ts` — `a value-identical upsert writes nothing and reports nothing (skip-identical contract)`
- doc: [Materialized-View Maintenance § Value-identical (no-op) write suppression](mv-maintenance.md#value-identical-no-op-write-suppression)

The returned `BackingRowChange[]` drives the MV-over-MV cascade (MV-005) and, on a
change-logged backing, the replication change log — so over- or under-reporting corrupts
consumers. Fidelity cuts both ways: an op that changes nothing reports nothing. A
value-identical upsert against the connection's *effective* row therefore writes nothing,
fires no cascade, and produces no change-log entry. This is a semantic guarantee, not an
optimization. Value identity is byte-faithful (`rowsValueIdentical`), never
collation-aware: a collation-equal, byte-different write is a real change.

### MV-017 — Declared constraints are validated against derived rows, before the cascade

- code: `packages/quereus/src/core/derived-row-validator.ts` — `validateDerivedRowImage`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `validateDeclaredConstraintsOverContents`
- guard: `packages/quereus/test/maintained-table-declared-constraints.spec.ts` — `Maintained-table declared-constraint validation`
- doc: [Derived-Row Constraints § Derived-row constraint validation](mv-constraints.md#derived-row-constraint-validation-declared-check--fk--secondary-unique)

Derivation writes bypass the DML constraint pipeline, so a maintained table's declared
CHECK and child-side FK constraints are validated by the engine at the maintenance
boundary: a bulk scan over the reconciled contents on the create-fill, attach, and
constraint-bearing refresh paths; a compiled per-row validator over each maintenance delta
in steady state, run *before* the row cascades to consumers. The writing statement fails,
attributed to the maintained table. A violation is always a hard abort — derivation writes
carry no `OR` clause, so `IGNORE` / `REPLACE` can never mask one.

### MV-018 — The derived-row validator tracks its constraint-only dependencies

- code: `packages/quereus/src/core/derived-row-validator.ts` — `dependencyTables`
- code: `packages/quereus/src/core/derived-row-validator.ts` — `makePoisonedDerivedRowValidator`
- guard: `packages/quereus/test/maintained-table-declared-constraints.spec.ts` — `self-heal on dependency re-create`
- doc: [Derived-Row Constraints § Derived-row constraint validation](mv-constraints.md#derived-row-constraint-validation-declared-check--fk--secondary-unique)

A compiled validator bakes in the live incarnations of the tables its checks reference — an
FK parent, a subquery-CHECK target. These are not derivation *sources*, so no source-change
path rebuilds them; the validator records them on `dependencyTables` and is rebuilt when one
is renamed, dropped, or re-created. Rebuilding touches the validator only: no staleness, no
maintenance interruption. A target that cannot recompile installs a *poisoned* validator that
re-raises the sited planning error on the next derivation write and self-heals when the
dependency returns — never a silent pass.

### MV-019 — Secondary UNIQUE is enforced by the host, post-batch

- code: `packages/quereus/src/vtab/memory/layer/manager.ts` — `enforceSecondaryUniqueOnMaintenance`
- code: `packages/quereus-store/src/common/store-table.ts` — `enforceSecondaryUniqueForMaintenance`
- guard: `packages/quereus/test/logic/51.9-maintained-table-secondary-unique.sqllogic`
- doc: [Derived-Row Constraints § Declared secondary UNIQUE](mv-constraints.md#declared-secondary-unique)

A UNIQUE collision is a property of a *pair* of rows, so it does not fit the per-row
validator of MV-017. The host checks each written image against the batch's final effective
contents after the batch lands. Post-batch is load-bearing: a `'replace-all'` diff applies
upserts before deletes, so a per-op check would false-positive whenever the derived set
merely moves a value between keys. Checking only written images is complete, since any
colliding pair contains one. The probe never routes through a covering view, which lags the
batch. Always a hard abort.

### MV-020 — A maintenance write fires parent-side referential actions

- code: `packages/quereus/src/core/database-materialized-views.ts` — `enforceParentSideReferentialActions`
- guard: `packages/quereus/test/runtime/maintained-parent-fk.spec.ts` — `Parent-side referential enforcement for maintained-table maintenance writes`
- doc: [Derived-Row Constraints § Parent-side referential enforcement](mv-constraints.md#parent-side-referential-enforcement-m-as-an-fk-target)

An FK declared on an ordinary table that *references* a maintained table lives on the child,
so it never appears in the maintained table's plan or its derived-row validator. A
maintenance delete or key-update of the referenced row would otherwise silently orphan the
child. Each backing delete/update change therefore runs the transitive RESTRICT walk and the
declared CASCADE / SET NULL / SET DEFAULT propagation through the *same* referential-action
engine the DML executor and the ingestion seam use — one engine, a third entry point. A
surviving RESTRICT rolls the source write back.

### MV-021 — The ingestion seam trusts its origin and re-validates nothing

- code: `packages/quereus/src/core/database-external-changes.ts` — `ingestExternalRowChanges`
- guard: `packages/quereus/test/external-row-change-ingestion.spec.ts` — `explicit: rollback discards the backing delta and capture in lockstep`
- doc: [External row-change ingestion § Trust boundary](mv-ingestion.md#trust-boundary)

A host that has already applied row changes directly to module storage reports them through
this seam so the post-write pipeline still runs. The seam re-checks no CHECK, NOT NULL,
UNIQUE, or child-side FK — the origin enforced them, and an origin-unenforced UNIQUE
collision degrades to last-writer-wins in the backing. What it *does* owe is transactional
lockstep: the derived effects (backing deltas, capture entries, cascade DML) unwind with the
batch savepoint, while externally-applied storage rows are the caller's to reconcile.
Reporting a change against a maintained table is out of contract; its contents are derived.

### MV-022 — A stale view serves its snapshot and propagates nothing

- code: `packages/quereus/src/core/database-materialized-views.ts` — `markMaterializedViewStale`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `tryRecompileMaterializedViewLive`
- guard: `packages/quereus/test/mv-structural-alter-restore.spec.ts` — `frozen ALTER releases the plan, emits backing invalidation, and reads stale until REFRESH`
- doc: [Materialized Views § Schema-change staleness](materialized-views.md#schema-change-staleness)

A source schema change that a body provably cannot observe recompiles the view in place;
anything else marks it **stale** and detaches its row-time plan, so it serves its last
snapshot and source writes stop propagating. `stale` is the only read-state flag. Staleness
is how MV-001 stays honest under DDL: a view that can no longer be maintained refuses to
pretend, and its next reference re-validates the body — erroring with a staleness diagnostic
rather than serving rows against a broken definition. Only `REFRESH`, or drop-and-recreate,
clears the flag.

### MV-023 — A rename rewrites the stored body rather than stranding it

- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `propagateTableRenameToMaterializedViews`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `restoreUnaffectedMaterializedViews`
- guard: `packages/quereus/test/mv-rename-propagation.spec.ts` — `TABLE rename re-keys sourceTables/bodyHash/sql and fires materialized_view_modified`
- doc: [Schema-change staleness § Rename propagation](mv-schema-change.md#rename-propagation-mv--faster-view)

`RENAME TO` / `RENAME COLUMN` on a source rewrites a dependent view's body in place — the
same AST walkers a plain view's body gets — rather than staling it, and re-registers
maintenance against the renamed catalog. This is MV-001 applied to DDL: a plain view follows
a rename, so a materialized view must too. Derived fields (`sourceTables`, `bodyHash`) are
recomputed on the rewritten form (MV-013). A stale flag that predates the statement survives
the rewrite — the backing may already be behind — so the body is fixed but the view stays
stale until `REFRESH`.

### MV-024 — A durable backing is refilled unless it is provably adoptable

- code: `packages/quereus/src/schema/manager.ts` — `tryAdoptPreExistingBacking`
- code: `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` — `backingShapeMatches`
- guard: `packages/quereus/test/view-mv-ddl-persistence.spec.ts` — `rebuilds + fills the backing, keeps maintenance live, names it in .materializedViews, fires no event`
- doc: [Backing-host capability § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity)

Coordinated commit is not two-phase commit: with the backing in one durable module and the
sources in another, a crash between commit acknowledgements can leave them divergent.
The answer is not to restrict module combinations but to make catalog rehydrate
**refill from the body by default**, so any divergence self-heals at the next open. A
pre-existing backing is adopted as-is only when five gates agree: a crash-durable trust
basis, the derived backing shape, module identity, the body hash (re-derived from the
persisted DDL), and same-module sourcing — which further requires that a maintained source
was itself adopted, not refilled.

## VU — View updateability

View updateability reuses the FD / equivalence-class / predicate-normalization machinery in
the *mutation* direction — lineage parallels FDs, propagation parallels emission. The topic
docs ([View Updateability](view-updateability.md) and its satellites) carry the exposition;
these are the claims a single code read can falsify.

### VU-001 — View-targeted DML rewrites to base tables and re-plans

- code: `packages/quereus/src/planner/building/view-mutation-builder.ts` — `buildViewMutation`
- code: `packages/quereus/src/planner/mutation/single-source.ts` — `rewriteViewInsert`
- guard: `packages/quereus/test/logic/93.4-view-mutation.sqllogic`
- doc: [View Updateability § The Update Site Model](view-updateability.md#the-update-site-model)

An `insert` / `update` / `delete` targeting a view, a CTE name, or a subquery-in-`from` is
rewritten to target the underlying base table(s) and re-planned through the ordinary
base-table builders, so all their constraint / conflict / FK machinery is reused verbatim.
There is no view-level updateability flag, no `instead of` trigger, and no `with check
option`: updateability is a property of the body, decided at plan time. The same substrate
serves a materialized-view name — routing to the MV's source, with row-time maintenance
syncing the backing inside the statement.

### VU-002 — Updateable iff a deterministic decomposition exists at plan time

- code: `packages/quereus/src/planner/mutation/propagate.ts` — `classifyViewBody`
- code: `packages/quereus/src/planner/mutation/mutation-diagnostic.ts` — `raiseMutationDiagnostic`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [View Updateability § Mutation Propagation](view-updateability.md#mutation-propagation)

A relation is updateable exactly when the propagation pass finds a deterministic base-table
decomposition at plan time. When it cannot, the write raises a structured `MutationDiagnostic`
(`no-inverse`, `predicate-contradiction`, `recursive-cte`, …) naming the operator and column
that obstructed propagation — it is never silently dropped and never silently widened onto
rows the view does not expose. `classifyViewBody` routes the body (single-source /
multi-source join / decomposition); a shape outside the supported fragment reaches
`raiseMutationDiagnostic` rather than producing a partial or best-effort write.

### VU-003 — PutGet: a write through a view never escapes the view predicate

- code: `packages/quereus/src/planner/mutation/propagate.ts` — `propagate`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [Round-Trip Laws § The three round-trip laws](vu-roundtrip.md#the-three-round-trip-laws)

Applying a mutation through a view and reading the view back reflects exactly the mutation's
effect on the writable columns: no base row outside the view's selection predicate appears,
disappears, or changes, and a write to a computed column is rejected (`no-inverse`), never
silently dropped. The selection predicate is conjoined into every emitted base operation's
predicate, so the view is a window the write cannot reach around. A key the forward FD walk
claims on the view output is the same tuple the backward walk binds the base row by.

### VU-004 — GetPut: reading a row and writing it back is a base no-op

- code: `packages/quereus/src/planner/analysis/update-lineage.ts` — `resolveBaseSite`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [Round-Trip Laws § The three round-trip laws](vu-roundtrip.md#the-three-round-trip-laws)

Reading a row through a view and writing the same values straight back — an `update` keyed on
the view's identifying predicate that assigns each column its just-read value — leaves the
base table byte-unchanged. Each writable output column resolves through `resolveBaseSite` to a
base column (identity, rename, passthrough, or invertible transform), and the write-back lowers
through that site's inverse, so the round trip composes to the identity on the base value.

### VU-005 — Forward and backward lineage agree

- code: `packages/quereus/src/planner/analysis/update-lineage.ts` — `deriveViewColumns`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [Round-Trip Laws § The three round-trip laws](vu-roundtrip.md#the-three-round-trip-laws)

The backward lineage (`deriveViewColumns`) agrees with the forward FD facts (`keysOf` /
`isUnique`) for every output column: each `base`-writable column has a forward FD path to that
base column, and every key the forward walk advertises on the view output is reconstructible by
the backward identifying predicate. A base primary key that survives projection is advertised
as a forward key. An operator that advertises a key forward while its backward `put` rule
threads a different base column is the bug the lineage-agreement law reds.

### VU-006 — A non-invertible column is read-only unless an inverse is authored

- code: `packages/quereus/src/planner/analysis/scalar-invertibility.ts` — `classifyInvertibility`
- code: `packages/quereus/src/planner/analysis/authored-inverse.ts` — `validateAuthoredInverses`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [Scalar Invertibility § Scalar Invertibility](vu-inverses.md#scalar-invertibility)

A projected column whose scalar transform the invertibility registry classifies `opaque` — a
computed or generated column — is read-only: a write reds the `no-inverse` diagnostic, never
silently dropped. `passthrough` and `inverse` transforms stay writable (the write lowers
through the inverse). The one lift is an authored inverse: a `with inverse (…)` clause on the
result column upgrades an otherwise-`opaque` column to a writable `base` site carrying
author-supplied put expressions, validated at build time by `validateAuthoredInverses`.

### VU-007 — A shared key is evaluated once and threaded to every member

- code: `packages/quereus/src/planner/mutation/multi-source.ts` — `analyzeMultiSourceInsert`
- code: `packages/quereus/src/planner/mutation/decomposition.ts` — `analyzeDecompositionInsert`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [Mutation Context § Shared keys are ordinary defaults](vu-mutation-context.md#shared-keys-are-ordinary-defaults--the-engine-chooses-no-id-policy)

A multi-source join `insert`, or an n-way decomposition `insert`, needs a shared key present in
no single base table. The engine invents none: it evaluates the anchor key column's declared
`default` once per produced logical row at the mutation envelope — before any base write — and
threads that one value into every member's key column through the join-key equivalence class.
So all members of a row's fan-out agree on identity, the default fires once per row (not once
per member), and a non-deterministic allocator captured at the envelope replays identically.

### VU-008 — A LIMIT, OFFSET, or DISTINCT body rejects rather than widen

- code: `packages/quereus/src/planner/mutation/single-source.ts` — `analyzeView`
- guard: `packages/quereus/test/property.spec.ts` — `View Round-Trip Laws`
- doc: [Round-Trip Laws § The three round-trip laws](vu-roundtrip.md#the-three-round-trip-laws)

A view body carrying `limit`, `offset`, or `distinct` is outside the supported decomposition
fragment: a row-count window or duplicate collapse cannot be reproduced as a `where` predicate,
so a mutation through it would touch base rows the view never exposes. `analyzeView` rejects
such a body with a structured diagnostic (`unsupported-limit` / `unsupported-distinct`) rather
than silently widening the write onto the collapsed or windowed-away rows. The PutGet law
(VU-003) guards this: the write-widening regression is now a property failure.

## RT — Runtime

Reserved.

## SCH — Schema

### SCH-001 — Index names are unique per schema

- code: `packages/quereus/src/schema/manager.ts` — `findIndexNameOwnerElsewhere`
- code: `packages/quereus/src/schema/catalog.ts` — `isImplicitCoveringIndex`
- code: `packages/quereus/src/schema/schema-differ.ts` — `computeSchemaDiff`
- guard: `packages/quereus/test/schema-manager.spec.ts` — `Index names are unique per schema`
- doc: [SQL DDL § 6.3 Indexes on Virtual Tables](sql-ddl.md#63-indexes-on-virtual-tables)

Within one schema at most one table carries a **user** index of a given name, matched
case-insensitively. `createIndex` rejects a name already held by a user index on another
table in the same schema (`IF NOT EXISTS` does not suppress it), and `computeSchemaDiff`
rejects two `index` declarations sharing a name. Implicit covering structures are excluded
by `isImplicitCoveringIndex`: a UNIQUE constraint's auto-built index takes the constraint's
name, which is unique only per *table*. An **exposed** implicit structure is likewise
outside the guarantee. This is what makes the by-name resolvers carrying no table name —
`dropIndex`, `ALTER INDEX … SET TAGS`, sync's `findIndexOwner` and its migration version
key — unambiguous. `importIndex` warns rather than fails, so an older database still opens.

## SYNC — Sync

Reserved.

## LENS — Lens

Reserved.
