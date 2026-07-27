---
description: Fixed a data-loss bug where creating or dropping an index inside a transaction silently threw away rows the transaction had already inserted, once it rolled back to an earlier savepoint.
files:
  - packages/quereus-isolation/src/isolation-module.ts                        # createIndex / dropIndex / applyIndexChangeToOverlays / applyInPlaceOverlayChange / createOverlayIndexSchema
  - packages/quereus-isolation/src/isolated-connection.ts                     # overlayConnection captured at construction (unchanged; see tripwire)
  - packages/quereus-isolation/test/isolation-layer.spec.ts                   # "index DDL inside a transaction preserves the overlay savepoint chain" suite (~line 1824)
  - packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic       # § 4, cross-backend savepoint sequence
  - packages/quereus/test/logic.spec.ts                                       # note recording the folded-away memory-only file
difficulty: medium
---

# Index DDL inside a transaction no longer discards pre-savepoint writes

## What was wrong

Each connection's uncommitted rows live in a private staging table (an "overlay"). `create index`
and `drop index` used to throw that staging table away and copy the staged rows into a fresh one.
The copy's first write lazily registered the new staging table's connection with the `Database`,
and registration replays `begin()` plus the whole active savepoint stack **before** the copy runs.
So every copied row landed *above* the replayed savepoint, and the next `rollback to savepoint`
discarded rows staged long before that savepoint was taken. Silent data loss.

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');   -- staged BEFORE the savepoint
savepoint s;
drop index ix;
rollback to savepoint s;
select id, v from t;             -- was []; now [{id:1, v:'a'}]
```

Not store-specific — reproduced equally on a plain in-memory table wrapped by the isolation layer.

## What changed

Both index paths now adopt the change **in place** instead of rebuilding:

- `IsolationModule.createIndex` / `dropIndex` → `applyIndexChangeToOverlays`, which walks each
  non-poisoned overlay for the table and calls `createOverlayIndex` / `dropOverlayIndex` on it.
- `createOverlayIndexSchema(idx, baseName, overlayName)` was factored out of `createOverlaySchema`
  so a single index handed to an already-open overlay is structurally identical to one copied in
  at overlay-creation time (predicate narrowed to live rows, self-qualifier rescoped onto the
  overlay's table name).
- `applyInPlaceOverlayChange` routes a `CONSTRAINT` thrown by an in-place adopt: the issuer's own
  overlay → `INTERNAL` (validation and migration have drifted), a foreign overlay → poison it and
  leave it untouched so its owner errors and rolls back. Shared with the ALTER TABLE forwards, so
  the two cannot drift on error routing.
- `rebuildOverlaysForIndexChange` / `rebuildOverlayForIndexChange` are gone; no caller remains
  (the ALTER paths were converted to in-place forwards by the two sibling `isolation-alter-*`
  tickets). `assertIndexPresent` is kept — the overlay's index schema is derived from the
  underlying's refreshed schema, so a underlying that does not refresh must still be caught loudly.

The rebuild originally existed because an open write `TransactionLayer` froze its schema at
creation. `bug-drop-index-in-transaction-still-enforced` gave `TransactionLayer.adoptSchema` both
an additive and a removal branch, so an open layer can adopt an index change with its savepoint
snapshots intact. The stale doc comments that justified the rebuild by that limitation were
rewritten.

## Provenance — read this before reviewing the diff

Most of this landed in commit `8ead1843`, which the runner committed when an earlier attempt at
this ticket timed out mid-run (the commit message says "timed out … added resume note"). Two
sibling tickets then refactored on top of it: `isolation-alter-forward-column-shape` (`c604abce`)
and `isolation-alter-forward-constraints-and-retype` (`27a1e650`, `ccdbd94c`) generalized the
error-routing seam into `applyInPlaceOverlayChange` and converted the ALTER paths the same way.

**This run therefore added almost no new code.** It verified every TODO item was actually
satisfied in the tree, ran the full validation the timed-out run never reached, and made two
comment-only edits (below). The diff a reviewer sees attributed to this ticket is small; the
substance to review sits in those three prior commits.

## Testing / validation

All run from repo root, all green:

- `yarn build` — clean.
- `yarn test` — 7404 + 315 + 1081 + 594 + others passing, **0 failing**, 13 pending.
- `yarn workspace @quereus/isolation run test` — 315 passing.
- `yarn test:store` — 7398 passing, **0 failing**, 19 pending.

### Use cases the tests pin

`packages/quereus-isolation/test/isolation-layer.spec.ts`, suite *"index DDL inside a transaction
preserves the overlay savepoint chain"* (~line 1824), against `MemoryTableModule` as underlying:

| test | pins |
|---|---|
| `DROP INDEX after a savepoint keeps rows staged before the savepoint` | variant A |
| `CREATE UNIQUE INDEX after a savepoint keeps rows staged before the savepoint` | variant B |
| `rollback to savepoint keeps pre-savepoint rows and discards post-savepoint ones across a DROP INDEX` | variant C — **both** directions; the important one |
| `a staged tombstone survives DROP INDEX under a savepoint` | a staged DELETE still lands at commit |

`packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic` § 4 asserts the same
sequence **cross-backend** (memory and store), plus that `rollback to savepoint` does *not* undo
the DROP itself — DDL is non-transactional on both backends, so a would-be duplicate insert after
the rollback is still accepted. The former memory-only file `10.1.3.1-ddl-drop-savepoint-memory.sqllogic`
was folded into it and deleted; `packages/quereus/test/logic.spec.ts:41` carries a comment saying
why the backends now agree.

## Known gaps — please probe these

- **Foreign-overlay poisoning on `create index` is not directly tested.** The path exists
  (`applyInPlaceOverlayChange`, foreign branch) and is exercised by the ALTER suites, but no test
  drives *two* connections where connection B has staged rows that violate a UNIQUE index
  connection A creates. Worth adding.
- **`dropIndex` does not early-return when the underlying supports no indexes**, unlike
  `createIndex` (which returns at `isolation-module.ts` ~1114). It falls through to the overlay
  walk, where `dropOverlayIndex` no-ops via the `schemaHasIndex` guard. Believed harmless — an
  underlying with no index support has no indexes for an overlay to have copied — but it is an
  asymmetry, not a deliberate design, and was not tested.
- **No test covers a *partial* index (one with a `where` predicate) created mid-transaction on an
  open overlay.** `createOverlayIndexSchema` rescopes the predicate's self-qualifier onto the
  overlay's generated name; that rescoping is only covered indirectly, through the
  overlay-creation path in `createOverlaySchema`.
- **Concurrency was not exercised.** The overlay walk is sequential `await` per overlay; nothing
  tests interleaved DDL from two connections.
- **Store backend savepoint noise.** `yarn test:store` logs
  `[TransactionCoordinator] rollback-to savepoint depth 0 out of range (stack size: 0); transaction
  was committed out from under it` twice. Warn-level only, tests pass, and it originates in
  `quereus-store` code this ticket never touched — pre-existing, not investigated here.

## Tripwires parked in code

- `isolation-module.ts`, `replaceOverlayForPrimaryKeyChange` — a `NOTE:` recording that this is now
  the *only* path that swaps an overlay table rather than adopting in place, so a registered
  `IsolatedConnection` keeps the old overlay's connection and forwards savepoint calls to a
  released table. Benign today (the swapped overlay is clean, and the fresh one registers its own
  connection), but it is the same shape as the bug this ticket fixed and would bite if the swap
  ever became reachable with staged rows.
- `isolation-module.ts`, `releaseOverlayTable` doc comment — corrected "one more per rebuild" to
  name the `alterPrimaryKey` swap, since rebuilds no longer exist.
