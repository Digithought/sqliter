---
description: The engine used to report the wrong data type for several two-operand expressions — comparisons written with a double equals sign, "like" and "xor" were reported as whatever their left-hand side was instead of true/false, and arithmetic mixing text with a number was reported as text even though it produces a number. Fixed by making the type report and the evaluator read the same operator list, and the review extended that list to every other place that kept its own copy.
files:
  - packages/quereus/src/planner/analysis/binary-operator-class.ts   # NEW — the shared classification
  - packages/quereus/src/planner/nodes/scalar.ts                     # BinaryOpNode.generateType
  - packages/quereus/src/runtime/emit/binary.ts                      # buildBinaryOpSpec
  - packages/quereus/src/planner/analysis/comparison-collation.ts    # isComparisonOperator
  - packages/quereus/src/planner/building/expression.ts              # needsComparisonCoercion (review)
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts      # isScalarComparisonOperator (review)
  - packages/quereus/test/binary-op-static-type.spec.ts              # announced-type + value-conformance tests
  - docs/types-inference.md                                          # § Binary operator result types
  - docs/types.md                                                    # implementation-file index
---

# What landed

`BinaryOpNode.generateType` (the announced type) and `buildBinaryOpSpec` (the runtime body)
each kept a hand-written list of operator spellings, and they had drifted: `generateType`'s
list was shorter and case-sensitive, and anything it missed fell through to the **left
operand's logical type**.

The fix is one shared classification rather than a longer list:

```ts
// src/planner/analysis/binary-operator-class.ts
export type BinaryOperatorClass =
	'arithmetic' | 'comparison' | 'is' | 'in' | 'logical' | 'concat' | 'like';

export function classifyBinaryOperator(operator: string): BinaryOperatorClass | undefined;
```

`classifyBinaryOperator` uppercases before lookup. Five consumers now dispatch on it — the
three from the implement pass plus two the review found still carrying private copies:

| consumer | what it decides |
|---|---|
| `BinaryOpNode.generateType` (`planner/nodes/scalar.ts`) | announced result type |
| `buildBinaryOpSpec` (`runtime/emit/binary.ts`) | which per-row body to build |
| `isComparisonOperator` (`analysis/comparison-collation.ts`) | whether to validate the collation lattice (`comparison` or `is`) |
| `needsComparisonCoercion` (`building/expression.ts`) | whether to insert cross-type coercion casts (`comparison`) |
| `isScalarComparisonOperator` (`analysis/scalar-param-usage.ts`) | the object-valued parameter guard (`comparison`) |

Announced types by class: comparison / `is` / `in` / logical / like → `BOOLEAN` (`is` also
`nullable: false`, as before); concat → `TEXT`; arithmetic → temporal-operation-table result,
else numeric promotion, else `ANY`; unclassified → `ANY`.

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

`<>` and `between` were already right because the parser normalizes `<>` → `!=` and desugars
BETWEEN into its own node.

## Behavior checks that came out clean

- **Ordering / DISTINCT / GROUP BY are unaffected by the TEXT → ANY change.**
  `createTypedOrderByComparator` (`util/comparison.ts`) only takes the type-specific path when
  `hasSemanticOrdering(type)` — today TIMESPAN and JSON only. TEXT and ANY both fall to
  `createOrderByComparatorFast`, and the propagated `collationName` is unchanged. Same gate
  governs `createSemanticValueComparator` for DISTINCT / set-op dedup.
- **DML write path.** `ANY` never identity-matches a declared column type, so a write sourced
  from such an expression always converts rather than taking the static-type skip. Now covered
  by a direct test (below).

# Review findings

## Checked

- **The implement diff read first, before the handoff summary** (`git show 869ec98a`).
- **Operator-map completeness.** Enumerated every construction site of a `type: 'binary'` AST
  in the repo (parser plus 30-odd planner/schema synthesis sites, including the computed
  spellings from `flipComparison` in `predicate-normalizer.ts`, `makeComparison` in
  `rule-sargable-range-rewrite.ts` and `binExpr` in `scalar-invertibility.ts`). Every spelling
  produced is in `CLASS_BY_OPERATOR`. The parser emits no `GLOB` / `REGEXP` / `MATCH` /
  bitwise binary operator, so the map's `TODO` for bitwise is accurate.
- **`isComparisonOperator`'s set is byte-identical before and after** (`=` `==` `!=` `<>` `<`
  `<=` `>` `>=` `IS` `IS NOT`), so no collation validation was silently added or removed.
- **Whether `ANY`'s `nullable: false` announcement lets anything elide a null test.** It does
  not: `select * from (select 1/0 as v) where v is null` still returns the row (measured).
