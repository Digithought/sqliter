---
description: A query that combines whole numbers and decimals with UNION used to write the whole numbers into a decimal column without converting them, storing them in the wrong internal form (and failing outright if that column was the table's key); the combined column now advertises a type that honestly covers both forms, so the conversion happens.
files:
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts     # rule 3 changed — the whole fix
  - packages/quereus/src/planner/nodes/set-operation-node.ts       # resolveDataColumns doc comment refreshed
  - packages/quereus/test/planner/set-op-type-merge.spec.ts        # 4 assertions re-pinned to NUMERIC
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic  # new SQL regression block (end of file)
  - docs/types.md                                                  # § "A set operation is a conversion site", rule 3
difficulty: medium
---

# Set-op numeric merge now advertises NUMERIC, not REAL

## What changed

One behavioral edit, in `mergeSetOpColumnType` rule 3
(`src/planner/analysis/set-op-type-merge.ts`): a set operation whose two branches
have *differing* builtin numeric types now advertises `NUMERIC` for that output
column, instead of promoting `INTEGER ∪ REAL` to `REAL`.

Why that fixes the bug: the merge converts neither branch — it passes both
through untouched — so a mixed stream really does carry both JavaScript forms
(`bigint` from the whole-number arm, `number` from the decimal arm). `REAL`'s
value space is `number` only, so the old claim was false, and
`buildRowCoercion` (`src/types/validation.ts`) believed it: seeing the producing
expression's type identical to a `real`-declared column's, it skipped conversion
as redundant and the `bigint` was stored raw. `NUMERIC`'s value space is
`number | bigint`, so the claim is now true, `NUMERIC !== REAL` at the DML, and
the cell converts like any other.

The rest of the diff is comments, doc, and tests — no other code path was
touched. Notably the **read side is untouched**: nothing casts, so
`select <big whole number> union all select 2.5` still returns each row in its
own storage class (matching SQLite). The rejected alternative — CAST the INTEGER
branch, mirroring rule 4 — would have silently rounded that SELECT.

## Use cases to exercise

All of these are covered by the new block at the end of
`test/logic/28.2-set-op-branch-types.sqllogic` (lines ~137-197), but they are the
things worth poking at by hand:

```sql
create table t (id integer primary key, v real);

-- Direct-insert baseline: 2^53+1 rounds down to 2^53 in the REAL form.
insert into t values (1, 9007199254740993);
select cast(v as text) from t;              --> '9007199254740992'

-- Through a set operation, either arm order: must match the baseline.
delete from t;
insert into t (id, v) select 1, 9007199254740993 union all select 2, 2.5;
select cast(v as text) from t order by id;  --> '9007199254740992', '2.5'
-- (was '9007199254740993' before the fix — raw bigint)

-- REAL-declared KEY: used to throw "Cannot convert a BigInt value to a number"
-- out of REAL_TYPE.compare; now completes and the rows read back.
create table k (v real primary key);
insert into k (v) select 9007199254740993 union all select 2.5;

-- NUMERIC-declared KEY: conversion is legitimately skipped (NUMERIC holds both
-- forms), so the bigint reaches NUMERIC_TYPE.compare — which the prereq ticket
-- numeric-comparator-rejects-bigint taught to handle it. Value stored intact.
create table nk (v numeric primary key);
insert into nk (v) select 9007199254740993 union all select 2.5;
select cast(v as text) from nk order by v;  --> '2.5', '9007199254740993'

-- Read path unchanged: no rounding on the way out.
select cast(v as text) from (select 9007199254740993 as v union all select 2.5) as s;
                                            --> '9007199254740993', '2.5'

-- Must keep working: still numeric, never CASE's "arms differ ⇒ TEXT".
select 1 as v union all select 2.5;         --> 1, 2.5
```

### Testing gotcha (cost a prior agent time — reconfirmed here)

The logic-test harness normalizes BigInt to Number before comparing rows
(`normalizeBigInts` in `test/logic.spec.ts`), so a bare
`→ [{"v":9007199254740993}]` assertion **cannot** tell the broken value from the
fixed one. `typeof(v)` cannot either (`getSqlDataTypeName` reports `'integer'`
for both a `bigint` and an integral `number`). Only `cast(v as text)` and the
`real primary key` throw discriminate. Every new stored-value assertion uses
`cast(v as text)` for that reason.

## Validation performed

- `yarn test` from repo root: **0 failing** across all workspaces (quereus:
  7458 passing; the other packages green too). Log kept at `/tmp/qtest.log`
  during the run.
- `yarn lint` from repo root: clean (eslint + `tsc -p tsconfig.test.json` for
  `packages/quereus`; no-op elsewhere).
- **Discrimination check**: temporarily reverted rule 3 to the old
  `INTEGER ∪ REAL → REAL` expression in-place and re-ran the 28.2 file — it
  fails at line 163 with `Actual: {"t":"9007199254740993"} / Expected:
  {"t":"9007199254740992"}`. The fix was then restored and the suite re-run
  green. So the new tests genuinely pin the behavior rather than passing
  vacuously.

## Known gaps / things a reviewer should push on

- **Only the first discriminator was proven to fail without the fix.** The 28.2
  run bails on the first mismatch, so the `real primary key` case and the
  `numeric primary key` case were never observed *failing* on the old code in
  this session — the original fix-stage ticket reports them failing on `main`,
  and that was taken at its word. Worth re-verifying independently if the
  reviewer wants each assertion individually shown to be load-bearing.
- **`yarn test:store` was not run** (slower LevelDB path). The 28.2 file
  deliberately carries no `using memory`, so the new cases *should* exercise the
  store path too, but that has not been observed.
- **`NUMERIC_TYPE.physicalType` is `PhysicalType.REAL`** even though its value
  space includes `bigint` — there is a pre-existing `NOTE:` about this at
  `src/types/builtin-types.ts:250`. This change routes more values through
  `NUMERIC`, so it widens the blast radius of that latent mislabel *if* anything
  ever starts encoding or rounding by `physicalType`. Nothing does today (the
  store keys off the JS value type), so it stays a tripwire, not a defect — but
  it is now reachable from plain `select 1 union all select 2.5`, which it was
  not before.
- **Divergence from arithmetic promotion is now deliberate and load-bearing.**
  `BinaryOpNode.generateType` and `findCommonType` still promote `INTEGER + REAL`
  to `REAL`, and that is correct for them (one value, one form). A future
  "consistency" cleanup that unifies the two would silently reintroduce this bug.
  The reasoning is spelled out in the rule-3 comment and in `docs/types.md`; a
  reviewer should check that wording is strong enough to stop that.
- No test asserts the *plan-level* advertised type end-to-end (only the unit
  spec's mock-operand `outputType` and the SQL-level effects). If a reviewer
  wants a `test/plan/` assertion on the column type of a mixed set op, that is
  not there.
