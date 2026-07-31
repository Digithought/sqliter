description: When syncing between devices, the record of "what version is this schema object at" is filed under just the object's name, so a table and an index that happen to share a name share one counter — and a schema change made on one device can then be silently dropped on another, permanently.
prereq:
files:
  - packages/quereus-sync/src/metadata/keys.ts (buildSchemaMigrationKey ~258, buildSchemaMigrationScanBounds ~330, parseSchemaMigrationKey ~434, SYNC_METADATA_FORMAT_VERSION ~62, buildTablePrefix ~273)
  - packages/quereus-sync/src/metadata/schema-migration.ts (the whole SchemaMigrationStore)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration ~855, collectSchemaMigrations ~1363, mapSchemaMigrationType ~114)
  - packages/quereus-sync/src/sync/change-applicator.ts:237-244
  - packages/quereus-sync/src/sync/snapshot.ts:97, :286-293
  - packages/quereus-sync/src/sync/snapshot-stream.ts:140, :674-681
  - packages/quereus-sync/src/sync/protocol.ts (SchemaMigrationType ~73, SchemaMigration ~85)
  - packages/quereus-sync/test/metadata/keys.spec.ts (~299, ~372, ~404)
  - packages/quereus-sync/test/sync/_peer-harness.ts (repro harness)
  - docs/sync.md (§ Storage Layout table row for `sm:`; § Metadata format version)
difficulty: medium
repro: verified
----

## The defect, reproduced

Schema changes replicate as **migrations**: a record per DDL statement carrying a
per-object version number, so a receiving device can tell which schema changes it
already has. Those records are filed under `sm:⟨schema⟩⟨object⟩{version}` — a key
with nothing in it saying *what kind of object* it is.

For a table migration the object component is the table name. For an index
migration it is the **index** name (`recordSchemaMigration`, sync-manager-impl.ts).
So a table `orders` and an index `orders` write into one migration stream and read
one version counter.

Reproduced against the real two-peer harness (`test/sync/_peer-harness.ts`), on a
scratch spec run with:

```
node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-sync/test/sync/<file>.spec.ts" --reporter spec
```

Three observations, all confirmed:

1. **The collision is reachable.** `create index orders on orders (note)` is
   accepted when table `orders` exists; `findIndexOwner('main','orders')` then
   resolves to `orders.orders`. Nothing in the engine forbids it — the
   index-name uniqueness rule that landed with `index-names-unique-per-schema`
   (`SCH-001`, docs/invariants.md) is index-vs-index only.
2. **The index migration bumps the table's counter.** On a peer with `orders`
   at version 1, creating the index named `orders` leaves
   `getCurrentVersion('main','orders')` at 2.
3. **A concurrent table migration silently eats it.** Peers `x` and `y` both
   hold `orders` at version 1. `x` runs `create index orders on orders (note)`
   (→ version 2); `y` afterwards runs `alter table orders add column qty`
   (→ also version 2, later HLC). Relaying `x → y`:

   ```
   relay x->y: {"applied":0,"skipped":2}
   y index owner after relay: undefined
   relay x->y (again): {"applied":0,"skipped":2}
   y index owner after second relay: undefined
   ```

   `y` never creates the index and never will — the skip in
   `change-applicator.ts:246-251` is "a migration already exists at this version
   with a dominating HLC", which is correct behaviour for two migrations of one
   object and wrong here, because these are two different objects. Control:
   with the index named `idx_note` instead, the same sequence gives
   `{"applied":1,"skipped":1}` and `y` gets the index. (The one remaining skip
   in the control is each peer's own `create table orders` at version 1, which
   is a genuine same-object conflict.)

The blast radius is any pair of concurrent schema changes where one is an
index migration and the other touches a table of the same name. The loser is
dropped with no error, no warning, and no retry path.

## Direction: widen the key with the object kind

Of the two directions the fix ticket weighed, take the **widen the key** one.
Reasons, stated so the next reader does not re-litigate:

- It fixes databases that already contain such a collision. Forbidding
  index-vs-table name collisions in the engine only stops new ones.
- It removes sync's dependence on an engine namespace invariant for the
  correctness of sync's own storage key. Index-vs-index correctness already
  rests on `SCH-001`; adding a second such dependency is the wrong direction.
- A format-version bump is unusually cheap right now: `bug-sync-metadata-key-delimiters-ambiguous`
  just raised the same constant 2 → 3, so any replica that has to re-bootstrap
  has almost certainly had to already.

Not in scope: making index names share a namespace with table and view names in
the engine. That is a user-visible SQL restriction with its own design surface
(rehydration warn-vs-fail, the declarative differ, `docs/sql-ddl.md`), and it is
not needed once the key carries the kind. Do not file it — after this lands,
`create index orders on orders (x)` is legal and merely confusing, not broken.

### Key layout

The object kind is a closed set derivable from the migration type, which every
call site already has in hand:

```ts
export type SchemaObjectKind = 'table' | 'index';

export function migrationObjectKind(type: SchemaMigrationType): SchemaObjectKind {
  switch (type) {
    case 'add_index':
    case 'drop_index':
      return 'index';
    // create/drop table and the three column-level types all name a TABLE.
    default:
      return 'table';
  }
}
```

Add it to the key as one more length-prefixed component, per `joinKeyParts`:

```
sm:⟨schema⟩⟨kind⟩⟨object⟩{version:010}
```

and raise `SYNC_METADATA_FORMAT_VERSION` from 3 to **4** (not to 3 — that is
taken by the length-prefix rework). `parseSchemaMigrationKey` then splits three
components instead of two and returns `kind` alongside `schema`, `table`,
`version`.

Placing the kind before the object name keeps `getCurrentVersion`'s prefix scan a
single exact prefix, and keeps versions contiguous within one object's stream.

### Wire format is unchanged

`SchemaMigration` (protocol.ts) already carries `type`, and every producer that
reads an `sm:` key back — `collectSchemaMigrations`, `snapshot.ts:97`,
`snapshot-stream.ts:140` — re-emits the migration's stored `type` next to the
parsed object name. So kind is recoverable on the receiving side without adding a
field to the wire message. **Do not** add one; deriving it keeps the two sides
from disagreeing.

Consequence for a mixed-version fleet (a peer still on format 3 talking to one on
format 4): the two ends compute *different* version numbers for the same index
migration, so it lands under two keys on the format-4 side rather than
suppressing anything. Idempotent DDL application (`decideSchemaChange`,
store-adapter.ts) already makes a re-applied migration a no-op, so the mixed case
degrades to today's behaviour, never worse. One sentence in `docs/sync.md` §
Metadata format version is enough; there is a `debt-version-skew-testing` ticket
in `blocked/` that owns the general problem.

### Call sites

`SchemaMigrationStore` gains a kind parameter on every method
(`getMigration`, `recordMigration`, `recordMigrationBatch`, `getCurrentVersion`,
`getAllMigrations`, `checkConflict`). Callers, all of which have the migration
type available at the call:

| Site | Has kind from |
|---|---|
| `sync-manager-impl.ts:890,895` (`recordSchemaMigration`) | `migrationType`, computed on line 861 |
| `sync-manager-impl.ts:887` (`counterKey`) | same — the in-transaction counter map key must include kind too |
| `change-applicator.ts:238,240` | `migration.type` |
| `snapshot.ts:287,289` | `migration.type` |
| `snapshot-stream.ts:675,677` | `migration.type` |

`getAllMigrations` and `checkConflict` have **no callers** outside the class
(verified by grep across `packages/`). Update their signatures for consistency
rather than deleting them — removing dead exports is a separate call.

## TODO

- Add `SchemaObjectKind` and `migrationObjectKind(type)` next to
  `SchemaMigrationType` in `packages/quereus-sync/src/sync/protocol.ts`, exported
  from the package entry point alongside the existing migration types.
- Widen `buildSchemaMigrationKey`, `buildSchemaMigrationScanBounds` and
  `parseSchemaMigrationKey` in `metadata/keys.ts` with the kind component; update
  the `sm:` line in that file's prefix comment block and the format-version
  doc-comment on `SYNC_METADATA_FORMAT_VERSION`. `buildTablePrefix` is shared with
  `cv:`/`tb:`/`qt:`/`bl:` — add a separate migration-prefix helper rather than
  widening it.
- Raise `SYNC_METADATA_FORMAT_VERSION` to 4 and update the mismatch message in
  `sync-manager-impl.ts:251-270` (its text still says "pk-identity keys").
- Thread the kind through every `SchemaMigrationStore` method and the five call
  sites in the table above, including the `versionCounters` counter key.
- Replace the `NOTE:` at `sync-manager-impl.ts:880-886` — its last two sentences
  ("An index name colliding with a *table* name still shares a counter … tracked
  separately as …") describe the defect this ticket removes. Keep the
  index-vs-index sentence pointing at `SCH-001`.
- Regression spec — `packages/quereus-sync/test/sync/schema-migration-object-kind.spec.ts`,
  built on `_peer-harness.ts`. Cover:
  - an index whose name equals an existing table's name does **not** advance the
    table's migration version (`getCurrentVersion` per kind);
  - the two-peer sequence from § The defect, reproduced, asserting `y` ends up
    with the index (`findIndexOwner('main','orders')` defined) and that
    `applied` counts the index migration;
  - the reverse pairing (`y` creates the colliding index second, later HLC) so
    the assertion does not depend on which side wins the HLC compare.
- Update `test/metadata/keys.spec.ts`: the round-trip at ~299 and the scan-bound
  isolation at ~404 need the kind argument, and add a case proving a `table`-kind
  and an `index`-kind key for the same `(schema, name)` are distinct and that
  neither falls inside the other's scan bounds. Keep the negative case at ~372
  (a format-2 key must not parse) and add the format-3 shape to it for the same
  reason.
- `test/sync/metadata-format-version.spec.ts` asserts against the constant, so it
  follows automatically — confirm it still passes rather than editing it.
- Docs: update the `sm:` row of the Storage Layout table and the *Metadata format
  version* paragraph in `docs/sync.md`. **`docs/sync.md` is 451 words over its
  ratchet at HEAD** (`yarn docs:check` fails there and on `docs/schema.md`, both
  pre-existing and untouched by this work) — so keep the edit word-neutral or
  shrinking; do not add a new subsection.
- Validate: `yarn build`, then
  `yarn workspace @quereus/sync run test`, then `yarn test` and `yarn typecheck`
  from the root. Stream with `tee`, per AGENTS.md.
