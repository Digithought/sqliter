---
description: Deleting a row whose JSON column holds a plain piece of text used to either do nothing or throw a confusing conversion error — fixed and reviewed.
files:
  - packages/quereus/src/vtab/table.ts                            # UpdateArgs.preCoerced doc
  - packages/quereus/src/vtab/memory/table.ts                     # forwards args.preCoerced
  - packages/quereus/src/vtab/memory/layer/manager.ts             # performMutation/performInsert/performUpdate honor preCoerced
  - packages/quereus-isolation/src/isolated-table.ts              # 3 tombstone writes pass preCoerced
  - packages/quereus-store/test/json-semantic-key-order.spec.ts   # 6 regression cases
  - docs/types.md                                                 # preCoerced escape hatch documented
difficulty: easy
---

# What shipped

Values in a `json` column are converted from source text to a stored form once, on
the way into storage. That conversion is not repeatable: `'"abc"'` converts to the
plain text `abc`, and converting `abc` again throws. Two independent gaps let an
already-converted value be converted a second time on the delete path:

1. **The in-memory table backend ignored the "already converted" flag.**
   `MemoryTable.update` never forwarded `UpdateArgs.preCoerced` to the manager, and
   `performInsert`/`performUpdate` converted unconditionally. Now the flag threads
   through and both skip their conversion pass when it is set — matching the
   persistent store backend, which already honored it.

2. **The isolation layer's delete markers carried converted values unmarked.**
   Deleting a row inside a transaction writes a marker row ("tombstone") into the
   per-connection staging table so the committed row is hidden. Its key cells come
   from storage, already converted, but were written without the flag. The three
   tombstone-writing call sites in `isolated-table.ts` now set `preCoerced: true`
   (convert-existing-staged-row-to-marker, fresh-marker-insert, and the shared
   `insertTombstoneForPK` helper used by the primary-key-change update path and by
   `or replace` evictions).

Both repros from the original bug now behave: `delete` of a `'"9"'` key removes
exactly that row and leaves its `'"9.0"'` sibling, and `delete` of a `'"abc"'` key
no longer throws.

# Review findings

## Checked

- **Read the implement diff first**, before the handoff summary
  (`c1e50a97`, 5 source/test files).
- **Correctness of each `preCoerced: true` site.** Traced the provenance of every
  cell each of the three tombstone writes passes. All arrive already converted:
  `existingOverlayRow` is read back out of the staging table; `targetPK` is either
  `oldKeyValues` (from the source scan) or sliced from `coercedValues`;
  `insertTombstoneForPK`'s three callers pass `targetPK` (×2) and `conflict.pk`
  (read from a stored row). Non-key cells in a fresh marker row are `null`.
  Confirmed the *other* isolation-layer writes correctly do **not** set the flag —
  they pass raw user values that the staging table must still convert.
- **Blast radius of honoring the flag in the memory backend.** Enumerated every
  caller that sets `preCoerced`. Only `quereus-isolation` does: the two flush
  writes (target the store backend, unchanged behavior), the three tombstone
  writes (this fix), and the overlay-rebuild-after-schema-change write at
  `isolation-module.ts:941`, which was silently ignored before and now takes
  effect. That last one was the real risk in this change, so it was probed
  directly (see below). No other package sets the flag, so no non-isolation
  consumer of `MemoryTable` changes behavior.
- **Lint and tests.** `yarn build` clean; `yarn workspace @quereus/quereus run lint`
  clean; full `yarn test` green — 7188 + 255 + 104 + 51 + 17 + 28 + 1012 + 481 + 52
  + 31 + 34 + 118 + 22, zero failures. No pre-existing failures surfaced, so
  `tickets/.pre-existing-error.md` was not written.
- **Docs.** Read every doc that mentions where conversion happens
  (`docs/types.md`, `docs/runtime.md`) rather than assuming they were current.

## Found and fixed in this pass (minor)

