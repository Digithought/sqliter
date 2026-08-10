---
description: When a table is altered, the notification the database sends out now carries the exact SQL statement that made the change, plus the old table name on a rename — implemented, reviewed, and shipped.
prereq:
files:
  - packages/quereus/src/vtab/module.ts                            # SchemaChangeInfo.ddl; renameTable's trailing `ddl?`
  - packages/quereus/src/vtab/events.ts                            # VTableSchemaChangeEvent.oldObjectName
  - packages/quereus/src/core/database-events.ts                   # DatabaseSchemaChangeEvent.oldObjectName + projection
  - packages/quereus/src/planner/building/alter-table.ts           # renders canonical SQL once, from the resolved table
  - packages/quereus/src/planner/nodes/alter-table-node.ts         # readonly `sql` ctor field
  - packages/quereus/src/planner/nodes/add-constraint-node.ts      # same
  - packages/quereus/src/runtime/emit/alter-table.ts               # every arm threads sql to module + event
  - packages/quereus/src/runtime/emit/add-constraint.ts            # both paths thread sql
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # shape gains ddl/oldObjectName
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # reshapeOpToChange: never sets ddl
  - packages/quereus/src/schema/manager.ts                         # emitAutoSchemaEventIfNeeded NOTE
  - packages/quereus/src/vtab/memory/module.ts                     # module-level emit-iff-ddl gate + alterEventShape
  - packages/quereus/src/vtab/memory/layer/manager.ts              # 9 manager-level ALTER emits removed
  - packages/quereus-store/src/common/store-module-alter.ts        # ONE gated dispatcher-tail emit
  - packages/quereus-store/src/common/store-module-alter-column.ts # arm emit removed
  - packages/quereus-store/src/common/store-module-rename.ts       # ddl param; gated emit with oldObjectName
  - packages/quereus-store/src/common/events.ts                    # SchemaChangeEvent.oldObjectName
  - packages/quereus-isolation/src/isolation-module.ts             # renameTable forwards ddl verbatim
  - packages/quereus-sync/src/sync/sync-manager-impl.ts            # comment-only
  - packages/quereus/test/alter-table-schema-events.spec.ts        # per-arm ddl; non-main qualification
  - packages/quereus-store/test/alter-events.spec.ts               # per-arm ddl, one-event, revert silence, quoting
  - packages/quereus-store/test/database-events.spec.ts            # auto-path vs module-path ddl parity
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts # end-to-end replication
  - docs/module-authoring.md                                       # § Schema Changes: `ddl` emit-iff-set rule
  - docs/sync-schema.md                                            # § What replicates
  - docs/usage.md                                                  # § What each ALTER TABLE arm reports
  - docs/module-events.md                                          # schema event shape
  - docs/store.md                                                  # store SchemaChangeEvent shape
difficulty: medium
---

# The schema-change event describes the alteration

Every `ALTER TABLE` statement's schema-change event now carries the statement's canonical,
schema-qualified SQL in `ddl`, exactly one event per statement, and a `RENAME TO` event also
carries `oldObjectName`.

## How it works

- `buildAlterTableStmt` renders the SQL **once at plan-build**, from a synthetic
  `AST.AlterTableStmt` whose table identifier is rebuilt from the resolved `TableSchema`
  (qualified unless the schema is `main`). Stored as a readonly `sql` field on
  `AlterTableNode` / `AddConstraintNode`.
- Every runtime arm passes it to `module.alterTable` as `SchemaChangeInfo.ddl` (an
  intersection field on the union, so existing `switch` narrowing is untouched) or to
  `module.renameTable` as a trailing `ddl?` parameter — **only on the call that IS the
  statement's action**. The inline-constraint installs, the failed-ADD-COLUMN revert calls,
  and the materialized-view backing reshapes pass none.
- The rule (documented on `SchemaChangeInfo.ddl` and in `docs/module-authoring.md`
  § Schema Changes): an emitter-backed module emits a schema-change event for a call **iff**
  `ddl` is set, and puts the text on the event. The store enforces it at one dispatcher-tail
  gate; the memory module got the same gate (its nine manager-level ALTER emits were removed),
  and `renameTable` has its own gated emit with `oldObjectName`.
