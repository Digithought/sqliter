description: When one transaction both changes rows in a table and drops that table, sync currently throws while recording the commit and discards the whole transaction, so unrelated changes in it never reach other devices; make sync skip only the dropped table's rows and record everything else.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # handleTransactionCommit ~line 709, recordDataEvent ~799, recordColumnVersions ~851
  - packages/quereus-sync/src/metadata/pk-identity.ts          # createPkKeyingResolver — the throw being guarded
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts # where the new capture-side tests belong
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # ~line 1926 — existing test whose expectation changes
  - packages/quereus-sync/test/sync/_peer-harness.ts           # makePeer / relayAll for the peer-facing test
  - packages/quereus-store/src/common/store-module.ts          # ~line 829 — where the drop schema event is emitted (context only, do not change)
difficulty: medium
----

## Confirmed reproduction

Verified against a real `Database` + `StoreModule` peer (`makePeer` from
`test/sync/_peer-harness.ts`):

```
create table a (id integer primary key, v text) using store
create table b (id integer primary key, v text) using store
insert into a values (1, 'a1'); insert into b values (1, 'b1')

begin
  update a set v = 'a2' where id = 1
  update b set v = 'b2' where id = 1
  drop table a
commit
```

Console output and change log afterwards:

```
[Sync] No table schema found for main.a - using fallback column names
[Sync] Error handling transaction commit: Error: No table schema for main.a — sync pk identity is unresolvable ...
    at ColumnVersionStore.keying (metadata/pk-identity.ts)
    at ColumnVersionStore.identity (metadata/column-version.ts)
    at ColumnVersionStore.getColumnVersion (metadata/column-version.ts)
    at SyncManagerImpl.recordColumnVersions (sync/sync-manager-impl.ts)
    at SyncManagerImpl.recordDataEvent (sync/sync-manager-impl.ts)
    at SyncManagerImpl.handleTransactionCommit (sync/sync-manager-impl.ts)

getChangesSince: b's update to 'b2' ABSENT, drop_table migration for a ABSENT
                 (only the two pre-transaction create_table migrations and the
                  original inserts survive)
```

`handleTransactionCommit`'s single top-level `try` wraps the whole transaction, so
the first unresolvable table aborts recording of *everything* — the other table's
rows and the schema migrations both.

## The fix

Filter the transaction's local data events **before** the HLC tick, dropping the
events of any table whose pk-identity keying cannot be resolved right now. Gate on
*resolvability*, not on "this transaction contains a drop for it".

Why resolvability and not the drop list:

- `create t; drop t; create t; insert into t` inside one transaction has a drop
  event for `t`, but `t` resolves fine at capture time and its rows must still be
  captured. A blanket drop-name skip would silently lose them.
- Resolvability covers every other way a table can vanish mid-transaction (e.g. a
  rename, tracked separately), not only drops.
- Probing resolvability up front means no event is ever half-recorded: the current
  throw can fire *after* a tombstone has been staged into the shared `WriteBatch`.

The drop list is still worth computing — use it only to classify the log line, so an
expected skip (the table was dropped by this same transaction) reads differently from
an anomaly (the table vanished for some other reason).

Prototyped shape (verified: repro passes, full `@quereus/sync` suite otherwise green):

```ts
// in handleTransactionCommit, replacing the plain localData filter:
const localSchema = batch.schemaEvents.filter(e => !e.remote);
const localData = this.filterCapturableDataEvents(
    batch.dataEvents.filter(e => !e.remote),
    localSchema,
);
if (localSchema.length === 0 && localData.length === 0) return;   // unchanged early-out
```

```ts
/**
 * Drop the data events of any table whose pk-identity keying cannot be resolved —
 * typically a table this same transaction dropped. Recording is per-transaction
 * best-effort at TABLE granularity: one unresolvable table costs only its own rows,
 * never the rest of the transaction (which is what the top-level catch would do).
 * Runs BEFORE the HLC tick, so a fully-skipped transaction consumes no clock and
 * nothing is ever half-staged into the shared WriteBatch.
 */
private filterCapturableDataEvents(
    events: DatabaseDataChangeEvent[],
    localSchema: DatabaseSchemaChangeEvent[],
): DatabaseDataChangeEvent[] { /* per-table resolvable? cache; count skips per table */ }

private isPkKeyingResolvable(schemaName: string, tableName: string): boolean {
    try { this.pkKeying(schemaName, tableName); return true; } catch { return false; }
}
```

Notes on the shape:

- Cache the resolvable verdict per `schema.table` for the transaction — one probe per
  table, not per row.
- Emit ONE log line per skipped table with the change count, not one per row.
  Dropped-by-this-transaction → informational; otherwise → `console.warn`.
