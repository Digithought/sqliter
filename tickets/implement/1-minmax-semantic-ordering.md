---
description: The min() and max() functions pick the smallest/largest value by comparing raw text, so the smallest duration, the smallest JSON document, and the smallest word in a case-insensitive column all come out wrong; they should compare by what the value means, the same way sorting and comparisons already do.
files:
  - packages/quereus/src/schema/function.ts                       # AggregateFunctionSchema — add the bind hook + binding types
  - packages/quereus/src/func/registration.ts                     # createAggregateFunction — pass the hook through; bindAggregateSchema helper
  - packages/quereus/src/util/comparison.ts                       # add createSemanticValueComparator; refactor createSemanticRowComparator onto it
  - packages/quereus/src/func/builtins/aggregate.ts               # minFunc / maxFunc — the actual fix
  - packages/quereus/src/runtime/emit/aggregate.ts                # stream-aggregate: bind at emit time
  - packages/quereus/src/runtime/emit/hash-aggregate.ts           # hash-aggregate: bind at emit time
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts   # buildDeltaAggregateDescriptor — bind stored agg columns
  - packages/quereus/src/core/database-materialized-views-apply.ts           # consumes the bound schema/algebra (no edit expected)
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts # buildReaggAggregate — bind before pulling merge/decode
  - packages/quereus/src/util/coercion.ts                         # coerceForAggregate — context for the skip-coercion note
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # flip the KNOWN GAP expectation
  - packages/quereus/test/util/aggregate-algebra-laws.ts          # law harness — should also cover a bound schema
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts
  - packages/quereus/docs/types.md                                # "Semantic ordering" — record that min/max now route through it
difficulty: hard
---

# min()/max() must rank by the argument's semantic order, not by raw text

## What is wrong

`min(x)` and `max(x)` compare with `compareSqlValuesFast(..., BINARY_COLLATION)` — SQLite
storage-class ordering with the byte/code-point collation, hard-wired. Every other
ordering site in the engine (`order by`, `<`/`>`, `distinct`, `group by`, index order)
instead routes through the argument's declared logical type when that type carries
semantic ordering, or through the column's declared collation. `min`/`max` were left out
because an aggregate step function receives bare runtime values and has no way to see the
call site's type or collation.

All four divergences below were reproduced against a build of `main`
(`packages/quereus/dist/src/index.js`, no local edits).

**TIMESPAN** (durations) — `dur` values `PT30M`, `PT1H`, `PT2H`, `P1D`, `PT0S`:

| query | result |
|---|---|
| `select id, dur from ts_test order by dur` | `PT0S, PT30M, PT1H, PT2H, P1D` (correct) |
| `select min(dur), max(dur) from ts_test`   | `mn=P1D, mx=PT30M` **(wrong)** |

`P1D` (one day) is reported as the *minimum* because the text `'P1D'` sorts first.

**JSON** — `d` values `[8,1]`, `[9]`, `[10]`:

| query | result |
|---|---|
| `select id, d from j order by d` | `[8,1], [9], [10]` (correct) |
| `select min(d), max(d) from j`   | `mn=[10], mx=[9]` **(wrong)** |

**Collation** (the older instance of the same gap) — `t text collate nocase`, values
`'B'` and `'a'`:

| query | result |
|---|---|
| `select t from t2 order by t`      | `a, B` (correct — NOCASE) |
| `select min(t), max(t) from t2`    | `mn=B, mx=a` **(wrong — BINARY)** |

**Materialized views** inherit the same wrong answer through both arms. A view
`select g, count(*), min(dur), max(dur) from src group by g` over `PT30M, PT2H, PT90M`
stores `mn=PT2H, mx=PT90M`; a subsequent `insert` of `PT10M` goes through the delta arm
(`algebra.merge`) and yields `mn=PT10M, mx=PT90M`. Stored and directly-evaluated values
agree with each other — because both are wrong the same way — so the fix must move them
together or a maintenance-equivalence check will start failing.

Reachable today; no flags or opt-ins involved.

## Expected behavior

`min(x)` / `max(x)` rank by the same comparator the argument's *ordering* sites use:

- argument's declared logical type carries `semanticOrdering` (TIMESPAN → elapsed time,
  JSON → structural deep-compare) ⇒ the type's own `compare`;
- otherwise ⇒ today's storage-class ordering, but under the argument's **resolved
  collation** rather than an unconditional BINARY;
- untyped / `any` argument with no collation ⇒ byte-identical to today.

