---
description: On the persistent storage backend, looking up a list of rows by their primary key reads the whole table instead of fetching just those rows — the fast path exists and works for other indexed columns, but the query planner never selects it for a primary key.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # computeBestAccessPlan — the two primary-key arms; EQ_OPS vs EQ_OR_IN_OPS
  - packages/quereus-store/src/common/store-table-scan.ts           # scanMultiSeekPrimary (~line 857) — the runtime arm, already written
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts  # the other caller: `in (select …)` collapsed to a pushed multi-seek
  - packages/quereus/src/vtab/best-access-plan.ts                   # equalitySeekKeyCount / isMultiValueEquality
  - packages/quereus-store/test/key-set-seek-store.spec.ts          # end-to-end key-set coverage against the store
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts
  - packages/quereus-store/test/pushdown.spec.ts
difficulty: medium
---

# Store: plan a primary-key multi-seek for `pk in (…)`

Promoted out of `feat-store-multiseek-coverage-gaps` (which keeps its other arm, the
duration/JSON multi-seek decline). This is the planner half only — the runtime half has
been written and correct for some time.

## What happens today

`select … from t where pk in (1, 2, 3)` full-scans a store-backed table.
`computeBestAccessPlan`'s primary-key arms match `'='` and nothing else (`EQ_OPS`;
`pinnedPkColumns` filters on `f.op === '='`), so no plan ever names a `_primary_`
multi-seek. The secondary-index arm has used `EQ_OR_IN_OPS` since
`feat-store-in-list-index-pushdown`, which is why the same query on a non-key indexed
column is fast.

The runtime arm already exists: `scanMultiSeekPrimary` (store-table-scan.ts ~line 857)
takes the decoded tuples, encodes one data key per tuple, deduplicates, sorts ascending
by encoded key, and point-reads each. Its doc comment says outright that it is unreachable
from this module's own plans and that it is what primary-key IN enablement will build on.

## Two callers, not one

This is worth more than the literal-list case suggests, because the engine funnels a
second, much more common shape into the same place:

- **Literal list** — `rule-select-access-path` emits a `plan=5` multi-seek directly.
- **`in (select …)` / semi-join** — subquery decorrelation produces a semi-join, and
  `rule-key-set-seek` rewrites the target leaf's `FilterInfo` at runtime into an ordinary
  single-column `plan=5` multi-seek, byte-identical to the literal form. The rule always
  builds the key set and always probes, so a declined seek is a *scan branch*, not a wrong
  answer — just the full table read.

So a primary-key target loses the seek in both shapes, and the store's own
`key-set-seek-store.spec.ts` covers only the secondary-index target today.

A downstream application hits exactly this: rendering one account's ledger wants the
sibling rows of N transactions fetched by key. They full-scan two tables and filter in
JavaScript (~800 ms at 36 000 rows) rather than issue the targeted read.

## What to build

In `computeBestAccessPlan`, let the primary-key arms accept a multi-value equality the way
`tryIndexAccessPlan` does — `equalitySeekKeyCount` / `isMultiValueEquality` are the shared
predicates, and a runtime-valued key set contributes its `maxCount` ceiling so every gate
judges the worst case it could be handed.

The plan must set `indexName: '_primary_'`, seek columns covering **every** primary-key
column, `isSet: false`, and claim exactly the filters the rule will consume
(`claimFirstPerRole` with equality roles over the full primary key). Carry over the two
gates the secondary-index arm already applies, for the same reasons stated there: the
`MAX_MULTI_SEEK_KEYS` cap with `inCount * INDEX_SEEK_COST` positioning cost, and the
semantic-ordering decline. `scanMultiSeekPrimary` already throws `multiSeekMalformed` on a
semantic-ordering primary-key member and on a `seekWidth` that does not cover the whole
primary key — the plan must never produce either, and those throws stay as the assertion
that it didn't.

Every decline stays cost-only: residual retained, answer right, speed-up lost.

