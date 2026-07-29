---
description: Window queries whose frame is one-sided — "the previous 2 rows through the current row", or "the current row through the next 3" — now run in one streaming pass instead of sorting and holding the whole group of rows in memory.
prereq:
files:
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts   # the recognition change
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts           # new spec (streaming vs buffered equivalence)
  - packages/quereus/test/logic/07.5-window.sqllogic                     # new value-level cases
  - docs/window-functions.md                                             # eligibility table + bail conditions
  - docs/optimizer-streaming.md                                          # precondition list
difficulty: medium
---

# Streaming coverage for one-sided sliding window frames — review handoff

## What changed

Only the optimizer's *recognition* changed. No runtime emitter code was touched:
the sliding-frame state machine in `runtime/emit/window.ts` already handled a
zero offset on either side, so a one-sided frame reduces to the two-sided form it
already ran.

**`recognizeSlidingFrame` (rule-monotonic-window.ts)** was rewritten around a new
`readFrameOffset(bound, direction, mode)` helper. A frame now qualifies when its
start bound is `n PRECEDING` **or `CURRENT ROW`** and its end bound is
`m FOLLOWING` **or `CURRENT ROW`** — or absent entirely, since a start-only frame
(`ROWS 2 PRECEDING`) means `... AND CURRENT ROW`. `CURRENT ROW` maps to offset
zero:

| written frame | offsets handed to the emitter |
|---|---|
| `between n preceding and current row` | `preceding=n, following=0` |
| `between current row and m following` | `preceding=0, following=m` |
| `between current row and current row` | `preceding=0, following=0` |
| `rows n preceding` (start-only) | `preceding=n, following=0` |

`UNBOUNDED PRECEDING AND CURRENT ROW` is deliberately *not* matched here — the
callers check `isDefaultEquivalentFrame` first, so it keeps routing to the cheaper
running-accumulator path. There is a test pinning that.

**A second, unplanned change** (see *Bug found and fixed* below): RANGE-mode
sliding frames now additionally require the single ORDER BY key's logical type to
be numeric (`isRangeSlidingEligible`). Previously the rule only checked that
there was exactly one ORDER BY key.

**A tripwire was recorded**, not filed as a ticket: a `NOTE:` comment in
`rule-monotonic-window.ts` at the partition-prefix check explaining that no
`PARTITION BY` window can stream today (a table access advertises `monotonicOn`
for its leading unbound index column only, so on an index `(g, k)` the
advertisement names `g` and the leading-ORDER-BY-key check rejects
`partition by g order by k`). Same point is spelled out as a bail-condition
bullet in `docs/window-functions.md`. This is pre-existing and equally true of
the two-sided frames that shipped earlier — nothing in this ticket changed it.

## Bug found and fixed (worth the reviewer's attention first)

While checking the RANGE peer-tie mapping the ticket asked about, a **pre-existing
divergence** surfaced: with a **TEXT** ORDER BY key under a numeric RANGE offset,
the streaming and buffered emitters return different answers. Reproduction, on
the code as it stood *before* this ticket:

```sql
create table rt (id integer primary key, k text, v integer);
create index rt_k on rt (k);
insert into rt values (1,'a',1),(2,'a',2),(3,'b',4),(4,'c',8);
select id, count(*) over (order by k range between 1 preceding and 1 following) c
from rt order by k, id;
-- streaming: c = 4,4,4,4   (whole non-numeric run treated as one span)
-- buffered:  c = 1,1,1,1   (bounds collapse to the current row)
```

The streaming range scan does its bound arithmetic in `Number` space and treats
any non-finite value as part of one contiguous peer span; the buffered walk's
`findRangeOffsetStart/End` bail to `currentIndex` for a non-finite value. Neither
is obviously "right" — a numeric RANGE offset over TEXT is not defined by the SQL
standard — but they must not disagree.

This mattered for this ticket because `range between current row and current row`
is the shape where the buffered answer is clearly correct (the peer group) and the
streaming answer clearly wrong, and the change would have newly routed it to
streaming. Rather than leave a known-wrong answer newly reachable, the rule now
declines RANGE sliding entirely when the ORDER BY key isn't numeric, so those
queries stay on the buffered path. `packages/quereus/test/plan/window-one-sided-frames.spec.ts`
has a test locking this for all four bound combinations.

