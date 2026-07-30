---
description: The engine has no single agreed way of writing a date-and-time down, so a stored timestamp cannot be found again by searching for the exact text that created it, and the two families of date functions disagree about what type they even return.
files:
  - packages/quereus/src/types/temporal-types.ts       # DATE/TIME/DATETIME parse, normalization, canonical spelling
  - packages/quereus/src/util/comparison.ts            # tryTemporalComparison — the runtime path for a text literal vs a temporal column
  - packages/quereus/src/func/builtins/datetime.ts     # the variadic date/time/datetime (SQLite display spelling)
  - packages/quereus/src/func/builtins/conversion.ts   # the single-argument date/time/datetime (canonical spelling)
  - packages/quereus/test/logic/                       # temporal coverage lives under the 4x.x series
  - packages/quereus/test/logic/06.5.4-declared-return-type-builtins.sqllogic  # section 8 pins today's TEXT return type
difficulty: medium
---

# DATETIME has no settled canonical spelling, and two things break because of it

## The shared blocker

Both problems below hinge on one unsettled question:

> **What is DATETIME's canonical stored spelling, and is the variadic date/time/datetime
> builtin required to emit it?**

Fixing either arm without deciding that re-opens the other, which is why they are one ticket.
A secondary decision rides along: whether `datetime` is meant to be a **fixed instant** or a
**time-zone-naive wall-clock** value. Today's display behavior (an offset input shifted to
UTC) suggests instant, but that choice governs the fix.

## Arm A (bug) — a value written with a time zone can never be found again

**Verified:** the write path normalizes to a UTC-naive spelling; the runtime comparison path
does not normalize the literal at all. So `where t = '2020-01-01T00:00:00Z'` returns zero rows
for a row inserted with that exact text.

```sql
create table d (id integer primary key, t datetime);
insert into d values (1, '2020-01-01T00:00:00Z'), (2, '2021-06-05T10:00:00+02:00');

select id, t from d;
-- 1 | 2020-01-01T00:00:00
-- 2 | 2021-06-05T08:00:00        <- shifted to UTC, offset dropped

select id from d where t = '2020-01-01T00:00:00Z';      -- 0 rows
select id from d where t = '2021-06-05T10:00:00+02:00'; -- 0 rows
select id from d where t = '2020-01-01T00:00:00';       -- 1 row
```

A value round-trips through the column fine, but the *only* text that finds it again is the
normalized spelling the engine chose — not the spelling that was written.

**Why it matters:** the natural pattern is to insert a timestamp and later look it up with the
same string an application already has in hand (an ISO-8601 timestamp from an API or a log
almost always carries `Z` or an offset). That lookup silently returns nothing. Silent zero
rows is worse than an error: nothing signals that the two spellings were treated as different
values.

**Expected:** writing and reading use one definition of "same instant". A `datetime` comparison
against a text value normalizes that text the same way a write does, so all three spellings
above select the row they describe. Ordering comparisons (`<`, `>`, `between`) agree with
equality on the same rule.

**Scope notes:** not a regression, and not related to JSON. Found while probing comparison
behavior during the review of `bug-json-equality-not-structural`; that change deliberately
leaves the temporal types on their existing runtime comparison path. It reproduces identically
whether or not the column is indexed, so no plan-time coercion is involved.

## Arm B (consistency) — the variadic date/time/datetime report TEXT, not their temporal type

Quereus has two overlapping families of date functions:

- `date(x)`, `time(x)`, `datetime(x)` — one argument. These convert a value to the
  DATE / TIME / DATETIME type and produce that type's *canonical* spelling.
- `date(x, '+1 day')`, `time(x, 'subsec')`, `datetime(x, 'start of month')` — one argument
  plus modifiers. These are SQLite's classic date functions, producing SQLite's *display*
  spelling.

The two spellings are not the same string:

| expression | produces | canonical form of the type |
|---|---|---|
| `datetime('2024-03-04 05:06:07', '+1 day')` | `2024-03-05 05:06:07` (space) | `2024-03-05T05:06:07` (T) |
| `time('12:00:00', 'subsec')` | `12:00:00.000` | `12:00:00` |
| `date('2024-03-04', '+1 day')` | `2024-03-05` | `2024-03-05` (same) |

So the variadic three declare TEXT as their return type while their single-argument siblings
declare the temporal types. `date(x)` and `date(x, '+1 day')` are the same function name and
report different types — a real inconsistency a user trips over when inspecting the declared
type of a `date(x, …)` expression (e.g. in a view or `create table as select`).

**Why they were left as TEXT:** the engine converts a value to a column's declared type exactly
once on the way in, and skips the conversion when the value's type already matches the
column's. If the variadic `datetime()` claimed to return DATETIME,
`insert into t(dt) select datetime(x, '+1 day')` would skip the conversion and store
`2024-03-05 05:06:07` verbatim. DATETIME columns compare as plain text, so that row would then
not match `dt = '2024-03-05T05:06:07'` — the spelling every other write to that column
produces. This was verified experimentally, not just reasoned about. Declaring TEXT keeps the
conversion, so the stored value stays canonical; the cost is only the type inconsistency.

Note that this failure mode is Arm A wearing a different hat: a stored value whose spelling
does not match the spelling the comparison path expects.

**Resolution options, in rough order of preference:**

1. **Make the variadic functions emit canonical spellings**, then declare the temporal types.
   Clean, but it changes what `select datetime('now')` prints, which is SQLite compatibility
   surface and appears in tests and probably in user queries. Needs a decision on whether that
   compatibility matters.
2. **Add a separate "display format" concept** so a function can declare a temporal type while
   telling the write path that its value still needs canonicalizing. The most honest model but
   the largest change — it touches the "convert exactly once" invariant, which is deliberately
   simple today (types are compared by object identity).
3. **Leave it and document it**, the current state. The behavior is correct; only the reported
   type is imprecise, and only for the modifier-accepting forms.

Nothing is *wrong* today in Arm B — every value stored and compared is correct — so on its own
it is a tidiness concern. It is here because option 1 and option 2 are both answers to the
shared blocker above, and picking one for Arm A settles Arm B with it.
