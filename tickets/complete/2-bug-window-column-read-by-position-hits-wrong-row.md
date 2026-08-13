---
description: A query that combined a window function with a per-row subquery lookup silently returned the lookup's value in the window column; window results are now addressed by stable column identity instead of by row position. Implemented, reviewed, and shipped.
files:
  - packages/quereus/src/planner/building/select-window.ts          # identity map + ColumnReferenceNode rewrite; structural spec grouping
  - packages/quereus/src/planner/nodes/window-node.ts               # predefinedWindowAttributes + getWindowAttributes(); length invariant
  - packages/quereus/src/planner/building/select-aggregates.ts      # grouped redirect walk skips window-function nodes
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts # NOTE: streaming is all-or-nothing per node
  - packages/quereus/src/runtime/register.ts                        # ArrayIndex emitter registration removed
  - packages/quereus/src/planner/nodes/plan-node-type.ts            # PlanNodeType.ArrayIndex removed
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts # ArrayIndex case removed
  - packages/quereus/test/logic/07.5-window.sqllogic                # regression section (table wsq)
  - packages/quereus/test/optimizer/attribute-id-stability.spec.ts  # window attribute-id stability tests
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts      # expectations updated for same-spec node sharing
  - docs/window-functions.md                                        # § Window Specification Grouping
  - docs/runtime.md                                                 # note under the source-attr invariant
repro: verified
---

# Complete: window column read by position hits wrong row

## What was broken

`select k, (select min(t.b) from wg t where t.a = k) as c, count(*) over () as n
from (select a as k from wg) group by k` returned `n` as a verbatim copy of `c`
instead of `2`. The window phase handed the projection a POSITIONAL read of the
WindowNode's output row (`ArrayIndexNode` / `emitArrayIndex`), which read slot N
from whatever live row context was newest. That was correct only while the
WindowNode's row was the newest context, and wrong the moment
`rule-scalar-agg-decorrelation` placed a join between the WindowNode and its
projection.

## What shipped

- **Stable window output identity.** `WindowNode` carries only its
  window-GENERATED attributes as the preserved list (`predefinedWindowAttributes`);
  `getAttributes()` is always `[...source.getAttributes(), ...windowAttrs]`, and
  `withChildren` / `withStreaming` pass `getWindowAttributes()` through
  unconditionally. A window result column keeps one attribute id even when the
  optimizer replaces the source.
- **Identity addressing.** `buildWindowPhase` records each collected function's
  window attribute keyed by its `AST.WindowFunctionExpr` object — the identity
  shared between the two select-list builds of a grouped query.
  `rewriteWindowFunctions` substitutes a `ColumnReferenceNode` bound to that
  attribute, resolved at runtime through `resolveAttribute` like every other
  column. A map miss raises `StatusCode.INTERNAL`. `findWindowColumnIndex` and
  `compareWindowSpecs` are gone; the grouped redirect walk skips window-function
  nodes.
- **Real specification grouping.** The grouping key is structural (spec fragments
  with every `loc` stripped), so functions sharing a specification share one
  WindowNode — one sort, one buffering/streaming pass.
- **Positional read removed.** `ArrayIndexNode`, `emitArrayIndex`, the emitter
  registration, `PlanNodeType.ArrayIndex`, and the fingerprint case are deleted;
  no references remain in the workspace (TVF row padding is still needed and its
  comment now says why).

## Review findings

**Checked** — the implement-stage diff read first, before the handoff summary;
then: identity-map lifetime and the AST-object claim it rests on (traced
`analyzeSelectColumns` → `buildFinalAggregateProjections` → `buildWindowPhase` in
`select.ts`); `withChildren` / `withStreaming` attribute preservation across a
replaced source; the structural grouping key against every spelling the parser can
produce; whether a stale `ColumnReferenceNode.columnIndex` can be read at runtime;
all deleted-symbol references across every package and doc; source hygiene of the
touched files; docs re-read against the new reality; ~23 additional query shapes
run against the engine.

