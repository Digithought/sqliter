description: When an ALTER TABLE statement on a persistent table fails partway through, the statement is reported as refused but the open session keeps behaving as if it had succeeded — and in the case of adding a UNIQUE rule, the session then silently accepts duplicate rows that the rule was supposed to reject.
files:
  - packages/quereus-store/src/common/store-module-alter.ts         # alterAddConstraint (~575), alterDropConstraint (~613), alterRenameConstraint (~654), alterRenameColumn (~446-455) — the schema-only arms
  - packages/quereus-store/src/common/store-module-alter-column.ts  # ~280 — the ALTER COLUMN arm's own updateSchema/saveTableDDL pair
  - packages/quereus-store/src/common/store-module-index.ts         # createIndex / dropIndex + unwindFailedIndexDdl — the same problem, already solved, and the shape to generalize
  - packages/quereus-store/src/common/store-table-base.ts           # updateSchema (386), markDdlSaved (412) — the cached-schema swap
  - packages/quereus-store/test/stream-index-build.spec.ts          # snapshotResidue / expectRefusedDdlLeavesNoResidue — the residue assertion to generalize
repro: verified
difficulty: medium
----

# What a user sees

On a table stored on disk (`using store`), adding a UNIQUE rule can fail — the durable
write of the new table definition hits an IO error. The statement is correctly reported as
refused. But for the rest of that session the table behaves as though the rule had been
added, *without* the structure that actually enforces it. The next duplicate row is
**silently accepted**. The rule can then never be added at all, because the table now
contains exactly the duplicate it was meant to prevent.

Verified on current `main` with an in-memory provider whose catalog write is made to throw
for one statement:

```
create table t (id integer primary key, email text) using store;
insert into t values (1, 'a@x.com'), (2, 'b@x.com');
alter table t add constraint uq unique (email);   -- refused: injected catalog write failure
insert into t values (3, 'a@x.com');              -- ACCEPTED. Should have been rejected or
                                                  -- (better) never been subject to the rule at all
alter table t add constraint uq unique (email);   -- now permanently refused: duplicate data
```

Observed after the refused statement: the table holds three rows including the duplicate,
and a physical index store `main.t_idx_uq` appears that the database engine has no record
of.

# Root cause — one site, repeated across arms

Each `ALTER TABLE` arm in `StoreModuleAlter` ends with the same two lines:

```ts
table.updateSchema(updatedSchema);   // the connected table adopts the post-ALTER schema
await this.saveTableDDL(updatedSchema);   // ...then the catalog write, which can throw
```

The engine (`SchemaManager`) registers the new schema in its own catalog only *after* the
module call returns, and does no cleanup when it throws. So the module owns the unwind, and
today there is none: a throw from `saveTableDDL` leaves the connected table one schema ahead
of both the engine and the catalog.

For `add constraint unique` that half-applied schema is actively harmful rather than merely
untidy. `StoreTableBase.updateSchema` materializes the hidden `_uc_*` index that backs a
plain UNIQUE, so DML immediately starts *enforcing by seek* against a physical store that
was never built — the build happens in `reconcileImplicitUniqueIndexStores`, which runs
after the arm returns and therefore never ran. An empty structure reports no conflict, so
the duplicate is waved through; the very next write then lazily creates the store, leaving
the ghost `main.t_idx_uq` behind.

`createIndex` / `dropIndex` had exactly this defect and it is now fixed
(`create-index-failure-leaves-orphan-index-store`), with a working unwind
(`StoreModuleIndex.unwindFailedIndexDdl`) that these arms should share.

# Which arms are affected, and which cannot be fixed this way

**Schema-only arms — unwindable, same shape as the index fix:**
`alterAddConstraint`, `alterDropConstraint`, `alterRenameConstraint`, `alterRenameColumn`
(which already has a `try`/`catch` reversing its expression rewrites, but does not restore
the cached schema). These touch no row data before the catalog write, so restoring the
previous cached schema is a complete undo.

**Row-rewriting arms — NOT unwindable this way:** `alterAddColumn`, `alterDropColumn`,
`alterPrimaryKeyChange`, and the `ALTER COLUMN` arm. Each physically re-encodes the data
store (`migrateRows` / `rekeyRows`) *before* the catalog write, so putting the old schema
back would leave the table reading re-encoded rows through the old layout — strictly worse
than the divergence it repaired. That window is already documented as an accepted tradeoff
at `store-module-alter.ts` (the `NOTE:` block above `rebuildSecondaryIndexes` in
`alterDropColumn`), which states the real fix is one durable marker covering the whole
physical rewrite. **This ticket does not reopen that decision** — it should leave those arms
alone, and say so in a comment so the next reader does not think they were missed.

# Expected behavior

A refused schema-only `ALTER TABLE` on a store table is a clean no-op: the connected table's
cached schema unchanged, the catalog entry unchanged, no physical index store created or
destroyed, no constraint half-enforced, and a retry of the same statement free to succeed.

Above all: **a refused `add constraint unique` must never cause a duplicate to be accepted.**
That is the user-visible harm and the acceptance test.

# Preferred shape — a seam, not four patches

The four schema-only arms all want the identical thing, so the fix should be one seam every
arm goes through rather than a `try`/`catch` copied four times. Something like a shared
"adopt this schema and persist it, putting the old one back if the persist fails" helper on
the module, with the arms calling it instead of the bare `updateSchema` + `saveTableDDL`
pair. `StoreModuleIndex.unwindFailedIndexDdl` is the existing, tested implementation of that
undo and should be reused or lifted, not re-derived.

That seam also gives the row-rewriting arms an obvious place to *not* call, making the
distinction between the two groups visible in the code rather than only in prose.

# Coverage

The class is "a refused store DDL statement leaves no residue", and it already has a working
assertion: `snapshotResidue` / `expectRefusedDdlLeavesNoResidue` in
`packages/quereus-store/test/stream-index-build.spec.ts` snapshot every provider store (keys
plus entry counts, and the catalog text) before a statement expected to throw, then assert
the snapshot is byte-identical afterwards. Reuse it — lifted to a shared test helper — driven
over each schema-only ALTER arm, so a fifth arm added later is covered without new
hand-written checks.

The UNIQUE case needs one assertion beyond residue equality, because residue alone would not
have caught the silent-acceptance harm: after the refused `add constraint unique`, inserting
a duplicate must be **accepted** (the constraint was never added) *and* a later retry of the
same `add constraint unique` must succeed.
