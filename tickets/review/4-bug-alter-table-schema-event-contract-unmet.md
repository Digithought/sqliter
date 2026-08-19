description: A program watching the database for structural changes now hears the same thing whether its data lives in memory or on disk — disk-backed tables finally say which column was added, dropped, or renamed instead of only "this table changed", and the device-sync layer was taught to keep recognising those messages so table alterations still reach other devices.
files:
  - packages/quereus/src/vtab/alter-event-shape.ts                          # NEW — the one shared shape derivation
  - packages/quereus/src/vtab/memory/module.ts                              # now calls the shared helper; private static deleted
  - packages/quereus/src/index.ts                                           # exports alterEventShape / AlterEventShape
  - packages/quereus-store/src/common/events.ts                             # SchemaChangeEvent is now an alias of VTableSchemaChangeEvent
  - packages/quereus-store/src/common/store-module-alter.ts                 # emit block spreads the shared shape (line ~143)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                     # mapSchemaMigrationType: maps 'column', exhaustive over objectType (~line 130)
  - packages/quereus-store/test/alter-events.spec.ts                        # per-arm shape assertions + new cross-backend parity spec
  - packages/quereus/test/alter-table-schema-events.spec.ts                 # tag-silence widened to all nine forms
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # 5 stale expectations updated
  - packages/quereus/src/runtime/emit/set-object-tags.ts                    # comment only — stale ticket reference re-pointed at docs
  - docs/sql-ddl.md                                                         # tags section: records that tag edits raise no event
difficulty: medium
----

# Review: store-backed ALTER TABLE now reports the documented per-arm shape

## What changed, in one paragraph

`docs/usage.md` § *What each `ALTER TABLE` arm reports* promises every structural arm raises
one schema-change event with the same fields regardless of storage backend. The store
backend was reporting `alter` / `table` for **every** arm — a subscriber learned the table
changed but not which column, and a `drop column` looked like an ordinary alteration. The
root cause was representational: `@quereus/store` declared its own narrower copy of the
event type (no `'column'` object type, no `columnName`), so the documented shape was
literally unrepresentable there. The copy is now an alias of the engine's type, one shared
`alterEventShape()` helper derives the per-arm shape for both backends, and the sync layer's
event → migration mapper was taught the newly-shaped events so replication keeps working.

## The four behaviour changes a reviewer should verify

Against a `using store` table with a `StoreEventEmitter`, the delivered event is now:

| Statement | before | after (= what memory-backed already did) |
|---|---|---|
| `add column sku …` | `alter` / `table` | `alter` / `column`, `columnName: 'sku'` |
| `rename column v to vv` | `alter` / `table` | `alter` / `column`, `columnName: 'vv'`, `oldColumnName: 'v'` |
| `alter column vv set default 'x'` | `alter` / `table` | `alter` / `column`, `columnName: 'vv'` |
| `drop column w` | `alter` / `table` | **`drop`** / `column`, `columnName: 'w'` |

Whole-table arms (`alter primary key`, add/drop/rename constraint) and `rename to` are
unchanged, and `StoreModuleRename.renameTable`'s emit was deliberately left alone.

## Use cases to exercise

**The contract itself.** Subscribe with `db.onSchemaChange`, run each arm above against a
store-backed table, and check `type` / `objectType` / `objectName` / `columnName` /
`oldColumnName`. Then run the identical statements against a plain `new Database()` and
diff — they must be identical. That "same facts either way" property is now pinned as a
test rather than as two hand-written expectation lists (`alter-events.spec.ts`, describe
*Store-backed and memory-backed ALTER TABLE deliver the same schema-event shapes*).

**Replication still works.** This is the coupled site that made the change non-trivial.
`mapSchemaMigrationType` previously returned `undefined` for anything that was not
`objectType: 'table'` or `'index'`, and the caller then recorded nothing — so the moment the
store started saying `'column'`, every column ALTER would have silently stopped reaching
peers. Exercise: two synced databases, run `add column` / `drop column` / `rename column` /
each `alter column` sub-form on one, confirm the other converges.
`packages/quereus-sync/test/sync/schema-alter-replication.spec.ts` (32 cases) is the direct
guard and is green.

