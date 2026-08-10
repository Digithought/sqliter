description: A join that can't use a hash/merge algorithm re-read its entire right-hand table once per left row; it now materializes a pure right side once and replays it, so a slow table is scanned a single time.
prereq:
files: packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/cache/reference-graph.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts, packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/test/plan/nested-loop-right-cache.spec.ts, packages/quereus/test/vtab/nested-loop-right-cache-scan-count.spec.ts, docs/optimizer.md
----

# Cache the right side of a pure nested-loop join (COMPLETE)

## What shipped

New optimizer rule `rule-nested-loop-right-cache` (PostOptimization pass, on
`PlanNodeType.Join`, right after `mutating-subquery-cache`) wraps the **pure right
side of a surviving logical nested-loop join** in a `CacheNode`, so the right side
is materialized once and replayed per left row instead of re-scanned N times. Fixes
the reported bug: `a JOIN b ON a.x > b.y` (and any non-equi / cross join) re-opened
the right pipeline per left row — a 10–100× trap on a high-per-read-latency vtab.

Supporting changes landed in the implement stage: `CacheNode.computePhysical` made a
physical pass-through (mirrors `AliasNode`); a CTE-safety gate around a latent
`CacheNode`/`CTEReference` runtime interaction; a size-gate row estimate that reads
both `physical.estimatedRows` and `TableAccessNode.filterInfo.indexInfoOutput.estimatedRows`;
and removal of the dead `inLoop` / `appearsInLoop` / `loopMultiplier` scaffolding in
`reference-graph.ts` + `materialization-advisory.ts`. See the implement commit
(`ticket(implement): bug-nlj-right-side-not-cached`) for the full rationale.

## Review findings

Checked: rule gates (driver / already-cached / purity / determinism / correlation /
CTE / size), `withChildren` reconstruction (child order + `existence` threading),
`CacheNode.computePhysical` field set vs `PhysicalProperties` and vs `AliasNode`,
the framework's readonly/deterministic/latency default derivation, the runtime
scan-count path (`streamWithCache` + `emitLoopJoin`), CTE node-type coverage, the
dead-code removal, docs, and the tests. Build / lint / test all green
(**7029 passing / 13 pending / 0 failing**, `yarn lint` clean, `yarn build` clean).

- **Correctness — no defects found.** Driver gate matches `emitLoopJoin`
  (`join.ts:213` — `right`/`full` drive from right, all others from left). Child
  order `[left, right, condition]` (`join-node.ts:247`) matches the rule's
  `withChildren([left, cached, condition])`, so the cache lands as the right input
  and `existence` survives. `CacheNode.computePhysical` mirrors `AliasNode` exactly;
  the framework derives `readonly`/`deterministic`/`idempotent`/`expectedLatencyMs`/
  `concurrencySafe` from children by default (`plan-node.ts:963-982`), so the fields
  the cache deliberately omits still resolve correctly. Already-cached gate prevents
  the rule re-firing on its own output (no fixpoint loop). CTE node-type set covers
  all four CTE machinery types.

- **Minor — FIXED inline.** The driver-gate comment claimed "Semi/anti still
  benefit: ... a replay buffer saves the reopen+scan." Overstated:
  `streamWithCache` only retains its buffer once a consumer drains the source to
  completion (`shared-cache.ts:104-107`), and semi/anti `break` on the first match
  (`join.ts:133-137`) — so a matched left row abandons the partial buffer and the
  next row re-scans; the buffer only lands after the first *unmatched* left row
  drains the right in full. Results are identical either way (not a data bug), and
  caching semi/anti is never a regression, but the benefit is data-dependent, not
  the guaranteed replay inner/cross/left get. Rewrote the comment to state this
  accurately (`rule-nested-loop-right-cache.ts`, driver gate). No test change: the
  scan-count test exercises the inner-theta path, which is unaffected.

- **Tripwire (already parked in code, no new work).**
  `estimateRightRows` over-estimates a large base scan that a selective `Filter`
  shrinks — biases toward NOT caching such a right side (missed optimization, never
  a memory hazard). A `NOTE:` sits at the helper. Left as-is.

- **Latent, worked-around (already documented, no new ticket filed).**
  - `CacheNode`/`CTEReference` runtime interaction — gated by `subtreeTouchesCte`,
    with a `NOTE:` in the rule. Confirmed the gate's four CTE node types are the
    complete set (`plan-node-type.ts`). Judged the gate an acceptable permanent
    boundary: caching a CTE-backed right side is low-value (a materialized CTE is
    already a buffer; a NOT_MATERIALIZED one re-scans cheap local state), so root-
    fixing the emit interaction buys little here. **Not** filing a `fix-` ticket —
    if the interaction bites elsewhere it should be raised from that call site.
  - `existence`-drop in `rule-mutating-subquery-cache` (raw `JoinNode` constructor)
    — a `NOTE:` was added at that site during implement. `join-physical-selection`
    skips existence joins so it is unreachable today. Left as a documented latent
    concern; not filing a `debt-` ticket for an unreachable path.

- **Test coverage — adequate, one honest gap.** Plan-shape (`theta`/`cross`/`equi`/
  `right`/`full`), a golden, a runtime scan-count proof (right `query()` invoked
  once), and the row-correctness checks are present and green. The gap the
  implementer already flagged stands: no end-to-end correlated-right nested-loop
  test (LATERAL support unverified), so the correlation gate is covered by
  `isCorrelatedSubquery` unit logic only. Not a blocker — the gate is conservative
  (skips on any correlation) so a false negative can only *skip* caching, never
  produce wrong rows.

- **Docs.** `docs/optimizer.md` was updated in implement (PostOptimization rule
  list, the nested-loop caching paragraph, the CacheNode physical-pass-through note,
  and the materialization-advisory loop-scaffolding removal). Re-read against the
  code — accurate and current.

## Nothing outstanding

No `fix-`/`debt-`/`backlog` tickets spawned: the two latent items are documented,
unreachable-or-low-value boundaries with `NOTE:`s at their sites, and the one review
finding was a comment inaccuracy fixed in this pass.
