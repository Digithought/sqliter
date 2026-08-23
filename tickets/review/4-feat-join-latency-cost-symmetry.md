---
description: The query planner now counts storage delay for every join strategy it compares, instead of only some of them, so it no longer picks a slower plan believing it is cheaper.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # the rewritten latency charges + new helper
  - packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts  # gate extracted as `canCacheNestedLoopRight`
  - packages/quereus/test/optimizer/join-latency-cost.spec.ts                 # new spec (5 tests)
  - docs/optimizer-costing.md                                                 # new "First-row latency in cost comparisons" subsection
  - docs/optimizer-joins.md                                                   # per-candidate charge table
difficulty: medium
---

# Charge every join strategy the storage delay it actually pays

## What shipped

A virtual-table module may declare `expectedLatencyMs` — the time its tables
take to hand back the **first** row of a freshly opened iterator. Every in-tree
module declares 0; a network-backed one would not.
`ruleJoinPhysicalSelection` compares five ways to run a join and previously
charged that delay unevenly: once to hash and merge (always the *right* side's,
hard-coded), per seek to both index-nested-loop orientations, and not at all to
the plain nested loop. Two `NOTE:` blocks at the comparison site recorded both
gaps; both are now resolved and deleted.

Every candidate is now charged **one open of its outer side plus however many
opens of its inner side it performs**:

| candidate | charge added |
| --- | --- |
| plain nested loop | `leftLatency + (cacheable ? rightLatency : leftRows × rightLatency)` |
| hash | `leftLatency + rightLatency` |
| merge | `leftLatency + rightLatency` |
| index-nested-loop | `leftLatency` (per-seek right latency already inside `indexNestedLoopJoinCost`) |
| index-nested-loop, mirrored | `rightLatency` (per-seek left latency already inside) |

"cacheable" is the new exported predicate `canCacheNestedLoopRight(node,
context)`, split out of `ruleNestedLoopRightCache`. That rule runs later in the
same pass and wraps a pure, uncorrelated, small-enough inner side in a
`CacheNode`, turning N re-opens into one open plus N buffer replays — so when it
will fire, the plain nested loop pays the latency once, not per outer row.
The predicate carries the original gates verbatim (driver type, already-cached,
purity, determinism, correlation, CTE-safety, the
`join.maxRightRowsForCaching` size gate over `estimateRightRows`); the rule body
is now a gate call plus the `CacheNode` build. The selection rule calls the
predicate and never restates a gate, and short-circuits the call entirely when
`rightLatency === 0` — the size gate walks the whole right subtree, and that
walk must stay off the zero-latency hot path.

Verified rather than assumed: `tryIndexNestedLoop` computes its per-seek latency
as `inner.physical.expectedLatencyMs` (`index-nested-loop.ts:602`), and the
mirrored call passes `inner = node.left` — so the mirror really is already fed
the left's latency per seek. The second `NOTE:` was deleted on that basis.

## Use cases to exercise

Everything here is **inert at latency 0**, which is the primary regression
guard: the full 10,115-test sweep (including every golden plan) is unchanged.
To see any of it, a module must declare a non-zero `expectedLatencyMs`. The
in-tree stand-in is the `HighLatencyMemoryModule` fixture
(`class HighLatencyMemoryModule extends MemoryTableModule { readonly expectedLatencyMs = 25 }`),
registered with `db.registerModule('hi_lat', …)` and selected per table with
`create table … using hi_lat`.

**Arm 1 — the plain nested loop's re-opens.** An `exists … as` join is the one
shape where this decides the plan outright: hash and merge drop the appended
flag column, so the rule's early return compares only the plain nested loop
against the index-nested-loop. With a 100-row outer, a 20-row high-latency
inner and latency 25:

- inner cacheable → plain NL costs 325 vs index-NL 2680, so the nested loop is
  kept and the cache rule wraps the inner. An *unconditional* per-row charge
  would price it at 2800 and hand the win to a 8.6x worse plan.
- inner over the cache size gate (`maxRightRowsForCaching` lowered to 5 in the
  test) → plain NL costs 2800 vs index-NL 2680, so the plan switches to the
  index-nested-loop. This is the case that was mis-planned before.

**Arm 2 — orientation symmetry.** Hash, merge and the mirrored
index-nested-loop all open the right input exactly once, so the right's latency
now **cancels** between them and can never decide that comparison. Previously
only hash and merge carried it, so raising a right side's latency handed wins to
the mirror it had not earned. The spec pins this with a 100-row left indexed on
the join column (zero latency) against a right side whose join column is
unindexed (so the un-mirrored orientation declines and merge would need two
sorts): a 30-row right picks the mirror at either latency, a 45-row right picks
hash at either latency. Pre-change, the 45-row high-latency spelling flipped to
the mirror.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean (only `packages/quereus` has a real lint; it also
  type-checks the test files).
