---
description: The `least` function gives different answers depending on where a NULL sits in its argument list — `least(1, null, 3)` returns 3 instead of the smallest value — and its sibling `greatest` treats NULLs a third way again.
files:
  - packages/quereus/src/func/builtins/scalar.ts        # greatestFunc / leastFunc + emitExtremum
  - packages/quereus/test/logic/24-builtin-branches.sqllogic  # current behavior pinned here
  - docs/types.md                                        # semantic-ordering section notes the wrinkle
difficulty: easy
---

# `least` NULL handling is order-dependent

## What happens today

`least` folds its arguments left to right, keeping whichever argument the
comparator ranks lower. NULL ranks lowest of all values, so a NULL argument
becomes the running answer. But the fold ALSO has a rule that replaces a NULL
running answer with the next argument unconditionally. The two rules fight, and
the result depends on where the NULLs sit:

```sql
select least(1, null);          -- null
select least(null, 1);          -- 1
select least(3, null, 1);       -- 1
select least(1, null, 3);       -- 3      <- not the smallest of anything
select greatest(1, null, 3);    -- 3      (greatest skips NULLs entirely)
```

So `least` effectively returns the minimum of only the arguments that follow the
last NULL, and `greatest` and `least` disagree with each other about what a NULL
argument means.

This is long-standing behavior, not a regression — the
`nullif-greatest-least-comparison-seam` work swapped the comparator these
functions use but deliberately left the fold's NULL rules untouched, and pinned
the current answers in `24-builtin-branches.sqllogic` so any change here is a
deliberate test edit.

## What it should do

Pick one rule and apply it to both functions. The two defensible options, both
in use by mainstream engines:

- **Skip NULLs** (PostgreSQL): `least(1, null, 3)` → 1, `greatest(1, null, 3)`
  → 3, and all-NULL → NULL. This is what `greatest` already does, and what the
  `min`/`max` aggregates do, so it is the most consistent with the rest of the
  engine.
- **Propagate NULLs** (Oracle, MySQL): any NULL argument makes the whole call
  NULL.

Whichever is chosen, `greatest` and `least` must agree, and the answer must not
depend on argument order.

## Notes for whoever picks this up

- The fold lives in `emitExtremum` in `func/builtins/scalar.ts`; the two
  registered `implementation` bodies next to it are unreachable dead defaults
  (the custom emitter handles every call site) but should be kept in step or
  removed.
- The `min`/`max` aggregates (`func/builtins/aggregate.ts`) and the window
  MIN/MAX (`func/builtins/builtin-window-functions.ts`) already skip NULLs; if
  the skip-NULLs option is chosen, the scalar fold ends up a near-duplicate of
  their `extremumParts` step and could plausibly share it.
- Update `docs/types.md` (the paragraph pointing at this ticket) and the pins in
  `test/logic/24-builtin-branches.sqllogic` as part of the change.
