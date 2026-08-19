description: A program watching the database for structural changes now hears the same thing whether its data lives in memory or on disk — disk-backed tables finally say which column was added, dropped, or renamed instead of only "this table changed", and the device-sync layer was taught to keep recognising those messages so table alterations still reach other devices.
files:
  - packages/quereus/src/vtab/alter-event-shape.ts                              # NEW — the one shared per-arm shape derivation
  - packages/quereus/src/vtab/memory/module.ts                                  # calls the shared helper; private static deleted
  - packages/quereus/src/index.ts                                               # exports alterEventShape / AlterEventShape
  - packages/quereus-store/src/common/events.ts                                 # SchemaChangeEvent aliases the engine type; DataChangeEvent now extends it too
  - packages/quereus-store/src/common/store-module-alter.ts                     # emit block spreads the shared shape
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                         # mapSchemaMigrationType: maps 'column', exhaustive over objectType, now exported
  - packages/quereus-sync/test/sync/schema-migration-type-mapping.spec.ts       # NEW (review) — full (objectType × type) decision table
  - packages/quereus-store/test/alter-events.spec.ts                            # per-arm shape assertions + cross-backend parity spec
  - packages/quereus/test/alter-table-schema-events.spec.ts                      # tag-silence widened to all nine forms
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts      # 5 stale expectations updated
  - packages/quereus/src/runtime/emit/set-object-tags.ts                        # comment only — stale ticket reference re-pointed at docs
  - docs/sql-ddl.md                                                             # tags section: records that tag edits raise no event
  - docs/module-events.md                                                       # (review) auto-path `ddl` claim corrected; new "Don't hand-roll the ALTER TABLE event shape" section
----

# Store-backed `ALTER TABLE` reports the documented per-arm shape

## What the change was

`docs/usage.md` § *What each `ALTER TABLE` arm reports* promises that every structural arm
raises one schema-change event carrying the same fields regardless of storage backend. The
store backend reported `alter` / `table` for **every** arm, so a subscriber learned that a
table changed but not which column, and a `drop column` was indistinguishable from an
ordinary alteration.

The root cause was representational: `@quereus/store` declared its own narrower copy of the
event interface (no `'column'` object type, no `columnName` / `oldColumnName`), which made
the documented shape literally unrepresentable there. The fix:

- `SchemaChangeEvent` in `@quereus/store` is now an **alias** of the engine's
  `VTableSchemaChangeEvent` — one wire shape, one declaration.
- One exported helper, `alterEventShape(change)`, derives `type` / `objectType` /
  `columnName` / `oldColumnName` from the `SchemaChangeInfo` an arm was handed. Both
  emitter-backed backends (memory module, store) call it. Its `switch` is exhaustive over
  the arm union, so a new arm fails the build rather than announcing the wrong shape.
- `@quereus/sync`'s event → migration mapper was taught the newly-shaped events. Without
  that, the moment the store started saying `'column'`, every column `ALTER` would have
  silently stopped replicating.

Delivered behaviour against a `using store` table, now identical to memory-backed:

| Statement | before | after |
|---|---|---|
| `add column sku …` | `alter` / `table` | `alter` / `column`, `columnName: 'sku'` |
| `rename column v to vv` | `alter` / `table` | `alter` / `column`, `columnName: 'vv'`, `oldColumnName: 'v'` |
| `alter column vv …` (all attribute forms) | `alter` / `table` | `alter` / `column`, `columnName: 'vv'` |
| `drop column w` | `alter` / `table` | **`drop`** / `column`, `columnName: 'w'` |

Whole-table arms (`alter primary key`, add/drop/rename constraint) and `rename to` are
unchanged. The tag arms (`set`/`add`/`drop tags` at the table, column and named-constraint
sites) still raise nothing — already the behaviour and already documented; this ticket only
pinned all nine forms and made the decision findable from `docs/sql-ddl.md`.

## Review findings

Read the implement diff (`adee4a29c`) before the handoff summary, then read every file it
touched plus the ones it arguably should have: `docs/module-events.md`,
`docs/module-authoring-schema-changes.md`, `docs/usage.md`, `runtime/emit/alter-schema-event.ts`
and the ~10 hand-written engine-fallback emit sites, every `objectType` consumer in every
package's `src/`, and `StoreEventEmitter`'s remote-scope marking.

### Verified — the three things the handoff asked a reviewer to check

- **No path sends a column arm to `drop_table`.** Confirmed by reading: the mapper's
  `case 'column'` returns `alter_column` for both `alter` and `drop`. Now also pinned by a
  test (below). `alter_column` is the coarse "table definition changed" migration whose
  replay parses the carried `ddl` and decides per arm (`store-adapter.ts` §
  `decideAlterTable`), which already handles drop column.
- **The two untracked `(objectType, type)` combinations are unreachable today.**
  `create`/`column` is produced by no emit site — the engine and both modules report
  `alter`/`column` for ADD COLUMN. `alter`/`index` likewise: the only `ALTER … INDEX` syntax
  the parser accepts is `ALTER INDEX <name> {SET|ADD|DROP} TAGS`, and the tag arms emit
  nothing. Correct to leave them returning `undefined`; now pinned as such by a test so the
  silence is visible if either becomes reachable.
