description: On the persistent storage backend, changing which columns make up a table's primary key inside a transaction used to throw away that transaction even when the change was rejected — so a user lost unrelated work they had not committed yet. Fixed by asking the legality question before writing anything out.
files:
  - packages/quereus-store/src/common/store-module-alter.ts   # alterTable dispatcher + alterPrimaryKeyChange — the fix
  - packages/quereus-store/src/common/store-table.ts          # validateRekeyedPrimaryKey (unchanged, now called from a second call site)
  - packages/quereus-store/test/alter-primary-key-rekey-transaction.spec.ts  # new spec, 5 cases
  - packages/quereus-store/test/alter-collate-pk-rekey.spec.ts # sibling spec this one is modeled on
  - docs/store.md                                             # updated: §"DDL that implicitly commits", PK re-key bullet
difficulty: easy
----

# `alter table … alter primary key` rejects before it flushes — implemented

## What changed

`StoreModuleAlter.alterPrimaryKeyChange` (`packages/quereus-store/src/common/store-module-alter.ts`)
now calls `StoreTable.validateRekeyedPrimaryKey` — the same two throw-only probes the
sibling `ALTER COLUMN … SET COLLATE` arm already used — **before**
`this.ddlCommitPendingOps()` flushes the module's buffered transaction. Previously the
flush ran first and only `table.rekeyRows`' internal duplicate check could reject, by
which point the flush had already committed every table the store module was holding,
not just the one being altered.

Two changes, one site:

1. `alterTable`'s `alterPrimaryKey` dispatch arm now threads the caller-supplied
   `rows?: EffectiveRowSource` through to `alterPrimaryKeyChange` (it was silently
   dropped before — `addConstraint` and `alterColumn` already passed it).
2. `alterPrimaryKeyChange` calls `table.validateRekeyedPrimaryKey(updatedSchema.primaryKeyDefinition, updatedSchema.columns, effectiveDdlRows(table, rows))`
   right after `rekeySchemaPrimaryKey` builds `updatedSchema`, before the flush.
   `rekeyRows`' own pass-1 duplicate check stays in place afterward as a backstop, not
   the gate (mirrors the SET COLLATE arm).

## Behavior after the fix

- A rejected `alter table … alter primary key` leaves the store, the catalog, **and**
  the enclosing transaction untouched — a following `rollback` undoes every earlier
  uncommitted statement, on the altered table and on every sibling table the store
  module holds.
- A collision among rows the transaction can see → `CONSTRAINT`, naming the colliding
  key. The message changed from `rekeyRows`' generic
  `UNIQUE constraint failed: duplicate primary key on rekey of 'main.t'` to
  `validateRekeyedPrimaryKey`'s `UNIQUE constraint failed: t primary key collides under
  the new key definition (key: 10)` — same status code, and now identical wording to
  the memory backend's message for the same statement
  (`MemoryTableManager.assertNoPrimaryKeyCollisionInRows`), so the two backends stop
  diverging. No existing test asserted the old text.
- A collision confined to rows the transaction has *deleted* from a committed state
  (invisible to the transaction's own view, but a `rollback` must be able to restore
  them) → `BUSY` ("Commit/rollback and retry"), not a silent flush-and-rekey. This is a
  **behavior change on the bare store module**: previously such a transaction would
  silently succeed, spending the delete's rollback-ability. It now matches what the
  isolation-wrapped path and the SET COLLATE arm already did. Retry after `commit` (or
  `rollback`, redo the delete, retry) lands the change.
- A non-colliding re-key inside a transaction still succeeds and rows resolve under the
  new key immediately (point lookup, not just full scan).

## Test coverage added

New file `packages/quereus-store/test/alter-primary-key-rekey-transaction.spec.ts`,
modeled on `alter-collate-pk-rekey.spec.ts` (same `createInMemoryProvider` /
`expectRejection` helper shapes — some duplication with that file, already tracked by
`debt-store-test-shared-inmemory-provider`).

Bare `StoreModule` (4 cases):
- rejected re-key leaves an **unrelated sibling table's** uncommitted insert
  rollback-able — this is the ticket's repro shape, the one that previously ate the
  whole transaction.
- rejected re-key leaves the **altered table's own** staged insert rollback-able.
- a committed collider deleted in-transaction → `BUSY`, transaction stays alive,
  `commit` + retry lands the change.
- a non-colliding re-key inside a transaction succeeds; point lookup on the new key
  column resolves.

Isolated module via `createIsolatedStoreModule` (1 case):
- rejected re-key leaves the issuer's staged rows on a **sibling table** intact —
  pins the wrapper path (which the ticket's investigation found was never broken:
  the wrapper stages writes in per-connection overlays, so `ddlCommitPendingOps` has
  nothing of the issuer's own to commit, and `IsolationModule.alterTable` refuses the
  statement with `BUSY` up front when the issuing transaction has staged rows for the
  table being altered — that pre-existing guard is untouched by this fix).

## Validation run

From repo root:

```
yarn workspace @quereus/store run test        # 1384 passing (was 1379; +5 new)
yarn workspace @quereus/isolation run test    # 386 passing (unchanged)
yarn typecheck                                # clean
yarn test:store                               # 8747 passing / 21 pending, ~4m (unchanged counts)
```

All green, no regressions, no pre-existing failures encountered.

## Known gaps / things the reviewer should double-check

- **No test exercises `EffectiveRowSource` divergence from the store's own committed
  view for `ALTER PRIMARY KEY` specifically** — i.e. a case where the isolation
  wrapper's staged rows are what makes the legality probe (`CONSTRAINT`) fire, as
  opposed to the store's own buffered-insert case already covered. The bare-module
  tests cover buffered-insert/-delete; the isolated-module test covers only the
  sibling-table-survives shape (the ticket's primary repro). The SET COLLATE sibling
  spec (`alter-collate-pk-rekey.spec.ts`) already covers the staged-row-collides-under-
  isolation shape for the shared probe code path (`validateRekeyedPrimaryKey` is the
  exact same function, called with the same `effectiveDdlRows` helper), so this is
  low-risk duplication rather than an untested code path — but it means this ticket's
  new spec doesn't independently pin that shape for the PK arm.
- Did not add a case for `ALTER PRIMARY KEY` reverting to an implicit key (empty
  `newPkColumns`) under a transaction — out of scope per the ticket, not mentioned in
  its TODO, and the probe's behavior there is identical (same function, empty PK
  definition just means every row's key collapses to empty bytes, which the probe
  would still catch as a collision on the second row). Not exercised either before or
  after this fix.
- Did not independently re-verify the ticket's claim that `updatedSchema.columns` vs
  the old columns is a no-op for key-transform/collation resolution in the PK arm's
  probe call — took it on the ticket's analysis (both are read through the same
  `rekeyedKeyComputer` the existing `rekeyRows` call already uses) and it's consistent
  with mirroring the SET COLLATE arm's own call shape.
- Two backlog items the ticket explicitly scoped out and I did not touch:
  `bug-rolled-back-rows-violate-surviving-ddl` (pre-flush probes judging against
  visible-not-effective-post-rollback rows is an accepted property of every arm using
  this probe, not widened here) and `bug-overlay-table-name-leaks-into-rekey-error`
  (isolation overlay's own re-key message, unreachable for `ALTER PRIMARY KEY` since
  the wrapper refuses first). Neither needed changes for this ticket.

## Review findings

(none yet — first pass)
