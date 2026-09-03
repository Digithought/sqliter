description: Fixed the sync bug where two devices that each created the same table offline reported a schema conflict forever once either device changed that table; a replicated create is now judged against the create this device recorded, not against the table's current shape.
files:
  - packages/quereus-sync/src/sync/protocol.ts               # localDDLAtVersion, toSchemaChange, sameVersionLocalDDL, toSchemaChangeWithLocalRecord, generic sortMigrationsByHLC
  - packages/quereus-sync/src/sync/change-applicator.ts      # ~309 — Phase 1a passes the record it already fetched
  - packages/quereus-sync/src/sync/snapshot.ts               # ~163-169 — Phase 1 lookup before Phase 3 files the incoming record
  - packages/quereus-sync/src/sync/snapshot-stream.ts        # PendingSchemaChange, flush records after apply, schema-migration chunk
  - packages/quereus-sync/src/sync/store-adapter.ts          # assertDefinitionMatches, create_table arm, add_index tripwire NOTE
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # 9 specs (4 from implement, 5 added in review)
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts        # workaround removed from one beforeEach
  - docs/sync-schema.md                                      # § Idempotent DDL application
difficulty: medium
----

# Replicated `create_table` is judged against the recorded migration, not the live table

## What was wrong

Two devices each ran the identical `create table orders (…) using store` offline. If
either then ran any `alter table orders …`, the first sync in the direction that admits
the other device's `create_table` threw a schema conflict printing the **altered** local
shape against the peer's **original** create. The throw lands in
`ApplyToStoreResult.errors`, which aborts the admission unit before its sync bookkeeping
commits — the peer watermark never advanced, so the same batch re-resolved and re-failed
on every subsequent sync, permanently.

Cause: `decideSchemaChange`'s `create_table` arm asked "is this create already applied
here?" by rendering the table's **current** shape with `generateTableDDL`. A table
altered since its own create no longer renders as the create that made it.

## What changed

`SchemaChangeToApply` gained `localDDLAtVersion?: string` — the DDL this device's **own**
migration *of the same type* at the *same* `(object kind, object name, schema version)`
recorded. All three ingress paths populate it, each reading the local record **before**
the incoming one is filed over it:

- `change-applicator.ts` Phase 1a — reuses the record it already fetched for the HLC
  comparison; no extra store read.
- `snapshot.ts` — Phase 1 lookup (Phase 3, inside `commitMetadata`, files the incoming
  migration later).
- `snapshot-stream.ts` — lookup at the `schema-migration` chunk; the record write is
  **deferred to the flush that applies it** (see review finding 1). The pending list holds
  `{ hlc, change, record }` triples; `sortMigrationsByHLC` is generic over `{ hlc }` so the
  flush can still order them causally.

`decideSchemaChange`'s `create_table` arm now decides:

| incoming create | local record at the same version | verdict |
|---|---|---|
| — | absent | fall back to the current-shape comparison |
| matches (normalized) | present | already applied — converge, nothing executed |
| differs (normalized) | present | divergence — throw, create against create |

`assertDefinitionMatches` takes an optional `localOrigin` label so the conflict message
says what `local:` is. Only a record of the **same migration type** counts
(`sameVersionLocalDDL`): a table created before sync was attached records its first
*alteration* at version 1, and comparing an incoming create against that `ALTER TABLE`
text would manufacture a conflict.

The ordering rule the three paths now share, stated in `docs/sync-schema.md`: **an
incoming migration is recorded only after the apply that admitted it has committed.**

A genuinely divergent create still throws and still blocks the batch — unchanged posture,
as the original ticket specified.

## Review findings

Reviewed the implement diff (`de6b5c73e`) before reading its handoff summary, then the
three ingress paths, the store adapter's decision arms, the migration metadata store, and
every doc that mentions the comparison.

### Major — found and fixed in this pass

1. **Regression: the streaming snapshot path silently converged a divergence on retry.**
   `snapshot-stream.ts` filed each incoming migration with an immediate `kv.put` at
   **chunk** time, while the apply that admits it happens later, at the flush. So a
   divergent `create_table` threw on the first attempt but left the incoming DDL recorded
   under this device's own `sm:` key; the retry's `toSchemaChangeWithLocalRecord` then
   returned that same incoming DDL, compared it against itself, matched, and converged —
   dropping the sender's table shape while reporting a successful bootstrap. Reproduced
   both ways with a throwaway probe spec (since deleted): pre-implement the retry threw
   again; post-implement it printed `(NO THROW — silently converged)`.

   Root cause was a metadata-before-apply ordering inversion at one site, not the
   comparison itself — the other two ingress paths already file their records inside the
   post-apply metadata commit. Fixed by giving the streaming path the same ordering:
   `PendingSchemaChange` now carries the record to file, and `flushDataToStore` writes the
   records only after `applyDataToStore` returns. The invariant is written into
   `docs/sync-schema.md` so all three paths are held to it, and pinned by two new specs
   (retry after a divergent create still conflicts; a successful streamed snapshot
   re-applied still converges).

   The deferral narrows one unreachable path: two migrations of one object that BOTH omit
   `schemaVersion` would now compute the same version. `SchemaMigration.schemaVersion` is
   required on the wire, and `change-applicator.ts` Phase 1a already takes exactly this
   stance; a `NOTE:` at the site says so.

