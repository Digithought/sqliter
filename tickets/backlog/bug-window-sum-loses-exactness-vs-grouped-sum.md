---
description: Adding up a column of very large whole numbers gives one answer with a plain total and a different, slightly wrong answer when the same total is written as a running/windowed total over the same rows.
files:
  - packages/quereus/src/runtime/emit/window.ts               # updateAccumulator / removeFromAccumulator (~lines 1403-1417), finalizeAccumulator (~line 1648)
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # ~line 226 — the same float-only accumulation
  - packages/quereus/src/func/builtins/aggregate.ts            # sumFunc — the grouped implementation the window one should agree with
  - docs/window-functions.md
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The window path accumulates in plain floating point on purpose — it must also SUBTRACT values as a sliding frame moves off them, which is cheap for floats and awkward for exact integers, so a maintainer may reasonably decide that only whole numbers beyond 9,007,199,254,740,991 are affected and that the sliding-frame cost is not worth paying.
---

# Window `sum()` and grouped `sum()` disagree on large whole numbers

## What happens

Same rows, same function, two spellings, two answers:

```sql
create table w (id integer primary key, v integer);
insert into w values (1, 9007199254740993), (2, 5);

select sum(v) from w;             -- 9007199254740998   (exact)
select sum(v) over () from w;     -- 9007199254740996   (wrong by 2)
```

Verified by running the above against a plain in-memory `Database`. The window
answer is silently rounded: no error, no NULL, no log line.

The threshold is JavaScript's largest exactly-representable whole number,
9,007,199,254,740,991. Below it the two spellings agree; at or above it the window
form starts losing low digits. `avg()` over a window shares the accumulator and so
shares the problem.

## Why

The grouped aggregate (`func/builtins/aggregate.ts`, `sumFunc`) keeps an exact
integer part and a floating-point part separately, so whole numbers past that
threshold stay exact. The window runtime keeps its own, unrelated accumulator that
converts every contribution to a float first:

```ts
acc.sum += Number(argVal);     // runtime/emit/window.ts
acc.sum -= Number(argVal);     // ...and subtracts the same way as a frame slides
```

The subtraction is the reason it is written that way: a sliding frame has to remove
values as it moves off them, which floating point makes trivial. Any fix has to keep
that removal working — either by giving the window accumulator the same
exact/approximate split (the exact part subtracts exactly; the float part subtracts
as it does now), or by reusing the grouped aggregate's accumulator and its `negate`
directly.

## The class, not just this instance

`sum` is one instance of a broader gap: **the window runtime reimplements several
builtin aggregates instead of reusing them**, so any behavioral decision made in one
place has to be re-made, and silently drifts, in the other. The durable guard is a
test that pins the *relationship* rather than this one pair of numbers:

> for every aggregate that can also be used as a window function, `f(x) over ()`
> returns the same value as `f(x)` over the same rows

applied over a value domain that includes large whole numbers, fractions, and NULLs.
That test would have caught this without anyone thinking about `sum` specifically,
and would catch the next divergence too.

## Expected behavior

`f(x) over ()` and `f(x)` are the same computation over the same multiset of rows and
should return the same value, including its storage class (whole numbers past the
safe-integer threshold come back as exact integers from both). A partitioned or
framed window is the same requirement restricted to each frame's rows.
