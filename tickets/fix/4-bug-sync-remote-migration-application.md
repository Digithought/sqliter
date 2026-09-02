description: When a device receives a batch of changes from another device, it applies the schema changes in that batch without regard to the rows that justify them or to how the local table has moved on — so an ordinary "tighten this rule" or "we both created the same table" sequence reports a sync failure, and in one case the failure repeats forever.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts   # createStoreAdapter — schema changes applied before data changes; decideSchemaChange, create_table arm
  - packages/quereus-sync/src/sync/admission.ts       # applyDataToStore / admitGroup — turns the DDL error into a failed admission unit
  - packages/quereus-sync/src/sync/sync-context.ts    # throwIfApplyErrors
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts   # the beforeEach workaround documents arm B
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Both arms have a workaround that already works in practice (sync again; relay the creates before altering), and reordering or reconciling migration application is delicate enough to risk introducing a worse divergence than the errors it removes.
----

# Remote schema migrations are applied without regard to context

A receiving device admits a batch by applying its schema changes and its row changes.
Two separately-filed defects sit in the same admission path, and both are the same
omission: **the migration is applied as-is, against whatever the local database happens to
be, with no reconciliation.** Arm A is about ordering within the batch; arm B is about the
local table having moved on. Both resolve in `sync/store-adapter.ts`.

## Arm A — a tightening schema change runs before the data that satisfies it (verified)

A receiving device applies a batch's schema changes **before** its row changes. That
ordering is right for a change that *loosens* or *extends* a table (adding a column,
dropping a constraint): the rows that follow need the new shape to land in. It is wrong for
a change that *tightens* one, because the tightening is only legal against rows the device
does not have yet — they are queued behind it in the same batch.

Observed against two real engines:

1. Both devices hold `orders` with one row whose `note` is empty (NULL).
2. Device A fills it in, then runs `alter table orders alter column note set not null`.
3. Both changes relay to device B in one batch.
4. B applies the schema change first, against a row that is still empty, and the engine
   refuses: `column note contains NULL values`.
5. The whole batch is reported failed — the caller of `applyChanges` sees
   `apply-to-store failed for 1 change(s): main.orders (alter_column): column note
   contains NULL values`.

The next sync round succeeds, so this is a spurious error rather than permanent
divergence — but it is an error the application sees on an ordinary sequence, and there is
no ordering the adapter can pick that is right for both loosening and tightening changes
without looking at which kind it has.

## Arm B — a stale `create_table` migration conflicts against an altered table (verified)

Two peers each run the identical `create table orders (…) using store` while offline
(never having synced). One then runs any `ALTER TABLE` on it — say `add column sku text`.
On the **first** sync between them, the direction that admits the other peer's
`create_table` migration (the one with the winning HLC) throws:

```
Schema conflict applying remote create_table for main.orders: a different definition already exists locally.
  local:  CREATE TABLE … ("id" …, "note" …, "sku" TEXT NULL) USING store
  remote: CREATE TABLE … ("id" …, "note" …) USING store
```

The two creates were byte-identical when they ran; the "divergence" is only that the
receiving peer's table has since moved on to a later schema version via its own alteration.
The conflict aborts the admission unit before its metadata commits, so the batch re-applies
and **re-fails on every subsequent sync, permanently** — the same stuck state that genuinely
divergent creates produce, for peers that never actually diverged.

Observed while building `schema-alter-replication.spec.ts`: its convergence tests had to
add an initial bidirectional relay (reconcile the creates before altering) to avoid this,
and the `beforeEach` comment marks the workaround.

## Notes for whoever picks this up

- Arm B is the more serious of the two: arm A recovers on the next round, arm B does not
  recover at all.
- Both need the adapter to compare the incoming migration against the local schema's
  history rather than against its current shape — the same information, from two angles.
  Deciding what that comparison is, once, serves both.
- The two-peer harness in `packages/quereus-sync/test/sync/` reproduces both.