- **Docs**: `docs/types-inference.md` § Binary operator result types and the implementation
  index in `docs/types.md` — both read in full and updated where the review widened the
  consumer set. `yarn docs:check` passes (the over-cap `types.md` the implement pass reported
  was split by the runner's triage pass in `88e6e18b`, before this review).
- **Source hygiene**: `binary-operator-class.ts` 80 lines, single purpose; no file grew past
  its neighbours (`scalar.ts` 985, `binary.ts` 602, `comparison-collation.ts` 575).

## Found and fixed in this pass (minor)

- **Two more private comparison-operator lists survived the unification.**
  `COMPARISON_OPS` (`building/expression.ts:54`) and `SCALAR_COMPARISON_OPS`
  (`analysis/scalar-param-usage.ts:14`) were both exactly the new `comparison` class written
  out again — the same drift risk this ticket exists to remove, one layer over. Replaced with
  `needsComparisonCoercion` / `isScalarComparisonOperator`, each a one-line
  `classifyBinaryOperator(op) === 'comparison'`. They deliberately ask for the `comparison`
  class, not `isComparisonOperator`, which also accepts `is`.
- **A test comment stated a mechanism that does not happen.** The nested-arithmetic case
  claimed the outer `+` moved off "the temporal-fallback path"; neither TEXT nor ANY is
  `isTemporal`, so both spellings selected the same generic coercing body. Comment corrected.
- **Consumer lists in the module doc comment and in both docs files were stale** after the
  first item. Updated to name all five consumers.

## Test gaps closed (the implementer named both)

- `'ab' not like 'a%'` — `NOT LIKE` parses as unary `NOT` over a `LIKE` `BinaryOpNode`; now
  asserted to announce BOOLEAN and produce `false`.
- **`ANY` on the DML write path** — `insert into w values (1, '123' + 0)` into a `text not
  null` column now asserts the stored value is the string `'123'`, i.e. that the coercion
  actually ran rather than the static-type skip firing.

Spec is 17 tests (was 15). Each still asserts the announced type **and** that the produced
value inhabits it via `conformsToType`, which is the pairing that catches the drift.

## Major — one, and it was appended to an open ticket rather than filed fresh

- **Announced *nullability* disagrees with the runtime the same way the logical type used
  to.** `select 1/0 as v` announces `REAL`, `nullable: false` and returns `null`:
  `generateType` computes `nullable` as `left.nullable || right.nullable`, while
  `buildNumericOpSpec` returns `null` for any non-finite result. Damage is limited to an
  embedder reading `getColumnDefs()[i].type.nullable` — no wrong query result was found (see
  the null-test check above). R2 admits `null` everywhere, so ticket 4's widened egress check
  will **not** catch this class; it needs its own assertion at the same seam.

  The site-claim grep found `tickets/implement/4-remaining-scalar-result-types-and-repr-net.md`
  already owns `planner/nodes/scalar.ts` and `runtime/strict-representation.ts`, and it is the
  theme ticket for announced-vs-produced. Appended there as **arm I** with the measurement and
  a Phase-3 TODO, rather than filing a second ticket for the same seam.

## Empty categories, with reasons

- **No new `fix/` / `plan/` / `backlog/` tickets.** The one major finding resolves at a site an
  open ticket already claims, so it became an arm there per the site-claim rule. Everything
  else was small enough to fix in this pass.
- **No new tripwire `NOTE:` added.** The one genuinely conditional concern — LIKE staying out
  of `isComparisonOperator` because `buildLikeOpSpec` ignores collation — already carries a
  `NOTE:` at `isComparisonOperator` from the implement pass, with its revisit condition ("if
  LIKE ever becomes collation-aware"). Re-read and left as-is.
- **No accepted-tradeoff `NOTE:` was overridden.** The one in range
  (`buildNumericOpSpec`'s null/bigint guard microbench) is unrelated to this diff.
- **Not filed, deliberately**: the implementer's note that `ANY` is a coarse answer for the
  arithmetic fallback. It is the honest answer while the runtime sniffs per row; there is no
  work to queue until a plan-time-decidable duration-shaped text type exists. Recorded here
  only.
- **Not filed, deliberately**: no plan-level test reaches the two internal AST-synthesis sites
  (`util/mutation-statement.ts`'s lowercase `'and'`, `assertion-classifier.ts`'s `'<>'`). Both
  spellings are unit-asserted through `classifyBinaryOperator`, and the case-insensitive
  lookup is now the only path, so a plan-level test would pin the same one line twice.

# Validation

| command | result |
|---|---|
| `yarn build` | pass |
| `yarn lint` | pass |
| `yarn typecheck` | pass |
| `yarn test` | pass — 9,478 quereus + all other workspaces |
| `yarn docs:check` | pass |

`yarn test:store` was run green by the implement pass and this review's edits are confined to
planner-side operator classification, comments and tests — no store-path behavior changed, so
it was not re-run.
