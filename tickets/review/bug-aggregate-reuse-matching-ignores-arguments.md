---
description: When a query summarizes data two different ways and then sorts or filters by one of those summaries, the engine could silently use the wrong one and return wrong numbers, with no error. Fixed.
files:
  - packages/quereus/src/planner/building/function-call.ts        # findMatchingAggregate — the fix
  - packages/quereus/src/planner/building/select-window.ts        # rejectUncollectedAggregates — doc note only, no logic change
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # HAVING / ORDER BY coverage (new block at EOF)
  - packages/quereus/test/logic/07.5-window.sqllogic              # grouped + window coverage (new case ~line 865)
difficulty: easy
---

# Aggregate reuse matching now compares canonical AST text, not a shallow argument peek

## What changed

`findMatchingAggregate` (`packages/quereus/src/planner/building/function-call.ts`)
used to decide "does this HAVING/ORDER BY/window-spec aggregate spelling match a
SELECT-list aggregate already computed?" by comparing function name, arg count,
DISTINCT flag, then a shallow per-argument peek that only understood bare column
refs and literals — any other argument shape (`b+0`, a qualified column, a nested
expr) fell through with the match left `true`. Two structurally different
aggregates were declared identical, and the clause silently read the wrong
computed column.

Fix: replace the argument loop with the canonical-AST fingerprint
(`expressionToString(...).toLowerCase()`) that `dedupeNewAggregates` and
`buildGroupByCoverage` already use for this same question elsewhere in the
planner. Name/arity/DISTINCT pre-checks were dropped as redundant — the
fingerprint captures all of it — replaced by a single string-equality check
against `expressionToString(aggFuncNode.expression)`.

No change was needed in `select-aggregates.ts` — `collectHavingAggregates` /
`collectOrderByAggregates` already keyed on the same fingerprint and were already
building the right (second) aggregate for an unmatched spelling; the bug was
purely that `findMatchingAggregate` was shadowing that correct work by returning
a false-positive match first.

## Verified behavior (was wrong at HEAD before this ticket, now correct)

Table `wg(a text, b text)`, rows `('x','1'),('y','2'),('x','3')`:

- `select a, sum(b+0) s from wg group by a order by sum(a+0)` — now returns
  `[{a:x,s:4},{a:y,s:2}]` (source order, since `sum(a+0)` is 0 for every group).
  Previously returned rows in the wrong order because ORDER BY silently reused
  the `sum(b+0)` column.
- `select a, sum(b+0) s from wg group by a having sum(a+0) > 3` — now returns
  `[]`. Previously returned `[{a:x,s:4}]` because HAVING silently reused
  `sum(b+0)`.
- `select a, sum(b+0) s, row_number() over (order by sum(a+0)) rn from wg group
  by a` — now raises the existing (pre-existing, unrelated-ticket) plan-time
  error `Aggregate function sum in a window function's ORDER BY is only
  supported when the same aggregate also appears in the SELECT list`. This is
  the intended degrade path, not a new limitation — see "Known narrowing"
  below.

## A narrowing, intentionally left as a tripwire, not fixed here

The fingerprint includes each argument's table qualifier, so `sum(w.b)` no
longer matches `sum(b)` even when `w` is the only table in scope (previously it
did, via the shallow column-name peek). Consequences, both verified:

- In HAVING/ORDER BY this is invisible to the caller: the collect path builds a
  second aggregate over the same column and the answer is identical (one extra
  computed column, no correctness or observable-order impact). Covered by
  `select a, sum(w.b) as s from wg w group by a having sum(b) > 3` in
  `07.3-group-by-extras.sqllogic`.
- In a window specification it now hits the UNSUPPORTED error above instead of
  resolving. Not covered by a regression test (the ticket's TODO list didn't
  call for one beyond the same-qualifier case already in `07.5-window.sqllogic`)
  — flagging as a reviewer gap, not asserting it's fine.

Recorded as a `NOTE:` doc comment at the `findMatchingAggregate` definition and
a corresponding note on `rejectUncollectedAggregates` in `select-window.ts` per
the ticket's instruction — resolving it would require binding each argument to
an attribute id, which needs the argument already built, and this function runs
before the build by design. `feat-aggregate-inside-window-function-argument` in
`backlog/` is the separate ticket that would lift the underlying window
limitation this degrades into.

## Test coverage added

`07.3-group-by-extras.sqllogic` (new block at EOF, table `wg`): the two
previously-wrong HAVING/ORDER BY queries above, plus controls that must keep
working — `count(*)` identical-spelling match, `count(distinct b)` DISTINCT
participation, SELECT-list alias reference (resolves via output scope, doesn't
touch this function), whitespace/redundant-parens normalization
(`sum(b+0)` vs `sum(b + 0)`, `sum(b)` vs `sum((b))`), identifier case
(`sum(B)` vs `sum(b)`), and the qualifier-narrowing case above.

`07.5-window.sqllogic` (~line 865, grouped section): one new case asserting the
window-spec UNSUPPORTED error fires for an argument-only divergence
(`sum(b+0)` in SELECT list vs `sum(a+0)` in `over (order by ...)`), alongside
the pre-existing `count(*)` divergence case it sits next to.

## What the reviewer should treat as unverified

- No regression test for the window-specification qualifier-divergence case
  (`sum(w.b)` in SELECT list vs `sum(b)` in a window ORDER BY) — only the
  HAVING/ORDER BY qualifier case is asserted. Worth a quick manual check if time
  allows; low risk since it degrades to an existing, already-tested error path
  rather than a silent wrong answer.
- Fix was validated by full `yarn test` (all packages, 0 failures) and `yarn
  lint` (clean: eslint + `tsc -p tsconfig.test.json --noEmit` for
  `packages/quereus`) run from repo root after the change — not re-verified
  independently by a second pass; standard reviewer re-run recommended.
- `expressionToString` is used case-insensitively (`.toLowerCase()`) to match
  `dedupeNewAggregates`'s convention; no case-sensitivity edge case (e.g.
  non-ASCII identifiers) was explored beyond the ASCII `sum(B)` vs `sum(b)`
  control.
