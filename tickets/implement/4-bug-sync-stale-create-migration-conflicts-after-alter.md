description: When two devices each create the same table while offline and one of them later changes that table, their first sync reports a schema conflict and then reports the same conflict forever — the devices never converge without someone intervening.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts        # decideSchemaChange (~440), create_table arm (~442), assertDefinitionMatches (~404), normalizeDDL (~385)
  - packages/quereus-sync/src/sync/protocol.ts             # SchemaChangeToApply (~483), toSchemaChange (~495)
  - packages/quereus-sync/src/sync/change-applicator.ts    # Phase 1a, ~line 280-306 — already fetches the local migration record at the same version
  - packages/quereus-sync/src/sync/snapshot.ts             # ~157-164 — the non-streaming snapshot's schemaChangesToApply build
  - packages/quereus-sync/src/sync/snapshot-stream.ts      # ~407 — the streaming snapshot's schemaChangesToApply build
  - packages/quereus-sync/src/metadata/schema-migrations.ts # getMigration / getCurrentVersion — the local migration history store
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # home for the new coverage
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts        # two beforeEach blocks (~188, ~296) work around this; drop the workaround once fixed
  - packages/quereus-sync/test/sync/_peer-harness.ts       # makePeer / relayAll — the two-peer harness the repro uses
  - docs/sync-schema.md                                    # ~200-225 — the section describing duplicate-create convergence
repro: verified
difficulty: medium
----

# A replicated `create table` is judged against a table that has moved on

## What happens

Two devices each run the identical `create table orders (…) using store` while offline.
One of them then runs any `alter table orders …` — say `add column sku text`. On the
**first** sync between them, the direction that admits the other device's `create_table`
migration fails:

```
Schema conflict applying remote create_table for main.orders: a different definition already exists locally.
  local:  CREATE TABLE "main"."orders" ("id" INTEGER NOT NULL PRIMARY KEY, "note" TEXT NOT NULL, "sku" TEXT NULL) USING store
  remote: CREATE TABLE "main"."orders" ("id" INTEGER NOT NULL PRIMARY KEY, "note" TEXT NOT NULL) USING store
```

The conflict lands in `ApplyToStoreResult.errors`, which aborts the whole admission unit
before its sync bookkeeping commits — so the peer watermark never advances, the same batch
is re-resolved on the next sync, and it **fails again, every time, permanently**. That is
the exact stuck state the duplicate-create idempotency work (landed as
`bug-sync-create-table-replication-not-idempotent`, commit `08a3217a`) exists to prevent;
this is the same class leaking through a second door.

## Why it happens

`decideSchemaChange`'s `create_table` arm (`store-adapter.ts` ~442) answers "has this
create already been applied here?" by rendering the **table's current shape** with
`generateTableDDL` and comparing it to the incoming statement. That is the wrong
comparison: a table that has been altered since its own create no longer renders as the
create that made it. The two creates were byte-identical when they ran; the only
"divergence" is the receiver's own later alteration, which is a separate migration that
replicates on its own.

Verified end to end over two real engines with the `test/sync/_peer-harness.ts` pair:
peer `a` creates `orders`, peer `b` creates the identical `orders` a moment later (so `b`'s
migration carries the greater timestamp), `a` then runs `alter table orders add column sku
text null`; relaying `b` to `a` throws the conflict above and throws it again on every
subsequent relay.

## The comparison that is actually available

Each device records its **own** schema migrations in the same store the incoming ones are
checked against (`ctx.schemaMigrations`), keyed by `(schema, object kind, object name,
schema version)`. Both devices' `create_table` is version 1 for a freshly created table,
and both record the same canonical rendering — measured directly, the two recorded strings
are byte-identical:

```
a: type=create_table v=1 ddl="CREATE TABLE \"main\".\"orders\" (\"id\" INTEGER NOT NULL PRIMARY KEY, \"note\" TEXT NOT NULL) USING store"
b: type=create_table v=1 ddl="CREATE TABLE \"main\".\"orders\" (\"id\" INTEGER NOT NULL PRIMARY KEY, \"note\" TEXT NOT NULL) USING store"
```

So the receiver already holds exactly the fact the decision needs: *what this device's own
migration at that same version said*. Compare against **that**, not against the current
shape, and the question becomes decidable and stays decidable however much the table is
altered afterwards.

The invariant this establishes: **a replicated migration is judged against the state it
was meant to produce, never against whatever the local object happens to look like now.**
That is a representation fix, not a patch — the decision currently cannot be made
correctly because the deciding function is not given the information it needs.

