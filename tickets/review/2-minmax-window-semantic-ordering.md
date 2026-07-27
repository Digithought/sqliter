---
description: Smallest and largest value calculations over a moving set of rows now compare values the same way plain sorting does, so they agree with the non-windowed versions for ordinary mixed numbers and text, and for durations, JSON documents, blobs, and case-insensitive text.
prereq:
files:
  - packages/quereus/src/schema/window-function.ts                 # new bindArgs hook + bindWindowSchema
  - packages/quereus/src/func/builtins/builtin-window-functions.ts # MIN/MAX rewritten onto a comparator
  - packages/quereus/src/runtime/emit/window.ts                    # bind at schema resolve; sliding scan folds through the bound schema
  - packages/quereus/src/util/comparison.ts                        # createSemanticValueComparator (unchanged; the shared routing rule)
  - packages/quereus/test/plan/window-minmax-semantic-ordering.spec.ts  # new — both physical shapes
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic    # new window min/max section
  - packages/quereus/test/logic/27.3-window-json-aggregation.sqllogic  # JSON window min/max
  - docs/types.md                                                  # "Semantic ordering" — known gap replaced
difficulty: medium
---

# Window `min()`/`max()` now rank by the argument's comparison semantics

## What was wrong

Window functions resolve through a registry (`schema/window-function.ts`) entirely
separate from ordinary aggregates. Its `MIN` and `MAX` steps compared with a bare
JavaScript `<`:

```ts
return value < state ? value : state;   // MIN, before
```

That disagrees with plain sorting even for ordinary mixed values — `5 < 'abc'` and
`'abc' < 5` are both `false` in JavaScript, so a number in an `any` column was never
selected and the window minimum was whichever non-null value arrived first. It also
ignored logical-type semantics (TIMESPAN elapsed time, JSON structure), ignored the
column's collation, and compared blobs by coercing two `Uint8Array`s to strings.

## What was built

The same shape the prereq ticket used for the MIN/MAX **aggregate**, on the window
registry:

- `WindowFunctionSchema` gained a `bindArgs` hook plus `bindWindowSchema`
  (`schema/window-function.ts`). It takes the *same* `AggregateArgBinding` type as the
  aggregate hook — declared logical type + resolved collation per argument — so the
  routing rule (`createSemanticValueComparator` in `util/comparison.ts`) keeps exactly
  one home. Binding is idempotent and merges field-by-field, so an omitted field means
  "keep the declared default".
- `builtin-window-functions.ts`: MIN and MAX are now one `extremumWindowParts(direction,
  compare)` factory registered twice. The registered default compares by storage class
  under BINARY (correct for untyped/ANY arguments and for any caller that never binds);
  `bindArgs` re-derives step and final over the call site's semantic comparator.
- `runtime/emit/window.ts` binds ONCE where it resolves the schema list, using
  `plan.functionArguments[fi][0].getType()` for the type and `ctx.resolveCollation` for
  the collation. Nothing per-row resolves a type or a collation.

The window emitter has **three** execution shapes, and all three now fold through that
one bound schema:

| shape | entry point | how it reaches the schema |
|---|---|---|
| buffered frame walk | `computeAggregateFunction` | already took `schema` |
| streaming running aggregate | `stepRunningAgg` | already took `fc.schema` |
| streaming sliding-frame scan | `slidingScanExtremum` | **new** — `schema` threaded through `handleSlidingArrival` → rows/range arrival → finalize |

The ticket flagged the sliding helpers as a possible third path. They were: the old
`slidingScanMin` / `slidingScanMax` each had their own private `<`. Rather than pass a
second comparator alongside the bound schema (two derivations of the same rule), the two
functions collapsed into `slidingScanExtremum`, which folds the buffer slice through
`schema.step` / `schema.final`. Reusing the schema is what makes the sliding path
*structurally* unable to rank differently from the buffered one. Excluding min/max from
the sliding optimization was the alternative and was not taken — `unstep` is never used
for them (they already rescanned the slice), so there was nothing unsound to exclude.

## Behavior now (verified against a build)

Table `m(id integer primary key, v any)` holding `'abc'`, `5`, `'zz'`:

| query | before | after |
|---|---|---|
| `select v from m order by v` | `5, 'abc', 'zz'` | unchanged |
| `select min(v), max(v) from m` | `5`, `'zz'` | unchanged |
| `min(v) over (), max(v) over ()` | **`'abc'`**, `'zz'` | `5`, `'zz'` |

