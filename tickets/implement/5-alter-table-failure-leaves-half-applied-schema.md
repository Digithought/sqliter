description: When an ALTER TABLE statement on a persistent table fails partway through, the statement is reported as refused but the open session keeps behaving as if it had succeeded — so a rule that was never added starts silently letting bad rows in, and a rule that was never removed stops being applied.
files:
  - packages/quereus-store/src/common/store-module-alter.ts         # alterAddConstraint (575), alterDropConstraint (613), alterRenameConstraint (654), alterRenameColumn (450) — the four schema-only arms; alterAddColumn (242), alterDropColumn (339), alterPrimaryKeyChange (510) — the row-rewriting arms to leave alone; alterTable dispatcher (57) — the reconcile call site
  - packages/quereus-store/src/common/store-module-alter-column.ts  # 279-280 — the ALTER COLUMN arm's own pair; row-rewriting, leave alone
  - packages/quereus-store/src/common/store-module-index.ts         # unwindFailedIndexDdl (387), guardedUnwindStep (415), IndexDdlProgress (64) — the existing undo to lift and share
  - packages/quereus-store/src/common/store-table-base.ts           # updateSchema (386), getSchema (366), markDdlSaved (412)
  - packages/quereus-store/test/stream-index-build.spec.ts          # createProvider (115), snapshotResidue (223), expectRefusedDdlLeavesNoResidue (240) — extract to a shared test module
  - packages/quereus-store/test/kv-store-doubles.ts                 # the precedent for a non-`.spec.ts` shared test module (Mocha's glob skips it)
repro: verified
difficulty: medium
----

# What a user sees

On a table stored on disk (`using store`), an `ALTER TABLE` can fail — the durable write of
the new table definition hits an IO error. The statement is correctly reported as refused,
but the connected table has already adopted the post-ALTER schema, so for the rest of the
session it behaves as though the statement had succeeded. Two user-visible harms, both
reproduced on current `main` with an in-memory provider whose catalog write is made to throw
for exactly one statement:

**1. A refused `add constraint unique` waves the duplicate through.**

```
create table t (id integer primary key, email text) using store;
insert into t values (1, 'a@x.com'), (2, 'b@x.com');
alter table t add constraint uq unique (email);   -- refused: injected catalog write failure
insert into t values (3, 'a@x.com');              -- ACCEPTED (observed)
alter table t add constraint uq unique (email);   -- now permanently refused: duplicate data
```

Observed after the refused statement: three rows including the duplicate, and a physical
index store `main.t_idx_uq` that the engine has no record of. The retry fails with
`UNIQUE constraint failed: t (email)` — the constraint can now never be added.

**2. A refused `drop constraint` stops enforcing a rule that is still supposed to be live.**

```
create table t (id integer primary key, email text, constraint uq unique (email)) using store;
insert into t values (1, 'a@x.com');
alter table t drop constraint uq;                 -- refused: injected catalog write failure
insert into t values (2, 'a@x.com');              -- ACCEPTED (observed). uq is still in the
                                                  -- catalog and in the engine, so this row
                                                  -- survives a reopen as an unenforceable
                                                  -- violation of a constraint that exists.
```

This second harm was found while verifying the first; it is the same defect read backwards
and it resolves at the same site.

# Root cause — one site, repeated across four arms

Every schema-only `ALTER TABLE` arm ends with the same pair:

```ts
table.updateSchema(updatedSchema);        // the connected table adopts the post-ALTER schema
await this.saveTableDDL(updatedSchema);   // ...then the catalog write, which can throw
```