This is exactly the routing `createSemanticRowComparator` (`util/comparison.ts:605`)
already performs per column for DISTINCT/set-operation row identity — the fix should
share that routing, not re-derive it.

`min(dur)` must then agree with `select dur from … order by dur limit 1`, and
`max(dur)` with `order by dur desc limit 1`, for every value set.

Ties under a non-BINARY collation (`'a'` vs `'A'` under NOCASE) compare equal, so which
raw value survives is unspecified — same latitude DISTINCT and GROUP BY already take when
choosing a group representative. Say so in a comment rather than pinning it in a test.

## Design

### The missing seam: bind an aggregate to its call site

Add an optional per-call-site specialization hook to `AggregateFunctionSchema`. It is
called **once**, at emit time (or at materialized-view plan-build time) — never per row —
with the resolved argument types and collations, and returns replacement
step/finalize/algebra closures that capture the comparison context.

```ts
// src/schema/function.ts

/** Resolved comparison context for ONE argument of an aggregate call site. */
export interface AggregateArgBinding {
	/** The argument's declared logical type; undefined when untyped / ANY. */
	readonly logicalType?: LogicalType;
	/** The argument's resolved collation; undefined ⇒ BINARY. */
	readonly collation?: CollationFunction;
}

/** The pieces a bind may replace. Any field omitted keeps the declared default. */
export interface AggregateFunctionBinding {
	readonly stepFunction?: AggregateReducer;
	readonly finalizeFunction?: AggregateFinalizer;
	readonly algebra?: AggregateAlgebra;
}

interface AggregateFunctionSchema {
	// …
	/**
	 * Optional specialization to the call site's comparison context. Called once per
	 * call site at emit / plan-build time — NEVER per row — with one binding per declared
	 * argument. Returns replacement closures, or undefined to keep the declared defaults.
	 * `algebra.merge` returned here MUST use the same comparison as the returned
	 * `stepFunction`, or materialized-view maintenance disagrees with direct evaluation.
	 */
	readonly bindArgs?: (args: readonly AggregateArgBinding[]) => AggregateFunctionBinding | undefined;
}
```

with the one applier every call site uses:

```ts
// src/func/registration.ts
export function bindAggregateSchema(
	schema: AggregateFunctionSchema,
	args: readonly AggregateArgBinding[],
): AggregateFunctionSchema {
	const bound = schema.bindArgs?.(args);
	return bound ? { ...schema, ...bound } : schema;
}
```

Binding is idempotent (rebinding with the same arguments yields an equivalent schema), so
`bindArgs` stays on the result and no call site has to track whether it already bound.

**Gating is unaffected.** Every place that *decides* whether an aggregate is
delta-maintainable / roll-up-able reads `schema.algebra?.merge` / `.negate` / `.decode` /
`.decompose` — presence, not identity (`planner/analysis/query-rewrite-matcher.ts:1256`,
`database-materialized-views-plan-builders.ts:778`). The unbound schema declares the same
fields, so no gate changes. Only the sites that *execute* step/merge/decode need binding.

### The shared comparator

```ts
// src/util/comparison.ts
/**
 * The comparator an ordering site uses for a single value of `type` under `collation`:
 * the type's own `compare` when it carries semantic ordering, else storage-class +
 * collation ordering. The scalar form of {@link createSemanticRowComparator}'s
 * per-column routing.
 */
export function createSemanticValueComparator(
	type: LogicalType | undefined,
	collation: CollationFunction = BINARY_COLLATION,
): (a: SqlValue, b: SqlValue) => number
```

Refactor `createSemanticRowComparator` to map its columns through this so there is one
copy of the routing rule.

### min / max

`minFunc` and `maxFunc` are the same aggregate with the sign flipped; today they are two
near-identical copies with differently-named accumulator fields (`{min: v}` / `{max: v}`).
Collapse them into one factory parameterised by name and direction, over a single
`{ v: SqlValue } | null` accumulator shape. The accumulator is opaque to every consumer
(`decode` builds it, `merge` folds it, `finalize` unwraps it), so renaming the field is
safe.

The factory takes a comparator and produces the `{stepFunction, algebra, finalizeFunction}`
triple; the registered default uses `compareSqlValuesFast(…, BINARY_COLLATION)` (today's
behavior, for the untyped case and any consumer that never binds), and `bindArgs` produces
the same triple over `createSemanticValueComparator(arg?.logicalType, arg?.collation)`.

Both `stepFunction` and `algebra.merge` must come from the same comparator — that is the
whole point of routing them through one factory. Delete the `NOTE:` block at
`func/builtins/aggregate.ts:161-167` that documents the gap.

