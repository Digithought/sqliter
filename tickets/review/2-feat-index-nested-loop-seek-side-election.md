---
description: When two tables are joined, the engine now considers using an index on either of them — not just whichever the query named second — and picks the cheaper side to drive from.
prereq:
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # tryIndexNestedLoop(joinType, outer, inner, equiPairs, outerRows, context); returns { newInner, cost }
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # mirrored candidate, mayMirrorIndexNestedLoop, swapped-JoinNode rebuild, five-way election
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts     # NOTE only — row-count arm never fires for table-backed inputs (not fixed here)
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts               # new `seek-side election` block (12 cases)
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic        # rollup in both spellings + forced nested loop + both-sides-indexed rows
  - docs/optimizer-joins.md                                                 # "Two-table joins are not reordered here" + Index-Nested-Loop § seek-side election
  - docs/optimizer-rules.md                                                 # ruleJoinPhysicalSelection entry
  - docs/optimizer.md                                                       # one-line join planning summary + rule-family table
difficulty: hard
---

# Elect which side of a join gets the index seek — implemented

## What changed

`rule-join-physical-selection` used to offer the index-nested-loop rewrite (replace a
full table read with one index lookup per row of the other side) only to the join's
**right** input. It now builds the candidate in **both** orientations for an inner join
and takes the cheaper:

- `tryIndexNestedLoop` (`index-nested-loop.ts`) takes `(joinType, outer, inner, equiPairs,
  outerRows, context)` instead of a `JoinNode`; every former `node.right` read is `inner`
  (including the side-effect gate and `expectedLatencyMs`), every `node.left` is `outer`.
  The returned subtree is `newInner`. No behaviour change from the refactor alone — the
  pre-existing 24 spec cases passed before the mirror was added.
- `ruleJoinPhysicalSelection` calls it twice: `(joinType, left, right, pairs, leftRows)`
  and — when `mayMirrorIndexNestedLoop(node)` — `('inner', right, left, flippedPairs,
  rightRows)`. The election is now `nested-loop | hash | merge | index-nl |
  index-nl-mirrored`, each a strict `<` in that order; the debug log line names both
  index-NL costs (`index-nl=…, index-nl-mirrored=…`).
- A mirrored win is rebuilt as `new JoinNode(scope, node.right, mirrored.newInner,
  'inner', node.condition, node.usingColumns)` — `withChildren` cannot swap slots. No
  `existence` (gated out).
- Mirror gate: `joinType === 'inner'` && no `exists … as` flags && no write in either
  subtree (same refusal the hash build/probe swap makes).

## Measured: the ticket's reproduction now plans the seek shape in both spellings

Memory module, 2,000 `txn` / 4,000 `entry` rows, 200 entities, `analyze` run (scratch
run, not committed):

```
select e.txn_id, sum(e.amount) from entry e join txn t on t.id = e.txn_id
 where t.entity_id = 7 group by e.txn_id
```

before: hash join reading all 4,000 `entry` rows. After, both spellings plan identically:

```
HashAggregate
└─ Join (inner)
   ├─ Alias t → Filter[entity_id = 7] → IndexScan txn USING _primary_   (≈10 rows)
   └─ Alias e → IndexSeek entry USING entry_txn                          (≈2 rows/seek)
```

Both spellings return identical rows (10 groups). The same shape is pinned at 400/800
rows in the spec (`drives from the filtered parent and seeks the child whichever table is
named first`) and at 24/34 rows in the sqllogic file.

## Tests (floor, not ceiling)

`test/optimizer/index-nested-loop.spec.ts` → `seek-side election (the mirrored candidate)`:

- headline pin: rollup in both spellings → JoinNode left = `txn`, right seeks `entry`, no
  hash join; same rows in both spellings
- both sides indexed (`pa` 4 rows / `pb` 200 rows, both with an index on `k`): small side
  drives in either spelling; same spelling with the cardinalities reversed **flips** the
  orientation (the decision follows the data, not the spelling)
- mirrored output: `joinType === 'inner'`, attributes are exactly `left.attrs ++
  right.attrs` in the new order, rows correct
- idempotence of the mirrored output (rule returns `null` with a null context — the
  sibling-reference guard fires before the context is touched)
- never mirrors: LEFT join, SEMI/ANTI (EXISTS / NOT EXISTS), `exists … as`, a write on
  either side (`insert … returning` as a FROM-position derived table) — each with a
  positive control showing the inner spelling **does** mirror, and the sharp assertion
  "no IndexSeek into `big` anywhere" (the only seek that could appear is the mirrored one)
- un-analyzed PK–PK join keeps the spelled orientation (see the tie caveat below)

`test/logic/11.3-index-nested-loop-join.sqllogic` (runs in memory **and** store mode):
rollup in both spellings + the same query with `t.id = e.txn_id + 0` (no bare-column equi
pair ⇒ no hash/merge/seek candidate ⇒ plain nested loop) all asserting the same literal
rows with `order by`; a non-aggregated projection through the exchanged sides (column
identity by attribute id); large-table-first both-sides-indexed join rows.

