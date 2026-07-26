---
description: After an insert or update, features that report or mirror the saved row handed back the text the user typed instead of the value actually stored — so a JSON column read back as plain text in RETURNING, and a materialized view kept up to date row-by-row disagreed with the table it summarizes. The engine change is written and passing; what remains is locking it in with tests and updating the docs.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts             # THE CHANGE — already applied; storedRowOrRaw / withStoredNewSection
  - packages/quereus/test/logic/42-returning.sqllogic             # where the RETURNING regression cases belong
  - packages/quereus/test/logic/42.1-returning-extras.sqllogic
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic  # row-time MV maintenance parity cases
  - packages/quereus/test/logic/03.6-type-system.sqllogic
  - packages/quereus/docs/runtime.md                              # DML executor / write pipeline docs
  - packages/quereus/src/vtab/table.ts                            # UpdateResult.row contract — needs the "stored row" wording
difficulty: medium
---

# Post-write consumers must see the row the substrate stored

## What was wrong

When you write a row, the value you typed is not always the value the table
keeps. A column declared `json` given the text `'{"a":2}'` is stored as a real
JSON value; a column declared `integer` given the text `'7'` is stored as the
number `7`. That conversion happens down in the storage layer, inside
`vtab.update()`.

Everything the engine reported *about* the write was built from the row as it
was **before** conversion, so the same column had two observable values
depending on which door you looked through.

## What was done (already in the tree — do not redo it)

Direction (1) from the fix ticket: use the row the virtual table hands back.
`vtab.update()` already returns `result.row` — the row the substrate actually
stored, after its own coercion pass. The DML executor was ignoring it.

All of the change is in `packages/quereus/src/runtime/emit/dml-executor.ts`:

- Two new module-level helpers:
  - `storedRowOrRaw(resultRow, rawRow, columnCount)` — returns the substrate's
    row when present and of the right width, else falls back to the raw row.
    The fallback exists for the minimal test/sample virtual-table modules that
    echo their input (`sample-plugins/comprehensive-demo`, `test/vtab/test-*.ts`);
    those never coerce, so raw *is* stored for them.
  - `withStoredNewSection(flatRow, storedRow, rawNewRow, columnCount)` — rebuilds
    the flat OLD/NEW row with the NEW half (indices n..2n-1) replaced by the
    stored row, so `RETURNING` projects stored values. Returns `flatRow`
    untouched when the fallback fired, so the no-coercion case allocates nothing.
- `processInsertRow`, `processUpdateRow` and `executeUpsertUpdate` now compute a
  `storedRow` right after the write and use it for change tracking
  (`_recordInsert` / `_recordUpdate`), row-time materialized-view maintenance,
  the foreign-key cascade, the auto-emitted data event, the changed-column
  comparison, and the row yielded downstream.
- DELETE is deliberately untouched: it uses the OLD row read from the source
  scan, which is already a stored row, and `result.row` is *not* trustworthy for
  delete — the isolation layer returns a synthetic placeholder row with only the
  primary-key cells filled (`packages/quereus-isolation/src/isolated-table.ts`,
  the `placeholderRow` branch, ~line 1350).

### Why this is safe

- **Every real substrate returns a coerced row for insert/update.** Memory
  (`vtab/memory/layer/manager.ts` — `coerceRowToSchema`), store
  (`quereus-store/src/common/store-table.ts` — `coerceRow`), and the isolation
  overlay (`quereus-isolation/src/isolated-table.ts` — returns the overlay memory
  table's own coerced row, tombstone-sliced) all do.
- **No double coercion.** Nothing is coerced before it reaches the storage
  layer, so the `JSON_TYPE.parse` non-idempotency trap described in the fix
  ticket is never entered. That trap is what rules out the "coerce once, early"
  approach; it is tracked separately as `bug-json-string-scalar-not-round-trip-safe`.
- **No aliasing hazard.** `storedRow` is the substrate's own array. For the
  memory backend that array lives in the BTree — but the BTree freezes every
  stored entry (`inheritree` defaults `freeze: true`), and the executor already
  handed those same frozen arrays downstream today via `result.existingRow` /
  `result.replacedRow` / `result.evictedRows`. Every consumer traced
  (change-capture projection, materialized-view maintenance, FK actions,
  `RETURNING` emission, the row-context slot machinery) only reads or copies.
- **Not written / IGNORE is unchanged.** `if (!result.row) return undefined`
  still short-circuits before any of the new code.

### Verification already run

- `yarn test` — 7184 passing, 0 failing.
- `yarn test:store` — 7178 passing, 0 failing (the store substrate).
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file typecheck).
- Manual reproductions, all now correct and matching a subsequent `select`:
  `insert ... returning` and `update ... returning` on a `json` column and on an
  `integer`-affinity column; `on conflict do update ... returning`;
  `insert or replace ... returning`; an `update` that moves the primary key;
  `insert or ignore` on a conflict still yields no row; and a row-time-maintained
  materialized view grouping two whitespace-different spellings of the same JSON
  into one group instead of two.

