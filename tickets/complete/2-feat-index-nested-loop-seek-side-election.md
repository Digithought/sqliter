---
description: When two tables are joined, the engine now considers using an index on either of them — not just whichever the query named second — and picks the cheaper side to drive from.
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # tryIndexNestedLoop(joinType, outer, inner, equiPairs, outerRows, context) → { newInner, cost }
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # mirrored candidate, mayMirrorIndexNestedLoop, swapped-JoinNode rebuild, five-way election
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts     # NOTE only — row-count arm never fires for table-backed inputs
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts               # `seek-side election` block (14 cases)
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic        # rollup both spellings, forced nested loop, `select *` both spellings, three-way, self-join
  - docs/optimizer-joins.md, docs/optimizer-rules.md, docs/optimizer.md
---

# Elect which side of a join gets the index seek — complete

## What shipped

`rule-join-physical-selection` used to offer the index-nested-loop rewrite (replace a
full table read with one index lookup per row of the other side) only to the join's
**right** input. It now builds the candidate in **both** orientations for an inner join
and takes the cheaper.

- `tryIndexNestedLoop` takes `(joinType, outer, inner, equiPairs, outerRows, context)`
  instead of a `JoinNode`, and returns `newInner`. "Outer" means the side that drives,
  "inner" the side whose access leaf becomes the seek — whichever JoinNode slot each
  came from.
- The rule calls it twice: `(joinType, left, right, pairs, leftRows)` and — when
  `mayMirrorIndexNestedLoop(node)` — `('inner', right, left, flippedPairs, rightRows)`.
  The election is `nested-loop | hash | merge | index-nl | index-nl-mirrored`, each a
  strict `<` in that order, so an exact tie keeps the spelled orientation.
- A mirrored win is rebuilt as a new `JoinNode(scope, node.right, mirrored.newInner,
  'inner', node.condition, node.usingColumns)` — `withChildren` cannot swap slots.
- Mirror gate: inner join, no `exists … as` flags, no write in either subtree.

The ticket's reproduction now plans the seek shape in both spellings; the parent/child
rollup that used to read all 800 `entry` rows drives from the ≈10-row filtered `txn`
and seeks `entry` whichever table is named first.

## Review findings

**How this was reviewed.** The implement-stage diff (`87bd445c5`) was read first —
source, tests, docs — before the handoff summary. Every soundness claim in the code
comments and docs was re-derived from the code rather than taken on the implementer's
word, and the two claims that could only be settled empirically were measured.

### Verified (no defect found)

- **The swap does not corrupt column values.** `buildJoinAttributes` concatenates both
  sides' `Attribute` objects verbatim for an inner join, so ids survive and only order
  changes; `emitColumnReference` resolves through `resolveAttribute(rctx, attributeId,
  …)`, so the positional `columnIndex` stored on a `ColumnReferenceNode` is never read
  at emit. Confirmed end to end by a new three-way test (below).
- **No ancestor could have relied on the join's emission order.** `JoinNode.computePhysical`
  returns no `ordering`, and `computePhysicalFromChildren`'s defaults do not synthesize
  one from children — so a Sort elision above the join was never justified by it. For
  an inner join `propagateJoinMonotonicOn` is symmetric in left/right (both sides
  preserved, both attr ids emitted, `strict` is an AND), so the mirror produces the same
  `monotonicOn` set. `updateLineage` / `attributeDefaults` are keyed by attribute id and
  merge symmetrically for `inner`. FDs, equivalence classes and domain constraints are
  positional but are recomputed on the new node in its own order.
- **No swap-back loop.** `rule-join-greedy-commute` is registered in the **Structural**
  pass (order 10); physical selection runs in **PostOptimization** (order 30), so
  commute can never see, and re-swap, the mirrored node.
- **Idempotence and LATERAL.** The sibling-reference guard (`readsColumnsOf` in both
  directions) sits above every candidate construction, so the rule's own mirrored output
  — whose right side seeks on the new left's columns — declines on re-entry. Already
  pinned by the implementer's test; the guard's placement was re-read to confirm it
  covers the mirror and not only the un-mirrored path.
- **A physical join above a mirrored join is safe** because PostOptimization is
  bottom-up: the parent takes its positional `preserveAttrs` snapshot after the child
  has already swapped. Pinned by a new test rather than left to reasoning.
