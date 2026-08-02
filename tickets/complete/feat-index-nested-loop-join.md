---
description: A query joining a small set of rows against a large indexed table now does one index lookup per row instead of reading the whole large table.
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # candidate construction (all gates)
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # four-way comparison + sibling-reference guard
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts    # same guard, added in review
  - packages/quereus/src/planner/cache/correlation-detector.ts              # readsColumnsOf, added in review
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                # peel/rebuild/probe helpers shared with rule-key-set-seek
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts          # refactored onto the shared helpers
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts    # selectPhysicalNode exported
  - packages/quereus/src/planner/cost/index.ts                              # indexNestedLoopJoinCost
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
  - docs/optimizer.md
difficulty: hard
---

# Index-nested-loop join — shipped

## What the feature does

A fourth physical join algorithm inside `rule-join-physical-selection`. When a
join's inner (right) side peels — through Alias / trivial Project / Filter — to
an unconstrained every-row table walk, and the table's module answers an
equality seek on the join key, the walk is replaced by an `IndexSeekNode` whose
seek keys are column references into the outer row. The logical `JoinNode` and
its nested-loop emitter survive: per outer row the emitter installs the left row
slot and re-opens the inner pipeline, so the seek re-resolves by attribute id.
The ON condition is retained as the over-fetch safety net.

Supported: INNER / LEFT / SEMI / ANTI, including `exists … as` existence joins
(a capability gain — hash/merge decline those). Declines: right/full,
side-effecting right side, pushed constraints / limit / offset on the leaf,
cross-logical-type or semantic-ordering keys, `MISMATCH_UNSAFE` collation cover,
module declining or costing the seek at/above its own scan. The module's own
`getBestAccessPlan` answers (probed twice: with the join constraints, with none)
decide selectivity; engine cost `indexNestedLoopJoinCost` uses `seekPlan.rows`.
Physical leaf construction reuses the exported `selectPhysicalNode`; anything
but an `IndexSeekNode` coming back declines the candidate.

The implementation landed across two commits: the core was swept into
`e109d7df` (whose message names an unrelated ticket), and `ac565430` added the
optimizer spec, the sqllogic file, the docs, and deleted nine debug probe
scripts the sweep had committed at the repo root. Both were reviewed as this
ticket's diff.

## Review findings

### Checked

Read the full implement-stage diff across both commits with fresh eyes before
the handoff summary: every gate in `index-nested-loop.ts` (leaf admission, the
two type gates, the constraint-extraction orientation assertion, the module
double-probe, the `selectPhysicalNode` result verification), the four-way cost
comparison and its latency handling, the `access-leaf.ts` extraction against the
`rule-key-set-seek` code it replaced, the cost formula against
`COST_CONSTANTS`, and all three touched docs against the code. Also checked the
neighbouring rules the feature's correctness argument leans on
(`rule-nested-loop-right-cache`'s uncorrelated gate, `rule-monotonic-merge-join`
as a second path to the same physical node) rather than taking the handoff's
word for them.

