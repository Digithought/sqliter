---
description: A sub-query inside WHERE or HAVING can now read a calculated column from the surrounding query without the query failing at runtime.
files:
  - packages/quereus/src/planner/analysis/predicate-dependencies.ts            # NEW — shared dependency collector
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts    # canPushAcrossProject rewired (arm A)
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts  # isConjunctPushable rewired (arm B)
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts       # header NOTE re-pointed (review)
  - packages/quereus/src/planner/cache/correlation-detector.ts                 # reused unchanged
  - packages/quereus/test/logic/07.7.8-correlated-ref-to-computed-column.sqllogic      # row-set guard
  - packages/quereus/test/optimizer/predicate-pushdown.spec.ts                 # plan-shape guard, arm A
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts  # plan-shape guard, arm B
  - packages/quereus/test/view-home-schema.spec.ts                             # oracle simplified (line ~1081)
  - docs/optimizer-rule-families.md                                            # refusal documented (review)
difficulty: medium
---

# Correlated sub-query reading an outer computed column — complete

## What was wrong

Two predicate-pushdown rules asked "which attributes does this predicate need in
scope?" by walking the predicate's **scalar** tree and stopping at any relational
child. A correlated reference inside an `exists` / `in` / scalar-sub-query operand
lives in exactly that relational subtree, so the answer came back empty. The push
went ahead, the reference landed below the node that defines the attribute it
reads, and the query died with:

```
No row context found for column <c>. The column reference must be evaluated
within the context of its source relation.
```

## What changed

**New file `src/planner/analysis/predicate-dependencies.ts`.** One collector, two
exports:

```ts
export interface PredicateDependencies {
	readonly direct: ReadonlySet<number>;      // the predicate's own scalar column refs
	readonly correlated: ReadonlySet<number>;  // what sub-query operands read from OUTSIDE themselves
}
export function collectPredicateDependencies(expr: ScalarPlanNode): PredicateDependencies;
export function collectPredicateAttributeIds(expr: ScalarPlanNode): Set<number>;  // union
```

The relational half delegates to the pre-existing `collectExternalReferences()` in
`planner/cache/correlation-detector.ts` (unchanged), which walks both
`getChildren()` and `getRelations()` and subtracts every attribute the subtree
defines for itself.

**Arm A — `rule-predicate-pushdown.ts`.** `canPushAcrossProject` gates on the union
(`collectPredicateAttributeIds`). The local scalar-only collector was deleted.

**Arm B — `rule-aggregate-predicate-pushdown.ts`.** `isConjunctPushable` refuses any
conjunct whose `correlated` set is non-empty, then gates on `direct` exactly as
before. The refusal (rather than teaching the rewriter to descend) is deliberate:
`rewriteOutputToSource` skips relational children, so a correlated reference carried
through would keep pointing at the aggregate's *output* attribute id while the rest
of the conjunct got rewritten onto source ids.

**Test-oracle simplification.** `view-home-schema.spec.ts`, "sizes a body sub-query's
source up in the home schema…": the oracle had been spelled against the base tables
with a comment pointing at this bug. It now reads through the view, comment gone.

**Review-stage additions** (below, under *Review findings*): the refusal is now
documented in `docs/optimizer-rule-families.md`, the sibling join rule's header NOTE
points at the new collector, a cost tripwire sits on the collector, and four test
cases were added.

## Validation

