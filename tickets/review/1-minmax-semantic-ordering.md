---
description: The min() and max() functions used to pick the smallest/largest value by comparing raw text; they now compare by what the value means (durations by elapsed time, JSON by structure, case-insensitive columns by their collation), matching how sorting already works — including inside stored materialized views. Review the implementation.
files:
  - packages/quereus/src/schema/function.ts                       # AggregateArgBinding / AggregateFunctionBinding / bindArgs hook
  - packages/quereus/src/func/registration.ts                     # bindAggregateSchema applier; bindArgs option threaded
  - packages/quereus/src/util/comparison.ts                       # createSemanticValueComparator; createSemanticRowComparator refactored onto it
  - packages/quereus/src/func/builtins/aggregate.ts               # min/max collapsed into one comparator-parameterised factory
  - packages/quereus/src/runtime/emit/aggregate.ts                # stream aggregate: schemas hoisted to emit time + bound
  - packages/quereus/src/runtime/emit/hash-aggregate.ts           # hash aggregate: same
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # buildDeltaAggregateDescriptor binds stored agg columns (new CollationResolver param)
  - packages/quereus/src/core/database-materialized-views-plans.ts           # DeltaAggregateColumn doc updated (bound schema)
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts  # buildReaggAggregate binds to the backing attribute's type/collation
  - packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts # comment: empty-group value needs no binding
  - packages/quereus/src/util/coercion.ts                         # NOTE on numeric-string coercion of TEXT min/max (pre-existing, unchanged)
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # flipped expectation + TIMESPAN/GROUP BY/DISTINCT/MV coverage
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic         # JSON min/max section
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic                 # NOCASE min/max (one existing expectation adjusted — see gaps)
  - packages/quereus/test/query-rewrite-equivalence.spec.ts       # TIMESPAN min/max rollup equivalence block
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts   # law harness over the BOUND min/max schemas
  - docs/types.md                                                 # "Semantic ordering" — min/max no longer an exception
---

# Review: min()/max() rank by the argument's semantic order

## What was built

`min(x)`/`max(x)` previously compared with a hard-wired storage-class + BINARY
comparison, so a TIMESPAN column's minimum was the text-least duration (`P1D`
before `PT30M`), a JSON column's extrema were canonical-text extrema, and a
`collate nocase` column's extrema were BINARY. All other ordering sites (ORDER
BY, `<`/`>`, DISTINCT, index order) already route through the declared type's
semantic ordering / the resolved collation.

The fix, as designed in the source ticket:

- **New seam**: `AggregateFunctionSchema.bindArgs` — an optional per-call-site
  specialization hook, called ONCE at emit / plan-build time with one
  `AggregateArgBinding` (`{logicalType?, collation?}`) per declared argument.
  It returns replacement `stepFunction`/`finalizeFunction`/`algebra` closures.
  `bindAggregateSchema(schema, args)` (func/registration.ts) is the one
  applier; it is idempotent (the bound schema keeps the hook).
- **Shared routing**: `createSemanticValueComparator(type, collation)`
  (util/comparison.ts) — the scalar form of `createSemanticRowComparator`'s
  per-column rule (semantic-ordering type ⇒ the type's `compare`; else
  storage-class + collation). The row comparator now maps through it.
- **min/max**: collapsed into one factory (`extremumParts`) parameterised by
  direction and comparator, over a `{ v: SqlValue } | null` accumulator (the
  accumulator shape is opaque to every consumer — decode builds it, merge folds
  it, finalize unwraps it). Registered default = BINARY (today's behavior for
  untyped/never-bound consumers); `bindArgs` re-derives the whole
  step/merge/decode/finalize set over the argument's semantic comparator, so
  step and merge can never disagree.
- **Five executing sites**:
  1. stream-aggregate emitter — `aggregateSchemas` hoisted out of `run()` to
     emit time (also removes per-execution work) and bound from each argument's
     `getType()` + `ctx.resolveCollation`;
  2. hash-aggregate emitter — same;
  3. `buildDeltaAggregateDescriptor` (MV write side) — takes a new
     `CollationResolver` param (caller passes `ctx.getCollationResolver()`) and
     stores the BOUND schema + algebra on each `DeltaAggregateColumn`;
     `database-materialized-views-apply.ts` executes them with no edit;
  4. `buildReaggAggregate` (MV read-side rollup) — binds to the BACKING
     attribute's type/collation before pulling `merge`/`decode`;
  5. scalar-agg decorrelation's empty-group value — needs NO binding
     (finalize of the identity accumulator never compares); commented.
