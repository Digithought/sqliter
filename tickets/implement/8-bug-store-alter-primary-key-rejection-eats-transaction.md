description: On the persistent storage backend, changing which columns make up a table's primary key inside a transaction throws away that transaction even when the change is rejected — so the user loses unrelated work they had not committed yet. Ask the legality question before writing anything out.
files:
  - packages/quereus-store/src/common/store-module-alter.ts   # alterTable dispatcher + alterPrimaryKeyChange — the one site to change
  - packages/quereus-store/src/common/store-table.ts          # validateRekeyedPrimaryKey (the ready-made probe), rekeyRows
  - packages/quereus-store/src/common/store-module-index-build.ts  # effectiveDdlRows helper
  - packages/quereus-store/src/common/store-module-alter-column.ts # the SET COLLATE arm — the shape to copy (lines ~188-214)
  - packages/quereus-store/test/alter-collate-pk-rekey.spec.ts # the sibling spec; test template + in-memory provider
  - packages/quereus-store/test/alter-primary-key-persistence.spec.ts
  - docs/store.md                                             # §"DDL that implicitly commits" (~line 771) and the PK re-key bullet (~line 587)
difficulty: easy
repro: verified
----

# `alter table … alter primary key` must reject before it flushes

## What is wrong

`StoreModuleAlter.alterPrimaryKeyChange` (packages/quereus-store/src/common/store-module-alter.ts:451)
calls `this.ddlCommitPendingOps()` — which commits the store module's whole
buffered transaction, across every table it holds — and only *then* calls
`table.rekeyRows(newPkColumns)`, whose pass 1 is the only check that the new key is
free of duplicates. When that check fails the store is left untouched (good) but the
user's transaction is already committed and unrecoverable.

This is the last remaining arm with a post-flush-only gate. Every other rejecting arm
already probes first; the closest sibling, `ALTER COLUMN … SET COLLATE` on a
primary-key member (`store-module-alter-column.ts`, the `pkRekeyNeeded` block), was
fixed by calling `StoreTable.validateRekeyedPrimaryKey` before the flush.

## Reproduced

Verified against a bare `StoreModule` over an in-memory KV provider (a scratch mocha
spec, since deleted):

```sql
create table t (id integer primary key, code integer not null) using store;
create table other (id integer primary key, v text) using store;
insert into t values (1, 10), (2, 10);      -- both rows collide under `code`

begin;
insert into other values (1, 'uncommitted');
alter table t alter primary key (code);     -- CONSTRAINT, as it should be
rollback;
select id, v from other;                    -- BUG: still returns (1, 'uncommitted')
```

Same shape with the pending write staged on `t` itself: `begin; insert into t values
(2, 10); alter table t alter primary key (code);` rejects, and the rejected
transaction's insert survives the following `rollback`.

Under the isolation wrapper the transaction is *not* eaten (verified): the wrapper
stages writes in per-connection overlays rather than in the store module's coordinator,
so `ddlCommitPendingOps` has nothing to commit. The wrapper also refuses this statement
up front with `BUSY` when the issuing transaction has staged rows for the altered table
(`IsolationModule.alterTable`, isolation-module.ts:1450). The defect is specific to the
bare store module — which is the module a host embeds directly and is exercised by
`packages/quereus-store/test`.

## The fix

One site. In `store-module-alter.ts`:

1. The `alterPrimaryKey` dispatch arm currently drops the caller-supplied
   `rows?: EffectiveRowSource`; pass it through, as the `alterColumn` and
   `addConstraint` arms already do.
2. In `alterPrimaryKeyChange`, immediately after `rekeySchemaPrimaryKey` builds
   `updatedSchema` and **before** `ddlCommitPendingOps()`:

```ts
await table.validateRekeyedPrimaryKey(
	updatedSchema.primaryKeyDefinition,
	updatedSchema.columns,
	effectiveDdlRows(table, rows),
);
```

`effectiveDdlRows` is already imported in this file. `updatedSchema.primaryKeyDefinition`
is `rekeySchemaPrimaryKey`'s rebuild of `change.newPkColumns` and carries the same
`{index, desc}` the existing `rekeyRows(newPkColumns)` call uses, so the probe and the
re-key compute byte-identical keys (both go through `StoreTable.rekeyedKeyComputer`).
`updatedSchema.columns` differs from the old columns only in the `primaryKey`/`pkOrder`
flags, which no key-collation or key-transform resolution reads — passing either is
equivalent; pass the new ones for symmetry with the SET COLLATE arm.

This was applied as an experiment and the whole suite stayed green (see *Validation*).

### Two consequences to accept deliberately

