description: Fixed and reviewed a bug where registering your own SQL function named "min" could make an unrelated GROUP BY query silently return wrong values, because an optimizer rewrite assumed "min" always meant the built-in.
files:
  - packages/quereus/src/core/database.ts                                            # `_findBuiltinFunction` (new); `_findFunction` doc reworded in review
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts    # the picker lookup, now gated on built-in identity
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts            # shadow / control / arity tests, grouped and de-duplicated in review
  - docs/optimizer-rules.md                                                           # rule entry now states the built-in gate (added in review)
  - docs/usage.md                                                                     # new "Shadowing a built-in function" note (added in review)
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts        # unchanged — sibling site already gated on `_isBuiltinFunction`
---

# `min/1` picker gates on built-in identity, not name

## What was wrong

`ruleGroupByFdSimplification` drops `GROUP BY` columns that are functionally determined
by the remaining grouping columns and re-emits each dropped column as a `min(<column>)`
"picker" aggregate. That is sound only because the *built-in* `min` returns the group's
one distinct value. The rule resolved the picker by name (`db._findFunction('min', 1)`),
so once an application registered its own `min` — registration overwrites by name and
argument count — the rewrite used the shadow and the query silently returned whatever
that computed. With `id` as the primary key and `v` determined by it, `select id, v from
pk group by id, v` returned the shadow's row counts (`1`, `1`) instead of `100`, `200`.

## What was done

`Database._findBuiltinFunction(funcName, nArg)` was added beside `_findFunction`,
implemented as `_findFunction` filtered through the pre-existing `_isBuiltinFunction`
(schema identity against the set of schemas registered from `BUILTIN_FUNCTIONS`; a name
cannot answer the question, because both the planner's resolution and a second lookup
return the same shadow). The rule now calls it, and declines the rewrite when the lookup
comes back empty — the query is then answered by the ordinary grouped aggregate, which is
correct and only slightly slower. The rule's header comment and its declined-rewrite log
line say "built-in `min`" explicitly.

`rule-minmax-index-boundary` needed no change: it gates a schema handed to it on the plan
node, using `_isBuiltinFunction` directly.

## Review findings

**Verified sound end-to-end.** The picker binds the built-in schema object onto the plan
node, and the aggregate emitter reads `funcNode.functionSchema`
(`src/runtime/emit/aggregate-setup.ts:88`) rather than re-resolving by name, so nothing
downstream can reintroduce the shadow after planning. `EmissionContext.validateCaptured
SchemaObjects` re-resolves by name but only logs a warning; it never swaps the schema.

**Correctness of the fix itself: no defects found.** The gate is per `(name, numArgs)`,
which is the right granularity, and declining is the safe direction.

### Fixed inline (minor)

- **Docs were stale.** `docs/optimizer-rules.md` listed the rule's skip conditions
  without the new built-in gate, while the sibling `ruleMinMaxIndexBoundary` entry
  documents its own gate at length. Added the missing condition and cross-referenced the
  sibling's explanation of why a name cannot answer this.
- **No user-facing documentation of shadowing at all.** Nothing in `docs/usage.md` told an
  application author that registering a function under a built-in's name replaces it for
  the whole connection, or what that costs. Added a "Shadowing a built-in function"
  subsection under the registration API, including the known materialized-view exception
  found below.
- **`_findFunction` was the unguarded footgun.** Its doc comment was the bare marker
  `/** @internal */`, so the next caller has nothing steering them to the safe variant.
  Reworded it to say what it resolves, when that is correct, and when
  `_findBuiltinFunction` is required instead. (Making it `private` was considered and
  rejected: `db.schemaManager.findFunction` is public and used by a dozen call sites, so
  the restriction would close one door out of two while breaking any external plugin
  that uses it.)
- **Test gap the implementer flagged, now closed.** The arity claim — that shadowing
  `min/2` must leave a rewrite resolving `min/1` alone — was believed to generalize but
  untested. Added `a shadow at a different arity leaves min/1 — and the rewrite — alone`;
  it passes.
- **Test duplication.** The two new tests repeated the same DDL / insert / plan / assert
  block. Grouped all three under a `describe` with `registerCountingMin(numArgs)` and
  `expectPkGrouping(table, expectedGroupByWidth)` helpers, so the third case cost three
  lines instead of twenty.

### Filed as a new ticket (major)

- **`tickets/fix/bug-mv-aggregate-rewrite-ignores-shadowed-function`** — the implement
  ticket's sweep concluded that the materialized-view rewrite reads only declared schema
  properties and is therefore correct under shadowing. That is wrong for the aggregate
  arm. `matchAggregateFragmentToMv` matches a query's aggregate to a view's stored
  aggregate by function **name**, so after `db.createAggregateFunction('sum', …)` a query
  the view covers is answered from the view's built-in-computed values while the same
  query over an uncovered column correctly runs the user's function. Reproduced and
  observed, not inferred: `select k, sum(x) from t group by k` returned `[30, 30]` where
  `[2, 1]` was correct, and `query_plan` shows an unchanged index scan of the view's
  backing before and after the registration. Narrowing detail worth knowing: the
  rewrite's existing determinism gate already declines a shadow registered with
  `createAggregateFunction`'s defaults, so only a shadow explicitly flagged deterministic
  reaches the bug. Maintenance was checked separately and still used the built-in, so the
  stored data is self-consistent and the defect is read-side only. The scalar-function
  analogue (an MV over `upper(name)`) was checked and does not reproduce — the projection
  rewrite never matches that shape.

### Checked, nothing found

- **Every other by-name function lookup**, re-walked rather than taken on trust:
  `rule-materialized-view-rewrite`'s determinism probe, `lens-prover`, `schema/manager`,
  `mutation/decomposition`, `planner/building/schema-resolution`, `planner/scopes/global`.
  All read a declared property off whatever schema resolves, which is the correct
  behavior under shadowing. The only exception is the aggregate-rollup path above, which
  is not reading a property but matching stored data.
- **Window functions** — the module-global registry (`schema/window-function.ts`) is
  populated only by `builtin-window-functions.ts` and has no public registration API, so
  every name reaching those name switches is a built-in. Unchanged from the implement
  ticket's assessment; confirmed independently.
- **Plan caching** cannot resurrect the bug in either direction: a plan built before a
  shadow holds the built-in schema object, and one built while shadowed simply declined.

### Considered and not filed

- **The rule could keep optimizing under a shadow** rather than declining, by binding the
  built-in `min` schema directly — the picker is synthetic and never re-resolved by name
  at emit. Not filed and not left as a comment: it is a speedup for applications that
  shadow `min`, worth nothing measured, and declining matches the settled behavior of the
  sibling rule. Recording it as a code note would have been noise at a site that is now
  correct.

## Validation

- `node test-runner.mjs --grep "ruleGroupByFdSimplification|minmax-index-boundary"` → 33
  passing (32 before this review pass, plus the new arity case).
- `yarn workspace @quereus/quereus lint` → clean (eslint + test-file typecheck).
- `yarn test` (all workspaces) → green; `packages/quereus` reports 10207 passing, 25
  pending (the same pre-existing skips as before this ticket).
