description: If an application registers its own aggregate function using the name of a built-in one (for example its own "sum"), a query that a materialized view happens to cover silently returns the view's pre-computed built-in values instead of running the application's function.
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts              # ~596 matchAggregateFragmentToMv, ~1229 recipeForRollup, and the exact-key recipeForExact it calls — the name-only match
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts  # ~194 resolveAggregate — resolves the query's aggregate off the live registry by (name, argc)
  - packages/quereus/src/core/database.ts                                       # ~2356 _findFunction / ~2367 _findBuiltinFunction / ~2385 _isBuiltinFunction — the identity surface a gate would use
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts # the sibling site already fixed this way, for reference
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                       # matcher unit tests — where a regression case fits
repro: verified
severity: wrong-result
likelihood: unusual
difficulty: medium
---

# A materialized view answers with the built-in's values after the name is taken over

## What happens

Quereus lets an application register its own SQL functions, and registration overwrites
by name and argument count — `db.createAggregateFunction('sum', …)` replaces the
built-in `sum/1` for every query on that connection.

Separately, the optimizer can answer a `group by` query from a materialized view that
already stores the same aggregate. It decides whether the view covers the query by
comparing the query's aggregate **name** (`sum`) against the name recorded for the
view's stored column. Nothing checks that the name still means the same function it
meant when the view was built.

So once an application takes over an aggregate's name, a query the view covers is
answered from the view's stored values — computed by the *built-in* — while the very
same query over a column the view does not cover correctly runs the application's
function. Two spellings of the same query disagree, and neither errors.

## Reproduction (run, observed)

```ts
const db = new Database();
await db.exec('create table t (id integer primary key, k integer not null, x integer not null) using memory');
await db.exec('insert into t values (1,1,10),(2,1,20),(3,2,30)');
await db.exec('create materialized view mv as select k, sum(x) as s from t group by k');

// A user aggregate that deliberately is not a sum: it counts rows.
db.createAggregateFunction('sum',
  { numArgs: 1, initialState: 0, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
  (acc) => acc + 1,
  (acc) => acc);
```

| query | expected (user `sum` = row count) | observed |
| --- | --- | --- |
| `select k, sum(id) from t group by k` — not covered by the view | `[{k:1,s:2},{k:2,s:1}]` | `[{k:1,s:2},{k:2,s:1}]` — correct |
| `select k, sum(x) from t group by k` — covered by the view | `[{k:1,s:2},{k:2,s:1}]` | `[{k:1,s:30},{k:2,s:30}]` — **wrong**, the built-in's sums |

`query_plan` confirms the mechanism: before the registration and after it, the covered
query plans identically as an index scan of the view's backing table. The rewrite does
not notice that `sum` changed meaning.

## What narrows it today, and what does not

- **The determinism gate already catches the common case.** The rewrite requires every
  function involved to be flagged deterministic, and `db.createAggregateFunction`
  defaults to *not* deterministic. A shadow registered with the plain default therefore
  declines the rewrite and behaves correctly. Only a shadow that explicitly declares
  itself deterministic (as above) reaches the bug. That is why this is filed as
  unusual rather than normal-use — but it is a flag an application sets in good faith,
  not a warning sign.
- **The stored data itself stays consistent.** After registering the shadow, inserting a
  new base row still maintained the view with built-in `sum` semantics (`30 + 5 = 35`),
  so the backing is not a mix of two functions' output — the defect is purely on the
  read side. Worth re-confirming for the case where the view's body is planned *after*
  the shadow is registered (a fresh connection over persisted state), which this
  reproduction did not cover; if maintenance picks up the shadow there, the backing
  really can end up mixed and the ticket grows an arm.
- **The scalar-function analogue was checked and does not reproduce.** A materialized
  view over `upper(name)` is not matched by the projection rewrite in the first place,
  so shadowing `upper` changes nothing.

## Why the fix belongs above the instance

This is the third site in one class: *a rewrite treats a function name as if it named
the function whose semantics the rewrite depends on.* The first two were
`ruleMinMaxIndexBoundary` and `ruleGroupByFdSimplification`, and both were settled the
same way — gate on **schema identity** rather than name, via
`Database._isBuiltinFunction` / `_findBuiltinFunction`, and decline when the name has
been taken over (declining is always safe: the query falls back to computing the
aggregate itself).

The materialized-view case needs a slightly stronger version of the same invariant,
because "built-in" is not the whole answer: a view may legitimately have been built over
a user aggregate that was registered before it. What must hold is that **the function
resolving now is the function whose output the view stores**. Expressing that requires
the view's recorded derivation to carry enough identity for the matcher to compare
against — not just `(name, argc)`. Getting that representation right is the substance of
this ticket; a name-plus-built-in-flag check would close the reproduced case but leaves
the user-aggregate-swapped-for-another-user-aggregate case open.

## Expected behavior

- A query whose aggregate resolves to a function other than the one that produced a
  candidate view's stored values must not be answered from that view. It computes the
  aggregate normally — correct, and only slower.
- The decline is diagnosable: the matcher's existing per-reason failure reporting (the
  `fail('…')` codes the unit tests observe) should name this reason distinctly rather
  than folding into an existing one.
- A view built over a user-registered aggregate keeps working while that registration
  stands; it stops being used if the name is re-registered to something else.
