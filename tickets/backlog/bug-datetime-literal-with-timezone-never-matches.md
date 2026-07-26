---
description: Storing a date-and-time that carries a time-zone marker and then searching for that exact same text finds nothing, because the stored copy silently drops the marker but the search text keeps it.
files:
  - packages/quereus/src/types/temporal-types.ts       # DATETIME parse / normalization
  - packages/quereus/src/util/comparison.ts            # tryTemporalComparison — the runtime path for a text literal vs a temporal column
  - packages/quereus/test/logic/                       # temporal coverage lives under the 4x.x series
difficulty: medium
---

# A `datetime` value written with a time zone can never be found again

## Observed

```sql
create table d (id integer primary key, t datetime);
insert into d values (1, '2020-01-01T00:00:00Z'), (2, '2021-06-05T10:00:00+02:00');

select id, t from d;
-- 1 | 2020-01-01T00:00:00
-- 2 | 2021-06-05T08:00:00        <- shifted to UTC, offset dropped

select id from d where t = '2020-01-01T00:00:00Z';    -- 0 rows
select id from d where t = '2021-06-05T10:00:00+02:00'; -- 0 rows
select id from d where t = '2020-01-01T00:00:00';     -- 1 row
```

So a value round-trips through the column fine, but the *only* text that finds it again is
the normalized spelling the engine chose — not the spelling that was written.

## Why it matters

The natural pattern is to insert a timestamp and later look it up with the same string an
application already has in hand (an ISO-8601 timestamp from an API or a log almost always
carries `Z` or an offset). That lookup silently returns nothing. Silent zero rows is worse
than an error: nothing signals that the two spellings were treated as different values.

## Expected behavior

Writing and reading should use one definition of "same instant". A `datetime` comparison
against a text value should normalize that text the same way a write does, so all three
spellings above — `…T00:00:00Z`, `…T00:00:00`, and an equivalent offset form — select the
row they describe. Ordering comparisons (`<`, `>`, `between`) should agree with equality on
the same rule.

## Scope notes

Not a regression, and not related to JSON. Found while probing comparison behavior during
the review of `bug-json-equality-not-structural`; that change deliberately leaves the
temporal types on their existing runtime comparison path, and this reproduces identically
whether or not the column is indexed, so no plan-time coercion is involved. Whoever picks
this up should decide first whether `datetime` is meant to be a fixed instant or a
time-zone-naive wall-clock value — the display above (an offset input shifted to UTC)
suggests instant, but that choice governs the fix.
