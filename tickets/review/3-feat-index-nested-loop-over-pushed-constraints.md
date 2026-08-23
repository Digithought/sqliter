---
description: The per-row index lookup used for joins now cooperates with a filter the storage module already claimed on the looked-up table, instead of giving up; review the combined-seek arm, its gates, and the three places a re-offered predicate can land.
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts             # admitSeekLeaf / offerConstraints / probeModule baseline / reapplyDeclinedPushed — the change
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                 # peelToAccessLeaf deleted; SeekableAccessLeafNode exported
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # selectPhysicalNode / reattachUnconsumedConstraints (unchanged, relied on)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts           # sibling with the same seek-arm gates (unchanged)
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts                # 'pushed-constraint (IndexSeek) inner leaves' block (+14 tests)
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic         # new section at the end (+9 row assertions)
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
  - tickets/backlog/bug-constant-subquery-literal-crashes-predicate-rewrite.md  # unrelated pre-existing crash found while probing
difficulty: hard
---

# Combine a join-key seek with the filters the storage module already claimed

## What changed

`index-nested-loop.ts` used to decline whenever the join's inner side bottomed out in an
`IndexSeekNode` (a leaf whose `FilterInfo` is the *sole* enforcer of a predicate the
module claimed — `where b.status = 'x'` with `status` indexed). It now has two admission
arms:

- **Walk arm** (`admitWalkLeaf`) — unchanged: an unconstrained every-row walk.
- **Seek arm** (`admitSeekLeaf`) — new: an `IndexSeekNode` with recorded
  `pushedConstraints`. The rule re-**offers** those constraints to the module together with
  the synthesized join-key equalities, asks for one plan over the combined set, and
  re-applies whatever the module declines as a `Filter` directly above the new seek.

```
Join(inner, s, IndexSeek(big, [status='x']))  ON big.id = s.k
  ──▶  Join(inner, s, Filter[status='x'](IndexSeek(big, keys=[s.k])))      memory & store, single indexes
  or   Join(inner, s, IndexSeek(big, keys=['x', s.k]))                       composite index (status, id)
```

### The correctness invariant (what a reviewer should try to break)

Every offered pushed constraint lands in exactly one of three places:

| module's answer for constraint *i* | who re-applies it | where |
|---|---|---|
| handled & consumed as a seek key | `selectPhysicalNode` re-promises it on the new seek's `pushedConstraints` | seek |
| handled but not consumed (e.g. redundant same-role duplicate) | `selectPhysicalNode`'s `reattachUnconsumedConstraints` | Filter |
| **not handled** (`handledFilters[i] !== true`) | **this rule**, `reapplyDeclinedPushed` | Filter |

