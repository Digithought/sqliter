description: Fixed a sync bug where a table and an index that happened to share a name were tracked under one shared "schema version" counter, so a schema change made on one device could be silently and permanently dropped on another.
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts (new `SchemaObjectKind` + `migrationObjectKind`, ~82)
  - packages/quereus-sync/src/metadata/keys.ts (`buildSchemaMigrationPrefix` ~266, `buildSchemaMigrationKey` ~287, `buildSchemaMigrationScanBounds` ~361, `parseSchemaMigrationKey` ~469, `SYNC_METADATA_FORMAT_VERSION` ~66)
  - packages/quereus-sync/src/metadata/schema-migration.ts (all six `SchemaMigrationStore` methods)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (`recordSchemaMigration` ~890, format-gate message ~256)
  - packages/quereus-sync/src/sync/change-applicator.ts:238-247, :377-386
  - packages/quereus-sync/src/sync/snapshot.ts:286-294
  - packages/quereus-sync/src/sync/snapshot-stream.ts:674-682
  - packages/quereus-sync/src/index.ts (exports)
  - packages/quereus-sync/test/sync/schema-migration-object-kind.spec.ts (NEW — regression spec)
  - packages/quereus-sync/test/metadata/keys.spec.ts (round-trip, malformed-key, scan-bound cases)
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts, test/sync/unknown-table-disposition.spec.ts (call-site updates)
  - docs/sync.md (§ Storage Layout, § Metadata format version)
difficulty: medium
----

## What shipped

Schema changes replicate as **migrations**: one record per DDL statement carrying a
per-object version number. Those records were filed under `sm:⟨schema⟩⟨object⟩{version}`,
a key with nothing in it saying what *kind* of object the name refers to — and for an
index migration the name is the INDEX name, not the table's. So a table `orders` and an
index `orders` shared one counter, and a concurrent migration of each landed on the same
key; the HLC-dominance skip in `change-applicator.ts` then dropped one of them
permanently, with no error and no retry path.

The key now carries the kind:

```
sm:⟨schema⟩⟨kind⟩⟨object⟩{version:010}      kind ∈ { 'table', 'index' }
```

`SYNC_METADATA_FORMAT_VERSION` 3 → **4**.

**The kind is derived, not transmitted.** `migrationObjectKind(type)` (protocol.ts) maps
`add_index`/`drop_index` → `'index'` and everything else → `'table'`. Every producer that
reads an `sm:` key back already re-emits the migration's stored `type`, so both ends of a
sync compute the same kind and cannot disagree. `SchemaMigration` (the wire message) is
byte-identical to before — deliberately, per the fix ticket.

`SchemaMigrationStore` methods all take `(schemaName, kind, objectName, …)` now. The
in-transaction counter map in `recordSchemaMigration` keys on
`joinKeyParts(schema, kind, object)` rather than a `.`-joined string, so a schema or object
name containing the delimiter cannot fold two objects onto one counter.

## Use cases to exercise in review

**The collision itself.** `create index orders on orders (note)` is legal SQL when a table
`orders` exists — the engine's index-name uniqueness rule (SCH-001, docs/invariants.md) is
index-vs-index only, and this fix deliberately does NOT change that. Worth confirming the
new key makes that legal-but-confusing case merely confusing:

```
node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-sync/test/sync/schema-migration-object-kind.spec.ts" --reporter spec
```

**The two-peer sequence.** Peer `x` creates the colliding index; peer `y` runs
`alter table orders add column qty` concurrently. Relaying `x → y` must leave `y` with the
index (`db.schemaManager.findIndexOwner('main','orders')` defined) and `y`'s own alter
untouched at table-version 2. Both orderings (index first, index second) are covered.

**Key isolation.** `test/metadata/keys.spec.ts` proves a `table`-kind and an `index`-kind
key for the same `(schema, name)` are distinct bytes and that neither falls inside the
other's scan bounds; the malformed-key case proves a format-3 `sm:` key (`sm:4:main1:t…`)
does not read back under format 4, and that an unrecognized kind component is rejected.

**Format-version gate.** `test/sync/metadata-format-version.spec.ts` asserts against the
constant, so it follows the bump automatically — confirmed passing, not edited. The gate's
error message no longer says "pk-identity keys" (that named only the version-2 change).

## Validation run

| Command | Result |
|---|---|
| `yarn build` | pass |
| `yarn workspace @quereus/sync run test` | 631 passing |
| `yarn test` (root, all workspaces) | pass |
| `yarn typecheck` | pass |
| `yarn lint` | pass |

The new spec was verified to be a real guard, not a tautology: temporarily making
`migrationObjectKind` return `'table'` for index types fails all four of its cases
(`expected undefined to equal 'orders'`, `expected +0 to equal 1`); the change was reverted
and `protocol.ts` byte-compared against its backup afterward.

## Known gaps / things a reviewer should push on

- **No cross-version fleet test.** A format-3 peer talking to a format-4 one is reasoned
  about (each end numbers an index migration differently, so it lands under two keys rather
  than suppressing anything, and `decideSchemaChange` no-ops the duplicate) and documented
  in one sentence in `docs/sync.md`, but nothing exercises it. `debt-version-skew-testing`
  in `blocked/` owns the general problem; this is not new exposure, but it is untested
  reasoning.

- **`drop_index` is covered only by derivation, not by a spec.** The regression spec
  exercises `add_index` against a same-named table. `drop_index` takes the same branch of
  `migrationObjectKind`, so it is covered by construction rather than by assertion.

- **The regression spec's peer setup is deliberately asymmetric.** `y` is built WITHOUT
  `createOrders` and bootstraps its schema by relaying `x`'s create. My first draft had both
  peers create `orders` independently; that produces two version-1 table migrations whose
  HLCs tie on wall time and break on the random site id, so whether the receiver's own table
  definition got challenged varied run to run (one of four cases failed intermittently with a
  `Schema conflict applying remote create_table` error unrelated to this bug). The rewrite is
  stable across 5 consecutive runs, but a reviewer should sanity-check that the bootstrap
  didn't narrow what the test proves.

- **`getAllMigrations` and `checkConflict` still have no callers.** Their signatures were
  widened for consistency rather than deleted, per the fix ticket. If the reviewer would
  rather see dead exports go, that is a separate call.

- **Doc edit was constrained by the word ratchet.** `docs/sync.md` is over its
  `yarn docs:check` ratchet at HEAD (as is `docs/schema.md`) — both pre-existing and
  untouched by this work. To stay word-neutral (verified: exactly 0 delta vs HEAD), the
  additions were offset by compressing adjacent prose in § Storage Layout: one duplicated
  length-prefix example, the `tx:` and `pt:` row wording, and the version-2 restatement in
  § Metadata format version (the length-prefix rationale it repeated is already stated in
  full one paragraph above). Reviewer should confirm no meaning was lost in those trims —
  they are the least-verified part of this diff.

- **`test:store` was not run.** Only `yarn test` (memory-backed). Nothing here touches the
  store path, but the LevelDB-backed logic run is unexercised.