Scratch-verified but **not** committed as tests (reviewer may want to pin them):
self-join `from big a join big b on a.v = b.id where b.w = 3` mirrors (seeks `a` driven
by filtered `b`) with distinct leaf instances and correct rows; three-way left-deep spine
`big b join s on b.v = s.k join t2 on t2.s_id = s.id` mirrors the lower join, the upper
join sees the swapped attribute order and returns correct rows, and adding `order by …
limit 2` leaves `rule-monotonic-limit-pushdown` untouched (LimitOffset over Sort over
Project over Join does not peel to a leaf).

## Validation run

- `yarn workspace @quereus/quereus test`: 10094 passing, 25 pending (pre-existing skips), 0 failing
- `yarn workspace @quereus/quereus test:store`: 10086 passing, 33 pending, 0 failing
- `yarn test` (root, all workspaces): all green
- `yarn lint`, `yarn typecheck`, `yarn build`, `node scripts/check-docs.mjs`: clean
- **Zero golden-plan churn and zero sqllogic churn.** The committed golden corpus never
  runs `ANALYZE` and has no secondary index on a join column, and no existing sqllogic
  case happened to depend on drive order. The ticket anticipated churn; none surfaced.
  That is evidence the mirror is conservative, not proof the corpus covers it — the new
  cases above are what cover it.

## Known gaps / judgment calls for the reviewer

- **The exact-tie test is weaker than the ticket asked for.** Under the cost constants an
  index-NL candidate can never win at equal cardinalities: at `n` rows each side it costs
  ≥ `1.5n` while hash costs `1.2n` (and merge less when both walks are ordered). Any tie
  between the two orientations implies equal outer row counts and equal rows-per-seek,
  so the winner is always hash/merge and the tie-break in the election is unobservable
  end to end. The committed test asserts the reachable property (un-analyzed PK–PK join:
  no seek in either direction, physical join's left is the first-named table — it comes
  out as a merge join, not the hash join the ticket guessed) and the comment states the
  proof. The tie-break itself is the fixed strict-`<` order in code. If a reviewer wants
  it pinned directly, a `MemoryTableModule` subclass overriding `getBestAccessPlan`
  cannot do it either (the bound is in the engine's formula, not the module's answer);
  it would need `indexNestedLoopJoinCost` itself stubbed.
- **Mirror cost uses `rightRows` from `physicalSourceRows(...) || 100`**, the same
  unknown-collapses-to-100 rule the un-mirrored side already used. Not changed here
  (belongs to `backlog/bug-row-estimate-conflates-unknown-and-zero`). Consequence: on two
  un-analyzed tables neither orientation fires, exactly as before.
- **Latency accounting asymmetry is unchanged.** Hash/merge are charged the *right*
  side's `expectedLatencyMs` once; the mirrored index-NL charges the *left* side's
  latency per seek (it is the new inner). With a high-latency left and a zero-latency
  right, the mirror can look cheaper than hash by avoiding a charge hash never paid for
  the left either. Both shipped modules report 0, so inert today; the existing `NOTE:` in
  the rule about plain-NL's exemption is the place this would be revisited.
- **`rule-join-greedy-commute` is not fixed**, per the ticket. A `NOTE:` at its row-count
  arm points to the backlog bug and to this election as the two-table remedy; the docs no
  longer imply the commute puts the smaller input on the left for table-backed inputs.
- **Self-join coverage.** `rebuildChain(inner, leaf, rebuiltLeaf)` replaces by node
  identity; the two sides of a self-join are distinct `TableReferenceNode`/scan instances
  (verified by the scratch plan above: the driving side keeps its `IndexScan`, the driven
  side gets the `IndexSeek`). Not pinned as a spec case.
- The mirrored candidate runs two extra `getBestAccessPlan` probes per qualifying inner
  equi-join (the existing uncached-probe `NOTE:` in `index-nested-loop.ts` already covers
  the memoization tripwire; the count doubled, the condition did not change).

## Docs updated

- `docs/optimizer-joins.md`: new subsection "Two-table joins are not reordered here"
  (QuickPick declines < 3 relations; greedy-commute's row-count arm reads the logical
  getter and never fires for table-backed inputs) and a "Seek-side election" bullet in
  § Index-Nested-Loop Join with the soundness argument (attribute ids survive, only order
  changes; `JoinNode.computePhysical` advertises no `ordering`; emitted row order for
  `ORDER BY`-less queries may change), the gates, and the tie rule.
- `docs/optimizer-rules.md`: `ruleJoinPhysicalSelection` entry names both candidates
  (`index-nl` / `index-nl-mirrored`) and the election order.
- `docs/optimizer.md`: join-planning summary and the rule-family table mention the
  seek-side swap.
- No doc repeated the parent ticket's "neither arm alone rescues this shape" claim; the
  sibling `implement/feat-index-nested-loop-over-pushed-constraints` already frames itself
  as a separate win and builds on the new `(outer, inner)` signature.
