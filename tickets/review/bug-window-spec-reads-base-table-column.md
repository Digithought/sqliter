---
description: Sorting or partitioning a window function by a grouping key written a different way than the GROUP BY wrote it — table-qualified, alias-qualified, or as a whole expression — used to crash with an internal error; it now returns results.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # GroupedWindowContext, buildGroupedWindowContext, redirectToGroupKeys, buildGroupKeyColumnRef
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowPhase — applies the redirect, then the strict assert
  - packages/quereus/src/planner/building/select.ts               # ~line 234-250, builds the context handed to the window phase
  - packages/quereus/test/logic/07.5-window.sqllogic              # grouped + window section, ~line 788-950
  - docs/sql-select.md                                            # line ~613, the grouped-window restriction
repro: verified
---

# Window specification in a grouped query can name its grouping key by any spelling

## What shipped

In a grouped query the plan is `Aggregate → [HAVING Filter] → Window → Project`.
The `WindowNode` evaluates its `partition by` / `order by` / argument expressions
over the aggregate's own output row, which carries only the grouping keys and the
aggregate results. Those expressions are built against a scope that falls through
to the pre-aggregate select scope, so several perfectly legal spellings of a
grouping key bound to a **base-table** column the aggregate row never had, and the
query died at runtime with `No row context found for column a`.

Two arms, both in the window phase:

**Arm 1 — redirect.** `redirectToGroupKeys` (select-aggregates.ts) walks each built
window-specification expression and each window-function argument and rewrites every
subtree that *is* a grouping key into a `ColumnReferenceNode` on the AggregateNode's
own output column for that key. Two rules per node, in order:

1. the subtree's canonical AST text equals a GROUP BY expression's — covers
   `group by a || '!'` + `over (order by a || '!')`, and nested occurrences,
   because the walk recurses;
2. the node is a column reference on the *base* attribute id of a bare-column
   grouping key — covers `group by a` + `over (order by wg.a)` / `over (order by
   w.a)`, since every qualifier spelling falls through to the same base attribute.

Otherwise it recurses into scalar children only. The redirect target is built by the
same `buildGroupKeyColumnRef` the select-list path uses (its first parameter widened
from `RegisteredScope` to `Scope`), so the reference publishes the grouping key's own
type and collation.

**Arm 2 — strict guard.** After redirection nothing legitimate may still name a
base-table attribute, so the coverage the window phase asserts is now **AggregateNode
output attribute ids only** — no base group-key attribute ids, no AST fingerprints.
`buildGroupedWindowContext` produces both halves (the two redirect maps plus that
coverage) and replaces the `buildGroupByCoverage` call `select.ts` made at ~line 245.
`validateAggregateProjections`' own `buildGroupByCoverage` call is unchanged — the
select-list caller still needs the loose set.

## Use cases to exercise

All of these are now asserted in `test/logic/07.5-window.sqllogic` (grouped-window
section, ~line 909 onward) against `create table wg (a text, b text)` holding
`('x','1'),('y','2'),('x','3')`. No primary key, so the functional-dependency GROUP BY
reduction cannot rewrite the keys out from under them.

**Should return rows:**

| query | expected |
|---|---|
| `select wg.a, row_number() over (order by wg.a) rn from wg group by wg.a order by rn` | `x,1` / `y,2` |
| `select a, row_number() over (order by wg.a) rn from wg group by a order by rn` | `x,1` / `y,2` |
| `select a, row_number() over (order by w.a) rn from wg w group by a order by rn` | `x,1` / `y,2` |
| `select a \|\| '!' k, row_number() over (order by a \|\| '!') rn from wg group by a \|\| '!' order by rn` | `x!,1` / `y!,2` |
| `select a \|\| '!' k, count(*) over (partition by a \|\| '!') c from wg group by a \|\| '!' order by k` | `x!,1` / `y!,1` |
| `select a \|\| '!' k, row_number() over (order by upper(a \|\| '!')) rn from wg group by a \|\| '!' order by rn` | `x!,1` / `y!,2` (nested — only the inner subtree is rewritten) |
| `select a, max(wg.a) over () m from wg group by a order by a` | `x,y` / `y,y` (the *argument* arm) |

