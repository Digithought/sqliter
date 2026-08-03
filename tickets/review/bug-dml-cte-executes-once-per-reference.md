---
description: A query can name a block that inserts, updates or deletes rows and hands them back; naming that block more than once used to run the write once per mention instead of once. Fixed, with row-set and plan-shape tests.
files:
  - packages/quereus/src/planner/building/with.ts                     # buildCommonTableExpr — forces materialize for DML bodies
  - packages/quereus/src/planner/nodes/cte-node.ts                    # CTENode — tableDescriptor now threaded, toString gained [buffered]
  - packages/quereus/src/planner/framework/characteristics.ts         # CTECapable gained tableDescriptor
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts # passes the descriptor through
  - packages/quereus/src/planner/cache/materialization-advisory.ts    # passes the descriptor through; comments updated
  - packages/quereus/src/runtime/emit/cte.ts                          # buffer keyed on tableDescriptor, not plan.id
  - packages/quereus/src/runtime/emit/recursive-cte.ts                # comment + map generic aligned
  - packages/quereus/src/runtime/types.ts                             # cteMaterializations key type narrowed to TableDescriptor
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic       # NEW — row-set + base-table-state coverage
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts             # NEW describe block — plan-level invariants
  - docs/optimizer.md                                                 # § Materialization Advisory
  - docs/runtime-caching.md                                           # § Shared CTE materialization
repro: verified
difficulty: medium
---

# Review: a data-modifying `with` block runs once per statement

## What changed and why

`with c as (insert into t … returning …) select …` must run its write exactly once per
statement execution, however many times the rest of the query names `c`. It was running once
per mention: `UNIQUE constraint failed` for `insert`, a silent double-increment for `update`,
and a second mention of a `delete` seeing an empty result.

Two independent causes, both fixed:

**A — the reference count undercounts.** Two mentions using the same alias (e.g.
`(select count(*) from c)` twice) share ONE `CTEReferenceNode`, so the `CTENode` shows a single
parent and the materialization-advisory gate reads "referenced once" — while that single
reference node is still emitted and driven twice. Fix: `buildCommonTableExpr` now constructs a
CTE with a data-modifying body (`insert` / `update` / `delete`) with `materialize = true`
outright, never consulting that gate. `markCTEMaterialization`'s existing `!node.materialize`
guard leaves the already-marked node alone. An explicit `not materialized` hint is deliberately
overridden — honoring it would license a second write. Read-only bodies are untouched and keep
flowing through the normal reference-count gate.

**B — the buffer key was not stable across plan rewrites.** `emitCTE` keyed its per-execution
buffer on `plan.id`, which is only correct while every mention points at one `CTENode` object.
The constant-folding pass (`replaceBorderNodes`) has no memo, so a node reachable from two
parents is rebuilt once per parent path — a `values`-bodied DML CTE really does end up as two
`CTENode` instances, two ids, two buffers. `ruleCteOptimization`, `markCTEMaterialization` and
`CTENode.withChildren` each also let the constructor mint a fresh `tableDescriptor`. Fix: the
descriptor is now an optional trailing constructor parameter threaded through all three sites,
and `emitCTE` keys the buffer on `plan.tableDescriptor`. This mirrors `RecursiveCTENode` /
`emitRecursiveCTE`, which already worked this way.

Both edits are required — neither alone fixes every case.

Beyond the five edits the fix ticket specified:

- `CTECapable` (`planner/framework/characteristics.ts`) gained `readonly tableDescriptor`, so
  `ruleCteOptimization` can read it off the capability type rather than a second `instanceof`.
  Both implementers already declared it via `CTEPlanNode`.
- `RuntimeContext.cteMaterializations` narrowed from `Map<string | TableDescriptor, …>` to
  `Map<TableDescriptor, …>` — with `emitCTE` moved off plan ids, nothing keys it by string any
  more. Comments in `runtime/types.ts`, `emit/recursive-cte.ts` and both docs updated to match.