- **The rejection message changes.** `rekeyRows` pass 1 says
  `UNIQUE constraint failed: duplicate primary key on rekey of 'main.t'`; the probe says
  `UNIQUE constraint failed: t primary key collides under the new key definition (key: 10)`.
  The status stays `CONSTRAINT`. This is an improvement, not a regression: it names the
  colliding key, and it is *exactly* the memory backend's message for the same statement
  (`MemoryTableManager.assertNoPrimaryKeyCollisionInRows`), so the two backends stop
  diverging. No test asserts the old text — `packages/quereus/test/logic/41.1-alter-pk.sqllogic`
  §3 uses a bare `-- error:` with no message match, and the store specs don't assert it.
  `rekeyRows` pass 1 stays in place as a backstop (as it already is for SET COLLATE);
  do not delete it.
- **The bare module gets stricter on one shape.** With the probe in front, a transaction
  that has *deleted* a committed row whose survivor collides under the new key now gets
  `BUSY` ("Commit/rollback and retry") instead of silently flushing the delete and
  re-keying. That is the second probe's whole purpose and matches what the SET COLLATE
  arm already does bare (see the last `describe` in `alter-collate-pk-rekey.spec.ts`).

### Not in scope

- `bug-rolled-back-rows-violate-surviving-ddl` (backlog) notes that judging DDL against
  the transaction's *visible* rows can leave a surviving DDL that rolled-back rows
  violate. That is a property of every pre-flush probe in this file, already accepted for
  the SET COLLATE arm and for the UNIQUE re-validation; this ticket does not widen it
  beyond the arm already using the same probe. Do not try to solve it here, and do not
  add it as a `prereq:`.
- `bug-overlay-table-name-leaks-into-rekey-error` (backlog) is about the *memory overlay's*
  copy of this message under the wrapper. `alter primary key` never reaches the overlay's
  re-key check (the wrapper refuses first), so nothing to do here.

## Expected behavior after the fix

- A rejected `alter table … alter primary key` leaves the store, the catalog **and** the
  enclosing transaction untouched — a following `rollback` undoes every earlier
  uncommitted statement, on the altered table and on every sibling table in the module.
- A collision among rows the transaction can see → `CONSTRAINT`, naming the key.
- A collision confined to committed rows the transaction has deleted → `BUSY`.
- An accepted re-key behaves exactly as today (still not transactional: the re-key and
  the persisted DDL are durable the moment the statement returns).

## TODO

- Thread `rows?: EffectiveRowSource` from `alterTable`'s `alterPrimaryKey` case into
  `alterPrimaryKeyChange`.
- Add the pre-flush `validateRekeyedPrimaryKey` call as shown above.
- Replace the "Physical re-key ahead" comment block's claim that `rekeyRows`' duplicate
  pass "runs against the flushed store, so a pending insert that collides under the new
  PK is caught" — it is now the backstop, not the gate. Mirror the wording the SET
  COLLATE arm uses at store-module-alter-column.ts:208-212.
- Add a spec — `packages/quereus-store/test/alter-primary-key-rekey-transaction.spec.ts`,
  modeled on `alter-collate-pk-rekey.spec.ts` (reuse its `createInMemoryProvider` and
  `expectRejection` helpers; note `debt-store-test-shared-inmemory-provider` already
  tracks the duplication, so copying is acceptable) — covering, on the **bare**
  `StoreModule`:
  - a rejected re-key leaves an unrelated sibling table's uncommitted insert rollback-able
    (the repro above);
  - a rejected re-key leaves the altered table's own staged insert rollback-able;
  - a committed collider deleted in this transaction → `BUSY`, transaction still alive,
    and `commit` + retry lands the change;
  - a non-colliding re-key inside a transaction still succeeds and keys rows under the
    new definition (point lookup on the new key column).
  And on the isolated module (`createIsolatedStoreModule`): a rejected re-key leaves the
  issuer's staged rows on a sibling table intact — pins the wrapper path against
  regression.
- Update `docs/store.md`:
  - §"DDL that implicitly commits" (~line 771): move `ALTER PRIMARY KEY`'s duplicate-key
    pass out of the "validation that runs after the commit" list into the pre-commit
    list, leaving only the `ADD COLUMN` backfill `NOT NULL` check in the post-commit
    category.
  - The PK re-key bullet (~line 587), currently written for `ALTER COLUMN … SET COLLATE`
    only: generalize it so both re-keying statements are covered by the same two-probe
    description.

## Validation

Run from the repo root, streaming output:

```
yarn workspace @quereus/store run test 2>&1 | tee /tmp/store-test.log
yarn workspace @quereus/isolation run test 2>&1 | tee /tmp/iso-test.log
yarn typecheck 2>&1 | tee /tmp/typecheck.log
yarn test:store 2>&1 | tee /tmp/test-store.log
```

With the experimental fix applied these were all green: store 1379 passing, isolation
386 passing, `test:store` 8747 passing / 21 pending (~3 min).
