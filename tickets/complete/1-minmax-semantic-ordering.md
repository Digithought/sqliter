---
description: The min() and max() functions used to pick the smallest/largest value by comparing raw text; they now compare by what the value means (durations by elapsed time, JSON by structure, case-insensitive columns by their collation), matching how sorting already works — including inside stored materialized views.
files:
  - packages/quereus/src/schema/function.ts                       # AggregateArgBinding / AggregateFunctionBinding / bindArgs hook
  - packages/quereus/src/func/registration.ts                     # bindAggregateSchema applier (field-wise merge)
  - packages/quereus/src/util/comparison.ts                       # createSemanticValueComparator; row comparator routes through it
  - packages/quereus/src/func/builtins/aggregate.ts               # min/max as one comparator-parameterised factory
  - packages/quereus/src/runtime/emit/aggregate-setup.ts          # NEW — emit-time setup shared by both aggregate emitters
  - packages/quereus/src/runtime/emit/aggregate.ts                # stream aggregate — now calls the shared setup
  - packages/quereus/src/runtime/emit/hash-aggregate.ts           # hash aggregate — same
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # delta descriptor binds stored agg columns
  - packages/quereus/src/core/database-materialized-views-plans.ts           # DeltaAggregateColumn doc
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts # MergeReagg.argCollation — records the argument's collation
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts # rollup binds to argument collation + backing type
  - packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts # comment: empty-group value needs no binding
  - packages/quereus/src/util/coercion.ts                         # NOTE on numeric-string coercion of TEXT min/max
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
  - packages/quereus/test/query-rewrite-equivalence.spec.ts       # TIMESPAN + NOCASE min/max rollup equivalence
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts   # law harness over the bound min/max schemas
  - docs/types.md, docs/aggregate-algebra.md, docs/mv-maintenance.md, docs/optimizer-rules.md, docs/sql-functions.md
---

# Complete: `min()`/`max()` rank by the argument's semantic order

## What shipped

`min(x)`/`max(x)` previously compared with a hard-wired storage-class + BINARY
comparison, so a duration column's minimum was the text-least duration (`P1D`
before `PT30M`), a JSON column's extrema were canonical-text extrema, and a
`collate nocase` column's extrema were BINARY — while every other ordering site
(ORDER BY, `<`/`>`, DISTINCT, index order) already used the declared type's
semantic ordering and the resolved collation.

The implementation added a per-call-site specialization seam and routed every
executing site through it:

- **`AggregateFunctionSchema.bindArgs`** — an optional hook called ONCE per call
  site at emit / plan-build time (never per row) with one
  `AggregateArgBinding` (`{logicalType?, collation?}`) per declared argument. It
  returns replacement `stepFunction` / `finalizeFunction` / `algebra` closures.
  `bindAggregateSchema(schema, args)` is the single applier and is idempotent.
- **`createSemanticValueComparator(type, collation)`** — the scalar form of the
  routing rule the row comparator (DISTINCT / set operations) already used:
  a semantic-ordering type uses its own `compare`, everything else uses storage
  class + collation. The row comparator now maps through it, so there is one copy.
