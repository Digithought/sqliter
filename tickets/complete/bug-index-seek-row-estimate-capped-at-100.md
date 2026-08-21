---
description: An index read used to tell the planner "about a hundred rows" no matter how many it really returned, so the planner kept choosing it over faster alternatives. It now reports the storage backend's real number, and the backend now counts matched rows instead of lookup keys.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts   # IndexSeekNode.computePhysical — arms 1 and 3
  - packages/quereus/src/vtab/memory/module.ts                 # estimateEqualityRows + the equality arm — arm 2
  - packages/quereus/src/vtab/index-descriptor.ts              # accessPathPlan() helper
  - packages/quereus/test/optimizer/index-seek-row-estimates.spec.ts   # 11 tests (8 from implement, 3 added in review)
  - packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts        # one test rewritten, then strengthened in review
  - docs/optimizer-costing.md                                  # module selectivity + what a seek node reports
  - docs/optimizer-fd.md                                       # the canonical FD table's seek row (review)
  - docs/module-authoring.md                                   # `rows` counts matched rows, not seek keys
repro: verified
difficulty: medium
---

# An index seek advertises a constant row count — complete

## What shipped

Three independent false claims in the row-estimate path, landed together because arm 1
alone is a regression.

**Arm 1 — the seek node relays the module's estimate.** `IndexSeekNode.computePhysical`
reported `Math.min(this.source.estimatedRows || 1000, 100)` — a constant for every seek
that was not a single-row primary-key lookup. It now reports
`Number(this.filterInfo.indexInfoOutput.estimatedRows)`, the module's own `rows` for the
access plan it chose. That number is the input to join-algorithm selection, cache
admission, sort costing and aggregate cardinality above the seek. "The module supplied no
estimate" is not distinguishable at the node: `rule-select-access-path` builds the field
as `accessPlan.rows || 1000`, so a missing or zero `rows` has already collapsed to 1000.
That `|| 1000` is accepted as the sole no-answer fallback, recorded in a `NOTE:` at the
site pointing at backlog `bug-row-estimate-conflates-unknown-and-zero`.

