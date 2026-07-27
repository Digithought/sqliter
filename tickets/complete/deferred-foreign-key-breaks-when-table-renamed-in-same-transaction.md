description: A postponed foreign-key check now survives a table rename that happens later in the same transaction, instead of failing the commit with an internal error or reporting a violation that isn't real.
prereq:
files:
  - packages/quereus/src/runtime/deferred-constraint-queue.ts     # notifyTableRename + per-entry rename map + bucket re-key
  - packages/quereus/src/runtime/types.ts                         # RuntimeContext.tableNameRemap
  - packages/quereus/src/runtime/emit/scan.ts                     # effectiveName before module.connect
  - packages/quereus/src/runtime/emit/alter-table.ts              # runRenameTable notifies the queue
  - packages/quereus/src/runtime/parallel-driver.ts               # fork() carries tableNameRemap
  - packages/quereus/test/runtime/fork-contract.spec.ts           # fork policy for the new field
  - packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic   # regression file (10 cases)
  - packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic  # case 11 added in review
  - docs/sql-ddl.md                                               # § RENAME TABLE
  - docs/runtime.md                                               # § fork contract — policy table
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

A per-parked-check name remap. Five pieces:

- `RuntimeContext.tableNameRemap?: ReadonlyMap<string, string>` — lowercase `<schema>.<name>` as
  written at emit time → the name that table carries now. Undefined on every ordinary execution.
- `emitSeqScan` resolves through it right before `module.connect` (and reports the *effective*
  name in the connect-failure message). Nothing else in the scan is name-bound.
- `DeferredConstraintRow.tableRenames?: Map<string, string>`, carried through `cloneAll`.
- `DeferredConstraintQueue.notifyTableRename(schemaName, oldName, newName)` — stamps every already
  queued entry (in `entries` and in every savepoint layer) and re-keys the bucket named after the
  table, merging per-constraint row lists if the destination bucket exists.
- `runRenameTable` calls it; `runDeferredRows` sets `runtimeCtx.tableNameRemap = entry.tableRenames`
  per entry.

Three details in `notifyTableRename` are load-bearing, each verified by disabling it and watching
a specific regression case fail:

- **Composition.** Any existing map *value* equal to `oldName` is rewritten to `newName`, so
  `pp → pp2 → pp3` leaves `main.pp → pp3` rather than a dangling `main.pp → pp2` (case 5).
- **No clobber.** The new key is only set when the entry does not already map it — an entry that
  already maps `<schema>.<oldName>` has had *its* table move on, and this rename is about
  whichever table holds the freed name now (case 8).
- **Schema-scoped composition** (added in review). Map *values* are bare names, so composition is
  confined to keys in the renamed table's own schema — otherwise a rename of `main.x2` follows a
  parked check that reads `s2.x2` (case 9).

`ParallelDriver.fork()` enumerates every `RuntimeContext` field explicitly, so the new field is
declared `shared-frozen` in `test/runtime/fork-contract.spec.ts` and copied in `fork()`.

## How to exercise it

`packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic` — 10 cases, both backends:

1. rename the **parent** after the check is queued, parent row supplied → commit succeeds
2. same, parent row never arrives → commit must report a **constraint** error, not an internal one
3. self-referential deferred FK + rename
4. rename only the **child** (the table the parked row belongs to)
5. two renames of the same table in one transaction
6. `rename column` on both sides, including a column the check reads
7. a freed name reused by a fresh table in the same transaction
8. …and renaming *that* reused name again
9. **cross-schema** — a rename in `main` must not follow a same-named table in `s2` *(added in review)*
10. the subquery-`CHECK` shape across a rename *(added in review; see the NOTE in the file — it
    pins user-visible behavior, it does not discriminate the remap)*

`packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic` case 11 *(added in
review)* — `drop column` landing between the deferred write and the commit, on parent and child.

Cases 1, 2, 5, 7, 8, 9 fail without the fix.

