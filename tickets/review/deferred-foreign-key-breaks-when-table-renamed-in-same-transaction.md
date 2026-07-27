description: A postponed foreign-key check now survives a table rename that happens later in the same transaction, instead of failing the commit with an internal error or reporting a violation that isn't real.
prereq:
files:
  - packages/quereus/src/runtime/deferred-constraint-queue.ts     # notifyTableRename + per-entry rename map + bucket re-key
  - packages/quereus/src/runtime/types.ts                         # RuntimeContext.tableNameRemap
  - packages/quereus/src/runtime/emit/scan.ts                     # effectiveName before module.connect
  - packages/quereus/src/runtime/emit/alter-table.ts              # runRenameTable notifies the queue
  - packages/quereus/src/runtime/parallel-driver.ts               # fork() carries tableNameRemap
  - packages/quereus/test/runtime/fork-contract.spec.ts           # fork policy for the new field
  - packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic   # new regression file (8 cases)
  - docs/sql-ddl.md                                               # § RENAME TABLE — new paragraph
difficulty: medium
----

# Deferred constraint checks follow an `ALTER TABLE ... RENAME TO`

## What was broken

A foreign key declared `deferrable initially deferred` is not checked when the row is written —
the engine parks the row on a queue and checks it at `commit`. The parked check carries a
compiled plan whose table-scan leaf remembers the table name as it was at write time. If the same
transaction then renamed one of those tables, the check read a name that no longer existed:

- memory backend — `commit` died with `Module 'memory' connect failed for table 'pp': Memory
  table definition for 'pp' not found. Cannot connect.` and never evaluated the constraint;
- store backend (LevelDB) — the connect under the vanished name *succeeded* and yielded an empty
  table, so `commit` reported a **false** `CHECK constraint failed: _fk_dr_c_pid` on a perfectly
  valid transaction.

## What was built

A per-parked-check name remap, exactly as the implement ticket specified. Five pieces:

- `RuntimeContext.tableNameRemap?: ReadonlyMap<string, string>` — lowercase `<schema>.<name>` as
  written at emit time → the name that table carries now. Undefined on every ordinary execution.
- `emitSeqScan` resolves through it right before `module.connect` (and reports the *effective*
  name in the connect-failure message). Nothing else in the scan is name-bound.
- `DeferredConstraintRow.tableRenames?: Map<string, string>`, carried through `cloneAll`.
- `DeferredConstraintQueue.notifyTableRename(schemaName, oldName, newName)` — stamps every already
  queued entry (in `entries` and in every savepoint layer) and re-keys the bucket named after the
  table, merging per-constraint row lists if the destination bucket exists.
- `runRenameTable` calls it, immediately after `renameBatchedEvents`.
- `runDeferredRows` sets `runtimeCtx.tableNameRemap = entry.tableRenames` per entry, next to the
  existing `activeConnection` assignment.

Two details in `notifyTableRename` that are load-bearing and were each verified to be so by
disabling them and watching the regression file fail:

- **Composition.** Before setting the new key, any existing map *value* equal to `oldName` is
  rewritten to `newName`, so `pp → pp2 → pp3` leaves `main.pp → pp3` rather than a dangling
  `main.pp → pp2`. Without it, case 5 fails with `connect failed for table 'dr_p8'`.
- **No clobber.** The new key is only set when the entry does not already map it. An entry that
  already maps `<schema>.<oldName>` has had *its* table move on; this rename is about whichever
  table holds the freed name now. Without the guard, case 8 fails with a false
  `CHECK constraint failed: _fk_dr_c13_pid`.

Two things not in the original ticket that the work turned up:

- `ParallelDriver.fork()` enumerates every `RuntimeContext` field explicitly, so the new field had
  to be added there or a parallelized operator inside a deferred check's plan would see
  `tableNameRemap === undefined` and connect under the stale name. Declared `shared-frozen` in
  `test/runtime/fork-contract.spec.ts` (the spec's `satisfies` clause forces a policy on every new
  field, and its "shared fields are aliased to parent" case needs a non-undefined sentinel — one
  was added).