The third row is the one the original ticket's correctness paragraph got wrong — it
said the rest is "handed to `reattachUnconsumedConstraints`", but that function only
recovers *handled-but-unconsumed* constraints (the normal path leaves unhandled ones to
`rule-grow-retrieve`'s residual assembly). Without `reapplyDeclinedPushed`, the headline
shape silently lost `status = 'x'` on both shipped modules, since each module's per-index
plan claims only its own columns. Verify the three landings are exhaustive; that is the
whole safety argument.

### Design decisions worth a second opinion

- **Offer order is join keys FIRST** (`offerConstraints`), not the ticket's
  `[...pushed, ...joinKeys]`. Both modules and `selectPhysicalNode` pick the *first*
  role-filling constraint per column, so when a pushed predicate and a join key share a
  column (`on b.id = s.k where b.id > 10`, or two equalities on one column) the correlated
  equality is what wins the column — which is the point of the candidate. `handledFilters`
  is positional, so every reader goes through `OfferedConstraints.joinKeyCount`.
- **Cost gate relaxed from `<` to `<=`** on cost (rows stays strictly `<`), for both arms.
  The memory module prices every single-key equality seek identically (cost keyed to the
  seek-key count, not rows matched), so a pushed `status = 'x'` seek and the join-key seek
  that would replace it tie on cost (0.8 vs 0.8) and differ only in rows (≈50 vs 1). Under
  strict `<` the seek arm was dead on the memory module for its headline shape. "No dearer
  and strictly fewer rows" is still "not worse than the displaced plan" in the module's
  own currency. The walk arm cannot observe the change with either shipped module (a scan
  never prices equal to a seek), but a reviewer may want to weigh whether the arms should
  differ.
- **Handled-claim check applies to join-key constraints only.** The old check required
  every constraint on a seek column to be claimed handled. With duplicates on one column
  (`b.id > 10` + `b.id = s.k`) the memory module claims the equality and leaves the range
  unhandled, which the old check would decline; the range is instead re-applied by
  landing 3. Pushed constraints need no claim because all three landings honour either
  answer; join-key constraints still need it ("the module is promising to seek on the
  key we will emit").
- **Two "seek uses the join key" checks.** A cheap early exit in `probeModule` (some
  seek column belongs to a join key) and the load-bearing identity check after the
  rebuild (`seek.pushedConstraints` includes a join-key constraint object). The second is
  what actually proves the seek is correlated; the first just avoids a pointless
  `selectPhysicalNode` call.
- **`peelToAccessLeaf` deleted** from `access-leaf.ts` (its only caller was this rule).
  `SeekableAccessLeafNode` is exported instead; `KeySetTargetNode` in
  `key-set-semi-join-node.ts` is the same union under a different name — left alone,
  it names a different role.

## What was verified

All in the foreground: `yarn test` (10109 passing in quereus, every workspace green),
`yarn test:store` (10101 passing), `yarn lint`, `yarn typecheck`, `yarn build`,
`node scripts/check-docs.mjs`.

### Which module took which constraints (empirical, both backends)

| shape | memory | store |
|---|---|---|
| `on b.id = s.k where b.status = 'x'` (status indexed) | PK seek on join key; status re-applied as Filter (landing 3) | same |
| `on b.v = s.k where b.status = 'x'` (v, status indexed) | idx_v seek; status Filter | same |
| `on c.v = s.k where c.status = 'x'`, indexes `(status, v)` and `(status)` | composite seek consumes both, no Filter | not probed on store (see gaps) |
| `on b.id = s.k where b.id > 10` (range on the join column) | PK equality seek; range Filter | same |
| `on b.v = s.k where b.id between 2 and 9` | idx_v seek; single `BetweenNode` Filter | **declines** — store answers the combined probe with its PK range seek (no join key) → "seek does not use the join key"; hash join kept, rows correct |
| `on b.v = s.k where b.id > 5` | idx_v seek; range Filter | declines, same reason |
| `on b.v = s.k where b.id = 8` (unique PK seek already) | declines (module keeps PK seek; tie broken by index order) | declines |
| LEFT (ON form), SEMI, ANTI with the status predicate | seek + Filter inside the inner pipeline; null-pad / drop / keep correct | same |

### Tests added

`test/optimizer/index-nested-loop.spec.ts`, block *pushed-constraint (IndexSeek) inner
leaves* (14 tests): PK and secondary join keys with the status predicate re-applied
(asserts the Filter is directly above the seek and references `status`; the new seek's
`pushedConstraints` holds only the correlated join key); composite index consuming both
(no Filter, `pushedConstraints` length 2, `[correlated, uncorrelated]`); duplicate
column; BETWEEN as one `BetweenNode`; LEFT/ANTI rows; module-keeps-own-seek leaves the
literal seek untouched; idempotence on the rule's output via both the caller's sibling
guard and a direct `tryIndexNestedLoop` call (gate 4 declines the now-correlated leaf).
Each seek-arm gate is pinned with a **constructed leaf** (a real pushed seek cloned via
`withProvenance` / the constructor with one property changed), with a positive control
proving the unmodified leaf is admitted and its predicate re-applied *by identity*.

`test/logic/11.3-index-nested-loop-join.sqllogic`, new final section (9 assertions):
inner (PK and secondary), LEFT/ANTI/SEMI, duplicate column, BETWEEN, composite, and
module-keeps-own-seek — all with `order by`, all with a predicate that genuinely rejects
a row the join-key seek returns (k=5 → id 5 has status 'y'). Runs green in both memory
and store mode.

The old decline test *"when the leaf already carries a pushed constraint"* (`big.id > 5`
on memory) was removed: that shape now fires by design and is covered by the duplicate-
column and BETWEEN tests.

## Known gaps — start here

- **Gates 4 and 5 (correlated / subquery-bearing pushed constraint) have no end-to-end
  SQL shape.** A correlated predicate inside a lateral, and a subquery-valued equality,
  are both kept as a Filter *above* the join by earlier passes rather than pushed into
  the leaf, so the gates are reached only through the constructed-leaf tests. If the
  reviewer knows a shape that does push one, add it; if the gates are unreachable by
  construction, say so in the findings rather than deleting them (they are defence in
  depth, same as the walk arm's `orderingLoadBearing` gate).
- **The composite-index test depends on the memory module's tie-break.** Both
  `idx_cb(status, v)` and `idx_cb1(status)` price the pushed `status = 'x'` seek at the
  same cost; the memory module takes the first index created. The test creates the
  composite first and says so in a comment. A module that tie-breaks differently would
  turn that test into a decline (still correct rows).
- **Store probe of the composite shape not done.** The store supports prefix seeks, so
  `status = 'x'` may already seek on `(status, v)` without the single-column index; the
  combined probe should then upgrade it to a full composite seek. The sqllogic composite
  case runs under `yarn test:store` and asserts rows only, not the plan.
- **Walk-arm Filters above the leaf are not gathered.** A user predicate the module did
  *not* claim (`Filter[status='x'](IndexScan)`) is peeled through and ignored, exactly as
  before; only module-claimed (`pushedConstraints`) predicates are re-offered. Offering
  those Filter predicates too would let a composite index over `(status, v)` fire for a
  predicate the memory module could not seek on alone. Out of this ticket's scope; worth a
  `feat-` if a reviewer thinks it is cheap (it is the same `offerConstraints` path with a
  different source list, plus extraction of the Filter's conjuncts).
- **Probe-volume header NOTE updated**, no memoization added (same tripwire as before).

## Unrelated finding (filed, not fixed)

`where v = (select 1)` crashes at plan time — "Literal value is a promise" — in
`rule-sargable-range-rewrite`, on a single table with no join. Constant folding stores
a pending Promise in the `LiteralNode`; two sites (`rule-sargable-range-rewrite.ts`,
`constraint-extractor.ts`) call `getSyncLiteral` without the `instanceof Promise` guard
every other planner reader has. Filed as
`backlog/bug-constant-subquery-literal-crashes-predicate-rewrite` with the shared-helper
fix shape. Not a test failure; found while probing shapes for this ticket.
