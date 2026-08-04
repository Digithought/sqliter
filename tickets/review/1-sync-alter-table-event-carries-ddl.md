---
description: When a table is altered, the notification the database sends out now carries the exact SQL statement that made the change, plus the old table name on a rename — implemented and tested; needs a code-review pass.
prereq:
files:
  - packages/quereus/src/vtab/module.ts                            # SchemaChangeInfo intersection field `ddl`; renameTable gains trailing `ddl?`
  - packages/quereus/src/vtab/events.ts                            # VTableSchemaChangeEvent.oldObjectName
  - packages/quereus/src/core/database-events.ts                   # DatabaseSchemaChangeEvent.oldObjectName + projection
  - packages/quereus/src/planner/building/alter-table.ts           # renders canonical SQL once, from the resolved table
  - packages/quereus/src/planner/nodes/alter-table-node.ts         # new readonly `sql` ctor field
  - packages/quereus/src/planner/nodes/add-constraint-node.ts      # same
  - packages/quereus/src/runtime/emit/alter-table.ts               # every arm threads sql to module + event
  - packages/quereus/src/runtime/emit/add-constraint.ts            # both paths thread sql
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # shape gains ddl/oldObjectName; doc rewritten
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # reshapeOpToChange doc: never sets ddl
  - packages/quereus/src/schema/manager.ts                         # emitAutoSchemaEventIfNeeded NOTE updated
  - packages/quereus/src/vtab/memory/module.ts                     # module-level emit-iff-ddl gate + alterEventShape; renameTable ddl
  - packages/quereus/src/vtab/memory/layer/manager.ts              # 9 manager-level ALTER emits removed
  - packages/quereus-store/src/common/store-module-alter.ts        # per-arm emits hoisted to ONE gated dispatcher-tail emit
  - packages/quereus-store/src/common/store-module-alter-column.ts # arm emit removed (dispatcher owns it)
  - packages/quereus-store/src/common/store-module-rename.ts       # ddl param; gated emit with oldObjectName
  - packages/quereus-store/src/common/events.ts                    # SchemaChangeEvent.oldObjectName
  - packages/quereus-isolation/src/isolation-module.ts             # renameTable forwards ddl verbatim
  - packages/quereus-sync/src/sync/sync-manager-impl.ts            # comment-only: blank-DDL warning now an older-peer case
  - packages/quereus/test/alter-table-schema-events.spec.ts        # updated: ddl asserted; memory double-emit retired
  - packages/quereus-store/test/alter-events.spec.ts               # new describe: per-arm ddl, one-event, revert silence, quoting
  - packages/quereus-store/test/database-events.spec.ts            # auto-path vs module-path ddl parity
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts # rewritten: replication asserted instead of the gap
  - docs/module-authoring.md                                       # § Schema Changes: `ddl` emit-iff-set rule
  - docs/sync-schema.md                                            # § What replicates: ALTER now carries DDL
difficulty: medium
---

# Review: the schema-change event describes the alteration

Implemented per `1-sync-alter-table-event-carries-ddl`. Every `ALTER TABLE` statement's
schema-change event now carries the statement's canonical, schema-qualified SQL in `ddl`,
one event per statement, and a `RENAME TO` event also carries `oldObjectName`.

## How it works

- `buildAlterTableStmt` renders the SQL **once at plan-build**, from a synthetic
  `AST.AlterTableStmt` whose table identifier is rebuilt from the resolved `TableSchema`
  (qualified unless the schema is `main`, matching `generateTableDDL` and the schema
  differ). Stored as a new readonly `sql` field on `AlterTableNode` / `AddConstraintNode`.
- Every runtime arm passes it to `module.alterTable` as `SchemaChangeInfo.ddl` (an
  intersection field on the union, so existing `switch` narrowing is untouched) or to
  `module.renameTable` as a new trailing `ddl?` parameter — **only on the call that IS the
  statement's action**. The inline-constraint install loop, the failed-ADD-COLUMN revert
  calls, and the materialized-view backing reshapes pass none.
- The rule (documented on `SchemaChangeInfo.ddl` and in `docs/module-authoring.md`
  § Schema Changes): an emitter-backed module emits a schema-change event for a call
  **iff** `ddl` is set, and puts the text on the event. The **store** enforces it at one
  dispatcher-tail gate in `StoreModuleAlter.alterTable` (the seven per-arm emits were
  removed); `renameTable` has its own gated emit with `oldObjectName`.
