---
description: The persistent storage backend can now answer "this account, all months before June" by reading only the matching rows instead of every row for that account; review the change.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts         # indexRangeAtPositionIsOrderSafe (new) + leading-column wrapper
  - packages/quereus-store/src/common/store-module-access-plan.ts  # tryIndexAccessPlan: the new prefixRange arm, ARM_SELECTIVITY
  - packages/quereus-store/src/common/store-table-scan.ts          # analyzeIndexAccess / buildPrefixRangeWindow / buildIndexRangeBounds
  - packages/quereus-store/test/pushdown.spec.ts                   # new "prefix-equality + trailing-range seek" describe + narrowing test
  - packages/quereus-store/README.md                               # new "Which predicate shapes become a seek" table
difficulty: medium
---

# Review: store prefix-equality + trailing-range index seeks

## What shipped

A store-backed table with an index on `(a, b)` and a predicate `a = ? and b <op> ?` used to
seek only the `a` prefix and re-filter every index entry under it. It now seeks the byte
window `prefix || bound`. Answers were already correct before the change (the residual
`Filter` was retained) — this is speed only, so **the review's job is to prove no row moved.**

The engine half (`rule-select-access-path`'s `plan=7` / `prefixRangeSeek`) and the in-memory
vtab's advertisement already existed and are unchanged. Only the store module changed, in
three places that must agree:

**Soundness gate** (`pk-key-resolution.ts`). `indexLeadingRangeIsOrderSafe` was hard-coded to
index-column position 0. It is now a thin wrapper over the new
`indexRangeAtPositionIsOrderSafe(db, columns, index, keyCollations, position)`; both decision
sites call the generalized one at the position they are actually bounding. No behavioral
change at position 0.

**Plan half** (`tryIndexAccessPlan`). The arm choice became a three-way `IndexArm`
(`'eq' | 'range' | 'prefixRange'`). `prefixRange` fires when the contiguous equality prefix is
a **strict, non-empty** prefix of the index columns, the next index column carries a bound,
and the prefix is **not** multi-valued (`isMultiSeek` false — the rule can only seek a
single-valued prefix key). It advertises `setSeekColumns([...eqCols, trailingCol])` and claims,
via the existing `claimFirstPerRole`, the prefix equality roles plus `rangeRoles(trailingCol)`.

**Scan half** (`analyzeIndexAccess`). After the equality prefix is collected it reads
`prefixLen` off the `plan=7` idxStr (never re-inferred) and builds one composite window.
`buildIndexRangeBounds` was generalized to take a fixed `prefixValues` ahead of the bounded
column plus the index's per-column direction/collation/transform arrays; the empty-prefix call
reproduces the old leading-column behavior exactly (`buildIndexPrefixBounds([])` returns
full-scan bounds, which is the old `full.gte` / `lt = undefined` start).

## Where a wrong answer would hide — the review's highest-value checks

1. **Over-claiming.** The plan drops the residual `Filter` on the strength of
   `handledFilters`. Check `claimFirstPerRole`'s roles for the `prefixRange` arm: prefix
   equalities under `EQ_OR_IN_OPS` plus the FIRST lower and FIRST upper on the trailing
   column. A second same-side bound (`b > 10 and b > 30`) must stay unclaimed.
2. **The degrade paths must WIDEN, never narrow.** Three of them exist and each falls back to
   the plain equality-prefix window (a strict superset) with `matchesFilters` still deciding:
   the trailing column's order gate failing (plan side downgrades `prefixRange` → `eq` and
   leaves the bound unclaimed; scan side returns null from `buildPrefixRangeWindow`); an
   unfaithful semantic probe cutting the prefix short (`prefixLen > eqValues.length`); an
   upper-bound byte increment overflowing to all-`0xff`. Confirm none of these can produce a
   window narrower than the prefix window — the MAX-lower / MIN-upper clamping against the
   prefix's own `[P, incr(P))` is what enforces it.
3. **The DESC swap.** Only the **bounded** column's direction drives the lower/upper swap; a
   DESC *prefix* column inverts bytes inside a prefix that stays fixed. There is a test for
   each (`ix_d on d (a asc, b desc)` and `ix_dp on dp (a desc, b asc)`), but the argument is
   worth re-deriving from `buildIndexRangeBounds`'s table.
