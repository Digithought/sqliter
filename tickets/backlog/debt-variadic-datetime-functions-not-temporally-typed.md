---
description: Two versions of the same date function report different types — one says "this is a date", the other says "this is just text" — because the second one formats its answer in a way the date type would not accept.
files:
  - packages/quereus/src/func/builtins/datetime.ts    # the variadic date/time/datetime
  - packages/quereus/src/func/builtins/conversion.ts  # the single-argument date/time/datetime
  - packages/quereus/src/types/temporal-types.ts      # DATE/TIME/DATETIME canonical spelling
  - packages/quereus/test/logic/06.5.4-declared-return-type-builtins.sqllogic  # section 8 pins today's behavior
difficulty: medium
---

# The variadic date/time/datetime functions report TEXT, not their temporal type

## What is going on

Quereus has two overlapping families of date functions:

- `date(x)`, `time(x)`, `datetime(x)` — one argument. These convert a value to the
  DATE / TIME / DATETIME type and produce that type's *canonical* spelling.
- `date(x, '+1 day')`, `time(x, 'subsec')`, `datetime(x, 'start of month')` — one
  argument plus modifiers. These are SQLite's classic date functions, and they produce
  SQLite's *display* spelling.

The two spellings are not the same string:

| expression | produces | canonical form of the type |
|---|---|---|
| `datetime('2024-03-04 05:06:07', '+1 day')` | `2024-03-05 05:06:07` (space) | `2024-03-05T05:06:07` (T) |
| `time('12:00:00', 'subsec')` | `12:00:00.000` | `12:00:00` |
| `date('2024-03-04', '+1 day')` | `2024-03-05` | `2024-03-05` (same) |

So the variadic three declare TEXT as their return type, while their single-argument
siblings declare the temporal types. That is a real inconsistency a user can trip over:
`date(x)` and `date(x, '+1 day')` are the same function name and report different types.

## Why they were left as TEXT

The engine converts a value to a column's declared type exactly once on the way in, and
skips the conversion when the value's type already matches the column's. If the variadic
`datetime()` claimed to return DATETIME, `insert into t(dt) select datetime(x, '+1 day')`
would skip the conversion and store `2024-03-05 05:06:07` verbatim. DATETIME columns
compare as plain text, so that row would then not match `dt = '2024-03-05T05:06:07'` —
the spelling every other write to that column produces. This was verified experimentally,
not just reasoned about.

Declaring TEXT keeps the conversion, so the stored value stays canonical. The cost is only
the type inconsistency described above.

## What a resolution would look like

Roughly three options, in rough order of preference:

1. **Make the variadic functions emit canonical spellings**, then declare the temporal
   types. Clean, but it changes what `select datetime('now')` prints, which is SQLite
   compatibility surface and appears in tests and probably in user queries. Needs a
   decision on whether that compatibility matters.
2. **Add a separate "display format" concept** so a function can declare a temporal type
   while telling the write path that its value still needs canonicalizing. This is the
   most honest model but the largest change — it touches the "convert exactly once"
   invariant, which is deliberately simple today (types are compared by object identity).
3. **Leave it and document it**, which is the current state. The behavior is correct; only
   the reported type is imprecise, and only for the modifier-accepting forms.

## Not urgent

Nothing is wrong today — every value stored and compared is correct. This is a
tidiness/consistency concern that a user meets when they inspect the declared type of a
`date(x, …)` expression (e.g. in a view or `create table as select`) and find TEXT where
they expected DATE.
