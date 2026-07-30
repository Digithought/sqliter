---
description: The engine now tells subscribers when a table is altered — renamed, or having a column or constraint added, dropped, renamed, or retyped — even when the storage backend provides no notifications of its own.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # the shared per-arm emit helper
  - packages/quereus/src/runtime/emit/alter-table.ts               # 9 emit sites at the arm tails
  - packages/quereus/src/runtime/emit/add-constraint.ts            # 2 emit sites (module-routed + engine-side CHECK)
  - packages/quereus/src/schema/manager.ts                         # emitAutoSchemaEventIfNeeded — the one gate
  - packages/quereus/test/alter-table-schema-events.spec.ts        # 33 cases, the whole contract
  - packages/quereus/test/alter-table-events.spec.ts               # ALTER PRIMARY KEY rebuild describe
  - packages/quereus-store/test/database-events.spec.ts            # ALTER no-double-emit cases
  - docs/usage.md                                                  # § What each ALTER TABLE arm reports
  - docs/sql-ddl.md                                                # ALTER PRIMARY KEY notification paragraph
  - docs/module-events.md                                          # DDL coverage of the auto path
difficulty: medium
---

# What landed

`ALTER TABLE` raises a public schema-change event (`db.onSchemaChange`) from the engine's own
path — i.e. for a storage backend that ships no event emitter of its own, which is the case a
default `new Database()` is in (the built-in `memory` module is registered without one). Before
this, `create table` emitted and every ALTER arm was silent.

## Shape per arm (the contract)

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename to` | `alter` | `table` | **new** table name | — | — |
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` (all four attribute forms) | `alter` | `column` | table | altered column | — |
| `alter primary key` | `alter` | `table` | table | — | — |
| `add constraint` | `alter` | `table` | table | — | — |
| `drop constraint` | `alter` | `table` | table | — | — |
| `rename constraint` | `alter` | `table` | table | — | — |

These mirror, field for field, what a `MemoryTableModule` constructed **with** a
`DefaultVTableEventEmitter` already reports for the same statements, so a subscriber sees the
same facts regardless of backend.

## Design decisions, as they stand after review

**One gate.** `SchemaManager.emitAutoSchemaEventIfNeeded` is public and every producer — the
ALTER arms via the thin `runtime/emit/alter-schema-event.ts` helper, and `SchemaManager`'s own
create/drop sites — passes through it. It decides both halves: "does any listener need this"
(`db._needsSchemaEvents()`, false inside a `withPublicEventsSuppressed` scope) and "does the
owning module registration already emit for itself" (`hasNativeEventSupport`).

**Emit at the arm's tail, on success only.** Every emit sits after the catalog swap and after the
internal `changeNotifier.notifyChange`. Emitting modules emit earlier (from inside
`module.alterTable`), so there is an intra-statement ordering divergence; it is unobservable
because each arm yields exactly one event and delivery is batched to commit.

**`ADD COLUMN` with an inline constraint emits ONE event on the engine path,** where an
emitter-backed module reports `alter`/`column` plus an `alter`/`table` per constraint (its own
extra `alterTable(addConstraint)` round-trip, not a second thing the application did). Both
sides are now pinned by tests.

## Out of scope (unchanged by review)

- **`SET`/`ADD`/`DROP TAGS`** — no backend reports them; emitting only from the engine would
  create a new asymmetry. Tracked in `backlog/feat-alter-table-tags-emit-no-schema-event`, with
  a positive test asserting the current silence.
- **`SET`/`DROP MAINTAINED`** — materialized-view lifecycle raises only internal catalog
  notifications on every backend.
- **The `ddl` payload** — the fallback carries none, matching every other auto event; a test
  asserts `ddl === undefined`. Owned by `fix/bug-sync-schema-migrations-replicate-empty-ddl`.
- **An old-table-name field for renames** — `DatabaseSchemaChangeEvent` has `oldColumnName` but
  no `oldObjectName`; the emitting backends have the same gap. Adding the field is a
  public-interface change for the replication ticket to drive.

