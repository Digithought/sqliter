description: A failed CREATE INDEX on a disk-backed table used to leave a half-created index behind that the session kept updating and that blocked retrying the same statement; it is now a clean no-op, and a failed DROP INDEX likewise leaves the index intact and still maintained.
files:
  - packages/quereus-store/src/common/store-module-index.ts    # createIndex, dropIndex, unwindFailedIndexDdl, guardedUnwindStep — the whole change
  - packages/quereus-store/test/stream-index-build.spec.ts     # 4 new tests + snapshotResidue / expectRefusedDdlLeavesNoResidue helpers
difficulty: medium
----

# What changed

`StoreModule.createIndex` used to wrap only the index *build* in a try/catch. Everything
after it — swapping the connected table's cached schema, writing the catalog entry,
reconciling the hidden `_uc_*` stores that back plain UNIQUE constraints, emitting the
schema-change event — ran unguarded. Since the engine (`SchemaManager.createIndex`)
registers the index in its own schema only *after* the module returns and does no cleanup
on a throw, a failure in any of those later steps left residue behind.

The try/catch now spans every one of those steps. A small `IndexDdlProgress` record
(`{ schemaSwapped, catalogWritten }`) tracks how far the statement got, and the catch runs
the exact inverse, newest step first:

1. restore the connected table's cached schema, then re-run
   `reconcileImplicitUniqueIndexStores` with the *failed* schema as its `oldSchema` — the
   symmetric inverse, which rebuilds any `_uc_*` store the forward pass tore down;
2. re-write the catalog with the pre-create bundle, **only** if the statement had already
   got past `saveTableDDL` (if that call is what threw, the catalog is already correct and a
   write there would create an entry for a table that may deliberately have none yet);
3. tear down the index store — the arm that already existed, now reached on every failure
   rather than only a build failure.

Each unwind step is individually guarded (`guardedUnwindStep`) so a cleanup failure is
logged with a `console.warn` naming the index and table, and the *original* error still
reaches the caller.

`dropIndex` got the mirror treatment over its own window — cached-schema swap, catalog
write, `ddlCommitPendingOps` — sharing the same `unwindFailedIndexDdl` helper. Its window
deliberately **ends at `tearDownIndexStore`**: once the physical delete has started the
store may be partly or wholly gone, and restoring the schema would point the table at an
index that no longer exists. That boundary is stated in a comment at the site.

# Use cases to exercise when reviewing

All against a store-backed table (`using store`) on a provider that can be made to fail.

**1. `CREATE INDEX` refused by unencodable catalog text.** A partial-index predicate
carrying a lone high surrogate (`create index ix on t (v) where v <> '\uD800'`) is text the
catalog encoder refuses, so `saveTableDDL` throws deterministically with no fault injection
— after the index store is fully populated and the cached schema already lists the index.
Expect: no `main.t_idx_ix` store, catalog unchanged, a following `insert` grows no ghost
index store, and a retry as a plain `create index ix on t (v)` succeeds and persists.
The retry is the sharp end: `assertStoreNameFree` reads occupancy off the cached schema, so
a leftover ghost used to refuse the retry with a message claiming `ix` collided with itself.

**2. `CREATE INDEX` refused by an IO error in the catalog write.** Same window, reached the
general way. Covers every provider-side failure of that step, not only the one the encoder
can predict.

**3. `DROP INDEX` refused by the catalog write.** The engine deregisters the index only
after the module returns, so it keeps planning seeks against it. Expect the connected table
to still **maintain** the index — insert a row after the refused drop and the index store
must grow, and an index-driven seek must find that row. Then a clean `drop index` must still
work.

**4. `CREATE UNIQUE INDEX` refused at the `_uc_*` reconcile.** The one case that reaches the
unwind with an implicit-unique store already torn down, so it is the only one that exercises
the inverse reconcile. Driven by a provider whose `deleteIndexStore` removes the store and
*then* reports failure. Expect `_uc_email` rebuilt with its entries, `uq_email` gone, catalog
back to the pre-statement bundle, and UNIQUE still enforced (a duplicate insert still
rejected, a fresh distinct insert still tracked).

