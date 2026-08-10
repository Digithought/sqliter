---
description: When a query summarizes data two different ways and then sorts or filters by one of those summaries, the engine could silently use the wrong one and return wrong numbers, with no error. Fixed and reviewed.
files:
  - packages/quereus/src/planner/building/function-call.ts        # findMatchingAggregate — the fix
  - packages/quereus/src/planner/building/select-window.ts        # rejectUncollectedAggregates — doc note only
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # HAVING / ORDER BY coverage
  - packages/quereus/test/logic/07.5-window.sqllogic              # grouped + window coverage
difficulty: easy
---

# Aggregate reuse matching compares canonical AST text, not a shallow argument peek

## What shipped

`findMatchingAggregate` (`packages/quereus/src/planner/building/function-call.ts`)
decides whether an aggregate written in HAVING, a top-level ORDER BY, or a window
specification is the one the SELECT list already computed. It used to compare
function name, argument count and DISTINCT, then peek at arguments only when both
sides were bare column refs or both literals — every other argument shape left the
match `true`, so two structurally different aggregates were declared identical and
the clause read the wrong computed column.

The argument loop was replaced by the canonical-AST fingerprint
(`expressionToString(...).toLowerCase()`) already used for this question by
`dedupeNewAggregates` and `buildGroupByCoverage`. The name/arity/DISTINCT
pre-checks were dropped as redundant — the rendered text carries all of them.
`select-aggregates.ts` needed no change: its collect path already keyed on the
same fingerprint and was already building the correct second aggregate; the false
match was shadowing it.

Now correct (each was wrong before), table `wg(a text, b text)` with
`('x','1'),('y','2'),('x','3')`:

- `... group by a order by sum(a+0)` → source order, not the `sum(b+0)` order.
- `... group by a having sum(a+0) > 3` → `[]`, not `[{a:x,s:4}]`.
- the same divergence inside `over (order by ...)` → the pre-existing named
  UNSUPPORTED limitation, not a silently wrong window column.

Known narrowing, documented as a `NOTE:` at `findMatchingAggregate` and mirrored on
`rejectUncollectedAggregates`: the fingerprint renders each argument's qualifier, so
`sum(w.b)` no longer matches `sum(b)`. In HAVING/ORDER BY that is invisible (a second,
redundant aggregate over the same column; identical answer); in a window specification
it degrades to the UNSUPPORTED error. Closing it needs attribute-id binding, which
requires the argument already built — and this function runs before the build.

## Review findings

**Checked:** the implement diff read fresh before the handoff summary; the fingerprint
convention at all four sites that use it (`function-call.ts`, `select-aggregates.ts`
`dedupeNewAggregates`, `select-projections.ts` `collectInnerAggregates`);
`expressionToString`'s literal / identifier / function rendering; the two new
sqllogic blocks; the handoff's three self-declared unverified items; `docs/` for any
file describing aggregate reuse or HAVING matching. Full `yarn lint` and `yarn test`
re-run from the repo root.

**Major — one ticket filed:** `fix/bug-aggregate-match-ignores-string-literal-case`.
The `.toLowerCase()` applied to the whole rendered expression lowercases quoted
string values too, so two aggregates differing only in a literal's capitalization
still false-match — the same silent-wrong-answer class this ticket set out to fix.
Reproduced against the current tree with a scratch mocha spec:
`select g, count(nullif(b,'A')) as c from t group by g having count(nullif(b,'a')) > 1`
returns `[]` where the correct answer is the row (the two aggregates are 1 and 2).
Not a regression from this ticket — the old shallow peek got the same query wrong for
a different reason — but it is residue of the same defect, and the fix's chosen
convention preserves it. The ticket also carries the DRY arm: the three call sites
open-code the same two lines instead of sharing one identity helper, which is why a
correct fix has to touch all of them.

**Minor — fixed in this pass:** the handoff flagged a missing regression for the
window-specification qualifier-divergence case. Confirmed by hand that
`select a, sum(w.b) as s, row_number() over (order by sum(b)) as rn from wg w group by a`
raises the expected UNSUPPORTED error, and added it to the grouped section of
`07.5-window.sqllogic` next to the argument-divergence case.

**Tripwire — recorded, not ticketed:** `findMatchingAggregate` re-renders every
collected aggregate's AST on each call, where the old code early-exited on name and
arity first. Collected-aggregate lists are a handful of entries in practice and the
full suite showed no timing change, so this is conditional, not work. Parked as a
`NOTE:` in that function's doc comment pointing at caching the fingerprint on the
collected entry if a query shape ever makes build time visible.

**Checked and clean, explicitly:**
- *Docs* — no file under `docs/` describes aggregate reuse, HAVING matching, or
  `findMatchingAggregate`; the behavior is documented only at the code site, and the
  implement pass updated both doc comments there. Nothing to update, not "looks fine".
- *Test coverage of the controls* — the 07.3 block covers identical-spelling match,
  DISTINCT participation, alias reference, whitespace/parens normalization, identifier
  case, and the qualifier narrowing; each is a direction a future loosening could break.
- *Handoff's third unverified item* (non-ASCII identifier case under `.toLowerCase()`)
  — not pursued as its own concern; it is subsumed by the filed ticket, which has to
  settle what the identity rendering normalizes.
- *Resource cleanup / error handling / type safety* — the diff adds no allocation,
  no I/O, no catch, and no cast beyond the pre-existing
  `as AggregateFunctionCallNode` guarded by `CapabilityDetectors.isAggregateFunction`.
  Nothing to report.
- *Source hygiene* — `function-call.ts` is 200 lines; the change removed 25 and added
  one. No size or decomposition concern.

**Validation:** `yarn lint` clean (eslint + `tsc -p tsconfig.test.json --noEmit` for
`packages/quereus`; every other package is the intentional no-op). `yarn test` from
repo root: 8686 + 1362 + 725 + 376 + 134 + 113 + 85 + 63 + 34 + 31 + 28 + 22 + 17
passing, 0 failures. No pre-existing failures surfaced.
