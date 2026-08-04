---
description: Column and constraint changes — adding, dropping or renaming a column, adding or dropping a constraint, changing the primary key — now reach other synced devices, apply idempotently there, and cannot leak phantom changes back onto the wire.
files:
  - packages/quereus-store/src/common/events.ts                    # beginRemoteSchemaScope / endRemoteSchemaScope (replaces expect/clear)
  - packages/quereus-sync/src/sync/store-adapter.ts                # decideAlterTable + decision table; applySchemaChange now scope-based; schemaEventSignature deleted
  - packages/quereus/src/index.ts                                  # + exports: expressionToString, namedConstraintExists
  - packages/quereus-store/test/events.spec.ts                     # rewritten for the scope API
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts   # NEW — end-to-end two-peer coverage
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # + synthetic alter_column decision-table coverage
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts    # + synthetic drives for the two kept warnings
  - docs/sync-schema.md                                            # § What replicates, § Idempotent DDL application rewritten
---

# Review: replicate table alterations

Implements ticket `sync-replicate-alter-table-ddl` (prereq
`sync-alter-table-event-carries-ddl` had already landed, so ALTER events carried DDL and
basic replication of alterations worked; this ticket added the two hardening layers).
`RENAME TO` remains excluded — `sync-replicate-rename-table` (in implement/) owns it.

## What changed

**A. Scoped remote-event marking** (`packages/quereus-store/src/common/events.ts`).
`StoreEventEmitter`'s one-for-one remote-event expectation registry
(`expectRemoteSchemaEvent` / `clearExpectedRemoteSchemaEvent`, matched on
type+objectType+schema+object, consumed one event per marker, never expired) is replaced
by refcounted scopes keyed on `(schema, object)` only:
`beginRemoteSchemaScope(schema, object)` / `endRemoteSchemaScope(...)`. While a scope is
open, EVERY schema event naming that object is marked remote; matching never decrements;
the caller's `finally` releases. So zero-event and multi-event statements both behave —
the two failure classes the old registry produced (leaked phantom local change / stranded
marker swallowing the next genuine local DDL). The concurrency tradeoff (a host issuing
local DDL on the very table being replicated at that instant is mis-marked remote) is in
the method's doc comment. `applySchemaChange` (store-adapter.ts) wraps `db.exec` in
begin/`finally`-end; `schemaEventSignature` and its inverse-of-`mapSchemaMigrationType`
coupling are deleted.

**B. `alter_column` idempotency arm** (`decideAlterTable` in store-adapter.ts).
The migration carries only text, so the arm parses it with the engine `Parser` and
decides against the local `TableSchema` per the ticket's decision table (now also in
`docs/sync-schema.md` § Idempotent DDL application). Key decisions:

- `add column` is the ONLY definition comparison, and only the **logical type**
  (`inferType(dataType).name` vs `ColumnSchema.logicalType.name`); mismatch throws a
  conflict naming the column and both types. Constraint-level drift converges silently —
  reasoning is a NOTE at `decideAddColumn`.
- Absent table → converge with a warning (drop won); absent column under `alter column`
  → converge with a warning (most-destructive-wins per docs).
- `rename column` / `rename constraint`: old-present → execute; new-present → converged;
  neither → converge with warning.
- Parse failure → log + execute, so the engine's own error surfaces.
- `alter primary key` compares PK names+directions; carries the NOTE referencing
  `bug-sync-rename-and-pk-change-strand-crdt-metadata` (metadata stranding NOT fixed
  here, per ticket).
- `rename to` and tag/maintained arms: `execute` as before, no idempotency arm.

**C. Warnings.** Both blank-DDL warnings (origin `recordSchemaMigration`, receiver
`applySchemaChange`) kept for older-build peers / third-party modules;
`schema-alter-table-warnings.spec.ts` now drives each synthetically (a hand-built
`TransactionCommitBatch` with a DDL-less alter event; a blank `alter_column` through a
directly-constructed adapter) and still asserts a real ALTER warns at neither end.

Small engine change: `expressionToString` and `namedConstraintExists` added to
`@quereus/quereus`'s main-index exports (the sync package's test tsconfig uses node10
module resolution, which cannot see the `/parser` / `/emit` subpath exports — the AST
types the adapter needs are derived structurally from `Parser['parse']` for the same
reason).

## How to validate

- `yarn build && yarn typecheck && yarn lint && yarn test` — all run green here
  (engine 8615, store 1359, sync 692, no failures).
- End-to-end behavior: `schema-alter-replication.spec.ts` — every alteration arm
  replicates (asserted via `generateTableDDL` equality on both peers), data flows across
  each alteration including into a newly added column, a replicated UNIQUE enforces on
  the receiver, identical concurrent alterations converge in BOTH relay directions
  (version-guard direction and `decideAlterTable` direction), divergent `add column`
  types conflict naming both, same batch twice converges, a genuine local ALTER on the
  receiver still replicates after an inbound one (the expectation-leak regression), a
  declarative `apply schema` adding+dropping columns in one transaction replicates.
- Decision table row-by-row: `schema-replication-idempotency.spec.ts` § "alter_column
  decision table" (synthetic migrations, per-arm already-applied/execute/conflict, absent
  table/column warnings, parse failure, zero-event tag statement leaving no residue,
  post-failure local capture).
- Emitter semantics: `packages/quereus-store/test/events.spec.ts` § "remote schema
  scopes" (multi-event, zero-event, refcount, close-without-open).

## Honest gaps / notes for the reviewer

- **Filed `bug-sync-stale-create-migration-conflicts-after-alter` (backlog).** Peers that
  created the same table independently and alter before their FIRST mutual sync hit a
  permanent conflict: the not-yet-reconciled `create_table` migration compares against
  the receiver's post-alteration DDL. Pre-existing comparison design, newly reachable
  because alterations now change the rendered table DDL. The new spec's convergence
  `beforeEach` reconciles creates first and says why.
- **`set not null` / `drop not null` equality-convergence is silent about backfill.** A
  receiver already at the wanted nullability skips the DDL; a receiver that differs
  executes it, and a `set not null` with existing NULLs on the receiver would throw and
  abort the batch (surfaced as an error, not converged). Not exercised end-to-end with
  violating rows.
- **Unnamed CHECK `add constraint` has no idempotency identity** — a concurrent
  identical unnamed CHECK on both peers re-executes and duplicates the constraint
  (engine auto-names it). Semantically harmless (same predicate twice); noted, not
  guarded.
- **Dropped-column noise:** `mergeColumnUpdates` still warns per change for change-log
  facts naming a column the batch's own DDL just dropped. The ticket said "consider
  demoting"; left as-is — rows for surviving columns are pinned to land
  (`schema-alter-replication.spec.ts` drop-column test).
- The `alter primary key` end-to-end test replicates the re-key at DDL level only; the
  CRDT-metadata stranding is real and tracked
  (`bug-sync-rename-and-pk-change-strand-crdt-metadata`), NOTE'd at the arm.
- `decideAlterTable` reads `stmt.table` not at all — it trusts the migration's
  `(schema, table)` envelope (which the origin filed from the event). A hand-crafted
  migration whose DDL names a different table than its envelope would be mis-decided;
  unreachable from the real pipeline.
