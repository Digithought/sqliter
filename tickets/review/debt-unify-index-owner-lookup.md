---
description: Five places in the engine each hand-rolled their own "which table owns the index with this name?" scan, and they disagreed about whether a UNIQUE constraint's internal backing index counted; they now all call one shared lookup.
files:
  - packages/quereus/src/schema/manager.ts        # new findIndexOwner + IndexLookupScope/IndexOwnerMatch; 3 call sites rewritten
  - packages/quereus/src/runtime/emit/drop-index.ts  # strict-DDL-policy owner scan -> findIndexOwner
  - packages/quereus/src/index.ts                 # exports IndexLookupScope, IndexOwnerMatch
  - packages/quereus-sync/src/sync/store-adapter.ts  # private findIndexOwner deleted
  - docs/invariants.md                            # SCH-001 updated
  - docs/schema.md                                # implicit-index Lifecycle paragraph updated
difficulty: medium
---

## What landed

`SchemaManager` gained one public resolver and the five duplicate loops are gone.

```ts
/** How much of a schema's index namespace a by-name owner lookup should consider. */
export type IndexLookupScope =
	| 'user-indexes'      // default; excludes a UNIQUE constraint's backing index, hidden or exposed
	| 'tag-addressable';  // additionally admits an *exposed* backing index; hidden still excluded

export interface IndexOwnerMatch {
	readonly table: TableSchema;
	readonly index: IndexSchema;   // exported publicly as TableIndexSchema
}

findIndexOwner(
	schemaName: string,
	indexName: string,
	options?: { scope?: IndexLookupScope; excludeTable?: string },
): IndexOwnerMatch | undefined
```

Implementation is the same first-match scan the sites had: case-insensitive on both
`indexName` and `excludeTable`, an out-of-scope match is **skipped and the scan
continues** (never stopped at), unknown `schemaName` returns `undefined` rather
than throwing. Scope maps to `isImplicitCoveringIndex` (`'user-indexes'`) or
`isHiddenImplicitIndex` (`'tag-addressable'`) from `schema/catalog.ts` — both read
only `uniqueConstraints`, so they answer identically on the memory and store
backends.

Call sites now:

| site | call |
|---|---|
| `SchemaManager.findIndexNameOwnerElsewhere` | kept as a one-line wrapper, `{ excludeTable: ownerTableName }` — two callers (`createIndex`, `importIndex`) and it is the home of the "exposed structures leave a residual first-match ambiguity" NOTE |
| `SchemaManager.dropIndex` | default scope; also **takes `storedIndexName` from the returned `IndexSchema`** instead of re-finding it, deleting a second scan |
| `SchemaManager.resolveIndexTagSwap` (first loop) | `{ scope: 'tag-addressable' }`; the store-mode `findExposedImplicitConstraintIndex` fallback loop below it is untouched, and `getSchemaOrFail` still runs first so an unknown schema still throws |
| `emitDropIndex` strict-DDL-policy gate | default scope; `isImplicitCoveringIndex` import dropped |
| `quereus-sync` `store-adapter.ts` | private `findIndexOwner` deleted; both `decideSchemaChange` arms call `db.schemaManager.findIndexOwner(...)`. `TableIndexSchema` dropped from its imports |

## The one intended behavior change

Sync's deleted copy took **the first match of any kind**. The replacement uses the
default `'user-indexes'` scope, so a UNIQUE constraint's backing index no longer
satisfies it. That is the point of the ticket — the engine and the sync receiver
now agree on what a bare index name resolves to.

Concretely, for a replicated migration whose index name matches only a local
constraint's backing structure:

- `drop_index` — was `'execute'` (owner found ⇒ run the DDL), still `'execute'`
  (owner not found ⇒ run the DDL). Same verdict by a different route; the
  subsequent `SchemaManager.dropIndex` refuses it either way.
- `add_index` — was `'already-applied'` (with a `generateIndexDDL` comparison
  against the backing structure, which would almost certainly have thrown a
  schema conflict); is now `'execute'`, and `createIndex`'s
  `shadowsConstraintStructure` guard then refuses it with `CONSTRAINT`.

