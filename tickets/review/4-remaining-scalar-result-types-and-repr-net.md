---
description: The data type the engine reports for each result column now agrees with the kind of value the column actually produces, across literals, arithmetic, CASE, VALUES, aggregates, window defaults, parameters, JSON table functions and pragmas; the permanent egress check stayed narrow because one already-tracked wrong-value bug still blocks it.
files:
  - packages/quereus/src/common/type-inference.ts             # value⇒type mapping now split on isSafeInteger; dead getLiteralSqlType deleted
  - packages/quereus/src/planner/nodes/scalar.ts              # LiteralNode, BinaryOpNode promotion + nullability, UnaryOp, CASE merge
  - packages/quereus/src/planner/nodes/values-node.ts         # VALUES column type merged across ALL rows
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts # now reused by CASE/VALUES/coalesce/LAG-LEAD; NOTE re non-singleton types
  - packages/quereus/src/types/comparison-coercion.ts         # numeric-vs-text: INTEGER side now targets NUMERIC
  - packages/quereus/src/func/builtins/aggregate.ts           # sum() → NUMERIC_RETURN
  - packages/quereus/src/func/builtins/scalar.ts              # findCommonType rewritten as the set-op fold; extremumReturnType deleted
  - packages/quereus/src/func/builtins/builtin-window-functions.ts # LAG/LEAD fold the default arg's type
  - packages/quereus/src/func/builtins/json-tvf.ts            # json_each/json_tree key/value/atom → ANY
  - packages/quereus/src/planner/nodes/pragma.ts              # pragma `value` column → ANY
  - packages/quereus/src/planner/scopes/param.ts              # untyped ? → ANY (was TEXT)
  - packages/quereus/src/core/statement.ts                    # egress seam comment rewritten; still R1-only (gated)
  - packages/quereus/test/announced-result-types.spec.ts      # NEW — 22 pins, one per reconciled shape
  - docs/types.md                                             # § Physical representation / Enforcement updated
---

# What was done

Every result column's ANNOUNCED type (`Statement.getColumnDefs()` / `getColumnType()`) now
names a value space its values actually inhabit. Measured by temporarily widening the
statement-egress representation check (`Statement._iterateWithSignal`) from R1-only to full
R2 and running the whole suite under `QUEREUS_REPR_STRICT=1 … --no-bail`:

- **Before this ticket** (prereqs landed, at `18e0ad94`): 25 violations.
- **After**: 2 violations — both instances of the one wrong-VALUE bug this ticket was
  forbidden to paper over (below). Every other test passes under the widened check.

The widening itself was then REVERTED (arm H, gated — see "Not done"), so the committed
egress check is still R1-only. `test/announced-result-types.spec.ts` (new, 22 tests) pins
each reconciled shape as a plain type assertion so regressions fail without the strict flag.

## Per-arm outcomes

