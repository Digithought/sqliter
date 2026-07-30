---
description: Five places in the codebase separately hand-roll "find which table owns the index with this name", and they already disagree with each other about which structures count — replace them with one shared lookup.
prereq: bug-drop-index-removes-unique-constraint-backing
files:
  - packages/quereus/src/schema/manager.ts (findIndexNameOwnerElsewhere ~2450, dropIndex ~2469, resolveIndexTagSwap ~1226)
  - packages/quereus/src/runtime/emit/drop-index.ts (strict-DDL-policy owner scan)
  - packages/quereus-sync/src/sync/store-adapter.ts (findIndexOwner ~403)
  - packages/quereus/src/index.ts (public exports)
  - packages/quereus/src/schema/catalog.ts (isImplicitCoveringIndex, isHiddenImplicitIndex)
difficulty: medium
---

## Why

`DROP INDEX`, `ALTER INDEX … TAGS`, and sync's replicated index DDL all name an
index without naming its table, so each has to scan a schema's tables to find the
owner. That scan is written out five times:

| site | today's rule for a UNIQUE constraint's hidden backing structure |
|---|---|
| `SchemaManager.findIndexNameOwnerElsewhere` | skip it, keep scanning |
| `SchemaManager.dropIndex` | skip it, keep scanning *(after the prereq ticket)* |
| `SchemaManager.resolveIndexTagSwap` | skip only the **hidden** one; an exposed one is a legitimate target |
| `emitDropIndex`'s strict-DDL-policy gate | skip it, keep scanning *(after the prereq ticket)* |
| `quereus-sync` `store-adapter.ts` `findIndexOwner` | **takes the first match of any kind** |

The sync copy's own comment says it mirrors `SchemaManager.dropIndex` "because
the schema manager exposes no index accessor". After the prereq ticket lands,
four of the five agree and the sync one is the odd one out — a replicated
`drop index` naming a constraint's structure would resolve to it there and not in
the engine. Nothing is known to produce that DDL today (the differ filters
implicit structures out), so this is a consistency and future-drift fix, not a
live defect.

## Design

Add one public method to `SchemaManager` and delete the five loops.

```ts
/** How much of the index namespace a by-name owner lookup should consider. */
export type IndexLookupScope =
    /** Only indexes a user may create/drop/rename. A UNIQUE constraint's backing
     *  structure is excluded whether hidden or exposed — its lifecycle is the
     *  constraint's. Default. */
    | 'user-indexes'
    /** Additionally admits an *exposed* backing structure, which IS addressable
     *  by `ALTER INDEX … TAGS`. Hidden ones stay excluded. */
    | 'tag-addressable';

export interface IndexOwnerMatch {
    table: TableSchema;
    index: TableIndexSchema;
}

findIndexOwner(
    schemaName: string,
    indexName: string,
    options?: { scope?: IndexLookupScope; excludeTable?: string },
): IndexOwnerMatch | undefined
```

Semantics to preserve exactly:

- Case-insensitive on both the index name and `excludeTable`, like every other
  index-name comparison in the engine.
- **Skip and keep scanning** past an out-of-scope match — never stop at it. This
  is what lets one table's constraint-backed `uq_email` coexist with another
  table's real index of the same name.
- `'user-indexes'` filters with `isImplicitCoveringIndex`; `'tag-addressable'`
  filters with `isHiddenImplicitIndex`. Both predicates already exist in
  `packages/quereus/src/schema/catalog.ts` and both read only
  `uniqueConstraints`, so they work on the store backend as well as memory.
- Returns the matched `IndexSchema` alongside the table — the sync adapter needs
  it, and `resolveIndexTagSwap` already computes it.
- Unknown schema returns `undefined` rather than throwing (the sync adapter and
  `findIndexNameOwnerElsewhere` both rely on that; `dropIndex` keeps its own
  explicit schema-not-found handling ahead of the call).

`resolveIndexTagSwap`'s second loop — the store-mode fallback that routes tags
onto an *unmaterialized* exposed structure via `findExposedImplicitConstraintIndex`
— is a different lookup (it resolves to a constraint, not an index) and stays
where it is.

Export the method's types from `packages/quereus/src/index.ts` so
`packages/quereus-sync` can drop its private copy and call
`db.schemaManager.findIndexOwner(schemaName, indexName)` with the default scope.
Keep the sync adapter's comment about why first-match is unambiguous, moved onto
the new method.

## TODO

- Add `findIndexOwner` (plus `IndexLookupScope` / `IndexOwnerMatch`) to
  `SchemaManager`, with the doc comment explaining the scopes and the
  skip-and-continue rule.
- Rewrite `findIndexNameOwnerElsewhere` as a thin call with
  `{ excludeTable: ownerTableName }`, or delete it and inline the call in
  `createIndex`. Keep its existing comment about exposed structures leaving a
  residual first-match ambiguity.
- Rewrite `dropIndex`'s owner scan as a call with the default scope.
- Rewrite `resolveIndexTagSwap`'s first loop as a call with
  `scope: 'tag-addressable'`.
- Rewrite `emitDropIndex`'s strict-DDL-policy scan as a call with the default
  scope.
- Export the method's types from `packages/quereus/src/index.ts`; replace
  `packages/quereus-sync/src/sync/store-adapter.ts`'s `findIndexOwner` with a
  call to it, and delete the private function.
- Confirm no behavior change: `yarn workspace @quereus/quereus run lint`,
  `yarn build`, `yarn test`, `yarn test:store`, and the sync package's own tests
  (`yarn workspace @quereus/sync run test`). No new test file is expected — the
  prereq ticket's `10.5.7-implicit-unique-index-lifecycle.sqllogic` and the
  existing `10.5.5-index-name-uniqueness.sqllogic` are the regression net.
