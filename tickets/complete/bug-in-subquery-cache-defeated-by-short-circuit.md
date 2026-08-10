description: Fixed an "x IN (subquery)" cache that ran the subquery once per outer row instead of once, by draining and committing the buffer before the first row is yielded.
files: packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts, packages/quereus/test/runtime/cache.spec.ts, packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts, packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic, packages/quereus/test/plan/joins/theta-nlj-right-cache.plan.json, docs/runtime.md, docs/optimizer-rules.md

# Complete: eager CacheNode build mode for IN-subquery cache

## What shipped

`rule-in-subquery-cache` wraps an uncorrelated `x IN (subquery)` source in a
`CacheNode` so the subquery materializes once and later outer rows replay from a
buffer. The runtime defeated it: `streamWithCache` used a streaming-first build
that only committed the buffer **after** the source drained fully, but `emitIn`
returns on the first matching row, aborting the generator mid-drain — so the
cache never committed and every match-heavy outer row re-opened the subquery
source (one query-start per outer row on a high-latency vtab).

Fix: an **eager** build mode on `CacheNode` / `streamWithCache`. In eager mode
the first evaluation drains the source fully and commits `cachedResult` (or
abandons, over threshold) **before** yielding any row, so a consumer that breaks
on the first row has already caused the full drain + commit. `emitIn` is
untouched — it keeps its streaming early-exit and benefits from a cache
populated on eval #1. `rule-in-subquery-cache` is the only eager setter; CTE,
nested-loop-right, and mutating-subquery caches keep `eager` defaulted `false`
to preserve first-row latency.

Mechanism, per-file breakdown, and the added tests are described in the
implement commit (`git show a7d8bf33`) — not repeated here.

## Review findings

Reviewed the implement diff with fresh eyes, then the handoff. Ran lint
(exit 0), the targeted specs (32 passing), plan goldens (182 passing), and the
full quereus suite (**7054 passing, 13 pending, 0 failing**) — all green.

**Correctness — confirmed.** Traced the pull-driven generator path: `emitIn`'s
`runSubqueryStreaming` early-returns `true` on the first match
(`subquery.ts:178`); in eager mode the first `.next()` forces the entire
`for await` drain + commit before the first `yield` (`shared-cache.ts:95-116`),
so the short-circuit can no longer abort the build. `emit/cache.ts` mints a fresh
source per eval and persists `CacheState` on the `RuntimeContext`, so the
abandon-and-restream path and prepared-statement re-execution behave correctly.
Error path (source throws mid-drain → nothing committed, `cacheAbandoned` stays
false → retry) is sound and tested. Deep-copy on both build and replay protects
the buffer.

**Golden plans — checked.** Only `theta-nlj-right-cache.plan.json` contains a
CacheNode; it correctly gained `"eager": false` in alphabetical order and no
`, eager` toString suffix. No other golden plan references a CacheNode, so the
always-emit `getLogicalAttributes` change touched nothing else.

**Docs — verified against code.** `docs/runtime.md` § CacheNode row-cache
lifetime and the `docs/optimizer-rules.md` one-liner both accurately describe
eager-vs-streaming-first and match the implementation.

**The two gaps the handoff flagged are already adequately covered — no new
tests needed:**
- *Revert guard for `eager: true`.* The handoff worried there was no in-test
  before/after. There is an implicit guard: the "scans exactly once when every
  outer row matches" scan-count test asserts `=== 1`; revert `eager: true` and
  the streaming cache is defeated → 3 scans → the test fails. Silent revert is
  caught.
- *NULL-membership three-valued logic through the cached path.* Already covered
  by `test/logic/07.7-in-subquery-caching.sqllogic:14-27`
  (`id IN (select val from nullable_ids)`, subquery yields `{1, NULL, 3}`, 5
  outer rows: non-matches → NULL/excluded, matches → TRUE). Because the rule now
  sets `eager: true` for that exact shape, this logic test *is* the
  NULL-through-eager-cache assertion, and it passes.

**Source hygiene — fine.** Eager branch is ~30 focused lines with clear,
non-redundant comments; the streaming-first branch is left byte-for-byte
unchanged. Some threshold/deep-copy logic is mirrored between the two branches,
but they differ fundamentally in yield timing — extracting a shared helper would
obscure more than it saves. No type-safety, cleanup, or error-eating issues.

**Major findings:** none. **Minor findings fixed inline:** none required — the
implementation and its coverage hold up.

## Tripwires recorded (not tickets)

- **Eager over-scan for low outer cardinality.** Eager drains the whole subquery
  on the first eval, so a single-row (or early-`LIMIT`) outer relation pays the
  full drain and loses IN's first-match early-exit — slower than the pre-fix
  streaming path in that narrow corner. It is a net win for the common
  multi-row, match-heavy case (the bug being fixed), and harmless for small
  subquery sources. The rule fires unconditionally on uncorrelated + functional
  and has no outer-cardinality gate. Genuinely conditional, so parked as a
  `NOTE:` at the eager setter in `rule-in-subquery-cache.ts` (not a ticket): if
  large-source + low-outer-cardinality IN-subqueries ever show as slow, gate
  eager (or the rule) on estimated outer cardinality.
- **Buffered-copy row identity in the eager abandon branch** (noted by the
  implementer). Over threshold, the abandon branch yields the buffer's copies
  where the streaming path yields original source rows. Values are equal and the
  cache is discarded, so nothing can be corrupted; no consumer relies on
  cache-yielded row identity. Confirmed harmless — recorded here, no code change.

## Out of scope (unchanged from ticket)

Building a `BTree` membership set inside `emitIn` for O(log K) probes instead of
the cache's O(K) linear replay — a strictly bigger change with a correlated-IN
correctness trap; the rule already accepts linear replay.

## Pre-existing failures

None. Full suite was 0-failing before and after; the one golden that flipped was
the direct, expected consequence of adding `eager` to `getLogicalAttributes`.
