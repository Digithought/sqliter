description: The sync engine ships a column-level schema-versioning store that nothing actually uses, and its storage keys have the same name-parsing flaw that was just fixed everywhere else — so it would misbehave the moment someone wired it up.
prereq:
files:
  - packages/quereus-sync/src/metadata/schema-version.ts (the whole module)
  - packages/quereus-sync/src/metadata/index.ts (re-export)
  - packages/quereus-sync/src/index.ts:277-283 (public export surface)
  - packages/quereus-sync/test/metadata/schema-version.spec.ts (its only caller)
  - packages/quereus-sync/README.md:74 (lists it as part of the architecture)
  - docs/sync.md § Storage layout (does not mention the `sv:` prefix at all)
difficulty: easy
----

## What is there

`SchemaVersionStore` records, per column, when that column's definition was last
changed, and resolves competing schema changes by "most destructive wins". It
stores one record per column under a key spelled `sv:{schema}.{table}:{column}`.

Two problems, both at the same module.

**Nothing uses it.** The only code that constructs a `SchemaVersionStore`, writes
an `sv:` record, or reads one back is its own unit test. The sync manager settles
schema changes through the *migration* records (`sm:` keys, `SchemaMigrationStore`)
instead. The module is nevertheless exported from the package's public entry
point, and the package README's architecture diagram lists it as a live component,
so a reader — or an outside consumer — reasonably assumes it is wired in. The
`sv:` prefix also appears in neither the key-prefix list in `metadata/keys.ts` nor
the storage-layout table in `docs/sync.md`.

**Its keys can be parsed wrong.** The key packs the schema name, table name and
column name between a bare `.` and a bare `:`, and the parser recovers them by
looking for the first `.` and the first `:`. All three of those are ordinary text —
`create table "a:b" (...)` and a column named `a:b` are both legal SQL — so a name
containing a colon makes the parser hand back a different table or a truncated
column name. This is exactly the flaw that was removed from every other sync
metadata key (`cv:`, `tb:`, `sm:`, `cl:`, `qt:`, `bl:`), which now write each
variable-length component as `{length}:{text}`. This module was missed because it
has no runtime caller, so no test exercised it.

## What should happen

Decide the module's fate first, because that decides the rest:

- If column-level schema versioning is not part of the design any more, delete the
  module, its test, its exports and its README mention. That is the smaller and
  more honest change.
- If it is meant to be used, keep it — but bring its keys onto the same
  length-prefixed encoding as the rest (`joinKeyParts` in
  `metadata/keys.ts`), list `sv:` alongside the other prefixes in `keys.ts` and in
  `docs/sync.md`'s storage-layout table, and cover it with the same
  separator-bearing-name round-trip tests the other key families have.

Either way this is bookkeeping-only: no `sv:` record exists on any replica today,
so there is nothing to migrate and no stored-format version bump is needed.
