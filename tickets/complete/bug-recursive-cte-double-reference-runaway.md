description: A recursive WITH-clause query used twice (e.g. self-joined) hung and errored with an iteration-limit message; it now computes the recursion once, reuses it at every reference, and returns its rows.
files: packages/quereus/src/runtime/emit/recursive-cte.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/runtime/types.ts, packages/quereus/test/plan/cte-materialization.spec.ts, docs/runtime.md, docs/optimizer.md
difficulty: medium
----

# Complete: recursive CTE referenced twice — buffer once, replay per reference

## What the bug was

```sql
WITH RECURSIVE cnt(x) AS (
	SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 3
)
SELECT a.x AS ax, b.x AS bx FROM cnt a JOIN cnt b ON a.x = b.x ORDER BY a.x;
```

Expected `(1,1)(2,2)(3,3)`; previously errored `QuereusError: Recursive CTE 'cnt'
exceeded maximum iteration limit (10000)`. Fixed.

## What shipped

A multi-referenced recursive CTE is now driven **once** per statement execution
into a shared buffer that every reference replays; a single-reference recursive
CTE keeps the streaming path (so an outer `LIMIT` still cuts an unbounded
recursion off before the iteration guard trips). Two stacked defects were fixed:

1. **Two independent recursive drives** racing on the shared working-table
   `tableDescriptor`, each clobbering the other's semi-naïve delta so neither
   terminated. Fixed by the buffer-once/replay path in `emitRecursiveCTE`, keyed
   on `tableDescriptor` (the stable identity the optimizer-duplicated node
   instances agree on — plan ids diverge).
2. **A `CacheNode` wrapped the shared recursive-case subtree** (its parent count
   inflated to ≥2 by the duplication), freezing the semi-naïve delta to the first
   iteration. Fixed by excluding every node inside a recursive-case subtree from
   cache recommendations (`noCacheNodes`).

Implementation details are unchanged from the implement handoff and remain
accurate; see the git history for `emitRecursiveCTE.run` / `driveRecursion`, the
`RecursiveCTENode.materialize` flag, and the `recursiveRefsByDescriptor` /
`noCacheNodes` logic in `materialization-advisory.ts`.

## Review findings

### Verified correct (checked, nothing to change)

- **Root-cause divergence reasoning** (buffer keyed on `tableDescriptor`, mark
  gated on descriptor-summed ref-count, recursive-case cache exclusion): confirmed
  sound by reading the optimizer pass order (`framework/pass.ts`: advisory at
  order 35, only Validation at 40 runs after — so the `materialize` flag can't be
  reconstructed away; `withChildren` preserves it), the reference-graph builder
  (per-descriptor parent-count summing recovers the true count across duplicated
  instances), and node identity semantics.
- **Buffered runtime path**: single drive, detached async IIFE, deadlock
  reasoning (drive drains independently of downstream pulls) — sound. No
  unhandled-rejection leak (pre-attached `.catch`), per-consumer row copies
  present.
- **Buffer-key collision** (`Map<string | TableDescriptor, …>`): string plan-ids
  and object descriptors never compare equal under `Map` SameValueZero — safe.
- **Extra shapes the implementer flagged as untested** — exercised all and they
  return correct results: UNION ALL double-reference (`… UNION ALL SELECT x FROM
  cnt`), scalar-subquery + main reference, 4-way self-join, and a recursive CTE
  whose base references another recursive CTE. (One of my probe expectations was
  itself wrong: recursive `UNION ALL` correctly keeps per-level duplicates.)
- **Docs** (`docs/runtime.md`, `docs/optimizer.md`): read both changed sections;
  they accurately describe the new recursive path.
- **Test coverage**: happy path, UNION DISTINCT, 3-reference replay, streaming
  single-ref regression under `LIMIT`, and source-error propagation are all
  covered — a solid floor.

### Fixed inline (minor)

- **Inaccurate comment** in `materialization-advisory.ts`: claimed `noCacheNodes`
  "is empty for" single-reference recursive CTEs. The collection loop runs for
  *every* `RecursiveCTENode` regardless of reference count, so the set is not
  empty — the exclusion is uniform (and correct: caching a working-table-dependent
  node is always wrong). Comment corrected to say so.
- **DRY / signature-drift hazard**: the advisory hand-rebuilt the 12-argument
  `RecursiveCTENode` constructor to flip `materialize`, duplicating the argument
  list that `withChildren` already owns. Added `RecursiveCTENode.withMaterialize`;
  the advisory now marks children via `withChildren` then flips the flag via the
  helper. Removed the now-unused `ScalarPlanNode` import.

### Major / new tickets

None. No latent defects found.

### Tripwires (recorded, not ticketed)

- **`noCacheNodes` over-broad**: excludes every node in a recursive-case subtree,
  including a subquery that never touches the working table and could safely be
  cached. Conditional perf concern only. Already parked as a `NOTE:` at the
  collection site in `materialization-advisory.ts` (search `NOTE:`).
- **Buffered multi-reference recursion ignores an outer `LIMIT`**: a buffered
  drive runs to completion (bounded by `maxRecursion`) before an outer `LIMIT`
  can cut it. This matches `emitCTE`'s materialized semantics and is correct for a
  self-join. A multi-referenced *unbounded* recursion under an outer `LIMIT` would
  hit the iteration guard — but it errored before this fix too, so no regression.
  No code change; noted here for a future reader who hits that shape.

### Not run

- **`test:store`** (LevelDB store path): the change is planner/runtime and
  store-agnostic, so per project guidance it was not run (store path is for
  store-specific diagnosis). Low risk.

## Validation

- `test/plan/cte-materialization.spec.ts`, `test/vtab/cte-multi-reference-scan-count.spec.ts`,
  `test/plan/materialization-advisory-single-pass.spec.ts` — 24 passing.
- Full `test/plan/**` + `test/optimizer/**` — 1594 passing.
- `test/logic.spec.ts` (includes CTE / recursive sqllogic) — 261 passing.
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc` test typecheck, exit 0).
