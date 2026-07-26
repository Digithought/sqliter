---
description: When you add a new column to an existing table and give it a default value, the rows that were already there store that default as raw text instead of converting it to the column's declared type — so old rows and new rows end up holding different-looking values.
files:
  - packages/quereus/src/schema/ (ALTER TABLE ADD COLUMN backfill)
  - packages/quereus/src/types/validation.ts   # coerceRowToSchema / validateAndParse — the conversion that is being skipped
  - packages/quereus-isolation/src/isolation-module.ts   # deriveAddColumnBackfill / computeAddColumnValue (overlay-side copy of the same backfill)
difficulty: medium
---

# What happens

`alter table … add column <c> <type> default <literal>` fills the new column on
every pre-existing row with the literal **exactly as written**, without running it
through the column's declared-type conversion. A later `insert` that lets the same
default apply *does* convert it. The two paths disagree.

Reproduced against a plain memory table (no store, no transaction involved):

```js
create table t (a integer primary key, b integer);
insert into t values (1, 10);
alter table t add column n integer default '7';
insert into t (a, b) values (2, 20);

select a, n, typeof(n) from t order by a;
-- a=1  n='7'  typeof=text      <-- backfilled row: still TEXT
-- a=2  n=7    typeof=integer   <-- inserted row:   converted
```

A `json` column shows the same split more sharply: the backfilled rows keep the
default's raw source text (`'"abc"'`) where an inserted row would hold the parsed
JSON string scalar (`abc`).

# Why it matters

Two rows of the same table hold two different physical representations of what
the user wrote as one default. Anything that compares, orders, indexes, or
round-trips the column then treats them as different values. For a `json` column
the backfilled cell is not even valid stored form, so a later read or re-write of
that row can fail.

# Expected

The `add column` backfill should apply the same declared-type conversion every
other write path applies (`coerceRowToSchema` / `validateAndParse`), so a
backfilled cell is indistinguishable from the cell a fresh `insert` under the same
default would produce.

# Scope notes

- The same untreated default is used by the persistent-store backfill and by the
  isolation layer's overlay migration for rows staged in an open transaction
  (`computeAddColumnValue` in `isolation-module.ts`). All of them currently agree
  *with each other* on the un-converted value, so fixing this must move them
  together or the overlay and the committed store will diverge instead.
- `alter column … set not null` with a `default` backfills through the same
  mechanism and should be checked at the same time.
- Found while reviewing `json-tombstone-recoerces-stored-key`; independent of that
  change (it reproduces on a plain memory table with no isolation layer involved).
