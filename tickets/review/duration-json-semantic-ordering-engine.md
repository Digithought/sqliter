<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-25T19:20:31.925Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\duration-json-semantic-ordering-engine.review.2026-07-25T19-20-31-924Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
---
description: The engine now orders duration and JSON values by what they mean (elapsed time, structural value) everywhere — sorting, comparisons, grouping, and index range scans previously disagreed with each other because some paths ordered by the raw text.
prereq:
files:
  - packages/quereus/src/types/logical-type.ts                   # new semanticOrdering flag + groupKey hook on LogicalType
  - packages/quereus/src/types/temporal-types.ts                 # TIMESPAN: flag, groupKey, shared timespanTotalSeconds
  - packages/quereus/src/types/json-type.ts                      # JSON: flag; compare honors collation for string/string pairs
  - packages/quereus/src/util/comparison.ts                      # hasSemanticOrdering, createTypedOrderByComparator, createSemanticRowComparator
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
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts        # range-scan bound filter now mirrors tree comparators (defect 3 fix)
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus-store/src/common/store-table.ts             # store declines byte-order claims; type-aware residual
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic  # new coverage
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # expectations updated to ruling
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # expectations updated to ruling
  - docs/types.md                                                # new "Semantic ordering" section
difficulty: hard
---

# Semantic ordering for TIMESPAN and JSON — engine side (implemented)

## What was ruled and built

Ruling (human decision, 2026-07-25, from `blocked/decide-duration-json-ordering-semantics`):
**wherever a value of a declared TIMESPAN or JSON column is ordered or compared — ORDER BY,
`<`/`>`/`=`, BETWEEN, primary-key order and range scans, DISTINCT/GROUP BY/set-operation
identity, window ordering/partitioning, join keys — the type's `compare` is the order.**
TIMESPAN ranks by elapsed time (`PT90M` < `PT2H`; `PT1H` ≡ `PT60M`), JSON by structural
deep-compare (`{"a":2}` < `{"a":10}`). Text order is a storage detail.

Mechanism: a new `semanticOrdering` flag on `LogicalType` (set only on TIMESPAN and JSON)
gates routing through `type.compare` at every ordering/identity site, via three new helpers
in `util/comparison.ts` (`hasSemanticOrdering`, `createTypedOrderByComparator` — ORDER BY
direction/NULLS handling stays in the wrapper, never delegated to the type —
`createSemanticRowComparator`). A companion `groupKey` hook supplies a canonical hash
representative for types whose stored text is not canonical for equality (TIMESPAN → total
seconds against the same fixed reference date `compare` uses; JSON needs none). The flag —
not mere presence of `compare` — gates routing because EVERY builtin type declares `compare`,
and ANY's ignores collation; blanket routing would have broken NOCASE ordering on untyped
columns. Documented in docs/types.md "Semantic ordering".

## Where it is wired (each is a review point)

- **Sort** (`emit/sort.ts`) and **window ORDER BY** (`emit/window.ts`): per-key
  `createTypedOrderByComparator`. Window peer-equality already used typed comparators;
  ordering and peers now agree.
- **Comparison operators** (`emit/binary.ts`): when BOTH operands declare the same
  semantic-ordering logical type → typed compare (with `createTypedComparator`'s
  storage-class-mismatch fallback, so a probe of another storage class never falsely equals).
  Mixed pairs (typed column vs text literal) still hit the generic path whose runtime
  temporal check compares durations semantically.
- **BETWEEN** (`emit/between.ts`): per-bound comparator mirroring the operator path
  (typed when types match, else runtime temporal check) so `x BETWEEN a AND b` stays
  byte-identical to its desugared form.
- **Memory-table range scans** (defect 3 of the source ticket): the BTree was already
  typed-ordered, but `planAppliesToKey` + early-termination filtered with text compares —
  `where d > 'PT90M'` on a timespan PK returned NO rows. `plan-filter.ts` now resolves
  per-column comparators with the SAME construction as the tree's key comparator
  (`createTypedComparator(columnLogicalType, collation)`), for the primary tree, secondary
  indexes, prefix-equality, and both early-termination arms.