- The `NOTE` at `deferred-constraint-queue.ts:172` (the `findConnection` name fallback) was
  rewritten: the bucket key is now the table's CURRENT name, so the note describes the mechanism
  rather than deferring the case.

## How to exercise it

`packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic` — 8 cases, runs on both
backends:

1. rename the **parent** after the check is queued, parent row supplied → commit succeeds
2. same, parent row never arrives → commit must report a **constraint** error (not an internal one)
3. self-referential deferred FK + rename (case 10 of `41-fk-cascade-conflict-and-self-ref` plus a rename)
4. rename only the **child** (the table the parked row belongs to)
5. two renames of the same table in one transaction
6. `rename column` on both sides, including a column the check reads
7. a freed name reused by a fresh table in the same transaction — the parked check must still read
   the original table, and the fresh one must keep its own rows
8. …and renaming *that* reused name again must still not drag the parked check along

Run single-file while iterating:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "41.11"
QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "41.11"
```

Cases 3–6 were already passing before the change (they are the "cover it, don't fix it" set from
the implement ticket) with one exception: **case 5 was not** — two renames need the composition
rewrite. Cases 1, 2, 5, 7, 8 all fail without the fix; verified by disabling the
`notifyTableRename` call and re-running.

## Validation actually run

- `yarn lint` — clean (this is the pass that type-checks the test files, and it is what caught the
  missing fork-contract policy).
- `yarn test` (whole workspace) — 0 failing; quereus 7405 passing / 13 pending, plus every other
  package green.
- `yarn test:store` — 7399 passing / 19 pending, 0 failing.
- Negative checks: the regression file was run with (a) `notifyTableRename` disabled, (b) the
  composition rewrite removed, (c) the no-clobber guard removed — each produced the expected
  failure, then the code was restored. No pre-existing failures were encountered, so
  `tickets/.pre-existing-error.md` was not written.

## Tripwire parked in code

`notifyTableRename` carries a `NOTE:` saying it stamps every pending entry — including entries
below the current savepoint layer — and that `rollbackLayer` does not unstamp them. That is
correct today only because a catalog rename is not rolled back either: the built-in modules declare
the `'non-transactional'` DDL tier, so `rollback to <savepoint>` and even a whole `rollback` leave
`alter table t rename to t2` applied. If `feat-transactional-ddl-native-backends` ever lands, the
remap has to become layer-scoped alongside the catalog.

## Known gaps — where to push

- **Only the scan leaf is remapped.** `emitSeqScan` was audited (in the implement ticket) as the
  only `module.connect(` site a read-only deferred check can reach; the others are `analyze.ts`,
  `remote-query.ts`, `schema/manager.ts` rehydration and `runtime/utils.ts` `getVTable` (the DML
  path). Worth a second pair of eyes: if a deferred check's plan can reach any of those — e.g. a
  CHECK expression calling a table-valued function, or a check that somehow drives DML — that path
  is still name-frozen.
- **Only RENAME TO is handled.** A column added or dropped between the write and the commit still
  leaves the parked row's arity mismatched against the live schema. `add column` on the referenced
  parent happens to work (case covered indirectly by the pre-existing behaviour the ticket
  documented) but `drop column` was never probed. The rejected alternative — re-planning each
  deferred check at commit time — is the general answer if more shapes turn up.
- **The bucket re-key may be dormant.** It only affects `findConnection`'s *name* fallback, which
  is reached only when the enqueue site had no `activeConnection` to stamp — and both enqueue sites
  stamp one whenever it exists. It is correctness hardening rather than something the regression
  file proves. If a reviewer can construct a no-connectionId enqueue, that would be worth a case.
- **Renames of a table only reachable through a *nested* scan** (a deferred CHECK whose subquery
  reads a third table that is then renamed) are not in the regression file. The mechanism should
  cover it — the remap is keyed per table, not per FK — but it is untested.
- **Cross-schema.** Every case in 41.11 lives in `main`. The keys are `<schema>.<name>` throughout,
  so an attached-schema rename should work, but `41.5-cross-schema-foreign-keys` shapes were not
  crossed with a rename.