- `CTENode.toString()` now appends ` [buffered]` when `materialize` is set, matching
  `RecursiveCTENode.toString()`. No golden plan file contains a CTE, so nothing needed
  regenerating (checked: `grep -rln CTE test/plan/{basic,joins,aggregates}` is empty).

## Verification

Every row of the fix ticket's repro table was re-run against a fresh in-memory database and now
matches the expected column. Full sweep: `yarn lint && yarn build && yarn test` — **0 failing**,
8499 + 370 + 113 + 63 + 17 + 28 + 1291 + 648 + 52 + 31 + 34 + 134 + 22 passing (8488 → 8499 is
the 11 new tests).

### Use cases to exercise

`packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic` (new) pins observable row sets AND
the resulting base-table state — the state check is the part that catches a double-write that
still returns plausible output:

- `insert` body referenced twice via two scalar subqueries, and via a self-join
- `insert … select from u` (not constant-foldable, so it stays one `CTENode` — exercises cause A
  in isolation) vs `insert … values` (folds, splits into two — exercises A and B together)
- `update` body referenced twice: `v` must end at 1, not 2 (the silent-corruption case)
- `delete` body referenced twice: the second mention sees the same returned row, not an empty re-run
- explicit `materialized` and explicit `not materialized` hints on both `insert` and `update` bodies
- three mentions in one statement
- controls: referenced once; referenced zero times; a plain `select`-bodied CTE referenced twice

`packages/quereus/test/plan/cte-dml-plan-shape.spec.ts` gained a
`data-modifying CTE: plan-shape invariants` block asserting, for eight statement shapes, that
every `CTENode` instance in the optimized plan carries `materialize = true` and that all
instances share one `tableDescriptor`. It includes an anti-vacuity test proving the
constant-foldable case genuinely yields 2+ instances (so the single-descriptor assert is not a
tautology), and a guard that a `select`-bodied single-reference CTE is NOT force-materialized.

## Known gaps — where to push

Treat the tests above as a floor. Untested and worth attacking:

- **Multiple data-modifying CTEs in one `with` clause** — `with a as (insert into t1 … returning …),
  b as (insert into t2 … returning …) select …`, each referenced twice. Each gets its own
  descriptor, so it should hold, but nothing pins it.
- **A DML CTE whose body writes a table the outer query also reads**, and one CTE reading
  another CTE's `returning` rows. Ordering/visibility semantics here were not examined.
- **Early teardown**: `with c as (insert … returning …) select * from c limit 0`. The forced
  buffering means the detached drive still runs to completion, so the write should happen — that
  is almost certainly the semantics we want for a write, but it is asserted nowhere.
- **Rollback / savepoint interaction** with a buffered DML CTE was not exercised beyond whatever
  the general DML suites already cover.
- **`yarn test:store`** (LevelDB-backed) was NOT run — memory-backed only.
- The **unreferenced** data-modifying CTE (`with c as (insert …) select 42`) still does not run
  at all; deliberately out of scope, filed as `backlog/bug-unreferenced-dml-cte-never-runs`. The
  new sqllogic file pins the current behaviour (`42`, no error, no row written) so the deviation
  cannot change direction unnoticed.
- Tripwire parked as a `NOTE:` in `planner/building/with.ts`: forcing `materialize` also takes a
  data-modifying CTE off the streaming path, so its whole `RETURNING` set is held in memory for
  the statement even when referenced once. Fine at today's `RETURNING` sizes; if a bulk write's
  `RETURNING` ever needs to stream, the reference-count undercount (cause A) has to be fixed
  first, not this flag relaxed.
- `backlog/bug-cte-cache-gate-reads-unknown-as-empty` touches the same file
  (`rule-cte-optimization.ts`) but a different concern — the `sourceSize > 0` caching gate a few
  lines above. Untouched here.