- **`mirrorEquiPairs` is complete.** `EquiJoinPair` carries only `leftAttrId` /
  `rightAttrId` plus two side-symmetric booleans, so the spread-and-flip loses nothing.
- **The `rule-join-greedy-commute` NOTE's claim was measured, not assumed.** A 500-row
  table joined to a 2-row table, spelled large-first, both with and without aliases:
  the rule's "Commuting join children" log never fires. The row-count arm really is
  inert for table-backed inputs, as the NOTE and `docs/optimizer-joins.md` say.

### Fixed in this pass (minor)

- **A committed sqllogic case claimed to exercise the mirror and did not.** The case
  commented "Non-aggregated projection through the exchanged sides"
  (`where t.entity_id = 2 and e.amount > 20`) plans a **hash join** on that data — the
  extra predicate on `entry` moves the estimate enough that neither orientation wins.
  Changed to `where t.entity_id = 1`, which does mirror (verified by inspecting the
  plan), and its comment no longer mentions `select *`, which it never was.
- **Result column order through the swap was untested** — the most user-visible
  consequence of exchanging the sides, and the one a reader worries about first. Added
  `select *` in both spellings to the sqllogic file, asserting the full row objects: the
  mirrored spelling still yields `entry`'s three columns then `txn`'s. (Safe because the
  star expands to explicit projections at build time; `docs/optimizer-joins.md` now says
  so, since the doc previously only ruled out a *row*-order problem.)
- **Two shapes the implementer verified in scratch but did not commit** are now pinned,
  because both are the kind of thing that regresses silently:
  - a three-way spine where the lower join mirrors and a **hash join** sits above it —
    the positional-snapshot hazard, asserting shape and rows (spec), plus a row-equality
    twin in sqllogic so it runs in store mode too;
  - a self-join that mirrors, asserting the seek lands on `primary` (the mirrored
    orientation) rather than `idx_v` (the un-mirrored one) — without that the test could
    not tell the two apart, since both sides report the same table name.
- **DRY.** The hash build/probe swap open-coded the same equi-pair flip as
  `mirrorEquiPairs`; it now calls it.

### Recorded as a tripwire, not a ticket

- **Latency accounting is asymmetric between the two orientations.** Hash and merge are
  charged the *right* side's `expectedLatencyMs` once; the mirrored index-NL charges the
  *left* side's latency per seek (the left is its inner), and nothing charges the left's
  latency to hash or merge. A high-latency left against a zero-latency right could make
  the mirror look cheaper by dodging a charge hash never paid either. Inert today — both
  shipped modules report 0. Recorded as a `NOTE:` beside the existing plain-NL exemption
  note in `rule-join-physical-selection.ts`, with the fix to make if a high-latency
  module appears (charge each candidate its own inner side's latency).

### Major findings: none

Nothing rose to a new ticket. The two limitations the implementer flagged are correctly
placed elsewhere and were not re-filed:

- the unknown-row-count collapse to 100 belongs to
  `backlog/bug-row-estimate-conflates-unknown-and-zero`, which already owns the site;
- `rule-join-greedy-commute`'s dead row-count arm is that same ticket's, and now carries
  a `NOTE:` pointing at it.

The exact-tie caveat was checked rather than accepted: at `n` rows per side an index-NL
costs `n × (1.0 + 0.5 + rowsPerSeek × 0.3)` ≥ `1.5n` against hash's `0.8n + 0.4n =
1.2n`, so an index-NL cannot win at equal cardinalities and the tie-break between the
two orientations is genuinely unobservable end to end. The committed test asserts the
reachable property instead, which is the right call.

### Validation

- `yarn workspace @quereus/quereus test`: 10096 passing, 25 pending, 0 failing
- `yarn workspace @quereus/quereus test:store`: 10088 passing, 33 pending, 0 failing
- `yarn lint`, `yarn typecheck`, `node scripts/check-docs.mjs`: clean
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.
- Zero golden-plan and (pre-existing) sqllogic churn, unchanged from the implement pass.

## Docs

`docs/optimizer-joins.md` gained "Two-table joins are not reordered here" and a
"Seek-side election" bullet under Index-Nested-Loop Join (soundness argument, gates, tie
rule, and now the `SELECT *` column-order clarification); `docs/optimizer-rules.md` and
`docs/optimizer.md` name both candidates and the election order. All three were re-read
against the code during review and match it.