### The five sites that execute an aggregate

1. **`runtime/emit/aggregate.ts` (stream aggregate).** `aggregateSchemas` is currently
   built inside `run()` (line 189) from `funcNode.functionSchema`, once per execution.
   Hoist it to emit time and bind there — the arg-type + collation resolution it needs is
   already written a few lines up for `distinctComparators` (lines 111-145): `arg.getType()`
   gives `{logicalType, collationName}`, and `ctx.resolveCollation(name)` resolves it.
   Hoisting also removes per-execution work.

2. **`runtime/emit/hash-aggregate.ts`.** Same change; the same resolution already exists
   at lines 78-107.

3. **`core/database-materialized-views-plan-builders.ts` → `buildDeltaAggregateDescriptor`
   (line 697).** Bind each aggregate column's `schema` from its argument node
   (`producing.args[0].getType()`, already required to be a `ColumnReferenceNode`) and
   store the **bound** `schema` and its **bound** `algebra` on the `DeltaAggregateColumn`.
   Zero-arg columns (`count(*)`) bind with an empty array. The function needs a
   `CollationResolver` parameter — `resolveBackingPkColumns` (line 111) in the same file
   already takes one from `db.getCollationResolver()`, so follow that pattern; the caller
   (`buildAggregateResidualPlan`, line 586) has `ctx`/`db` in hand.

   `database-materialized-views-apply.ts` (lines 888-891, 981-983) then executes the bound
   pair with no edit of its own.

   Soundness note to leave as a comment: the delta arm's `decode` reconstructs an
   accumulator from the **stored backing** value and merges it against step contributions
   from **source** rows. For min/max the backing column's type is `inferReturnType(argType)
   = argType`, so one binding covers both sides. An aggregate whose result type differs
   from its argument type would need two bindings — none exists today, and none is
   delta-maintainable-and-comparison-sensitive; state the assumption rather than
   generalizing for it.

4. **`planner/rules/cache/rule-materialized-view-rewrite.ts` → `buildReaggAggregate`
   (line 662).** This builds the rollup fold `merge ∘ decode` over a stored backing column.
   Bind `schema` to the **backing attribute's** type and collation
   (`backingAttrs[backingCol].type`) before reading `schema.algebra!.merge` /
   `.decode!` at lines 671-672. `context.db` is available on the rule's `OptContext`
   (line 39) — thread a resolver down through `mergeReaggsFor` / the recipe builder at
   line 615.

5. **`planner/rules/subquery/rule-scalar-agg-decorrelation.ts:613`** —
   `finalizeFunction(cloneInitialValue(initialValue))`, the empty-group value. min/max
   finalize the identity accumulator to NULL regardless of comparator, so **no binding is
   needed here**. Leave a one-line comment saying so, so the next reader does not have to
   re-derive it.

### Coercion hazard

`coerceForAggregate` (`util/coercion.ts:86`) converts numeric-looking *strings* to numbers
for every aggregate except `count` / `group_concat` / `json_*`, and the emitters skip it
only when all argument types are numeric (`aggregateSkipCoercion`,
`emit/aggregate.ts:149`). A TIMESPAN literal (`'PT2H'`) and a JSON object both survive it
untouched today, so this is not currently a bug — but running a semantically-typed value
through numeric coercion on its way to a type-aware comparator is a hazard waiting to
happen. Extend `aggregateSkipCoercion` to also skip when every argument type carries
`semanticOrdering`. Behaviour-neutral today, and it keeps the new comparator honest.

Separately, and **out of scope**: `min`/`max` over a plain TEXT column of numeric-looking
strings already returns a *number* (`min('5','10')` → `5`), disagreeing with
`order by … limit 1`. That is the coercion rule, not the comparator, and predates this
ticket. Record it as a `NOTE:` at the `coerceForAggregate` call site rather than fixing it
here; if it should change, that is its own ticket.

## Tests

Existing expectation to flip —
`test/logic/107-temporal-arithmetic-mutation-kills.sqllogic:336-341` asserts the current
wrong answer under a "KNOWN GAP" comment. Change to `mn=PT0S, mx=P1D` and delete the
comment.

New coverage:

- **TIMESPAN**, both aggregate physical shapes: no-GROUP-BY (stream aggregate) and
  `group by` (hash aggregate — `92-hash-aggregate-edge-cases.sqllogic` or
  `15-timespan.sqllogic`). Assert `min(dur)` equals `order by dur limit 1` and
  `max(dur)` equals `order by dur desc limit 1` over the same rows.
- **JSON** (`06.9.2-json-structural-equality.sqllogic` or a sibling): values `[8,1]`,
  `[9]`, `[10]` ⇒ `mn=[8,1]`, `mx=[10]`.
- **Collation**: `t text collate nocase` with `'B'`, `'a'` ⇒ `mn` is the NOCASE-smallest
  (`a`), `mx` is `B`. Assert against `order by t limit 1` rather than a literal, so the
  tie-representative question stays open.
- **`min(distinct dur)` / `max(distinct dur)`** — DISTINCT dedup is already semantic; the
  result must match the non-DISTINCT form.
- **Materialized view**: `select g, count(*), min(dur), max(dur) from src group by g` over
  TIMESPAN. Assert the stored view equals the directly-evaluated query after (a) create,
  (b) an insert that lowers the min (exercises the delta `merge` path), (c) a delete of the
  extreme (exercises the tighten residual fallback).
- **Rollup rewrite**: a query that rolls a stored `min`/`max` TIMESPAN column up to a
  coarser grouping, asserted against the same query with the view-rewrite rule disabled.
- **Algebra laws**: `test/incremental/aggregate-algebra.spec.ts` currently exercises the
  unbound `minFunc`/`maxFunc`. Add a case that runs the law harness against
  `bindAggregateSchema(minFunc, [{logicalType: TIMESPAN_TYPE}])` (and max) over TIMESPAN
  text values, so the bound closures are law-checked too — that is what catches a
  step/merge comparator mismatch. `test/util/aggregate-algebra-laws.ts` takes a schema, so
  it should need no signature change.

## Constraints

- The comparator must reach `algebra.merge`, not just the step — otherwise
  store-maintained materialized views disagree with direct evaluation.
- Untyped / `any` arguments with no declared collation keep today's storage-class + BINARY
  behavior, byte for byte.
- Binding happens once per call site, at emit / plan-build time. Nothing in the per-row
  path may resolve a type or a collation.

## Out of scope

Window `min(x) over (…)` is broken too — and separately: it uses a different registry
(`schema/window-function.ts`) whose step is a raw JS `<`. Tracked as
`minmax-window-semantic-ordering`, which depends on the comparator helper this ticket
adds. Do not touch `func/builtins/builtin-window-functions.ts` here.

## TODO

- [ ] Add `createSemanticValueComparator` to `util/comparison.ts`; refactor
      `createSemanticRowComparator` onto it.
- [ ] Add `AggregateArgBinding` / `AggregateFunctionBinding` / `bindArgs` to
      `schema/function.ts`; document the same-comparison-as-step contract next to the
      existing `AggregateAlgebra` author contract.
- [ ] Thread `bindArgs` through `createAggregateFunction` (`func/registration.ts`) and add
      `bindAggregateSchema` there.
- [ ] Collapse `minFunc`/`maxFunc` into one comparator-parameterised factory over a single
      `{ v }` accumulator; register with the BINARY default and a `bindArgs` that uses the
      argument's semantic comparator. Delete the KNOWN-GAP `NOTE:` block.
- [ ] Bind at emit time in `runtime/emit/aggregate.ts` (hoisting `aggregateSchemas` out of
      `run()`) and `runtime/emit/hash-aggregate.ts`.
- [ ] Bind stored aggregate columns in `buildDeltaAggregateDescriptor`; take a
      `CollationResolver` parameter and pass it from `buildAggregateResidualPlan`.
- [ ] Bind the rollup fold in `rule-materialized-view-rewrite.ts:buildReaggAggregate`
      from the backing attribute's type/collation.
- [ ] Comment `rule-scalar-agg-decorrelation.ts:613` explaining why the empty-group value
      needs no binding.
- [ ] Extend `aggregateSkipCoercion` to skip coercion for semantic-ordering argument types;
      add the `NOTE:` about numeric-string coercion of TEXT min/max.
- [ ] Flip `107-temporal-arithmetic-mutation-kills.sqllogic` and add the TIMESPAN / JSON /
      NOCASE / DISTINCT / materialized-view / rollup coverage above.
- [ ] Add bound-schema cases to `test/incremental/aggregate-algebra.spec.ts`.
- [ ] Update `docs/types.md` "Semantic ordering" — min/max are no longer an exception; note
      that window min/max still is, pointing at `minmax-window-semantic-ordering`.
- [ ] `yarn build`, `yarn test`, `yarn lint`.
