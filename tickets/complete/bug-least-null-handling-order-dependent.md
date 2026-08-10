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
in step: both now reduce over a `null` seed and skip NULL candidates, same as the
custom emitter.

## Tests / docs updated

- `test/logic/24-builtin-branches.sqllogic`: `least(1, null)`, `least(3, null, 1)`,
  `least(1, null, 3)` now expect the actual minimum of the non-NULL arguments
  instead of the old order-dependent answers. Review stage extended this block
  (see findings).
- `test/logic/15.1-semantic-ordering.sqllogic` line ~558: `least(d, null)` /
  `least(null, d)` now both expect `d`'s value (previously one of the two
  returned `null`).
- `docs/types.md`, `docs/functions.md`, `docs/sql-functions.md`: removed the
  "order-dependent" callouts.

## Review findings

### Correctness of the fold — checked, one clarification landed

Re-derived the new `emitExtremum` fold against the old one case by case, including
the interaction the fix does *not* mention: `group.key(i, args[i])` can return
`null` for a **non-NULL** argument, because a coerced group runs `lenientCast`
and e.g. `cast('' as integer)` is null. The new `currentKey === null` skip
therefore drops such an argument too.

Worked through every shape this can take (`least('', 1)`, `greatest('', 5, 3)`,
`least('', cast(null as integer))`, all-null-key groups, single-argument and
zero-argument calls) and confirmed:

- `greatest` already behaved this way before the fix (a null-key argument could
  only survive as the running best if every later argument also had a null key,
  and in that case every argument is NULL anyway), so no `greatest` behavior
  changed.
- The only `least` change is exactly the intended one: a null key no longer wins.
- The "everything skipped" case returns `null` under both old and new code — the
  old code returned `args[bestIndex]`, and in every all-null-key scenario that
  argument is itself NULL.

So no defect — but the docstring said "NULL **arguments** are skipped", which is
narrower than what the code does. Fixed inline: the comment now says null **keys**
are skipped and calls out the coerced-group case explicitly, so the next reader
does not have to re-derive it.

### Test coverage — thin, extended inline

The implement stage's own handoff flagged the gap honestly (only 2-3 numeric
arguments). Added to `24-builtin-branches.sqllogic`:

- NULLs interleaved at more positions (`least(null, 3, null, 1, null)`), and the
  mirror `greatest(3, null, 1)` case that the file had only for `least`.
- Single surviving argument (`least(null, 7, null)` / `greatest(null, 7, null)`).
- A non-numeric comparison group (TEXT) for both directions, which exercises the
  collation-routed comparator rather than the numeric one.
- A mixed TEXT/INTEGER group with a NULL (`least('abc', null, 1)` → `'abc'`,
  `greatest('abc', null, 1)` → `1`) — this is the case that pins both halves at
  once: the coerced key ranks, the raw argument is returned (`returnsArg`), and
  the NULL is skipped.
- All-NULL and single-NULL calls for both directions.

All pass. Note `.sqllogic` files each run as one Mocha test, so the suite total
(8648) is unchanged by these additions — that is expected, not a sign the new
lines were skipped; a wrong expectation fails the file.

### Docs — verified, no further edits needed

Read all three changed docs plus every other file mentioning `least`/`greatest`
(`docs/types.md` §semantic ordering and §common-type resolution,
`docs/functions.md`, `docs/sql-functions.md`,
`src/runtime/emit/operand-comparator.ts`, `src/schema/function.ts`,
`src/types/cast-semantics.ts`). The surviving `least('abc', 1)` → `'abc'`
example in `docs/functions.md` is still correct under the new fold (`'abc'`
coerces to `0`, which is a real key, not null). No dangling references to the
old backlog ticket path remain outside `tickets/.logs/`.

### Not filed as tickets

- **Shared helper between the scalar fold and the aggregate `extremumParts`** —
  the implement handoff already argued against it; concur. The scalar fold needs
  the coerced-key / raw-argument index split that the aggregate accumulator has
  no notion of, so unifying them would add a parameter to the aggregate path to
  serve one caller. Speculative simplification, no trigger.
- **The unreachable `implementation` fallback bodies on `greatestFunc`/
  `leastFunc`** — dead as long as `customEmitter` is set, but the same pattern
  is used for `nullif` and the surrounding comments say so. Removing them is a
  separate, wider cleanup than this ticket, and leaving them *inconsistent* with
  the emitter would have been the real hazard; they were kept in step.

### Tripwires

None recorded. Nothing here is conditional-on-a-future-event: the fold is O(n)
with one comparator call per argument, resolves collation and coercion once at
emit, allocates nothing per row, and has no cleanup or error path to leak.

## Verification

- `yarn build` (root): clean.
- `yarn test` (from `packages/quereus`): **8648 passing, 13 pending, 0 failing**
  (including the extended `24-builtin-branches.sqllogic`).
- `yarn lint` (from `packages/quereus`): clean, no output, exit 0.