### Minor — fixed in this pass

2. **The two snapshot ingress paths were populated but untested** (the implementer flagged
   this as the highest-value gap, correctly). Added three specs driving real engines:
   whole-snapshot and streamed-snapshot duplicate creates after a local `alter table`, plus
   a divergent create over the whole-snapshot path asserting the message names create
   against create and does not print the altered shape. All three fail against the
   implement commit with the `localDDLAtVersion` branch disabled (verified by temporarily
   neutering it, then restoring) and pass with it.

3. **An inaccurate claim in three places.** The code comment, the `localDDLAtVersion` doc
   comment, and `docs/sync-schema.md` all said the current-shape fallback covers "a version
   that does not line up because the table was dropped and re-created". It does not:
   migration records are never deleted, so a local drop + re-create leaves the original
   `create_table` at version 1 and the lookup finds it. Corrected in all three to "a
   version whose record is some other migration type".

### Conditional — parked as tripwires, not tickets

4. **Drop + re-create makes a stale incoming create converge silently** against a table
   that no longer has that shape (see finding 3 for why it does not fall back). Benign
   today — the peer's create is genuinely superseded, its own drop/re-create replicates
   behind it, and it is strictly better than the permanent block the current-shape
   comparison gave. `NOTE:` parked at the `create_table` arm in `store-adapter.ts`, with
   the fix if drop/re-create of a replicated table becomes common (key the lookup on the
   current version's create).

5. The implementer's `add_index` tripwire (that arm still compares the index's current
   shape; safe only because no ALTER form modifies an index in place) was re-checked at its
   site in `store-adapter.ts` and stands as written.

### Checked, nothing to report

- **Delta path ordering** — `change-applicator.ts` files its records inside `admitGroup`'s
  `commitMetadata`, after the apply. Correct as-is; that is the shape finding 1 brought the
  streaming path into line with.
- **`sortMigrationsByHLC` genericization** — widening only; every existing call site,
  including `SchemaMigrationStore.listAllMigrations`, keeps its exact return type (confirmed
  by `yarn typecheck` across the workspace).
- **`normalizeDDL` left unexported**, deviating from the implement TODO. Agreed with the
  implementer's call: the comparison has one site, and exporting it would add unused public
  surface.
- **Divergence detection is HLC-order-dependent in the delta path** — a divergent create
  that is HLC-dominated is skipped before `decideSchemaChange` ever sees it, so no conflict
  is reported. Pre-existing and untouched by this change; the divergent-create posture is
  already documented at `assertDefinitionMatches`.
- **`MigrationVersionLookup`** duplicates `SchemaMigrationStore.getMigration`'s shape rather
  than importing `StoredMigration`. The stated reason (an import cycle) is overstated — a
  type-only import is erased — but a structural interface that names only what it uses is
  the better dependency anyway. Left alone.
- **File sizes** — `store-adapter.ts` 1047, `change-applicator.ts` 1221, `protocol.ts` 849,
  `snapshot-stream.ts` 908 lines (`wc -l`). Large, but this work added ~120 lines net across
  four files and split nothing further apart; no size ticket filed on the strength of this
  diff alone.
- **Comment density** is high in the added code, matching the surrounding house style in
  these files (rationale at the site rather than in a separate doc). Consistent, not
  flagged.
- **Resource cleanup / error handling** — no new handles, listeners, or catch sites; the
  deferred record loop sits on the same path the apply already occupied, and a throwing
  apply now leaves *fewer* partial writes behind than before.

## Validation

- `yarn workspace @quereus/sync test` — **745 passing, 0 failing** (740 at the implement
  commit, +5 added in review). Run seven times: six consecutive clean runs plus one clean
  run immediately after a full `yarn typecheck`.
- `yarn test` (whole workspace) — all suites pass, 0 failing.
- `yarn typecheck` and `yarn lint` clean across every package.

One caveat, reported rather than hidden: an early sync-package run (chained directly after
`yarn typecheck`) reported `744 passing / 1 failing`, and that command discarded the failure
detail before it could be read. Seven subsequent runs — including a deliberate repeat of the
same chained-under-load shape — were clean, so the failing test could not be identified or
reproduced. Nothing was skipped, disabled, or loosened. If it resurfaces it is most likely
one of the timing-sensitive peer-harness specs (`settle()` is a fixed 25 ms wait, and
`.mocharc.cjs` sets a 10 s timeout); the fix would be to make that spec wait on a condition
rather than a duration.
