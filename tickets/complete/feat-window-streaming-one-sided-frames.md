---
description: Window queries whose frame is one-sided — "the previous 2 rows through the current row", or "the current row through the next 3" — now run in one streaming pass instead of sorting and holding the whole group of rows in memory.
prereq:
files:
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts   # the recognition change
  - packages/quereus/src/runtime/emit/window.ts                          # buffered frame walk — NULL ordering-key fixes (review)
  - packages/quereus/src/planner/nodes/window-node.ts                    # offset doc comment
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts           # streaming vs buffered equivalence, 19 cases
  - packages/quereus/test/logic/07.5-window.sqllogic                     # value-level cases
  - docs/window-functions.md                                             # eligibility table, bail conditions, user-facing frame rules
  - docs/optimizer-streaming.md                                          # precondition list
difficulty: medium
---

# Streaming coverage for one-sided sliding window frames — completed

## What shipped

**Recognition (implement stage).** `recognizeSlidingFrame` in
`rule-monotonic-window.ts` was rewritten around a `readFrameOffset(bound, direction)`
helper. A frame qualifies for the one-pass streaming plan when its start bound is
`n PRECEDING` **or `CURRENT ROW`**, and its end bound is `m FOLLOWING` **or
`CURRENT ROW`** — or absent, since a start-only frame (`ROWS 2 PRECEDING`) means
`... AND CURRENT ROW`. `CURRENT ROW` is the offset-zero case of the bound it
replaces, so a one-sided frame reduces to the two-sided form the sliding-buffer
state machine already ran. No runtime emitter code was needed for this part.

| written frame | offsets handed to the emitter |
|---|---|
| `between n preceding and current row` | `preceding=n, following=0` |
| `between current row and m following` | `preceding=0, following=m` |
| `between current row and current row` | `preceding=0, following=0` |
| `rows n preceding` (start-only) | `preceding=n, following=0` |

`UNBOUNDED PRECEDING AND CURRENT ROW` is deliberately not matched here; it keeps
routing to the cheaper running-accumulator path, with a test pinning that.

**RANGE eligibility (implement stage).** RANGE-mode sliding frames additionally
require the single ORDER BY key's logical type to be numeric
(`isRangeSlidingEligible`), because the streaming range scan and the buffered
frame walk did not agree for a text key.

**Two more divergences closed, plus a DRY pass (review stage)** — see below.

## Review findings

### Checked

Read the implement diff before the handoff. Traced the recognizer against the
parser's actual frame-bound AST and against the buffered frame walk in
`runtime/emit/window.ts` bound-by-bound, then ran targeted probes comparing the
streaming and buffered answers for shapes the tests did not cover: NULL ordering
keys, fractional offsets, text ordering keys, `Infinity`. Verified the
`PARTITION BY` claim in the implementer's `NOTE:` against
`buildMonotonicAdvertisement` in `vtab/memory/module.ts` — it is accurate. Read
every doc the change touched plus the user-facing sections of
`docs/window-functions.md` it did not. Full `yarn build`, `yarn test`
(7841 + 594 + 342 + … passing, zero failing), and `yarn lint` clean.

### Found and fixed in this pass

**1. A NULL ordering key was treated as zero by the buffered frame walk.**
`findRangeOffsetStart` / `findRangeOffsetEnd` read the ORDER BY value with a bare
`Number(...)`, and `Number(null) === 0`. Any RANGE interval reaching down to zero
therefore swallowed the NULL-keyed rows:

```sql
-- k values: null, null, 10, 20, 20, 30
select k, sum(v) over (order by k range between 10 preceding and current row) from rnull;
-- k=10 → buffered 7 (the two NULL rows summed in), streaming 4 (correct)
```

The streaming emitter already gets this right and carries a comment saying
exactly why (`orderByVal0Num`, window.ts). Fixed by routing both helpers through
a shared `rangeOrdinal()` that maps NULL to NaN. This is pre-existing — the
two-sided frames that shipped earlier hit it too — and the existing
`range_null` sqllogic case missed it only because its offset (5) was smaller than
its smallest key (10), so no interval reached zero.

**2. A NULL-keyed row's own frame started at the wrong row.** With the above
fixed, the second NULL row still disagreed: the buffered walk bailed to
`currentIndex` for a non-finite key, so a NULL row's frame began at itself rather
than at the start of its NULL peer group. Per the standard (and per the streaming
emitter, and per what `RANGE CURRENT ROW` already did), a row whose ordering key
has no place on the numeric line takes its peer group as its frame. The two
helpers are now `rangeOffsetStart` / `rangeOffsetEnd` and fall back to
`findFirstPeer` / `findLastPeer`. Side benefit: the incoherence the implementer
flagged as a "reviewer judgment call" — a text ordering key giving 1-row frames
under `1 preceding and 1 following` but the full peer group under
`current row and current row` — is gone; every numeric offset over a text key now
consistently degrades to the peer group.

