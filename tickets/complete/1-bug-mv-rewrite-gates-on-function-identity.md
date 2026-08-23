---
description: A query answered from a materialized view used to return the view's old stored numbers when the application had since registered its own function under a name the view uses; the optimizer now notices the name changed meaning and computes the query normally instead.
files:
  - packages/quereus/src/schema/derivation.ts                                    # ~69 `bodyFunctions`
  - packages/quereus/src/planner/analysis/mv-body-functions.ts                   # the capture walk (50 lines)
  - packages/quereus/src/core/database-materialized-views.ts                     # ~318 registerMaterializedView — capture point
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts               # ~83 reason, ~178 RecipeOrDecline, ~245 FunctionIdentityGate, ~694 gate build, ~1243/~1281/~1338 call sites, ~1390 tripwire NOTE
  - packages/quereus/src/planner/analysis/predicate-shape.ts                     # ~151 walkAstNodes widened to AstNode
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                        # "— function identity" describe block (8 cases)
  - docs/usage.md                                                                # ~688 shadowing section
  - docs/materialized-views.md                                                   # ~51/~57 derivation field list, ~282 "Function identity"
  - docs/schema.md                                                               # ~85 TableDerivation runtime-state bullet
  - docs/optimizer-rule-families.md                                              # ~29 aggregate-rollup arm
difficulty: medium
---

# What shipped

A materialized view's stored rows were produced by whichever functions were registered
when its maintenance plan was built. Function registration overwrites by
`(name, argument count)`, so `db.createAggregateFunction('sum', …)` re-points `sum/1` for
every later query on the connection without touching a single stored row. The
materialized-view query rewrite matched the view's stored aggregates to a query's
aggregates **by name**, so a covered query was handed the previous function's numbers
while the same query spelled a way the view could not answer returned the new function's —
silently, with no error and no way for the application to see the disagreement.

The rewrite now proves the name still means the same function before it trusts a stored
value.

**Capture.** `registerMaterializedView` walks the body AST, resolves every function call
`(name, argc)` against the live registry (`findFunction(name, argc) ?? findFunction(name, -1)`),
and records the resulting schema objects on `TableDerivation.bodyFunctions`, keyed by
`getFunctionKey(name, argc)`. It sits beside the existing `sourceScope` assignment, before
anything in the registration can throw, so every create / attach / reopen / rename /
live-recompile path that re-registers a view also refreshes it. Runtime-only: the catalog
serializes a maintained table through an explicit field pick (`maintainedDescriptor`), so
the map never reaches persistence — object identity could not survive a process boundary
anyway. The walk reuses `walkAstNodes`, the reflective whole-subtree walk (its parameter
widened from `AST.Expression` to `AST.AstNode` so a whole body walks like an expression),
which is why no clause — select list, WHERE, GROUP BY, HAVING, ORDER BY, nested subquery —
can be missed by a forgotten visitor case.

**Gate.** A new `RewriteFailureReason`, `'function-rebound'`, distinct from
`aggregate-not-decomposable`. `matchAggregateFragmentToMv` builds one
`identityOk(name, argc)` closure comparing the recorded schema against
`resolveAggregate(name, argc)` by object identity; absent map, absent entry, or a different
object ⇒ decline, and the query is computed from the base tables (correct, only slower).
Applied at the three sites that consume a stored value: `recipeForExact`, `recipeForRollup`'s
directly-mergeable branch, and `resolveMergeablePartial` (including the `count(*)`
substitution). The recipe helpers return `AggregateRecipe | 'rebound' | undefined` so the
two decline kinds stay nameable apart at the call site.

Both originally reported arms are fixed — a shadowed built-in `sum` over a view holding
`sum(x)`, and a user aggregate re-registered with different behaviour under its own name.

# Review findings

## Verified, not just re-read

- **The capture point covers every registration path.** All eight `registerMaterializedView`
  call sites (create, attach/re-attach with its rollback arms, refresh, `alter table … rename`,
  live recompile) were read; the capture is the second statement of the method, ahead of
  `buildMaintenancePlan`'s throw, so a path that registers at all captures.
- **The map is genuinely never serialized.** `maintainedDescriptor` (`schema/catalog.ts:377`)
  picks four fields explicitly, and the one shallow derivation copy in the tree
  (`catalog-persistability.ts:136`) feeds that same picker.
- **Resolver symmetry holds.** The capture and the rule's `AggregateResolver` perform the
  identical lookup (exact arity, then the variadic `-1` registration) against the same
  schema map, so the identity comparison is apples-to-apples. A name captured as a *scalar*
  compares false against the aggregate resolver — a decline, which is the safe direction.
- **Argument-count keying is consistent for `count(*)`.** The parser gives `count(*)`
  `args: []`, so the capture keys it `count/0`; `aggArgc(undefined)` is `0`; and the built-in
  registers `count/0` and `count/1` as separate schemas (`func/builtins/aggregate.ts:53,322`).
  The `count(*)`-substitutes-for-`count(x)` branch re-keys to `0` before gating, correctly.
  Had any of these disagreed, every view storing `count(*)` would have declined its rewrite
  — a silent blanket loss of the optimization, which is why it was checked rather than assumed.

## The implementer's flagged deviation — checked and endorsed

The source ticket asked for the rollup to be gated on the **query** aggregate's
`(name, argc)`. Taken literally that breaks `avg` rollup: a body storing `sum(x)`/`count(x)`
answers `avg(x)` without the body ever naming `avg`, so `avg/1` is legitimately absent from
the capture. The implementation instead gates the functions whose **stored values are
consumed** — the aggregate's own partial on the direct-merge path, each sibling partial on
the decompose path.

