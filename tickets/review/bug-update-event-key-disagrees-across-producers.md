---
description: The three storage backends used to describe a primary-key-changing update differently, so an app listening for changes could not tell which row moved. They now all follow one written-down rule, and every backend was changed to match.
prereq:
files:
  - docs/usage.md                                                  # the contract, § Subscribing to Data Changes
  - docs/module-authoring.md                                       # producer obligation (end of the events section)
  - docs/module-events.md                                          # key field comment + re-key rule
  - docs/store.md                                                  # store hook doc points at the contract
  - packages/quereus/src/runtime/emit/dml-executor.ts              # engine auto path: pkEventComparators, primaryKeyRelocated, emitAutoUpdateEvents
  - packages/quereus/src/vtab/memory/layer/manager.ts              # memory native: eventKeyFromImage + commit-time emit
  - packages/quereus/src/vtab/memory/layer/transaction.ts          # PendingChange.pk removed with its re-key machinery
  - packages/quereus/src/core/database-events.ts                   # selectKeySourceImage simplified to the contract
  - packages/quereus-store/src/common/store-table.ts               # store update arm splits on pkChanged
  - packages/quereus/test/data-event-key-contract.spec.ts          # NEW — engine auto + memory native
  - packages/quereus-store/test/data-event-key-contract.spec.ts    # NEW — store
  - packages/quereus-sync/test/sync/pk-changing-update.spec.ts     # NEW — sync end-to-end
  - packages/quereus/test/alter-table-events.spec.ts               # re-pinned
  - packages/quereus-store/test/alter-events.spec.ts               # re-pinned
difficulty: medium
---

# What the rule is now

Written into `docs/usage.md` § Subscribing to Data Changes, and repeated as a producer
obligation in `docs/module-authoring.md`:

1. **`key` is the primary key projected out of the event's own row image** — `newRow` for an
   `insert` and an `update`, `oldRow` for a `delete`. So an update keys by its *post*-image.
2. **An `update` never moves a row.** If a statement changes a primary key such that the row
   *relocates* — its key values differ under the primary key's own comparator, which is
   per-column collation- and type-aware, not byte identity — the producer delivers a `delete`
   at the old key then an `insert` at the new key, **in that order**, instead of one `update`.
   A rewrite that leaves the row in place (a `NOCASE` `'apple'` → `'APPLE'`) stays a single
   `update`, whose `key` clause 1 fixes to the post-image.

Documented costs: a relocating update carries no `changedColumns` and no "same row" link
between the two events, and **ordering is guaranteed but adjacency is not**.

# What changed, per producer

**Engine auto-event path** (`dml-executor.ts`) — one new helper `emitAutoUpdateEvents(ctx,
oldRow, newRow)` now owns every row-level update event, and three call sites were rewired to
it: `processUpdateRow`'s update event, the INSERT arm's same-key REPLACE event, and the UPSERT
`DO UPDATE` arm (which the original ticket did not list, but which is the same producer and had
the same pre-image-key bug when the DO UPDATE moves the row). `keyValues` in `processUpdateRow`
was deliberately left pointing at the OLD row — it is the vtab's `oldKeyValues` and the
`buildUpdateStatement` argument. Relocation is tested by `pkEventComparators`, built once per
emit from `uniqueEnforcementComparators` over `primaryKeyDefinition[i].collation`.

**Store** (`store-table.ts`) — the update arm's single event became a split on the existing
`pkChanged` (`!bytesEqual(oldKey, newKey)`), which is already collation-correct because encoded
data keys fold each PK column's key collation. The `replacedAtNewPk` eviction delete still
emits first, so the delivered order is evict-delete, move-delete, move-insert.

**Memory native** (`manager.ts`) — the commit-time emit now projects `key` from
`change.newRow ?? change.oldRow` through the schema current at delivery, instead of replaying
the key each write recorded. This is what fixes the `NOCASE` case (`recordUpsert` files an
in-place rewrite under the *pre*-image key). Its relocating-update path already recorded
delete-then-insert, so clause 2 needed nothing there.

**Sync** — no production change. Verified end to end: it now sees `delete` + `insert`, writes a
tombstone for the old pk, and files a full cell set (not a diff) under the new one.

# Removals worth a reviewer's eye

Projecting the memory key at emit time made two pieces of machinery dead, and both were
removed rather than left as traps:

- `PendingChange.pk` — its only consumer was the commit-time emit. Gone, along with
  `TransactionLayer.prepareRekeyedPrimaryKeyColumns`' `rekeyedPendingChanges`, the
  `PreparedPrimaryKeyRekey.rekeyedPendingChanges` field, its install arm, and
  `selectEventKeySourceImage`. The ALTER PRIMARY KEY re-key of memory-native events is now the
  emit-time projection itself.
- `DatabaseEventEmitter`'s `selectKeySourceImage` tie-break (`database-events.ts`) — it existed
  only because the producers disagreed. It now follows the contract (`newRow` for insert and
  update, `oldRow` for delete) and *warns* when a producer's recorded key does not reproduce
  from its own image, which is now a contract violation rather than an expected variation.

