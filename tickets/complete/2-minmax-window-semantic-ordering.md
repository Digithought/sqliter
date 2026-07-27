---
description: Smallest and largest value calculations over a moving set of rows now compare values the same way plain sorting does, so they agree with the non-windowed versions for ordinary mixed numbers and text, and for durations, JSON documents, blobs, and case-insensitive text.
prereq:
files:
  - packages/quereus/src/schema/window-function.ts                 # bindArgs hook + bindWindowSchema
  - packages/quereus/src/func/builtins/builtin-window-functions.ts # MIN/MAX on a comparator; SUM/AVG tripwire NOTE
  - packages/quereus/src/runtime/emit/window.ts                    # binds at schema resolve; sliding scan folds through the bound schema
  - packages/quereus/src/runtime/emit/aggregate-setup.ts           # argComparisonContext now shared with the window emitter
  - packages/quereus/src/util/comparison.ts                        # createSemanticValueComparator (unchanged; the shared routing rule)
  - packages/quereus/test/plan/window-minmax-semantic-ordering.spec.ts
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/logic/27.3-window-json-aggregation.sqllogic
  - docs/types.md, docs/sql-functions.md, docs/window-functions.md
difficulty: medium
---

# Window `min()`/`max()` rank by the argument's comparison semantics

## What was wrong

Window functions resolve through a registry (`schema/window-function.ts`) separate
from ordinary aggregates, and its `MIN`/`MAX` steps compared with a bare JavaScript
`<`. That disagrees with plain sorting even for ordinary mixed values — `5 < 'abc'`
and `'abc' < 5` are both false, so a number in an `any` column was never selected
and the window minimum was whichever non-null value arrived first. It also ignored
logical-type semantics (TIMESPAN elapsed time, JSON structure) and the column's
collation, and compared blobs by coercing two `Uint8Array`s to strings.

## What was built

- `WindowFunctionSchema` gained a `bindArgs` hook plus `bindWindowSchema`. It takes
  the same `AggregateArgBinding` the aggregate hook takes — declared logical type +
  resolved collation per argument — so the routing rule
  (`createSemanticValueComparator`) keeps one home. Binding is idempotent and merges
  field-by-field; an omitted field means "keep the declared default".
- MIN and MAX are one `extremumWindowParts(direction, compare)` factory registered
  twice. The registered default compares by storage class under BINARY (correct for
  untyped/ANY arguments and for any caller that never binds); `bindArgs` re-derives
  step and final over the call site's semantic comparator.
- `runtime/emit/window.ts` binds ONCE where it resolves the schema list. Nothing
  per-row resolves a type or a collation.

All three physical shapes fold through that one bound schema: the buffered frame
walk (`computeAggregateFunction`), the streaming running accumulator
(`stepRunningAgg`), and the streaming sliding-frame scan — where the two private
`slidingScanMin`/`slidingScanMax` helpers collapsed into one `slidingScanExtremum`
that folds the buffer slice through `schema.step`/`schema.final`. Reusing the schema
is what makes the sliding path structurally unable to rank differently.

## Behavior

Table `m(id integer primary key, v any)` holding `'abc'`, `5`, `'zz'`: `min(v) over ()`
was `'abc'`, is now `5`. TIMESPAN `min(dur) over ()` over `PT30M, PT1H, PT2H, P1D, PT0S`
was `P1D`, is now `PT0S`. JSON `max(d) over ()` over `[8,1], [9], [10]` was `[9]`,
is now `[10]`. `text collate nocase` `'B','a','c'` was `mn='B', mx='a'`, now
`mn='a', mx='c'`. Blobs compare bytewise and equal the aggregate result.

Under a semantic tie with byte-different spellings (`'PT1H'` vs `'PT60M'`, `'a'` vs
`'A'` under NOCASE) which raw value survives is unspecified — the same latitude the
aggregate, DISTINCT, and GROUP BY take.

## Validation

`yarn build`, `yarn lint` (root fan-out; only `packages/quereus` has a real lint —
eslint + `tsc -p tsconfig.test.json --noEmit`), and `yarn test` all clean after the
review edits: **7369 passing in `packages/quereus`, 0 failing across all workspaces**.
`yarn test:store` not run — the change is emitter-local with no storage surface.

## Review findings

### Checked and clean

- **Every consumer of the window registry.** `resolveWindowFunction` has three call
  sites; only the emitter reads `step`/`final`, and it binds before use. The planner
  node consults the schema for return-type inference only, which no comparator
  affects.
- **`functions[i]` ↔ `functionArguments[i]` alignment**, on which the binding
  depends. The builder constructs them together index-for-index, and
  `rule-monotonic-window` is all-or-nothing (it never splits a window node), so the
  indices cannot skew.
- **NULL and empty-frame handling in the rewritten sliding scan.** Folding through
  the schema's own step reproduces the old helpers' null-skipping exactly, and an
  empty slice folds to the empty accumulator ⇒ NULL. Now covered by tests (below)
  rather than by inspection.
- **The three-shapes-agree claim** — the implementer's spec runs every query on a
  streaming and a rule-disabled buffered database and asserts deep equality, and
  asserts off the plan that streaming really engaged rather than assuming it. That
  is the right shape of test and it holds.
