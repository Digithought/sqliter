---
description: Fixed a summary query that sorts by two things at once — a summary it does not display, plus one of its own result column names — which used to fail with "Column not found" instead of returning rows.
files:
  - packages/quereus/src/planner/building/select.ts             # early placement deleted; corrected tripwire NOTE at the surviving applyOrderBy call (~line 374)
  - packages/quereus/src/planner/building/select-aggregates.ts  # orderByNeedsPostAggregateSort dropped from buildAggregatePhase's return
  - packages/quereus/src/planner/building/select-modifiers.ts   # OrderByOptions doc comment: "three call sites" -> "both call sites"
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # implement-stage coverage from ~line 462; review added 8 more cases at the end
  - docs/runtime.md                                             # redirectPostAggregate bullet updated; new subsection after the grouped-plan boundary check
difficulty: medium
---

# Retired the early ORDER BY placement for aggregate queries

## What changed

An aggregate query's `ORDER BY` used to be planned in one of two positions, and each
position could see names the other could not:

- **Early**, between the aggregation and the final projection — taken only when
  `ORDER BY` named an aggregate the `SELECT` list did not contain. Select-list `as`
  aliases do not exist yet in that position.
- **Late**, above the final projection — every other aggregate `ORDER BY`. Aliases
  are in scope there.

An `ORDER BY` that needed both lost, failing with `Column not found: c`. The early
placement is gone: every aggregate `ORDER BY` now sorts in the late position, which
sees both name sets.

Plan shape changed for exactly one family of queries — those whose `ORDER BY`
introduces an aggregate the SELECT list lacks — and only by swapping two adjacent
nodes:

```
before:  Project(select list) → Sort → Aggregate
after:   Sort → Project(select list) → Aggregate
```

which is the shape every other aggregate `ORDER BY` already had.

Sites:

- `select.ts` — the early-placement `if` block, its comment, the `orderByAppliedEarly`
  local and the `if (!orderByAppliedEarly)` guard are deleted; the guard's body is now
  unconditional.
- `select-aggregates.ts` — `orderByNeedsPostAggregateSort` dropped from
  `buildAggregatePhase`'s return type and returned object (the deleted branch was its
  only consumer). The *local* `needsPostAggregateSort` and `hasOrderByOnlyAggregates`
  both stay; they still gate `collectOrderByAggregates`, the `preAggregateSort`
  decision, `needsFinalProjection`, and `preserveForAggregate`.
- `docs/runtime.md` — the `redirectPostAggregate` bullet no longer names the deleted
  placement.

## Why the surviving placement can still resolve a sort-only aggregate

A sort key like `max(b)` in `select a, count(*)+1 as c from g group by a order by
max(b), c` binds to the `AggregateNode`'s own output attribute. The final `ProjectNode`
does not list that attribute among its output columns — yet the `SortNode` above it
still reads it, because `emitProject` (`runtime/emit/project.ts:31-51`) sets two row
contexts per row (its own output row *and* its source row) and keeps the source one
live while it yields. The sort evaluates its keys during that pull, before buffering.
This is `docs/runtime.md` § "Invariant: source-attr contexts and child pulls".

## Tripwire (not a ticket)

The placement is sound only while every node between the final `ProjectNode` and the
`SortNode` is **streaming**. Exactly one can sit there today — the `DistinctNode` of a
`DISTINCT` query, which yields each surviving row straight through. A *buffering* node
landing in that gap would leave the sort-only aggregate key without a row context and
the query would die with `No row context found`.

Parked in two places, both corrected during review (the implement-stage wording said the
gap was empty, which it is not):

- the `NOTE:` at the surviving `applyOrderBy` call in `select.ts`, with the remedy —
  widen the final projection with one `ColumnReferenceNode` projection per sort-only
  aggregate, sort above that, add a stripping projection above the sort; `LIMIT` stays
  above the strip, `DISTINCT` is the awkward one because it must keep deduping on the
  select-list columns alone;
- a new `docs/runtime.md` subsection, "The one binding that does depend on a source-attr
  context", directly under the grouped-plan boundary-check discussion, which otherwise
  reads as "plan-time binding must never depend on this" with no exception named.

## Review findings

Reviewed the implement diff (`7461c1c07`) cold against the source, then the handoff.
No major findings — nothing warranted a new ticket. Seven minor findings, all fixed in
this pass.

**Fixed — correctness of the load-bearing comment**

- `select.ts` — the tripwire `NOTE:` claimed "nothing sits between the final ProjectNode
  and this SortNode. Nothing does today", and its remedy claimed "DISTINCT and LIMIT
  already sit above this sort". Both wrong for `DISTINCT`: `applyDistinct` runs on the
  line immediately above `applyOrderBy`, so a `DistinctNode` sits *between* the
  projection and the sort in every `DISTINCT` query. The plan is still correct — a
  `DistinctNode` yields per source row rather than buffering (`runtime/emit/distinct.ts`),
  so the projection's source context is still live — but the stated reason was "the gap
  is empty" when the real reason is "everything in the gap streams". A future reader
  checking the tripwire would have found the claim false and had to re-derive why the
  code works. Rewrote the NOTE around the streaming condition and corrected the remedy's
  `DISTINCT` clause.
- `select-modifiers.ts` — `OrderByOptions`'s doc comment justified the options object by
  "the three call sites (select.ts)". The diff deleted one; two remain. Changed to
  "both call sites".

**Fixed — docs out of step with the new reality**

