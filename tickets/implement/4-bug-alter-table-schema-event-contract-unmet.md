description: An application watching the database for structural changes is promised the same notification whether its data lives in memory or on disk, but the disk-backed storage says only "this table changed" without naming the column that was added, dropped or renamed. Making the two agree also requires the sync layer to keep recognising those notifications, or table alterations silently stop reaching other devices.
files:
  - packages/quereus/src/vtab/memory/module.ts                          # MemoryTableModule.alterEventShape (private static, ~line 1107) — the reference shape; extract it
  - packages/quereus/src/vtab/module.ts                                 # SchemaChangeInfo union (~line 709) — the helper's input
  - packages/quereus/src/vtab/events.ts                                 # VTableSchemaChangeEvent (~line 54) — the canonical event shape
  - packages/quereus/src/index.ts                                       # public export surface for the new helper
  - packages/quereus-store/src/common/events.ts                         # store's own SchemaChangeEvent (line 10) — a hand-copied duplicate that is too narrow
  - packages/quereus-store/src/common/store-module-alter.ts             # StoreModuleAlter.alterTable emit block (lines 142-149) — the single wrong site
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                 # mapSchemaMigrationType (~line 121) — drops objectType 'column' on the floor
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # lines 367/394/472/517/573/586 — expectations that read the old shape
  - packages/quereus-store/test/alter-events.spec.ts                    # widen from "an event happened" to "this event"
  - packages/quereus/src/runtime/emit/alter-table.ts                    # tag arms (runSet/Merge/DropTableTags et al., ~lines 1655-1760) — arm B, no code change
  - docs/usage.md                                                       # § What each ALTER TABLE arm reports (line 495) — the contract
  - docs/sql-ddl.md                                                     # § tags (~line 591/623) — arm B doc cross-reference
repro: verified
difficulty: medium
----

# Make the store backend's ALTER TABLE event match the documented per-arm shape

## What subscribers are promised

