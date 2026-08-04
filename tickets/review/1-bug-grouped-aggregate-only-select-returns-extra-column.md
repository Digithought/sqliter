---
description: A query that groups rows and asks only for a count used to hand back the column it grouped on too, and grouped queries could return their columns in the wrong order; both are fixed and verified, and the fix was hardened against a queued change that would have silently broken it.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts          # aggregateOutputIsSelectList + needsFinalProjection
  - packages/quereus/src/planner/building/select.ts                     # passes starProjectionsByColumn into buildAggregatePhase
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic   # result coverage
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts         # column-name/order + plan-shape coverage
  - packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic  # updated: had pinned the buggy shape
  - packages/quereus/test/incremental/delta-aggregate.spec.ts           # the routing that constrained the fix
difficulty: medium
repro: verified
---

# Grouped query returns exactly its select list

The fix itself landed in commit `3f507aac`. This ticket covers the independent
verification pass over it, plus the small amount of work that pass turned up.

## What the bug was

An `AggregateNode` publishes exactly its grouping keys (in `GROUP BY` order)
followed by its aggregate results. When the planner built no projection above it,
the aggregate node *was* the query root, so its shape became the statement's
result shape instead of the select list's — leaking the grouping key, or handing
the columns back in `GROUP BY` order rather than select-list order.

`needsFinalProjection` decided whether to build that projection from questions
like "does any select-list expression need rebuilding?" — never from "does the
aggregate's output actually match the select list?". `aggregateOutputIsSelectList`
now asks exactly that, and the projection is skipped only on an exact positional
match.

Always projecting would have been wrong: a grouped materialized-view body
(`select k, count(*) c, sum(a) s from src group by k`) must stay a bare
aggregate-over-scan, or its incremental maintenance re-routes from
residual-recompute to full-rebuild. That body's select list already agrees with
the aggregate output, which is the property the predicate keys off.

## What this pass verified

Each TODO from the implement ticket, and what came of it:

- **Build, tests, lint, typecheck** — all clean against the current tree.
- **The predicate's assumptions about `analyzeSelectColumns`** — confirmed by
  reading both. `buildSelectStmt` pushes expanded star projections first, then
  the non-aggregate select-list columns in order (`select.ts:161-174`);
  `analyzeSelectColumns` collects aggregates in select-list order and routes
  window and non-aggregate items into `projections`
  (`select-projections.ts:162-211`).
- **The cases where the predicate's answer is irrelevant** — confirmed
  short-circuited by an earlier term, and confirmed correct end-to-end by running
  them. Wrapped aggregates (`count(*) + 1`, `case when count(*) > 1 …`) are
  caught by `hasWrappedAggregates`; `HAVING`-only and `ORDER BY`-only aggregates
  by their own flags. All three produce a projection and correct columns.
- **A select-list item that is a scalar subquery containing an aggregate** —
  confirmed classified as a non-aggregate item, and correct.
  `select (select count(*) from u) su, count(*) c from nk group by a` returns
  `su, c`. It is now a permanent test rather than a spot-check.

Two things the pass found beyond the TODO list, both handled — see below.

## What changed in this pass

**Hardening — removed a positional assumption that was about to break.**
`aggregateOutputIsSelectList` walked into the shared projection list at a computed
offset, relying on the "stars first, named columns after" layout.
`fix/1-bug-star-in-select-list-ignores-its-position` is queued and will change
exactly that layout to written order — at which point the offset would have gone
silently wrong, mis-deciding whether to project. It now excludes the star entries
by object identity and reads the rest in order, which holds under either layout.
Behavior today is unchanged; the full suite confirms it. A note on the star ticket
tells its implementer this second reader exists and needs no attention.

**Three regression cases that were genuinely broken before the fix.** Verified by
running the same queries against `63d99922` (the parent commit) in a scratch
worktree:

| query | before the fix | now |
|---|---|---|
| `select count(*) c1, count(*) c2 from nk group by a` | `a, c1, c2` | `c1, c2` |
| `select count(distinct b) c from nk group by a` | `a, c` | `c` |
| `select a, a, count(*) c from nk group by a` | `a, c` (a column dropped) | `a, a:1, c` |

