---
description: The query planner now counts storage delay for every join strategy it compares, instead of only some of them, so it no longer picks a slower plan believing it is cheaper.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts
  - packages/quereus/test/optimizer/join-latency-cost.spec.ts
  - docs/optimizer-costing.md
  - docs/optimizer-joins.md
difficulty: medium
---

# Charge every join strategy the storage delay it actually pays

## What shipped

A virtual-table module may declare `expectedLatencyMs` — the time its tables
take to hand back the **first** row of a freshly opened iterator. Every in-tree
module declares 0; a network-backed one would not. `ruleJoinPhysicalSelection`
compares five ways to run a join and previously charged that delay unevenly:
once to hash and merge (always the *right* side's, hard-coded), per seek to both
index-nested-loop orientations, and not at all to the plain nested loop. Two
`NOTE:` blocks at the comparison site recorded both gaps; both are resolved and
deleted.

Every candidate is now charged **one open of its outer side plus however many
opens of its inner side it performs**:

| candidate | charge added |
| --- | --- |
| plain nested loop | `leftLatency + (opensOnce ? rightLatency : leftRows × rightLatency)` |
| hash | `leftLatency + rightLatency` |
| merge | `leftLatency + rightLatency` |
| index-nested-loop | `leftLatency` (per-seek right latency already inside `indexNestedLoopJoinCost`) |
| index-nested-loop, mirrored | `rightLatency` (per-seek left latency already inside) |

"opensOnce" is `nestedLoopRightOpensOnce(node, context)`, exported by
`rule-nested-loop-right-cache`: the right side is already materialized, or that
rule (later in the same pass) is about to wrap a pure, uncorrelated,
small-enough inner side in a `CacheNode`, turning N re-opens into one open plus
N buffer replays. The selection rule never restates a gate, and short-circuits
the call entirely when `rightLatency === 0` — the size gate walks the whole
right subtree, and that walk must stay off the zero-latency hot path. The
implement stage also split the cache rule's gates into a separate exported
predicate, `canCacheNestedLoopRight`; review found that predicate was the wrong
question for the cost site and added the open-count one on top of it (see
findings).

The whole surface is inert at `expectedLatencyMs === 0`, which every in-tree
module reports, so the golden plan sweep is unchanged.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn test` — 10,119 passing, 25 pending, 0 failing across the monorepo, after
  the review's fix and 4 added tests (10,115 before). No pre-existing failures
  surfaced, so no `.pre-existing-error.md` was written.
- Spec: `packages/quereus/test/optimizer/join-latency-cost.spec.ts`, 9 tests.

## Review findings

### Read first, then the handoff

The implement-stage diff (`c8f017036`) was read before the handoff summary.
Verified independently rather than taken on the handoff's word: the mirrored
index-nested-loop really is fed the left side's latency per seek
(`tryIndexNestedLoop` passes `inner.physical.expectedLatencyMs` at
`index-nested-loop.ts:602`, and the mirror's `inner` is `node.left`); the rule's
type guard returns null for `right` and `full` joins long before the cost block,
so the cache predicate is never reached with one; the correlated-inner early
return (`readsColumnsOf`) still fires before any latency is computed; the gate
split into `canCacheNestedLoopRight` is faithful — every gate present, in the
original order, each polarity flipped correctly, and the dropped `%d rows` from
one debug line costs nothing.

### Major — fixed in this pass

**The plain nested loop was re-priced as uncached after its inner side was
cached, converting the plan to a hash join and discarding the cache.**
`ruleJoinPhysicalSelection` runs again on a join that `ruleNestedLoopRightCache`
has already rewritten. On that second visit `canCacheNestedLoopRight` answers
*false* — its already-cached gate means "nothing left to wrap" — and the new
charge read that as "opens the inner per outer row". Observed directly in the
rule's own debug log on a 2-row × 40-row inner join with a 25 ms right side:
first visit `nl=35, hash=42.6` → nested loop kept; cache rule wraps the inner;
second visit `nl=60, hash=42.6` → converted to hash, cache thrown away. The
optimizer settled on the plan it had already priced as the more expensive one.

Root cause is one site and one question: the cost model needs *how many times is
the inner opened*, which is not *is there a cache left to add*. Fixed by adding
`nestedLoopRightOpensOnce` next to the predicate in the cache rule (already
materialized **or** about to be), and pointing the selection rule at that. No
gate is duplicated and nothing moves at latency 0. Pinned by the new arm-3 test
"keeps the nested loop when its high-latency inner will be cached", which failed
before the fix and passes after.

### Minor — fixed in this pass

- The cost debug line used `%.2f`, which `debug` has no formatter for: it
  printed the token verbatim and appended every cost value *after* the row
  counts, so each line read `for 35 x 42.6 rows 467.35 Infinity Infinity 2 40`.
  Pre-existing, but it is the diagnostic for exactly this change and it is how
  the defect above was found. Changed to `%d`.
- Docs re-read against the new reality rather than assumed current:
  `docs/optimizer-joins.md`'s charge table and `docs/optimizer-costing.md`'s
  latency subsection now name the open-count predicate and state why it is not
  the cacheability one; the spec's header comment matches.

### Tests — the implementer's set was a floor; added to

- **Nothing covered the plain nested loop against hash.** Arm 1 uses an
  `exists … as` join, where hash and merge are structurally excluded, so it only
  ever pitted the loop against the index-nested-loop; arm 2 pitted hash against
  the mirror. The ordinary shape — a plain inner join where hash *is* a
  candidate — had no test, and it is the shape that exposed the defect above.
  Added as arm 3: three tests over a 2-row × 40-row join with no index on either
  join column (so neither seek orientation exists), covering the cached inner,
  the inner past the cache size gate, and the zero-latency control.
- **A high-latency LEFT side was untested in either direction.** The handoff
  flagged the original ticket's third suggested test as not following from its
  own charge table, and dropped it. That call is correct — but for a reason the
  handoff did not give. The mirror's *inner* is the left, so the left's latency
  is charged to it once per seek inside `indexNestedLoopJoinCost`; a remote left
  makes the mirror dramatically **worse**, not better, and the ticket's prose
  had the sign backwards. Added a test pinning that: the 30-row shape the mirror
  wins outright with a local left flips to hash the moment the left is remote
  (mirror 829 vs hash 114), and stays hash with both sides remote. This covers
  the "both sides high latency" case the handoff also listed as missing.
- **The un-analyzed-row-count case is still not isolated**, as the handoff said.
  Left alone deliberately: with no statistics both sides collapse to the 100-row
  default, which makes hash beat the plain nested loop on work alone in every
  shape reachable here, so the branch cannot be made to decide a plan. Not a
  test that would fail if the code were wrong.
- Arm 2's margins are as thin as the handoff described (the 45-row case wins by
  5 units of work). Left as-is: the positive control at 30 rows does distinguish
  "hash won" from "no mirror candidate was built", which is the failure mode
  worth guarding, and the new left-latency test now exercises the same pair with
  a margin of several hundred.

### Tripwires parked in code

- `rule-join-physical-selection.ts`, on `nestedLoopInnerLatency` — a semi/anti
  join breaks out of the inner scan on the first match, so its cache buffer only
  lands after the first *unmatched* outer row: a match-heavy semi join can
  re-open the inner per outer row while this charges it once. Recorded rather
  than "fixed" because the error is bounded by `(outerRows − 1) × latency` and
  runs the opposite way to the work term's existing pessimism (a full inner scan
  charged per outer row for a loop that breaks early); picking either end of
  that range is not defensibly better while both terms are this coarse. Also
  stated in `docs/optimizer-joins.md`.
- The impure-right-side `NOTE:` from the implement stage is kept and folded into
  the same block.
- Considered and **not** recorded: `rule-eager-prefetch-probe` hides some of a
  hash join's build-side latency after selection has already charged it in full.
  Real, but it is a threshold-gated rewrite that does not change any candidate's
  open count, so the charge table stays correct as written.

### Filed as new tickets

- `backlog/debt-join-selection-candidate-list` — `ruleJoinPhysicalSelection` is
  294 lines (~145 of code), and each strategy is spread across three
  hand-synchronized places: a cost expression, an `if (< bestCost)` block whose
  position decides ties, and two parallel log literals. Five strategies today,
  a sixth arriving with `feat-index-nested-loop-batched-seeks` (which is why the
  ticket carries it as a prereq rather than colliding with it). Filed at the
  representation rung — one candidate list — not as "split this function".
- `backlog/debt-shared-high-latency-test-module` — ten optimizer specs each
  declare a private copy of the same fake 25 ms storage module, and their
  comments have already drifted (one calls itself the shared fixture while being
  the tenth copy). This ticket's spec is that tenth copy; the batched-seeks
  ticket will add an eleventh.

### Checked and clean

- **Resource cleanup / error handling** — nothing here opens, allocates, or
  throws; the change is arithmetic over already-computed plan properties, and
  every absent candidate costs `Infinity` so it can never win (`bestCost` starts
  at the always-finite `nlCost`, so no comparison can select a null candidate).
- **Type safety** — no `any` and no non-null assertion added; the two `?? 0`
  reads match every other consumer of `expectedLatencyMs` in the tree.
- **Layering** — the new import direction `rules/join/` → `rules/cache/` is
  acyclic (the cache rule imports nothing from `rules/join/`) and is the only
  way to avoid restating the gates; the alternative, duplicating them, is what
  the two deleted `NOTE:` blocks were warning about.
- **Rule ordering** — confirmed the handoff's "runs later in the same pass"
  claim by reading the registry: `phase` is a label the pass manager never
  orders on, and within `PassId.PostOptimization` rules apply in registration
  order, where `join-physical-selection` precedes `nested-loop-right-cache`.
- **Performance** — the predicate walks the right subtree, but only past the
  `innerLatencyMs === 0` short-circuit, so no in-tree plan pays for it.
- **Double logging** — the handoff's known gap stands: the size-gate decline can
  log twice per join. Debug-only, high-latency plans only; not worth a gate.