**Should still be rejected at plan time** (the regression fence for arm 2 — the three
pre-existing negatives at ~line 849-857, unchanged message):

- `select a, row_number() over (order by b) rn from wg group by a`
- `select a, count(*) over (partition by b) c from wg group by a`
- `select a, sum(b) over () s from wg group by a`

all → `Column 'b' must appear in the GROUP BY clause or be used in an aggregate function`.

Verified by hand outside the corpus, same message, not added to the corpus:

- `select a, row_number() over (order by wg.b) rn from wg group by a` → rejects on
  `wg.b` (a *qualified* ungrouped column is not accidentally redirected).
- `select a || '!' k, row_number() over (order by b || '!') rn from wg group by a || '!'`
  → rejects on `b` (a same-shaped expression over the *wrong* column is not
  fingerprint-matched).
- `select a, row_number() over (order by a collate nocase) rn from wg group by a`
  → `x,1` / `y,2` (a wrapper around a grouping key survives the redirect).

## Validation run

- `yarn build` — clean.
- `yarn lint` (repo root, fans out; only `packages/quereus` has a real lint) — clean.
- `yarn test` (repo root, all workspaces) — clean, no failures.
- `yarn workspace @quereus/quereus run test` re-run after a final cosmetic refactor of
  `buildWindowPhase` — 8693 passing, 13 pending, 0 failing.
- `packages/quereus/test/logic.spec.ts` alone — 348/348 files passing.

`tickets/.pre-existing-error.md` was not written; nothing failed.

## Known gaps — treat these as the starting points

- **Rule 1 matches by canonical AST text, not resolved identity.** A subtree that
  reads like a grouping key but resolves to something else — a correlated outer
  reference shadowed by an identically-spelled local column — would be redirected
  wrongly. Parked as a `NOTE:` on `redirectToGroupKeys`. This is the same limitation
  `buildFinalAggregateProjections`' `groupByFingerprints` map already carries for the
  select list, so fixing it properly means changing both sites to compare resolved
  attribute identity. I did not attempt to build a failing case for it; if the
  reviewer can construct one, it is a real bug rather than a tripwire.
- **A correlated reference inside a grouped subquery's window specification is still
  rejected**, before and after. The strict coverage set cannot tell a correlated
  reference to an enclosing relation from an ungrouped local one — both get the same
  `must appear in the GROUP BY clause` message. Verified unchanged at HEAD before the
  change, so tightening the guard regressed nothing. `NOTE:` at the assert site in
  `buildWindowPhase`.
- **Naming a grouping key by its SELECT-list alias still fails** (`select a as k,
  row_number() over (order by k) … group by a` → `Column not found: k`), even though
  the same spelling works for an *aggregate* alias. Different root cause, different
  site; tracked as `backlog/bug-window-spec-cannot-name-group-key-by-select-alias`.
  Both the working aggregate-alias case and the failing group-key-alias case are now
  asserted in the corpus, so that ticket has a fence on both sides.
- **The aggregates-without-GROUP-BY path is untouched.** `select.ts` builds the
  grouped window context only when `groupByExpressions.length > 0`, so a windowed
  query with aggregates but no GROUP BY gets neither the redirect nor the coverage
  check — exactly as before. `select count(*) c, row_number() over (order by count(*))
  rn from wg` is rejected earlier by `validateAggregateProjections` with `Cannot mix
  aggregate and non-aggregate columns in SELECT list without GROUP BY`, which is why
  the gap has not bitten; I did not probe it further and there is no corpus assertion
  pinning that message from the window side.
- **The redirect stringifies every node it walks** (`expressionToString` per node, per
  prepare). Same cost profile as the `assertGroupByCoverage` walk that already ran
  there, over window specifications only, so it is small — but it is not measured, and
  I did not add a NOTE for it since the pre-existing walk carries the same shape.
- **Corpus coverage is memory-backend only** (`yarn test`). `yarn test:store` was not
  run; this is a pure planner-building change with no vtab/storage surface, so a store
  divergence would be surprising, but it is unverified.