# Review findings

## Checked

- Read the implement-stage diff (`3137013f`, all 12 files) before the handoff summary.
- **Gate correctness.** `hasNativeEventSupport` is instance-state based
  (`getEventEmitter() !== undefined`), so a `MemoryTableModule` built without an emitter
  correctly falls through to the engine while one built with an emitter suppresses it. Confirmed
  neither half of the decision is re-implemented under `runtime/emit/`.
- **Arm coverage.** Enumerated all 12 dispatcher cases in `alter-table.ts`. Nine structural arms
  emit; the three tag arms and two maintained arms are deliberately silent; `add constraint` is
  its own node and both of its branches (module-routed, engine-side CHECK) emit. No arm missed.
- **Emit placement.** Every emit is at the arm tail, after the catalog swap and `notifyChange`,
  past every throw — including the `ADD COLUMN` inline-constraint revert path.
- **Field parity** against the memory module's own emit sites
  (`vtab/memory/layer/manager.ts` lines 2009 / 2096 / 2202 / 2295 / 2407) — shapes match field
  for field on all four column arms and the primary-key arm.
- **Suppression interaction.** `needsSchemaEvents()` returns false inside
  `withPublicEventsSuppressed`, so the shadow-rebuild's four inner statements (including the
  inner `RENAME TO` arm's own new emit) stay silent while the outer arm's emit, outside the
  scope, reports.
- **Sync interaction.** The fallback is gated off for the store module (native emitter), so no
  new empty-`ddl` migrations reach sync. The store's own missing-`ddl` gap predates this and is
  owned by `fix/bug-sync-schema-migrations-replicate-empty-ddl`.
- **Docs**, read in full rather than trusted: `usage.md`, `module-events.md`, `sql-ddl.md`,
  `schema.md`, `sync.md`, `module-authoring.md`, `packages/quereus/README.md`. The
  quoomb-web worker's `onSchemaChange` subscription (`docs/sync.md` § Revival / drain) already
  filters to `create`/`table`, so the new `alter` events do not reach it.

## Found and fixed in this pass (minor)

- **`docs/module-events.md` dropped `DROP TABLE` from the auto-path DDL list.** The new "DDL
  coverage of the auto path" section listed `CREATE TABLE` / `CREATE INDEX` / `DROP INDEX`, but
  `SchemaManager.dropTable` emits too. Added.
- **`SchemaManager.dropTable` carried a hand-inlined copy of the gate** — the same
  `_needsSchemaEvents() && !hasNativeEventSupport(...)` predicate spelled out a second time,
  which is precisely the duplication the ticket's "one gate" argument warns against. Routed
  through `emitAutoSchemaEventIfNeeded`; the predicate is token-for-token identical, so no
  behaviour change.
- **The emitter-backed describe pinned no `add column … <inline constraint>` case** — the
  implementer flagged this themselves. The engine's one-event divergence was asserted while the
  module's two-event behaviour was free to drift. Added a case asserting
  `['alter/column/t/w', 'alter/table/t']`; it passes as predicted, so the divergence is now
  pinned on both sides.
- **`apply schema` was an unasserted, undocumented behaviour change.** The differ's generated
  migration DDL runs through the ordinary statement path (no suppression), so a declarative apply
  that alters a memory-backed table now raises one event per generated ALTER. That reading is
  correct — a declarative apply is a schema change the application asked for, and its generated
  `create table` already reported — so it is now pinned by a test and stated in `docs/usage.md`
  rather than left to drift.

## Tripwire (recorded, not ticketed)

- `runAlterPrimaryKey`'s rebuild branch is the one place where a module **with** its own emitter
  could report nothing: it raised `UNSUPPORTED` instead of emitting, and the gate then suppresses
  the engine's fallback because the registration advertises native support. Unreachable today
  (memory re-keys in place; the store handles `alterPrimaryKey` natively), so it is genuinely
  conditional. Parked as a `NOTE:` at the emit site in `runtime/emit/alter-table.ts`.

