---
description: The per-row index lookup used for joins now works together with a filter the storage module had already taken responsibility for, instead of giving up on those tables; reviewed, one shape fixed, two follow-up tickets filed.
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts             # admitSeekLeaf / offerConstraints / probeModule baseline / reapplyDeclinedPushed
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                 # peelToAccessLeaf deleted; SeekableAccessLeafNode exported
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # selectPhysicalNode / stampSeekProvenance / reattachUnconsumedConstraints (unchanged, relied on)
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts                # 'pushed-constraint (IndexSeek) inner leaves' block (+15 tests)
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic         # new final section (+10 row assertions)
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
difficulty: hard
---

# Combine a join-key seek with the filters the storage module already claimed

## What shipped

`index-nested-loop.ts` used to decline whenever the join's inner side bottomed out in an
`IndexSeekNode` — a leaf whose `FilterInfo` is the *sole* enforcer of a predicate the
module claimed (`where b.status = 'x'` with `status` indexed), because the predicate's
residual `Filter` was dropped on the module's promise. It now has two admission arms:

- **Walk arm** (`admitWalkLeaf`) — unchanged: an unconstrained every-row walk.
- **Seek arm** (`admitSeekLeaf`) — new: an `IndexSeekNode` with recorded
  `pushedConstraints`. The rule re-**offers** those constraints to the module together
  with the synthesized join-key equalities, asks for one plan over the combined set, and
  re-applies whatever the module declines as a `Filter` directly above the new seek.

```
Join(inner, s, IndexSeek(big, [status='x']))  ON big.id = s.k
  ──▶  Join(inner, s, Filter[status='x'](IndexSeek(big, keys=[s.k])))      memory & store, single indexes
  or   Join(inner, s, IndexSeek(big, keys=['x', s.k]))                      composite index (status, v)
```

### The correctness invariant

Every offered pushed constraint lands in exactly one of three places:

| module's answer for constraint *i* | who re-applies it | where |
|---|---|---|
| handled & consumed as a seek key | `selectPhysicalNode`'s `stampSeekProvenance` re-promises it on the new seek's `pushedConstraints` | seek |
| handled but not consumed | `selectPhysicalNode`'s `reattachUnconsumedConstraints` | Filter |
| not handled (`handledFilters[i] !== true`) | this rule's `reapplyDeclinedPushed` | Filter |

The review traced this and found it **exhaustive**, including the one hole it could have
had: `reattachUnconsumedConstraints` only recovers constraints whose operator is in
`RECLAIMABLE_OPS` (`=`, `IN`, the four range ops, `OR_RANGE`), so a claimed-but-unconsumed
constraint outside that set would be lost. It cannot happen here, because
`pushedConstraints` records only constraints `selectPhysicalNode` *consumed*, and every
`consumed.add(…)` site in that file consumes a constraint whose operator is already in
`RECLAIMABLE_OPS`. Row 2 of the table is in fact unreachable for the seek arm on either
shipped module (the join key wins the role a duplicate pushed constraint would need), so
the live landings are rows 1 and 3.

### Other design decisions, as shipped

- **Offer order is join keys FIRST**, so a correlated equality wins a column a pushed
  predicate also touches. `handledFilters` is positional, so every reader goes through
  `OfferedConstraints.joinKeyCount`.
- **Cost gate relaxed from `<` to `<=` on cost** (rows stays strictly `<`), both arms,
  because the memory module prices every single-key equality seek identically. Verified
  live on the store backend, where a shape declines at `seek 0.4/1 vs displaced 0.4/1` —
  the gate still bites.
- **Handled-claim check applies to join-key constraints only.** Pushed constraints need
  no claim because all three landings honour either answer.
- **`peelToAccessLeaf` deleted**; `SeekableAccessLeafNode` exported instead.

## Review findings

Read the implement diff first (`git show 427474315`), then the handoff.

### Correctness — one wrong-shape finding, fixed inline; no wrong-answer findings

- **Fixed: `reapplyDeclinedPushed` peeled only one `FilterNode`.** Its own doc comment
  promised "the seek carries one residual Filter rather than a stack", but the code did
  `rebuilt instanceof FilterNode ? rebuilt.source : rebuilt` — a single level. That stack
  is reachable: `selectPhysicalNode` can return `Filter(Filter(seek))` when a
  `COARSER_SAFE` collation residual is wrapped by `reattachUnconsumedConstraints`. The
  result was correct (nothing lost, predicates just nested) but contradicted the stated
  invariant and left a redundant node. Now peels the whole stack, outermost predicate
  first, matching the peel `rebuiltSeek` already used.