- **A (literals)** — `LiteralNode.getType` now routes through the one shared mapping
  `inferLogicalTypeFromValue`; its divergent copy is deleted. Integral `number` ⇒ INTEGER.
  Two refinements found on the way: the split is `Number.isSafeInteger`, not `isInteger`
  (`1e308` is an integral double that only inhabits REAL's space), and a Promise-valued
  folded literal announces ANY (it used to fall into the object arm and announce JSON).
- **Arithmetic promotion** (forced by A) — INTEGER/INTEGER `/` announces NUMERIC (real
  division on the number path: `1/2` is `0.5`); any NUMERIC operand ⇒ NUMERIC; **mixed
  INTEGER/REAL ⇒ NUMERIC** (verified live: `int_col + real_col` over
  `(9007199254740993, 2.0)` returns a bigint, which REAL cannot claim); REAL/REAL stays
  REAL; INTEGER `+ - * %` stays INTEGER.
- **B (sum)** — `sum()` announces NUMERIC, deliberately NOT narrowed by argument type: the
  exact/approx accumulator split routes per VALUE, so a REAL column of safe integers can
  finalize a bigint. `avg()`/`total()` audited — they always return a `number`, REAL stands.
- **C (CASE)** — the "arms differ ⇒ TEXT" rule replaced by a fold of
  `mergeSetOpAdvertisedType` across all THEN arms + ELSE.
- **D (LAG/LEAD)** — the default argument's type now folds into the announced type via the
  same merge (TEXT value ∪ INTEGER default ⇒ ANY).
- **E (parameters)** — `DEFAULT_PARAMETER_TYPE` is ANY (was TEXT). Landed last, after
  re-measuring; it cleared 8 of the measured violations with no coercion/collation fallout
  in the suite.
- **F (TVFs)** — `json_each`/`json_tree` declare `key`, `value` AND `atom` as ANY (the
  walkers emit raw JSON scalars; `value` was the 44.1 boolean violation). Pragma's `value`
  column is ANY for the same reason (booleans for on/off options).
- **G (residue)** — all traced: the key-propagation `column_0` was a parameter inside
  VALUES (arm E); 22-boundary's was a parameter (E); 44.1's was the pragma column.

## Same-theme fixes the measurement forced (reviewer: scrutinize these — they change results)

- **`findCommonType` (coalesce/iif/choose/greatest/least) rewritten as the set-op fold**;
  `extremumReturnType` deleted (the fold is semantically identical for its cases). Mixed
  categories now announce ANY instead of the first argument's type.
- **`ValuesNode` column types merge across ALL rows** (was: first row only —
  `VALUES (1), (1.5)` announced INTEGER).
- **Unary `- +` over a non-numeric, non-TIMESPAN operand announces ANY, nullable** (was:
  operand's type — `select -'42'` announced TEXT and produced -42).
- **Numeric-vs-text comparison coercion: an INTEGER side now targets NUMERIC**
  (`types/comparison-coercion.ts`). This is a *behavior* change, not only metadata:
  `INTEGER_TYPE.parse` reads a leading digit prefix (`'1e3'` → 1, `'1.9'` → 1), so
  `1000 = '1e3'` was false and `int_col = '1.9'` was TRUE for `int_col = 1`. NUMERIC parses
  the full spelling. `test/logic/03.6.1-…sqllogic` updated in three places accordingly
  (`i = '1.9'` → false, `i in ('1.9')` → false, `nullif(i, '1.9')` → 1) — the file's own
  contract ("every form agrees") is preserved; the truncating answers were the defect.
- **Arithmetic nullability (arm I, first slice)** — `BinaryOpNode` announces nullable
  except `+ - *` over two INTEGERs (the only shape with no non-finite→null path). The
  carve-out is REQUIRED: the lens prover uses expression nullability to prove computed
  `v + 1` NOT NULL columns (`test/logic/55-lens-prover.sqllogic`). The INTEGER check is by
  NAME, not identity — an identity check broke store-mode MV rename propagation
  (53.2 sqllogic; a persistence-round-tripped schema held a non-singleton LogicalType).
  A tripwire NOTE about that non-singleton observation is at the identity compares in
  `set-op-type-merge.ts`.

## Not done — say-so items

- **Arm H (the R2 net) is NOT installed.** Gated exactly as the ticket predicted:
  `backlog/bug-text-coercion-in-arithmetic-and-aggregates` (still in backlog) makes
  `min(text_col)` return a *number* under a correct TEXT announcement — two suite sites
  (`14-utilities.sqllogic` `min(amount)`, `25-aggregate-edge-cases.sqllogic` `mn`). The
  egress seam comment in `statement.ts` now states the exact widening recipe and that the
  rest of the suite already passes under it; the backlog ticket's body was updated to say
  it is the LAST blocker. `NO_DECLARED_TYPES` therefore still exists.
- **Arm I's assertion is NOT installed.** Measured: asserting "announced non-nullable ⇒ no
  null cell" at egress finds ~28 violations across several classes beyond arithmetic
  (builtins whose `inferReturnType` hard-codes `nullable: false` while nulling on null
  input, outer-join columns not widened, empty scalar subqueries). Filed with the class
  breakdown and re-measurement recipe as
  `backlog/debt-announced-nullability-disagrees-with-produced-nulls`. Only the arithmetic
  slice was fixed here (it was arm I's measured case, `select 1/0`).

# Validation run (all green)

```
yarn build && yarn lint && yarn typecheck
yarn test           # full workspace
yarn test:store     # 9492 passing, 0 failing
yarn test:repr-strict  # 9509 passing, 0 failing
```

Golden plans regenerated (`UPDATE_PLANS=true`, 6 files — literal `REAL`→`INTEGER` and
promotion shifts only). Test-expectation updates a reviewer should re-derive rather than
trust: `binary-op-static-type.spec.ts` (mixed promotion → NUMERIC),
`comparison-group-coercion.spec.ts` (hoisted probe cast → NUMERIC),
`constraint-extractor.spec.ts` (a literal's no-op cast target is now 'INTEGER'),
`window-function-types.spec.ts` (LAG differing-type default → ANY),
`correlated-predicate-scope.spec.ts` / `subquery-decorrelation.spec.ts`
(`cast(… as numeric)` in plan text), `mv-custom-collation-maintenance.spec.ts` (backing
column for `sum()` declared `numeric`).

# Review suggestions

- The measurement command (from the original ticket) reproduces the whole audit; re-run it
  with the seam temporarily widened to confirm only the two gated min/max sites remain.
- The NUMERIC comparison-coercion change is the highest-blast-radius edit: check index
  seek/constraint extraction over `int_col = '5'`-shaped predicates still extracts (the
  converting cast lands on the text side, as before), and that no consumer keys off
  `physicalType` of NUMERIC (see the pre-existing NOTE on `NUMERIC_TYPE`).
- `create … maintained as select …, sum(v) …` now requires the declared column to be
  `numeric` (declaring `real` errors with a shape mismatch). User-facing DDL strictness
  change — worth a deliberate yes/no.
