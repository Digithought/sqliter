description: Deleting a row whose JSON column holds a plain piece of text inside a transaction on the persistent store used to do nothing or throw a confusing conversion error — this is now fixed and ready for review.
prereq:
files:
  - packages/quereus/src/vtab/table.ts                       # UpdateArgs.preCoerced doc updated (tombstone path is 2nd user)
  - packages/quereus/src/vtab/memory/table.ts                # MemoryTable.update forwards args.preCoerced
  - packages/quereus/src/vtab/memory/layer/manager.ts         # performMutation/performInsert/performUpdate thread preCoerced, skip coerceRowToSchema when set
  - packages/quereus-isolation/src/isolated-table.ts          # 3 tombstone writes now pass preCoerced: true (convert-to-tombstone ~1322, fresh-tombstone-insert ~1345, insertTombstoneForPK ~1540)
  - packages/quereus-store/test/json-semantic-key-order.spec.ts  # 4 new regression cases, isolated-store section
difficulty: easy
---

# Fix summary

Root cause was two independent gaps that let an already-converted stored value be
converted a second time (JSON conversion is not idempotent — see `docs/types.md`
§ "Where coercion happens (and why exactly once)"):

1. **Memory backend ignored `UpdateArgs.preCoerced`.** `MemoryTable.update` never
   forwarded `args.preCoerced` to `MemoryTableManager.performMutation`, and
   `performInsert`/`performUpdate` ran `coerceRowToSchema` unconditionally. Fixed:
   `preCoerced` now threads from `MemoryTable.update` → `performMutation` →
   `performInsert`/`performUpdate`, which skip `coerceRowToSchema` when set. This
   brings the memory backend in line with `StoreTable`, which already honored the
   flag.

2. **Isolation layer's delete-tombstone writes carried already-converted values
   without marking them.** Deleting a row inside a transaction writes a
   "tombstone" row into the per-connection overlay (a memory table) to hide the
   committed row; that tombstone's primary-key cells came from storage
   (already converted) but were written through `overlay.update()` without
   `preCoerced`, so the overlay's memory table converted them again. Fixed: the
   three tombstone-writing call sites in `isolated-table.ts` now pass
   `preCoerced: true`:
   - the delete branch's "convert existing overlay row to a tombstone" update
     (~line 1322, row sliced from a row the overlay itself already wrote)
   - the delete branch's "insert a fresh tombstone" (~line 1345, key cells from
     `oldKeyValues`, read from the source scan)
   - `insertTombstoneForPK` (~line 1540), the shared helper also used by the
     PK-change update path (~1255, ~1288) and the merged-UNIQUE-REPLACE eviction
     path (~1810) — all three of its callers already pass an already-coerced `pk`,
     so fixing the helper fixes all three.

   Everything else in `IsolatedTable.update` still passes **un**converted values
   to the overlay, which is deliberate (see the comment at ~line 1119) and is out
   of scope here.

**Side effect confirmed working, not separately tested:** `isolation-module.ts:941`
(overlay rebuild after a schema change) already passed `preCoerced: true` and was
silently ignored before this fix. It now behaves correctly automatically — no new
test added for this path specifically since it shares the same memory-backend fix
and the existing overlay-rebuild suite (`packages/quereus-store` DDL/ALTER logic
tests, all still green) exercises it indirectly.

Audited the other pre-existing `preCoerced: true` callers per the ticket
(`quereus-isolation/src/flush.ts:77` and `:85`, overlay→underlying flush) — both
already carry rows the overlay itself wrote, so both were already correct and
needed no change.

## Both repros from the ticket now behave correctly

```sql
create table d (j json primary key, v text) using store;
insert into d values ('"9"', 'a'), ('"9.0"', 'b');
delete from d where v = 'a';
-- now: exactly row '"9"' removed, '"9.0"' remains
```

```sql
create table d2 (j json primary key, v text) using store;
insert into d2 values ('"abc"', 'a');
delete from d2 where v = 'a';
-- now: row removed, no error
```

## Test coverage added

`packages/quereus-store/test/json-semantic-key-order.spec.ts`, new `describe`
block in the "JSON structural key order (isolated store)" section — 4 cases:

- delete of a JSON string-scalar key (`'"9"'`, sibling `'"9.0"'` present) in
  autocommit — removes exactly the targeted row
- same, inside an explicit `begin`/`commit` — checks both the staged
  (pre-commit) and post-commit state
- delete of a key whose text is not valid JSON source (`'"abc"'`) in
  autocommit — does not throw, row count reaches 0
- same, inside an explicit `begin`/`commit`

All 21 cases in this spec file pass; full `quereus-store` suite (1010 tests) and
the whole-workspace `yarn test` (7188 + 255 + 104 + 51 + 17 + 28 + 1010 + 481 + 52
+ 31 + 34 + 118 + 22, all green, zero failures) pass. `yarn build` and
`yarn workspace @quereus/quereus run lint` (the only package with a real lint —
eslint + a `tsc --noEmit` pass over test files) are clean.

## Known gaps for the reviewer

- **UPDATE-side symptoms are explicitly out of scope**, per the parent ticket —
  those are tracked separately under `json-coerce-once-at-dml-source`. This
  ticket only touches the DELETE/tombstone path.
- No new *unit* test directly targets `MemoryTableManager.performInsert` /
  `performUpdate` skipping `coerceRowToSchema` when `preCoerced` — coverage is
  end-to-end through the isolated-store SQL regression cases above (which do
  exercise the memory-backend fix, since the overlay itself is a memory table).
  If tighter unit coverage of the manager-level plumbing is wanted, that would be
  a new, narrower addition.
- Did not audit callers of `overlay.update()` beyond the three tombstone sites
  and the two `flush.ts` sites named in the parent ticket for other latent
  double-coercion opportunities in `isolated-table.ts`. The ticket's own review of
  the file (comment at ~line 1119) states the rest is deliberate un-coerced writes
  that stay correct until `json-coerce-once-at-dml-source` lands — trusted as-is,
  not independently re-verified line-by-line for this pass.
