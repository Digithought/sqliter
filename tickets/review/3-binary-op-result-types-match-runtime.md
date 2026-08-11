---
description: The engine used to report the wrong data type for several two-operand expressions — comparisons written with a double equals sign, "like" and "xor" were reported as whatever their left-hand side was instead of true/false, and arithmetic mixing text with a number was reported as text even though it produces a number. Both are now fixed by making the type report and the evaluator read the same operator list.
prereq:
files:
  - packages/quereus/src/planner/analysis/binary-operator-class.ts   # NEW — the shared classification
  - packages/quereus/src/planner/nodes/scalar.ts                     # BinaryOpNode.generateType — now dispatches on it
  - packages/quereus/src/runtime/emit/binary.ts                      # buildBinaryOpSpec — now dispatches on it
  - packages/quereus/src/planner/analysis/comparison-collation.ts    # isComparisonOperator — now derived from it
  - packages/quereus/test/binary-op-static-type.spec.ts              # NEW — announced-type + value-conformance tests
  - docs/types.md                                                    # NEW § Binary operator result types
difficulty: medium
---

# What landed

`BinaryOpNode.generateType` (announced type) and `buildBinaryOpSpec` (runtime body) each
kept their own hand-written list of operator spellings. They had drifted: `generateType`'s
list was shorter and case-sensitive, and anything it missed fell through to the **left
operand's logical type**.

The fix is one shared classification, not a longer list:

```ts
// src/planner/analysis/binary-operator-class.ts
export type BinaryOperatorClass =
	'arithmetic' | 'comparison' | 'is' | 'in' | 'logical' | 'concat' | 'like';

export function classifyBinaryOperator(operator: string): BinaryOperatorClass | undefined;
```

`classifyBinaryOperator` uppercases before lookup. Three consumers now dispatch on it:

- `BinaryOpNode.generateType` — announced result type,
- `buildBinaryOpSpec` (`runtime/emit/binary.ts`) — which per-row body to build,
- `isComparisonOperator` (`analysis/comparison-collation.ts`) — whether to validate the
  collation lattice. It is now `cls === 'comparison' || cls === 'is'`, which reproduces the
  old literal set exactly (the existing assertions in
  `test/planner/comparison-collation.spec.ts` pin that and still pass).

Announced types by class: comparison / `is` / `in` / logical / like → `BOOLEAN` (`is` also
`nullable: false`, as before); concat → `TEXT`; arithmetic → temporal-operation-table
result, else numeric promotion, else `ANY`; unclassified → `ANY`.

## Measured before/after

Probe: plan the statement, read `BinaryOpNode.getType().logicalType`, evaluate, compare.

| expression | announced before | announced after | value |
|---|---|---|---|
| `'a' == 'a'` | TEXT | **BOOLEAN** | `true` |
| `1 xor 0` | REAL | **BOOLEAN** | `true` |
| `'ab' like 'a%'` | TEXT | **BOOLEAN** | `true` |
| `'a' <> 'b'` | BOOLEAN | BOOLEAN | `true` |
| `'123' + 0` | TEXT | **ANY** | `123` (number) |
| `'abc' + 0` | TEXT | **ANY** | `0` (number) |
| `('123' + 0) + 1` | TEXT | **ANY** | `124` — unchanged |
| `1 + 2` / `1 + 2.5` | REAL | REAL | unchanged |
| `date - date` | TIMESPAN | TIMESPAN | unchanged |
| `'a' \|\| 'b'` | TEXT | TEXT | unchanged |

(`<>` and `between` were already right because the parser normalizes `<>` → `!=` and
desugars BETWEEN into its own node.)

# Use cases for testing / validation

## The property the new spec asserts

`test/binary-op-static-type.spec.ts` (15 tests) does **not** just assert "operator X
announces Y". Each case asserts the announced type **and** that the produced value inhabits
it, via `conformsToType` — the same R2 predicate the statement-egress checker and the DML
write path use. Either half alone passes while the two disagree, which is exactly the bug.

Worth re-checking as a reviewer:

- **Add a new binary operator and confirm the drift can't come back.** Add a spelling to
  `CLASS_BY_OPERATOR` and confirm both the announcement and the emitter pick it up with no
  second edit. Conversely, confirm an operator absent from the map announces `ANY` and
  raises `UNSUPPORTED` on emit rather than silently announcing its left operand's type.
- **Case-insensitivity is load-bearing, not defensive.** `util/mutation-statement.ts:132`
  builds `operator: 'and'` (lowercase) and `analysis/assertion-classifier.ts:288` builds
  `operator: '<>'`. Both previously missed `generateType`'s case-sensitive switch and were
  announced as their left operand's type. Neither has a direct test of its own —
  `classifyBinaryOperator('and')` is asserted in the new spec, but a *plan-level* test that
  reaches those two synthesis sites would be stronger and does not exist.
- **`ANY` on the DML write path.** `ANY` never identity-matches a declared column type, so
  `insert into t(c) select '123' + 0 …` now always converts instead of taking the
  static-type skip. Verified only indirectly (full suite + store suite green); a direct
  test that the coercion actually runs for such a source expression would be a good add.