**This is the largest risk surface in the change.** `PendingChange.pk` deletion means a
mid-transaction ALTER PRIMARY KEY on a memory-native table gets its event keys solely from the
delivery-time schema projection. The three ALTER PRIMARY KEY re-key specs
(`alter-table-events.spec.ts`) exercise widening, narrowing, and re-keying to a column absent
from the old key, and pass — but a reviewer should convince themselves there is no
mid-transaction shape in which the recorded images are NOT already at the delivered schema's
arity. `eventKeyFromImage` degrades to "no key + warn" in that case rather than emitting an
`undefined` key slot; nothing pins that fallback.

# Use cases to test / validate

Run these by subscribing with `db.onDataChange` before the statement:

| case | expected |
|---|---|
| `update t set a = 2 where a = 1`, `t(a pk)` holding `(1,'x')` | `delete key [1] oldRow [1,'x']`, then `insert key [2] newRow [2,'x']` |
| same, but `set a = 2, v = 'y'` | same two events, **no** `changedColumns` on either |
| `update t set k = 'APPLE' where k = 'apple'`, `k text collate nocase` pk | ONE `update`, `key ['APPLE']`, and `select k from t` returns `'APPLE'` |
| `update t set v = 'y' where a = 1` | ONE `update`, `key [1]`, `changedColumns ['v']` (store omits `changedColumns` by design) |
| composite pk `(a,b)`, `update t set b = 8` | split — `delete [1,9]`, `insert [1,8]` |
| pk declared `on conflict replace`, rows at 1 and 2, `update t set a = 2 where a = 1` | THREE events: `delete [2]` (evicted), `delete [1]` (move), `insert [2]` |
| `insert … on conflict (b) do update set a = 2` where the conflicting row moves | split, like a plain relocating update |

All seven run against the engine auto path and the memory native path
(`packages/quereus/test/data-event-key-contract.spec.ts`, 14 tests) and six of them against the
store (`packages/quereus-store/test/data-event-key-contract.spec.ts`; the
`changedColumns`-present case is inverted there to assert the store's deliberate omission).

Sync (`packages/quereus-sync/test/sync/pk-changing-update.spec.ts`, 4 tests): a relocating
update on a synced table leaves the receiving peer holding only the new pk; the old pk is
tombstoned and the new one is not; the relayed change list is `delete pk[1]` followed by a
column entry per column at `pk[2]`; and a `NOCASE` case-only rewrite tombstones nothing.

# Known gaps

- **`update or replace` is unreachable in this dialect.** The REPLACE ordering case is reached
  through a declared `primary key (a) on conflict replace`. A statement-level `OR REPLACE` on
  UPDATE, if the parser ever gains it, is not covered.
- **The `eventKeyFromImage` "no usable image" fallback is untested.** It logs and ships an event
  with no `key`. Reaching it requires a pending-change image the ADD/DROP COLUMN reshape had to
  leave at the retired arity — a best-effort path that is itself only reachable when a backfill
  evaluator throws.
- **The `selectKeySourceImage` warning path is untested.** It fires only for a third-party
  module with its own emitter that violates clause 1; no in-tree module can trigger it.
- **No test pins that a relocating update inside an explicit transaction preserves
  delete-before-insert ORDER across the whole batch** when other tables' events interleave. The
  contract deliberately promises ordering but not adjacency; the specs only observe
  single-statement autocommit, where the two are indistinguishable.
- **The isolation layer (`quereus-isolation`) was not exercised.** It has no data-event emitter
  of its own, so it should be transparent here — but that was reasoned, not tested.
- **`docs/sync.md` was not touched.** Sync's observable behaviour for a PK-changing update did
  change (a tombstone now appears where none did before), and the doc says nothing about it
  either way. Judged out of scope; flag if the reviewer disagrees.

# Tripwire parked

`NOTE:` at `primaryKeyRelocated` in `packages/quereus/src/runtime/emit/dml-executor.ts` — the
engine's relocation verdict is built from `uniqueEnforcementComparators` while the memory
substrate decides the same question from `createPrimaryKeyFunctions`. Two constructions that
agree on every type in tree today; they could part company on a type carrying a `compare`
without `semanticOrdering` (DATE/TIME/DATETIME) *if* such a column ever became able to declare
a non-BINARY collation, which the DDL currently refuses.

# Validation run

- `yarn test` — all workspaces green (quereus 8180 passing / 13 pending; store 1232; sync 643;
  everything else unchanged), zero failures.
- `yarn test:store` — 8172 passing / 21 pending, zero failures.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `npx tsc -b tsconfig.build.json` — clean (needed before the sync leg: `@quereus/sync` tests
  resolve `@quereus/store` through `dist`, so the store split is invisible to them until built.
  A reviewer re-running only the sync spec on a stale `dist` will see it fail misleadingly).

No pre-existing failures surfaced.
