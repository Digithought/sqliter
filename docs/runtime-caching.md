# Runtime Caching

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Per-execution caches that live on the `RuntimeContext` and reset between
prepared-statement executions: inner-scan connection reuse, `CacheNode` row
caches, and shared (multi-reference) CTE materialization. Companion to
[Runtime § Common Patterns](runtime.md#common-patterns); the fork policy for
each cache field is declared in the `RuntimeContext` fork-contract table there.

## Inner-scan connection reuse

A nested-loop join whose inner (right) side is **not** wrapped in a cache node
re-scans the inner relation once per outer row (`runtime/emit/join.ts`
`driveFromLeft`). Each re-scan re-invokes the inner sub-program, including its
scan leaf (`emitSeqScan`, `runtime/emit/scan.ts`). Rather than
`module.connect(...)` + `disconnect(...)` the inner virtual table on every
re-scan (one connect/disconnect per outer row), the scan leaf connects the
instance **once per scan-site per execution** and reuses it across every
re-scan:

- The connected instances live in a per-execution cache on the
  `RuntimeContext` (`ctx.scanConnections`, a `Map<symbol, VirtualTable>`),
  keyed by a stable symbol minted in each `emitSeqScan` closure — so the key is
  identical across re-scans of one scan site but distinct from every other
  site. A self-join's two scan sites over one table therefore get **distinct**
  instances and never share a cursor (its single consumer drains each inner
  cursor sequentially before the next outer row, so one instance is never
  concurrently self-live).
- The scan leaf no longer disconnects in its `finally` (it still closes the
  per-invocation row slot each pass). Teardown happens once, in
  `Statement._iterateRowsRawInternal`'s `finally`, which disconnects every
  cached instance exactly once on all exit paths (completion, `break`, error,
  abort) after the consumer finishes draining.
- The cache lives on the per-execution `RuntimeContext`, so it resets between
  prepared-statement runs — a re-executed statement reconnects afresh.
- **Fallback:** the transient/analysis `RuntimeContext`s that don't set
  `scanConnections` (e.g. `Database._executeSingleStatement`, const-evaluation)
  make the scan leaf own the lifecycle: connect and disconnect per invocation,
  as before. Correct, just no reuse.

Reuse is visibility-neutral for the memory vtab, which reads live-at-`query()`
state (a reused instance's later `query()` observes the same state a fresh
connect would). The read scan connects `module.connect` directly and never
registers a `VirtualTableConnection`, so this is independent of the
`adoptConnection` / connection-registration path.


## CacheNode row-cache lifetime

`emitCache` (`src/runtime/emit/cache.ts`) materializes its source's rows on
first iteration and replays them on later re-iterations within the same
execution — used for CTE materialization (`rule-cte-optimization`),
mutating-subquery caching (`rule-mutating-subquery-cache`), uncorrelated scalar
subqueries (`rule-scalar-subquery-cache`), and the nested-loop right side
(`rule-nested-loop-right-cache`). Uncorrelated `IN (subquery)` no longer uses a
row cache — `emitIn` materializes a probed value set directly (see § IN-subquery
set probe below). The materialized `CacheState` (from
`src/runtime/cache/shared-cache.ts`) lives on the per-execution
`RuntimeContext` (`ctx.cacheStates`, a `Map<symbol, CacheState>`), keyed by a
symbol minted in the `emitCache` closure — the same pattern as
`scanConnections` above and `executionMemo`
([Runtime § Common Patterns](runtime.md#common-patterns)). Because the instruction tree
(and the closure that minted the key) is cached and reused across a prepared
statement's executions, tying the cache to the context rather than the
closure resets it between runs: a re-executed statement re-drives its cached
source and observes current data instead of replaying the first run's rows.

**Eager vs. streaming-first build.** `streamWithCache` has two build modes,
selected by `CacheNode.eager`. The default *streaming-first* mode yields each
source row as it arrives and only commits `cachedResult` after the source drains
to completion — great first-row latency, but a consumer that short-circuits
(breaks on an early row) aborts the generator before the drain finishes, so the
buffer is never committed and the next evaluation re-opens the source. The
*eager* mode drains the source fully and commits the buffer **before** yielding
any row, so a first-match short-circuit can't abort the build; if the eager drain
exceeds the cache threshold it abandons and streams the remainder through.

> **NOTE:** eager mode currently has **no caller** — the only rule that set
> `eager: true` was `rule-in-subquery-cache`, retired in favor of the emit-level
> IN-subquery set probe (below). CTE, nested-loop-right, mutating-subquery, and
> scalar-subquery caches all use streaming-first (`eager` defaulted `false`). The
> capability is kept for a future short-circuiting cache consumer; if none
> materializes, it is dead code that could be removed.

## IN-subquery set probe

An uncorrelated, functional `x IN (subquery)` is **not** row-cached. `emitIn`
(`src/runtime/emit/subquery.ts`, `runSetProbe`) drains the subquery source
exactly once per statement execution into a `BTree` keyed under the membership
collation, tracking whether the inner produced any NULL, then probes that set per
outer row: hit → `true`; miss → `NULL` if the inner had a NULL else `false`;
condition NULL → `NULL` (without forcing the build — and a condition the
membership conversion coerces to NULL short-circuits the same way, so the key is
computed before the build, not after; see `inMembershipKeys` and `docs/types.md`
§ JSON). This is O(K + N·log K) with
**zero statistics** — it replaced the retired eager-CacheNode mechanism, whose
threshold could abandon the buffer and re-drive the subquery per outer row
(O(N×K); see quereus-in-subquery-set-probe). The probe set lives on the
per-execution `RuntimeContext` (`ctx.inSetProbes`, `Map<symbol, {tree, hasNull}>`)
keyed by a symbol minted in the `emitIn` closure — same reset-per-execution
pattern as `cacheStates` / `executionMemo`, so a re-run re-drains with current
data. The gate (uncorrelated + functional) matches the retired rule: correlated
sources must re-evaluate per outer row, and non-deterministic sources keep their
per-row semantics — both route to the streaming (early-exit) path instead.

Fewer shapes reach this probe than the gate alone suggests: the optimizer
rewrites an uncorrelated, deterministic **filter-position** `x IN (subquery)`
into a hash semi join first (`rule-subquery-decorrelation`, uncorrelated arm —
see `docs/optimizer-rules.md`), whose build side drains the source once with the
same scan-count guarantee. The set probe remains the path for
projection-position IN (which must keep its three-valued answer), `NOT IN`,
correlated or non-deterministic sources, and any shape the rewrite's gates
decline (non-column left side, collation conflict, mixed semantic-ordering
pair).

## Shared CTE materialization (multi-reference CTEs)

A non-recursive CTE referenced more than once (or hinted `MATERIALIZED`) is
marked `materialize` by the optimizer's materialization-advisory pass (see
`docs/optimizer.md` § Materialization Advisory). `emitCTE`
(`src/runtime/emit/cte.ts`) then evaluates the CTE **exactly once per statement
execution**, matching standard SQL `MATERIALIZED` semantics:

- Every `CTEReferenceNode` emits its own copy of the CTE's source subtree
  (`emitPlanNode` has no memoization), but all references share one `CTENode`
  instance — so each reference's `emitCTE` closure agrees on the buffer key,
  the CTENode's plan id.
- The buffer lives on the per-execution `RuntimeContext`
  (`ctx.cteMaterializations`, a `Map<string | TableDescriptor, Promise<Row[]>>` —
  non-recursive CTEs key by plan-id string, recursive CTEs by descriptor object;
  the two key spaces never collide). The first
  reference to run stores the buffer *promise* synchronously (before any
  `await`), then drives its source to completion; a second reference that
  interleaves — e.g. the two sides of a nested-loop self-join — finds the
  promise and awaits it instead of driving its own source subtree, which is
  therefore never iterated. This holds regardless of how references interleave,
  where a first-drain row cache (`CacheNode`) would still double-drive.
- Rows are copied on buffer-in and on yield so a downstream mutator cannot
  corrupt another reference's (or a later replay's) view.
- Per-execution lifetime gives the same staleness guarantee as `cacheStates`:
  a re-executed prepared statement re-materializes and observes current data.

Un-marked CTEs (single reference without a `MATERIALIZED` hint, or an explicit
`NOT MATERIALIZED`) keep the pure streaming path — early exit such as `LIMIT`
never drains the source.

**Recursive CTEs** run through the working-table machinery (`emitRecursiveCTE`),
not `emitCTE`, but follow the same buffer-once-replay pattern when referenced
2+ times:

- A **single-reference** recursive CTE stays on the streaming path (each drive
  emits its own semi-naïve loop). Streaming is required so an outer `LIMIT` can
  cut an unbounded recursion off before the iteration guard trips.
- A **multi-referenced** recursive CTE (e.g. joined to itself) is marked
  `materialize` on its `RecursiveCTENode` and buffered once per execution. Two
  interleaved streaming drives would clobber each other's delta on the shared
  working-table `tableDescriptor` — the recursion never terminates and trips the
  10 000-iteration guard. So the first reference to run drives the recursion to
  completion inside a detached async IIFE (draining independently of how the join
  pulls, which breaks the nested-loop deadlock) into a buffer keyed by the
  `tableDescriptor`; every reference replays it. The mark **ignores** the
  `MATERIALIZED` / `NOT MATERIALIZED` hint — honoring `NOT MATERIALIZED` here
  would re-introduce the runaway, so correctness wins.
- The buffer key is the `tableDescriptor`, **not** the plan id, because earlier
  optimizer passes duplicate a multi-referenced recursive CTE into distinct
  `RecursiveCTENode` instances (distinct plan ids) that all preserve the one
  `tableDescriptor`. The advisory marks every copy (it sums parent counts per
  descriptor) and additionally forbids caching anything inside a recursive-case
  subtree — a `CacheNode` there would freeze the semi-naïve delta to the first
  iteration's rows. See `docs/optimizer.md` § Materialization Advisory.