- The engine's no-module-emitter path (`emitAlterSchemaEvent`) passes the same rendered text,
  so memory-backed and store-backed alterations announce the identical string.

Deliberate behavioral deltas, all recorded by the implementer and confirmed in review:
a no-op `ALTER COLUMN` now emits (parity with the engine path); the store's single emit runs
after `reconcileImplicitUniqueIndexStores` rather than before it; canonicalization is partial
by design (statement keywords lowercased and the table qualified; data-type and identifier
casing preserved as written).

## Review findings

Reviewed the implement commit `89c740ce` diff first, then every touched file and the ones the
change should have touched. Ran `yarn build`, `yarn test` (all workspaces — **8,615 + 376 +
113 + 63 + 17 + 28 + 1,355 + 659 + 85 + 31 + 34 + 134 + 22 passing, 0 failing**),
`yarn workspace @quereus/store test`, `yarn lint`, `yarn typecheck` — all green, both before
and after the fixes below. No pre-existing failures surfaced.

### Major — filed as a ticket

- **A failed `ADD COLUMN` can still announce that the column was added.**
  `tickets/fix/alter-add-column-revert-leaks-schema-event.md` (`repro: verified`).
  The engine marks the module's `addColumn` call with `ddl`, so an emitter-backed module
  announces from *inside* that call — but the statement is not over: the inline-constraint
  installs run afterwards, and a failure there unwinds through `revertFailedAddColumn` with
  the announcement already made. Verified against the store module: inside an explicit
  transaction that then commits, `alter table p add column c integer default 5 unique` on a
  table whose rows would all take value 5 fails, leaves the table unchanged, and still
  delivers `{type:'alter', objectName:'p', ddl:'alter table p add column c integer default 5
  unique'}`. The engine's own path gets this right (it announces at the arm's tail).
  Not a regression — the spurious event predates this ticket — but this ticket makes it
  material: the event now carries SQL a sync peer executes, so a peer gains a column the
  origin does not have. The existing test `a failed ADD COLUMN announces nothing` passes only
  because its failure mode (a backfill CHECK) throws before the module call returns.

### Minor — fixed in this pass

- **The deliberate non-`main` qualification had no committed test** (the implementer flagged
  this). Added `a table outside main announces a schema-qualified statement` to
  `packages/quereus/test/alter-table-schema-events.spec.ts`, pinning
  `alter table "temp".q add column w text null` — the whole reason the SQL is rendered from
  the resolved table rather than from the statement as typed.
- **Wrong worked example in both `renameTable` emit-gate comments** (memory + store): they
  cited "the shadow-table rebuild's trailing rename" as a call arriving *without* `ddl`. It is
  itself a `RENAME TO` statement and therefore carries `ddl`; it is silenced by
  `withPublicEventsSuppressed`, not by the gate. No in-tree caller omits `ddl` today.
  Comments corrected to say so.
- **`docs/usage.md` § *What each `ALTER TABLE` arm reports* was left stale** — it still told
  readers that an emitting backend "may report an extra `alter`/`table` per inline
  constraint", which this ticket retired. Rewritten: the arm table notes `oldObjectName` on
  `rename to`, a new paragraph states that every arm sets `ddl` to the canonical
  schema-qualified SQL and what is and is not canonicalized, and the success-path guarantee
  now names the one known exception (the ticket above) instead of overclaiming.
- **`docs/module-events.md` and `docs/store.md` event shapes were behind the code** —
  `oldObjectName` missing from both (and `oldColumnName` from the first); the "how a rename
  reaches a replicating peer is an open question" note is now answered. Updated.
- **Three dead parameters in `store-module-alter.ts`.** The implementer `_`-prefixed
  `schemaName`/`tableName` on `alterAddConstraint` / `alterDropConstraint` /
  `alterRenameConstraint` when their emits moved to the dispatcher. They are private helpers
  with one call site each — dropped the parameters instead of carrying them dead.

### Tripwire — recorded at the code site, not filed

- `buildAlterTableStmt` renders `sql` for **every** arm, including the four that never
  announce anything (the tag arms, `set`/`drop maintained`) — so `set maintained as <select>`
  stringifies its whole SELECT body for a string nobody reads. Free today (ALTER is not a hot
  path, each statement builds once). `NOTE:` at the site says to render lazily and hand the
  arms a thunk if that ever costs anything.

