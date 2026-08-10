description: A failed ALTER TABLE on a stored table used to leave the open session behaving as if it had succeeded — a rule that was never added stopped blocking bad rows, and a rule that was never removed stopped being applied. The four affected statement kinds now undo themselves cleanly.
files:
  - packages/quereus-store/src/common/store-module-index.ts          # adoptAndPersistSchema (405) — the new seam; unwindFailedSchemaDdl (426), guardedUnwindStep (467), SchemaDdlProgress (66) — renamed + widened to protected
  - packages/quereus-store/src/common/store-module-alter.ts          # the four schema-only arms now route through the seam; alterSubject (632); the row-rewriting arms carry a why-not comment; NOTE: at the dispatcher's reconcile (122)
  - packages/quereus-store/src/common/store-module-alter-column.ts   # 279 — why-not comment only, behavior unchanged
  - packages/quereus-store/test/refused-ddl-residue.ts               # NEW shared (non-spec) test module lifted out of stream-index-build.spec.ts
  - packages/quereus-store/test/alter-refused-residue.spec.ts        # NEW — the four arms, one case table
  - packages/quereus-store/test/stream-index-build.spec.ts           # now imports the shared harness; no behavior change
difficulty: medium
----

# What changed

`StoreModuleIndex` gained one seam, `adoptAndPersistSchema(table, updatedSchema, subject)`:
adopt the post-ALTER schema on the connected table, persist it to the catalog, and on a
persist failure put the previous cached schema back and rethrow. The four schema-only
`ALTER TABLE` arms — `alterAddConstraint`, `alterDropConstraint`, `alterRenameConstraint`,
`alterRenameColumn` — now persist through it instead of the bare
`table.updateSchema(...)` + `await this.saveTableDDL(...)` pair.

The undo is the existing `createIndex` / `dropIndex` unwind, renamed away from "index" now
that two DDL families share it: `IndexDdlProgress` → `SchemaDdlProgress`,
`unwindFailedIndexDdl` → `unwindFailedSchemaDdl`, both it and `guardedUnwindStep` widened
from `private` to `protected`. The seam passes `{ schemaSwapped: true, catalogWritten: false }`
and no rebuild callback, because the only step after the schema swap IS the catalog write.

`guardedUnwindStep`'s warning text changed from "…while unwinding a failed index DDL
statement" to "…while unwinding a failed DDL statement". The one spec that asserts on that
warning does not match the changed words.

Nothing else moved. The four row-rewriting arms (`alterAddColumn`, `alterDropColumn`,
`alterPrimaryKeyChange`, and the `ALTER COLUMN` arm) keep the bare pair and each carries a
short comment saying why the seam is deliberately not used there — they have already
re-encoded the data store, so restoring the old schema would make the table misread its own
rows. That is a pre-existing accepted tradeoff recorded in `alterDropColumn`; it was not
reopened.

# How to see it work

Both sequences below are from the original bug report and are now covered by
`alter-refused-residue.spec.ts`. "Refused" means the durable catalog write throws — in the
tests, an in-memory provider whose `put` is switched to throw for exactly one statement.

```
create table t (id integer primary key, email text) using store;
insert into t values (1, 'a@x.com'), (2, 'b@x.com');
alter table t add constraint uq unique (email);   -- refused
insert into t values (3, 'a@x.com');              -- accepted: no constraint exists (correct)
delete from t where id = 3;
alter table t add constraint uq unique (email);   -- now SUCCEEDS (used to be permanently refused)
insert into t values (4, 'a@x.com');              -- rejected: the retried constraint really enforces
```

```
create table t (id integer primary key, email text, constraint uq unique (email)) using store;
insert into t values (1, 'a@x.com');
alter table t drop constraint uq;                 -- refused
insert into t values (2, 'a@x.com');              -- REJECTED (used to be accepted)
```