Nothing is known to emit that DDL — `computeSchemaDiff` filters implicit
structures out of its `index` declarations — so this is unreachable today. **This
is the one place a reviewer should push hardest:** it is the only semantic delta in
the diff, and it is unverified by any test because nothing can currently produce
the input.

## Validation

All run from repo root, all green, no new files:

- `yarn workspace @quereus/quereus run lint` — clean (this is eslint **plus** the
  `tsconfig.test.json` type pass, so spec-file signature drift is covered)
- `yarn build` — clean
- `yarn test` — 8047 passing / 13 pending in `packages/quereus`, plus every other
  workspace; `quereus-sync`'s own 594 passing are included in this run
- `yarn test:store` — 8038 passing / 22 pending

Regression net is pre-existing, as the ticket predicted: the prereq's
`test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` and
`test/logic/10.5.5-index-name-uniqueness.sqllogic`, plus
`test/schema-manager.spec.ts` (which already exercises the
`isHiddenImplicitIndex` true/false branches of the tag-swap path and the
cross-table uniqueness check).

## Suggested review focus

- **Scope wiring.** Verify each site got the scope it had: `resolveIndexTagSwap`
  is the *only* `'tag-addressable'` caller, everything else is default. Getting
  this backwards is silent — an exposed backing index would become droppable, or
  `ALTER INDEX … TAGS` on one would start returning NOTFOUND.
- **`dropIndex`'s `storedIndexName`.** It now comes from `ownerMatch.index.name`
  rather than a re-find over `ownerTable.indexes`. Same object, so the same
  stored display casing, but it is what the module-facing stored-name contract
  rides on (`DROP INDEX iDx` must reach the module as `idx`) — worth confirming
  the value is identical and still computed before the `module.dropIndex` call.
- **`resolveIndexTagSwap` ordering.** `getSchemaOrFail(targetSchemaName)` must
  stay *above* the `findIndexOwner` call, or an unknown schema starts returning
  NOTFOUND-for-index instead of the schema error. It does; confirm.
- **Whether the `findIndexNameOwnerElsewhere` wrapper earns its keep.** The
  ticket offered "thin call or inline it". It was kept because two callers use it
  and it documents the *uniqueness rule* (distinct from the generic lookup). A
  reviewer who disagrees can inline it into `createIndex`/`importIndex` cheaply —
  but the exposed-ambiguity NOTE needs a new home if so.

## Known gaps

- **No new test.** By design (ticket said none expected), but it means the sync
  behavior delta above rests on reading, not on a run. If a reviewer wants it
  pinned, the cheapest guard is a unit test on `findIndexOwner` itself:
  two tables, one with `constraint uq_email unique (email)` and one with a real
  `create index uq_email`, asserting the default scope skips the constraint's
  structure and finds the real index — that is the skip-and-continue rule, and it
  is currently only covered indirectly through `dropIndex`.
- **No direct coverage of `excludeTable`'s case-insensitivity.** It is exercised
  only through `createIndex`, which passes `tableSchema.name` (already stored
  casing), so the `.toLowerCase()` on it is defensive and unproven.
- `resolveIndexTagSwap` now resolves the schema twice on the tag-addressable path
  (`getSchemaOrFail`, then `findIndexOwner`'s own `getSchema`). A map lookup on a
  DDL path; deliberately not optimized.

## Tripwires parked

None new. The pre-existing O(indexes × tables) NOTE on `importIndex`'s
per-index call is unchanged and still accurate — the wrapper it calls now
delegates, but the cost shape is identical.

## Docs touched

- `docs/invariants.md` SCH-001 — the "by-name resolvers" list was four names that
  no longer exist as separate scans; it now names `findIndexOwner` as the single
  resolver and mentions the `tag-addressable` carve-out.
- `docs/schema.md` implicit-index **Lifecycle** paragraph — same substitution
  ("the predicate three write paths consult" → the shared resolver plus
  `createIndex`'s own guard).