- **Store mode.** `yarn test:store` re-runs the logic suite on LevelDB and passes; the
  logic files listed in the original ticket (`03-expressions`, `10-distinct_datatypes`,
  `14-utilities`, `06.5.3-…`, `44.1-…`, `07.7-…`) are unchanged and pass in both modes.

## Acceptance-list verification (the widened egress check)

The original ticket's acceptance says the listed cases must stop reporting a representation
mismatch once the statement-egress check is widened. That widening is owned by
`remaining-scalar-result-types-and-repr-net`, so it is not in this diff. I measured the
same property directly instead: for each acceptance query, take `Statement.getColumnDefs()`
→ `type.logicalType`, iterate rows, and run `conformsToType` per non-null cell.

Result: **0 violations** across

```
SELECT i > 1, n <= 10.5, t == 'world' FROM expr_t WHERE i = 2
select 1 xor 0, 0 xor 0, null xor 1
select 'ab' like 'a%', 'ab' not like 'a%'
SELECT '123' + 0, 'abc' + 0, '' + 0
select json_type(j) = 'object' as r from urt
select cast('5' as integer) + 1, 'x' || 'y', 3 between 1 and 5
select ('123' + 0) + 1
select '123' + 0 as v order by v
```

The probe was a throwaway script, deleted after the run — **it is not committed**, so this
measurement is not re-runnable from the repo. A reviewer wanting it back can rebuild it
from the query list above, or wait for ticket 4's real widening to subsume it.

## Ordering risk — checked, and it is a non-issue

The original ticket flagged `order by ('123' + 0)` as a possible visible behavior change
(TEXT's comparator → `ANY`'s). It is not: `createTypedOrderByComparator`
(`util/comparison.ts:638`) only takes the type-specific path when
`hasSemanticOrdering(type)` is true — which today is TIMESPAN and JSON only. TEXT and ANY
both fall to `createOrderByComparatorFast(direction, nulls, collationFunc)`, and the
`collationName` this node propagates is unchanged (`mergePropagatedCollation` was not
touched). Same comparator before and after. The same `hasSemanticOrdering` gate governs
DISTINCT / GROUP BY / set-op dedup via `createSemanticValueComparator`, so those are
unaffected for the same reason. Measured: `order by (s + 0)` over `'10','9','100'` yields
`9, 10, 100`.

# Known gaps — please treat these as starting points

- **Nullability was not touched and has its own disagreement.** `select 1 / 0` announces
  `INTEGER`/`REAL` with `nullable: false` but returns `null` (`buildNumericOpSpec` returns
  null on a non-finite result). Out of scope here — R2 admits `null` in every position, so
  it is not a representation violation, and no check currently catches it. Not filed;
  flagging it so the reviewer can decide whether it belongs to
  `remaining-scalar-result-types-and-repr-net` or a new ticket.
- **`ANY` is a coarse answer for the arithmetic fallback.** It is the honest one given the
  runtime sniffs values per row, but if a future change makes the TEXT-operand case
  decidable at plan time (e.g. a declared "duration-shaped text" type), this arm should
  narrow rather than stay `ANY`.
- **`isComparisonOperator` still excludes `LIKE` — deliberately.** `buildLikeOpSpec`
  ignores collation entirely, so raising an ambiguous-collation error for
  `a collate nocase like b collate rtrim` would report a conflict about a collation the
  operator never applies. Recorded as a tripwire `NOTE:` at `isComparisonOperator`
  (`analysis/comparison-collation.ts`): if LIKE ever becomes collation-aware, accept the
  `'like'` class there in the same breath. Whether LIKE *should* be collation-aware is a
  separate question this ticket did not answer.
- **The unclassified-operator arm changed from "left operand's type" to `ANY`.** Nothing
  can execute such a node (the emitter raises `UNSUPPORTED`), so this is unobservable
  through SQL and is covered only by a synthetic-AST unit test in the new spec. If a
  reviewer disagrees with `ANY` there, the alternative (keep the left operand's type) is a
  one-line change.
- **No test reaches the two internal AST-synthesis sites** (`mutation-statement.ts`'s
  lowercase `'and'`, `assertion-classifier.ts`'s `'<>'`) at plan level. The classification
  is unit-tested for both spellings; the synthesis paths themselves are not.

# Validation run

| command | result |
|---|---|
| `yarn test` | pass — 9,476 quereus + all other workspaces |
| `yarn test:store` | pass — 9,468 |
| `yarn lint` | pass |
| `yarn typecheck` | pass |
| `yarn docs:check` | **fails, pre-existing** — see below |

`docs/types.md` was already 12,498 words at `HEAD` against an unratcheted 12,000-word cap,
so `yarn docs:check` failed before this ticket. The new `## Binary operator result types`
section added 354 words to an already-over-cap doc (12,852 now). Recorded in
`tickets/.pre-existing-error.md` with the measurement; splitting `types.md` into a topic
doc is a whole-document reorganization and was not attempted here. Three other docs are
flagged near-cap in the same run, so the split is worth planning as one piece of work.
