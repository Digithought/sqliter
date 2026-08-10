---
description: Five places in the engine each hand-rolled their own "which table owns the index with this name?" scan, and they disagreed about whether a UNIQUE constraint's internal backing index counted; they now all call one shared lookup.
files:
  - packages/quereus/src/schema/manager.ts             # findIndexOwner + IndexLookupScope/IndexOwnerMatch; 3 call sites
  - packages/quereus/src/runtime/emit/drop-index.ts    # strict-DDL-policy owner scan -> findIndexOwner
  - packages/quereus/src/index.ts                      # exports IndexLookupScope, IndexOwnerMatch
  - packages/quereus-sync/src/sync/store-adapter.ts    # private findIndexOwner deleted
  - packages/quereus/test/schema-manager.spec.ts       # review: 6 direct findIndexOwner tests added
  - docs/invariants.md                                 # SCH-001
  - docs/schema.md                                     # implicit-index Lifecycle paragraph
difficulty: medium
---

## What shipped

`SchemaManager.findIndexOwner(schemaName, indexName, options?)` is now the only
by-name index-owner resolver in the codebase.

```ts
export type IndexLookupScope =
	| 'user-indexes'      // default; excludes a UNIQUE constraint's backing index, hidden or exposed
	| 'tag-addressable';  // additionally admits an *exposed* backing index; hidden still excluded

export interface IndexOwnerMatch {
	readonly table: TableSchema;
	readonly index: IndexSchema;   // exported publicly as TableIndexSchema
}
```

First-match scan over `schema.getAllTables()`, case-insensitive on `indexName`
and `options.excludeTable`, **skip-and-continue** past an out-of-scope match
(never stop at it), `undefined` for an unknown schema rather than a throw.

Callers: `SchemaManager.dropIndex`, `SchemaManager.resolveIndexTagSwap`
(`'tag-addressable'`), `SchemaManager.findIndexNameOwnerElsewhere` (kept as a
one-line wrapper — two callers, and it is the home of the exposed-index-ambiguity
NOTE), `emitDropIndex`'s strict-DDL-policy gate, and `@quereus/sync`'s
`decideSchemaChange`.

## Review findings

### Checked and clean

- **Scope wiring, per site.** Compared each rewritten call against the loop it
  replaced. `resolveIndexTagSwap` is the only `'tag-addressable'` caller (was
  `isHiddenImplicitIndex`); `dropIndex`, `findIndexNameOwnerElsewhere` and
  `emitDropIndex` all default to `'user-indexes'` (all three were
  `isImplicitCoveringIndex`). No site inverted.
- **`dropIndex`'s `storedIndexName`.** `ownerMatch.index` is the same object the
  old re-find returned (both `table.indexes.find` on the same lowercased name),
  so the stored display casing handed to `module.dropIndex` is unchanged, and it
  is still computed before the module call. `lowerIndexName` survives in that
  method because the array/constraint rebuild below still uses it — not dead.
- **`resolveIndexTagSwap` ordering.** `getSchemaOrFail(targetSchemaName)` still
  runs above the `findIndexOwner` call, so an unknown schema throws the schema
  error rather than degrading to index-NOTFOUND. `getSchema` and
  `getSchemaOrFail` normalize identically (`name.toLowerCase()`), so the double
  resolution cannot disagree.
- **Completeness of the de-duplication.** Swept `packages/quereus`,
  `packages/quereus-sync` and `packages/quereus-store` for surviving
  `getAllTables()` + `indexes.find` owner scans. The remaining hits
  (`store-module-base.ts` store-name collection, `sync-manager-impl.ts` basis
  enumeration, the per-table `indexes.find` in planner/vtab code) resolve
  something other than "which table owns this index name" — none is a missed
  duplicate.
- **Docs.** Read `docs/invariants.md` SCH-001 and the `docs/schema.md`
  implicit-index Lifecycle paragraph against the shipped code; both now name
  `findIndexOwner` as the single resolver and describe the `tag-addressable`
  carve-out accurately. No other doc mentions the old per-site scans.
- **Lint + tests.** `yarn workspace @quereus/quereus run lint` clean (eslint plus
  the `tsconfig.test.json` type pass). `yarn test` green across every workspace:
  8053 passing / 13 pending in `packages/quereus` (8047 + the 6 added below),
  1202 in `quereus-store`, 594 in `quereus-sync`, 0 failing. No pre-existing
  failures surfaced.

### Fixed in this pass (minor)

- **The handoff's `drop_index` analysis is inverted.** It claimed the sync
  `drop_index` verdict was unchanged — "was `'execute'` (owner found ⇒ run the
  DDL), still `'execute'` (owner not found ⇒ run the DDL)". The arm reads
  `findIndexOwner(...) ? 'execute' : 'already-applied'`, so owner-not-found is
  `'already-applied'`. The real delta for a name matching only a local
  constraint's backing structure is `'execute'` → `'already-applied'`, which is
  *better*, not neutral: the old path exec'd a `drop index` that
  `SchemaManager.dropIndex` refuses with `no such index`, throwing and aborting
  the whole admission unit. The new path converges silently, which is correct —
  there is no user index by that name to drop. Code was already right; only the
  reasoning was wrong. Added a three-line comment on that arm
  (`store-adapter.ts`) so the next reader does not re-derive it wrong.
- **No direct coverage of the new public resolver.** The handoff listed this as a
  known gap. Added six tests to `packages/quereus/test/schema-manager.spec.ts`
  (`describe('findIndexOwner')`): skip-and-continue past a constraint-backing
  structure to the real index on another table; `undefined` when only a backing
  structure carries the name; exposed backing structure admitted at
  `'tag-addressable'` but not at the default scope; hidden backing structure
  excluded at both; case-insensitivity of `indexName`, `schemaName` **and**
  `excludeTable` (the last was previously unproven — `createIndex` only ever
  passes already-stored casing); unknown schema returns `undefined` instead of
  throwing.

### Verified, no change needed

- **The `add_index` semantic delta.** Confirmed unreachable:
  `schema-differ.ts:509` filters `CatalogIndex.implicit` out of the actual-index
  map, and hidden backing structures never reach the catalog at all — so no
  migration can name one. The delta the handoff described (`'already-applied'`
  with a doomed DDL comparison → `'execute'` then `createIndex`'s
  `shadowsConstraintStructure` refusal) stands as reasoned, and is the direction
  that matches the engine. It stays untested because nothing can produce the
  input; a test would have to fabricate the migration record.
- **The `findIndexNameOwnerElsewhere` wrapper.** Kept. Two callers
  (`createIndex`, `importIndex`), it names the uniqueness rule rather than the
  generic lookup, and it hosts the exposed-implicit-ambiguity NOTE that has no
  better home. Inlining would trade a one-line delegate for two duplicated
  option literals and a homeless comment.

### Not found / not applicable

- **No major findings**, so no new `fix/`, `plan/` or `backlog/` ticket was
  filed. The diff is a de-duplication with one intended, unreachable semantic
  delta; nothing in it changes a reachable code path's behavior.
- **No new tripwires.** The one conditional cost in the area —
  `importIndex`'s per-index `O(indexes × tables)` call — already carries its
  `NOTE:` at the call site and is unchanged by this diff (the wrapper delegates,
  the cost shape is identical). `resolveIndexTagSwap` now resolves the schema
  twice on the tag-addressable path; that is a `Map.get` on a DDL path, below the
  threshold where a note earns its keep.
- **`yarn test:store` not re-run.** The implement stage ran it green and the only
  change in this pass is a memory-backed spec file plus a comment;
  `test:store` re-runs `test/logic/*.sqllogic`, which neither touches.