- **Test gap: two of the three fixed call sites had no coverage.** The four
  handed-off cases all exercise the fresh-marker-insert path only. Added two
  regression cases to `json-semantic-key-order.spec.ts`: one that stages a row in
  the same transaction before deleting it (the convert-existing-row-to-marker
  write), and one where an `or replace` on a `unique` column evicts a row (the
  `insertTombstoneForPK` helper). **Both were verified to actually fail without
  the fix** by disabling it in the built output and re-running — the first left the
  deleted row visible, the second left a duplicate that violates the very `unique`
  constraint that triggered the eviction. Spec now at 23 cases, all green.
- **Stale comment in `isolated-table.ts` (~1119).** It asserted the staging table
  "always re-coerces every cell … unconditionally", which this change made false.
  Rewritten to state the actual rule and name the tombstone writes as the
  exception. Its adjoining performance note, which suggested threading a
  pre-converted row through as a future optimization, now points at the flag that
  makes that possible.
- **Stale docs in `docs/types.md` § "Where coercion happens (and why exactly
  once)".** Said the storage layer converts "unconditionally"; it now documents
  `UpdateArgs.preCoerced` as the single escape hatch, who uses it, and why. The
  adjacent note about the isolation layer declining to thread its converted row
  was likewise narrowed to exclude the tombstone writes. `docs/runtime.md`'s
  parallel passage was read and left alone — it describes the DML executor path,
  where the flag is never set, so it stays accurate.

## Found and filed as a new ticket (major, but out of scope here)

- **`backlog/bug-add-column-default-not-coerced.md`** — `alter table … add column
  c <type> default <literal>` fills pre-existing rows with the literal's raw text
  instead of converting it to the column's declared type, while a later `insert`
  under the same default does convert. Reproduced on a plain memory table with no
  isolation layer and no store involved, so it is independent of this change and
  was not introduced by it. Worth noting it interacts with this fix in a *good*
  way: before, the staging-table copy of a backfilled row got converted while the
  committed copy did not, so the two diverged; now both agree (on the wrong value).

## Recorded as a tripwire, not a ticket

- Skipping the conversion pass also skips its "too many values" row-width guard.
  Every `preCoerced` caller today builds its row programmatically from the same
  schema, so the width is structural and cannot drift. Parked as a `NOTE:` comment
  at the exact site (`manager.ts`, `performInsert`) saying what to do if an
  externally-shaped row ever arrives with the flag set.

## Checked and clean — nothing found

- **Source hygiene.** The diff is small and each site carries a short comment
  explaining *why* the flag is set, not what the line does. No function grew, no
  file grew meaningfully, nothing needed decomposition. `performMutation` picked up
  a sixth positional parameter, which is at the edge of comfortable but matches the
  surrounding signature style; converting it to an options object would be churn
  beyond this ticket.
- **Resource cleanup / error handling.** The change adds no allocation, no
  handle, and no new failure mode — it only elides a call. The overlay-rebuild
  paths that now behave differently already free their half-built table on any
  throw.
- **Type safety.** No `any`, no cast introduced; `preCoerced?: boolean` threads
  through with explicit types at each hop.

## Known gaps carried forward, deliberately

- **The UPDATE-side symptoms remain broken and are not this ticket's job** —
  tracked under `json-coerce-once-at-dml-source`. Concretely, `update t set v = …`
  on a row with a JSON string-scalar key still passes the row's converted key back
  as a raw value. This is why the new convert-to-marker regression case stages its
  row with `insert or replace` rather than `update`.
- **The primary-key-change update path** through `insertTombstoneForPK` (two of the
  helper's three callers) still has no direct regression case, because reaching it
  requires updating a JSON primary key — which is exactly the broken UPDATE path
  above. Its sibling caller (the `or replace` eviction) is now covered, and it is
  the same helper, so the fix is exercised; the specific path is not.
