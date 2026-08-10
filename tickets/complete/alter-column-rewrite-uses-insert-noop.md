description: Fixed a bug where changing an in-memory table column's type (or tightening it to NOT NULL) silently failed to update the rows already stored; review then found and fixed a follow-on bug where a partway-failed type change left some rows converted and some not.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # alterColumn: setDataType two-phase convert, setNotNull backfill, valuesRewritten rebuild gate
  - packages/quereus/test/logic/41.2-alter-column.sqllogic  # cases 7, 8, and new 9 (partial-failure all-or-nothing)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # updated pinned expectations
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts       # updated stale comment
  - docs/materialized-views.md  # "type-sensitive CHECK on the reshape arm" paragraph
----

## What shipped (implement stage)

`MemoryTableManager.alterColumn` rewrote already-stored rows via `tree.insert(newRow)` in two loops (SET DATA TYPE physical conversion, SET NOT NULL NULL-backfill). `inheritree`'s `BTree.insert` no-ops when the key already exists, and every rewritten row keeps its PK — so neither loop ever wrote anything. Converted/backfilled values were computed and discarded; `SET NOT NULL` reported success while leaving real NULLs behind.

Fix: `insert` → `upsert` (overwrites the entry in place) in both loops, plus a `valuesRewritten` flag gating `rebuildAllSecondaryIndexes()` so a secondary index on the altered column reflects the new values. Metadata-only paths set no flag and pay no rebuild.

The fix also surfaced that the MV refresh/reshape retype is a *physical* rewrite now (not metadata-only): `set data type` during a reshape converts the stored value in place but does not re-run the CHECK, so the documented "type-sensitive CHECK on the reshape arm" corner stays open with the value now genuinely `10` (integer) rather than `'10'` (text). The implementer updated the three pinned `it()` blocks, a sibling comment, and the docs paragraph to match.

## Review findings

Read the implement diff first with fresh eyes, then the handoff. Ran `yarn workspace @quereus/quereus run lint` (clean) and `yarn workspace @quereus/quereus test` (6902 passing / 13 pending / 0 failing) after every change.

**Checked — core mechanism (correct).** Verified against `inheritree/dist/b-tree.js`: `insert` skips the value update on an existing key (`internalInsert` returns `path.on === false`, `freezeEntry`/version-bump skipped); `upsert` overwrites in place. Both loops snapshot all target rows before mutating, so no mid-iteration tree mutation. Diagnosis and the `insert`→`upsert` fix are sound.

**MAJOR — fixed inline (correctness regression the fix introduced).** The SET DATA TYPE loop converted **and** upserted row-by-row in a single loop, and `validateAndParse` can throw mid-loop on an unconvertible value. With the old `insert` (no-op) this was harmless; with `upsert` a later row's conversion failure threw *after* earlier rows had already been physically rewritten in the base primary tree. The catch block only restores `primaryTree` on the collation+PK-rekey path (`basePrimaryTreeBeforeRekey`), never here — so a partway-failed `ALTER … SET DATA TYPE` left some rows converted (e.g. integer `10`) under the reverted old (text) schema: table corruption. Fixed by making the branch two-phase — convert **every** row up front (throw-only), mutate only after all conversions succeed. This mirrors the store backend's `alterColumnSetDataType`, which already did a throw-only convert pass before rewriting (confirmed at `store-module.ts:2006-2016`); the two backends now share the same all-or-nothing ordering. New sqllogic **case 9** (`41.2-alter-column.sqllogic`) pins it: `text → integer` where row 1 (`'10'`) is convertible and row 2 (`'abc'`) is not — the ALTER errors and BOTH rows stay as their original text values. This case fails against the pre-fix upsert-in-loop code and passes after.

**Checked — PK-column SET DATA TYPE (safe, both paths).** `upsert` would orphan the old key if the PK's own extracted key changed under conversion. Verified the path is blocked before reaching the mutation: the emit layer rejects it (`runtime/emit/alter-table.ts:952` — `Cannot SET DATA TYPE on PRIMARY KEY column`), and the MV reshape retype (which *does* route through `module.alterTable` → the same `alterColumn` branch) is forbidden by the reshape classifier — a key column's type change is "inexpressible" (`materialized-view-helpers.ts` `classifyBackingReshape`). No live upsert-orphan risk.

**Checked — SET NOT NULL backfill (safe).** The only throw (missing/NULL default) happens *before* the backfill loop; the loop itself only upserts. No partial-mutation window. No two-phase change needed.

**Checked — MV reshape re-derivation (the implementer asked for an independent read).** The retype-during-reshape now physically converts the stored value (`v: 10` integer) but does not re-run the CHECK, so the corner stays open (`v < '9'` numeric-false, row survives). The updated pins in `maintained-table-refresh-revalidation.spec.ts` (3 `it()` blocks) and `materialized-view-refresh-reshape.spec.ts`, plus the docs paragraph, are internally consistent and pass. Confirmed no other live doc/test still claims `set data type` is "metadata-only" (remaining hits are collation-related or archived complete tickets).

**Tripwire — recorded, not filed.** The `valuesRewritten` branch rebuilds **every** secondary index, not only those covering the altered column. Fine now (mirrors the collationChanged path's unconditional rebuild); only matters on a wide-index table where a rejected/successful retype shows up as slow. Parked as a `NOTE:` comment at the rebuild site in `manager.ts` (~line 2198).

**Docs.** `docs/materialized-views.md` "type-sensitive CHECK on the reshape arm" reflects the new physical-rewrite reality. No other doc touched by the change needs updating.

**Out of scope (unchanged from handoff).** Open-transaction ALTER is covered by `bug-alter-column-set-data-type-sees-transaction-rows`; this fix is scoped to the autocommit base-layer path.