**Arm 2 — the memory backend counts matched rows, not seek keys.** The equality arm
passed `inCardinality` (the number of seek *keys*) as its row count. New
`estimateEqualityRows` computes: unique index or the `_primary_` pseudo-index → one row
per key; otherwise, with usable statistics covering every equality column,
`1 / max(distinctCount, 1)` per column folded through the engine's `combineConjunctive`;
otherwise the shape constant `0.1` (the store's `ARM_SELECTIVITY.eq`); clamped to
`max(1, min(N, inCardinality × perKey))`. Cost still keys off `eqMatch(inCardinality)`.

**Arm 3 — a multi-key primary-key seek no longer claims at-most-one-row.** The guard was
`seekKeys.length >= pk.length`, so `where id in (1,2,3)` forced `estimatedRows: 1` and
stamped the singleton functional dependency `∅ → all columns` for a seek returning three
rows. Now `seekKeys.length === pk.length` **and** the access path's plan is not
`multiSeek`, answered by the new exported `accessPathPlan()` in `index-descriptor.ts`.

### Measured, before and after

2000 rows, `k` = 4 distinct values, `s` = 7 distinct values, both indexed, after `analyze`:

| query | rows returned | `estimatedRows` before | after |
|---|---|---|---|
| `where s = 'v1'` | 286 | 100 | 285 |
| `where k = 1` | 500 | 100 | 500 |
| `where k in (1,2)` | 1000 | 100 | 1000 |
| `where id > 1900` | 100 | 100 | 500 *(range arm is still a shape constant)* |
| `where id = 5` | 1 | 1 | 1 |
| `where id in (1,2,3)` | 3 | **1, + false singleton FD** | 3, no singleton FD |

No benchmark work counter moved: the un-analyzed 1000-row default × the 0.1 shape
constant reproduces the old flat 100 exactly.

## Review findings

Read the implement diff (`d4c5f15f1`) before the handoff summary, then checked every
consumer of the three changed claims.

### Fixed in this pass (minor)

- **A test that had stopped testing its own name.** `runtime-key-set-protocol.spec.ts` →
  *"does NOT claim ordering over a runtime-set seek column"*. The implement pass rewrote
  its assertion into `if (result.seekColumnIndexes?.length > 0) { … }`, but the 25-key
  plan the test builds no longer seeks at all, so the branch never executed — and no other
  test pinned the ordering claim *under a required ordering* (the sibling multi-seek test
  passes none). Measured the crossover: the module still pushes the set at 5 keys and
  flips to the ordered walk by 9. Added a live 5-key case that seeks and asserts
  `providesOrdering` is undefined, so the invariant is enforced again.
- **A vacuous else-branch.** *"never advertises more rows than the table holds"* was
  `if (seek) expect(2000) else expect(<the same lookup>).to.be.undefined` — the else arm
  asserted nothing. Measured: the seek *is* chosen. Made it deterministic, and switched
  the query to `k in (0, 1, 2, 3, 0)` so the clamp is load-bearing (5 keys × 500 = 2500
  without it) instead of incidentally landing on the table size.
- **Handoff gap 3 closed — `combineConjunctive` vs the ticket's `product` was untested.**
  Added a composite-equality-prefix test on an analyzed table (3 × 4 distinct values over
  1200 rows): the node reports 173 where a raw product would give 100, which is the exact
  answer here because the two columns are independent by construction. The damping and its
  deliberate over-estimate are now pinned and explained rather than argued only in prose.
- **A unique *secondary* index had no coverage.** Only the primary key (recognised by
  name) was tested; the `unique`-flag path was not. Added.
- **Handoff gap 5 closed — nothing pinned a downstream consumer.** Added a test that the
  aggregate above the seek estimates 50 rows (500 ÷ 10) where the flat 100 gave 10. That
  is the ticket's motivating symptom, asserted directly instead of transitively.
- **A doc that should have been touched and was not.** `docs/optimizer-fd.md`'s operator
  table — the file calls it canonical — lumped `IndexSeekNode` in with the scans as "pass
  child FDs/ECs through unchanged", omitting the singleton `∅ → all_cols` claim entirely.
  Arm 3 changed exactly that claim's precondition. Split the row out, stated the
  "pins every PK column exactly once" condition and the multi-seek exclusion, cross-linked
  to `optimizer-costing.md`.
- **DRY.** `PRIMARY_INDEX_NAME` was imported for the new `isUniqueIndex` while three
  `'_primary_'` string literals remained in the same file (the pseudo-index construction
  and two ordering checks). Substituted; string-identical, no behaviour change.

### Parked as tripwires (conditional — not tickets)

- `estimateEqualityRows` doc comment (`vtab/memory/module.ts`): the module prices and
  estimates the seek keys it was *offered*, but `rule-select-access-path` drops
  NULL-bearing tuples and collapses duplicates *afterwards* — so `k in (1, 1, 1)` is
  estimated as three keys and seeks one. Over-estimating is the safe direction and the
  cost model has always carried the same asymmetry; the note says where the reduction
  would belong if an exact count is ever needed.
- `estimateEqualityRows` doc comment: names the saturation crossover (roughly nine seek
  keys without per-column statistics, where `10 × 0.1N` becomes the whole table) as the
  place to look if a multi-seek with an `ORDER BY` on the seek column is slow on an
  un-analyzed table. This is the one plan move in the diff; see below.
- The implement pass's two tripwires stand unchanged: the missing seek-versus-scan veto
  (`estimateEqualityRows`) and the `|| 1000` no-answer convention
  (`IndexSeekNode.computePhysical`).

### Appended to an existing ticket, not filed fresh

- `packages/quereus/src/vtab/memory/module.ts` is **1,230 lines** (`wc -l`, 2026-08-21),
  up from 1,107 — past the ~1,000-line seam this project uses elsewhere, and absent from
  `debt-oversized-source-files`. Appended there as an arm rather than as a new ticket,
  naming the costing-versus-lifecycle seam (the store package has already made exactly
  this split) and the cross-package duplicated constant: memory's
  `EQ_SELECTIVITY_WITHOUT_STATS` is a hand-kept copy of the store's `ARM_SELECTIVITY.eq`.
  Recorded there that the two backends' *other* shape constants already disagree (memory
  prices range at 0.25 and prefix-range at 0.125 against the store's 0.3 and 0.15), so
  unifying them is a decision, not a rename.

### Checked, nothing found

- **Arm 1 cannot produce `NaN`.** `IndexInfo.estimatedRows` is a required `bigint`. All
  thirteen `new IndexSeekNode(...)` sites either receive a `FilterInfo` derived from the
  module's `accessPlan` or clone an existing one (`rule-monotonic-range-access`,
  `withProvenance`, `withChildren`); the index-nested-loop rule routes through
  `selectPhysicalNode`. No path reaches the node with an absent estimate.