## Considered and rejected as findings

- **`emitAutoSchemaEventIfNeeded` widened to public.** The implementer offered a narrower
  `Database._emitAutoSchemaEvent` seam as an alternative; it would be a forwarder over the same
  gate on a class the arms already reach. Left as is.
- **Intra-statement ordering divergence** (engine at the tail, module mid-`alterTable`). Looked
  for a listener that could observe it: one event per arm, batched to commit, and schema events
  are delivered in an array separate from data events — nothing exposes the order.
- **`columnName` follows the statement's argument casing, not the stored column name.** True, but
  the memory module's own emit sites do exactly the same, so this is shared pre-existing
  behaviour, not a divergence this change introduces.
- **`alter-table.ts` at 2,223 lines.** Already tracked by
  `backlog/debt-emit-source-files-too-large`, which names this file explicitly.

## New tickets filed

None. Nothing found rose to major: the two real defects (the docs omission, the duplicated gate)
were one-line fixes, and the two coverage gaps were closed with tests in this pass.

## Handoff nit

The implement handoff cited the sibling ticket as `fix/sync-schema-migrations-replicate-empty-ddl`;
the actual slug carries the `bug-` prefix (`fix/bug-sync-schema-migrations-replicate-empty-ddl`).

# Validation

`yarn build`, `yarn lint`, `yarn typecheck` clean. `yarn test`: all green — quereus **7981
passing / 13 pending / 0 failing** (up 2 from the handoff's 7979, exactly the two cases added
here), quereus-store 350, quereus-sync 594, every other package unchanged and passing. No
pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

`yarn test:store` was **not** re-run in this pass. The only source edit outside the ALTER arms is
the `dropTable` gate refactor, whose predicate is identical to the code it replaced; the store
package's own suite (350 cases, including the two new ALTER no-double-emit cases) ran green under
`yarn test`, and the implementer ran `test:store` clean (7970 passing, 22 pending, 0 failing) on
functionally this same code.

## Test inventory — `packages/quereus/test/alter-table-schema-events.spec.ts` (33 cases)

- **engine fallback** (default `Database`): the exact per-arm shape from the table above; one
  event per statement even with inline constraints (single and several); a failed ALTER announces
  nothing (rename-onto-existing-name, an `add column` whose inline `CHECK` the existing rows
  violate — the revert path, a non-unique `alter primary key`, a `drop constraint` naming
  nothing); transaction scoping (nothing before `commit`, nothing on `rollback`, nothing on
  `rollback to savepoint`, delivered after `release savepoint`); the commit batch carries the one
  schema event and zero data events; the tag arms stay silent; a declarative `apply schema` that
  widens a table reports the generated ALTER; and a module with no `alterTable` hook at all takes
  the engine-side `ADD CHECK` path and reports the same shape.
- **emitter-backed `MemoryTableModule`**: the same arms, asserting exactly one event per
  statement (the direct no-double-emit guard), plus the deliberate two-event `add column …
  unique` divergence.

`packages/quereus/test/alter-table-events.spec.ts`'s ALTER-PRIMARY-KEY-rebuild describe now
asserts **one** `alter`/`table` event naming `t` where it previously asserted zero — the point of
the change, not a weakened test: the shadow-table churn stays suppressed (nothing names
`__rekey_`, the commit batch still carries zero data events and exactly one schema event), and
the failed-rebuild case still asserts zero events.

The store package adds two cases next to its `create table` control: `add column` and `rename to`
over a store-backed table each emit exactly one `onSchemaChange` event.

## Structural coverage gap (unchanged, stated for the record)

There is no `.sqllogic` coverage — that suite has no way to observe events, so the whole contract
lives in TypeScript specs. The consequence is that `yarn test:store` exercises the store's own
emitter path arm-by-arm only through the two cases in the store package, not for all nine arms.