- **No wrong-answer finding.** 19 SQL shapes beyond the implementer's tests were
  cross-validated against an independently computed JS reference on the memory backend:
  `OR` range, `IN` on a non-key column, `IN` on the join column, `IS NULL`, two predicates
  on different columns, range + equality, `<>`, `LIKE`, LEFT join with the predicate in
  `WHERE` rather than `ON`, a `NOCASE` collated predicate, a three-way spine (two joins
  fired), a self-join with predicates on both sides, a duplicate equality on the join-key
  column, a range on the join-key column, a derived table whose projection drops the
  predicate's column, an aliased subquery with an inner `ORDER BY`, `SEMI` with
  `IS NOT NULL`, a composite index over a NULL-bearing column, and a `LATERAL` join. All
  returned exactly the reference rows. The probe file was temporary and is deleted; the
  one shape it found untested is now a permanent test (below).

### Test coverage — one gap, filled inline

- **Added:** the peeled-`Project` shape. `docs/optimizer-joins.md` claims the re-applied
  `Filter` goes *inside* the peeled wrapper chain "so a peeled trivial Project that
  dropped the predicate's column cannot orphan it", and nothing tested it —
  `select s.id from ps s join (select id, v from pb where status = 'x') t on t.v = s.k`
  is exactly that shape (the derived table does not select `status`). Now pinned in
  `test/optimizer/index-nested-loop.spec.ts` (asserts the `Project` sits above the
  re-applied `Filter`) and in `11.3-index-nested-loop-join.sqllogic` (rows, both backends).
- Everything else the handoff claimed to cover is genuinely covered; the removed decline
  test *"when the leaf already carries a pushed constraint"* was correctly removed (that
  shape now fires by design and is covered by the duplicate-column and BETWEEN tests).

### Gaps the handoff asked the reviewer to close — both closed, no code change

- **"Gates 4 and 5 have no end-to-end SQL shape."** Confirmed, and they should stay.
  Measured by enabling the rule's own debug channel
  (`DEBUG=quereus:optimizer:rule:index-nested-loop`) across the whole spec suite and
  across the `11.3` sqllogic file in **both** backends: the five seek-arm gate declines
  appear only in the constructed-leaf tests that were written for them, never from any
  SQL — including the `LATERAL` shape probed specifically to try to reach gate 4. They are
  defence in depth, same as the walk arm's `orderingLoadBearing` gate.
- **"Store probe of the composite shape not done."** Done. Running `11.3` under
  `QUEREUS_TEST_STORE=true` with the rule's debug channel on shows
  `candidate: seek inl_cb.status,v via inl_idx_cb` — the store consumes both the pushed
  `status` equality and the join key into one composite seek, the same as the memory
  module. The sqllogic rows for that case already passed under `yarn test:store`; this
  confirms the *plan*, not only the answer.

### Tripwires recorded (conditional; not tickets)

- **`NOTE:` at seek-arm gate 4** (`index-nested-loop.ts`): the gate reads the *recorded
  constraint's* `correlated` flag, where `rule-key-set-seek`'s equivalent gate asks whether
  the leaf *subtree* is correlated. The two agree only because `stampSeekProvenance` is the
  sole producer of `pushedConstraints` and records every constraint the seek consumed. A
  future rule that mints a correlated seek without recording a correlated constraint would
  slip past this gate.
- **`NOTE:` at `displacedPlan`** (`index-nested-loop.ts`): the seek arm's baseline reads
  `filterInfo.indexInfoOutput.estimatedRows`, which `makeFullScanFilterInfo` stored as
  `accessPlan.rows || 1000`. A module answering its own seek with `rows: 0` (without
  claiming every filter, which would have folded the access away) or omitting `rows`
  reads back as a 1000-row baseline it never stated, and the cost gate would admit a
  candidate it should decline. Unreachable on both shipped modules, which always return a
  positive seek estimate.

### Filed as tickets (major)

- `backlog/debt-seek-leaf-admission-gates-duplicated` — `index-nested-loop.ts` and
  `rule-key-set-seek.ts` each hand-maintain the same five-gate checklist for re-planning a
  constrained seek leaf, and `peelToSeekableAccessLeaf` hands the leaf to any caller with
  only a doc comment as protection. Filed at the boundary-invariant rung: the gate set
  should live next to the peel helper so a third caller cannot be written without it. The
  ticket names the one real decision (which of the two correlation checks is correct).