**`drop column` must map to `alter_column`, not `drop_table`.** `alter_column` is the coarse
"table definition changed" migration whose replay parses the carried `ddl` and decides per
arm (`store-adapter.ts` § `decideAlterTable`); it already handles drop column. A reviewer
checking the mapper should confirm no path can send a column arm to `drop_table` — that
would drop the peer's table.

**Tag statements stay silent (no code changed).** `set tags` / `add tags` / `drop tags` at
the table, column and named-constraint sites raise nothing. That was already documented and
was already the behaviour; this ticket only pinned it (all nine forms) and made the decision
findable from the tags section of `docs/sql-ddl.md`.

## Validation run

All from repo root, all green:

- `yarn build` — clean.
- `yarn typecheck` — clean (this is what proves no other package was relying on the store's
  narrower `objectType`).
- `yarn lint` — clean.
- `yarn test` — every workspace passing, 0 failing. Notable counts: `@quereus/quereus` 9779,
  `@quereus/store` 1812 (was 1811 — the new parity case), `@quereus/sync` 725,
  `@quereus/isolation` 420.
- `@quereus/store` was rebuilt before the cross-package runs; `@quereus/sync`'s tests resolve
  `@quereus/store` through its built `dist`, so a src-only change is invisible to them.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps and things worth a second pair of eyes

- **The parity test's statement list is hand-written, not generated.** It covers all fourteen
  structural arms on one fixture table, but a *new* arm added to `SchemaChangeInfo` would be
  caught by the helper's exhaustive `switch` (build failure) and not by the parity test
  (which would simply never run it). The build failure is the real guard; the parity test
  guards the two backends agreeing on the arms that exist.
- **The mapper's exhaustiveness is over `objectType` only.** An untracked
  `(objectType, type)` *combination* inside a branch — an `alter` on an index, a `create` on
  a column — still returns `undefined` silently. That is deliberate and stated in the doc
  comment, but it is the same silent-drop shape that caused this bug at one level up, so it
  is worth a reviewer's judgement on whether any of those combinations is reachable today.
  (`create`/`column` is not emitted by any site; `alter`/`index` is not either.)
- **`SchemaChangeEvent` exported from `@quereus/store` is now wider.** Any out-of-tree
  consumer that exhaustively switched on `objectType` expecting `'table' | 'index'` will now
  see `'column'`. That widening *is* the fix, but it is a public type change. In-tree
  consumers were checked: `quoomb-web/src/worker/sync-local-create-drain.ts` filters on
  `create` + `table` and already has a test for ignoring `objectType: 'column'`.
- **The nine-form tag-silence test runs on a default memory-backed database only.** The tag
  arms never call `module.alterTable` at all — they go straight to the `SchemaManager`
  setters — so the backend is not a variable there. A store-backed duplicate would add
  runtime without adding coverage; if a reviewer disagrees, it is a three-line addition to
  `packages/quereus-store/test/alter-events.spec.ts`.
- **Two stale references to a deleted ticket were re-pointed at the docs** rather than left
  dangling: `packages/quereus/src/runtime/emit/set-object-tags.ts` and the header comment of
  `packages/quereus/test/alter-table-schema-events.spec.ts` both named
  `backlog/feat-alter-table-tags-emit-no-schema-event`, which no longer exists (it was folded
  into this ticket). Both now cite `docs/usage.md` § What each `ALTER TABLE` arm reports.
  Comment-only edits, but they are outside the strict blast radius of the bug.
- **Five sync expectations were updated, not six.** The ticket listed six candidate sites in
  `schema-replication-idempotency.spec.ts`; the sixth (line ~472, `add unique (sku)`) drives
  the `addConstraint` arm, which correctly still reports `alter` / `table` and was left
  alone. Each of the five was checked against the arm its case actually drives.