That is sound, and re-derived here rather than taken on trust. The recombine applies the
*live* aggregate's declared decomposition over partials proven to be the live `sum`/`count`,
which is exactly what recomputing over the base rows would do. It holds even when the
composed aggregate is itself a user registration: a shadowed `avg` contributes its own
declared `combine`, over identity-verified partials, giving what that shadow would compute
directly — the same contract every user aggregate carries without a view in the picture
(algebra law #5, pinned by `assertAggregateAlgebraLaws`). The rationale is recorded in
`recipeForRollup`'s doc comment.

## The other arms — the "needs no gate" claim, tested harder than stated

The handoff argued the projection and join arms are safe because they match only bare
passthrough columns. True, and confirmed at `mvProjectionBaseCols` — a computed select item
is left unmapped and the output coverage check fails `missing-column`. But that argument
covers select lists only, and those arms also read the MV body's **WHERE**, which the
handoff did not address. Chased down: `recognizeGuardClauses` returns `undefined` if *any*
conjunct is unrecognized (never a partial recognition), and its clause vocabulary is
column-vs-literal / column-vs-column only, while `planTimeLiteralValue` accepts a
`LiteralNode` and nothing else — so `where upper(name) = 'A'` and `where x = upper('a')`
both make the whole predicate opaque and forgo with `predicate-not-entailed`. No function
value from an MV body's WHERE can reach a rewrite un-gated. The claim holds for predicates
as well as projections; it just held for a different reason than the one given.

## Fixed in this pass (minor)

- **Untested branch.** The two rollup tests both took the `algebra.decode` direct-merge
  path, so `resolveMergeablePartial`'s new `'rebound'` return and `recipeForRollup`'s
  propagation of it — the entire decompose/partial arm of the gate — shipped with no
  coverage. Added `function-rebound: an avg rollup declines when a stored PARTIAL was
  re-registered`: `avg(amt)` over the SALES view, asserted composing before the shadow and
  declining `function-rebound` after a `sum/1` takeover that deliberately declares
  merge/decode so it clears the decomposability check first.
- **No isolation test between views.** Added `a shadow declines only the views that store
  the shadowed name`: two views over one base table, `sum/1` shadowed, the `sum` view
  declines while the `count(*)` view keeps matching exact-key.
- **Documentation drift.** `TableDerivation`'s runtime-state field list is enumerated in
  three places and none mentioned the new field: the substrate diagram and the "derivation
  record" bullet in `docs/materialized-views.md`, and the runtime-state bullet in
  `docs/schema.md`. All three updated, each pointing at the § Aggregate rollup explanation.
  (`docs/optimizer-rules.md`'s one-line entry delegates to `optimizer-rule-families.md`,
  which the implementer did update — no drift there.)

## Major findings: none filed, with the reason

The one live hazard is real and was raised honestly in the handoff: any re-registration
refreshes the capture, so `alter table mv rename`, a reopen, or a live recompile after a
takeover rebuilds the maintenance plan against the new function **and** re-captures from
it, re-opening the read gate over a backing that holds a mix of both functions' output.
That is not a new ticket — it is the entire subject of `bug-mv-maintenance-detects-function-drift`,
already sitting in `implement/`, which names the same site (`registerMaterializedView`) and
is designed to read the prior map before this ticket's single-statement overwrite. Recorded
as evidence there rather than re-filed. Nothing else rose to major.

## Tripwires

None added. The implementer's `NOTE:` at `analyzeMvStoredColumns`
(`query-rewrite-matcher.ts:1390`) is the right knowledge in the right form — if the
projection or join arm ever learns to match a computed column it must consume
`derivation.bodyFunctions` the same way — and it is genuinely conditional, since neither
arm matches computed columns at all today. Left as-is.

## Considered and declined

- **`query-rewrite-matcher.ts` size.** `wc -l` says 1542, up 79 from this ticket. Large,
  but in line with its neighbours (`database-materialized-views.ts` 1323,
  `materialized-view-helpers.ts` >3200) and the additions are cohesive with the aggregate
  arm they serve. No split filed.
- **`min`/`max` under a collated argument with a shadow**, suggested by the handoff as
  reviewer probing. It takes the same `algebra.decode` direct-merge branch the `sum` rollup
  test already pins, and the collation binding is orthogonal to function identity — no new
  branch would be exercised. Not written.
- **Over-capture** (a body subquery's function call records a key the gate may later consult
  for an unrelated stored column) forgoes a speedup and never a correct answer. Left as the
  handoff had it.
- **Across a process boundary the check cannot verify a user function**, and the determinism
  gate can still fire first and mask `function-rebound` with `no-candidate` (same correct
  outcome, different reason). Both are inherent and both are stated in `docs/usage.md`.

# Validation

- `yarn typecheck` (all workspaces) — clean.
- `yarn lint` (all workspaces, including the quereus eslint + `tsconfig.test.json` pass) — clean.
- `yarn workspace @quereus/quereus test` — **10215 passing, 25 pending** (10213 before, +2 from
  this review's tests). No failures; `tickets/.pre-existing-error.md` not written.
- Root `yarn test` (every workspace) — exit 0, 11m42s. It exceeds the ten-minute foreground
  window, so it is not routinely agent-runnable; recorded here because it was worth
  confirming once that no other package reads the rewrite's behaviour.
- `yarn test:store` not run — reserved for store-specific diagnosis per AGENTS.md. The reopen
  paths were verified by reading every `registerMaterializedView` call site, which is a
  call-graph argument, not an observation; the store-backed reopen remains unexercised, as
  the handoff said.
