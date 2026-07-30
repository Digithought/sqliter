---
description: The engine now tells subscribers when a table is altered — renamed, or having a column or constraint added, dropped, renamed, or retyped — even when the storage backend provides no notifications of its own. Review the per-arm event shapes, the guard against double-reporting, and the docs.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # NEW — the shared per-arm emit helper
  - packages/quereus/src/runtime/emit/alter-table.ts               # 9 emit sites added at the arm tails
  - packages/quereus/src/runtime/emit/add-constraint.ts            # 2 emit sites (module-routed + engine-side CHECK)
  - packages/quereus/src/schema/manager.ts                         # emitAutoSchemaEventIfNeeded: private → public (~2581)
  - packages/quereus/test/alter-table-schema-events.spec.ts        # NEW — 31 cases, the whole contract
  - packages/quereus/test/alter-table-events.spec.ts               # 2 cases + header rewritten (~1005-1085)
  - packages/quereus-store/test/database-events.spec.ts            # 2 ALTER no-double-emit cases added
  - docs/usage.md                                                  # § Subscribing to Schema Changes — new per-arm table
  - docs/sql-ddl.md                                                # ALTER PRIMARY KEY notification paragraph
  - docs/module-events.md                                          # auto-event DDL coverage
difficulty: medium
---

# What landed

`ALTER TABLE` now raises a public schema-change event (`db.onSchemaChange`) from the engine's
own path — i.e. for a storage backend that ships no event emitter of its own, which is the case
a default `new Database()` is in (the built-in `memory` module is registered without one). Before
this, `create table` emitted and **every** ALTER arm was silent.

## Shape per arm (this is the contract to review against)

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

These are not invented: they are what a `MemoryTableModule` constructed **with** a
`DefaultVTableEventEmitter` already reports for the same statements, so a subscriber sees the
same facts regardless of backend. `drop column` really is `type: 'drop'`.

## Three design decisions worth attacking

**One gate, not two.** `SchemaManager.emitAutoSchemaEventIfNeeded` went from `private` to
public; the arms call it through a thin helper (`runtime/emit/alter-schema-event.ts`) that fills
in `schemaName` and the module name from the arm's `tableSchema`. The gate decides two things —
"does any listener need this" (`db._needsSchemaEvents()`, also false inside a
`withPublicEventsSuppressed` scope) and "does the owning **module registration** already emit for
itself" (`hasNativeEventSupport`). Re-implementing either half in `runtime/emit/` is what would
double-report on a store-backed table. Nothing was re-implemented; confirm that.

**Emit at the arm's tail, on success only.** Every emit sits after the catalog swap and after the
internal `changeNotifier.notifyChange`, at the point the arm returns. The emitting modules emit
*earlier* (from inside `module.alterTable`), so there is a deliberate intra-statement ordering
divergence. Rationale: an arm that fails after the module call — the `ADD COLUMN`
inline-constraint revert path, an `assertRenameDependentsPersistable` refusal — must announce
nothing at all, and the drift is unobservable because each arm yields exactly one event and
delivery is batched to commit. Attack this if you can find a listener that can observe the order.

**`ADD COLUMN` with an inline constraint emits ONE event.** The arm makes a second
`module.alterTable(addConstraint)` round-trip per inline constraint, so an emitter-backed module
reports `alter`/`column` **plus** an `alter`/`table` per constraint. The engine path collapses
that to one `alter`/`column`: the extra round-trip is the module's internal call pattern, not a
second thing the application did. This is the single knowing divergence from parity; it is
commented at the emit site so it does not get "fixed" into two.

## Deliberately out of scope

- **`SET`/`ADD`/`DROP TAGS`** — measured to emit nothing on the emitter-backed memory module
  either (the tag arms are catalog-only and never call `module.alterTable`), so emitting here
  would be a new capability, not restored parity — and it would emit for memory while staying
  silent for the store, a *new* asymmetry. Tracked in
  `backlog/feat-alter-table-tags-emit-no-schema-event`. There is a positive test asserting the
  silence, so the decision is pinned rather than merely absent.
- **`SET`/`DROP MAINTAINED`** — materialized-view lifecycle raises only internal catalog
  notifications; no backend raises a public schema event for it.
