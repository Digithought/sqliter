----
description: Changing the sort/compare rule of a primary-key column inside an open transaction used to be accepted and then quietly ignored, letting a table end up with two rows that should have been duplicates; it now either takes effect for real or is rejected with a message the user can act on.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # validateRekeyedPrimaryKey, assertNoPrimaryKeyCollision, alterColumn, adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # rekeyPrimaryKey, reindexOwnWrites
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict (doc only)
  - packages/quereus/src/vtab/memory/index.ts                # MemoryIndex.primaryKeyComparator doc
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - docs/memory-table.md                                     # § DDL and transactions, rule 3
difficulty: hard
----

# Complete: `alter column … set collate` on a primary-key column inside an open transaction

## What the statement does now

Both original repros are fixed, and neither is silently accepted-then-ignored:

```sql
create table t (v text primary key);
begin;
insert into t values ('a');
alter table t alter column v set collate nocase;   -- accepted, genuinely in force
insert into t values ('A');                        -- CONSTRAINT: UNIQUE constraint failed
commit;
select * from t;                                   -- one row: 'a'
```

```sql
create table t (v text primary key);
begin;
insert into t values ('a');
insert into t values ('A');
alter table t alter column v set collate nocase;   -- CONSTRAINT: UNIQUE constraint failed
```

## Design

The primary tree is a *map*, not a multi-map, so — unlike a secondary index — it cannot physically
hold two rows whose keys collapse under the new comparator. Every layer in the DDL connection's
chain (the committed base, savepoint snapshots, and the immutable layer each statement boundary
leaves behind) holds rows a `rollback` or `rollback to savepoint` must be able to restore. So
`MemoryTableManager.validateRekeyedPrimaryKey` runs before any mutation and checks *every* layer,
not just the effective view:

| what collides under the new comparator | result |
| --- | --- |
| the transaction's effective rows | `CONSTRAINT` — `UNIQUE constraint failed: <table> primary key collides under new collation` |
| any layer beneath them | `BUSY` — `Cannot change the collation of a primary key column of table <t>: rows this transaction has removed still collide under the new collation and must survive a rollback. Commit/rollback and retry.` |

Once that passes, `BaseLayer.rebuildPrimaryTreeStrict` re-keys the base and
`TransactionLayer.rekeyPrimaryKey` re-keys each open layer oldest-first: `pkFunctions`, the
primary tree, the layer's own-write log, and every secondary index (each derives its
`primaryKeyComparator` / `encode` from the primary key definition). `adoptSchema` keeps its old
job; the PK path no longer routes through it.

**The known cost.** The `BUSY` arm is conservative. The chain holds one immutable layer per
statement boundary, so a transaction that held a colliding pair at *any* statement boundary is
refused — even when its final view is clean and no savepoint can reach the offending layer. This
is a false rejection, not a wrong answer: the transaction stays usable, and committing then
re-issuing the ALTER succeeds. Narrowing it would mean re-parenting the view's tree past the
unreachable layers — precisely the rebase savepoint snapshots exist to prevent. Reviewed and
accepted: the alternative trades a rare, recoverable rejection for a row silently lost on
rollback.

## Review findings

### Checked

