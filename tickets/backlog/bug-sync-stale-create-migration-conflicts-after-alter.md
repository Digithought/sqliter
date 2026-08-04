---
description: Two devices that created the same table separately and then never synced can get permanently stuck the first time they do sync, if either device altered the table in the meantime.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts      # decideSchemaChange, create_table arm
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts  # the beforeEach workaround documents the gap
repro: verified
---

# Stale create_table migration conflicts against an altered table

## Observed

Two peers each run the identical `create table orders (…) using store` while offline
(never having synced with each other). One of them then runs any `ALTER TABLE` on it —
say `add column sku text`. On the FIRST sync between them, the direction that admits the
*other* peer's `create_table` migration (the one with the winning HLC) throws:

```
Schema conflict applying remote create_table for main.orders: a different definition already exists locally.
  local:  CREATE TABLE … ("id" …, "note" …, "sku" TEXT NULL) USING store
  remote: CREATE TABLE … ("id" …, "note" …) USING store
```

The two creates were byte-identical when they ran; the "divergence" is only that the
receiving peer's table has since moved on to a later schema version via its own
alteration. The conflict aborts the admission unit before its metadata commits, so the
batch re-applies and re-fails on every subsequent sync, permanently — the same stuck
state divergent creates produce, but for peers that never actually diverged.

Observed while building `schema-alter-replication.spec.ts`: its convergence tests had to
add an initial bidirectional relay (reconcile the creates before altering) to avoid this;
the `beforeEach` comment marks the workaround.

## Why

`decideSchemaChange`'s `create_table` arm compares the incoming migration's DDL against
`generateTableDDL` of the local table's **current** state. Before alterations replicated
that was safe in practice — a table's rendered CREATE only drifted through paths that
didn't record migrations. Now every `ALTER TABLE` moves the rendered DDL away from the
original create, so any not-yet-reconciled duplicate `create_table` (schema version 1)
arriving after a local alteration (version ≥ 2) reads as a divergent definition.

## Expected

A duplicate create that matched at its own schema version should converge even when the
local table has later alterations layered on top. The adapter never sees the migration's
`schemaVersion` (`SchemaChangeToApply` strips it), so possible shapes include: thread the
version through and skip the definition comparison when the local recorded version is
already beyond it, or reconstruct/track the version-1 rendering. Genuinely divergent
creates (different shape at the same version) must still conflict.

## Scope note

Only reachable when peers create the same table independently and alter it before their
first mutual sync — synced-then-altered peers are absorbed by the migration version
guard. Low urgency, but the failure mode is a permanent wedge, not a transient error.
