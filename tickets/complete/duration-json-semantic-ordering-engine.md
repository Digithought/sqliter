---
description: The engine now orders duration and JSON values by what they mean (elapsed time, structural value) everywhere — sorting, comparisons, grouping, and index range scans previously disagreed with each other because some paths ordered by the raw text.
files:
  - packages/quereus/src/types/logical-type.ts                   # semanticOrdering flag + groupKey hook on LogicalType
  - packages/quereus/src/types/temporal-types.ts                 # TIMESPAN: flag, groupKey, shared timespanTotalSeconds
  - packages/quereus/src/types/json-type.ts                      # JSON: flag; collation-aware string/string compare
  - packages/quereus/src/util/comparison.ts                      # hasSemanticOrdering, semanticKeyTransform, createTypedOrderByComparator, createSemanticRowComparator
  - packages/quereus/src/runtime/emit/sort.ts                    # per-key typed ORDER BY comparators
  - packages/quereus/src/runtime/emit/window.ts                  # window ORDER BY + PARTITION BY canonicalization
  - packages/quereus/src/runtime/emit/binary.ts                  # typed comparison-operator path
  - packages/quereus/src/runtime/emit/between.ts                 # BETWEEN aligned with desugared comparisons
  - packages/quereus/src/runtime/emit/distinct.ts                # semantic row identity
  - packages/quereus/src/runtime/emit/set-operation.ts           # semantic row identity
  - packages/quereus/src/runtime/emit/hash-aggregate.ts          # GROUP BY hash-key canonicalization
  - packages/quereus/src/runtime/emit/bloom-join.ts              # hash-join key canonicalization
  - packages/quereus/src/runtime/emit/merge-join.ts              # typed merge-key comparators
  - packages/quereus/src/planner/analysis/sat-checker.ts         # typed compares in contradiction proving
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts        # range-scan bound filter mirrors tree comparators
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus-store/src/common/store-table.ts             # store declines byte-order claims; type-aware residual
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic  # coverage
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts
  - docs/types.md                                                # "Semantic ordering" section
---

# Complete: semantic ordering for TIMESPAN and JSON — engine side

## What shipped

Ruling (human decision, 2026-07-25, from `blocked/decide-duration-json-ordering-semantics`):
wherever a value of a declared TIMESPAN or JSON column is ordered or compared — ORDER BY,
`<`/`>`/`=`, BETWEEN, primary-key order and range scans, DISTINCT / GROUP BY /
set-operation identity, window ordering and partitioning, join keys — the type's
`compare` is the order. TIMESPAN ranks by elapsed time (`PT90M` < `PT2H`;
`PT1H` ≡ `PT60M`), JSON by structural deep-compare (`{"a":2}` < `{"a":10}`). Text order
is a storage detail.

Mechanism: a `semanticOrdering` flag on `LogicalType` (set only on TIMESPAN and JSON)
gates routing through `type.compare` at every ordering/identity site, via helpers in
`util/comparison.ts` (`hasSemanticOrdering`, `createTypedOrderByComparator` — ORDER BY
direction/NULLS handling stays in the wrapper, never delegated to the type —
`createSemanticRowComparator`, and `semanticKeyTransform` for hash keys). A companion
`groupKey` hook supplies a canonical hash representative for types whose stored text is
not canonical for equality (TIMESPAN → total seconds against the same fixed reference
date `compare` uses; JSON needs none). The flag — not mere presence of `compare` — gates
routing, because every builtin type declares `compare` and ANY's ignores collation;
blanket routing would have broken NOCASE ordering on untyped columns.

Wired into: Sort, window ORDER BY and PARTITION BY, comparison operators, BETWEEN,
DISTINCT, set operations, GROUP BY (hash aggregate), bloom/hash-join and merge-join keys,
memory-table primary and secondary range scans (`plan-filter.ts` now builds its bound and
prefix comparators with the same construction as the scanned tree's key comparator),
planner satisfiability proving (`sat-checker.ts`), and the persistent store's ordering
advertisements and residual filter. Documented in `docs/types.md` § "Semantic ordering".

Several follow-up tickets landed between the implement commit and this review and have
already extended the work: `1-memory-unique-semantic-compare` (UNIQUE enforcement),
`1-minmax-semantic-ordering` and `2-minmax-window-semantic-ordering` (min/max via a
`bindArgs` seam), `duration-json-semantic-ordering-store` (order-preserving store key
encoding), `bug-json-equality-not-structural` and `bug-json-pk-store-scan-order` (JSON
comparison against SQL text, IN membership via `semanticKeyTransform`).

## Review findings

**Method.** Read the implement diff (`2f2fae52`) with fresh eyes before the handoff
summary, then re-read every touched file at HEAD — the diff is two days stale and six
downstream tickets have rewritten parts of it. Probed each claimed site by executing SQL
against the engine rather than trusting the code read. Ran `yarn build`, `yarn lint`,
`yarn test` (whole monorepo) and `yarn test:store`.

### Confirmed defects — new tickets filed (major)

- **A mixed-type equi-join key drops matching rows.** `from a join b on a.d = b.s`
  (TIMESPAN column against a TEXT column) returns 0 rows while
  `from a cross join b where a.d = b.s` returns 1 — the same predicate, two answers.
  `extractEquiPairs` gates only on matching collation, never on whether the two declared
  types order values the same way, so the pair reaches `emitBloomJoin`, which serializes
  raw values into the hash key. `emitMergeJoin` is unsound for the same pair on its own
  terms: its inputs are sorted by each side's own order (typed for the TIMESPAN side
  since this change) but its advance step compares by text. `where exists (…)` and
  `left join … where … is not null` show the same 0 rows. Filed as
  `fix/mixed-type-equi-join-key-drops-semantic-matches` with the repro. The already-noted
  `USING` and AS OF tripwires are the same shape and are called out there for the same
  pass.

