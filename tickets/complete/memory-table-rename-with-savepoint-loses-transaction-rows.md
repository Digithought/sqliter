---
description: Renaming a table inside a transaction that also used a savepoint used to throw away every row the transaction had written; it now keeps them, and a follow-up schema change in the same transaction no longer fails with a bogus "another connection has uncommitted changes" error.
prereq:
files:
  - packages/quereus/src/vtab/memory/connection.ts                                  # tableName getter + rename()
  - packages/quereus/src/vtab/memory/layer/manager.ts                               # renameTable, rekeyRegisteredConnections, commitTransaction warning, sibling NOTE
  - packages/quereus/src/runtime/deferred-constraint-queue.ts                       # NOTE added during review (tripwire)
  - packages/quereus/test/logic/41.8.1-alter-rename-savepoint-staged-rows.sqllogic  # cases A..O from implement, P and Q added in review
  - packages/quereus/test/alter-table-events.spec.ts                                # row assertion restored
  - docs/memory-table.md                                                            # "RENAME TO adopts too" section
difficulty: medium
---

# Complete: `RENAME TO` inside a transaction adopts its schema and re-keys the connection registry

## What shipped

Two independent defects, one visible outcome each, both in the memory virtual-table module.

**Staged rows vanished at COMMIT.** Every schema-mutating arm of `MemoryTableManager` finishes by
handing its new `TableSchema` object to the open transaction's layers (`adoptSchemaOnOpenLayers`).
`renameTable` was the only arm that did not. `commitTransaction` folds a savepoint snapshot back
into the committed chain only when the snapshot's schema is the *same object* as the manager's
current one; after a rename that check failed, the fold was skipped, and `COMMIT` returned success
having published nothing. Savepoints are involved far more often than the SQL suggests — the DML
executor takes internal ones for statement- and row-level rollback — so this was reachable without
anyone writing `savepoint`.

**A second ALTER in the same transaction was refused.** The `Database` connection registry stores
each connection under a qualified `<schema>.<table>` string fixed at registration. The rename never
moved it, so every by-name lookup the renamed table's manager makes came back empty — including the
one that identifies "the connection this DDL statement is running through". A follow-up `ALTER`
then saw the transaction's own connection as a stranger holding uncommitted work and raised
`Cannot perform schema change on table t2 while another connection has uncommitted changes.`

The second defect disarms the fix for the first: the adopt walk is itself name-keyed, so adopting
after the name moves is a silent no-op. `renameTable` therefore re-keys the registry **first**
(`rekeyRegisteredConnections`), then moves `_tableName` / `tableSchema` / `baseLayer.tableSchema`,
then adopts. `MemoryVirtualTableConnection.tableName` became a getter over a private field with a
single `rename()` mutation site; `connectionId` deliberately keeps the creation-time name it embeds,
because it is the key of `Database.activeConnections`.

`commitTransaction` also now logs when it refuses a snapshot fold because the snapshot's schema
object is older than the manager's — the "some arm forgot to adopt" case that used to discard rows
silently. The ordinary read-only / no-writes commit takes the same early return and is not logged.

Coverage: `test/logic/41.8.1-alter-rename-savepoint-staged-rows.sqllogic` (cross-backend, cases
A–Q), plus the restored row assertion in `test/alter-table-events.spec.ts`. `docs/memory-table.md`
gained a "`RENAME TO` adopts too — after re-keying the connection registry" section.

## Review findings

### Verified correct

- **The `commitTransaction` control-flow change is behaviour-preserving.** Hoisting the schema
  identity comparison out of the outer `if` was needed so the "is this snapshot ahead of the head"
  walk still runs on the mismatch path. That walk is side-effect-free, and the mismatch arm leaves
  `pendingTransactionLayer` null exactly as the old condition did, so the only new behaviour is the
  log line.
- **The ordering claim holds end to end.** `adoptSchemaOnOpenLayers` → `openTransactionLayersOldestFirst`
  → `ddlConnection` → `registeredConnections` all key on `${schemaName}.${_tableName}`, so the
  re-key genuinely must precede the `_tableName` assignment. Traced each hop.