- The engine's no-module-emitter path (`emitAlterSchemaEvent`) passes the same rendered
  text (and `oldObjectName` for rename), so memory-backed and store-backed alterations
  announce the identical string — asserted in `database-events.spec.ts`.

## Beyond the ticket's file list (flag for review)

1. **Memory module brought under the same rule.** The ticket named only the store as the
   enforcement site, but `MemoryTableModule` built with an emitter (an in-tree test
   config) emitted per manager operation — including the double emit for
   `add column … unique` that the ticket's point 3 exists to kill, pinned by
   `alter-table-schema-events.spec.ts`. I removed the nine manager-level ALTER emits
   (`vtab/memory/layer/manager.ts`) and added a module-level emit-iff-`ddl` gate
   (`alterEventShape` maps each arm to the same event shape the engine auto path
   reports). Index and create/drop-table emits in the manager are untouched. Consequence:
   a wrapper driving manager methods directly (isolation overlays) is now silent — which
   is what the rule wants — but if some out-of-tree consumer relied on manager-level
   alter events, that's a behavior change.
2. **Sync warnings spec rewritten** (`schema-alter-table-warnings.spec.ts`): it pinned
   the blank-DDL gap this ticket closes. It now asserts the inverse — no origin/receiver
   warning, the peer **actually executes** the relayed alteration (gains the column /
   constraint), and every ALTER form replicates end to end. Only a comment changed in
   sync source (`recordSchemaMigration`); the blank-DDL warnings themselves remain for
   older-build peers. Note for ticket 2 (`sync-replicate-alter-table-ddl`): basic
   one-for-one replication already works after this ticket and is covered here; ticket 2
   is the hardening (idempotent re-apply, divergence handling).

## Behavioral deltas worth probing

- **A no-op `ALTER COLUMN`** (e.g. `drop not null` on an already-nullable column, which
  early-returns in the store's `alterColumnChange`) now emits an event where the store
  previously emitted none. Deliberate: the engine auto path always emitted for it, so
  this is parity, and the statement did execute.
- **Store emit moved later**: the one gated emit runs after
  `reconcileImplicitUniqueIndexStores`, where the old per-arm emits ran before it. If the
  reconcile throws, the persisted change is now UNannounced (before: announced then
  thrown). Both orderings are wrong in some crash window; the new one at least never
  announces a change that then failed.
- **Rendering canonicalization is partial by design**: statement keywords lowercase and
  the table identifier resolved/qualified, but a data TYPE's casing (`TEXT` vs `text`)
  and identifier casing are preserved as written. Every emitted string re-parses
  (asserted per arm). The ticket's sketch (`alter table "orders" …`) assumed
  always-quoted identifiers; `quoteIdentifier` quotes only keywords/invalid names, so
  actual output is `alter table orders add column sku text` — tests hand-type the actual
  form.

## Validation

- `yarn build`, `yarn test` (all workspaces), `yarn test:store` (8606 passing),
  `yarn lint`, `yarn typecheck` — all green.
- Key suites: `packages/quereus/test/alter-table-schema-events.spec.ts` (per-arm shape +
  ddl on the auto path; emitter-backed memory now one-event with ddl);
  `packages/quereus-store/test/alter-events.spec.ts` (per-arm ddl over 14 forms,
  canonicalization, quoting round-trip incl. `"select"` / `'O''Brien'` / generated
  expression, ONE event for `add column … unique`, zero events for a failed ADD COLUMN
  inside a committing transaction, every ddl re-parses);
  `packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts` (end-to-end
  replication of add/rename/drop column and add constraint between two store peers).

## Known gaps

- Tag arms (`SET`/`ADD`/`DROP TAGS`) still emit nothing on any path — out of scope,
  tracked as `feat-alter-table-tags-emit-no-schema-event`; not regressed (the `sql` field
  is rendered for them but unused).
- `SET`/`DROP MAINTAINED` likewise announce nothing (unchanged); their `sql` is rendered
  but unused.
- No test drives an ALTER through the isolation overlay asserting the forwarded `ddl`
  reaches the store's event — the forwarding is a verbatim pass-through of `change` (and
  now of `renameTable`'s `ddl`), and isolation suites pass, but it is untested
  specifically.
- The non-`main` qualification is exercised only via an ad-hoc check during development
  (`alter table "temp".q …` renders qualified); no committed test pins it, because store
  tables in the suites all live in `main`.