# Validation actually run

- `yarn workspace @quereus/store run test` — **1585 passing**, 0 failing (was 1581 before;
  4 new tests).
- `yarn build` — clean.
- `yarn typecheck` — clean.
- `yarn lint` — clean.
- `yarn test` (all workspaces) — clean, exit 0, 5m 06s.
- **Red-check:** each of the 4 new tests was confirmed to fail with the unwind temporarily
  disabled, then the fix restored from a scratchpad backup. Failure modes seen were exactly
  the ones claimed: leftover `main.t_idx_ix=2`, a `_uc_email` store lost and never rebuilt, a
  catalog carrying a `CREATE UNIQUE INDEX` the engine never registered, and a `DROP INDEX`
  after which the index store stopped growing (2 instead of 3).

# Known gaps — treat these as the starting point

**The `ALTER TABLE` arms have the same defect, and it is worse there. A `fix/` ticket is
filed: `alter-table-failure-leaves-half-applied-schema` (`tickets/fix/5-…`).** Phase 3 of the
source ticket asked me to check this and note it rather than widen the change, which is what
I did. What I found while checking is more severe than orphan residue, and is **verified**,
not inferred:

```
create table t (id integer primary key, email text) using store;
insert into t values (1, 'a@x.com'), (2, 'b@x.com');
alter table t add constraint uq unique (email);   -- refused (injected catalog write failure)
insert into t values (3, 'a@x.com');              -- SILENTLY ACCEPTED
```

`updateSchema` materializes the `_uc_*` index for the new UNIQUE, so DML starts enforcing by
seek against a store that the (never-reached) reconcile was going to build — an empty
structure reports no conflict. The duplicate lands, a ghost `main.t_idx_uq` appears, and the
constraint can then never be added. Four schema-only arms are unwindable the same way this
ticket's fix is; four row-rewriting arms are **not** (they re-encode rows before the catalog
write) and are already covered by an accepted-tradeoff `NOTE:` in `store-module-alter.ts`
pointing at a durable marker as the real fix. The filed ticket says all of this and asks for
one shared seam rather than four copied try/catches.

**Where the residue snapshot helper lives.** `snapshotResidue` /
`expectRefusedDdlLeavesNoResidue` are local to `stream-index-build.spec.ts`. They are the
right assertion for the whole "a refused store DDL statement leaves no residue" class and the
filed ALTER ticket asks to reuse them, which will mean lifting them to a shared test helper.
I deliberately did not lift them pre-emptively with only one consumer.

**Snapshot granularity.** The snapshot compares store keys plus *entry counts*, and the
catalog as decoded text. It would not catch a refused statement that rewrote an existing
entry's value in place without changing the count, outside the catalog. That is not a shape
any current arm has; if one appears, widen the snapshot to hash values.

**`dropIndex`'s teardown-onward window is genuinely uncovered**, by design (see above). If
`tearDownIndexStore` or the reconcile after it throws, the engine keeps the index, the
catalog no longer lists it, and the physical store may be gone. That is unchanged from before
this ticket, and fixing it needs the same durable-marker approach as the row-rewriting ALTER
arms — not a wider try/catch.

**Not touched, as scoped by the source ticket:** a `tearDownIndexStore` on a provider that
only *closes* rather than deletes still leaves an orphan store a later same-name
`CREATE INDEX` would reopen with stale entries. Tracked as
`bug-mobile-providers-delete-table-stores-only-closes`.

**Provider hooks added to the spec's fake provider** (`catalogFailure.fail`,
`failDeleteIndex`) are test scaffolding on the in-memory provider only; no production
provider interface changed.

# Review findings

- Noticed while checking Phase 3: the `ALTER TABLE` arms share this defect and, for
  `add constraint unique`, silently accept a duplicate row. Verified, and filed as
  `tickets/fix/5-alter-table-failure-leaves-half-applied-schema.md` rather than widening this
  change — see *Known gaps* above for the reasoning and the affected/unaffected arm split.
