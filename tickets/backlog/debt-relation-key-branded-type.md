---
description: Once the engine's table-read label has a single owner, the next step is to make the compiler treat it as its own kind of value, so an ordinary piece of text can no longer be passed where that label is expected.
prereq: debt-one-owner-for-relation-key
files:
  - packages/quereus/src/planner/analysis/relation-key.ts       # where the type would be declared (created by the prereq)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts # TableInfo.relationKey, targetRelation, the per-key maps
  - packages/quereus/src/planner/analysis/binding-extractor.ts    # PlanBindings maps
  - packages/quereus/src/planner/analysis/key-filter.ts           # injectKeyFilter's targetRelationKey parameter
  - packages/quereus/src/runtime/delta-executor.ts                # per-key maps
  - packages/quereus/src/schema/assertion.ts                      # AssertionDependentTable.relationKey — a rehydration boundary
  - packages/quereus/src/func/builtins/explain.ts                 # emits the key as a SQL value
difficulty: medium
tradeoffs: The prereq already removes the way this label gets built wrong; this only stops a *different* string being passed where the label belongs, and it costs a type change that touches every map, interface field, and function parameter carrying the key — a maintainer may reasonably want a second real incident before paying that.
---

# Make the table-read label its own type

## Background

The engine names each place a query reads a table with a short text label of the
form `<schema>.<table>#<node id>`, lowercase — the "relation key". Its sibling
ticket `debt-one-owner-for-relation-key` gives that label one owner module, so it is
built and taken apart in exactly one place.

That fixes *mis-spelling*. It does not fix *mis-passing*: the label is still a plain
`string`, so nothing stops a bare table name, a display name, or an unrelated
identifier being handed to a function that expects the label. The failure mode is the
same one the owner module was created to kill — a map lookup that finds nothing and
degrades quietly rather than throwing.

## What is being asked for

Give the label a type the compiler enforces, rather than a documentation-only alias:

```ts
export type RelationKey = string & { readonly __relationKey: unique symbol };
```

Everything that carries the label adopts the type — `TableInfo.relationKey`, the
`targetRelation` on extracted constraints, `injectKeyFilter`'s target parameter, the
per-key `Map` types in `binding-extractor.ts` and `delta-executor.ts`, and the
assertion schema's `dependentTables`. Casts happen only at the owner module's
constructors and at boundaries where a key arrives as untyped text — rehydrating an
assertion's stored dependents, and `explain_assertion` handing the key back out as a
SQL string value.

## Why it is filed separately

The blast radius is not measurable until the owner module lands and every site is
routed through it. It could be a tidy afternoon or it could ripple through several
dozen map declarations; a rough count of `relationKey` / `relKey` / `targetRelation`
mentions in `packages/quereus/src` today is around 50, but how many are *type* sites
rather than uses is exactly the unknown. Whoever picks this up should measure first
and say the number in the handoff.

There is also a judgement call worth making explicitly: branding map *keys*
(`Map<RelationKey, BindingMode>`) is where most of the protection lives — a
`map.get(someString)` stops compiling — and also where most of the churn lives. It is
reasonable to brand the interface fields and function parameters and leave the map
key types alone; that is a smaller change with most of the benefit at call sites.
Decide, do not drift into it.

## Not in scope

Changing the label's format, its owner module's API shape, or which sites compute it.
That is all settled by the prereq.
