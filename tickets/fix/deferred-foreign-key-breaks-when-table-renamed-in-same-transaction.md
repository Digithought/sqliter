---
description: If a transaction defers a foreign-key check and then renames one of the tables involved, the COMMIT fails with a confusing internal error instead of checking the constraint.
prereq:
files:
  - packages/quereus/src/runtime/deferred-constraint-queue.ts        # the queue: buckets keyed by table name, evaluators frozen at row time
  - packages/quereus/src/runtime/emit/constraint-check.ts            # enqueue site (row-time defer decision)
  - packages/quereus/src/core/derived-row-validator.ts               # second enqueue site
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runRenameTable — catalog + module rename, no deferred-queue fixup
  - packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic  # existing deferred-FK coverage to extend
difficulty: medium
---

# Deferred foreign-key check + `ALTER TABLE ... RENAME TO` in one transaction fails at COMMIT

## What happens

A foreign key declared `deferrable initially deferred` is not checked when the row is written —
it is queued and checked at `COMMIT`. If the same transaction also renames one of the tables the
check reads, `COMMIT` fails with an error that reads like an engine fault rather than a
constraint problem:

```
Error: Module 'memory' connect failed for table 'pp':
       Memory table definition for 'pp' not found. Cannot connect.
```

The constraint is never evaluated — it neither passes nor reports a violation — and the whole
transaction is lost.

## Reproductions

Both are minimal and fail on the memory module today. Verified pre-existing: the failure is
unchanged with the `memory-table-rename-with-savepoint-loses-transaction-rows` connection-registry
re-key disabled, so it is not caused by that change.

**Renaming the parent table:**

```sql
create table pp (id integer primary key);
create table cc (id integer primary key,
    pid integer null references pp(id) deferrable initially deferred);

begin;
insert into cc values (10, 1);      -- queues the deferred FK check against `pp`
alter table pp rename to pp2;
insert into pp2 values (1);         -- the parent row the check needs
commit;                             -- FAILS: "Memory table definition for 'pp' not found"
```

Expected: `COMMIT` succeeds — at commit time the parent row exists, so the FK is satisfied.

**Renaming a self-referencing table** (the classic forward-reference shape, adapted from the
existing `41-fk-cascade-conflict-and-self-ref.sqllogic` case 8):

```sql
create table sd (id integer primary key,
    pid integer null references sd(id) deferrable initially deferred);

begin;
insert into sd values (2, 1);       -- forward reference: parent row not there yet
alter table sd rename to sd2;
insert into sd2 values (1, null);
commit;                             -- FAILS: "Memory table definition for 'sd' not found"
```

Expected: `COMMIT` succeeds (this is exactly the existing passing case plus a rename).

A **non**-self-referencing FK where only the *child* is renamed does pass, so the trigger is
specifically that the renamed table is the one the queued check *reads*.

## Why it happens (starting point, not a diagnosis)

The deferred-constraint queue stores each pending row under the table name that was current when
the row was written, together with an evaluator closure compiled against that name. Nothing
re-points either when a rename lands later in the same transaction: at commit the evaluator asks
the module for a table that no longer exists under that name.

Two things are name-bound and both may need attention:

- the queue's bucket key (`DeferredConstraintQueue.enqueue` lowercases `baseTable`), which is also
  what `findConnection` name-matches on when no `connectionId` was recorded;
- the queued evaluator's own plan, which resolves the *referenced* table by name.

The bucket key alone is not the whole story — the parent-rename reproduction above fails on the
referenced side, which the bucket key does not cover.

## Expected behavior

A rename inside a transaction must not change whether a deferred constraint is evaluated or what
it decides. After the rename, the queued check should read the same table under its new name and
report a genuine `CONSTRAINT` violation, or pass, exactly as it would have without the rename.

## Scope notes

- Both reproductions above should land as regression coverage — a cross-backend
  `test/logic/*.sqllogic` file is the natural home, next to the existing deferred-FK cases.
- Worth checking the same shape for `ALTER TABLE ... RENAME COLUMN` on a column a deferred check
  reads, and for the store module (`yarn test:store`) as well as memory.
