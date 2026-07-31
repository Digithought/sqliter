----
description: Fixed a sync bug where a table and an index that happened to share a name were tracked under one shared "schema version" counter, so a schema change made on one device could be silently and permanently dropped on another; review then found and fixed a second bug the fix had introduced, where a device receiving a fresh copy of a database could no longer rebuild its indexes.
files:
  - packages/quereus-sync/src/sync/protocol.ts (`SchemaObjectKind`, `migrationObjectKind`, `sortMigrationsByHLC`, `toSchemaChange`)
  - packages/quereus-sync/src/metadata/keys.ts (`sm:` key build/parse/bounds, `SYNC_METADATA_FORMAT_VERSION` 3 → 4)
  - packages/quereus-sync/src/metadata/schema-migration.ts (`SchemaMigrationStore` — kind-keyed methods, new `listAllMigrations`)
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/snapshot.ts, src/sync/snapshot-stream.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/test/sync/schema-migration-object-kind.spec.ts
  - packages/quereus-sync/test/sync/snapshot-ddl-causal-order.spec.ts (NEW — review regression spec)
  - packages/quereus-sync/test/metadata/keys.spec.ts
  - docs/sync.md (§ Storage Layout, § Metadata format version, § DDL Application Order, § Streaming Snapshot API)
difficulty: medium
----

# Schema migration keys carry the object kind, and snapshot DDL replays causally

## What was wrong

Schema changes replicate as **migrations** — one record per DDL statement, carrying a
version number for the object it changes. Those records were filed under
`sm:⟨schema⟩⟨object⟩{version}`: a key that says which object was changed but not what
*kind* of object it is. For an index migration the name in that key is the INDEX name,
not the table's, so a table `orders` and an index also named `orders` shared one version
counter.

`create index orders on orders (note)` is legal SQL — the engine's index-name uniqueness
rule (SCH-001, `docs/invariants.md`) is index-vs-index only. When two devices then made a
change each, both landed on the same `(object, version)` key, and the
higher-timestamp-wins skip in `change-applicator.ts` dropped one of them permanently:
no error, no retry, the two devices simply disagreed about the schema forever.

## What shipped

The key now carries the kind:

```
sm:⟨schema⟩⟨kind⟩⟨object⟩{version:010}      kind ∈ { 'table', 'index' }
```

`SYNC_METADATA_FORMAT_VERSION` went 3 → **4**. A replica whose stored format differs
refuses to open and must re-bootstrap from a peer snapshot; that gate already existed.

**The kind is derived, never transmitted.** `migrationObjectKind(type)` maps
`add_index`/`drop_index` → `'index'` and everything else → `'table'`. Every producer
re-emits the migration's stored `type`, so both ends of a sync compute the same kind and
cannot disagree, and the wire message `SchemaMigration` is byte-identical to before.

`SchemaMigrationStore`'s methods all take `(schemaName, kind, objectName, …)`. The
in-transaction counter map in `recordSchemaMigration` keys on the same length-prefixed
join the stored key uses, so a schema or object name containing the delimiter cannot fold
two objects onto one counter.

## What review added

Making the key kind-aware also changed the order the `sm:` range scans back: within a
schema, every `index`-kind key now sorts ahead of every `table`-kind one. Both snapshot
paths replayed DDL in that scan order, so a fresh receiver got `create index` before the
`create table` it depends on and the bootstrap died with
`apply-to-store failed … no such table: orders`. See findings below.

DDL now replays in **causal (timestamp) order** on both snapshot paths and the delta
path, on the producing *and* the consuming side. The three duplicated `sm:`-scan loops
collapsed into one `SchemaMigrationStore.listAllMigrations()`, which returns the whole
migration set already ordered.

## Review findings

**Read first:** the implement-stage diff (`88acdce7`) in full, before its handoff summary;
then every `sm:`-key consumer in `packages/quereus-sync/src`, the two sibling packages
(`quereus-sync-client`, `sync-coordinator` — neither touches these keys), `docs/sync.md`,
and `docs/invariants.md` § SCH-001.

### Major — fixed in this pass

- **Snapshot bootstrap of any replica holding an index was broken.** `sm:` scan order is
  (schema, kind, object), and `'index'` sorts before `'table'`, so *every* index migration
  preceded *every* table migration. Both `applySnapshot` and `applySnapshotStream` replay
  the DDL list in order, and the store adapter surfaces a failed statement as an apply
  error, so a fresh receiver aborted with `no such table: orders`. Reproduced against a
  sender holding `orders` + one index on it: both paths failed before the fix, both pass
  after. Fixed by ordering migrations by HLC — `sortMigrationsByHLC` in `protocol.ts`,
  applied in `listAllMigrations` (producers) and again in `applySnapshot` /
  `applySnapshotStream`'s flush (consumers, so a sender on another implementation cannot
  reintroduce it). `change-applicator.ts`'s existing private sort now delegates to the
  same helper, and the repeated `{type, schema, table, ddl}` narrowing became
  `toSchemaChange`.
  *Was it new?* Partly. Under format 3 the same failure occurred whenever the index name's
  length-prefixed key happened to sort before its table's (index `a` on table `orders`
  does; index `note_idx` does not), so it was a latent name-dependent bug. Format 4 made
  it unconditional, which is how review caught it.
  Covered by `test/sync/snapshot-ddl-causal-order.spec.ts` — 5 cases: producer order, both
  consumers bootstrapping fresh, and both consumers re-sorting a sender that shipped raw
  key order. All 5 fail without the fix.

