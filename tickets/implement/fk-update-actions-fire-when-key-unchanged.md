description: Updating any column of a parent row wrongly rewrote its child rows even when the column the children point at never changed; the one-line engine fix is in and verified, and this ticket adds the regression tests that keep it from coming back.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts        # executeForeignKeyActions — gate already applied here
  - packages/quereus/test/logic/41-foreign-keys.sqllogic       # value-level regression cases (see line ~800-872 for the existing sibling block)
  - packages/quereus/test/runtime/fk-cascade-reentry.spec.ts   # closest existing runtime FK spec; model the new event spec on it
  - packages/quereus/src/runtime/emit/dml-executor.ts          # the three UPDATE call sites (lines ~869, ~1082, ~1159)
difficulty: easy
---

# Regression coverage for the parent-update foreign-key action gate

## What was wrong, in plain terms

A foreign key's `on update` action (`cascade` / `set null` / `set default`) exists to
push a change in the parent's **referenced** columns down to the child rows. The action
executor never checked whether those columns actually changed — it re-issued the child
DML after *every* parent row update. So updating an unrelated column of a parent row
rewrote its children anyway.

## Reproduced (before the fix)

Against a plain in-memory database, `update p set other = 200 where id = 1` — which never
touches `p.id`, the column the child points at:

| child FK action | child before | child after | child data-change event |
|---|---|---|---|
| `on update set default` | `p_id = 1` | `p_id = 99` — **silent data loss** | update, `changedColumns: ["p_id"]` |
| `on update set null` (nullable child col) | `p_id = 1` | `p_id = null` — **silent data loss** | update |
| `on update set null` (non-nullable child col) | `p_id = 1` | statement fails: `NOT NULL constraint failed: c.p_id` | none |
| `on update cascade` | `p_id = 1` | `p_id = 1` (value survives) | **phantom** update event, `changedColumns: []` |

## The fix (already landed in the working tree)

`executeForeignKeyActions` (`packages/quereus/src/runtime/foreign-key-actions.ts`, in the
per-FK loop right after `parentColIndices` resolves) now applies the same short-circuit
every other enforcement site in that file already uses:

```ts
if (operation === 'update' && newRow !== undefined) {
    if (!anyReferencedColumnChanged(parentColIndices, oldRow, newRow)) continue;
}
```

`anyReferencedColumnChanged` is the existing shared helper (same file, ~line 99) used by
the RESTRICT pre-check, the batched-RESTRICT accumulator, the transitive pre-walk, and the
lens walker — so this is reuse, not a second comparison. By the time the executor runs, the
DML executor has already handed it the *stored* (type-coerced) new row, so the values
compared are apples-to-apples.

**Verified:** all six repro combinations (three actions × {untouched referenced column,
genuine re-key}) behave correctly after the change — untouched ⇒ child untouched and **no**
child data-change event; genuine re-key ⇒ the action still fires exactly as before. Full
`yarn workspace @quereus/quereus run test` is green (7343 passing, 0 failing) and
`typecheck` exits 0.

**Lens counterpart audited — no change needed.** The logical-FK walker already gates:
`resolveLensFkParentReferencedValues` (same file, ~line 783) calls
`anyReferencedColumnChanged` and returns `undefined` (⇒ skip the ref) when no referenced
column moved. Both the lens cascade walker and the lens RESTRICT pre-check share it.

## Why the existing tests missed this

`41-foreign-keys.sqllogic` already has a "cascade child untouched (no key change ⇒ no
propagating UPDATE)" assertion (~line 861). It passed *before* the fix, because `cascade`
rewrites the child to the value it already holds — the final value is correct either way.
A value-only assertion cannot see the phantom write. That is why the cascade case below
must assert the **absence of a child data-change event**, not just the child's value.

## What is left to do

Regression tests only. Two modalities, because value assertions and event assertions live
in different test harnesses.

### Gotcha the tests must respect

In Quereus a bare `p_id integer` column is **NOT NULL by default** (verified: inserting
`null` into it raises `NOT NULL constraint failed`). This is a deliberate divergence from
SQLite, not a bug. A `set null` child column therefore has to be declared
`p_id integer null` for the "child gets nulled" direction to be exercisable at all.

## TODO

Phase 1 — value-level regression cases in `packages/quereus/test/logic/41-foreign-keys.sqllogic`

- Add a block near the existing `crc_` / `crcj_` short-circuit blocks (~line 800-872) so
  the related cases read together. Use a distinct table-name prefix.
- `on update set default`: parent with an extra non-key column, child with
  `p_id integer default 99`, a second parent row `(99, ...)` so the default is a live
  parent key. Assert: after `update p set other = ... where id = 1` the child still reads
  `p_id = 1`; after a genuine `update p set id = 7 where id = 1` the child reads
  `p_id = 99`.
- `on update set null`: child column declared `p_id integer null`. Assert: untouched
  referenced column ⇒ child still `p_id = 1`; genuine re-key ⇒ child `p_id = null`.
- `on update cascade`: assert untouched ⇒ child still `p_id = 1`; genuine re-key ⇒ child
  follows to the new key. (Value-only here is fine — the event assertion lives in phase 2.)
- Also cover the non-nullable `set null` shape (bare `p_id integer`): an update that leaves
  the referenced column alone must now **succeed**, where it previously raised
  `NOT NULL constraint failed: c.p_id`. This is the case most likely to regress
  unnoticed, because the symptom was an error rather than bad data.

Phase 2 — change-event regression spec

- New spec, suggested `packages/quereus/test/runtime/fk-action-key-change-gate.spec.ts`.
  Model the setup/teardown on `packages/quereus/test/runtime/fk-cascade-reentry.spec.ts`
  (`new Database()`, `pragma foreign_keys = true`, `afterEach` close).
- Subscribe with `db.onDataChange(listener)` — the event carries
  `{ type, schemaName, tableName, key, oldRow, newRow, changedColumns, remote }`.
- Clear the captured events after seeding, run `update p set other = 200 where id = 1`,
  and assert **no** event with `tableName === 'c'` was emitted, for each of the three
  actions. Before the fix, cascade emitted one with `changedColumns: []`.
- Assert the positive direction too: a genuine re-key emits exactly one child event with
  `changedColumns: ['p_id']`.

Phase 3 — optional hardening (small, same file)

- `executeSingleFKAction` decides "cascade delete vs cascade update" purely from
  `newRow === undefined`. If a future caller ever passed `operation: 'update'` with no
  `newRow`, the cascade branch would issue a child **DELETE**. No current caller does —
  all three UPDATE sites in `dml-executor.ts` pass a non-optional row — so this is dormant,
  not a live defect. Consider a cheap guard (throw, or an explicit early return) in
  `executeForeignKeyActions` when `operation === 'update' && newRow === undefined`, rather
  than letting it fall through. Skip if it reads as noise.

Phase 4 — validation

- `yarn workspace @quereus/quereus run test` (green baseline is 7343 passing / 13 pending).
- `yarn workspace @quereus/quereus run lint` — the sqllogic additions do not need it, but
  the new spec file does (lint type-checks test files).
- No docs update identified as required; the behavior now matches what `docs/` already
  describes for the RESTRICT sites.