- **Simple `CASE` and `nullif` compare raw bytes.**
  `case d when 'PT60M' then … end` reports a miss on a `'PT1H'` row that `d = 'PT60M'`
  matches; `nullif(d, 'PT60M')` returns the value instead of NULL. Both call
  `compareSqlValues(a, b)`, which is hard-wired to storage class + BINARY and consults no
  logical type — so they also ignore a declared `collate nocase`, which is a
  pre-existing collation defect independent of this ticket. The scalar (non-aggregate)
  `min(…)`/`max(…)` in `func/builtins/scalar.ts` share the call and the defect; the
  aggregate forms were already fixed. Filed as
  `fix/case-and-nullif-ignore-collation-and-type` with repros for both the type and the
  collation halves.

### Fixed in this pass (minor)

- **Duplicated `groupKey` plumbing.** `hash-aggregate.ts`, `window.ts` and
  `bloom-join.ts` each hand-rolled the `hasSemanticOrdering(t) && t.groupKey ? … :
  undefined` canonicalizer, even though a later ticket added exactly that helper as
  `semanticKeyTransform` in `util/comparison.ts` and every other identity site already
  calls it. Routed all three through the helper.
- **Redundant `as LogicalType` casts** on `getType().logicalType` in `sort.ts`,
  `window.ts`, `distinct.ts`, `set-operation.ts` and `merge-join.ts` (the property is
  already typed; `between.ts` had dropped its cast downstream). Removed, along with the
  now-unused imports.
- **Test coverage gaps.** `15.1-semantic-ordering.sqllogic` asserted UNION dedup but not
  `EXCEPT`/`INTERSECT`, and asserted JSON *ordering* but no JSON *identity* at all — even
  though set operations, DISTINCT, GROUP BY, window PARTITION BY and join keys all route
  JSON through the same row-identity path. Added both blocks (plus a JSON `BETWEEN` case)
  and verified they actually execute by deliberately breaking an expectation and
  confirming the failure. All pass on both the memory and store backends.
- **Docs overstated coverage.** `docs/types.md` § "Semantic ordering" stated the rule
  applies to "merge/hash join keys" without qualification. Added a short subsection
  naming the two surfaces that do not follow it yet and pointing at the two tickets above.

### Checked and found sound

- The `compareWithOrderByFast` refactor into `orderByNullResult` is behavior-preserving:
  walked all six (a/b NULL) × (FIRST/LAST/DEFAULT) cases against the pre-change code,
  including the direction-conditioned default that negated itself back to the same result.
- The `compare`/`groupKey` contract on TIMESPAN holds. `compare` returns 0 only when both
  values parse to the same total seconds (same `groupKey`) or the raw texts are identical
  (same `groupKey`), so compare-equal values can never land on distinct hash keys. An
  unparseable value keeps its raw text, which serializes as TEXT and so cannot collide
  with a parsed value's numeric total.
- `plan-filter.ts` mirrors the tree's key-comparator construction for the primary tree,
  secondary indexes, the equality prefix and both early-termination arms; a downstream
  ticket further hardened it with an explicit `keyIsTuple` flag rather than sniffing
  `Array.isArray` (which a JSON array value would have defeated).
- `sat-checker.ts` collects semantic column types through the same
  `forEachColumnReference` walk `collectColumns` uses, so the two cannot drift.
- `IN` membership, `BETWEEN`, index seeks, composite and DESC primary keys, NULL
  placement, and the ANY/TEXT negative controls all behave per the ruling — verified by
  execution, not by reading.

### Nothing found in these categories

- **Resource cleanup:** the change adds no new iterators, handles or long-lived caches —
  every comparator is a closure resolved once at emit or scan setup. Nothing to leak.
- **Error handling:** the one new failure mode, an unparseable duration, is handled by an
  explicit documented fallback in both `compare` and `groupKey` rather than a swallowed
  throw. No new silent catches.
- **Performance:** all comparator resolution stayed at emit / per-scan time; no per-row
  registry lookups or allocations were introduced. `test/performance-sentinels.spec.ts`
  passes.
- **Pre-existing test failures:** none. `yarn test` and `yarn test:store` are fully green
  (7401 / 7395 passing, 0 failing), so `tickets/.pre-existing-error.md` was not written.

## Tripwires recorded (code NOTEs, indexed here)

Carried forward from the implement pass; all still accurate at HEAD:

- `runtime/emit/join.ts` (`evaluateUsingCondition`) — `USING` equality is not
  semantic-ordering-aware.
- `runtime/emit/asof-scan.ts` — AS OF match/partition compares are collation-based;
  correct for DATE/DATETIME, wrong for a TIMESPAN/JSON match column.
  (Both of the above are now also named in
  `fix/mixed-type-equi-join-key-drops-semantic-matches`, which shares their root cause.)
- `emit/recursive-cte.ts` — union dedup deliberately stays raw-BINARY `compareRows`,
  matching SQLite's collation-less recursive queue table. Untouched by design.
- `vtab/memory/layer/plan-filter.ts` and `quereus-store`'s `matchesFilters` — per-scan and
  per-row comparator construction; memoize only if a profile ever shows it.

## Open follow-ups

- `fix/mixed-type-equi-join-key-drops-semantic-matches` (filed by this review)
- `fix/case-and-nullif-ignore-collation-and-type` (filed by this review)
- `fix/upsert-conflict-target-semantic-ordering` (filed earlier, still open)
- `backlog/feat-reopen-timespan-store-seeks` — the store's ordering advertisements and
  byte-window seeks over semantic-ordering key members stay declined; now merely
  conservative, since both types' key bytes became order-faithful.