### Checked and clean — nothing to report

- **One event per statement, per arm.** Re-derived the gate on both producers. The memory
  module's `alterEventShape` is exhaustive over all eight `SchemaChangeInfo` arms and matches
  what the engine's auto path reports for each; `MemoryTableModule` is the only new emitter,
  and `hasNativeEventSupport` is a *dynamic* check (`getEventEmitter() !== undefined`), so an
  emitter-less memory module still gets the engine fallback and neither path doubles up.
- **Removing the nine manager-level emits is safe and is in fact a fix.** The only callers of
  `MemoryTableManager`'s ALTER methods other than the module are `MemoryTable.alterSchema` /
  `.rename`, driven by the isolation overlay (`forwardColumnShapeToOverlay` calls the
  *VirtualTable* hook, never `module.alterTable`). Those calls used to announce a second,
  overlay-internal event; they are now correctly silent. Materialized-view backing reshapes
  likewise. Index and create/drop-table emits in the manager are untouched.
- **Rendering completeness.** The parser produces exactly one attribute per `alterColumn`
  action (`set not null` / `drop not null` / `set data type` / `set default` / `drop default` /
  `set collate` are separate parses), so `alterTableToString`'s first-match-wins `if` chain
  cannot silently drop half a statement. Every arm's rendering is asserted per-form and
  re-parsed in `alter-events.spec.ts`.
- **`SchemaChangeInfo` becoming an intersection breaks nothing.** Every `switch` over it still
  narrows; the store dispatcher's `never` exhaustiveness check still compiles; no in-tree or
  sample plugin implements `alterTable`/`renameTable` outside the three modules changed here
  plus test doubles.
- **Sync's event→migration mapping is unaffected.** `mapSchemaMigrationType` tracks only
  `objectType: 'table' | 'index'`, so the column-shaped events the engine and memory paths
  raise are ignored as before; the store's `alter`/`table` shape is what replication reads.
- **Batched-event interactions.** `renameBatchedEvents` walks only the *data* event stores, so
  the rename does not relabel a batched schema event's `objectName` out from under its `ddl` —
  the comment claiming this is accurate.
- **Size hygiene.** `runtime/emit/alter-table.ts` measured 2,224 lines
  (`(Get-Content <path> | Measure-Object -Line).Lines`), up ~69 from this change; already
  claimed by `debt-emit-source-files-too-large`, so not re-filed.
  `vtab/memory/layer/manager.ts` measured 3,589 lines and was **not** claimed by any size
  ticket — filed `backlog/debt-memory-table-manager-file-too-large.md`. (This change shrank it
  by ~80 lines; the debt is pre-existing.)

### Considered and deliberately not filed

- `expressionToString`'s unknown-node fallback renders `[type]`, so a future AST variant could
  in principle produce a `ddl` that does not re-parse. Every expression form the parser emits
  has a case today and every emitted string is re-parsed in the store suite, so this is
  speculation, not a defect.
- The store announces `alter`/`table` for column arms where the engine and memory paths
  announce `alter`/`column` with the column name. Pre-existing divergence, untouched by this
  ticket, and invisible to sync (which tracks only the table shape). Left alone rather than
  widened into an unrelated change.

## Known gaps carried forward

- Tag arms (`SET`/`ADD`/`DROP TAGS`) and `SET`/`DROP MAINTAINED` still announce nothing on any
  path — out of scope, tracked as `feat-alter-table-tags-emit-no-schema-event`; not regressed.
- No test drives an ALTER through the isolation overlay asserting the forwarded `ddl` reaches
  the store's event. Reviewed the forwarding by hand (verbatim pass-through of `change`, and of
  `renameTable`'s `ddl`) and the isolation suites pass, but it is not pinned specifically.
- Downstream: `sync-replicate-alter-table-ddl` (receiver-side idempotent re-apply and the
  one-for-one event expectation rework) and `sync-replicate-rename-table` (a rename's data
  stream) remain open. Basic one-for-one replication already works after this ticket and is
  covered by `packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts`.