- **The public widening of `SchemaChangeEvent` is contained.** Swept every `objectType`
  reference in every package's `src/`. The only consumers that switch on it are the sync
  mapper (updated), `sync-manager-impl.ts`'s dropped-table logging filter
  (`'table' && 'drop'` — unaffected either way), and `quoomb-web`'s
  `sync-local-create-drain.ts` (`create` + `table`, with an existing test for ignoring
  `objectType: 'column'`). `StoreEventEmitter`'s remote-scope key is `(schemaName,
  objectName)`, and a column event's `objectName` is the table, so remote marking is
  unaffected.

### Major findings — none

No correctness, resource-cleanup, or error-handling defect survived the pass, so no new
`fix/`, `plan/`, or `backlog/` ticket was filed. The one structural duplication that remains
is guarded by tests and is recorded as a tripwire rather than a ticket (below).

### Minor findings — all fixed in this pass

- **`mapSchemaMigrationType` had no direct test.** End-to-end replication specs
  (`schema-alter-replication.spec.ts`, 32 cases) prove the *reachable* combinations work, but
  the mapping itself — and especially the combinations that deliberately return `undefined`
  and therefore record nothing and say nothing — was pinned nowhere. That silent-drop shape
  is exactly what caused this bug one level up. Exported the function (same pattern as
  `assertOpSeqInRange`, which the tests already import from this module directly, so the
  package's index surface is unchanged) and added
  `packages/quereus-sync/test/sync/schema-migration-type-mapping.spec.ts` — the full
  `(objectType × type)` table plus the `oldObjectName` rename discriminator, 11 cases.
- **`@quereus/store`'s `DataChangeEvent` was still a hand-maintained copy** of the engine's
  `VTableDataChangeEvent` — the identical pattern that caused this ticket in the sibling
  type, left in place one file away from the fix. It differed only by an extra legacy `pk`
  alias, so it now `extends VTableDataChangeEvent` and declares only `pk`. Typecheck clean
  across all workspaces.
- **`docs/module-events.md` contradicted itself about `ddl` on the auto path.** Line ~106
  says "always set for ALTER TABLE"; the *Modules without Native Events* section said "Auto
  DDL events carry no `ddl` text". The code agrees with the former for ALTER
  (`alter-schema-event.ts`) and with the latter for CREATE/DROP TABLE and CREATE/DROP INDEX
  (verified at `schema/manager.ts` lines 1587, 3022, 3092, 2554, 2780 — none pass `ddl`).
  Narrowed the sentence to say exactly that.
- **`docs/module-events.md` never told a module author the shape is a contract.** It shows
  how to build a native emitter but pointed at no shape guidance, and the newly exported
  `alterEventShape()` was undocumented — the "third backend hand-rolls its own reporting"
  hazard this ticket exists to close. Added a *Don't hand-roll the `ALTER TABLE` event shape*
  subsection with the emit-iff-`ddl` snippet and the `RENAME TO` carve-out.
- **The parity spec's doc comment was wrong in a way that invited someone to weaken it.**
  It claimed "both sides derive their shape from one shared helper", which would make the
  assertion tautological. In fact a default `new Database()` registers
  `new MemoryTableModule()` with **no** emitter (`core/database.ts`), so the memory column is
  produced by the engine's fallback (`runtime/emit/alter-table.ts`) while the store column
  comes from `alterEventShape` — a genuine cross-implementation comparison, and stronger than
  advertised. Corrected the comment and pointed at where the helper's *other* caller (the
  memory module's own emitter path) is pinned.

### Tripwire recorded, not ticketed

- The engine's fallback is a **third** producer that still writes the per-arm triples out by
  hand at ~10 sites in `runtime/emit/alter-table.ts` and `add-constraint.ts`; it emits at each
  arm's tail from per-arm locals with no `SchemaChangeInfo` in scope to derive from. Fine now
  — the cross-backend parity spec catches drift across all fourteen arms. `NOTE:` at
  `packages/quereus/src/vtab/alter-event-shape.ts` states the revisit condition: a fourth
  producer, or an arm union that outgrows the parity spec's hand-written statement list.

### Coverage assessed and judged adequate

- All three producers are pinned: engine fallback and memory-with-emitter in
  `packages/quereus/test/alter-table-schema-events.spec.ts`, engine-fallback-vs-store in the
  new parity describe, per-arm store shapes in `alter-events.spec.ts`.
- Error paths: the failed-ADD-COLUMN "announces nothing, not even its revert" cases were
  already present and still pass. Interaction: `add column … unique` still announces exactly
  one event with the column shape.
- The handoff's own noted gap — the parity spec's statement list is hand-written, so a *new*
  arm would not be run by it — is accepted as stated: the helper's exhaustive `switch` fails
  the build first, which is the stronger guard. Now also written down at the code site as the
  tripwire's revisit condition.
- The nine-form tag-silence test running on a memory-backed database only is also accepted:
  the tag arms never reach `module.alterTable` (they call `SchemaManager` setters directly),
  so the backend is not a variable there.

### Validation

All from repo root, all green, run after the review edits:

- `yarn build` — clean.
- `yarn typecheck` — clean across every workspace (this is what proves the `DataChangeEvent`
  base-type change breaks no consumer).
- `yarn lint` — clean.
- `yarn test` (full sweep before the review edits) — 0 failing. Re-ran every affected
  workspace after the edits: `@quereus/quereus` 9779 passing / 25 pending, `@quereus/store`
  1812, `@quereus/sync` **736** (was 725; +11 from the new decision-table spec),
  `@quereus/isolation` 420, `@quereus/quoomb-web` 68.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