- **Row identity**: DISTINCT and set operations use `createSemanticRowComparator`;
  GROUP BY (hash aggregate) and window PARTITION BY canonicalize key serialization through
  `groupKey`; bloom/hash-join build+probe keys likewise (the serialized key IS the match
  there — without canonicalization `PT1H` ⋈ `PT60M` silently dropped). Merge join resolves
  typed key comparators when both sides share the semantic type (its inputs are now sorted
  by that order). Stream aggregate already used typed comparators.
- **Planner satisfiability** (`sat-checker.ts`): contradiction proving over a
  semantic-ordering column now uses the type compare — previously
  `d BETWEEN 'PT30M' AND 'PT100M'` was "proved" empty by text order and the optimizer
  emitted an EmptyResult (rows silently vanished; found by the new logic tests).
- **JSON collation nuance**: `JSON_TYPE.compare` now honors a supplied collation for
  string/string pairs, so an explicit `COLLATE NOCASE` pin on a JSON comparison keeps
  discriminating as before (`test/planner/collation-soundness.spec.ts` case 5). BINARY is
  code-point order — identical to the structural string-leaf compare — so only non-BINARY
  pins behave differently.
- **Persistent store** (`quereus-store`, landed here to keep the tree green; the sibling
  `implement/duration-json-semantic-ordering-store` ticket was updated to not redo it):
  `keyOrderMatchesCollation` declines ordering advertisements AND byte range windows for
  semantic-ordering PK/index members; byte-EQUALITY point/prefix windows are declined too
  (byte-EQ under-fetches semantic equality); the full-scan residual (`matchesFilters`)
  compares such columns through the type. Store loses those seeks/elisions until the store
  ticket lands an order-preserving key normalization.

## Validation

- New `test/logic/15.1-semantic-ordering.sqllogic`: every reproduction from the source
  ticket — PK order (elided or not), the formerly-empty range scan, `d = 'PT120M'` point
  seek hitting `PT2H`, BETWEEN, DESC, DISTINCT/GROUP BY/UNION/window-partition collapse of
  `PT1H`/`PT60M`, equi-join across spellings, untyped text staying 2-row/text-ordered, ANY
  column staying text-ordered, JSON structural ordering + type-rank + key-order-insensitive
  equality.
- Updated `107-temporal-arithmetic-mutation-kills.sqllogic` (asserted the old lexicographic
  ORDER BY) and `any-json-pk-binary-key.spec.ts` (asserted the old byte-order advertisement;
  added a store timespan range-scan test).
- `yarn build`, `yarn lint`, root `yarn test` (all packages), and `yarn test:store` all green.

## Known gaps / follow-ups (real tickets, not tripwires)

- **`min`/`max` still rank by text** for TIMESPAN (`min('PT2H','PT90M')` → `'PT2H'`): step
  functions carry no type context. Filed as `fix/minmax-semantic-ordering` (prereq: this);
  the 107 logic test documents the gap inline.
- **Store key identity**: the store still accepts `PT1H` and `PT60M` as distinct PK rows
  (memory collapses them), and the engine's PK-uniqueness inference can therefore assume
  ≤1 row where a store table holds two semantic-equal spellings. Remaining scope of
  `implement/duration-json-semantic-ordering-store` (key normalization via `groupKey`).

## Review findings

(To be filled by the review pass.)

## Tripwires recorded (code NOTEs, indexed here per workflow)

- `func/builtins/aggregate.ts` (min): NOTE explaining the type-context gap — now also a
  filed fix ticket, see above.
- `runtime/emit/join.ts` (`evaluateUsingCondition`): USING equality is not
  semantic-ordering-aware; fine while USING on such columns stays unused — resolve
  per-column comparators like merge join if it shows up.
- `runtime/emit/asof-scan.ts`: AS OF match/partition compares are collation-based — correct
  for DATE/DATETIME (canonical text order IS semantic order); a TIMESPAN/JSON match column
  would need typed comparators.
- `emit/recursive-cte.ts` union dedup deliberately stays raw-BINARY `compareRows`
  (matches SQLite's collation-less recursive queue table) — untouched by design.
- `vtab/memory/layer/plan-filter.ts` + `store-table.ts` `matchesFilters`: per-scan/per-row
  comparator construction notes (memoize if a profile ever shows it).
