---
description: Fixed a bug where renaming a table on storage backends that cannot move stored data natively (both mobile plugins) silently dropped all of the table's rows; those backends now copy the data instead.
files:
  - packages/quereus-store/src/common/store-module-rename.ts
  - packages/quereus-store/src/common/kv-store.ts
  - packages/quereus-store/test/rename-store-copy-fallback.spec.ts
  - docs/store.md
  - packages/quereus-store/README.md
---

## What shipped

`StoreModuleRename.renameTable` used to call the *optional* provider hook
`renameTableStores` to relocate a table's data and index stores during
`ALTER TABLE ... RENAME TO`, and do nothing at all when a provider omitted it — the catalog
was rewritten under the new name regardless, so the rows stayed keyed under the old name
where nothing could reach them and `select * from <newName>` returned zero rows.

When the hook is absent, `renameTable` now calls a private `copyTableStores` helper that:

- streams every entry from the old data store to the new one via the provider's REQUIRED
  `getStore` (one entry at a time, no whole-table buffering), then does the same for each
  secondary-index store in the authoritative `indexNames` list — which includes the hidden
  `_uc_*` index realizing a plain `UNIQUE` constraint;
- reclaims the old-named stores via `deleteTableStores` when the provider has it, else
  closes the stale handles and logs that the old-named copy was left behind;
- propagates any failure instead of swallowing it, so a failed copy stops *before* the
  catalog rewrite and the table stays reachable under its old name.

`renameTableStores`'s doc comment, `docs/store.md`, and `packages/quereus-store/README.md`
document the fallback and its O(table size) cost.

## Review findings

Reviewed the implement diff (88df0ebc) against `store-module-rename.ts`, `kv-store.ts`, all
four store provider plugins, and the rename docs.

**Fixed in this pass (minor):**

- *Test gaps the implementer flagged, plus one they did not.* Added three assertions' worth
  of coverage to `rename-store-copy-fallback.spec.ts`: (a) a `UNIQUE` constraint still
  rejects a duplicate of a pre-rename row after the rename — the hidden `_uc_*` index arm
  had no test, and this is the silent-corruption case the code comments call out; (b) the
  close-and-warn arm (a provider with neither `renameTableStores` nor `deleteTableStores`),
  asserting the old data and index handles are closed, the warning fires once, and the rows
  still moved. The provider double is now parameterized rather than duplicated.
- *Verified the new index-arm tests actually bite.* Temporarily neutered the index-copy loop
  and confirmed both the indexed-predicate test and the new `UNIQUE` test fail; restored.
- *Stale docs.* `docs/store.md` and the package README both described `renameTableStores` as
  optional without saying what happens when it is omitted, and the "accepted residues" list
  for rename covered only the native-move path. All three updated.

**Filed as a ticket (major):**

- *`deleteTableStores` does not delete on either mobile plugin.* Both
  `plugin-react-native-leveldb` and `plugin-nativescript-sqlite` implement it as *close the
  handle* — no data is erased. Two consequences: the fallback's reclaim arm silently leaves
  a full duplicate on device (and, because the hook exists, the orphan warning never fires),
  and — pre-existing, larger than this ticket — `drop table t; create table t (...)`
  resurrects the dropped table's rows into the new table. The implement handoff asserted the
  opposite ("they exercise the `deleteTableStores` reclaim branch"), which is where this
  started. Root cause is in the two plugins, not in the rename code, so:
  `tickets/backlog/bug-mobile-providers-delete-table-stores-only-closes.md`, with a
  provider-conformance-suite suggestion so the class is caught across plugins rather than
  one plugin at a time. It notes the overlap with the already-open
  `bug-mobile-provider-physical-store-name-collisions`, which touches the same two files for
  an unrelated defect. A pointer `NOTE:` sits at the reclaim call site.

**Recorded as tripwires, not tickets:**

- A failed copy leaves partially-written stores under the new name and nothing clears them;
  a retry copies over them key-by-key, so a row deleted between the two attempts would
  survive as a stale entry. Harmless today (first attempt writes into an empty destination,
  and retrying an unchanged table is idempotent). `NOTE:` on `copyTableStores`.
- Reclaim is best-effort by contract, per the plugin defect above. `NOTE:` at the call site.

**Checked and found clean:**

- *Failure ordering.* Every side effect that precedes the copy (dispose, cache eviction,
  connection eviction) is recoverable — the catalog is untouched, so the table reconnects
  under its old name. The copy runs before the catalog rewrite, matching the existing
  hazard note at the relocation site.
- *Case-only rename* (`t` → `T`), which would make source and destination the same physical
  store on the lowercasing providers and let the reclaim wipe the data: unreachable — the
  `this.tables.has(newKey)` guard at the top of `renameTable` is keyed lowercase and rejects
  it first.
- *Cache staleness.* The fallback goes through the provider directly, not the module's
  caching `getStore`, so it cannot pick up a stale handle; `this.stores` was already evicted
  for the old key earlier in `renameTable`.
- *Destination collisions.* `assertStoreNameFree` runs over the new data store name and every
  relocated index store name before the first side effect, so the copy cannot land on a live
  table's storage.
- *Stats.* The stats re-key runs after the copy against the unified `__stats__` store; no
  shipped provider's `deleteTableStores` touches stats entries, so the row-count estimate
  survives the fallback the same as the native path.
- *Performance.* The one-entry-at-a-time copy is the ticket's stated tradeoff (correctness on
  backends that cannot move natively), documented in the hook's doc comment. Not re-filed.

**Not covered — stated plainly:** neither mobile plugin has an automated test suite in this
repo (no device or simulator harness), so the fallback is verified only against an in-memory
provider double modeled on them. The ticket accepted that gap up front, and the ticket filed
above proposes the provider-conformance suite that would close it.

## Validation

- `yarn workspace @quereus/store run test` — 1379 passing, 0 failing (1377 before, +2 new).
- `yarn test` (all workspaces) — passing.
- `yarn typecheck` for `@quereus/store` — clean.
- `yarn lint` (all workspaces) — clean; `@quereus/store` has the intentional
  `echo 'No lint configured'` no-op, and this change touches no file in `packages/quereus`.
