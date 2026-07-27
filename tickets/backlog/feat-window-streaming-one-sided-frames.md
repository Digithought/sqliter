---
description: A window query whose frame is one-sided — "the previous 2 rows through the current row", or "the current row through the next 3" — falls back to sorting and holding the whole partition in memory, even though the two-sided version of the same frame already runs in one streaming pass.
prereq:
files:
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts   # recognizeSlidingFrame / isDefaultEquivalentFrame — the recognition gap
  - packages/quereus/src/runtime/emit/window.ts                          # sliding-frame state machine that would execute it
  - docs/window-functions.md                                             # streaming-eligibility table lists supported frame shapes
  - packages/quereus/test/logic/07.5-window.sqllogic                     # existing frame coverage
difficulty: medium
---

# Streaming coverage for one-sided sliding window frames

## What happens today

Window functions have two execution strategies. The default buffers the whole
partition, sorts it, and walks each row's frame. When the input already arrives in
window order, the optimizer rule `rule-monotonic-window` can instead tag the plan
to run in one streaming pass with a small bounded buffer.

That rule recognizes exactly two frame families:

- the default frame — everything from the start of the partition through the
  current row, and
- a **two-sided** frame — `between n preceding and m following`, with literal
  non-negative offsets, in either `rows` or `range` mode.

Anything else disables streaming **for the entire window node**, not just for the
one function. So these all buffer:

```sql
sum(x) over (order by t rows between 2 preceding and current row)
min(x) over (order by t rows between current row and 3 following)
```

even though `rows between 2 preceding and 1 following` — strictly more work —
streams.

## Why it matters

`n preceding and current row` is the common shape for a trailing moving average or
a trailing min/max over a time series, and it is exactly the query someone runs
over a large ordered table where buffering the partition hurts most. Users who
write the natural form get the slow plan; only the unnatural symmetric form gets
the fast one.

Correctness is not affected — both strategies produce the same answers. This is
purely about which plan gets chosen.

## Expected behavior

A one-sided sliding frame with a literal non-negative offset should stream under
the same preconditions the two-sided form already requires (input ordered on the
partition-then-order-by prefix; `range` mode still needing a single numeric ORDER
BY key; no frame exclusion). `current row` is the offset-zero case of the bound it
replaces:

| frame | equivalent two-sided form |
|---|---|
| `between n preceding and current row` | `between n preceding and 0 following` |
| `between current row and m following` | `between 0 preceding and m following` |
| `between current row and current row` | `between 0 preceding and 0 following` |

Note that in `range` mode "current row" means *all peer rows with the same ORDER BY
value*, which is what an offset of 0 already means to the existing range scan — so
the mapping should be checked against peer-tie cases, not assumed.

Watch the interaction with the default frame: `unbounded preceding and current row`
must keep routing to the cheaper running-accumulator path, not to the sliding
buffer.

## Use cases to cover

- Trailing moving average / running min-max over an ordered table, `rows` and
  `range`, with and without `partition by`.
- Peer ties in `range` mode at both edges of the frame.
- A window node mixing a one-sided-frame function with a default-frame function.
- Every new shape must return the same rows as the buffered strategy — the
  existing pattern for asserting that is
  `packages/quereus/test/plan/window-minmax-semantic-ordering.spec.ts`, which runs
  each query on a normal database and on one with `monotonic-window` disabled and
  requires the results to be deep-equal.