The third is the opposite mismatch from the reported one — the select list is
*shorter* than the aggregate output — and nothing covered it. All three are now
pinned in both test files, alongside the scalar-subquery case.

## Known gaps — read these

- **`yarn test:store` was not run** (LevelDB-backed re-run of the logic suite; too
  slow for an agent turn). The change is planner-only and storage-agnostic, so it
  is unlikely to matter, but it is untested on that path.
- **Window functions in a grouped select list crash** — `select a, row_number()
  over (order by a) rn from nk group by a` fails with `No emitter registered for
  WindowFunctionCall`. This is **not** caused by this change: it reproduces
  identically at `63d99922`, and `needsFinalProjection` was already true for those
  queries before and after. Filed as
  `fix/bug-window-function-over-grouped-query-crashes` with the root-cause site
  named. Flagged here because it is the one grouped-query shape this ticket's
  guarantee does *not* hold for, and a reviewer probing grouped select lists will
  hit it.
- **The `!hasAggregates` term and `aggregateOutputIsSelectList` overlap.** For an
  aggregate-free grouped query whose select list already agrees with the group
  keys (`select g from gk group by g`), the shape check would permit dropping the
  projection but the older term forces it anyway. Collapsing the two would remove
  a plan node from those queries. Deliberately not done — it narrows behavior that
  `test/planner/groupby-key-completeness.spec.ts` and
  `test/plan/grouped-projection-shape.spec.ts` depend on, and it is a separate
  change from fixing the bug.
- **A tripwire, parked at its code site**, not filed: `containsAggregateFunction`
  resolves function schemas while walking each select-list expression, once per
  prepare of a grouped query, on top of the walk `analyzeSelectColumns` already
  does. Unmeasured. `NOTE:` comment above the function says what to do if it ever
  shows up.

## A test had pinned the bug

`test/logic/07.7-scalar-agg-decorrelation.sqllogic` asserted that

```sql
select p.id, (select count(*) from cc where cc.pid = p.id group by cc.pid) as n from p where p.id = 1;
```

fails with *"Scalar subquery must return exactly one column"* — an error that only
existed because the subquery leaked its grouping key as a second column. It is a
legal one-column scalar subquery and now runs. The file was updated (not deleted)
to assert the correct results, plus two cases that were previously unreachable: an
outer row matching no inner row yields `null` (no group is formed at all, so the
"count bug" 0 does not apply), and grouping on a column the correlation does not
pin still raises *"Scalar subquery returned more than one row"*.

## What to poke at

The predicate is the whole fix, so the productive attack is finding a grouped
select list where it answers "shapes agree" but they do not (a leaked or reordered
column), or where it answers "disagree" for a query that must stay a bare
aggregate (which would re-route materialized-view maintenance — watch
`test/incremental/delta-aggregate.spec.ts`).

Directions not exhausted here: grouped queries under `DISTINCT`, `LIMIT`, or set
operations; grouping keys that are expressions rather than bare columns combined
with stars; `GROUP BY` on a joined source where two sources share a column name;
and grouped bodies of non-materialized views. Ordinary aggregate coverage
(`07-aggregates`, `25-aggregate-edge-cases`, `92-hash-aggregate-edge-cases`)
passes, but none of it was written with output *shape* in mind.

## Validation run

- `yarn build` — clean.
- `yarn test` — 0 failing; quereus 8639 passing, 13 pending (8636 before this
  pass; +3 from the new spec cases).
- `yarn workspace @quereus/quereus run lint` and `run typecheck` — clean.
- `test/incremental/delta-aggregate.spec.ts` passes, including its create-time
  routing pins.

One incident worth recording: partway through this pass I removed a scratch git
worktree that I had given a junction to the repo's `node_modules`, and the
recursive delete followed yarn's workspace symlinks back into `packages/`,
deleting 1714 tracked files and `node_modules`. Every deleted file was unmodified
at `HEAD` (the tree held no other changes), so `git checkout -- .` plus
`yarn install` restored it exactly, and the full validation above was then re-run
from scratch and matches. Nothing in the diff is affected; noted only so the
record is accurate.
