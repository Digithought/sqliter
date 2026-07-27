---
description: When min() or max() is used as a windowed calculation over a set of rows, it compares values with a raw JavaScript less-than, so it disagrees with plain sorting even for ordinary mixed numbers and text, and gets durations and JSON documents wrong.
prereq: minmax-semantic-ordering
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # MIN/MAX window registrations — the defect
  - packages/quereus/src/schema/window-function.ts                  # WindowFunctionSchema — where a bind hook would live
  - packages/quereus/src/runtime/emit/window.ts                     # computeAggregateFunction (~530) and runStreaming (~1268)
  - packages/quereus/src/util/comparison.ts                         # createSemanticValueComparator (added by the prereq)
  - packages/quereus/test/logic/27.3-window-json-aggregation.sqllogic
difficulty: medium
---

# Window min()/max() compare with a raw JavaScript `<`

## What is wrong

Window functions resolve through a registry entirely separate from ordinary aggregates
(`schema/window-function.ts`, populated by `func/builtins/builtin-window-functions.ts`).
Its `MIN` and `MAX` steps are:

```ts
step: (state, value) => {
	if (value === null) return state;
	if (state === null || state === undefined) return value;
	return value < state ? value : state;      // MIN
}
```

A bare JavaScript `<`. It does not implement SQL storage-class ordering, does not consult
any collation, and does not consult the argument's logical type. So it is wrong in strictly
more cases than the ordinary-aggregate gap the prereq ticket fixes.

Reproduced against a build of `main`, column `v any` with values `'abc'`, `5`, `'zz'`:

| query | result |
|---|---|
| `select v from m order by v`                       | `5, 'abc', 'zz'` |
| `select min(v), max(v) from m`                     | `mn=5, mx='zz'` (agrees) |
| `select min(v) over (), max(v) over () from m`     | `mn='abc'`, `mx='zz'` **(wrong)** |

`5 < 'abc'` is `false` in JavaScript and so is `'abc' < 5`, so the number is simply never
selected — the window minimum is whichever non-null value happened to arrive first.

The same registration is also wrong for every case the prereq ticket documents. With
TIMESPAN values `PT30M, PT1H, PT2H, P1D, PT0S`, `select min(dur) over () from ts_test`
returns `P1D`, while `order by dur` puts `PT0S` first.

Blobs (`Uint8Array`) compare by `<` as objects — coerced to strings — which is neither
byte order nor anything else meaningful.

## Expected behavior

`min(x) over (…)` returns the same value as `min(x)` over the same frame's rows, which
after the prereq ticket lands means: the argument's logical type's `compare` when that type
carries semantic ordering, else SQL storage-class ordering under the argument's resolved
collation.

## Design

The shape mirrors the prereq ticket's, on the window registry instead of the aggregate one.

`WindowFunctionSchema` (`schema/window-function.ts:5`) has `step` / `final` hooks and an
`inferReturnType`, but no per-call-site context. Add the same kind of one-shot bind:

```ts
export interface WindowFunctionSchema {
	// …
	/** Specialize step/final to the call site's argument comparison context. Called once
	 *  at emit time, never per row. Mirrors AggregateFunctionSchema.bindArgs. */
	readonly bindArgs?: (args: readonly AggregateArgBinding[]) => Pick<WindowFunctionSchema, 'step' | 'final'> | undefined;
}
```

Reuse `AggregateArgBinding` and `createSemanticValueComparator` from the prereq rather than
introducing parallel types — the routing rule must have exactly one home.

Both window execution paths must bind:

- `runtime/emit/window.ts` → `computeAggregateFunction` (line ~530, general frame path),
  reached via the schema list resolved at line ~217;
- `runtime/emit/window.ts` → `runStreaming` (the running-aggregate accumulator at line
  ~1268), the monotonic fast path activated by `rule-monotonic-window`.

Resolve each function's argument type and collation once where the schemas are resolved
(`resolveWindowFunction`, line ~217 of the emitter) and hand the bound schema to both
paths, so the streaming and non-streaming shapes cannot drift apart.

The sliding-frame helpers `slidingStepNum` / `slidingUnstepNum` / `slidingFinalAcc`
(`emit/window.ts:1379-1395`) cover `sum` / `count` / `avg` only — check whether min/max can
reach them; if they can, that is a third path to bind (or to exclude from the sliding
optimization, since min/max are not invertible under `unstep`).

## Tests

- `min(v) over ()` / `max(v) over ()` over mixed storage classes must equal
  `min(v)` / `max(v)` and agree with `order by v limit 1`.
- TIMESPAN and JSON columns: window min/max agree with the ordinary aggregate and with
  `order by … limit 1`.
- A `collate nocase` text column: window min/max agree with `order by t limit 1`.
- A frame that actually slides (`rows between 1 preceding and current row`) so the
  streaming path is exercised alongside the general one — assert against the same query
  with the monotonic-window rule disabled, so both physical shapes are compared.
- Blob column: window min/max agree with the ordinary aggregate.

## TODO

- [ ] Add the `bindArgs` hook to `WindowFunctionSchema`, reusing `AggregateArgBinding`.
- [ ] Rewrite the `MIN` / `MAX` registrations in `builtin-window-functions.ts` onto a
      comparator, defaulting to `compareSqlValuesFast(…, BINARY_COLLATION)` when unbound.
- [ ] Bind once where the emitter resolves window function schemas; use the bound schema in
      both `computeAggregateFunction` and `runStreaming`.
- [ ] Check whether min/max reach the sliding-frame helpers; bind or exclude them.
- [ ] Add the coverage above; extend `27.3-window-json-aggregation.sqllogic` where it fits.
- [ ] Update `docs/types.md` — remove window min/max from the semantic-ordering exception
      list the prereq ticket left there.
- [ ] `yarn build`, `yarn test`, `yarn lint`.
