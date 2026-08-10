---
description: Subtracting one timestamp from another reports only the whole days between them and silently throws away the hours, minutes, and seconds — so two moments five days and two hours apart come back as exactly five days.
files:
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts   # tryTemporalArithmetic — the DATE/DATETIME '-' branch converts both sides to PlainDate
  - packages/quereus/src/types/temporal-ops.ts                 # after temporal-op-table lands, the four '-' date/datetime cases live here
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: fixing it changes the answer of an operation people may already have built around, and the four cases (date−date, date−datetime, datetime−date, datetime−datetime) need separate rulings — a maintainer might prefer to leave the whole-days answer and add an explicit function for the precise difference rather than change an operator's meaning.
---

# What is wrong

Subtracting two DATETIME values reports only the calendar-day part of the gap. Verified:

```sql
select datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00');
-- returns 'P5D'
-- the actual gap is 5 days and 2 hours — 'P5DT2H'
```

The cause is one line of the subtraction rule: before computing the difference, both sides
are converted to a plain calendar date, discarding the time of day. Anything that depends on
the hours — a duration billed, an elapsed-time threshold, a service-level check — is wrong,
and wrong quietly, since `P5D` is a perfectly valid answer shape.

The same conversion applies to the mixed forms (`datetime - date` and `date - datetime`).
Only `date - date` is unaffected, because there is no time of day to lose.

# Expected behavior

`DATETIME - DATETIME` should report the full elapsed gap including the time of day.

The two mixed forms need an explicit ruling rather than an assumed one: when one side is a
plain date and the other carries a time, treating the plain date as midnight is the
conventional reading, but it should be a stated decision, and it changes today's answers.

# How to reproduce

Any DATETIME subtraction where the two values have different times of day. The engine's
own test file `107-temporal-arithmetic-mutation-kills.sqllogic` covers `DATE - DATE` and
`TIME - TIME` but has no `DATETIME - DATETIME` case, which is why the loss went unnoticed.

# Notes

Found while planning `temporal-op-table`, which moves the temporal arithmetic rules into a
single table. That work deliberately preserves this behavior verbatim so the refactor stays
behavior-neutral; the fix belongs here, on its own, where the answer change is visible.
