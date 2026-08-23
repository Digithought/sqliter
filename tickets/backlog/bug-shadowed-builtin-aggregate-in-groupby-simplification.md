---
description: If an application registers its own aggregate function named "min", one of the optimizer's rewrites keeps using it as if it were the built-in, and a plain SELECT starts returning the wrong values.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts   # line ~142, the `min/1` lookup
  - packages/quereus/src/core/database.ts                                            # `_isBuiltinFunction`, the identity gate to use
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts       # the sibling site, already fixed this way
repro: verified
severity: wrong-result
likelihood: contrived
tradeoffs: Only an application that registers a function with the same name as a built-in aggregate can hit this, so a maintainer could reasonably call name collisions the caller's problem and close it — the counter-argument is that the fix is three lines and the failure is silent wrong data, not an error.
---

# A user-defined `min` is mistaken for the built-in `min`

## What happens

Quereus lets an application register its own SQL functions. Registration overwrites by
name and argument count, so registering an aggregate called `min` that takes one argument
replaces the built-in `min` for every query on that connection.

One optimizer rewrite (`rule-groupby-fd-simplification`) drops `GROUP BY` columns that are
already determined by the other grouping columns, and re-adds each dropped column as a
`min(<column>)` "picker" — a way of saying "any value from the group, they are all the
same". That is only true of the *built-in* `min`. The rule looks the function up by name,
so once an application has registered its own `min`, the picker silently runs the
application's function instead, and the query returns whatever that function computes.

## Reproduction (run against the memory backend)

```ts
const db = new Database();
await db.exec('create table pk (id integer primary key, v integer not null)');
await db.exec('insert into pk values (1, 100), (2, 200)');
db.createAggregateFunction('min', { numArgs: 1, initialState: 0 },
  (acc) => acc + 1,          // deliberately not an extremum: counts rows
  (acc) => acc);
// select id, v from pk group by id, v order by id
```

| registration | result |
| --- | --- |
| no user `min` | `[{id:1, v:100}, {id:2, v:200}]` — correct |
| user `min` registered | `[{id:1, v:1}, {id:2, v:1}]` — wrong |

No error, no warning; `v` is simply replaced by the user function's output.

## Expected behaviour

The rewrite must fire only when the picker it synthesizes is the built-in `min`. When the
name has been taken over by an application function, the rule should decline and leave the
grouping alone — the query is then answered without the rewrite, which is correct and only
slightly slower.

## Why this is filed separately

The same mistake existed in `rule-minmax-index-boundary` and was fixed during that
ticket's review by adding `Database._isBuiltinFunction(schema)` — an identity check
against the schemas the database registered from its built-in list, which name lookup
cannot answer (both the query's resolution and a second lookup return the same shadow, so
comparing them proves nothing). That helper already exists; this ticket is applying it at
the one remaining call site, plus a regression test in the shape above.

A sweep for other places that assume "a function with this name behaves like the built-in"
is worth doing at the same time — at the time of writing these two were the only two
lookups of that kind, and the materialized-view rewrite does the right thing already (it
keys off a capability the function schema declares, not off its name).
