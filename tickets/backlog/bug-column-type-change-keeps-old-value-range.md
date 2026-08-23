----
description: After changing a column's type, the database keeps describing that column with the smallest and largest values it held BEFORE the change, so the query planner sizes searches on it against a range the column no longer has.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # runAlterColumn — the engine-side arm; sibling carryStatisticsAcrossColumnRename is the shape to follow
  - packages/quereus/src/schema/table.ts                              # pruneStaleColumnStatistics — deliberately cannot catch this (the column keeps its name)
  - packages/quereus-store/src/common/store-table-base.ts             # columnStatisticsRemap / remapPersistedColumnStatistics — the persisted half's seam
  - packages/quereus-store/src/common/store-module-alter-column.ts    # the store's ALTER COLUMN arm
  - packages/quereus/src/vtab/memory/module.ts                        # memory backend already drops all statistics on this form, so it does not have the bug
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The numbers are advisory — only query-plan sizing is affected, never query results — and any `ANALYZE` clears it, so a maintainer may reasonably rank this below work that affects answers; the fix also needs a judgement call on which type changes actually invalidate a range, and being wrong there loses good measurements for no reason.
----

# A column keeps its old value range after its type changes

## What happens

`ANALYZE` records, per column, how many distinct values it holds, how many are NULL, and
its smallest and largest value. Change that column's type afterwards and the values are
rewritten — but the recorded smallest and largest are not. They keep describing the values
the column held before the change.

Verified on the persistent (store) backend, in memory and on disk:

```sql
create table t (id integer primary key, v integer null) using store;
-- 20 rows, v = 0 .. 19
analyze t;                                   -- v: min 0, max 19 (integers)
alter table t alter column v set data type text;
-- v still records min 0, max 19 — as INTEGERS, for a column that now holds text
```

The distinct count and NULL count are still right (a cast changes neither), so the entry
looks healthy; only the range is wrong, and it is wrong in a way that compares an integer
range against text values. A query like `where v > '30'` is then sized against a range that
does not describe the column, and the planner can pick the wrong access path.

The default (memory) backend does not have this: it discards a table's statistics entirely
on this form of ALTER, which is fail-safe.

Nothing is corrupted and no query returns a wrong answer — only plan choice is affected —
and a fresh `ANALYZE` fixes it.

## Why the existing guards miss it

The related work (`bug-alter-column-leaves-stale-column-statistics`) built two guards, and
by construction neither one applies here:

- The engine drops statistics naming a column the table no longer has. A type change keeps
  the column and its name, so there is nothing stale to spot.
- The store re-keys its saved record when an ALTER frees a column name. A type change frees
  no name, so that pass deliberately does nothing.

Both were the right scope for that ticket. This is the remaining case: the name is fine and
the *values* moved out from under the measurements.

## The invariant worth stating

Every guard so far is about column *names*. The missing rule is about column *values*:

> An ALTER that rewrites a column's values invalidates that column's recorded value range.

Only one ALTER form rewrites values in place today (`alter column ... set data type`), so
the rule has one site — but stating it as a rule is what makes a future value-rewriting
form face the question. The engine arm for that form is `runAlterColumn`, whose sibling
`carryStatisticsAcrossColumnRename` in the same file is the shape to follow: decide the
statistics consequence next to the arm that causes it, before the catalog write.

## What needs deciding

- **Which changes invalidate the range.** A collation change reorders comparisons without
  moving values, so it invalidates min/max just as a cast does. A nullability change does
  not. Whether a widening change between two numeric types should keep the range is a real
  question — cheap to keep, and keeping it wrongly is the failure this ticket is about.
- **Whether the whole entry goes or only the range.** The distinct and NULL counts survive
  every cast, and they are what equality estimates use, so dropping them costs plan quality
  for no correctness gain. A histogram, like the range, describes values and does not
  survive.
- **The persisted half.** The store's saved record needs the same correction, or a reopen
  restores the stale range. The seam already exists — `columnStatisticsRemap` in
  `store-table-base.ts` decides per ALTER form what happens to the saved entry — and this
  form currently returns "nothing to do" there.

## Expected behavior

After `alter table t alter column v set data type <other>`, nothing the database records
about `v`'s values may still describe the values it held before — in memory and after a
close and reopen, on every backend that keeps statistics. An untouched column in the same
table keeps its own measurements. A later `ANALYZE` restores whatever was dropped.