**Ordering advertisement — advertise it.** Unlike the secondary-index multi-seek (whose
windows emit in index-key order, unrelated to any column order), `scanMultiSeekPrimary`
sorts its points ascending by encoded data key, which *is* primary-key order. Run the
result through `buildPkOrderingAdvertisement` gated on the same `pkOrderPreservingPrefix`
every other primary-key arm uses, so `… where pk in (…) order by pk` elides its `Sort`.
Assert both the elision and the row order in a test — this is the one claim in this ticket
that can produce wrong-order rows if it is wrong.

## Edge cases & interactions

- **Isolation-layer merge order** was the original reason this was held back: a
  primary-key scan is merged with the transaction's staged writes by walking two streams
  that must share a key order, and a list lookup emitting in list order broke that. It was
  filed as `bug-isolation-multiseek-merge-order` and fixed, and `scanMultiSeekPrimary`
  emits in ascending key order specifically to satisfy it. **Re-confirm under an open
  transaction** with staged puts and deletes both inside and outside the key list — a
  stale row appearing beside its updated copy, or a deleted row resurfacing, is the exact
  failure to look for.
- **Composite primary keys.** A list must pin every primary-key column; a partial pin
  keeps today's behavior. Cross-product counting for `a in (…) and b in (…)` is what the
  `MAX_MULTI_SEEK_KEYS` cap guards.
- **NULL components** drop their tuple (a NULL matches nothing in set membership) —
  already handled in `decodeMultiSeekTuples`, but assert it plans and returns correctly
  rather than throwing.
- **Duplicate and collation-equal keys** collapse to one point with each merged tuple's
  residual kept as an alternative. Assert no duplicate row is emitted.
- **Empty list / every tuple NULL** must yield zero rows, not a scan.
- **Interaction with the arm-ordering bug.** `computeBestAccessPlan` returns from the
  leading-primary-key-range arm before anything downstream runs
  (`bug-store-pk-range-preempts-cheaper-index`). Place the new arm where a full-primary-key
  list is not shadowed by a range on the leading column, and say in a comment what the
  chosen order is and why. Do not fix the general arm-competition problem here.
- **Interaction with `store-index-seek-batched-row-resolution`** (in `implement/`): that
  ticket makes `scanMultiSeekPrimary` fetch its rows in one batched read instead of one
  store transaction per key. Independent — this ticket makes the arm reachable, that one
  makes it fast — but if both land, the combined path is what the downstream ledger case
  actually needs, so it is worth measuring them together.
- **`rule-key-set-seek` gates.** That rule declines when the leaf's emission order is
  load-bearing unless the seek reproduces it (`seekPreservesTargetOrder`). Advertising
  primary-key ordering above interacts with that gate — check which branch a
  `… in (select …) order by pk` query takes and pin it with a test either way.

## Expected results

- `select … from t where pk in (…)` reads on the order of the listed keys, not the table,
  and `query_plan()` / the captured `idxStr` shows a `_primary_` multi-seek.
- `select … from t where pk in (select …)` takes the seek branch of `KeySetSemiJoin`
  against a store-backed target, matching what a secondary-index target does today.
- Row sets identical to the pre-change plan in every case, including all declines.

## TODO

- Accept multi-value equality in the primary-key arms of `computeBestAccessPlan`: seek
  columns over the full primary key, `isSet: false`, `MAX_MULTI_SEEK_KEYS` cap, positioning
  cost, semantic-ordering decline, positional filter claiming.
- Add the primary-key ordering advertisement, gated on `pkOrderPreservingPrefix`.
- Extend `packages/quereus-store/test/key-set-seek-store.spec.ts` with a primary-key
  target, mirroring its existing secondary-index cases, including the isolation-wrapped
  variant it already sets up.
- Add literal-list cases to `pushdown.spec.ts`: single-column and composite primary key,
  duplicates, NULL member, empty list, over-cap decline, `order by pk` elision.
- Add a read-your-own-writes case under an open transaction with staged puts and deletes
  inside and outside the key list.
- Update the stale ticket path in `scanMultiSeekPrimary`'s doc comment (it points at
  `tickets/backlog/feat-store-pk-in-list-multiseek`) and the "not reachable from this
  module's own plans" sentence, which this ticket makes false.
- Run `yarn test` and `yarn test:store`.