Run from repo root, after the review changes:

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`), all workspaces.
- `yarn test` — **8536 passing, 0 failing** in `packages/quereus` (8535 before the
  review's one added `it`; the four sqllogic statements added below live inside that
  file's single existing `it`). Every other workspace green and unchanged: 370, 113,
  63, 17, 28, 1291, 648, 52, 31, 34, 134, 22.

# Review findings

## What was checked

The implement-stage diff was read first, before the handoff summary. Both rule
sites, the new collector, and `correlation-detector.ts` were read in full. Every
other use of `isRelationalNode` under `src/planner/rules/` and
`src/planner/analysis/` was inspected for the same scalar-only blind spot. The
`docs/` tree was searched for text describing the Project gate. Lint and the full
test suite were run.

## Correctness — nothing found

No defect in the fix. Both new refusals fail in the safe direction: they can decline
a push that would have been legal, never admit one that is not.

- **Arm A** requires every id in `direct ∪ correlated` to exist below the Project.
  A pass-through column's id is preserved by `ProjectNode`, so correlating on one
  still pushes; a computed column's id is minted by the Project and cannot be found
  below, so it refuses. A grandparent-scope id is also not found below and is
  refused — pessimistic, and already carried as a `NOTE:` at the site.
- **Arm B** refuses on any non-empty `correlated` set, which subsumes the
  aggregate-output, group-key, and outer-scope cases alike.
- **No third hole.** The only other predicate-dependency collector in the optimizer
  is `collectSubtreeAttributeIds` in `rule-join-predicate-pushdown.ts`, and it
  already descends through relational children (an earlier ticket taught it to). It
  is strictly *coarser* than the new collector — it counts a sub-query's own
  internal ids too, which land on neither join side, so any conjunct carrying a
  sub-query is declined. Sound. Everything else that matched the search is a tree
  *rebuilder* (`rebuildChain`, `rebuildPipelineWithNewLeaf`, `rewriteOutputToSource`),
  not a dependency question.

## Test coverage — gaps found and filled in this pass

The implementer's own handoff flagged that arm B's discriminating test (`having g > 0`)
carries no sub-query at all, so a future blanket "refuse every sub-query" would still
pass it. That was the real gap. Added:

- `test/logic/07.7.8-…sqllogic` and
  `test/optimizer/rule-aggregate-predicate-pushdown.spec.ts` — an `or` conjunct
  mixing `g > 0` with an **uncorrelated** `exists`. Unsplittable, carries a
  sub-query, and must still push (asserted: zero FILTERs above the aggregate, all
  four groups returned). A blanket refusal now fails.
- `test/logic/07.7.8-…sqllogic` — the correlated `IN (select …)` form. The operand
  hangs off an `InNode`, which reports its own node type; the collector recognizes
  the relational child structurally, and this pins that.
- `test/logic/07.7.8-…sqllogic` — a correlation buried two sub-queries deep, pinning
  the "whole operand subtree is scanned" claim.
- Corrected a misleading comment in the same file: a case labelled "a conjunct that
  is correlated but whose sub-query is NOT correlated" is not correlated at all, and
  `and` splits it into two conjuncts before the guard ever sees it.

## Docs — one gap, fixed

The implement stage updated no documentation. `docs/optimizer-rule-families.md`
§ *Predicate Pushdown Implementation* is where each pushdown refusal is recorded,
in a "(ticket `<slug>`)" bullet style with pointers to the row and plan-shape
guards. The new refusal was missing; a bullet in that style was added.
`docs/optimizer.md` names `rulePredicatePushdown` only in a rule list and needed no
change. No other doc described the Project gate.

## Stale cross-reference — fixed

`rule-join-predicate-pushdown.ts`'s header NOTE said its pessimistic outer-reference
refusal could only be recovered "after separating a genuinely-outer id from a
subquery-internal one, which this walk does not currently distinguish". The new
module distinguishes exactly that. The NOTE now points at it, while keeping the
existing gate — the header defers that change until a correlated body is *measured*
losing a seek, and the swap would also make more conjuncts pushable, which needs its
own plan-shape coverage.

## Tripwires (recorded in code, not filed as tickets)

- **Correlation detection cost.** Each relational child costs two full walks of its
  subtree, once per conjunct per rule firing. Nothing measured; predicate sub-query
  bodies are small today. `NOTE:` on `walk()` in `predicate-dependencies.ts`, naming
  the fix if it ever shows up hot (memoize on a `WeakMap` keyed by the relational
  child — plan nodes are immutable, so it is sound).
- The two refusal-pessimism `NOTE:`s the implementer left at the arm A and arm B
  sites were verified accurate and left in place.

## New tickets filed — one, unrelated to the fix

`tickets/backlog/debt-planner-analysis-readme-stale.md`. The change added a file to
`src/planner/analysis/`, whose `README.md` is titled "Constant Folding
Implementation" and inventories three files in a folder that now holds about thirty.
Pre-existing, not made worse by this change, and orthogonal to it — hence a separate
ticket rather than an inline fix. Checked the board first; no open ticket names that
path.

No ticket was filed against the fix itself: nothing found in it warranted one.

## Deliberately left alone

- **`view-home-schema.spec.ts` ~line 1137**, the sibling oracle the implementer
  flagged. It spells `temp.dk` explicitly, and that is load-bearing: the test is
  about a view whose `with schema "temp", main` clause decides *which* `dk` the body
  binds. Reading the oracle through the view would erase the very thing the test
  pins. The comment-free base-table spelling is correct here; the one that was
  simplified had a comment saying it existed only because of this bug.
- **The join rule's collector was not unified** with the new module. A
  behaviour-preserving swap would need a third "all subtree ids" accessor whose
  semantics are a coarse proxy, muddying the new module's two-set contract; the
  behaviour-*changing* swap is gated on measurement by that rule's own header. The
  cross-reference above is the proportionate action.

## Not run

`yarn test:store` (the LevelDB-backed re-run of the logic suite). The change is
planner-only and touches no module surface, so the store leg exercises identical
plan decisions — an argument, not a measurement, and the same one the implementer
gave. Flagged here so it is not mistaken for a clean store run.

## Note on the implement handoff

It reported "zero pending". The suite reports **13 pending** in `packages/quereus`,
before and after — the diff adds no `skip`, so these predate the ticket. Nothing to
do; recorded so the number is not read as a regression later.
