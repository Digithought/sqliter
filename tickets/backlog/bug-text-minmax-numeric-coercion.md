---
description: When a text column holds number-like strings, min() and max() quietly treat them as numbers and can return a different row than sorting the same column would — and they hand back a number where the column holds text.
files:
  - packages/quereus/src/util/coercion.ts                    # coerceForAggregate — the numeric-string conversion
  - packages/quereus/src/runtime/emit/aggregate-setup.ts     # computeAggregateSkipCoercion — which call sites skip it
  - packages/quereus/src/runtime/emit/aggregate.ts           # stream aggregate — applies coerceForAggregate per value
  - packages/quereus/src/runtime/emit/hash-aggregate.ts      # hash aggregate — same
difficulty: medium
---

# `min`/`max` over a text column coerce number-like strings to numbers

## What happens

Before an aggregate steps a value, the engine converts a number-looking string to
an actual number so that `sum`/`avg` accept `'12'`. That conversion is applied to
every aggregate that is not `count`, `group_concat`, or a `json_*` function — so
`min` and `max` get it too.

For a plain `text` column that holds `'5'` and `'10'`:

```sql
create table t (id integer primary key, v text);
insert into t values (1, '5'), (2, '10');

select min(v) from t;                    -- 5      (a NUMBER, compared numerically)
select v from t order by v limit 1;      -- '10'   (text order)
```

Two separate problems in one:

- **Wrong row.** `min(v)` disagrees with `order by v limit 1`, which every other
  ordering site in the engine (comparison operators, `distinct`, index order) agrees
  with.
- **Wrong type out.** The value returned is a number, not the text that is stored,
  so the result's storage class differs from the column's.

## Why it is filed now

This predates the change that made `min`/`max` rank by their argument's declared
type and collation, and that change deliberately left it alone: the two emitters
skip the conversion only when every argument is numeric or carries semantic
ordering (`timespan`, `json`), which leaves plain and collated `text` on the old
path. So the fix above is complete for the types it covers, and this is the
remaining hole — now documented in a code comment but not otherwise tracked.

## Expected behavior

`min(x)` and `max(x)` should pick the same value `order by x limit 1` /
`order by x desc limit 1` picks, and should return it unchanged — same storage
class, same bytes — for every argument type, text included.

## Scope notes for whoever picks this up

- Changing this is a **behavior change**, not a pure bug fix: existing queries that
  rely on `min`/`max` over numeric-looking text returning numbers will see different
  results. Worth a deliberate decision (and a look at what SQLite does — SQLite
  applies the column's type affinity, and for a `text` column compares as text).
- Only `min`/`max` are in question here; `sum`, `avg`, `total`, and the `var_*` /
  `stddev_*` family all parse strings inside their own step functions, so they do
  not depend on this pre-step conversion. Verify that before removing it wholesale.
- Watch the mixed-storage-class case: a column holding both `5` (integer) and `'5'`
  (text) must still order by storage class the way the comparison operators do.
