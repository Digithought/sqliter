<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-26T15:12:47.205Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\bug-isolation-index-ddl-rebuild-drops-savepoint-writes.implement.2026-07-26T15-12-47-205Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
---
description: When a transaction creates or drops an index and later rolls back to a savepoint taken before that index change, rows the transaction had already inserted vanish without any error.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # createIndex / dropIndex / rebuildOverlaysForIndexChange / rebuildOverlayForIndexChange / createOverlaySchema
  - packages/quereus-isolation/src/isolated-table.ts          # overlay lifecycle, savepoint callbacks
  - packages/quereus-isolation/src/isolated-connection.ts     # connection fan-out to overlay/underlying
  - packages/quereus/src/core/database.ts                     # registerConnection (savepoint replay, ~line 2040)
  - packages/quereus/src/vtab/memory/layer/manager.ts         # dropIndex/createIndex -> adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/transaction.ts     # TransactionLayer.adoptSchema (additive + removal branches)
  - packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic
  - packages/quereus/test/logic/10.1.3.1-ddl-drop-savepoint-memory.sqllogic
  - packages/quereus-isolation/test/isolation-layer.spec.ts
difficulty: medium
---

# Isolation overlay rebuild erases every write staged before the DDL

Promoted from `fix/bug-store-savepoint-ddl-drop-lost-insert`. Reproduction, root cause and a
validated fix direction are below; the original ticket's description of *which* row is lost was
wrong and is corrected here.

## Confirmed behavior

Reproduced on the LevelDB store backend, and equally on a plain in-memory table wrapped by the
isolation layer — so this is **not** store-specific. It is a defect of the isolation layer
(`packages/quereus-isolation`), which the store happens to be the only in-repo user of.

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');   -- staged
savepoint s;
drop index ix;
rollback to savepoint s;
select id, v from t;             -- [] — row (1,'a') is GONE
commit;
select id, v from t;             -- [] — still gone
```

The lost row is **(1,'a')**, the one inserted *before* the savepoint. (The original ticket said
the *second* insert was lost; a step-by-step probe shows otherwise — the second insert lands and
survives fine. The observable symptom in the original `.sqllogic` — "expected 2 rows, got 1" — is
the same either way, which is how the mix-up happened.)

`rollback to savepoint s` must never discard work done before `s`. This is silent data loss.

Four variants were probed; all four lose the pre-savepoint row:

| # | DDL run between `savepoint s` and `rollback to savepoint s` | pre-savepoint row after rollback |
|---|---|---|
| A | `drop index ix`                | lost |
| B | `create unique index ix on t (v)` | lost |
| C | `insert; drop index; insert` (rows *after* the savepoint should be dropped, the pre-savepoint one kept) | all lost |
| D | `alter table t add column w text` | lost |

A, B and C are this ticket. D goes through a different code path and is split out as
`bug-isolation-alter-column-rebuild-drops-savepoint-writes`.

## Root cause

Each connection's uncommitted writes are staged in a private **overlay** table (a `MemoryTable`
created per connection+table, holding staged rows plus tombstones). `IsolationModule.createIndex`
and `IsolationModule.dropIndex` do not tell the existing overlay about the index change — they
**throw the overlay away and build a new one**, copying the staged rows across
(`rebuildOverlaysForIndexChange` → `rebuildOverlayForIndexChange`, `isolation-module.ts` ~1240–1295).

The copy loop calls `newOverlayTable.update(...)`. That is the new overlay's first write, so
`MemoryTable.ensureConnection` opens a connection for it and registers it with the `Database`
(`packages/quereus/src/vtab/memory/table.ts:116`). `Database.registerConnection`
(`database.ts:2040`) then does exactly what it is supposed to do for a lazily-appearing
connection: it calls `begin()` and **replays the whole active savepoint stack** so later
`rollback to <depth>` broadcasts are in range.

The ordering is the bug:

```
create new overlay table
  → copy staged rows in
      → first write registers the new overlay's connection
          → registerConnection replays begin() + createSavepoint(0)   <-- happens FIRST
      → rows are then written ABOVE savepoint 0