- **Collation on the *result* type.** `min(t) over ()` over a NOCASE column produces
  a ScalarType with no `collationName`, so a downstream ordering of that result
  falls back to BINARY. The plain `min(t)` aggregate node does exactly the same —
  symmetric, pre-existing, and outside this ticket. Noted, not filed: it is a
  question about aggregate/window output types in general, not a regression here.

### Fixed in this pass (minor)

- **Two docs still described the old behavior.** `docs/sql-functions.md` listed
  window min/max as a known gap "tracked as `minmax-window-semantic-ordering`" —
  the very ticket being completed. Rewritten. `docs/window-functions.md`, the
  dedicated window doc, documented `step`/`final` for extension authors with no
  mention of the new `bindArgs` hook, and described the sliding scan as an
  unqualified recompute. Both updated. Only `docs/types.md` had been touched.
- **The argument comparison context was duplicated.** The window emitter re-derived
  `{ logicalType, collation }` from the argument's type inline, a copy of
  `argComparisonContext` in `runtime/emit/aggregate-setup.ts` — including the
  "missing collation name stays undefined ⇒ BINARY" convention. Exported the
  existing helper and used it; window and aggregate now read a call site through
  the same function.
- **`schema` was threaded as a seventh parameter through six sliding-path
  functions** alongside `fi`, while the sibling `stepRunningAgg` already took the
  `StreamingFunctionContext` that carries both. Switched the sliding path to the
  same convention — one parameter fewer per signature, and no second way to reach
  a function's schema.
- **Two dead exports removed** from `schema/window-function.ts`:
  `createAggregateState` (which the implementer flagged as suspicious) and
  `createRankingState`. Neither had a caller anywhere in the monorepo; the
  full build across all packages confirms it.
- **`bindWindowSchema`'s doc comment said "both window execution shapes"** while
  the change is specifically about there being three. Corrected.

### Test gaps closed (minor)

Three cases added to `test/plan/window-minmax-semantic-ordering.spec.ts`, all
passing on both physical shapes:

- **RANGE-mode sliding frames.** The diff changed two independent finalizers —
  ROWS and RANGE — and every new test used ROWS. The RANGE scan is a genuinely
  different path (bounds advance by ORDER BY value, not row offset) and had its own
  copy of the raw `<`. Now covered with a TIMESPAN argument, including an assertion
  that the RANGE frame really streams.
- **NULL arguments**, whole-partition: skipped, and the result equals the aggregate.
- **An all-NULL sliding frame** yields NULL rather than an empty accumulator.

Writing these surfaced that Quereus columns are NOT NULL by default
(`docs/sql.md`), which is why no NULL fixture existed; the new table declares
`timespan null` explicitly.

### Filed as a new ticket (major)

- `backlog/feat-window-streaming-one-sided-frames` — the implementer noticed that
  `1 preceding and current row` does not stream and left it unexplained. Confirmed:
  `rule-monotonic-window` recognizes only the default frame and a **two-sided**
  `n preceding and m following`, so one-sided frames disable streaming for the whole
  window node and buffer the entire partition. `n preceding and current row` is the
  natural shape for a trailing moving average, so users writing the obvious query
  get the slow plan while a strictly more expensive symmetric frame gets the fast
  one. Correctness is unaffected — this is plan selection only, and it is
  pre-existing rather than caused by this ticket.

### Recorded as tripwires, not tickets

- **Window `SUM`/`AVG` coerce with `Number(value)` and take no type context** — the
  same shape the MIN/MAX fix removed. Harmless today: over TIMESPAN/JSON both the
  window form and the plain aggregate yield NULL, so they agree. It only becomes
  work if a logical type gains a meaningful `Number()` coercion. Parked as a `NOTE:`
  at the SUM registration in `func/builtins/builtin-window-functions.ts`, pointing
  at the two sliding-path helpers that coerce a second time.

### Accepted as-is, with reasons

- **No test pins which representative survives a semantic tie** (`'PT1H'` vs
  `'PT60M'`). Deliberate and correct — pinning it would freeze an unspecified
  choice the aggregate, DISTINCT, and GROUP BY all leave open. It does mean a future
  change that silently swaps the survivor goes uncaught; that is the intended
  trade, and it is stated in the type docs rather than in an assertion.
- **Only `args[0]` participates in the binding.** Exact today — MIN and MAX are
  unary, and the hook receives the full array, so a future multi-argument
  comparison-sensitive window function extends rather than rewrites.
- **`bindWindowSchema`'s documented idempotency has no consumer** and no test; no
  call site rebinds. Left alone: the property is free (the bound schema keeps the
  hook) and the doc is accurate.
- **The MIN/MAX fold is written twice** — once for the aggregate (`extremumParts`),
  once for the window (`extremumWindowParts`) — because the two registries use
  different accumulator shapes (boxed `{v}` vs. raw value). Only the trivial
  direction predicate is duplicated; the comparison rule itself, which is where the
  semantics live, is shared. The window factory's comment names its aggregate twin,
  which is the guard that matters.
- **`slidingScanExtremum` still rescans the frame slice per finalize**, exactly as
  the two helpers it replaced did; per-comparison cost is now a closure call rather
  than an inline `<`. The pre-existing "acceptable for v1 — windows are typically
  small" note in the sliding-frame header still stands and was not re-litigated.
