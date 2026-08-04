---
description: Fixed `least` so it always skips NULL arguments, matching `greatest`, instead of giving a different answer depending on where the NULL sat in the argument list.
files:
  - packages/quereus/src/func/builtins/scalar.ts        # emitExtremum + greatestFunc/leastFunc default bodies
  - packages/quereus/test/logic/24-builtin-branches.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - docs/types.md
  - docs/functions.md
  - docs/sql-functions.md
difficulty: easy
---

# `least` NULL handling fixed to skip-NULLs (matches `greatest`)

## What changed

`emitExtremum` in `packages/quereus/src/func/builtins/scalar.ts` folded arguments
left-to-right and special-cased a `null` running best: any NULL argument became
the running best (since NULL always compares lowest), and the *next* argument
then replaced that NULL best unconditionally, regardless of whether it was
actually the extremum. For `greatest` (direction `+1`) this special case never
fired wrongly because NULL never wins a "greatest" comparison. For `least`
(direction `-1`) it did fire, since NULL always "wins" a low-comparison, so any
NULL clobbered the running minimum and the next value replaced it unconditionally
— producing the order-dependent bug described in the original ticket
(`least(1, null, 3)` → `3` instead of `1`).

Fixed by rewriting the fold to skip NULL argument keys outright (`continue` when
`currentKey === null`), tracking `bestIndex = -1` until a real candidate is seen,
and returning `null` only when no non-NULL argument existed. This is the
"skip NULLs" option from the original ticket — it's what `greatest` already did
and what `min`/`max` (`func/builtins/aggregate.ts`) and window MIN/MAX
(`func/builtins/builtin-window-functions.ts`) already do, so `least` now agrees
with all of them.

The two dead-default `implementation` bodies passed to `createScalarFunction` for
`greatestFunc`/`leastFunc` (unreachable — `customEmitter` always wins) were kept
in step: both now reduce over `null` seed and skip NULL candidates, same as the
custom emitter.

## Tests / docs updated

- `test/logic/24-builtin-branches.sqllogic`: `least(1, null)`, `least(3, null, 1)`,
  `least(1, null, 3)` now expect the actual minimum of the non-NULL arguments
  instead of the old order-dependent answers.
- `test/logic/15.1-semantic-ordering.sqllogic` line ~558: `least(d, null)` /
  `least(null, d)` now both expect `d`'s value (previously one of the two
  returned `null`) — this test wasn't listed in the original ticket's `files:`
  but pinned the same bug and had to move together.
- `docs/types.md`, `docs/functions.md`, `docs/sql-functions.md`: removed the
  "order-dependent" callouts and the dangling reference to
  `tickets/backlog/bug-least-null-handling-order-dependent` (that backlog file
  never existed separately — this fix ticket was already the tracking ticket).

## Verification

`yarn test` (from `packages/quereus`): 8648 passing, 13 pending, 0 failing.
`yarn lint`: clean.

## Notes for reviewer

- No shared helper was introduced between the scalar fold (`emitExtremum`) and
  the aggregate `extremumParts` (`func/builtins/aggregate.ts`) even though the
  original ticket floated it as a "could plausibly share" idea — the scalar
  fold needs the coerced-KEY/raw-ARGUMENT split (`returnsArg`) that the
  aggregate accumulator doesn't, so unifying them would need threading an extra
  index-vs-value distinction through the aggregate's accumulator type. Left as
  a possible follow-up, not required by this ticket's scope (making the two
  functions internally consistent), and not filed as a ticket since it's a
  speculative simplification with no concrete trigger.
