----
description: Changing the sorting rule of a table's primary-key column inside a transaction can be refused — or fail with an internal error after the change has already been applied — because of rows the same transaction has already deleted.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # validateRekeyedPrimaryKey / assertNoPrimaryKeyCollision, and alterColumn's `rows` (EffectiveRowSource) parameter
  - packages/quereus-isolation/src/isolation-module.ts       # forwardAlterColumnToOverlay, createOverlaySchema (why the overlay's primary key covers deletion markers), issuerOverlayDriftError
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # home for the isolated-leg regression tests
  - packages/quereus/test/logic/41.7-alter-column-collate.sqllogic
difficulty: hard
----

# `set collate` on a primary-key column counts rows the transaction has deleted

## Background in one paragraph

Two rows can have distinct primary keys under one sorting rule and identical ones under another
— `'A'` and `'a'` are different keys under the default (byte-exact) rule and the same key under
the case-insensitive one. So changing a primary-key column's sorting rule has to check that no
two surviving rows collide under the new rule. Inside an open transaction, "surviving" has to
mean *what this transaction can see*: a row it has already deleted is not a row, and must not
block the change. Both of the shapes below get that wrong, in opposite directions.

The engine normally runs with a per-connection isolation layer in front of the storage module:
uncommitted inserts and deletes live in a private staging table (deletes are recorded as
*deletion markers* that carry the deleted row's primary key and nothing else), and the storage
module underneath sees only committed rows. The isolation layer already hands the storage module
a merged "rows this connection can see" stream for exactly this kind of check.

## Shape 1 — a false rejection (clean, but wrong)

```sql
create table t (k text primary key, v text);
insert into t values ('A', 'x'), ('a', 'y'), ('b', 'z');

begin;
delete from t where k in ('A', 'a');            -- both colliders are gone, as far as this transaction sees
alter table t alter column k set collate nocase; -- refused anyway
commit;
```

Refused with `UNIQUE constraint failed: t primary key collides under new collation`. The
rejection is clean — nothing has been mutated — but it should not happen at all: the only two
rows that collide under the new rule are rows this transaction has deleted.

Reproduces on **both** legs (plain memory-backed tables and isolated ones). Without the
isolation layer the same statement produces a friendlier, deliberate message ("rows this
transaction has removed still collide under the new collation and must survive a rollback.
Commit/rollback and retry"), so the conservative refusal is *known* there; what is new is that
the isolation layer already computes and passes down the correct row set and the check ignores
it.

## Shape 2 — an internal error *after* the change has landed

```sql
create table t (k text primary key, v text) using isolated;
insert into t values ('A', 'x');

begin;
delete from t where k = 'A';       -- the committed collider is deleted
insert into t values ('a', 'y');   -- ...and replaced by one that collides with it case-insensitively
alter table t alter column k set collate nocase;
```

The storage module underneath is asked first, judges the transaction's visible rows (just
`'a'`), and accepts — permanently, since this kind of schema change is not transactional and
commits immediately. The isolation layer then forwards the same change to the connection's
private staging table, which still holds a deletion marker keyed `'A'` alongside the staged row
keyed `'a'`. Under the new rule those two collide, and the statement dies with:

```
Isolation layer: applying alter table (alterColumn) to the issuing connection's overlay for
'main.t' raised: UNIQUE constraint failed: _overlay_t_663 primary key collides under new
collation. That DDL's validation pass already judged a superset of these rows and accepted them,
so validation and migration have drifted.
```

This is the worse of the two: the user sees an internal "should never happen" message, and by
the time it arrives the shared table's sorting rule has *already* changed. The wording is also
untrue — validation and the forward did not drift, they are correctly looking at two different
row sets. The staging table's primary key deliberately covers deletion markers (so that
re-inserting at a deleted key is recognised as a resurrection rather than a fresh row), which is
why a marker participates in the collision check at all.

## Expected behavior

- A collision that exists **only** among rows the transaction has deleted must not block the
  change, on either leg.
- A collision between a deletion marker and a row the same transaction has staged must not block
  it either: they are the same logical row's before and after, not two rows.
- A collision between two rows the transaction can actually see must still be refused, and
  refused **before** anything is mutated, with a message naming the colliding key.
- No path may end with the shared table's sorting rule changed and the statement reporting an
  internal error.

## Notes for whoever picks this up

- Shape 1 has a store-backend sibling already filed as `bug-store-pk-collate-rejects-deleted-row-collision`
  (the persistent backend's own re-key pass reads committed rows directly, and its refusal
  arrives mid-rewrite). Same user-visible complaint, different code; worth reading together, and
  worth checking whether one fix covers both.
- `alter-collate-pk-in-transaction` (completed) is what made this statement genuinely work
  inside a transaction, which is what makes both shapes reachable today. Its deliberate
  conservative carve-out is the friendlier message quoted in shape 1 — decide explicitly whether
  that carve-out should stay for the no-isolation case once the effective-row set is honored.
- Shape 2 is not a regression from the in-place ALTER forwarding work: the previous
  rebuild-the-staging-table approach hit the identical collision when it re-inserted the marker
  and the staged row into a freshly re-keyed table. It has simply never been covered.
- Add regression coverage for both shapes on both legs; `41.7-alter-column-collate.sqllogic`
  runs under the store backend too.