**3. A fractional RANGE offset succeeded or raised depending on the plan.**
`readFrameOffset` required an integer offset only in ROWS mode, but the buffered
walk's `getFrameOffset` *throws* `Invalid window frame offset` for a non-integer
in both modes. So `range between 1.5 preceding and current row` returned rows on
a table with a usable index and raised on one without. The recognizer now
requires a non-negative integer literal in both modes, matching the buffered
path. The implementer's handoff listed fractional RANGE offsets as "accepted but
untested" — they were also divergent. Supporting them properly on both paths is a
separate enhancement, not filed (nobody has asked for it).

**4. DRY / altitude.** The frame is a property of the window spec, but
`recognizeFunctionMode` re-derived it per function: three copies of
`recognizeSlidingFrame(frame)` + `isDefaultEquivalentFrame(frame)` + the
`sliding.mode === 'range' && !rangeSlidingOk` guard, and three near-identical
`slidingAgg` object literals. Hoisted into one `classifyFrame(frame, orderBy)`
call per WindowNode returning a `FrameShape { isDefault, sliding }`, with a
`slidingAggMode(name, sliding)` builder for the returns. Net −30 lines in the
rule, and the RANGE-eligibility guard now exists in exactly one place.

Each of 1–3 got a spec case in `window-one-sided-frames.spec.ts` (now 19 cases,
each still run on both a normal database and one with the `monotonic-window` rule
disabled, deep-compared). 1 and 3 also got value-level `07.5-window.sqllogic`
cases so the expected answers are pinned independently of the both-shapes
harness. `docs/window-functions.md` gained the user-facing rules (integer-only
offsets; NULL keys in RANGE) and a short statement that a bail from the streaming
rule is always a performance decision and never a semantic one.

### Filed as new tickets

- `backlog/bug-window-range-offset-ignored-on-text-key` — a numeric RANGE offset
  against a text ordering column silently ignores the offset and returns the peer
  group instead. PostgreSQL and SQLite both error. Consistent across plans (the
  optimizer already keeps these buffered), so it is a wrong-answer-vs-standard
  issue rather than a two-paths-disagree issue. This is the judgment call the
  implementer left to review; the answer is "yes, it should error, and it's its
  own ticket."
- `backlog/feat-window-streaming-partitioned` — no `PARTITION BY` window can take
  the streaming plan today, because a table access advertises sorted-emit for one
  column only. The implementer parked this as a tripwire; it is not conditional —
  it is definitely true now and partitioned windows are the common shape — so it
  is a feature gap, and a ticket. The `NOTE:` in the rule stays as the in-code
  pointer.

### Recorded as tripwires, not tickets

- The RANGE spec cases stream only because the optimizer picks the secondary index
  for `order by k`. A cost-model change would drop them to the buffered walk and
  the failure would read as a window-rule regression. Parked as a `NOTE:` above
  the `RANGE mode with peer ties` describe block, telling the reader to check the
  chosen index first.

### Deliberately left alone

- **The unreachable `exclusion` guards.** `EXCLUDE CURRENT ROW` and friends are
  not parseable at all, so the `frame.exclusion` checks in both
  `isDefaultEquivalentFrame` and `recognizeSlidingFrame` are dead. Correct as a
  forward guard — whoever adds the parser support gets the safe behaviour for
  free — and the docs already say so.
- **`runtime/emit/window.ts` is 1730 lines.** Long, and a plausible split exists
  (buffered walk / streaming emitter / sliding helpers). Pre-existing, untouched
  by this ticket's subject matter, and not worth churning a file that three
  interacting execution strategies share while they are still being extended.

### Not found

No resource-cleanup, error-handling, or type-safety issues: the rule is pure
recognition over an AST with no I/O or allocation to leak, the runtime changes
are index arithmetic inside an existing loop, and nothing new is typed `any` or
cast. No dead code left behind — the two renamed helpers have no other callers
(the full build confirms).

## Known gaps carried forward

- **`PARTITION BY` never streams** — now `backlog/feat-window-streaming-partitioned`.
  The spec's partitioned cases therefore exercise the buffered walk on both
  databases; they lock semantics but prove nothing about the streaming emitter's
  partition handling under a one-sided frame. Structural, not something the tests
  could route around.
- **No test drives a RANGE one-sided frame wider than the data** beyond the
  existing two-sided `5 preceding and 5 following` case and the new
  `10 preceding` over a 6-row table.
