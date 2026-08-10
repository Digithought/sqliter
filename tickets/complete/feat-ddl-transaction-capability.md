description: Schema changes used to silently escape the surrounding transaction. Storage backends now declare how their DDL behaves in a transaction, and an opt-in strict mode refuses in-transaction schema changes on backends that can't roll them back.
files:
  - packages/quereus/src/vtab/capabilities.ts
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/runtime/emit/{create,drop}-index.ts
  - packages/quereus/src/runtime/emit/{create,drop}-table.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/runtime/emit/add-constraint.ts
  - packages/quereus/src/runtime/emit/materialized-view.ts        # NOTE only (MV gate deferred)
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus/test/capabilities.spec.ts
  - packages/quereus-store/test/isolated-store.spec.ts
  - packages/quereus/test/logic/10.1.4-ddl-transaction-policy.sqllogic
  - docs/{module-authoring,memory-table,store,architecture}.md
----

# Completed: DDL transaction capability — declared tiers + strict gate

## What shipped

Storage modules declare how their DDL behaves inside a transaction via
`ModuleCapabilities.ddlTransactionality` (`DdlTransactionality`: `transactional` /
`non-transactional` / `auto-commit`; default `non-transactional`). A new
`ddl_transaction_policy` option/pragma (`permissive` default, `strict` opt-in) gates
enforcement: under `strict`, a module-dispatching DDL statement issued while an
**explicit** transaction is open, on a module whose tier is not `transactional`, is
refused with a sited `QuereusError` before any dispatch or catalog mutation — the
transaction and its savepoints stay open and usable.

Enforcement is one shared helper (`assertDdlTransactionPolicy`) called at the top of
each module-dispatching DDL emitter. Memory declares `non-transactional`, store declares
`auto-commit` (worst-case), isolation forwards the underlying tier verbatim.

## Review findings

Adversarial pass over commit `3cd3bd4c`. Aspects checked and outcomes:

- **Load-bearing predicate (`isExplicitTransactionOpen` = `!getAutocommit() &&
  !_isImplicitTransaction()`) — CHECKED, sound, no defect.** Traced the transaction
  manager: `beginTransaction('implicit')` sets `isAutocommit=false`, so during any
  transaction autocommit is false; `transactionSource` becomes `'explicit'` **only** via
  an explicit `BEGIN` or an explicit `SAVEPOINT` statement (`runtime/emit/transaction.ts`
  → `_upgradeToExplicitTransaction`). The internal batch/apply-schema savepoint
  broadcasts (`_createSavepointBroadcast` etc.) do **not** upgrade, so autocommit nested
  DDL keeps `transactionSource='implicit'` and is correctly *not* gated — resolving the
  handoff's gap #3 by construction. The one non-BEGIN gating case (a bare `SAVEPOINT` in
  autocommit) is correct behavior: that statement deliberately takes explicit transaction
  control ("savepoints mean the user wants transaction control, so we shouldn't
  auto-commit").

- **Gate placement — CHECKED, correct.** Runs before `_ensureTransaction()` and any
  mutation; refusal leaves the transaction/savepoints open. Verified by both the unit test
  (`getAutocommit()` still false after throw) and the sqllogic (insert-again-then-commit,
  rollback-to-savepoint-then-commit).

- **`drop-index` wasted schema scan on the default path — MINOR, FIXED INLINE.** The
  owner-resolution scan (`Array.from(schema.getAllTables())`) ran on **every** DROP INDEX,
  including under the default `permissive` policy where the result is discarded. Guarded it
  behind a new cheap `isDdlPolicyStrict(db)` check (also DRY'd into
  `assertDdlTransactionPolicy`, replacing its inline string compare). Behavior identical;
  the permissive path now pays nothing. `drop-index.ts` + `ddl-transaction-policy.ts`.

- **Materialized-view verbs not gated — MAJOR, already filed (accepted).** `create/drop/
  refresh materialized view` create/drop a backing module table that escapes rollback like
  `CREATE TABLE`, but are separate emitters left out of scope. A greppable `NOTE:` sits at
  `emitCreateMaterializedView` and `backlog/debt-strict-ddl-gate-materialized-views.md`
  tracks it. Disposition confirmed: it is a genuine coverage hole, correctly deferred to
  the debt ticket rather than expanded into this pass.

- **ALTER gate covers catalog-only arms (SET/DROP TAGS, SET/DROP MAINTAINED,
  schema-only rename) — CHECKED, intentional, no change.** Those still mutate the transient
  engine catalog, which is not transaction-scoped, so the change escapes rollback and
  strict should refuse it. Broader than the literal "module-dispatching" phrasing but
  correct; documented at the call site.

- **Module declarations + isolation forwarding — CHECKED, correct, tested.** Memory
  `non-transactional`, store `auto-commit`, isolation forwards underlying verbatim (never
  upgrades). Covered by `capabilities.spec.ts` and `isolated-store.spec.ts`.

- **`resolveDdlTransactionality` robustness — CHECKED, no action.** Would throw if
  `getCapabilities()` returned `undefined`, but the interface types it non-null; the
  optional chain already handles a missing method. No defect under the contract.

- **Docs — CHECKED, accurate.** `module-authoring.md` (tier definitions + capability
  tables), `memory-table.md`, `store.md`, `architecture.md` all read correctly against the
  code as shipped; the live-gate count (now three) is consistent across every table.

- **Tripwires — none new.** The `drop-index` duplicate of `SchemaManager.dropIndex`'s
  owner scan (handoff gap #4) now runs only under strict; the existing site comment plus
  this note are sufficient — not worth a shared helper yet.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus run test` — 6977 passing, 13 pending.
- `yarn workspace @quereus/store run test` — 959 passing.
- `node test-runner.mjs --store --grep "ddl-transaction-policy"` — 1 passing (10.1.4
  sqllogic against the isolation-wrapped LevelDB store; strict refuses there too).

## Follow-ups (already on the board, not part of this ticket)

- `backlog/debt-strict-ddl-gate-materialized-views.md` — extend the gate to MV verbs.
- `backlog/feat-transactional-ddl-native-backends.md` — raise a backend to `transactional`.