`docs/usage.md` § *What each `ALTER TABLE` arm reports* (line 495) promises that every
structural `ALTER TABLE` arm raises exactly one schema-change event, "whether or not the
storage backend ships an emitter of its own … so a subscriber sees the same facts either
way", and tabulates the per-arm shape:

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` | `alter` | `column` | table | altered column | — |

Whole-table arms (`alter primary key`, add/drop/rename constraint) report `alter` / `table`;
`rename to` additionally sets `oldObjectName`.

## Arm A — what the store backend actually reports (verified)

Verified on current `main` by running the four column arms against a default (memory-backed)
database and against a `using store` table with a `StoreEventEmitter`, and diffing the
delivered events:

| Statement | default backend | store backend |
|---|---|---|
| `add column sku …` | `alter` / `column`, `columnName: 'sku'` | `alter` / `table`, no `columnName` |
| `rename column v to vv` | `alter` / `column`, `columnName: 'vv'`, `oldColumnName: 'v'` | `alter` / `table`, neither name |
| `alter column vv set default 'x'` | `alter` / `column`, `columnName: 'vv'` | `alter` / `table`, no `columnName` |
| `drop column w` | **`drop`** / `column`, `columnName: 'w'` | `alter` / `table`, no `columnName` |

So a subscriber is told the table changed but not which column, and a `drop column` looks
like an ordinary alteration rather than a removal — the same statement reports differently
depending only on where the data happens to live. Both backends already agree on the
whole-table arms and on `ddl`.

The wrong site is one block: `StoreModuleAlter.alterTable`'s emit at
`packages/quereus-store/src/common/store-module-alter.ts:142-149`, which hardcodes
`type: 'alter', objectType: 'table'` for every arm. The reference implementation is
`MemoryTableModule.alterEventShape` (`packages/quereus/src/vtab/memory/module.ts:1107`), a
private static that derives the shape from the `SchemaChangeInfo` the arm was called with.

`StoreModuleRename.renameTable`'s emit (`store-module-rename.ts:310`) is already correct —
`alter` / `table` with `oldObjectName` — and must not change.

### Why the two shapes drifted, and the representational fix

`@quereus/store` declares its **own** `SchemaChangeEvent`
(`packages/quereus-store/src/common/events.ts:10`) as a hand-maintained copy of the engine's
`VTableSchemaChangeEvent` (`packages/quereus/src/vtab/events.ts:54`) — but a narrower one:
its `objectType` is `'table' | 'index'` (no `'column'`) and it has no `columnName` /
`oldColumnName` fields at all. The store module *could not* have emitted the documented
shape; the type forbade it. Two hand-maintained copies of one wire shape is the root cause,
so make the copy stop being a copy: `SchemaChangeEvent` should be an alias (or a
re-export) of `VTableSchemaChangeEvent`, which every store emit site already satisfies.

Beware a name collision while working: `packages/quereus/src/schema/change-events.ts` also
exports a type called `SchemaChangeEvent`. That is the engine's *internal* catalog change
notifier, unrelated to the public schema-change channel, and it must not be touched.

### The coupled site that makes this NOT a one-line change

`mapSchemaMigrationType` in `packages/quereus-sync/src/sync/sync-manager-impl.ts:121` maps a
delivered schema event to the migration the sync layer records. It handles
`objectType === 'table'` and `objectType === 'index'`, and **returns `undefined` for
anything else** — the caller then records nothing. Today every store-backed column ALTER
arrives as `objectType: 'table'` and is folded into an `alter_column` migration; the moment
the store starts reporting `objectType: 'column'`, all of them stop being recorded and
table alterations silently stop reaching peers.

This was confirmed, not inferred: applying the arm-A shape change alone and running
`packages/quereus-sync/test/sync/schema-alter-replication.spec.ts` turns 12 of its 32 cases
red (add column, drop column, rename column, every `alter column` sub-form, and the
multi-alteration / idempotency cases). Teaching `mapSchemaMigrationType` to map
`objectType === 'column'` → `'alter_column'` — for `type: 'drop'` (drop column) as well as
`type: 'alter'` — returns that file to 32 green.

Two notes for the implementer:

- A `drop column` must map to `alter_column`, **not** `drop_table`. `alter_column` is the
  coarse "table definition changed" migration whose replay parses the carried `ddl` and
  decides per arm (`store-adapter.ts` § `decideAlterTable`); it already handles drop column.
- The silent-drop behaviour is what made this a *silent* replication loss rather than a
  loud one. Make the `objectType` dispatch exhaustive with a `never` check on the fall-through,
  so a future new `objectType` fails the build instead of quietly disabling replication for
  it. Keep returning `undefined` for genuinely untracked *combinations* inside each branch
  (an `alter` on an index, say) — the exhaustiveness is over `objectType`, not over
  `(objectType, type)`.

Sync tests that only assert the *old* shape and need their expectations updated (they are
correct tests reading a now-changed fact, not defects):
`packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts` at lines 367, 394,
472, 517, 573 and 586, which assert tuples like `['alter', 'table', 'orders', true]` for
replayed column alterations. Five of the six went red under the experiment; check each
against the arm its case actually drives rather than rewriting all six blind.

Also verified green under the full experimental change: the whole `@quereus/store` suite
(1811 passing), `@quereus/isolation` (420 passing), and the rest of `@quereus/sync` beyond
the six expectation sites. No other package reads `objectType`
(`quoomb-web/src/worker/sync-local-create-drain.ts` filters on `create` + `table` only, so
it is unaffected).

## Arm B — tag statements: no code change, the decision is already made

The originating report asked whether `alter table … set tags / add tags / drop tags` should
raise a schema-change event, noting that they raise nothing today. Verified: nine tag
statement forms (table / column / named-constraint × SET / ADD / DROP), zero events.

That silence is **already documented as intentional**, and the documentation predates the
report. `docs/usage.md:532-534` states:

> Two arm families report nothing on either path: the metadata-tag arms (`set tags`,
> `add tags`, `drop tags`) and the materialized-view lifecycle arms (`set maintained`,
> `drop maintained`). Both are catalog-only and no backend announces them.

That paragraph landed in commit `3137013f8` (2026-07-29); the ticket was filed 2026-08-05.
So there is no contradiction to resolve and **no emit to add**. Tags are informational
metadata that the engine derives no behavior from (`docs/sql-ddl.md:591`), and mechanically
the tag arms never call `module.alterTable` at all — they go straight to the `SchemaManager`
setters — so an emitter-backed backend has no seam to announce from either.

What arm B is worth is making that decision **discoverable from where a reader lands**:
a `docs/sql-ddl.md` tags-section cross-reference, and a regression test so the silence is
pinned rather than incidental.

## Out of scope

- Adding schema-change events for tag or materialized-view-lifecycle arms (arm B above).
- The `alter_column` migration's coarseness — sync deliberately folds every table alteration
  into one migration type and replays the carried `ddl`. This ticket keeps that; it only
  stops the mapper from dropping the newly-shaped events.
- `docs/usage.md`'s contract table itself, which is already correct — the code is what moves.

## TODO

### Phase 1 — share one shape derivation

- Extract `MemoryTableModule.alterEventShape` into a standalone exported helper in the
  engine (suggested home: `packages/quereus/src/vtab/alter-event-shape.ts`) taking a
  `SchemaChangeInfo` and returning
  `Pick<VTableSchemaChangeEvent, 'type' | 'objectType' | 'columnName' | 'oldColumnName'>`.
  Keep the exhaustive `switch` over the `SchemaChangeInfo` union so a new arm fails the build.
- Re-export it from `packages/quereus/src/index.ts` alongside the other vtab event exports.
- Point `MemoryTableModule.alterTable` at the shared helper and delete the private static, so
  there is exactly one derivation.

### Phase 2 — widen the store's event type and use the shared shape

- Make `SchemaChangeEvent` in `packages/quereus-store/src/common/events.ts` an alias of (or
  re-export of) the engine's `VTableSchemaChangeEvent` instead of a narrower hand-copy, and
  note in a comment why it is not re-declared.
- Spread the shared helper's result into `StoreModuleAlter.alterTable`'s emit block
  (`store-module-alter.ts:142-149`), keeping the existing emit-iff-`change.ddl` gate and the
  comment above it exactly as they are.
- Leave `StoreModuleRename.renameTable`'s emit alone.
- Rebuild `@quereus/store` before running any cross-package test — `@quereus/sync`'s tests
  resolve `@quereus/store` through its built `dist`, so a src-only change is invisible to
  them and a run against a stale `dist` proves nothing.

### Phase 3 — keep replication working

- Teach `mapSchemaMigrationType` (`sync-manager-impl.ts:121`) to map `objectType === 'column'`
  to `'alter_column'` for both `type: 'alter'` and `type: 'drop'`.
- Make the `objectType` dispatch exhaustive with a `never` fall-through so a future object
  type cannot silently disable its own replication.
- Update the stale expectations in
  `packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts` (lines 367, 394,
  472, 517, 573, 586), per case rather than wholesale.

### Phase 4 — pin the contract in tests

- Widen `packages/quereus-store/test/alter-events.spec.ts` from asserting only that an event
  carrying `ddl` happened to asserting the full documented shape per arm — `type`,
  `objectType`, `objectName`, `columnName`, `oldColumnName` — for the four column arms, the
  whole-table arms and `rename to`. This is the assertion whose absence let the divergence
  survive.
- Add a case (either there or in the engine's suite) that runs the same statements against a
  default memory-backed database and asserts the two backends deliver identical shapes, so
  the "same facts either way" promise is pinned as a property rather than re-tabulated by hand.
- Add a regression test pinning arm B: the nine tag statement forms (table / column /
  named-constraint × SET / ADD / DROP) deliver zero schema-change events, with a comment
  pointing at `docs/usage.md` § What each `ALTER TABLE` arm reports for why that is the
  contract and not an oversight.

### Phase 5 — docs

- `docs/usage.md`: no change to the contract table — verify the shipped behaviour now matches
  it end to end and leave it.
- `docs/sql-ddl.md`: in the tags section (~line 591/623), add one sentence recording that tag
  changes raise no schema-change event because they are informational and catalog-only,
  cross-referencing `docs/usage.md` § What each `ALTER TABLE` arm reports. That is where a
  reader asking "does my tag edit notify anything?" actually lands.

### Validation

- `yarn workspace @quereus/store run build` (required before the cross-package runs).
- `yarn workspace @quereus/store run test` — 1811 passing at HEAD.
- `yarn workspace @quereus/sync run test` — 725 at HEAD; the six expectation sites above are
  the only ones this change should move.
- `yarn workspace @quereus/isolation run test` — 420 passing at HEAD.
- `yarn test`, `yarn typecheck`, `yarn lint`.