TIMESPAN `PT30M, PT1H, PT2H, P1D, PT0S`: `min(dur) over ()` was `P1D`, now `PT0S`.
JSON `[8,1], [9], [10]`: `max(d) over ()` was `[9]` (canonical-text order), now `[10]`.
`text collate nocase` `'B','a','c'`: was `mn='B', mx='a'`, now `mn='a', mx='c'`.
Blobs now compare bytewise and equal the aggregate result.

## Use cases to exercise when reviewing

- `min(x) over (…)` / `max(x) over (…)` must equal `min(x)` / `max(x)` over the same
  rows, and agree with `order by x limit 1` — for TIMESPAN, JSON, `collate nocase` text,
  blob, and an `any` column mixing numbers and text.
- The three physical shapes must agree with each other. `rule-monotonic-window` picks the
  shape; disabling it (`db.optimizer.updateTuning({ disabledRules: new Set(['monotonic-window']) })`)
  forces the buffered one. The new spec runs every query on both and asserts equality.
- PARTITION BY plus a semantic-ordering argument (partition keys were already
  canonicalized; the min inside each partition is the new part).
- Under a semantic tie with byte-different spellings (`'PT1H'` vs `'PT60M'`, `'a'` vs
  `'A'` under NOCASE) which raw value survives is **unspecified** — same latitude the
  aggregate, DISTINCT, and GROUP BY take. Don't write a test that pins it.

## Validation performed

- `yarn build` — clean.
- `yarn test` — 7365 passing in `packages/quereus`, 0 failing across all workspaces.
- `yarn lint` (root fan-out) and `packages/quereus` lint (eslint + `tsc -p
  tsconfig.test.json --noEmit`) — clean.
- Instrumented the built `dist` with a temporary probe to confirm each of the three
  execution shapes is actually reached by the new tests (probe removed afterwards).
- Not run: `yarn test:store`. The change is emitter-local with no storage surface.

### Tests added

- `packages/quereus/test/plan/window-minmax-semantic-ordering.spec.ts` (12 cases) — every
  query runs on both a streaming and a rule-disabled buffered database and the results
  must be deep-equal; one case asserts off the WindowNode's `streaming` property that the
  streaming emitter really engaged rather than assuming it.
- `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` — a "Window min()/max()"
  section: TIMESPAN whole-partition / running / sliding, agreement with the aggregate and
  with `order by … limit 1`, the mixed-storage-class `any` case, NOCASE, and blobs.
- `packages/quereus/test/logic/27.3-window-json-aggregation.sqllogic` — JSON window
  min/max, whole-partition and sliding.

## Known gaps / things a reviewer should push on

- **The `1 PRECEDING AND CURRENT ROW` frame does not stream.** I assumed it would and the
  first draft of the spec failed on that assertion. `rule-monotonic-window` only maps
  *two-sided* `n PRECEDING AND m FOLLOWING` frames to `slidingAgg`, so the sliding tests
  use `1 PRECEDING AND 1 FOLLOWING`. Whether the one-sided form *should* stream is a
  separate question I did not investigate.
- **No test pins a semantic-tie representative**, by design (see above) — which means a
  future change that silently swaps which of `'PT1H'`/`'PT60M'` survives would not be
  caught. That is intentional, not an oversight, but it is a real hole in the net.
- **Only `args[0]` participates in the binding.** MIN/MAX are unary so this is exact
  today, but `bindArgs` receives the full array and a future multi-argument
  comparison-sensitive window function would need to use more of it.
- **`sum`/`avg` window functions still coerce with `Number(value)`** and are untouched
  here. Over a TIMESPAN column both the aggregate and the window form return NULL — they
  agree, so this ticket left them alone. Not a regression, but it is the same class of
  "no type context in the step" the min/max fix removed, and nothing prevents it from
  becoming visible if a future logical type has a meaningful `Number()` coercion.
- **`createAggregateState` in `schema/window-function.ts` appears to be dead** — no
  caller found. Not touched.
- Performance: `slidingScanExtremum` still rescans the frame slice per finalize, exactly
  as `slidingScanMin`/`slidingScanMax` did; the per-comparison cost is now a closure call
  rather than an inline `<`. The pre-existing "recompute from the buffer slice on each
  finalize (acceptable for v1 — windows are typically small)" note in
  `emit/window.ts`'s sliding-frame header still stands and was not re-litigated.
