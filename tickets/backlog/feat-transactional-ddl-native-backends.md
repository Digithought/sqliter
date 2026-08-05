----
description: Make schema changes (creating indexes, altering tables) roll back together with the rest of the transaction on the built-in storage backends, so a cancelled transaction leaves no schema change behind.
files:
  - packages/quereus/src/schema/                            # SchemaManager — no transaction-scoped catalog today
  - packages/quereus/src/vtab/memory/layer/manager.ts       # DDL mutates the base layer directly
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # adoptSchema — where a buffered schema would live
  - packages/quereus-store/src/common/store-module.ts       # ddlCommitPendingOps — the auto-commit posture to retire
tradeoffs: Needs a transaction-scoped catalog that SchemaManager does not have and that touches every schema consumer; the current tiers are a decided and documented contract, not an oversight.
----

# Raise the native backends to the `'transactional'` DDL tier

`feat-ddl-transaction-capability` settled the reference semantics: on a fully-cooperating
module, a schema change is buffered with the transaction — catalog entry and physical
structures — visible to later statements inside it, and discarded whole on rollback. It
also settled that neither built-in backend provides this today: memory declares
`'non-transactional'` (schema escapes rollback), store declares `'auto-commit'` (some DDL
force-commits the whole buffered transaction).

This ticket is the "answer is yes" follow-up that decision deferred: actually raise the
built-in backends (memory first; store after) to the `'transactional'` tier.

## What it takes

- **A transaction-scoped catalog.** `SchemaManager` holds one live schema; a transactional
  DDL needs the new `TableSchema` / `IndexSchema` visible only to the issuing connection
  until commit, and dropped on rollback. This is the core missing primitive and the reason
  the capability ticket stopped short.
- **Memory:** build new physical structures into the pending `TransactionLayer` instead of
  the base layer (the `adoptSchema` machinery already threads schema to pending layers and
  savepoint snapshots — the inverse direction, discarding on rollback, is what's missing).
- **Store:** buffer catalog writes through the coordinator and defer physical rewrites
  (index builds, row migrations, directory moves) to commit — or give them an undo path —
  retiring `ddlCommitPendingOps` for the affected arms.

## What it buys

- Resolves `bug-rolled-back-rows-violate-surviving-ddl` structurally (the rolled-back
  delete and the DDL it justified disappear together).
- Gives `bug-store-savepoint-ddl-drop-lost-insert` territory a coherent model (savepoint
  rollback restores the dropped index).
- Lets strict `ddl_transaction_policy` mode pass on the native backends, making it a
  usable default for applications instead of an opt-in guard.

Not scheduled — promote when a workload or the sync/migration track demands it. Large:
expect a plan-stage decomposition (catalog scoping, memory, store as separate chained
tickets).