- `yarn test` — 10,115 passing, 25 pending, 0 failing across the monorepo. No
  pre-existing failures surfaced, so no `.pre-existing-error.md` was written.
- New spec: `packages/quereus/test/optimizer/join-latency-cost.spec.ts`, 5 tests.

Each of the three behavioral changes was checked to be a real regression pin by
temporarily reverting it and confirming the matching test fails:

| reverted change | test that fails |
| --- | --- |
| all latency terms back to the old block | "switches to the index-nested-loop when the inner is too large to cache" and "a 45-row right side: hash wins at either latency" |
| the cacheability branch made unconditional (`outerRows × latency` always) | "keeps the nested loop when the cache rule will collapse the re-opens to one" |

## Known gaps — treat the tests as a floor

- **The ticket's third suggested test does not follow from its own spec table,
  and was replaced.** It asked for "high-latency LEFT input, zero-latency right
  … the swapped index-nested-loop no longer wins over hash". Under the specified
  table a high-latency left adds `leftLatency` to hash/merge and nothing to the
  mirror, which makes the mirror *more* competitive, not less. The implemented
  table is what the ticket's "What to build" section specifies; the observable
  arm-2 effect is the hash/merge ↔ mirror symmetry described above, and that is
  what the spec pins. Worth a reviewer's second opinion on whether the intended
  behavior was the table or the prose — the code follows the table.
- **Arm 2's margins are small by nature.** Arm 2 only ever adds a one-time open
  (≤ one latency value), so any end-to-end test of it sits within ~25 cost units
  of the crossover. The 45-row case wins by 5 units (mirror 81 vs hash 76 on
  work alone). It is a real pin, but it is sensitive to the memory module's
  `rowsPerSeek` answer and to the `COST_CONSTANTS` values; a future constant
  tweak could silently turn it into a tautology. The 30-row positive control
  exists precisely so "hash won" cannot be confused with "no mirror candidate
  was built", but nothing pins the *margin* itself.
- **No test drives both sides high-latency.** The ticket asked for one
  ("assert the *ordering* of candidates rather than absolute costs"). It is not
  in the spec: with both latencies equal the arm-2 terms cancel across
  hash/merge/index-NL and only the plain nested loop moves, which the arm-1
  tests already cover. A reviewer may want it anyway as a shape check.
- **No test for the un-analyzed-row-count interaction.** The ticket flagged that
  a table with no statistics collapses to the 100-row default, so a
  latency-bearing plain NL gets its charge multiplied by 100. The arm-1 fixture
  happens to have a 100-row outer either way (analyzed or not), so the branch is
  exercised but not *isolated*. Worth a dedicated case.
- **`canCacheNestedLoopRight` predicts a rule that has not run.** One case it
  answers pessimistically — an impure right side that `mutating-subquery-cache`
  will wrap — is recorded as a tripwire `NOTE:` at the call site rather than
  filed as a ticket (see below). It is unreachable today because no rival
  candidate accepts an impure inner either.
- **Double logging.** `canCacheNestedLoopRight` is now called from two places
  in the same pass on the same join (the selection rule, then the cache rule),
  so its size-gate decline can log twice per join. Debug-only, and only on
  high-latency plans.

## Tripwires parked in code

- `rule-join-physical-selection.ts`, on `nestedLoopInnerLatency`: `NOTE:` that
  the cacheability predicate over-charges a plain nested loop whose impure right
  side `mutating-subquery-cache` will wrap, with the reason it is unreachable
  and what to do if a candidate that tolerates an impure inner ever appears.

## Review pointers

- The whole change is ~40 lines in `ruleJoinPhysicalSelection` plus a
  mechanical split in `ruleNestedLoopRightCache`. The split should be
  behaviour-preserving: confirm no gate was dropped, reordered, or had its
  polarity flipped, and that the `estimatedRows` value the old "Caching pure
  nested-loop right side (%s, %d rows)" log printed is not needed (the log now
  omits the count rather than walking the subtree a second time).
- Confirm `ruleJoinPhysicalSelection` cannot reach the predicate with a `right`
  or `full` join: the type guard at the top of the rule returns null for both
  long before the cost block, and `canCacheNestedLoopRight` would return false
  anyway.
- Confirm the correlated-inner early return (`readsColumnsOf`) is undisturbed —
  it still fires before any latency is computed, so the rule's own
  index-nested-loop output is never re-priced.
- The new import direction is `rules/join/` → `rules/cache/`. Check that is
  acceptable layering for this codebase (there is no cycle: the cache rule
  imports nothing from `rules/join/`).
