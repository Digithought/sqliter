description: Fixed the sync bug where two devices that each created the same table offline reported a schema conflict forever once either device changed that table; a replicated create is now judged against the create this device recorded, not against the table's current shape.
files:
  - packages/quereus-sync/src/sync/protocol.ts               # localDDLAtVersion, toSchemaChange, sameVersionLocalDDL, toSchemaChangeWithLocalRecord, generic sortMigrationsByHLC
  - packages/quereus-sync/src/sync/change-applicator.ts      # ~309 — Phase 1a passes the record it already fetched
  - packages/quereus-sync/src/sync/snapshot.ts               # ~163-169 — Phase 1 lookup before Phase 3 overwrites the record
  - packages/quereus-sync/src/sync/snapshot-stream.ts        # ~396-412 flush, ~700-712 schema-migration chunk
  - packages/quereus-sync/src/sync/store-adapter.ts          # ~410 assertDefinitionMatches, ~459 create_table arm, ~505 add_index tripwire NOTE
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # 4 new end-to-end specs
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts        # workaround removed from one beforeEach
  - docs/sync-schema.md                                      # § Idempotent DDL application
difficulty: medium
----

# Replicated `create_table` is judged against the recorded migration, not the live table

## What was wrong

Two devices each ran the identical `create table orders (…) using store` offline. If
either then ran any `alter table orders …`, the first sync in the direction that admits
the other device's `create_table` threw:

```
Schema conflict applying remote create_table for main.orders: a different definition already exists locally.
  local:  CREATE TABLE "main"."orders" (… "sku" TEXT NULL) USING store   <- the ALTERED shape
  remote: CREATE TABLE "main"."orders" (…) USING store                   <- the peer's create
```

The throw lands in `ApplyToStoreResult.errors`, which aborts the admission unit before
its sync bookkeeping commits — the peer watermark never advanced, so the same batch
re-resolved and re-failed on **every** subsequent sync, permanently.

Cause: `decideSchemaChange`'s `create_table` arm asked "is this create already applied
here?" by rendering the table's **current** shape with `generateTableDDL`. A table
altered since its own create no longer renders as the create that made it.

## What changed

`SchemaChangeToApply` gained `localDDLAtVersion?: string` — the DDL this device's **own**
migration *of the same type* at the *same* `(object kind, object name, schema version)`
recorded. All three ingress paths populate it, each reading the local record **before**
overwriting it with the incoming one:

- `change-applicator.ts` Phase 1a — reuses the record it already fetched for the HLC
  comparison; no extra store read.
- `snapshot.ts` — Phase 1 lookup (Phase 3 records the incoming migration later).
- `snapshot-stream.ts` — lookup at the `schema-migration` **chunk**, because that handler
  records the incoming migration immediately while the flush that builds the changes
  happens later. The pending list now holds `{ hlc, change }` pairs so the flush can still
  order them causally; `sortMigrationsByHLC` is generic over `{ hlc }` to sort them.

`decideSchemaChange`'s `create_table` arm now decides:

| incoming create | local record at the same version | verdict |
|---|---|---|
| — | absent | fall back to today's current-shape comparison |
| matches (normalized) | present | already applied — converge, nothing executed |
| differs (normalized) | present | divergence — throw, create against create |

`assertDefinitionMatches` takes an optional `localOrigin` label so the conflict message
says what `local:` is (`(local is this device's own create_table recorded at the same
schema version, not the table's current shape)`).

Only a record of the **same migration type** counts (`sameVersionLocalDDL`): a table
created before sync was attached records its first *alteration* at version 1, and
comparing an incoming create against that `ALTER TABLE` text would manufacture a conflict.

## Validation

`yarn workspace @quereus/sync test` — **740 passing, 0 failing** (736 before, +4 new).
`yarn test` (whole workspace) — all suites pass, no failures. `yarn typecheck` and
`yarn lint` clean.

The four new end-to-end specs in `schema-replication-idempotency.spec.ts` all failed
before the change and pass after:

- *duplicate create judged after the local table moved on*: two peers create the identical
  `orders`, `a` then adds `sku`; relaying `b → a`
  - admits b's create and leaves a's `[id, note, sku]` intact while b keeps `[id, note]`;
  - **succeeds again on a second relay** with `applied === 0` (the permanence half — this
    is what the aborted metadata commit used to make impossible);
  - still lets a's alteration replicate onward to b afterwards.
- *divergent create judged after the local table moved on*: two peers create **differently
  shaped** `orders`, `a` adds `sku`; the relay still throws, the message names both
  original creates (`"extra"` present) and does **not** print the altered shape (asserted
  by the absence of `sku` in the message).

The workaround in `schema-alter-replication.spec.ts`'s `convergence and divergence`
`beforeEach` (two reconciling relays that existed purely to dodge this bug) is gone and
that describe still passes. The `rename to` `beforeEach` keeps its relays — it needs them
for the rename-specific reason the ticket called out (a create arriving after the rename
would find the name free and re-create the table); its comment was narrowed to say so.

## Worth a reviewer's attention (known gaps)

- **The two snapshot paths are populated but not exercised by a new test.** Only the delta
  path (`change-applicator`) has an end-to-end spec for the duplicate-create-after-alter
  case. The snapshot paths are covered by typecheck plus the existing snapshot specs
  (which pass), not by a spec that actually alters a table and then bootstraps a snapshot
  carrying a duplicate create. Highest-value place to push on this work.
- **`normalizeDDL` was NOT exported**, deviating from the ticket's TODO. The comparison
  stayed entirely inside `store-adapter.ts`, so no second site needs the rule; exporting
  it would have added unused public surface. If a reviewer wants ingress-side
  normalization, that is the moment to export it.
- **The fallback keeps the old failure mode**, deliberately: with no same-version record
  (a table created before sync was attached, or a version that does not line up because
  the table was dropped and re-created) an altered local table still reads as a divergence
  against an incoming create. Documented at the code site and in `docs/sync-schema.md`.
- **A genuinely divergent create still throws and still blocks the batch** — unchanged
  posture, as the ticket specified.
- **Tripwire parked at `store-adapter.ts` `add_index` arm** (`NOTE:`): that arm still
  compares an index's current shape, safe only because no ALTER form modifies an index in
  place. If in-place index alteration ever lands, the arm inherits the same class of bug;
  `localDDLAtVersion` is already populated for index migrations, so the fix would be a
  one-line change there.
- `sortMigrationsByHLC` is now generic over `{ readonly hlc: HLC }`. Widening only —
  every existing call site keeps its exact return type.