- **min/max** collapsed into one factory parameterised by direction and
  comparator, over an opaque `{ v }` accumulator. The registered default is
  BINARY (today's behavior for untyped arguments); `bindArgs` re-derives
  step / merge / decode / finalize together, so step and merge cannot disagree.
- **Executing sites bound**: stream-aggregate emitter, hash-aggregate emitter,
  the materialized-view delta descriptor (write side), and the read-side rollup
  re-aggregation. The scalar-agg decorrelation empty-group value needs no
  binding (finalizing the identity accumulator never compares) and says so.
- **Delta / rollup eligibility gating is unchanged** — it reads algebra field
  presence off the unbound declaration, and the bind contract requires a binding
  to declare the same fields.

## Review findings

**Read first:** the implement diff (`940038cb`), then the handoff. Validation run
at review: `yarn build`, `yarn lint` (eslint + `tsc` over src and test files), and
`yarn test` (all workspaces — 7354 quereus tests plus every other package) all
green, both before and after the review's own edits. No pre-existing failures
surfaced, so `tickets/.pre-existing-error.md` was not written.

### Major — fixed in this pass (correctness regression the change introduced)

**Rolling a materialized view's `min`/`max` up to a coarser key ranked under
BINARY when the argument column had a collation.** An aggregate's *result* type
carries its argument's logical type but **not** the argument's collation, so a
view over `min(v)` where `v` is `collate nocase` lands in a BINARY-declared
backing column. The read-side rollup bound its `merge` from that backing
column's type, so it folded NOCASE-chosen stored partials under BINARY.
Reproduced end to end before fixing:

```sql
create table t (id integer primary key, k integer not null, v text collate nocase);
create materialized view nmv_k as
  select k, count(*) as c, min(v) as mn, max(v) as mx from t group by k;
insert into t values (1, 1, 'B'), (2, 2, 'a');

select min(v), max(v) from t;   -- with the view: mn=B, mx=a   (BINARY)
                                -- without it:   mn=a, mx=B   (NOCASE)
```

Note this is *new* inconsistency, not a pre-existing one: before the change both
paths were BINARY and agreed. The duration/JSON half of the feature was
unaffected, because the logical type *does* propagate — which is why the
implementer's TIMESPAN rollup test passed and this gap stayed hidden.

Fixed by recording the argument's declared collation on the rollup recipe
(`MergeReagg.argCollation`, filled from the base table column the matcher already
resolved — the matcher only admits bare base-column arguments, so it is exactly
the argument's collation) and binding the rollup with it, falling back to the
backing column's collation. Regression test added:
`query-rewrite-equivalence.spec.ts` § *NOCASE min/max rollup equivalence*
(rewrite-on == rewrite-off, plus a pinned non-vacuous assertion that the global
rollup really does rewrite onto the backing).

### Minor — fixed in this pass

- **The materialized-view test did not actually discriminate the delta merge
  arm.** `107-…sqllogic` inserted `PT10M` into a group whose stored minimum was
  `PT30M` — but `'PT10M'` sorts first under *both* text and elapsed-time order,
  so a BINARY merge would have produced the same answer. Changed the inserted
  value to `P1D`, which disagrees against *both* stored extrema at once (it sorts
  before `PT30M` textually yet is the longest duration in the group), so the
  assertion now fails if the delta merge loses its binding. Arm-level proof is
  still out of reach (see *Not fixed* below), but the value check is now real.
- **~85 lines duplicated verbatim between the two aggregate emitters.** The diff
  added a third identical block (the bind loop) next to two that were already
  copied (DISTINCT comparators, coercion-skip). Extracted to a new
  `runtime/emit/aggregate-setup.ts`; each emitter is now three lines. Also
  collapsed the `collationName ? resolveCollation(…) : undefined` idiom, which
  appeared six times across the two files, into one helper.
- **`bindAggregateSchema` could strip a declared field.** It spread the hook's
  return over the schema, so a hook returning an explicit `algebra: undefined`
  would drop the algebra — silently disabling delta maintenance and rollup —
  despite the documented contract saying an omitted field keeps the default.
  Now merges field by field with `??`.
- **A test comment claimed coverage that was not there.** `06.9.2`'s new section
  said "GROUP BY shape (hash aggregate) and DISTINCT agree" above a query that
  only exercised DISTINCT. Split the claim and added the missing GROUP BY case.
- **Two-step binding in the delta descriptor.** `buildDeltaAggregateDescriptor`
  bound once with an empty argument list and then rebound for the single-argument
  case. Collapsed to one bind over a built binding list.
- **A doc comment sat on the wrong declaration.** The new NOTE about
  `coerceForAggregate` was attached to the `NON_NUMERIC_AGGREGATES` const above
  it rather than the function it describes. Moved onto the function.

### Docs — checked and updated

Every doc the change touched or should have touched was read, not assumed:

- `docs/types.md` — the implementer's rewrite of the min/max paragraph was
  accurate. Added the consequence that an aggregate's result type drops the
  argument's collation, since that is what the rollup bug turned on.
- `docs/aggregate-algebra.md` — **was stale**: its builtin table still described
  min/max's merge as "the same BINARY comparison as step". Corrected, and added a
  *Call-site binding (`bindArgs`)* section — this is the author-contract page for
  aggregate algebra, so the new extension point's two obligations (bound merge
  must match bound step; bound algebra must declare the same fields) belong here
  rather than only in a TSDoc comment.
- `docs/mv-maintenance.md` — **was stale** in the same way ("the same `BINARY`
  compare the `step` uses" in the tighten-only section). Corrected with a pointer
  to the binding section.
- `docs/optimizer-rules.md` — the rollup-arm description said nothing about
  comparison context. Added the binding rule and why the collation comes from the
  argument rather than the backing column.
- `docs/sql-functions.md` — the user-facing function reference described `min`/`max`
  neutrally ("the minimum value of all non-NULL values"), which was not wrong but
  no longer says enough now that the answer depends on the argument's type and
  collation. Added the rule and a pointer to *Semantic ordering*, plus a line on
  the window forms noting they have **not** changed — that inconsistency is now
  user-visible, so the reference should say so rather than let a reader assume the
  two behave alike.
- `packages/quereus/README.md`, `docs/architecture.md`, `docs/sql.md`,
  `docs/functions.md`, `docs/window-functions.md` — read; their `min`/`max`
  mentions are name lists or determinism examples with no comparison-order claim,
  so nothing to update.

### Checked and found sound (no action)

- **Every executing path for a min/max accumulator was traced.** The step /
  finalize / merge call sites are the two emitters, the delta-apply flush, the
  rollup re-aggregation, and the decorrelation empty-value probe; all four that
  compare are bound, and the fifth provably does not compare. The synthesized
  rollup aggregate closes over already-bound `merge`/`decode` and declares no
  `bindArgs`, so the emitter's later bind is a correct no-op rather than a
  double-bind.
- **Widening the coercion skip to semantic-ordering types is behavior-neutral.**
  `coerceForAggregate` now also skips when every argument carries semantic
  ordering, which affects `sum`/`avg`/`total`/`var_*`/`stddev_*` over `timespan`
  and `json`, not only min/max. All of those parse strings inside their own step
  functions, so nothing changes for them.
- **The rollup binds to the backing attribute's logical type**, which for min/max
  equals the argument type because `inferReturnType` is identity. The same
  single-binding assumption on the write side is stated in the code.
- **The tie-representative expectation change** in `06.4.2` was legitimate: the
  old `min(val) = 'APPLE'` assertion under NOCASE was the BINARY answer wearing a
  NOCASE comment. Folding through `upper()` is the right fix, and leaving which
  raw spelling survives a tie unspecified matches the latitude DISTINCT and
  GROUP BY already take.
- **No scalar `min(a,b)`/`max(a,b)` exists** in this engine, so the aggregate is
  the only surface — nothing else to bind.
- **Source hygiene** of the new code: the min/max factory is short and
  single-purpose, the new comparator helper is four lines, and the new emit-setup
  module is a set of small named functions. No oversized files resulted.

### Filed as new tickets

- `backlog/bug-text-minmax-numeric-coercion` — pre-existing and untouched by this
  change, but real and previously untracked: over a plain `text` column,
  `min`/`max` convert number-looking strings to numbers before comparing, so
  `min(v)` over `'5'` and `'10'` returns the number `5` while `order by v limit 1`
  returns `'10'`. Wrong row *and* wrong storage class out. The implementer
  documented it in a code comment and correctly scoped it out; the ticket makes it
  triageable. Filed to `backlog/` rather than `fix/` because closing it is a
  deliberate behavior change, not a straightforward repair.

### Tripwires (recorded, not ticketed)

- The read-side rollup and the write-side delta arm each assume **one** binding
  covers both decoding stored values and stepping source values, which holds only
  while a comparison-sensitive aggregate's result type equals its argument type.
  Recorded as `NOTE`-style comments at both sites rather than a ticket: no such
  aggregate exists today, and the assumption is stated where a future author would
  meet it.

### Not fixed — carried forward

- **Delta-arm selection is still not asserted.** The materialized-view test now
  proves the *values* are right through an insert and a delete of the extreme, and
  the inserted value now discriminates the comparator, but nothing proves the
  delta-aggregate arm (rather than the plain residual recompute) executed the
  insert. Both arms use the bound comparator, so either is correct. A reviewer
  wanting arm-level proof can add a duration-typed min/max body to
  `test/incremental/maintenance-equivalence.spec.ts` — its `AGGREGATE_SHAPES`
  suite already random-mutates a `min`/`max` body over an integer column, so the
  work is extending the fixture to a semantic-ordering column type.
- **`yarn test:store` was not run**, per repo guidance that it is for
  store-specific diagnosis. The change is comparator-level and store-agnostic.
- **Window `min(x) over (…)` still ranks with a raw JS compare** — a different
  registry with no binding seam. Tracked as `minmax-window-semantic-ordering`
  (already in `implement/`, prereq on this ticket); `docs/types.md` points at it.