- **The other `renameTable` caller is unaffected.** The primary-key rebuild path in
  `runtime/emit/alter-table.ts` calls `shadowMgr.renameTable(tableName)` on a freshly created shadow
  manager. The re-key looks up the shadow name (no connections registered under it) and the adopt
  filters on `tableManager !== this` (the old manager's connections are excluded), so both are
  no-ops there.
- **`connectionId` collisions are not a risk.** The embedded counter is a module-global
  (`connectionCounter` in `vtab/memory/layer/connection.ts`), so a table recreated under a freed
  name cannot mint a colliding id.
- **No connection object is ever spread.** Grepped every package's `src/` for
  `{...conn}` / `Object.assign({}, …)` over a `VirtualTableConnection`; there are none, so the
  getter-vs-data-property concern raised in the handoff has no in-tree failure mode.
- **`Database.removeConnectionsForTable` matches only the fully-qualified name**, which is exactly
  what `rekeyRegisteredConnections` writes — so `DROP TABLE` after a rename now evicts the
  connection it previously leaked. Net improvement, no regression.

### Handoff gaps probed and closed

- **"The new warning log has no test."** Closed empirically instead of with a spec: ran the full
  413-file sqllogic suite with `DEBUG='quereus:vtab:memory:*warn*'`. Zero occurrences of the
  "Discarding staged rows" message — the gate does not fire on ordinary commits.
- **"Multi-schema renames are untested."** Not reachable: `ATTACH DATABASE` is not in the parser and
  `CREATE TEMP TABLE` is rejected with "TEMP/TEMPORARY is not supported", so SQL can only produce
  tables in `main`. Nothing to test.
- **"`RENAME TO` across a full `rollback` is untested."** Now case P in the sqllogic file: a full
  `ROLLBACK` after a rename + savepoint must discard every staged row. Passes on memory and store.
- **No case read the table mid-transaction.** Every original case only checked post-`COMMIT` state,
  so an adopt that published the right rows while leaving the transaction's own view wrong would
  have slipped through. Now case Q: read after `rollback to savepoint`, then write again, then
  commit. Passes on memory and store.
- **"`rekeyRegisteredConnections` relies on the bare-name fallback in `getConnectionsForTable`."**
  Reviewed: the fallback can only widen the match to an unqualified registration of the same simple
  name, and the `tableManager !== this` filter excludes every other table's connections. Correct as
  written; the qualified/unqualified duality in that lookup is pre-existing.
- **"Per-case attribution is not self-evident from a failing run."** Confirmed and accepted: the
  sqllogic runner bails at the first divergence by design. Not worth restructuring one file into
  seventeen.

### Major — new ticket filed

- **Deferred foreign-key check + rename in the same transaction fails at `COMMIT`.** Found while
  probing the connection-registry change. A `deferrable initially deferred` FK queues its check to
  commit time; if the transaction then renames a table the check reads, `COMMIT` dies with
  `Module 'memory' connect failed for table 'pp': Memory table definition for 'pp' not found.` The
  constraint is never evaluated. Confirmed **pre-existing** — reproduces identically with this
  ticket's registry re-key disabled — and reachable from plain SQL, with two minimal reproductions
  (rename the parent; rename a self-referencing table). Filed as
  `fix/deferred-foreign-key-breaks-when-table-renamed-in-same-transaction`.

### Tripwires parked

- `NOTE:` at `DeferredConstraintQueue.findConnection`
  (`packages/quereus/src/runtime/deferred-constraint-queue.ts`), added in this pass: the queue's
  name fallback keys off the name a row was *written* under, which a module that follows a rename
  (as the memory module now does) no longer matches. Inert today — both enqueue sites stamp a
  `connectionId` when one exists, and the ticket above makes the whole path fail earlier anyway.
- `NOTE:` at the multi-connection schema-drift check in
  `packages/quereus/src/vtab/memory/layer/manager.ts` (`commitTransaction`'s rebase arm), carried
  over from implement: `adoptSchemaOnOpenLayers` only walks the DDL connection's own layer chain, so
  a sibling connection's pending layer keeps its creation-time schema object and could make that arm
  raise `Commit failed: schema changed under transaction` spuriously. Unreachable while one
  `Database` runs one transaction at a time.

### Not findings, but noted

- `logger.warn` in the memory module is a `debug` sub-namespace (`…:warn`), not a console warning —
  it is off unless `DEBUG` is set. The doc's phrase "logged at warning level" reads as stronger than
  it is, but it matches the module's own house API and its sibling call site, so it was left alone.
- Source hygiene: no new long functions. `rekeyRegisteredConnections` is six lines and sits directly
  beside `registeredConnections`; `MemoryVirtualTableConnection.rename` is a two-line mutator.
  `manager.ts` remains very large (~3700 lines), which is pre-existing and already tracked by
  `backlog/debt-memory-alter-column-method-too-long`.

## Validation

- `yarn build` — clean.
- `yarn lint` (whole workspace) — exit 0, no eslint output; `packages/quereus`'s `tsc -p
  tsconfig.test.json --noEmit` pass clean.
- `yarn test` (whole workspace) — green: `packages/quereus` 7384 passing / 13 pending / 0 failing,
  every other package unchanged. Re-run after the review's own edits with the same result.
- `node test-runner.mjs --grep "41.8"` and `node test-runner.mjs --store --grep "41.8"` — all three
  files pass on both the memory module and the LevelDB store module, including the new cases P and Q.
- All review scaffolding removed: the temporary env-var gate used to prove the pre-existing
  deferred-FK failure and the throwaway `zz-probe.sqllogic` are gone; `git status` clean apart from
  the intended edits.