- **Arm 3 does not decline a legitimate singleton.** Walked every seek-building arm: the
  legacy primary-key arm builds exactly `pk.length` keys, the index-aware equality arm
  takes its keys from `seekColumnIndexes`, and the multi-seek arm builds `tuples × width`.
  The only genuine singleton refused is the composite-multi-seek-of-one-tuple shape the
  handoff already flagged as deliberate.
- **No new empty-result folds.** `estimateEqualityRows` clamps to ≥ 1, so the
  `rows === 0` → `EmptyResultNode` fold in `selectPhysicalNode` cannot newly fire.
- **No consumer misreads the new `estimatedRows: 1` on unique seeks.**
  `guaranteesUniqueRows` reads `estimatedRows === 1` as a ≤1-row proof only for
  zero-column relations; a seek always has columns, so the kind-aware `hasSingletonFd`
  path is the one that runs.
- **The two backends really do agree.** Compared arm 2 against
  `store-module-access-plan.ts` line by line: fraction of `request.estimatedRows` rather
  than of `statistics.rowCount`, wholesale fallback when any equality column is
  uncovered, the empty-snapshot (`rowCount <= 0`) guard, and the
  `min(estimatedRows, inCount × rows)` clamp all match.
- **The new docs wording about scans holds.** Both arms that construct an `IndexScanNode`
  are the unconstrained ordered-walk fallback, so calling it a "full-relation access node"
  that inherits the catalog count is accurate.
- No `any`, no swallowed exceptions, no unclosed database in the new tests.

### Weighed and left alone

- Handoff gap 2 — a composite-key multi-seek whose cross-product reduces to one tuple is
  refused the singleton dependency. Conservative by choice, documented at the site, and it
  costs an optimization in a shape with no known caller. Agreed with as filed.
- Handoff gap 4 — the range, prefix-range and OR-range arms are still shape constants of
  the table size. Out of arm 2's scope and already stated in `docs/optimizer-costing.md`.
- Handoff gap 1 — the runtime-key-set plan move. Read the two candidate plans and agree
  with the implementer: both fetch the whole table under the module's own belief, only the
  scan avoids the sort, the store saturates the same way, `ANALYZE` resolves it, and the
  byte-for-byte runtime-set-versus-literal-`IN` parity assertion is unchanged and still
  passing. Recorded as a tripwire (above) rather than reverted or ticketed. The coverage
  hole the rewrite left behind *was* real, and is fixed above.

## Validation

All run at the reviewed tree, after the review edits.

| command | result |
|---|---|
| `yarn workspace @quereus/quereus run lint` (eslint + `tsconfig.test.json`) | clean |
| `yarn test` (every workspace) | quereus **9995 passing** (9992 before this pass, +3 new), 25 pending; **0 failing in any package**, exit 0 |
| `yarn bench:gate` | gate passed; all 4 ratio guards hold |
| `yarn docs:check` | clean |

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.

Related backlog tickets referenced but not otherwise touched:
`bug-row-estimate-conflates-unknown-and-zero`,
`debt-access-leaf-node-positional-constructors`,
`debt-store-engine-estimate-agreement-test`.
