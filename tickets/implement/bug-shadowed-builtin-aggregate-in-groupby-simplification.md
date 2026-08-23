---
description: If an application registers its own function named "min", one of the query optimizer's rewrites keeps treating it as the built-in "min", and an ordinary SELECT silently returns wrong values.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts   # line ~142 — the `min/1` lookup that must gate on built-in identity
  - packages/quereus/src/core/database.ts                                            # ~2356 `_findFunction`, ~2372 `_isBuiltinFunction` — add the combined lookup here
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts        # ~159 — the sibling site, already gated; switch only if it reads cleaner
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts            # regression test lands here
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts                     # ~314 — the existing shadow test to mirror
repro: verified
difficulty: easy
---

# A user-defined `min` is mistaken for the built-in `min`

## The defect, confirmed

Quereus lets an application register its own SQL functions, and registration
overwrites by name and argument count. So `db.createAggregateFunction('min', …)`
replaces the built-in `min/1` for every query on that connection.

The optimizer rule `ruleGroupByFdSimplification` drops `GROUP BY` columns that are
already determined by the remaining grouping columns, and re-emits each dropped
column as a `min(<column>)` "picker" — its way of saying "any value from this group,
they are all identical". That is true only of the *built-in* `min`. The rule resolves
the picker by name:

```ts
const minSchema = context.db._findFunction('min', 1);
if (!minSchema || !isAggregateFunctionSchema(minSchema)) { … return null; }
```

so once an application has taken the name over, the picker runs the application's
aggregate and the query returns whatever that computes. No error, no warning.

Verified against the memory backend during this ticket (a throwaway spec, since
removed — the tree is clean):

```ts
const db = new Database();
await db.exec('create table pk (id integer primary key, v integer not null)');
await db.exec('insert into pk values (1, 100), (2, 200)');
db.createAggregateFunction('min', { numArgs: 1, initialState: 0 },
  (acc) => acc + 1,   // deliberately not an extremum: counts rows
  (acc) => acc);
// select id, v from pk group by id, v order by id
```

| registration | observed result |
| --- | --- |
| no user `min` | `[{id:1, v:100}, {id:2, v:200}]` — correct |
| user `min` registered | `[{id:1, v:1}, {id:2, v:1}]` — wrong |

Here `id` is the primary key, so `v` is functionally determined, gets dropped from the
`GROUP BY`, and comes back as the shadow's row count instead of its own value.

## Why a name check cannot fix this

Both the planner's own resolution and a second `_findFunction('min', 1)` return the
*same* shadow after registration, so comparing them only proves they agree with each
other. The only question that distinguishes the two is **schema identity**: is this
object one of the schemas the database registered from its built-in list?
`Database._isBuiltinFunction(schema)` answers exactly that (it tests membership in the
private `builtinFunctionSchemas` set), and a user schema cannot declare its way in.
That helper already exists — it was added when the same mistake was found in
`rule-minmax-index-boundary`, which now gates on it at line ~159.

## Confirmed fix

Adding the identity gate to the lookup makes the reproduction pass and leaves every
existing test in both affected specs green (verified: 30 passing across
`rule-groupby-fd-simplification.spec.ts`, `minmax-index-boundary.spec.ts`, and the
throwaway repro). When the gate declines, the rule simply does not fire; the query is
then answered by the ordinary grouped aggregate, which is correct and only slightly
slower.

## Shape of the change

This is the **second** instance of one class — "a rule assumes a function with this
name has the built-in's semantics" — so fix it a rung above the instance: give the
class one obvious, hard-to-misuse entry point on `Database`, right beside
`_findFunction`:

```ts
/** @internal Resolve `funcName/nArg` ONLY when it is the built-in registration.
 *  Returns undefined when the name has been taken over by a user function, so a
 *  caller whose rewrite is sound only for built-in semantics cannot accidentally
 *  pick up the shadow. See {@link _isBuiltinFunction} for why a name (or a second
 *  lookup) cannot answer this. */
_findBuiltinFunction(funcName: string, nArg: number): FunctionSchema | undefined
```

implemented as `_findFunction` filtered through `_isBuiltinFunction`. The rule then
calls that instead of `_findFunction`, and the "not registered as aggregate" log line
becomes "min/1 is not the built-in aggregate; skipping" so a declined rewrite is
diagnosable.

`rule-minmax-index-boundary` keeps `_isBuiltinFunction` as-is — it gates a schema that
arrives on the plan node, not a lookup it performs — so there is nothing to migrate
there.

## Sweep result (done; no further sites)

Every other place that resolves a function by name was checked. All of them read a
*declared property* off whatever schema resolves (`FunctionFlags.DETERMINISTIC`, or
the rollup algebra an aggregate schema declares), which is the right behaviour under
shadowing — a user function's own flags should govern. Those are
`rule-materialized-view-rewrite.ts` (~107, ~195), `lens-prover.ts` (~1310),
`schema/manager.ts` (~2419) and `mutation/decomposition.ts` (~1685). Leave them alone.

The window-function path (`rule-monotonic-window.ts` ~265, `runtime/emit/window.ts`
~1492) dispatches on bare names like `sum`/`count`/`avg`, which *looks* like the same
smell but is not: window functions live in their own module-global registry
(`schema/window-function.ts`), populated only by `builtin-window-functions.ts`, with no
public registration API. Every name that reaches those switches is a built-in. Worth a
second look only if user-registered window functions are ever added.

So after this ticket the class has no known open instances.

## TODO

- Add `_findBuiltinFunction(funcName, nArg)` to `Database` next to `_findFunction`, with the doc comment above; implement it as `_findFunction` filtered through `_isBuiltinFunction`.
- Switch `rule-groupby-fd-simplification.ts` (~142) to `context.db._findBuiltinFunction('min', 1)`, keep the `isAggregateFunctionSchema` narrowing (the picker node needs the aggregate schema type), and reword the log line to say the rewrite declined because `min/1` is not the built-in.
- Update the rule's file header comment: it currently states the picker is `MIN(<original-column>)` without qualification — say it is the *built-in* `min`, and that the rule declines when the name is shadowed.
- Add a regression test to `test/optimizer/rule-groupby-fd-simplification.spec.ts` in the shape reproduced above: register a counting `min/1` aggregate, then assert both that the rewrite declined (the aggregate node still carries both `GROUP BY` columns via `aggregateProps`) and that the rows are the true values `100`/`200`. Mirror the comment style of the sibling test at `minmax-index-boundary.spec.ts:314`, which explains why identity and not a name comparison is the gate.
- Also assert the un-shadowed control in the same spec if it is not already covered — same query on a fresh `Database` must still collapse the `GROUP BY` to one column, so the test proves the gate is not simply disabling the rule outright.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