- Keeping the early-return before the tick matters: a transaction whose data is
  entirely skipped and that carries no schema events must consume no HLC and emit no
  `localChange`, mirroring the existing all-remote-echo behavior directly above it.
- A relay-only deployment (no `getTableSchema` oracle) resolves every table to
  `RAW_PK_KEYING` and never throws, so nothing is skipped there — no behavior change.
- `opSeq` contiguity is preserved for free: opSeq is only allocated for facts that
  are actually recorded.

## Dead branch to clean up

`recordColumnVersions` (~line 861) currently does:

```ts
if (!tableSchema && this.getTableSchema) {
    console.warn(`[Sync] No table schema found for ${schemaName}.${tableName} - using fallback column names`);
}
```

With the filter in place this branch is unreachable — an oracle-wired manager can no
longer reach `recordColumnVersions` for a table the oracle does not know. Remove the
warn branch. Keep the `columnNames?.[i] ?? \`col_${i}\`` fallback itself: it is still
the live path for a relay-only manager with no oracle at all.

## Existing test that must change

`test/sync/sync-manager.spec.ts` ~line 1926, `'should warn about missing table schema
when getTableSchema is provided but returns undefined'`, asserts the
`No table schema found` warning fires and that the insert is recorded with placeholder
column names. That expectation is exactly the behavior being replaced. Rewrite it to
assert the new contract: the row change is **skipped**, one skip warning naming the
table is emitted, and no `cv:` record is written for it.

The sibling test right above it (`'should not warn ... when getTableSchema is not
provided'`) exercises the relay-only path and must keep passing unchanged.

## Tests to add

In `test/sync/transaction-commit.spec.ts` (real `Database` + `makePeer`, alongside the
existing rollback test):

- **Mixed transaction, capture side.** The reproduction above. Assert
  `getChangesSince` returns b's `v='b2'` column change AND a `drop_table` migration
  for `a`, and returns nothing for `a`'s rows.
- **Peer side.** Relay that transaction to a second peer with `relayAll` and assert
  `select v from b where id = 1` is `'b2'` there. (Verified working with the prototype.)
- **Drop-then-recreate in one transaction.** `begin; drop table a; create table a (...);
  insert into a ...; commit` — assert the post-recreate insert IS captured. This is the
  case a naive drop-name skip would break.
- **Skip is table-scoped, not transaction-scoped.** A `FakeTransactionSource` commit
  whose oracle knows `users` but not `ghost`: `users`' facts record with contiguous
  opSeq starting at 0, `ghost`'s do not appear, and no error event is emitted on
  `syncEvents`.

## Explicitly NOT in this ticket

**"The drop actually takes effect on the peer."** Verified separately: the store
module emits its drop-table schema event with **no `ddl`** (`store-module.ts` ~line
829), so the migration is recorded as `ddl: ''` and `applySchemaChange`
(`store-adapter.ts` ~line 540) short-circuits blank DDL and executes nothing. A plain
`drop table` in its own transaction already fails to remove the table on a peer today,
independent of this bug. That is the in-flight ticket
`sync-schema-migrations-replicate-empty-ddl`.

So the peer-side test here must assert the drop_table **migration record reaches the
peer's wire payload** (which this fix restores), not that the peer's table disappears.
Do not add a `prereq:` on the empty-DDL ticket — the two fixes are independent and
serializing them buys nothing.

**Purging a dropped table's leftover sync bookkeeping.** The source ticket raised it as
an open question. Decision: not here. Dropping a table today leaves its `cv:`/`tb:`/`cl:`
records in the sync KV forever, and retention of a retired table's metadata is
load-bearing elsewhere (the store-and-forward relay keeps forwarding a retired table's
changes; detached basis tables are deliberately kept until the eviction horizon in
`evictExpiredBasisTables`). Changing that is a retention-semantics design call, not a
guard. The concrete defect it would prevent — a re-created table inheriting the previous
incarnation's tombstones — is filed as `bug-sync-recreated-table-inherits-dropped-table-metadata`.

## TODO

- Add `filterCapturableDataEvents` + `isPkKeyingResolvable` to `SyncManagerImpl` and
  wire them into `handleTransactionCommit` ahead of the HLC tick.
- Remove the now-unreachable `No table schema found` warn branch in
  `recordColumnVersions`; keep the `col_${i}` fallback for the no-oracle path.
- Rewrite `sync-manager.spec.ts` ~line 1926 to the skip contract.
- Add the four tests above.
- Update `docs/sync.md` (§ transaction-based change grouping / local capture) with one
  line: local capture is best-effort at table granularity — a table unresolvable at
  capture time costs only its own rows.
- Run `yarn workspace @quereus/sync run test` and `yarn build`.