- **The `ddl` payload** — the fallback carries none, matching every other auto event. Owned by
  `fix/sync-schema-migrations-replicate-empty-ddl`. A test asserts `ddl === undefined` so the gap
  is explicit.
- **An old-table-name field for renames** — `DatabaseSchemaChangeEvent` has `oldColumnName` but
  no `oldObjectName`, so a rename names only the new table. The emitting backends have the same
  gap; adding the field is a public-interface change for the replication ticket to drive.

# Validation

`yarn build`, `yarn typecheck`, `yarn lint` clean. `yarn test`: **all green** (quereus 7979
passing; quereus-store 350; sync 594; the rest unchanged). `yarn test:store`: 7970 passing, 22
pending, 0 failing. No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

## New spec — `packages/quereus/test/alter-table-schema-events.spec.ts` (31 cases)

Two describes, and the pairing is the point:

- **engine fallback** (default `Database`) pins the exact per-arm shape from the table above,
  plus: one event per statement even with inline constraints (single and several); a failed ALTER
  announces nothing (rename-onto-existing-name, an `add column` whose inline `CHECK` the existing
  rows violate — the *revert* path, the interesting one — a non-unique `alter primary key`, a
  `drop constraint` naming nothing); transaction scoping (nothing before `commit`, nothing on
  `rollback`, nothing on `rollback to savepoint`, delivered after `release savepoint`); the
  commit batch carries the one schema event and zero data events; the tag arms stay silent; and
  a module with **no** `alterTable` hook at all takes the engine-side `ADD CHECK` path and
  reports the same shape.
- **emitter-backed `MemoryTableModule`** re-runs the same arms and asserts **exactly one** event
  per statement — the direct no-double-emit guard.

## Rewritten existing cases — say so out loud

`packages/quereus/test/alter-table-events.spec.ts`, describe *'ALTER PRIMARY KEY via shadow-table
rebuild: the rebuild is notification-silent'*: two cases now assert **one** `alter`/`table` event
naming `t` where they previously asserted zero. That is the point of the change, not a weakened
test — the shadow-table churn stays suppressed (the assertion that nothing names `__rekey_` is
kept, and the commit-batch case still asserts zero data events and exactly one schema event). The
describe's header comment was rewritten accordingly. The failed-rebuild case still asserts zero
events and was left alone (the statement throws, so nothing is emitted).

Store package: two new cases next to the `create table` control — `add column` and `rename to`
over a store-backed table each emit exactly one `onSchemaChange` event.

# Known gaps / things a reviewer should push on

- **The `ADD COLUMN`-with-inline-constraint divergence is asserted only on the engine path.** The
  emitter-backed describe deliberately uses plain arms, so nothing pins the *module's* two-event
  behaviour. If you think that behaviour should also be locked down (so a future module change
  cannot silently converge or diverge further), that is a fair finding.
- **`apply schema` (declarative migration) now emits per-ALTER events for memory-backed tables.**
  `runtime/emit/schema-declarative.ts` executes the differ's generated DDL through
  `_execWithinTransaction`, which is not suppressed — so a declarative apply that alters a
  memory table now raises one event per generated ALTER statement, where before it raised only
  the `create`/`drop` ones. I believe that is correct (a declarative apply *is* a schema change
  the application asked for, and `create table` inside it already reported), and no test
  regressed, but it is a behaviour change nobody explicitly asked for and no test asserts it
  either way. Worth a decision.
- **No coverage of the `ALTER PRIMARY KEY` native-branch emit sitting inside the
  UNSUPPORTED-catching `try`.** The emit cannot raise `UNSUPPORTED` (it either emits or does
  not), and there is a code comment saying so, but the reasoning is not test-enforced. Same class
  of concern as the pre-existing NOTE just above it about the re-key call.
- **No sqllogic coverage.** The whole contract is in TypeScript specs; the `.sqllogic` suite has
  no way to observe events, so this is structural rather than an omission — but it does mean the
  store-mode run (`yarn test:store`) exercises the store's *own* emitter path only through the
  two new cases in the store package, not arm-by-arm.
- **`emitAutoSchemaEventIfNeeded` is now public API surface on `SchemaManager`.** That is
  intentional (one gate), but it is a widened surface; if you would rather see it exposed as a
  narrower engine-internal seam (e.g. `_emitAutoSchemaEvent` on `Database`), say so.
