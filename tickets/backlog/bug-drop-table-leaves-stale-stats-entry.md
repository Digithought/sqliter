---
description: Dropping a table leaves its saved row-count behind, so a new table created with the same name starts out believing it already holds the old table's rows — the query planner then sizes it wrongly.
files:
  - packages/quereus-store/src/common/store-module.ts       # tearDownTableStorage — the site that must also delete the stats entry
  - packages/quereus-store/src/common/store-module-rename.ts # rename already migrates the entry — the shape to copy
  - packages/quereus-store/src/common/store-table-base.ts    # primeStats reads the stale entry back
  - packages/quereus-store/test/reclaim-detached-table.spec.ts # asserts today's behavior; would need the new expectation
repro: static
severity: edge-case
likelihood: normal-use
tradeoffs: It is an estimate, not a result — no query returns wrong rows, so a maintainer may reasonably rank it below anything user-visible, and the leftover entry is a few dozen bytes per dropped table.
---

# Dropping a table leaves its row-count statistics behind

## What happens

Each table's persisted row count lives as ONE ENTRY in a single shared statistics store
(`__stats__`), keyed by `{schema}.{table}` — not in a per-table store. Dropping a table
reclaims its data store, its index stores and its catalog entry, but nobody removes that
entry:

- `StoreModuleBase.tearDownTableStorage` (the path behind `drop table`, and behind the sync
  layer's reclaim of a detached table) deletes stores and catalog DDL, never the stats entry.
- The storage providers each carry a comment saying the entry "will be removed by the calling
  code if needed". No calling code removes it. (The comments in the two mobile providers were
  corrected to say so and to point here; the LevelDB and IndexedDB providers still carry the
  original wording.)
- Renaming a table DOES migrate the entry (`store-module-rename.ts` copies it to the new key
  and deletes the old one), so the drop path is the outlier, not the design.

Consequence: `drop table t` then `create table t (...)` gives the new, empty table the old
table's saved row count. `StoreTableBase.primeStats` reads it on first touch, and every later
write adds its delta on top, so the count stays inflated for the life of the table. The
planner prices access paths from that count, so it can pick a scan where a seek was right (or
the reverse). Nothing returns wrong ROWS — the count is an estimate only.

Secondary effect: the stats store grows by one permanently-orphaned entry per dropped table.

## Expected behavior

Dropping a table leaves nothing behind that a table later created under the same name can
inherit. A table re-created under a dropped name starts from no statistics at all — the same
state as a name never used before.

## Confirming it

Read-only inference from the code so far; no test was run. What would confirm it: with any
store-backed provider, create a table, insert rows, drop it, re-create it under the same name,
and read back its estimated row count (or check the `__stats__` store directly for the key) —
a non-zero count on the empty new table is the defect.

## Where to fix it

One site: `StoreModuleBase.tearDownTableStorage` should delete `buildStatsKey(schema, table)`
from the stats store alongside the store and catalog cleanup, mirroring what the rename path
already does. It must stay idempotent (deleting an absent key is a no-op) because the reclaim
path is called speculatively.

Worth pairing with a generalized check rather than a single-case test, since this is the third
kind of per-table residue (data, catalog, stats) and a fourth would go unnoticed the same way:
after a drop, assert that NOTHING keyed to the dropped table survives anywhere the module
writes — no data or index store, no catalog entry, no statistics entry. That assertion belongs
at the `StoreModule` level (`packages/quereus-store/test/`), not in the provider-level reclaim
battery, because the stats entry is written by the module and the providers correctly never
touch it.

Note `reclaim-detached-table.spec.ts` currently asserts the opposite in a comment ("stats live
in a unified store … so they are not part of the per-table reclaim"); that expectation is what
would change.