**Correctness — nothing found.** Probed shapes all returned correct results:
window function inside `case` / inside a scalar function call / inside arithmetic;
window function inside a scalar subquery in the select list (handled by the inner
build, not mis-routed to the outer rewrite); duplicate identical window
expressions; partitioned window beside a decorrelated subquery; `lag`/`lead`
sharing one specification; window column in a grouped query with `having`; window
column through `order by` + `limit`; window over a join with a correlated
subquery; window column consumed by an outer aggregate; two stacked specifications
beside a subquery; the same window column referenced twice in one select list.

Two specific hazards checked and cleared:
- *Could the new structural grouping key merge two genuinely different
  specifications?* No. `WINDOW w AS (…)` named windows do not exist in the AST
  (`WindowFunctionExpr.window` is always the inline definition), so there is no
  spelling that keys equal while meaning something different. Under-grouping was
  confirmed for the documented cases (an explicit default frame vs. an implicit
  one, `order by b` vs. `order by p.b` — two nodes each), which costs a duplicate
  sort and never a wrong merge.
- *Does a stale `columnIndex` on the rewritten reference matter?* No.
  `emit/column-reference.ts` never reads it; `resolveAttribute` resolves purely by
  attribute id. The only planner consumer of `ColumnReferenceNode.columnIndex` is
  materialized-view rewrite matching, which reads it as "position in the source
  relation" — exactly what the window rewrite stores.

**Fixed inline (minor)**
- `packages/quereus/src/planner/nodes/window-node.ts` — added a constructor
  invariant: `predefinedWindowAttributes.length` must equal `functions.length`.
  The list is positional against `functions`, and a wrong length would have
  silently produced a mis-shaped attribute row (the exact failure class this
  ticket removed) at some later read instead of at construction.
- `packages/quereus/src/planner/building/select-window.ts` — `WindowColumnEntry`
  now holds `{ attr, columnIndex }` instead of re-copying the attribute's id,
  type, and name into three sibling fields.
- `packages/quereus/test/logic/07.5-window.sqllogic` — a comment still explained
  an output name in terms of the deleted array-index node.

**Test coverage added**
- `07.5-window.sqllogic`: a PARTITIONED window beside the decorrelated subquery
  (the buffered partitioned path advertises neither ordering nor monotonicity, so
  the join above it sees a different shape than the sorted cases the implementer
  pinned), and `lag`/`lead` sharing one specification (two functions WITH
  arguments on one node, so the per-function argument arrays must stay aligned
  with the output columns).

**Tripwire (recorded, not ticketed)** — streaming recognition is all-or-nothing
per node, and now that grouping actually merges, functions sharing an `over (…)`
share that fate: `ntile(2) over (order by b), row_number() over (order by b)` runs
the whole node buffered. It costs nothing today (the unrecognized function forced
a sort and a materialization either way), so this is knowledge, not work. Parked
as a `NOTE:` at the recognition loop in
`packages/quereus/src/planner/rules/window/rule-monotonic-window.ts` and as a
paragraph in `docs/window-functions.md` § Window Specification Grouping.

**Major findings — none**, so no new tickets were filed.

**Declined / left alone** — `shouldUseSequencingNode` (the `row_number`-without-
partition fast path) remains a dormant TODO the implementer deliberately did not
touch; it is inert, not wrong. Window functions are still collected only from the
SELECT list (`order by row_number() over (…)` was unsupported before this change
and still is) — pre-existing scope, unchanged by this ticket.

## Validation

- `yarn test` (packages/quereus): 9549 passing, 0 failing.
- `yarn test:context-strict`: 9552 passing, 0 failing.
- `yarn lint` (packages/quereus: eslint + `tsc -p tsconfig.test.json`): clean.
- Root `yarn test` (all workspaces) and root `yarn lint`: clean.
- `yarn test:store` not run (memory-backed suite only, per default agent
  guidance); nothing in the change touches storage paths.
- Plan-shape expectations in `test/plan/window-one-sided-frames.spec.ts` were
  reviewed rather than trusted: the three changed `expectStreamingModes` readings
  are the intended consequence of same-spec functions sharing one node, and the
  distinct-frame cases correctly remain one node per specification.
