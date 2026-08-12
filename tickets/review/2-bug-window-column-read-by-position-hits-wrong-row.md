---
description: A query that combined a window function with a per-row subquery lookup silently returned the lookup's value in the window column; window results are now addressed by stable column identity instead of by row position, and the fix is implemented and fully tested.
files:
  - packages/quereus/src/planner/building/select-window.ts          # identity map + ColumnReferenceNode rewrite; structural spec grouping
  - packages/quereus/src/planner/nodes/window-node.ts               # predefinedWindowAttributes + getWindowAttributes(); ids survive withChildren/withStreaming
  - packages/quereus/src/planner/building/select-aggregates.ts      # grouped redirect walk now skips window-function nodes; NOTE rewritten
  - packages/quereus/src/runtime/register.ts                        # ArrayIndex emitter registration removed
  - packages/quereus/src/planner/nodes/plan-node-type.ts            # PlanNodeType.ArrayIndex removed
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts # ArrayIndex case removed
  - packages/quereus/src/runtime/emit/table-valued-function.ts      # row-padding comment updated (padding itself still needed)
  - packages/quereus/test/logic/07.5-window.sqllogic                # new regression section (table wsq), deferral NOTE replaced
  - packages/quereus/test/optimizer/attribute-id-stability.spec.ts  # two new window attribute-id stability tests
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts      # 3 expectations updated for same-spec node sharing
  - docs/window-functions.md                                        # § Window Specification Grouping rewritten; pipeline text updated
  - docs/runtime.md                                                 # note under the source-attr invariant: no recency-based reads remain
repro: verified
---

# Review: window column read by position hits wrong row

## What was broken

`select k, (select min(t.b) from wg t where t.a = k) as c, count(*) over () as n
from (select a as k from wg) group by k` returned `n` as a verbatim copy of `c`
instead of `2`. The window phase handed the projection a POSITIONAL read of the
WindowNode's output row (`ArrayIndexNode` / `emitArrayIndex`), which read slot N
from whatever live row context was newest. Correct only while the WindowNode's
row was the newest context; wrong the moment `rule-scalar-agg-decorrelation` (or
any rewrite) placed a join between the WindowNode and its projection.

## What was done (all five ticket phases)

1. **Stable window output identity.** `WindowNode` now carries only its
   window-GENERATED attributes as the preserved list
   (`predefinedWindowAttributes`); `getAttributes()` is always
   `[...source.getAttributes(), ...windowAttrs]`, and `withChildren` /
   `withStreaming` pass `getWindowAttributes()` through unconditionally. A window
   result column keeps one attribute id even when the optimizer replaces the
   source (which it does in essentially every real plan).

2. **Identity addressing.** `buildWindowPhase` records each collected function's
   window attribute keyed by its `AST.WindowFunctionExpr` object — the one
   identity shared between the two select-list builds of a grouped query (both
   walk the same `stmt.columns`). `rewriteWindowFunctions` now substitutes a
   `ColumnReferenceNode` bound to that attribute; the value resolves through
   `resolveAttribute` like every other column. A map miss raises
   `StatusCode.INTERNAL` instead of silently keeping the raw node.
   `findWindowColumnIndex` and `compareWindowSpecs` (name + loc-sensitive spec
   matching) are deleted. The grouped redirect walk (`redirectNode`,
   select-aggregates.ts) explicitly skips window-function nodes.

3. **Real specification grouping.** `groupWindowFunctionsBySpec`'s key is now
   structural (JSON of the spec fragments with every `loc` stripped), so
   functions sharing a specification genuinely share one WindowNode — one sort /
   one buffering or streaming pass. Spelling variants (identifier case, an
   unused qualifier) still split nodes; that costs a duplicate sort, never a
   wrong merge.

4. **Positional read removed.** `ArrayIndexNode`, `emitArrayIndex`, the emitter
   registration, `PlanNodeType.ArrayIndex`, the fingerprint case, and the
   ArrayIndex fingerprint tests are deleted. No references remain anywhere in
   the workspace. TVF row padding is still needed (`resolveAttribute` checks
   `columnIndex < row.length`); its comment now says so.

5. **Coverage and docs.** See below. `docs/window-functions.md` § "Window
   Specification Grouping (not currently effective)" rewritten — grouping works
   now. `docs/runtime.md` notes next to the "source-attr contexts and child
   pulls" invariant that every scalar row read now goes through
   `resolveAttribute`.

## Validation performed

- `yarn test` (packages/quereus): 9549 passing, 0 failing.
- `yarn test:context-strict`: 9552 passing, 0 failing (relevant because the fix
  replaces the one remaining recency-based read).
- `yarn lint` (eslint + tsc over test files): clean.
- New sqllogic section in `test/logic/07.5-window.sqllogic` (table `wsq`, text
  values 'p'/'q'/'r' so numeric affinity cannot mask a wrong column), covering
  every shape the ticket listed:
  - grouped + windowed + correlated scalar-aggregate subquery × {constant window,
    row_number asc, row_number desc} — the original repro family;
  - the same three shapes × {EXISTS, IN} correlated subqueries
    (rule-subquery-decorrelation path);
  - ungrouped windowed + correlated subquery (streaming path regression guard);
  - two window functions with different specs beside a decorrelated subquery
    (mis-address cannot hide behind equal values);
  - two window functions sharing one spec/one WindowNode resolving to distinct
    columns, including two same-NAME `sum(...)` functions with different
    arguments — the case the old loc-accident protected;
  - a filter over a window output column through a subquery (`where rn > 1`) —
    pins that the predicate stays above the WindowNode.
- Two new tests in `test/optimizer/attribute-id-stability.spec.ts` assert the
  optimized plan's window-column reference is bound to an attribute the
  WindowNode actually publishes, for (a) the decorrelation rewrite and (b) the
  streaming (`withStreaming`) rebuild.

## Plan-shape expectations that changed (reviewer: verify these are the intended readings)

`test/plan/window-one-sided-frames.spec.ts` pinned one WindowNode per function;
same-spec functions now share a node, so three `expectStreamingModes`
expectations changed shape, e.g. `[['slidingAgg'], ['slidingAgg']]` →
`[['slidingAgg', 'slidingAgg']]` (lines ~178, ~208, ~257) and the helper's doc
comment was updated. Distinct-frame cases (fv/lv, the three-spec query at ~353)
are unchanged — different specs still get different nodes. No other plan-shape
test needed changes; `streaming-window-filter-shadow.spec.ts`'s "two stacked
Window nodes" pin is across a subquery boundary, which grouping (per select
statement) does not merge.

## Known gaps / notes for the reviewer

- **Window functions are only collected from the SELECT list** (unchanged
  behavior); `order by row_number() over (...)` at the top level was not
  supported before and is not now.
- The structural grouping key compares AST spellings byte-exact (after `loc`
  strip); it does not canonicalize identifier case or qualifiers. Deliberate:
  under-grouping is only a duplicate sort, over-grouping would be a correctness
  bug. Documented in the function's comment and in docs/window-functions.md.
- `ColumnReferenceNode.columnIndex` for a window reference is the position on
  the OUTERMOST window node's row at build time. Runtime resolution uses only
  the attribute id (`resolveAttribute`), so a post-optimization position shift
  is harmless — same contract as every other column reference in the engine.
- `shouldUseSequencingNode` (row_number-without-partition fast path) remains the
  dormant TODO it was; untouched.
- `yarn test:store` was not run (memory-backed suite only, per default agent
  guidance); nothing in the change touches storage paths.
