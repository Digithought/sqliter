----
description: A transaction that deletes a row and inserts a replacement whose key differs only in letter case cannot then change that column's sorting rule — the statement dies with an internal "should never happen" error, the table's sorting rule has already changed, and committing afterwards silently loses the new row.
prereq: pk-collate-judges-wrong-row-set
files:
  - packages/quereus-isolation/src/isolation-module.ts       # alterTable (~1369), validateOverlayMigration (~1931), forwardAlterColumnToOverlay (~2133), backfillStagedNotNull (~2167 — the template), createOverlaySchema (~2411), issuerOverlayDriftError (~965)
  - packages/quereus-isolation/src/overlay-rows.ts           # makePkKeySerializer
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # regression home; injectOverlay / overlayState / fullScan helpers live here
  - packages/quereus/test/logic/41.7-alter-column-collate.sqllogic
difficulty: hard
----

# The isolation overlay cannot adopt a primary-key re-key that collapses a deletion marker onto a staged row

## Reproduction

```sql
create table t (k text primary key, v text) using isolated;
insert into t values ('A', 'x');

begin;
delete from t where k = 'A';       -- the committed row is deleted
insert into t values ('a', 'y');   -- replaced by one that collides with it case-insensitively
alter table t alter column k set collate nocase;
```

Today the `alter` fails with:

```
Isolation layer: applying alter table (alterColumn) to the issuing connection's overlay for
'main.t' raised: UNIQUE constraint failed: _overlay_t_663 primary key collides under new
collation. That DDL's validation pass already judged a superset of these rows and accepted them,
so validation and migration have drifted.
```

Three things are wrong with that outcome:

1. It is an `INTERNAL` "this should never happen" error shown to a user for an ordinary
   statement sequence.
2. Its text is untrue. Validation and the forward did not drift; they correctly judged two
   *different* row sets, and this ticket is about the second one.
3. The shared table's collation has **already changed** by the time it is raised — the
   underlying storage module accepted and committed the change (DDL here is not
   transaction-scoped) before the overlay was asked to follow.

And the aftermath is worse than the error: continuing to `commit` reports success and leaves the
table **empty** — the staged row `('a','y')` is gone. Under the new `NOCASE` rule the overlay's
deletion marker for `'A'` and its live row for `'a'` are the same key, so the flush deletes what
it just inserted. Silent row loss.

A second, less obvious sequence hits the same wall — insert two case-variant rows and delete both
inside one transaction, leaving two deletion markers that collide under the new rule:

```sql
begin;
insert into t values ('A', 'x'), ('a', 'y');
delete from t where k in ('A','a');
alter table t alter column k set collate nocase;   -- same INTERNAL today
```

## How the overlay stores this

Each connection's uncommitted work for a table lives in a private staging table (the *overlay*),
one row per touched primary key, with an extra trailing flag column (`_tombstone` by default).
A staged insert/update is a live row with the flag `0`; a staged delete is a *deletion marker* —
the deleted row's primary key, `NULL` in every other column, flag `1`. Dumped directly, the
reproduction above stages exactly:

```
[["A", null, 1],      -- deletion marker for the committed row 'A'
 ["a", "y",  0]]      -- the staged replacement
```

Every copied secondary index and UNIQUE constraint on an overlay is narrowed to live rows
(`_tombstone = 0`) precisely because a marker is not a row. The overlay's **primary key** is
deliberately *not* narrowed: it must keep covering markers so that re-inserting at a deleted key
is recognised as a resurrection rather than a second row (see `createOverlaySchema`'s doc). That
is why the marker takes part in the primary-key collision check at all.

## The rule the fix encodes

> Under the re-keyed primary key, a deletion marker and a live row that land on the same key are
> the same logical row's *before* and *after* — not two rows. The live row wins and the marker is
> discarded. Two markers that land on the same key collapse to one marker.

That is sound because the pair can only ever resolve one way at flush time: the underlying holds
at most one row at the new key (the companion ticket's layer walk guarantees the committed side
holds no collision), so an upsert of the live row is the complete net effect, and a single marker
is the complete net effect of two.

It is also exactly the rule the memory module already applies one level down, when a
`TransactionLayer` replays its own write log under a re-keyed primary key: *"a deletion whose key
an upsert now occupies is dropped entirely"* (`vtab/memory/layer/transaction.ts`,
`rekeyPrimaryKey`). This ticket lifts the same rule to the isolation layer's markers.

Two live rows landing on the same key is **not** covered by this rule — that is a real duplicate
and must be refused. For the connection issuing the DDL the companion ticket refuses it before
anything is mutated; for a *foreign* connection's overlay it must become poison, matching how
every other un-adoptable constraint is handled.

## Shape of the change

`IsolationModule.alterTable` already runs a two-tier discipline that this fits into unchanged:

- **Tier 2, before `underlying.alterTable`** — dry-run every affected overlay's migration and
  throw (issuer) or poison (foreign) while the underlying, the catalog and every overlay are
  still untouched. `validateOverlayMigration` is that pass; `SetDataTypeConvertContext` is the
  precedent for a per-ALTER context object computed up front.