## Shape of the change

`SchemaChangeToApply` (`protocol.ts` ~483) is the record the store adapter decides on. Give
it one more optional field carrying what this device's own migration at the *same* schema
version recorded:

```ts
export interface SchemaChangeToApply {
  readonly type: SchemaMigrationType;
  readonly schema: string;
  readonly table: string;
  readonly fromTable?: string;
  readonly ddl: string;
  /**
   * The DDL this device's OWN migration at the same (object kind, name, schema
   * version) recorded, when it has one. The decision compares against this —
   * the shape the incoming migration was meant to produce — rather than against
   * the object's current shape, which later local migrations have moved on.
   * Absent when this device has no migration record at that version.
   */
  readonly localDDLAtVersion?: string;
}
```

All three ingress paths build `SchemaChangeToApply[]` and all three already hold
`ctx.schemaMigrations`, so all three can populate it:

- `change-applicator.ts` Phase 1a (~280-306) — the **easiest**: it already fetches
  `existingMigration` at exactly that key for the timestamp comparison. Pass its `ddl`
  straight through.
- `snapshot.ts` (~157-164) and `snapshot-stream.ts` (~407) — one extra lookup per migration.

Then `decideSchemaChange`'s `create_table` arm decides:

| incoming create | local record at same version | verdict |
|---|---|---|
| — | absent | fall back to today's current-shape comparison (unchanged) |
| matches (normalized) | present | already applied — converge, do not re-execute |
| differs (normalized) | present | genuine divergence — throw, naming **both original creates** |

The third row is a real improvement to the error as well as preserving the signal: today
the message shows the receiver's *altered* shape against the sender's create, which reads
as a divergence even when there is none. With the record in hand it shows create against
create, so an operator sees the actual disagreement.

Reuse `normalizeDDL` (`store-adapter.ts` ~385) for the comparison — it currently has module
scope; export it or lift it beside the other shared helpers.

## Deliberately unchanged

- **A genuinely divergent create still throws.** Two devices with the same table name and
  different column layouts have no automatic convergence path; that posture is documented
  in `docs/sync-schema.md` and is not what this ticket relaxes.
- **The current-shape fallback stays** for the no-record case (a table created before sync
  was attached, or a version number that does not line up because one device dropped and
  re-created the table). Those keep today's behaviour, including today's failure mode.
- **Version mismatch is not treated as convergence.** Only a record at the *same* version
  answers the question; anything else falls back.

## TODO

- Add `localDDLAtVersion?: string` to `SchemaChangeToApply` in `protocol.ts`, documented as
  above, and thread it through `toSchemaChange`.
- Populate it in `change-applicator.ts` Phase 1a from the `existingMigration` already
  fetched there — no extra store read.
- Populate it in `snapshot.ts` and `snapshot-stream.ts` where they build their
  `schemaChangesToApply` arrays, so a snapshot into an already-populated device gets the
  same treatment as a delta batch.
- Export `normalizeDDL` from `store-adapter.ts` (or move it somewhere both it and the
  ingress paths can reach) so one normalization rule is used everywhere.
- Rework `decideSchemaChange`'s `create_table` arm to the three-row table above, keeping
  the current-shape path as the no-record fallback and updating the doc comment on
  `assertDefinitionMatches` to say which comparison it is performing.
- Make the divergent-create error name both original create statements when the record is
  available.
- Add end-to-end coverage in `schema-replication-idempotency.spec.ts`: two peers create the
  identical table, one alters it, relay in the direction that admits the other's create —
  assert the relay succeeds, both peers keep the altered shape, and a **second** relay also
  succeeds (the permanence half is the point).
- Add a divergent-create counterpart in the same spec: two peers create *differently*
  shaped tables of the same name, one alters, relay — assert it still throws and that the
  message names both creates rather than the altered shape.
- Remove the workaround from `schema-alter-replication.spec.ts`: the `beforeEach` blocks at
  ~188 and ~296 relay in both directions first purely to dodge this bug. Drop the extra
  relays and the comments explaining them, and confirm the specs still pass. Note that the
  `rename to, carrying rows for the new name` block (~526) is asymmetric for a *different*
  reason — competing creates at version 1 tie-break on a random site id — so leave that one
  alone.
- Update `docs/sync-schema.md` (~200-225): the duplicate-create convergence section should
  state that the comparison is against the recorded migration at the same version, with the
  current-shape fallback and its residual limitation spelled out.
- Run `yarn workspace @quereus/sync test` and `yarn typecheck`.