### Minor — fixed in this pass

- `docs/sync.md` § DDL Application Order claimed DDL replays "destructive operations first
  (DROP TABLE, then DROP COLUMN, then ALTER/ADD)". No such ordering exists in the code —
  the applicator sorts by HLC and nothing else. That sentence was describing the
  *conflict-precedence* hierarchy from the section above it as if it were replay order.
  Replaced with the actual rule, plus why key order cannot be used.
- `drop_index` had no assertion, only derivation-by-construction (implementer flagged this
  honestly). Added a case to `schema-migration-object-kind.spec.ts`: create + drop the
  colliding index, index stream reaches version 2, table stream stays at 1, table survives.
- Three copies of the same "scan `sm:`, parse the key, rebuild the wire record" loop
  (`snapshot.ts`, `snapshot-stream.ts`, `sync-manager-impl.collectSchemaMigrations`)
  collapsed into `listAllMigrations`. The streaming producer also had a separate
  count-only pre-scan of the same range; that second pass is gone.

### Checked and clean

- **Key isolation** — the implementer's `keys.spec.ts` cases (round-trip over the nasty-name
  matrix, table/index keys distinct, disjoint scan bounds, format-3 key and unknown kind
  both rejected) do prove what they claim; re-read, not just re-run.
- **Format gate** — `metadata-format-version.spec.ts` asserts against the constant, so it
  tracked the bump without editing. The gate's error message no longer names a specific
  version's change, which is right — it fires for any mismatch.
- **Wire compatibility** — `SchemaMigration` is unchanged on the wire; `wire.ts`'s
  serializer needed nothing. No consumer of these keys exists outside `quereus-sync`.
- **Delimiter safety** — the in-transaction counter key uses `joinKeyParts`, so a `.` or `:`
  in a schema/object name cannot merge two counters. This was the version-3 bug class and
  the fix does not reintroduce it.
- **`docs/invariants.md`** — SCH-001 is index-vs-index only and stays that way; this change
  deliberately does not tighten it. The `SYNC` section is `Reserved`, so nothing to update.
- **Implementer's doc trims** — re-read against HEAD. One detail did go: *why* the version-2
  `{schema}.{table}:` packing was wrong (the `.` delimiter) is no longer in `docs/sync.md`.
  It survives in full in `keys.ts`'s `SYNC_METADATA_FORMAT_VERSION` comment, which is where
  someone hitting it would be, so this was left as trimmed rather than restored against the
  word budget.

### Tripwire (recorded, not ticketed)

- The streaming snapshot producer now buffers the whole migration set before emitting the
  header (it needs the count anyway, and must sort). One record per DDL statement ever run,
  so it is small next to the row data the same generator streams — but it is no longer
  lazy. `NOTE:` at the site in `snapshot-stream.ts` says what to do if a replica's DDL
  history ever grows enough to matter (keep an HLC-ordered index over `sm:`).

### Filed as a new ticket

- `backlog/debt-doc-size-ratchet-red-at-head` — `yarn docs:check` fails on `main`:
  `docs/sync.md` is 450 words over its recorded maximum and `docs/schema.md` 343. Neither
  belongs to this work (both were over before it started), and because `docs:check` is the
  first step of `yarn check`, the whole gate stops there for every ticket. Agents editing
  `docs/sync.md` have been compressing unrelated prose to stay word-neutral, which is a bad
  way to decide what survives.

### Left alone, deliberately

- `getAllMigrations` and `checkConflict` on `SchemaMigrationStore` still have no callers.
  Their signatures widened with the rest for consistency. Deleting a public store method is
  a separate call from this bug, and `listAllMigrations` now gives that class at least one
  live whole-store reader.
- No cross-version (format 3 ↔ 4) fleet test. Reasoned about and documented in one sentence
  in `docs/sync.md`; `blocked/debt-version-skew-testing` owns the general problem. Not new
  exposure, but still untested reasoning.
- `yarn test:store` (LevelDB-backed) was not run — nothing here touches the store path, only
  sync metadata keying and replay order.

## Validation

| Command | Result |
|---|---|
| `yarn build` | pass |
| `yarn workspace @quereus/sync run test` | 637 passing (was 631; +6 from the two new/extended specs) |
| `yarn test` (root, all workspaces) | pass |
| `yarn typecheck` | pass |
| `yarn lint` | pass |
| `node scripts/check-docs.mjs` | fails on `docs/sync.md` + `docs/schema.md` — pre-existing, see the filed ticket. This pass left `docs/sync.md` one word *shorter* than it found it (14248 → 14247). |