- **Migrate step, after `underlying.alterTable`** — apply the overlay-side work in place, so the
  overlay's layer chain and savepoint snapshots survive. `backfillStagedNotNull` is the precedent
  for doing that through ordinary overlay writes.

So:

- A new context (call it the primary-key re-key context) is derived when
  `change.type === 'alterColumn'`, `change.setCollation` is set, and the named column is part of
  the underlying's primary key. It carries the column index and a key serializer built from the
  *post-change* collation — synthesize the post-change schema by cloning the pre-alter one with
  that column's `collation` replaced, then `makePkKeySerializer` over it. (A retype of a
  primary-key column is rejected upstream, so `setCollation` is the only trigger.)
- The dry-run groups each overlay's staged rows by that new key and classifies every group:
  one live row → nothing to do; ≥2 live rows → reject/poison; 1 live + n markers → plan to drop
  the n markers; ≥2 markers, no live → plan to drop all but one.
- The migrate step replays the plan as ordinary overlay `delete` writes keyed by each marker's
  **old** primary key (the overlay is still keyed under the old collation at that moment), then
  forwards the `set collate` to the overlay exactly as `forwardAlterColumnToOverlay` does today.

This has been confirmed to work end-to-end by hand: with the marker removed first, the overlay's
own `alterSchema` accepts the re-key and leaves `[["a","y",0]]` — including when a `savepoint`
sits between the delete and the insert, so the overlay's layer chain is not an obstacle.

Ordering matters: **validate before the underlying mutates, mutate the overlay after.** Do not
drop markers in tier 2 — if the underlying then rejects, the overlay would have lost deletions it
still needs.

`issuerOverlayDriftError` stays. It should remain unreachable, and once this lands it is again
telling the truth when it fires.

## TODO

- Derive the primary-key re-key context in `alterTable`, alongside `setDataTypeCtx` /
  `setNotNullCtx`, from the PRE-alter underlying schema.
- Extend `validateOverlayMigration` with the marker-collapse dry run: group staged rows by the
  new key, plan the marker drops, and throw `CONSTRAINT` when a group holds two or more live
  rows. Keep the existing contract — the issuer's throw aborts atomically, a foreign overlay's
  becomes poison via the caller.
- Apply the planned marker drops in the migrate step, before `forwardAlterColumnToOverlay`'s
  `alterSchema` call. Model it on `backfillStagedNotNull`: materialize the rows to touch first
  (writes mutate the layer the scan reads through), then issue `overlay.update({ operation:
  'delete', values: undefined, oldKeyValues: <marker's old pk> })`, and fail loudly on a
  non-`ok` `UpdateResult` rather than ignoring it.
- Do the same for foreign overlays — a foreign connection whose staged marker/row pair collapses
  cleanly must adopt the change, not be poisoned.
- Update the doc comments that currently assert the overlay forwards `set collate` "straight
  through" (`forwardAlterColumnToOverlay`, and `alterTable`'s per-change-type list).
- Add a `NOTE:` at the grouping site recording the cost shape: it materializes one key per staged
  row for one ALTER; if an overlay with very many staged rows ever makes this ALTER slow, group
  lazily or reuse the merge `effectiveRowsFor` already builds.

### Regression coverage

- `packages/quereus-isolation/test/isolation-layer.spec.ts`:
  - delete-then-reinsert-with-colliding-case, then `set collate` → statement **succeeds**; the
    overlay holds exactly the live row; `commit` leaves the table holding `('a','y')` and not
    empty. The last assertion is the one that pins today's silent row loss.
  - same sequence with a `savepoint` between the delete and the insert, then `rollback to
    savepoint` after the ALTER → the deletion marker is back and the table reads as `'A'` deleted.
    This is the assertion that proves the in-place migration did not flatten the overlay's
    savepoint chain.
  - insert two case-variant rows and delete both, then `set collate` → succeeds; `commit` leaves
    the table empty as the transaction intended.
  - two staged **live** case-variant rows in a FOREIGN overlay while another connection issues the
    ALTER → that overlay is poisoned (`/roll back this transaction/i`), keeps both staged rows,
    and its `commit` fails. Mirrors the existing "poisons a foreign overlay whose staged rows
    violate a newly created UNIQUE index" test.
  - a foreign overlay holding a marker/live pair that collapses cleanly → adopts the change in
    place, is **not** poisoned, and `overlayState(dbB)!.overlayTable` is the same object as before
    (the in-place assertion the neighbouring ALTER tests already use).
- `packages/quereus/test/logic/41.7-alter-column-collate.sqllogic` — the delete-then-reinsert
  sequence already succeeds on the plain memory leg (no isolation), so it is a candidate for
  cross-leg coverage here. This file also runs under `yarn test:store`, where the underlying is
  the store module behind the same isolation layer; confirm the store leg actually agrees before
  adding it, and if it does not, put it in a memory-only file with a one-line reason in
  `logic.spec.ts`'s `MEMORY_ONLY_FILES` note block rather than weakening the assertion.
- `yarn test`, `yarn workspace @quereus/isolation test`, and `yarn lint` must pass. Run
  `yarn test:store` for the sqllogic addition only — it is slower, so scope it to that decision.
