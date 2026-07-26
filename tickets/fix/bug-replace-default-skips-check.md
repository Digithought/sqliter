---
description: When an INSERT OR REPLACE fills in a column's default value because the statement supplied nothing, the table's CHECK rules are not applied to that filled-in value, so a row that should be rejected gets stored.
files:
  - packages/quereus/src/runtime/emit/constraint-check.ts   # run() / checkConstraints / checkNotNullConstraints — the substitution and the row context it is invisible to
  - packages/quereus/test/logic/40.2-check-extras.sqllogic  # natural home for a regression case
  - packages/quereus/test/logic/03.4-defaults.sqllogic      # existing NOT NULL DEFAULT coverage
difficulty: medium
---

# `insert or replace` default substitution is invisible to CHECK

## Reproduction

```sql
create table t (id integer primary key, v integer not null default 5 check (v > 100));

-- The CHECK is live: a supplied value below 100 is rejected as expected.
insert into t values (2, 7);
-- ConstraintError: CHECK constraint failed: _check_v (v > 100)

-- But a NULL under OR REPLACE is silently accepted.
insert or replace into t values (1, null);
select * from t;   -- [{"id":1,"v":5}]  ← 5 is not > 100
```

Expected: the second statement fails the same CHECK. SQLite applies NOT NULL
default substitution first and then evaluates CHECK against the substituted row.

## Why it happens

`emitConstraintCheck`'s per-row loop establishes the row context that constraint
expressions read from **before** running the NOT NULL pass:

1. `run()` computes the row it will expose (`coercedRow`) and opens
   `withAsyncRowContext` over it.
2. Inside that context, `checkConstraints` calls `checkNotNullConstraints`, which
   — under `OR REPLACE` — builds a **new** row with the column's DEFAULT
   substituted and returns it as `replacedRow`.
3. `checkConstraints` reassigns its own local variable to that new row, but the
   already-open row context still exposes the pre-substitution row. So the CHECK
   evaluator reads the original `NULL`, and `NULL > 100` is NULL, which CHECK
   treats as a pass.

The substituted row does reach storage, so the stored value is the default while
the constraint verdict was computed against NULL.

This is **not** a regression from `bug-json-compare-string-ambiguity` — the same
staleness exists in the pre-fix code, which exposed the raw `flatRow` and had the
identical local-variable reassignment. That ticket only changed *which* row is
exposed, not *when* it is exposed.

## Constraint on the fix

The NOT NULL pass cannot simply be hoisted above the row context. A column
DEFAULT may reference other columns of the row being inserted (`new.<col>` — see
the NOT NULL attribution comment in `checkNotNullConstraints` and the NOT NULL
default section of `test/logic/03.4-defaults.sqllogic`), so the DEFAULT
evaluators need the row context too. The CHECK phase has to re-observe the row
after substitution — e.g. by re-entering a nested row context over the rebuilt
row before `checkCheckConstraints` runs — rather than by reordering the phases.

## Expected behaviour to pin down

- `insert or replace` where a substituted DEFAULT violates a CHECK → the CHECK
  fails, and the row is not stored.
- `insert or replace` where the substituted DEFAULT satisfies the CHECK → the row
  is stored with the default (unchanged from today).
- A DEFAULT expression that references another column of the same row still
  resolves correctly (existing `03.4-defaults.sqllogic` cases must not regress).
- The immediate and deferred CHECK paths must agree on all of the above; today
  both accept the reproduction above, so both need coverage.
- The same scenario via `update or replace`, if that path can substitute a
  default at all.
