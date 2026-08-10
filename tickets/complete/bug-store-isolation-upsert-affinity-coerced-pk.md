---
description: |
  On a store-backed table wrapped in the transaction-isolation layer, an "insert … on conflict
  do update/nothing" whose key is written in a different form than it is stored (e.g. the text
  '1' into an integer key holding 1) wrongly threw away the existing row and kept the
  just-inserted one. Fixed by coercing the incoming row to the declared column types before the
  isolation layer probes for a conflict — but only for that probing, not for the actual write.
files:
  - packages/quereus-isolation/src/isolated-table.ts                # update() — coerceRow + coercedValues, fix site
  - packages/quereus-store/src/common/store-table.ts                # coerceRow (~:857) — reference mirrored
  - packages/quereus/src/vtab/memory/layer/manager.ts               # performInsert/performUpdate — overlay's OWN unconditional coercion
  - packages/quereus/src/types/json-type.ts                         # JSON_TYPE.parse (~:24) — non-idempotent for scalar-string JSON
  - packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic  # repro, now runs in both modes
  - packages/quereus/test/logic/03.6-type-system.sqllogic           # JSON-column case that guards the double-coercion hazard
  - packages/quereus/test/logic.spec.ts                             # MEMORY_ONLY_FILES entry removed
---

# Completed: isolation overlay coerces the incoming row before probing for an ON CONFLICT match

## What shipped

`IsolatedTable.update()` (`packages/quereus-isolation/src/isolated-table.ts`) now coerces the
incoming row to the declared column logical types once per call (`coercedValues`, via a private
`coerceRow` mirroring `StoreTable.coerceRow`) and feeds that coerced form to every conflict-detection
site: PK/newPK/targetPK extraction, `checkMergedPKConflict`, `checkMergedUniqueConstraints`'s
`newRow`, and the `keysEqual` PK-relocation checks. The actual overlay write still uses the **raw**
`values` — the overlay (a memory-module table) re-coerces every cell unconditionally on its own
insert/update, so writing the coerced row through would coerce twice, which throws for JSON scalar
strings (`JSON_TYPE.parse` is not idempotent). See the implement commit and the review findings below.

Result: a cross-storage-class proposed key (TEXT `'1'` into an `integer primary key` holding `1`)
now matches the stored row during probing instead of missing it and shadowing it with a fresh row.

## Validation (review pass)

- `yarn workspace @quereus/isolation build` — clean.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) — clean.
- `yarn test` (memory): 6879 passing, 9 pending, 0 failing.
- `yarn test:store` (LevelDB/store mode, the path this fix actually exercises): 6874 passing,
  14 pending, 0 failing.

## Review findings

**Verified correct (checked, nothing to change):**

- **Core coerced/raw split.** Traced every PK-derivation and conflict-detection site in `update()`
  (insert / update / delete arms, lines ~882–1050) — all now derive from `coercedValues`; every
  `overlayRow` write-content construction still uses raw `values`. Consistent: the stored PK ends up
  coerced (overlay re-coerces) and detection compares coerced-to-coerced. No stray raw-`values[i]`
  left in a detection or `keysEqual` path (grep-confirmed).
- **Load-bearing "overlay always re-coerces" claim.** Verified against
  `MemoryTableManager.performInsert` (`manager.ts:829-838`) and `performUpdate` (`:886-895`): both
  unconditionally `validateAndParse` every cell, no `preCoerced`/`args`-consulting shortcut. So
  passing raw values through is correct and passing coerced would double-coerce. Deviation from the
  original plan (which said to coerce the write too) is justified.
- **JSON non-idempotency.** Confirmed at `json-type.ts:24-38`: a JSON scalar string `'"hello"'`
  parses to native `hello`; re-parsing `hello` calls `safeJsonParse("hello")` → invalid → throws.
  The double-coercion hazard is real; the raw-write choice avoids it.
- **Regression guard for that hazard is real and already runs.** `03.6-type-system.sqllogic` inserts
  a JSON scalar into a JSON column in store mode; because the normal-insert write path
  (`overlayRow = [...(values ?? []), 0]`, line 947) is shared with the ON CONFLICT arms, a future
  "just coerce the write too" regression would fail 03.6 even though 03.6 never hits ON CONFLICT.
  The implementer's "known gap" (no JSON+ON-CONFLICT-specific test) is therefore marginal — the
  shared write path is already covered — so **no additional test filed.**
- **No off-by-one / schema-shape bug.** `coerceRow` uses the user schema (`this.tableSchema`, no
  tombstone column); `values` from the executor excludes the tombstone, so lengths line up and the
  "Too many values" guard can't false-trip. Short/default-filled rows coerce trailing-only, matching
  `StoreTable.coerceRow`.

**Minor — fixed in this pass:**

- Added a `NOTE:` tripwire at the `coercedValues` site (`isolated-table.ts` ~:871): the full row is
  now coerced twice per isolation-layer write (once here for detection, once in the overlay for
  storage — two `JSON.parse` for JSON columns). Negligible today; flagged in case isolation-write
  throughput or large-JSON rows ever show as hot, at which point threading a pre-coerced row is the
  fix. Recorded as a code comment, not a ticket.

**Major — new ticket filed:**

- **DRY:** the coerce-row loop now exists in ~4 near-identical copies across three packages
  (`StoreTable.coerceRow`, `IsolatedTable.coerceRow`, and two inline copies in
  `MemoryTableManager.performInsert`/`performUpdate`). A fix to one won't reach the others. Filed
  `backlog/debt-coerce-row-duplicated-across-vtab-backends.md` to extract one shared helper. Not done
  inline because it must edit `store-table.ts` + `manager.ts` (reference-only for this bug fix) and
  re-run the store suite — out of scope for a scoped bug fix.

**Not applicable / empty categories:**

- No error-handling, resource-cleanup, or type-safety findings — the change adds a pure function and
  reuses existing non-null-assertion conventions already pervasive in the file; no new resources,
  awaits, or catch sites introduced.
- No security surface (internal write-path coercion only).