4. **prefixLen is fail-loud, everything else is fail-soft.** A `prefixLen` outside
   `1 … index.columns.length - 1` throws `INTERNAL` via the new `malformedFilterInfo`
   (`multiSeekMalformed` now delegates to it, message text unchanged). Judge whether that
   split is right: a bad `prefixLen` is structurally impossible and would address the wrong
   columns, while every *unserveable* case degrades. A missing trailing bound constraint
   currently degrades silently rather than throwing — arguably it should be loud too, since
   the rule cannot emit `plan=7` without at least one bound.

## How to exercise it

```sql
create table t (id integer primary key, a integer, b integer) using store;
create index ix_ab on t (a, b);
-- seeks prefix||bound, reads only the in-range slice:
select id from t where a = 5 and b between 20 and 30;
-- must NOT take the arm (multi-value prefix), still correct via multi-seek + residual:
select id from t where a in (5, 6) and b >= 30;
```

`packages/quereus-store/test/pushdown.spec.ts` § "prefix-equality + trailing-range seek"
covers: plan shape (INDEXSEEK, no SEQSCAN); two-sided inclusive/exclusive and `between`;
one-sided each way; empty window; prefix confinement across groups; redundant same-side bounds
(both roles); multi-value `IN` prefix declining; DESC trailing column; DESC *prefix* column;
a three-column index bounding the third column under a two-column prefix; a memory-module
oracle comparison over six predicates; read-your-own-writes with pending inserts inside and
outside the narrowed window plus a pending delete; and a non-order-preserving trailing
collation degrading to the prefix seek with the residual intact. The counting-KV-store
narrowing proof (`prefix-range seek reads only the in-range rows, not the whole prefix group`)
is the one that would have failed before the change: 100 rows all sharing `a = 1`, and it
asserts at most 8 data-store `get`s for a 4-row answer.

## Known gaps — please treat as a floor, not a finish line

- **Only `yarn workspace @quereus/store test` was run** (1620 passing). The full `yarn test`
  and `yarn test:store` were **not** run — the run hit its token budget first. Both should be
  run before this is considered done; nothing outside `packages/quereus-store` was touched, so
  the risk is low but unmeasured.
- **No test asserts the `plan=7` idxStr itself** (only the INDEXSEEK op name and the rows).
  If the arm silently stopped firing and fell back to the prefix seek, every row assertion
  would still pass; only the counting-store test would catch it, and only for the one shape it
  covers.
- **No test for the fail-loud `prefixLen` path** — it needs a hand-built `FilterInfo`, which
  the spec has no harness for today.
- **No test for an unfaithful semantic probe on the trailing column** (a TIMESPAN/JSON `b`
  whose bound has no faithful byte position). The code path is the same widen-to-prefix one as
  the collation decline, which is covered, but the semantic arm is untested here.
- **Ordering is deliberately not advertised** for this arm (matching the existing index arms),
  so `order by b` keeps its `Sort`. Out of scope by the plan ticket.
- **Cost mis-ranking tripwire** recorded at `store-module-access-plan.ts` `ARM_SELECTIVITY`:
  a schema carrying BOTH `(a)` and `(a, b)` prices the `(a)`-only equality seek (factor 0.1)
  cheaper than the composite prefix-range seek (0.15) and picks the worse plan. Answers are
  unaffected; the ticket's guidance was explicitly to place `prefixRange` between the two
  existing factors, so this was followed and parked as a `NOTE:` with the two ways out. The
  in-memory module has the same inversion, more sharply.
- **`bug-store-pk-range-preempts-cheaper-index` untouched**, as instructed: the leading-PK
  range arm still returns before the secondary-index loop, so every new test uses a table whose
  primary key is absent from the predicate.
- **Docs:** the store README gained a "Which predicate shapes become a seek" table.
  `docs/module-authoring.md` and `docs/optimizer.md` already described the prefix-range seek
  from the engine side accurately and were left unchanged — worth a second opinion on whether
  that was the right call.