Read the implement diff before the handoff. Traced `rekeyPrimaryKey`'s replay by hand against the
layer chain (base rebuild → oldest-first layer re-key → copy-on-write inheritance), traced
`validateRekeyedPrimaryKey`'s CONSTRAINT/BUSY split against `ensureSchemaChangeSafety`'s
guarantees, traced the `alterColumn` catch's restore, and probed the interaction between the
re-keyed layers and every *other* consumer of `TransactionLayer.ownWrites` (`adoptSchema` →
`reindexOwnWrites`, and `MemoryTableManager.commitTransaction`'s rebase). Verified the
statement-boundary claim empirically: each DML operation gets its own layer, which is why the
BUSY arm catches the sequences the handoff says it does. Read `docs/memory-table.md`
§ DDL and transactions and the doc comments on every touched symbol.

### Major — one real bug, fixed in this pass

**A `create index` later in the same transaction returned the re-keyed row twice.** The implement
diff added `reindexNetWrites` so *its own* index rebuild would drive from net effect, but left
`ownWrites` holding the raw log — which after a re-key names two keys (`'a'` deleted, `'A'`
upserted) that the new comparator has collapsed into one. Any later reader of that log hit the
exact bug `reindexNetWrites` was written to dodge:

```sql
create table t (v text primary key, w text);
insert into t values ('a','x');
begin;
update t set v='A' where v='a';
alter table t alter column v set collate nocase;
create index tw on t(w);
select v from t where w='x';   -- returned [A, A]  (before the fix)
```

Fixed at the root instead of the symptom: `rekeyPrimaryKey` now **rewrites `ownWrites` in place
to its net effect** — one entry per key, deletions first, and a deletion whose key an upsert has
re-occupied dropped entirely. With the log canonical, `reindexNetWrites` had nothing left to do
that `reindexOwnWrites` could not, so it is gone (~30 lines) and the two callers share one path
again. `reindexOwnWrites` needed one correctness fix of its own to serve both: it now drops the
parent's index entry under the *parent row's* primary key rather than under the key the write
names — after a re-key those differ, and filing the removal under the write's key left the
parent's entry in place. The commit-time rebase also replays the rewritten log; net-effect,
deletions-first is equivalent there, and the entries it drops are exactly the ones a later upsert
subsumes.

Regression test added: *"a create index later in the same transaction does not double-index a
re-keyed row"*. It fails (returns `['A','A']`) without the `ownWrites` rewrite.

### Minor — fixed in this pass

*   `docs/memory-table.md` § DDL and transactions still opened with "Two rules define what that
    means" after the diff added a third. Corrected, and the rule-3 paragraph now describes the
    own-write-log rewrite (it previously described only the replay order, which is no longer the
    whole mechanism).
*   Two test comments named `reindexNetWrites`, now removed.

### Minor — test gaps the handoff listed, now closed

*   **`desc` primary key.** `createPrimaryKeyFunctions` folds `desc` into the comparator; the
    re-key rebuilds it from the new schema. Test *"re-keys a descending primary key without
    losing its direction"* asserts both the new collation's enforcement and the surviving scan
    order. Passed unmodified.
*   **Partial index across a PK re-key.** Test *"honors a partial index predicate while re-keying
    the primary key"* moves one row out of a partial index, one row in, and inserts a third that
    never qualifies. Passed unmodified.

### Checked and found sound

*   **The `BUSY` breadth.** Reviewed the judgement call the handoff flagged. Rejecting a
    transaction whose intermediate layer held a colliding pair is the only option that does not
    either rebase past savepoint snapshots or drop a row on rollback. Accepted as designed.
*   **`validateRekeyedPrimaryKey`'s layer walk.** `ensureSchemaChangeSafety` has already drained
    committed layers into the base and rejected sibling connections with open work, so the chain
    below the view is exactly this transaction's own layers plus the base. The autocommit path
    (no connection) falls through to the base as the view, which is why
    `test/logic/41.7.1-alter-column-collate-unique.sqllogic` still sees `CONSTRAINT`.
*   **Multi-connection.** Unreachable, not untested: `ensureSchemaChangeSafety` raises `BUSY`
    before a PK re-key can see a foreign layer, and the pre-existing "other connections" test
    covers that gate.

### Tripwires (parked in code, not filed as tickets)

*   **`rekeyPrimaryKey`'s deletion replay assumes a key the layer deleted is a key its parent
    held.** That holds today because every DML operation gets its own layer, so no single layer
    both creates and destroys a key. If one ever does (a trigger, or a statement whose DML
    operations were merged into one layer), `rekeyed.find(key)` could land on a *colliding*
    parent row and delete it. `NOTE:` on `TransactionLayer.rekeyPrimaryKey` says what the
    deletion would then have to verify. Verified empirically that today's engine cannot reach
    it: `select (insert …), (delete …)` puts the two writes in different layers, and the
    intermediate one trips the `BUSY` check.
*   **`assertNoPrimaryKeyCollision` walks every row of every layer**, so validating a chain is
    O(layers × rows) — one more full pass than the base rebuild that follows. `NOTE:` at the
    method says how to narrow the walk if a deep savepoint stack over a large table ever makes
    an ALTER slow. (Carried over from the implement pass.)
*   **The `catch` in `alterColumn` cannot undo a partial layer re-key.** With both pre-passes
    running before any mutation nothing below `updateSchema` is expected to throw, so the path is
    unreachable; if `rekeyPrimaryKey` on layer *k* ever threw, layers `0..k-1` would stay
    re-keyed and the restore would not undo them. The existing comment at the catch says so.

### Out of scope, unchanged

*   **Store backend.** This is the memory manager only. `yarn test:store` was not run; the
    store's own pending-rows hole is `fix/bug-store-alter-rekey-ignores-pending-ops` and the
    isolation overlay hole is `fix/isolation-ddl-validation-ignores-overlay-rows`. Nothing here
    touches either path.
*   **`validateRekeyedUniqueStructures`'s materialized-view caveat.** It walks `schema.indexes`,
    so a UNIQUE constraint covered only by a row-time materialized view would not be re-checked.
    Guarded by the always-present auto-index; the existing `NOTE` says so.
*   **`bug-rolled-back-rows-violate-surviving-ddl`.** Both of its repros are secondary-index
    cases (their primary key is an untouched `integer`), so that ticket is untouched and still
    open. The analogous primary-key hazard is closed by construction here: the rows a rollback
    can restore are exactly the rows of some layer, and every layer was proved collision-free
    before the ALTER was allowed.

## Tests

`packages/quereus/test/ddl-in-transaction-validation.spec.ts`, describe block *"alter column …
set collate on a PRIMARY KEY column"* — 15 cases (12 from implement, 3 added in review): both
repros; enforcement for the rest of the transaction and after commit; `BUSY` for a committed
duplicate the transaction deleted, for a statement-boundary-only collision, and for a duplicate
held in an eager savepoint snapshot; `rollback` restoring the pre-transaction rows under the
surviving collation; `rollback to savepoint` with the new collation still enforced; a row moved
onto the colliding key by `update`; the double-index regression; `create index` after a re-key;
secondary-index survival across a PK re-key; a composite PK re-keyed on its second column; a
`desc` PK; a partial index across a re-key.

`yarn workspace @quereus/quereus run lint` clean. `yarn test` (whole workspace) green — quereus
6766 passing / 0 failing.