`SchemaManager` registers the new schema in the engine's own catalog only *after* the module
call returns, and does no cleanup when it throws (`revertAddColumn` in
`packages/quereus/src/runtime/emit/alter-table.ts` is the only engine-side undo, and it is
scoped to `ADD COLUMN`'s inline-constraint installs). So the module owns the unwind, and
today there is none: a throw from `saveTableDDL` leaves the connected table one schema ahead
of both the engine and the catalog.

For `add constraint unique` that half-applied schema is actively harmful rather than untidy.
`StoreTableBase.updateSchema` materializes the hidden `_uc_*` index that backs a plain
UNIQUE, so DML immediately starts *enforcing by seek* against a physical store that was never
built — the build happens in `reconcileImplicitUniqueIndexStores`, which the dispatcher runs
only after the arm returns, so it never ran. An empty structure reports no conflict, so the
duplicate is waved through; the next write then lazily creates the store, leaving the ghost
`main.t_idx_uq`. For `drop constraint` the mirror holds: the swap de-materializes the `_uc_*`
that was doing the enforcing, and nothing enforces afterwards.

`createIndex` / `dropIndex` had exactly this defect and it is fixed
(`create-index-failure-leaves-orphan-index-store`); `StoreModuleIndex.unwindFailedIndexDdl`
is the working undo to share.

# Scope: four arms in, four arms out

**In — schema-only, fully unwindable:** `alterAddConstraint`, `alterDropConstraint`,
`alterRenameConstraint`, `alterRenameColumn`. None touches row data before the catalog write,
so restoring the previous cached schema is a complete undo.

**Out — row-rewriting, NOT unwindable this way:** `alterAddColumn`, `alterDropColumn`,
`alterPrimaryKeyChange`, and the `ALTER COLUMN` arm (`store-module-alter-column.ts:279`).
Each physically re-encodes the data store (`migrateRows` / `rekeyRows`) *before* the catalog
write, so putting the old schema back would leave the table reading re-encoded rows through
the old layout — strictly worse than the divergence it repairs. That window is already an
accepted tradeoff, recorded in the `NOTE:` above `rebuildSecondaryIndexes` in
`alterDropColumn`, which states the real fix is one durable marker covering the whole physical
rewrite. **Do not reopen that decision.** Leave those four arms exactly as they are and say
so in a comment, so the next reader does not read the asymmetry as an oversight.

`store-module-rename.ts` (RENAME TABLE) is a different shape and out of scope.

# The seam

One helper on the module that the four arms call instead of the bare pair — something like:

```ts
/** Adopt `updatedSchema` on the connected table and persist it; on a persist failure put
 *  the previous cached schema back, so a refused schema-only ALTER is a clean no-op. */
protected async adoptAndPersistSchema(
	table: StoreTable,
	updatedSchema: TableSchema,
	subject: string,   // e.g. `table 'main.t'` — for the guarded-unwind warning
): Promise<void>
```

Ordering stays swap-then-persist, deliberately: `updateSchema` validates (key collations,
semantic key transforms) before adopting anything, so a schema the table cannot carry is
rejected with nothing persisted. Persist-first would invert that and leave the catalog ahead.

The undo the helper needs is a strict subset of `unwindFailedIndexDdl`: only the cached-schema
restore fires, because the only step after the swap *is* the catalog write, so a throw means
the catalog was never written and re-writing the old bundle would create a catalog entry for a
table that may deliberately have none yet (the lazy first-access persist). Reuse
`unwindFailedIndexDdl` rather than re-deriving it — it already documents that reasoning — with
`{ schemaSwapped: true, catalogWritten: false }` and no rebuild callback. It and
`guardedUnwindStep` are `private` in `StoreModuleIndex` today; widen to `protected` and rename
away from "index" (`unwindFailedSchemaDdl` / `SchemaDdlProgress`) now that both DDL families
share them. `StoreModuleAlter` extends `StoreModuleAlterColumn` extends `StoreModuleIndex`, so
the helper is in scope for every arm wherever in that chain it lands.

Capture the original inside the helper (`table.getSchema()`), not from the caller's
`oldSchema` — same object today, but it keeps the helper's contract self-contained.

`alterRenameColumn` keeps its existing `try`/`catch`, which reverses the in-place AST rewrites
that a schema restore cannot undo (the `Expression` nodes are shared by reference). The two
nest correctly: the helper restores the cached schema, rethrows, and the arm's catch then
reverses the ASTs the restored schema shares.

# Known residual window — comment it, do not fix it here

The dispatcher runs `reconcileImplicitUniqueIndexStores` *after* the arm returns, and that
call is outside the seam. If the `_uc_*` build throws (IO error) the catalog and the connected
table both already carry the new constraint while the engine — which registers only after
`alterTable` returns — does not. Unwinding that would mean restoring the schema, re-writing the
catalog, and running the reconcile's inverse over a reconcile that may have half-completed.
Out of scope. Leave a `NOTE:` at the dispatcher's reconcile call stating the window plainly,
and flag it in the review handoff so the reviewer can decide whether it deserves its own
ticket. (`reconcileImplicitUniqueIndexStores` already carries a related `NOTE:` tolerating a
partial `_uc_*` build.)

# Coverage

The class is "a refused store DDL statement leaves no residue" and it already has a working
assertion in `stream-index-build.spec.ts`: `snapshotResidue` records every provider store with
its entry count plus the catalog's decoded DDL text; `expectRefusedDdlLeavesNoResidue`
snapshots, runs a statement expected to throw, and asserts the snapshot is byte-identical.
Lift those two plus `createProvider` (whose `catalogFailure.fail` switch is what injects the
IO error) into a shared non-`.spec.ts` test module — `kv-store-doubles.ts` is the precedent —
and have both the existing spec and a new one import them.

Residue equality alone would NOT have caught either harm above, so each needs a behavioral
assertion after the refused statement:

- refused `add constraint unique` → a duplicate insert is **accepted** (the constraint was
  never added), and a retry of the same `add constraint unique` **succeeds**;
- refused `drop constraint uq` → a duplicate insert is still **rejected** (the constraint is
  still live and still enforced);
- refused `rename constraint uq to uq2` → `drop constraint uq` (the OLD name) still resolves;
- refused `rename column email to mail` → `select email from t` still works, and a retry of
  the rename succeeds.

Drive them from one table of `{ sql, after }` cases so a fifth schema-only arm added later
gets residue coverage for free.

# TODO

Phase 1 — the seam

- Rename `IndexDdlProgress` → `SchemaDdlProgress` and `unwindFailedIndexDdl` →
  `unwindFailedSchemaDdl` in `store-module-index.ts`; widen it and `guardedUnwindStep` to
  `protected`; update their doc comments to cover both DDL families (they currently say
  "index DDL statement", including the warning text in `guardedUnwindStep`).
- Add the `adoptAndPersistSchema` helper described above, reusing `unwindFailedSchemaDdl`.
- Route `alterAddConstraint`, `alterDropConstraint`, `alterRenameConstraint` and
  `alterRenameColumn` through it; delete their bare `updateSchema` + `saveTableDDL` pairs.
- Leave `alterAddColumn`, `alterDropColumn`, `alterPrimaryKeyChange` and the `ALTER COLUMN`
  arm on the bare pair, and add one comment at each group boundary saying why the seam is
  deliberately not used there (row data already re-encoded; see the existing accepted-tradeoff
  `NOTE:` in `alterDropColumn`).
- Add the `NOTE:` at the dispatcher's `reconcileImplicitUniqueIndexStores` call describing the
  residual post-arm window.

Phase 2 — coverage

- Extract `createProvider`, `snapshotResidue` and `expectRefusedDdlLeavesNoResidue` from
  `stream-index-build.spec.ts` into a shared test module (e.g.
  `packages/quereus-store/test/refused-ddl-residue.ts`); keep the existing spec green on the
  imported versions with no behavior change.
- New spec (e.g. `alter-refused-residue.spec.ts`) driving the four schema-only arms from one
  case table: residue equality for each, plus the four behavioral assertions listed above.
- Confirm the two repro sequences in "What a user sees" now behave correctly.

Phase 3 — validate

- `yarn workspace @quereus/store test`
- `yarn build && yarn lint && yarn typecheck` (the store package's `typecheck` covers
  `tsconfig.test.json`, so the new/moved test module is type-checked there)
- `yarn test` for the whole workspace