rollback to savepoint 0  → discards every copied row
```

Every staged row lands *above* the replayed savepoint, so the next `rollback to savepoint`
unwinds all of them regardless of when they were actually written. Variant C shows the flip side:
today the rebuild flattens the layer chain, so the distinction between "staged before the
savepoint" and "staged after it" is destroyed in both directions.

Two secondary staleness facts, worth knowing while working here but not the primary cause:

- `IsolatedConnection` captures `overlayConnection` at construction
  (`isolated-connection.ts:40`), so after a rebuild it still points at the *discarded* overlay;
  its savepoint/rollback forwards go to a table nobody reads.
- The discarded overlay's own `MemoryVirtualTableConnection` stays in the `Database` connection
  registry after `releaseOverlayTable`.

## The rebuild is no longer necessary

The rebuild exists because of a memory-module limitation that has since been fixed. The comment
on `IsolationModule.dropIndex` (isolation-module.ts ~1195–1206) states it:

> A bare forward to `overlay.dropIndex` is insufficient: when the overlay's `MemoryTable` has an
> active write `TransactionLayer`, its `tableSchemaAtCreation` is frozen at layer-creation time,
> so the synthesized UNIQUE constraint keeps firing … even after the manager's schema is refreshed.

That is stale. `bug-drop-index-in-transaction-still-enforced` gave `MemoryTableManager.dropIndex`
and `createIndex` an `adoptSchemaOnOpenLayers` call, and `TransactionLayer.adoptSchema`
(`transaction.ts` ~200–233) now has both an **additive** branch (build the new index into the
layer) and a **removal** branch (drop an index the new schema no longer declares, which also
strips the derived UNIQUE constraint). An open transaction layer therefore *can* adopt an index
change in place, savepoint chain intact.

## Validated fix direction

Spiked both directions locally; both work and both were reverted before handoff.

**`dropIndex`** — replace the `rebuildOverlaysForIndexChange` call with a per-overlay forward:

```ts
for (const key of this.connectionScopedKeys(this.connectionOverlays, schemaName, tableName)) {
  const overlayState = this.connectionOverlays.get(key)!;
  if (overlayState.poison) continue;              // poisoned overlays are still left alone
  await overlayState.overlayTable.dropIndex?.(indexName);
}
```

With that in place variant A keeps row 1, and variant C correctly keeps only row 1 (rows staged
after the savepoint are discarded, as they should be) — the layer chain and its savepoint
snapshots survive untouched.

**`createIndex`** — same shape, but the overlay needs an *overlay-flavored* `IndexSchema`: the
base index's predicate AND-ed with `<tombstone> = 0`, with any self-qualifier in the predicate
rescoped from the base table's name to **this** overlay's name. `createOverlaySchema`
(isolation-module.ts ~2052) already builds exactly that for a whole schema; factor the per-index
part out into a helper (e.g. `createOverlayIndexSchema(idx, baseName, overlayName)`) and call it
from both places rather than duplicating the `andPredicate`/`rescopePredicateQualifier` logic.
The derived UNIQUE constraint needs no separate handling — `MemoryTableManager.createIndex`
synthesizes it from the index schema and carries its predicate over.

Both `MemoryTable.createIndex(indexSchema, rows?)` and `MemoryTable.dropIndex(indexName)` exist
and forward to the manager, keeping `MemoryTable.tableSchema` fresh
(`packages/quereus/src/vtab/memory/table.ts:418,424`).

### Behavior that must be preserved

The rebuild carried three responsibilities beyond the schema swap. Check each survives:

- **Foreign-overlay poisoning.** A `create index` whose new UNIQUE the *other* connection's staged
  rows violate must poison that connection's overlay rather than fail the DDL
  (`adoptRebuiltOverlay`, isolation-module.ts ~979). In-place `overlayTable.createIndex` will
  throw `CONSTRAINT` from `validateUniqueOverEffectiveRows`; route it through the same
  issuer-vs-foreign decision (issuer → `INTERNAL`, foreign → poison + leave the overlay alone).
- **Poisoned overlays are skipped** — keep the `if (overlayState.poison) continue;` guard.
- **Underlyings without index support.** `createIndex` currently returns early when neither the
  table nor the module exposes `createIndex`; keep that, and treat an overlay module without
  `createIndex`/`dropIndex` as a no-op rather than a throw.

Once neither index path calls it, `rebuildOverlaysForIndexChange` /
`rebuildOverlayForIndexChange` become dead — but check the ALTER path
(`migrateOverlayForAlter`) first, and leave `insertIntoRebuiltOverlay` /
`adoptRebuiltOverlay` in place since ALTER still uses them.

## Test coverage to add

- `packages/quereus-isolation/test/isolation-layer.spec.ts` — a `savepoints` sub-suite covering
  variants A, B and C above, against `MemoryTableModule` as the underlying. C is the important
  one: it pins *both* directions (pre-savepoint row kept, post-savepoint rows discarded).
- `packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic` — the savepoint case can
  now be asserted cross-backend. Memory-direct and store must both keep the pre-savepoint row.
  Note the pre-existing backend divergence that keeps the memory-only file alive: memory does not
  undo the DROP on `rollback to savepoint`, so the later duplicate insert is *accepted*. Verify
  the store now matches (it should — `feat-ddl-transaction-capability` put store on the
  `'auto-commit'` DDL tier, i.e. DDL is not part of the transaction and is not rolled back).
- Fold the now-shared case out of `10.1.3.1-ddl-drop-savepoint-memory.sqllogic` if it becomes
  redundant, and update that file's header comment — it currently claims store "implements
  savepoint/DDL differently", which after this fix is only true of the DDL-not-rolled-back part.

## TODO

- [ ] Extract a `createOverlayIndexSchema(idx, baseName, overlayName)` helper out of
      `createOverlaySchema`, and have `createOverlaySchema` use it for its own index mapping.
- [ ] Rewrite `IsolationModule.dropIndex` to forward `dropIndex` to each non-poisoned overlay
      in place instead of rebuilding.
- [ ] Rewrite `IsolationModule.createIndex` to forward `createIndex` (with the overlay-flavored
      index schema) to each non-poisoned overlay in place instead of rebuilding.
- [ ] Route a `CONSTRAINT` thrown by an in-place overlay `createIndex` through the existing
      issuer-`INTERNAL` / foreign-poison decision; keep the poison message wording.
- [ ] Keep `assertIndexPresent` — the underlying must still report the refreshed schema, since
      the overlay index schema is derived from it.
- [ ] Delete `rebuildOverlaysForIndexChange` / `rebuildOverlayForIndexChange` if the ALTER path
      does not use them; otherwise leave them and note why.
- [ ] Refresh the stale doc comments on `IsolationModule.dropIndex` / `createIndex` that justify
      the rebuild by the now-fixed frozen-schema limitation.
- [ ] Add the isolation-layer savepoint tests (A, B, C).
- [ ] Assert the savepoint sequence cross-backend in `10.1.3-ddl-drop-in-transaction.sqllogic`
      and update the memory-only file's header.
- [ ] `yarn build && yarn test`, then `yarn test:store` (store is where the original report came
      from). Also run the isolation package's own suite:
      `yarn workspace @quereus/isolation run test`.