- `backlog/feat-index-nested-loop-offer-filter-predicates` — the handoff's "walk-arm
  Filters above the leaf are not gathered" gap, filed as the reviewer was asked to decide.
  Measured rather than asserted: with only a composite `(status, v)` index and no
  single-column `status` index, `join cb c on c.v = s.k where c.status = 'x'` plans with
  **no index seek at all**, because neither the predicate alone nor the join key alone is a
  usable prefix. The ticket flags the non-obvious hazard — a `Filter` conjunct has a fourth
  possible fate the recorded constraints do not (it is already applied where it sits), so
  the rebuilt `Filter` must be edited deliberately or the rule loses a predicate.

### Appended as an arm to an existing ticket

- `backlog/debt-access-leaf-node-positional-constructors` — the new seek-arm gate test
  *"declines a seek carrying a pushed limit"* builds its fixture by re-typing all 13
  `IndexSeekNode` constructor arguments, a ninth hand-maintained argument list and the
  first one in test code. Recorded as an arm per the existing-class rule, not a new ticket.

### Categories checked with nothing to report — with reasons

- **Resource cleanup:** nothing to find. The rule allocates no handles, opens no cursors,
  and holds no state across calls; it builds plan nodes and returns.
- **Error handling:** already right. The single throwing call (`validateAccessPlan` inside
  `probeModule`'s `ask`) is wrapped, the module and table are named in the log line, and
  the candidate declines — an engine-synthesized probe is never surfaced to the user as a
  query error. No swallowed exceptions anywhere in the diff.
- **Type safety:** no `any`, no unexplained non-null assertions (each `!` sits under a
  check or a stated "non-empty input ⇒ defined result"), and the new
  `SeekableAccessLeafNode` / `OfferedConstraints` / `AdmittedLeaf` types are what removed
  the previous ad-hoc unions.
- **Source hygiene / size:** `index-nested-loop.ts` measured at 583 lines, of which 314 are
  code (`grep -vE '^\s*(\*|/\*|//|$)'`) across 11 functions — ~28 code lines per function,
  in line with the repo's comment-dense house style. Not a size-debt finding; the file is
  not on `debt-oversized-source-files`.
- **Docs:** `docs/optimizer-joins.md` and `docs/optimizer-rules.md` were both read line by
  line against the new code and describe the shipped behaviour accurately, including the
  three landings, the offer order, the relaxed cost gate, and each seek-arm gate. No other
  doc mentions the rule's leaf admission (`check-docs.mjs` passes).
- **Pre-existing failures:** none. `tickets/.pre-existing-error.md` not written.

## Verification

All foreground, after the review's changes:

| command | result |
|---|---|
| `yarn lint` | clean |
| `yarn typecheck` | clean |
| `yarn build` | clean (run pre-change; no interface changed since) |
| `node scripts/check-docs.mjs` | "Docs OK" |
| `yarn test` | **10110 passing** in quereus, every workspace green, 0 failing |
| `yarn test:store` | **10102 passing**, 33 pending, 0 failing |

## Empirical module behaviour (both backends)

| shape | memory | store |
|---|---|---|
| `on b.id = s.k where b.status = 'x'` (status indexed) | PK seek on join key; status re-applied as Filter | same |
| `on b.v = s.k where b.status = 'x'` (v, status indexed) | idx_v seek; status Filter | same |
| `on c.v = s.k where c.status = 'x'`, indexes `(status, v)` and `(status)` | composite seek consumes both, no Filter | **same** (measured this review) |
| `on b.id = s.k where b.id > 10` | PK equality seek; range Filter | same |
| `on b.v = s.k where b.id between 2 and 9` | idx_v seek; single `BetweenNode` Filter | declines ("seek does not use the join key") |
| `on b.v = s.k where b.id = 8` (unique PK seek already) | declines (module keeps PK seek) | declines |
| `on c.v = s.k where c.status = 'x'`, index `(status, v)` ONLY | no seek at all — neither half is a usable prefix (this is `feat-index-nested-loop-offer-filter-predicates`) | not probed |
| LEFT (ON form), SEMI, ANTI with the status predicate | seek + Filter inside the inner pipeline; null-pad / drop / keep correct | same |

## Unrelated finding from the implement stage (already filed, untouched here)

`where v = (select 1)` crashes at plan time — "Literal value is a promise" — on a single
table with no join, in `rule-sargable-range-rewrite`. Filed as
`backlog/bug-constant-subquery-literal-crashes-predicate-rewrite`. Not caused by this
work and not a test failure.