- `docs/runtime.md` § "Corollary: a published source row reaches only the adjacent
  consumer" states flatly that **plan-time binding must never depend on** a source-attr
  context, and the diff makes exactly one deliberate exception to that without saying so
  anywhere in the docs. Added a subsection naming the exception, its condition (streaming
  nodes only in the gap), and why it is not an invitation to bind that way elsewhere
  (the grouping-key redirect and `assertGroupedPlanCoverage` still forbid binding a
  *pre-grouping* attribute above the aggregate). `yarn docs:check` passes.
- Swept the rest of the docs for the retired placement: `grep` over `docs/`,
  `packages/quereus/docs/`, `packages/quereus/README.md`, and `src/` finds no other
  mention. The one bullet the implementer edited was the only stale text.

**Fixed — test gaps. Eight cases added at the end of
`test/logic/28.2-orderby-expression-extras.sqllogic`; every expectation taken from real
SQLite (`node:sqlite`) on the same fixture, not from Quereus.**

- **`DISTINCT` that actually collapses rows** (3 cases, fixture `sod`). The
  implement-stage `DISTINCT` cases could never dedupe — their group keys or counts were
  all distinct — so the one node that can sit in the load-bearing gap was never exercised
  doing its job. `sod` gives two groups with the same count and different `max(v)`, so
  the sort-only aggregate's direction is observable in what survives dedup
  (asc → `3,2`; desc → `2,3`). Quereus matches SQLite on all three, which pins both that
  the key resolves through a `DistinctNode` and that dedup happens below the sort.
- **A SELECT-list alias shadowing a real column of the table** (2 cases, fixture `sh`
  with a column literally named `c`): `order by max(c), c` must read the table's `c`
  inside the aggregate and the alias for the bare key. Matches SQLite.
- **The same pairing under other builders** (2 cases): inside a `with` CTE body, and on
  the window path — whose `ORDER BY` never went through the retired branch, so this pins
  that the two paths now agree.
- **The boundary check is not relaxed by the sort-only aggregate** (1 error case):
  `order by max(b), b` where `b` is neither grouped nor aggregated must still be rejected
  at plan time with the user-facing `Column 'b' must appear in the GROUP BY clause…`
  message, not ship a plan that dies at run time with `No row context found`. Confirmed.
  This is the regression the moved sort could most plausibly have caused and the implement
  ticket had no case for it.

**Checked, nothing found**

- **Dangling references to the removed return field** — `orderByNeedsPostAggregateSort`
  survives only as the local helper function and its own name in prose; no consumer of
  the dropped `buildAggregatePhase` field remains. `hasOrderByOnlyAggregates` still has
  its three live uses.
- **Optimizer rules that could drop a buffering node into the gap** — read every rule
  that can insert or reorder a node around a `ProjectNode`. `rule-projection-pruning`
  fires only on `Project`-over-`Project` and never reaches this shape; the `cache/` rules
  attach a `CacheNode` at a CTE, a scalar subquery, or a join's right side, none of which
  is this gap. Nothing today lands there.
- **Type safety, error handling, resource cleanup** — the diff is a deletion plus a
  comment; it adds no error path, no allocation, no `any`, and narrows a return type.
  Nothing to find, stated explicitly rather than left silent.
- **Source size** — `select.ts` 956 lines, `select-aggregates.ts` 1,643 (`wc -l`); the
  diff shrinks both. `select-aggregates.ts` is already listed in
  `backlog/debt-oversized-source-files` at 1,645 lines, so this is evidence the file is
  drifting down, not a new ticket. The site-claim grep over the open board found no other
  ticket claiming these files' relevant sites.

**Considered and declined (no ticket)**

- The implementer asked whether the tripwire deserves a mechanical assertion rather than
  prose. Declined: there is no node characteristic for "buffers its input" today
  (`planner/framework/characteristics.ts` has only the materialization *hint*), so an
  assertion would first have to introduce and correctly populate that property across
  every relational node — a design change out of proportion to a gap that can hold
  exactly one node type today. The remedy is written at the site and now in the docs, so
  the cost of discovering this late is a comment away.
- A property/generated test over aggregate `ORDER BY` clauses (the implementer's other
  self-criticism) would cover the class rather than the listed instances, but it needs a
  clause generator and a SQLite oracle harness, neither of which exists in this suite.
  Not filed: no evidence of a recurring class here — this is the second `ORDER BY`
  placement defect, and the fix removes the branch that caused both.

**Not chased**

- The implement ticket's note about the suite total moving by one. Both review runs here
  report the same total (10,198 tests) with zero failures, and nothing in this diff can
  add or remove a test case. Left as recorded; not investigated further.

## Validation

- `yarn lint` — clean (twice: before and after the review edits).
- `yarn build` — clean.
- `yarn docs:check` — `Docs OK: links resolve, invariants well-formed, sizes within
  ratchet, doc and package tiers declared.`
- `yarn workspace @quereus/quereus run test` — **10,173 passing, 25 pending, 0 failing**
  (10,198 tests), re-run after all review edits.
- `yarn workspace @quereus/quereus run test:context-strict` — 10,176 passing, 22 pending,
  0 failing. This is the run that matters most for the new plan shape: it asserts the
  operator-shadows-child direction of the very row-context invariant the sort-only
  aggregate key depends on.
- `yarn test:store` not run, in both stages — the change is planner-only and
  backend-independent. Deliberate omission.

## Filed separately, not fixed here

`backlog/bug-ungrouped-aggregate-rejects-constant-select-item` — `validateAggregateProjections`
rejects *any* non-aggregate select-list item in an ungrouped aggregate query, including
constants that reference no column (`select 'total' as label, count(*) from t`), which
SQLite accepts. Independent of `ORDER BY` and verified at HEAD before this change. Ticket
reviewed and reads well: plain-language description, `repro: verified`, severity,
likelihood, and an honest `tradeoffs:` line. A comment in the new test section names the
slug where the missing matrix cell would go.