Those reproductions were run from a scratch spec that was deleted. **Turning
them into committed tests is the main remaining job.**

## What is left

### Regression tests

There is currently no test that would catch a regression here. The reproductions
are all plain SQL, so they belong in the `.sqllogic` suite rather than a spec.

The `typeof(<col>)` trick is what makes the assertion sharp: compare what
`RETURNING` reports against what a following `select` reports, both value and
`typeof`.

### Docs

`packages/quereus/src/vtab/table.ts` documents `UpdateResult.row` only as
"new/updated row for INSERT/UPDATE". It is now load-bearing that this is the
**stored** row after the module's own coercion, and that a module which coerces
must return the coerced row. Say so, and say that `row` is not relied upon for
DELETE.

`packages/quereus/docs/runtime.md` (write pipeline / DML executor section) should
gain a short statement of the rule: the raw proposed row flows *down* to the
substrate, the stored row flows *back up* to every post-write consumer.

## Deliberately out of scope

- **The pre-write foreign-key RESTRICT comparison has the same class of bug and
  is filed separately** as `bug-fk-restrict-change-detection-uncoerced` in
  `tickets/fix/`. It compares a stored OLD row against a raw NEW row *before*
  `vtab.update()` runs, so there is no stored row yet and `result.row` cannot fix
  it. Confirmed reproducing on the current tree.
- **Making coercion idempotent** (direction (2) in the fix ticket) is the deeper
  eventual shape: it would let `emit/insert.ts` / `emit/update.ts` coerce once up
  front and retire `constraint-check.ts`'s separate coerced copy. It needs JSON to
  stop representing a JSON string scalar as a bare JS string, which is a
  type-system change with wide blast radius. Tracked as
  `bug-json-string-scalar-not-round-trip-safe` (fix/) and
  `bug-json-text-scalar-reparsed-on-write` (backlog/). Not needed for this work.
- One consequence worth knowing: for a `json` column holding a bare text scalar,
  `RETURNING` now shows the *corrupted* value that the storage layer's
  non-idempotent re-parse produced on update, rather than the clean input text.
  That is honest reporting of an existing storage defect, not a new one — it is
  exactly the bug `bug-json-string-scalar-not-round-trip-safe` owns.

## TODO

- Add RETURNING parity cases to `packages/quereus/test/logic/42.1-returning-extras.sqllogic`
  (or a new `42.2-returning-stored-row.sqllogic` if that file is getting long):
  for a `json` column and an `integer`-affinity column, assert that
  `insert ... returning <col>, typeof(<col>)` matches a following
  `select <col>, typeof(<col>)`, and likewise for `update ... returning`.
- Add the same parity assertion for the remaining write arms: `on conflict ...
  do update ... returning`, `insert or replace ... returning`, and an `update`
  that moves the primary key (`returning old.<pk>, <pk>, ...`).
- Add a negative case pinning that `insert or ignore` on a conflicting row still
  returns no rows at all.
- Add a row-time materialized-view parity case to
  `packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic`: create a
  materialized view grouping on a `json` column, insert two rows whose JSON is
  structurally equal but textually different (`'{"a":1}'` and `'{ "a" : 1 }'`),
  and assert the view holds one group with count 2 — i.e. that the incrementally
  maintained view agrees with the same view rebuilt from the base table.
- Update the `UpdateResult.row` doc comment on `VirtualTable.update` in
  `packages/quereus/src/vtab/table.ts`: it is the STORED row (post-coercion), a
  coercing module must return its coerced row, and it is not consulted for DELETE.
- Add the raw-down / stored-up rule to the DML executor section of
  `packages/quereus/docs/runtime.md`.
- Re-run `yarn test`, `yarn test:store`, and `yarn workspace @quereus/quereus run lint`.