Validation: `yarn test` (all workspaces, quereus 8357 passing / 0 failing —
+2 over the handoff's 8355 for the two tests added below), `yarn test:store`
(8349 / 0), `yarn lint`, `yarn typecheck`, `yarn build`,
`node scripts/check-docs.mjs` — all green. No pre-existing failures surfaced.

### Found and fixed in this pass

**The correlated-side guard was over-broad, and it cost real plans.** The
implementation declined hash and merge whenever `isCorrelatedSubquery` was true
for *either* input. That predicate asks "does this subtree read anything from
outside itself" — which is a strictly wider question than the actual hazard.
The hazard is a side reading its *sibling's* columns (`JOIN LATERAL`, and the
index-nested-loop's own output): hash and merge drain one side before the
other's rows exist, so those references resolve against no row. A side that
correlates to a scope *outside* the join is safe — the enclosing driver installs
that row slot before the whole join subtree opens, so a once-per-open hash build
sees it.

Reproduced before fixing: for

```sql
select s.id, x.id from s join lateral (
  select b1.id from (select id, w, v + s.k as vk from big) b1
  join big b2 on b2.w = b1.w) x on true
```

the inner `b1 ⋈ b2` join (200 × 200 rows, both un-correlated to each other) came
out as a plain nested loop instead of a hash join, because `b1`'s projection
reads `s.k` from the enclosing LATERAL. By the rule's own cost model that is
4200 vs 240 — the guard turned a hash join into a nested loop over 40,000 pairs.

Fixed by replacing the predicate with `readsColumnsOf(reader, producer)` in
`correlation-detector.ts`, which intersects the reader's external references
with every attribute id defined anywhere in the producer's subtree, and applying
it in both directions. The narrowed guard still blocks LATERAL and still makes
the index-nested-loop rewrite idempotent (its output seeks on left-side column
refs) — both pinned by tests. The guard also moved below the equi-pair
extraction so it does no subtree walks on joins the rule would decline anyway.

**`rule-monotonic-merge-join` had the same hazard and no guard.** It produces
the same `MergeJoinNode` from the same `JoinNode` population and runs *ahead* of
`rule-join-physical-selection`, so guarding only the latter left a second path
to the same runtime failure. Added the shared guard there too. Honest caveat:
this one is defensive and **untested** — no SQL shape was found that both reads
a sibling's columns and advertises `monotonicOn` on the join key, so the gate
may be unreachable. Declining costs at most one unreachable optimization, which
is the right trade against a "No row context found" at runtime.

**Two small cleanups.** The `node.condition ? … : …` ternary in
`rebuildWithIndexNL` was dead — `extractEquiPairs` returns null for an undefined
condition, so the else branch is unreachable past the extraction check;
simplified to the non-ternary form. Test names, code comments, the sqllogic
header, and both docs files still said "correlated side"; reworded to
"sibling-reference" so the vocabulary matches what the code now checks.

### Tests added

Two cases in `test/optimizer/index-nested-loop.spec.ts` under a new
`the sibling-reference guard` block: a LATERAL join must keep the logical
`JoinNode` (no hash, no merge), and the outer-scope-correlated shape above must
still produce its hash join. The first pins the guard's necessary direction at
plan level (the sqllogic file already pins it at row level); the second is the
regression pin for the over-breadth fix.

The implementer's own coverage was otherwise sound and I added nothing to it:
plan shape on secondary-index / PK / LEFT / SEMI / ANTI / `exists … as`, rule
idempotence, seven decline paths, cost crossover in both directions, and row
equality across NULL keys, self-join, three-way spine, composite and partial
composite keys, and both collation directions.

### Tripwires recorded (not tickets)

- **Latency asymmetry biases against index-NL.** Hash and merge are charged the
  inner side's `expectedLatencyMs` once, index-NL per seek, and plain
  nested-loop not at all — yet plain NL re-opens the right side per outer row
  too, so it pays the same latency it is not charged for. With a nonzero
  `expectedLatencyMs` the plain nested loop could beat the strictly cheaper
  index-NL. Both shipped modules report 0, so nothing is wrong today. `NOTE:` at
  the comparison site in `rule-join-physical-selection.ts`, with the fix to make
  if a high-latency module appears.
- **Probe volume** — one extra pair of uncached `getBestAccessPlan` calls per
  qualifying equi-join. Already recorded by the implementer as a `NOTE:` in
  `index-nested-loop.ts`'s header; left as-is.

### Checked and found nothing

- **Seek construction and the gates.** Walked the cases that would matter:
  duplicate equi pairs on one inner column (extra constraint reattaches as a
  residual Filter, which the `IndexSeekNode` check peels, and the ON condition
  covers it regardless); a trivial Project that reorders or drops columns
  (attribute-id lookups, not positions); ANTI/LEFT with an over-fetching seek
  (the retained ON trims); NULL keys from both sides. No defect found.
- **The `access-leaf.ts` extraction is behavior-preserving** for
  `rule-key-set-seek` — the moved `peelToLeaf` / `rebuildChain` /
  `buildProbeRequest` are identical modulo the type-parameter cast that the
  wider `AccessLeafNode` type made unnecessary.
- **Docs match the code.** Verified the claims rather than trusting them: the
  cost formula against `COST_CONSTANTS` (1.0 + 0.5 + rowsPerSeek × 0.3), and
  `optimizer.md`'s claim that `rule-nested-loop-right-cache` keeps the seek out
  of a `CacheNode` against that rule's actual uncorrelated gate. Updated
  `optimizer-joins.md` and `optimizer-rules.md` for the narrowed guard.
- **Source hygiene.** `index-nested-loop.ts` is 353 lines and
  `rule-join-physical-selection.ts` 291, both comment-heavy but with small
  single-purpose functions and no dead sections — no split warranted. The nine
  root-level `.mjs` debug probes the sweep committed were already deleted.
- **No new tickets filed.** Nothing found rose to "major, needs its own
  ticket": the one substantive defect had a tight localized fix and is done, and
  the follow-ups the implementer parked in `backlog/` already cover the feature's
  known scope limits.

### Gaps accepted, not closed

Three gates ship untested, and the implementer's reasons hold up on reading:
`orderingLoadBearing` (no SQL shape reaches a join's right leaf with the flag
set — a bare derived-table `ORDER BY` is pruned first, `ORDER BY … LIMIT` blocks
the peel at the LimitOffset instead), the purity gate (a side-effecting right
side that still peels to a bare leaf gets wrapped in a `CacheNode` by
`rule-mutating-subquery-cache`, registered earlier, which fails the peel), and
the per-seek latency term (`expectedLatencyMs` is 0 for both shipped modules).
The new `rule-monotonic-merge-join` guard joins that list. These are cheap
defensive gates whose absence would be a correctness bug, so leaving them
unexercised is the right call over contriving reachability.

## Parked follow-ups (already in backlog/, prereq: this ticket)

- `feat-index-nested-loop-over-pushed-constraints` — fire even when the leaf
  already carries pushed filters.
- `feat-index-nested-loop-commute-drive-side` — teach join ordering about index
  availability; today only the right side is ever seek-rewritten.
- `feat-index-nested-loop-batched-seeks` — batch seeks per outer-row window for
  high-latency backends.
