---
description: Window queries that group rows with PARTITION BY always fall back to sorting and holding every row in memory, even when the data already arrives in the right order and a one-pass streaming plan would work.
files:
  - packages/quereus/src/vtab/memory/module.ts                            # buildMonotonicAdvertisement — the thing to widen
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts     # the NOTE: comment explaining today's dead end
  - packages/quereus/src/runtime/emit/window.ts                            # runStreaming already resets per-partition state
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts             # PARTITION BY cases, currently buffered on both databases
  - docs/window-functions.md                                               # bail-conditions list
difficulty: medium
---

# Let partitioned window queries take the streaming fast path

## The gap

Quereus has a one-pass "streaming" plan for window functions: when the rows
already arrive in the order the window wants, it computes results as rows flow
through instead of collecting the whole input, sorting it, and walking it. That
plan currently never fires for a query with `PARTITION BY`:

```sql
select g, k, sum(v) over (partition by g order by k) from t;   -- always buffered
```

even when `t` has an index on `(g, k)` that hands the rows over in exactly
`g, k` order — the ideal case for streaming.

## Why

A table access tells the optimizer which single column it is emitting in sorted
order (an advertisement the code calls `monotonicOn`). Today it names only the
*leading* column of the index it is walking that isn't pinned to a constant. On
an index `(g, k)` that means it advertises `g`.

The streaming window rule needs to know the *ORDER BY* key arrives sorted — here
that's `k` — so it looks for `k` in the advertisement, doesn't find it, and gives
up. The rule's remaining checks (partition columns forming a prefix of the source
ordering, per-function recognition, frame shapes) are already written for the
multi-key case and would pass.

So the fix is upstream of the window rule: an index scan walking `(g, k)` emits
rows sorted by `k` *within each `g`*, and that fact needs to reach the optimizer.
Whether that means widening `monotonicOn` to a list of columns, adding a separate
"sorted within groups of these columns" advertisement, or something else is the
design question this ticket exists to answer — `monotonicOn` is consumed by other
rules too (limit pushdown, merge join, range access), so widening it is not a
local change.

## What "done" looks like

- `partition by g order by k` over an index on `(g, k)` produces a streaming
  window plan, and returns the same rows the buffered plan returns.
- The other consumers of the ordering advertisement are unaffected, or are
  updated deliberately with their own tests.
- The `NOTE:` comment in `rule-monotonic-window.ts` and the corresponding bullet
  in `docs/window-functions.md` — both of which currently tell the reader that
  partitioned windows never stream — are removed or rewritten.
- The `PARTITION BY` cases in `window-one-sided-frames.spec.ts` gain the
  streaming-mode assertions they deliberately omit today. Read the comment above
  them first: they were written to keep passing either way, so they will *not*
  fail when this starts working, and nothing else will notice on its own.

## Why it matters

Buffering is what makes a window query's memory grow with the input. Partitioned
windows — "running total per customer", "rank within each category" — are the
common shape, so the case that most needs the one-pass plan is exactly the case
that can't have it. This is a performance gap only; results are correct today.
