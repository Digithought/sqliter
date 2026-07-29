---
description: Asking for a window frame like "all rows within 10 of the current row's value" silently ignores the "within 10" part when the ordering column holds text instead of numbers, returning a different answer than requested rather than reporting the mistake.
prereq:
files:
  - packages/quereus/src/runtime/emit/window.ts        # rangeOffsetStart / rangeOffsetEnd, getFrameBounds
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts   # isRangeSlidingEligible already declines to stream this
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts           # existing "non-numeric ORDER BY key" case
  - docs/window-functions.md
difficulty: easy
---

# A numeric RANGE frame offset over a non-numeric ordering column should be an error

## What happens today

A `RANGE` window frame with a numeric offset means "every row whose ORDER BY
value is within N of mine":

```sql
select k, sum(v) over (order by k range between 1 preceding and 1 following)
from t;
```

That question only makes sense if `k` is something you can add 1 to. When `k`
is text, Quereus accepts the query anyway and quietly drops the offset — the
frame it actually computes is the *peer group* (rows sharing the same `k`), the
same frame `range between current row and current row` would give. So all three
of these return identical results on a text `k`:

| written frame | frame actually used |
|---|---|
| `between 1 preceding and 1 following` | peer group |
| `between 1 preceding and current row` | peer group |
| `between current row and current row` | peer group |

No warning, no error. The user asked one question and got the answer to a
different one.

## Expected behaviour

Raise an error, the way both PostgreSQL and SQLite do:

- PostgreSQL: `RANGE with offset PRECEDING/FOLLOWING is not supported for column type text`
- SQLite: `RANGE with offset PRECEDING/FOLLOWING requires one ORDER BY expression with a numeric type`

Scope of the check: a `RANGE` frame that carries an explicit offset bound
(`n PRECEDING` or `n FOLLOWING`) against an ORDER BY key whose logical type is
not numeric. It must NOT affect:

- `RANGE` frames whose bounds are only `UNBOUNDED …` / `CURRENT ROW` — those are
  defined by peer-group equality and are correct over any comparable type,
  including text. `order by k range between unbounded preceding and current row`
  must keep working.
- `ROWS` frames, which count rows and never touch the ordering value.

Temporal ordering keys are worth a deliberate decision rather than a default:
"within 3 of this timestamp" is a reasonable thing to want, but it needs an
interval type on the offset, not a bare number. Erroring is a fine first answer;
say so explicitly in the ticket that implements this.

## Why it's not urgent

The wrong answer is at least *consistent* — every numeric offset over a text key
degrades to the same peer-group frame on every plan. The optimizer already
declines to route these to the streaming window emitter (`isRangeSlidingEligible`
in the rule file above), so the two physical paths agree with each other. This is
about rejecting a meaningless query rather than about two code paths disagreeing.

## Where the check belongs

Probably at plan-build / validation time rather than inside the runtime frame
walk, so the error surfaces on `prepare` rather than mid-iteration — but the
runtime's `getFrameBounds` is where the type is currently observed, so confirm
the ORDER BY key's logical type is reachable at build time before committing to
that placement.