Single-file iteration:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "41.1[01]"
QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "41.1[01]"
```

## Review findings

### Checked

Re-read the whole implement diff before the handoff summary. Traced `notifyTableRename`'s
composition, no-clobber and savepoint-layer semantics by hand; checked the bucket-key format
against **both** enqueue sites (`core/derived-row-validator.ts` and `runtime/emit/constraint-check.ts`
— both pass `<schema>.<table>`, matching the key `notifyTableRename` builds); checked the
scan-leaf key derivation; checked the fork policy and `ParallelDriver.fork()`; checked where the
notify sits in `runRenameTable` relative to the failable preflights; audited every `module.connect(`
call site in `packages/quereus/src`; read `docs/sql-ddl.md` § RENAME TABLE and `docs/runtime.md`
§ fork contract against the code. Probed each gap the handoff flagged as untested. Ran `yarn lint`,
`yarn test`, `yarn test:store`.

### Fixed in this pass (minor)

- **Cross-schema composition was wrong.** The composition step matched on the map's *value*, which
  is a bare table name with no schema, so a rename in one schema dragged along a parked check
  reading a same-named table in another. Reproduced exactly (`Module 'memory' connect failed for
  table 'dr_x3'`), fixed by confining composition to keys under the renamed table's own schema
  prefix, and pinned as case 9. This is the one real defect in the diff.
- **`docs/runtime.md` fork-policy table was stale.** It claims to list every `RuntimeContext`
  field, but `tableNameRemap` was added to `fork-contract.spec.ts` without a row here. Added it,
  plus three pre-existing omissions found while checking (`mutationOrdinal`, `signal`,
  `inSetProbes`).
- **Coverage for two gaps the handoff listed as untested.** Cross-schema (case 9, above) and
  `drop column` landing mid-transaction between the deferred write and the commit — the latter as
  `41.10` case 11, on both the parent and the child side. Both pass; `41.10` case 8 only covered a
  drop *before* the transaction.
- **A handoff claim corrected.** The handoff expected the mechanism to cover a rename reached
  through a nested scan ("should cover it, but untested"). It does not need to: the only deferred
  shape that reaches a third table is a `CHECK` containing a subquery, and that shape never
  re-reads its table at commit at all — see the next section. Case 10 documents this in the file
  rather than leaving a false expectation.

### Filed as a new ticket (major)

- **`fix/bug-deferred-subquery-check-reads-stale-state`** — a `CHECK` containing a subquery is
  auto-deferred (`constraint-builder.ts`, `needsDeferred = containsSubquery(...)`) but evaluates
  against pre-transaction data. It misses a same-transaction insert that would satisfy it (false
  violation) and a same-transaction delete that would break it (false pass — commits data that
  violates its own constraint). Reproduces at HEAD with no `ALTER TABLE` anywhere, so it is
  pre-existing and independent of this diff; found only because probing this ticket's
  "nested scan" gap required that shape. Not root-caused; the ticket carries both reproductions
  and points at the suspected frozen `IN`-probe set.

### Checked, no finding

- **Other `module.connect(` sites.** `analyze.ts`, `remote-query.ts`, `schema/manager.ts`
  rehydration and `runtime/utils.ts` `getVTable` are all still name-frozen, but none is reachable
  from a deferred check's plan: the FK shape is an `EXISTS` over exactly one parent (scan leaf
  only), and the subquery-`CHECK` shape does not scan at commit at all.
- **Notify placement vs. failure.** Every way `runRenameTable` can fail *before* a side effect
  (name conflict, dependent-persistability preflight, `module.renameTable`) already ran by the
  time the queue is notified, so the queue is never stamped for a rename that did not start.
- **Resource cleanup, error handling, type safety, source hygiene.** Nothing found. No new
  lifecycle is introduced (the remap is a plain map on an existing entry), no exception is
  swallowed, no `any`, and `deferred-constraint-queue.ts` stays at ~280 lines with short
  single-purpose methods.

### Left alone deliberately

- **The bucket re-key is still not proven by a test.** The handoff flagged this; it is only
  observable through `findConnection`'s name fallback, which needs an enqueue with no
  `connectionId`. `derived-row-validator.ts` can pass `undefined`, so the path is not provably
  dead, but constructing a case would take more than it is worth against code that is correct
  either way. Left as correctness hardening.

### Tripwires parked in code

- The existing `NOTE` in `notifyTableRename` — it stamps entries below the current savepoint layer
  and `rollbackLayer` does not unstamp them, which is correct only because the built-in modules'
  `'non-transactional'` DDL tier leaves a rename applied through a rollback. Re-verified accurate;
  left in place.
- **New `NOTE` in `notifyTableRename`**: it walks every queued entry per rename and each entry
  owns its own map, so a bulk load parking a very large number of deferred rows and then renaming
  pays O(entries) per rename. Fine today; the note names the fix (one copy-on-write map shared
  across the entries queued between two renames) if it ever shows up hot.

## Validation actually run

- `yarn lint` — clean (this is the pass that type-checks test files).
- `yarn test` (whole workspace) — 0 failing; quereus 7405 passing / 13 pending, every other
  package green.
- `yarn test:store` — 7399 passing / 19 pending, 0 failing.
- Negative checks: `41.11` re-run with `notifyTableRename` disabled → fails at case 1; case 9
  reproduced its own failure before the schema-scoping fix and passes after; case 10 verified to
  pass either way (which is what led to the new `fix/` ticket).
- No pre-existing failures encountered, so `tickets/.pre-existing-error.md` was not written.

## Remaining known gaps

- **Only `RENAME TO` is remapped.** `drop column` mid-transaction is now covered and works
  (`41.10` case 11), but that is coverage, not a mechanism — nothing re-plans a parked check
  against a changed column set. Re-planning each deferred check at commit time stays the general
  answer if more shapes turn up.
- **`rollback` semantics** depend on DDL being non-transactional. See the tripwire above.
