----
description: On the persistent (LevelDB) store backend, if you drop an index inside a savepoint and then roll that savepoint back, the very next INSERT reports success but the row silently disappears — no error, no data.
files:
  - packages/quereus/test/logic/10.1.3.1-ddl-drop-savepoint-memory.sqllogic   # memory analogue of the sequence (memory behaves differently)
  - packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic       # cross-backend drop-in-tx enforcement (this passes on store)
  - packages/quereus-store/                                                    # store module
  - packages/quereus-isolation/                                               # isolation layer (savepoints, read-your-own-writes, rollback)
difficulty: medium
----

# Store backend: INSERT silently lost after `rollback to savepoint` that dropped an index

## What happens

On the persistent store backend (LevelDB via the isolation layer), this exact sequence loses data
with no error:

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');
savepoint s;
drop index ix;
rollback to savepoint s;
insert into t values (2, 'a');   -- returns SUCCESS, no error raised
select id, v from t order by id; -- returns ONLY {1,'a'} — row (2,'a') is absent
commit;
select id, v from t order by id; -- still only 1 row
```

The second `insert` returns success (it does **not** raise `UNIQUE constraint failed`, and it does
**not** raise any other error), yet the row is never persisted — it is absent both mid-transaction
(before `commit`) and after. A statement that reports success must either insert the row or raise;
silently doing neither is data loss.

This is store-specific. The same sequence on the memory backend accepts the insert and keeps the
row (see `10.1.3.1-ddl-drop-savepoint-memory.sqllogic` — memory does not undo the DROP on rollback,
so no constraint remains and the duplicate is kept). Only store loses the write.

## How it was found

Reviewing `bug-drop-index-in-transaction-still-enforced` (a memory-backend fix for DROP INDEX /
DROP CONSTRAINT enforcement inside a transaction). The cross-backend enforcement cases (drop index
/ drop constraint mid-transaction, and the sibling-index guard) all pass on store —
`10.1.3-ddl-drop-in-transaction.sqllogic` is green under `QUEREUS_TEST_STORE=true`. Only the
savepoint-rollback variant diverges, which is why that case was pinned in a memory-only file rather
than asserted cross-backend.

## Reproduce

Add a temporary `.sqllogic` with the sequence above (assert 2 rows) and run:

```
cd packages/quereus && node test-runner.mjs --store --grep "<your-temp-file>"
```

Observed: `Row count mismatch. Expected 2, got 1`. Asserting `-- error: UNIQUE constraint failed` on
the second insert instead fails with `Expected error … but SQL block executed successfully` — i.e.
the insert neither errors nor lands.

## Expected behavior (semantics now decided)

The transactional-DDL question this fix was waiting on is settled:
`feat-ddl-transaction-capability` placed the store on the `'auto-commit'` tier — DDL is not
part of the transaction, and `rollback to savepoint` does **not** restore a dropped index.
(Restoring it is the future `feat-transactional-ddl-native-backends` tier, not this bug.)

So the correct outcome for the reproduction is memory's posture: the index stays dropped, the
second `insert` succeeds, and row (2,'a') is present both mid-transaction and after `commit`.
The current "success + silent drop" is data loss and is the defect to fix. Likely suspect: the
isolation layer / store savepoint machinery holding a stale reference to the dropped index's
overlay or unique-enforcement state after the savepoint rollback, so the write lands in a
structure that no longer feeds reads or persistence.

This is now unblocked and promotable to `fix/` whenever prioritized — nothing further to
decide first.

## Scope note

Requires the specific combination savepoint + DDL (`drop index`) + `rollback to savepoint` +
subsequent write. Plain `drop index` inside a transaction (no savepoint) works correctly on store,
as does a savepoint rollback with no intervening DDL. The narrowness is why it escaped earlier
coverage, not evidence it is harmless — silent lost writes are severe wherever they occur.