Run just the new spec:

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/alter-refused-residue.spec.ts" --reporter spec
```

# Coverage

`stream-index-build.spec.ts`'s provider double and residue harness were lifted into
`test/refused-ddl-residue.ts` (a plain module, not a `.spec.ts`, so Mocha's glob skips it —
same precedent as `kv-store-doubles.ts`). Moved verbatim except for export keywords and a
named `TestProvider` type replacing the inline `ReturnType<typeof createProvider>`; the
existing spec passes unchanged on the imported versions (13/13).

The new spec drives all four arms from one `{ setup, sql, after }` case table, so a fifth
schema-only arm gets residue coverage by adding a row. Each case asserts residue equality
across the refused statement AND behavior afterwards.

**Anti-vacuity check, run explicitly:** with the seam's unwind call disabled, all four cases
fail, each on the harm it targets — ghost `main.t_idx_uq` store built by the next write;
duplicate accepted after a refused DROP CONSTRAINT; duplicate accepted after a refused
RENAME CONSTRAINT; `Column 'email' not found.` on the RENAME COLUMN retry. Restored and
re-verified green.

Note that residue equality alone catches NONE of these — the half-applied schema lives in
memory and the ghost `_uc_*` store appears on the next write, after the snapshot window
closes. The behavioral assertions are load-bearing.

# Known gaps — please poke at these

- **The residual post-arm window is documented, not fixed.** `alterTable` runs
  `reconcileImplicitUniqueIndexStores` after the arm returns, outside the seam. If that
  build/teardown throws, the catalog and the connected table both carry the new constraint
  set while the engine does not. There is now a `NOTE:` at that call stating so. The ticket
  scoped it out and asked the reviewer to decide whether it deserves its own ticket —
  **that decision is yours.** It is reachable (an IO error during the `_uc_*` build), so if
  you judge it a real latent defect rather than a tripwire, it is a `bug-` ticket, not a
  code comment.
- **Only one failure mode is exercised: the catalog `put` throwing.** The index specs also
  cover an encoder rejection (unencodable DDL text) reaching the same step; the ALTER specs
  do not. Worth checking whether `saveTableDDL` can fail partway on a multi-key write in a
  way that breaks the "the catalog was never written" assumption the seam relies on to skip
  the catalog restore.
- **A failing unwind on the ALTER path is untested.** `guardedUnwindStep` swallow-and-log is
  covered only through `createIndex`. Reaching it from `adoptAndPersistSchema` needs
  `table.updateSchema(originalSchema)` itself to throw during the restore — plausible only
  if validation is non-symmetric, which I did not attempt to construct.
- **The validation-rejection path is untested.** If `updateSchema(updatedSchema)` throws,
  `schemaSwapped` stays false and nothing is restored. Believed correct (nothing was
  adopted), asserted nowhere.
- **Constraint-kind coverage is partial.** Cases use UNIQUE and CHECK. FOREIGN KEY
  add/drop/rename go through the same three arms and the same seam, but have no case.
- **Not exercised under the isolation wrapper.** All cases call the store module directly;
  the `EffectiveRowSource` (`rows`) path through `alterAddConstraint` is untouched by this
  change but also unproven against it.
- One assertion hard-codes the physical store name `main.t_idx_uq` (the implicit index of a
  named UNIQUE). It will need updating if `implicitUniqueIndexName` ever changes.
- `yarn test:store` (the LevelDB-backed re-run of the engine logic tests) was NOT run — it is
  the slow suite and this change is store-package-internal. If you want belt-and-braces on
  the ALTER paths under a real provider, that is the run to do.

# Validation actually performed

- `yarn workspace @quereus/store test` — 1597 passing, 0 failing
- `yarn build` — clean
- `yarn lint` — clean
- `yarn typecheck` — clean (store package's `typecheck` covers `tsconfig.test.json`, so the
  new and moved test modules are type-checked)
- `yarn test` (whole workspace) — completed successfully, no failures