- **Gating untouched**: delta/rollup eligibility reads algebra field PRESENCE
  off the unbound declaration; the bind contract (documented on `bindArgs`)
  requires the bound algebra to declare the same fields.
- **Coercion**: `aggregateSkipCoercion` in both emitters now also skips
  `coerceForAggregate` when every argument type carries semantic ordering
  (behavior-neutral today; keeps numeric-string coercion away from the typed
  comparator). The pre-existing TEXT-min/max numeric-string coercion quirk
  (`min('5','10')` → number 5) is unchanged and documented as a NOTE on
  `coerceForAggregate`.

## Validation performed

- `yarn build` (root, all packages), `yarn test` (root — all workspaces, incl.
  quereus's 7352 logic/spec tests), `yarn lint` (incl. quereus's tsc pass over
  test files): all green.
- Flipped the KNOWN-GAP expectation in `107-…sqllogic` to `mn=PT0S, mx=P1D` and
  added: min/max ≡ `order by … limit 1` (asc/desc), `min(distinct)` ≡ plain,
  GROUP BY (hash-aggregate) shape, and a TIMESPAN materialized view exercised
  through create-fill, an insert that lowers the min (delta merge arm), and a
  delete of the extreme (tighten residual fallback), with stored ≡ direct
  asserted after the merge.
- JSON: `[8,1]`,`[9]`,`[10]` ⇒ `mn=[8,1]`, `mx=[10]`, plus DISTINCT form
  (06.9.2 § 12).
- NOCASE: new `mm_nc` section in 06.4.2 asserts min/max ≡ `order by t limit 1`
  and the literal extrema over tie-free values.
- Rollup: new deterministic block in `query-rewrite-equivalence.spec.ts` — a
  TIMESPAN min/max MV answers exact-key / rollup-to-coarser-key / global
  queries identically with the rewrite on vs off, asserts the rollup really
  rewrites onto the backing, and pins elapsed-time extrema the text order would
  get wrong.
- Algebra laws: `aggregate-algebra.spec.ts` now law-checks
  `bindAggregateSchema(minFunc/maxFunc, [{logicalType: TIMESPAN_TYPE}])` over a
  semantically-distinct duration domain, plus a direct pin that the bound merge
  tightens `PT90M` under `PT2H` while the unbound (BINARY) merge does the
  opposite — this is the check that catches a step/merge comparator mismatch.

## Known gaps / notes for the reviewer

- **One existing expectation changed**: `06.4.2-collation-extras.sqllogic`'s
  `coll_agg` block asserted `min(val)=APPLE` under NOCASE — that was the old
  BINARY answer wearing a NOCASE comment ('apple' and 'APPLE' tie under NOCASE,
  and the engine now keeps the first-encountered spelling, 'apple'). Rewritten
  to fold through `upper()` so the assertion is representative-agnostic. Which
  raw spelling survives a tie is deliberately unspecified (documented in
  code + docs/types.md), matching DISTINCT/GROUP BY latitude.
- **Delta-arm selection is not asserted**: the MV sqllogic test proves the
  VALUES are right through insert and delete-of-extreme, but cannot prove the
  delta-aggregate arm (vs the plain residual) actually executed the insert.
  Both arms now use the bound comparator, so either way is correct; a reviewer
  wanting arm-level proof can extend
  `test/incremental/maintenance-equivalence.spec.ts` with a TIMESPAN min/max
  body.
- **`yarn test:store` not run** (per repo guidance it is for store-specific
  diagnosis). The change is comparator-level and store-agnostic — the store's
  TIMESPAN key handling predates it — but store-mode logic tests re-running
  these files would be a cheap extra check.
- **Window `min()/max() over (…)` is still wrong** — different registry, raw JS
  `<`. Tracked as `minmax-window-semantic-ordering` (already in implement/,
  prereq on this ticket); docs/types.md points at it.
- The read-side rollup binds to the backing ATTRIBUTE's type. For min/max the
  backing column type equals the argument type (`inferReturnType` is identity),
  so one binding covers decode-of-stored and merge-of-stored; the same
  single-binding assumption is stated as a comment in
  `buildDeltaAggregateDescriptor` for the write side.
- `bindArgs` for min/max allocates a fresh closure set per call site at emit
  time — once per statement compile, not per row; no tripwire worth recording.