**Reviewer judgment call:** the buffered path's own behaviour for a non-numeric
RANGE key is still incoherent — `between 1 preceding and 1 following` yields
frames of 1 row while `between current row and current row` yields the full peer
group of 2. Arguably Quereus should reject a numeric RANGE offset against a
non-numeric ORDER BY key outright (Postgres and SQLite both error). That is a
separate decision about SQL surface behaviour and was left alone; if the reviewer
agrees it should be an error, that's a new `plan/` ticket, not an inline fix.

## How to validate

```
yarn workspace @quereus/quereus run build
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/plan/window-one-sided-frames.spec.ts"
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "07.5"
```

Full `yarn build`, `yarn test`, and `yarn workspace @quereus/quereus run lint`
were all run clean. No pre-existing failures encountered.

### Use cases the tests cover

`window-one-sided-frames.spec.ts` (16 cases) runs **every** query twice — once
normally, once on a database with the `monotonic-window` rule disabled — and
requires deep-equal results, plus asserts off the `WindowNode`'s `streaming`
property that the streaming path really engaged (and really didn't, on the
buffered database).

- ROWS: `2 preceding and current row`, start-only `rows 2 preceding`,
  `current row and 2 following`, `current row and current row`.
- ROWS trailing MIN / MAX / AVG / COUNT — the moving-average and running-min-max
  shapes the ticket named.
- `FIRST_VALUE` / `LAST_VALUE` under one-sided frames.
- An all-NULL argument window under a one-sided frame (must yield NULL, not the
  empty accumulator).
- RANGE with real peer ties (two rows sharing an ORDER BY value, reached via a
  non-unique secondary index), at both edges of the frame and for
  `current row and current row` where the frame *is* the peer group.
- Non-numeric ORDER BY key under RANGE — must stay buffered (the fix above).
- `UNBOUNDED PRECEDING AND CURRENT ROW` in all four spellings still resolving to
  `runningAgg`, never `slidingAgg`.
- A one-sided frame, a default frame, and `row_number()` in one query — separate
  frames land in separate WindowNodes and each keeps its own strategy.
- `PARTITION BY` per-partition frame restart, ROWS, both directions.
- Shapes that must stay buffered: `current row and unbounded following`,
  `unbounded preceding and 1 following`, `1 following and 3 following`, and
  `sum(distinct …)`.

`07.5-window.sqllogic` gained value-level cases for the same ROWS and RANGE
shapes with hand-computed expectations (including a partitioned trailing sum and
a NULL-argument trailing sum), so the answers are pinned independently of the
"both shapes agree" harness.

## Known gaps — please treat these as starting points

- **`PARTITION BY` never streams.** The partitioned tests in the spec therefore
  exercise the buffered walk on *both* databases; they lock semantics but prove
  nothing about the streaming emitter's partition handling under a one-sided
  frame. This is the biggest hole in the coverage and it is structural, not
  something the tests could route around. See the `NOTE:` in the rule.
- **RANGE peer ties depend on the optimizer picking the secondary index.** The
  spec's RANGE cases only stream because the plan chooses the `r_k` index scan;
  an unrelated cost-model change could silently drop them to the buffered path
  and the `expectStreamingModes` assertions would catch it — but as failures
  that look like this ticket's fault when they aren't. Worth knowing.
- **No test drives a frame wider than the data in RANGE one-sided mode** beyond
  the existing two-sided `5 preceding and 5 following` case.
- **Non-integer RANGE offsets** (`range between 1.5 preceding and current row`)
  are accepted by the recognizer (RANGE allows any finite non-negative literal)
  but are not covered by a test.
- **Frame exclusion** (`EXCLUDE CURRENT ROW` etc.) is not parseable at all, so
  the `exclusion` guards in both `isDefaultEquivalentFrame` and
  `recognizeSlidingFrame` are currently unreachable. They were left in place as
  a forward guard, and the docs now say so.
