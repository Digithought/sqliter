description: Fixed a bug where renaming a table on storage backends that don't support fast native moves (both mobile plugins) silently dropped all the table's rows; now those backends copy the data instead.
prereq:
files:
  - packages/quereus-store/src/common/store-module-rename.ts (new private `copyTableStores` fallback, wired into `renameTable`'s `if (this.provider.renameTableStores)` guard)
  - packages/quereus-store/src/common/kv-store.ts (`renameTableStores` doc comment now documents the fallback and its cost)
  - packages/quereus-store/test/rename-store-copy-fallback.spec.ts (new — fallback path coverage)
difficulty: easy
----

## What was implemented

`StoreModuleRename.renameTable` (`store-module-rename.ts`) called the
*optional* provider hook `renameTableStores` to physically relocate a table's
data + index stores during `ALTER TABLE ... RENAME TO`, but did nothing when a
provider omitted it — the catalog was rewritten under the new name regardless,
so the table's rows stayed keyed under the old name where nothing could reach
them. `select * from <newName>` silently returned zero rows.

Fix: when `provider.renameTableStores` is absent, `renameTable` now calls a
new private helper `copyTableStores(schemaName, oldName, newName, indexNames)`
that:

1. Opens the old and new data stores via the provider's REQUIRED
   `getStore`/`getIndexStore` (not the module's own caching `getStore`, so it
   never returns a stale cached handle) and streams every entry from old to
   new via `iterate()`/`put()` — one entry at a time, no whole-table
   buffering.
2. Repeats the same copy for each of the table's secondary-index stores
   (`indexNames`, the authoritative materialized index list already computed
   by `renameTable`, including hidden `_uc_*` UNIQUE-backing indexes).
3. Reclaims the old-named stores: calls `provider.deleteTableStores` if the
   provider implements it (both shipped mobile providers do — see below), or
   else falls back to closing the stale handles via the required
   `closeStore`/`closeIndexStore` and emits a `console.warn` (matching the
   `[StoreModule] ...` style already used elsewhere in this file) that the
   old-named data was left behind as an orphaned duplicate.
4. Does not swallow any failure. A thrown error inside the copy propagates
   straight out of `renameTable`, *before* the catalog rewrite — so a failed
   copy leaves the table durably discoverable under its OLD name (via the
   engine's `schema.removeTable`/`addTable` swap, which only happens after
   `module.renameTable` returns successfully — see
   `packages/quereus/src/runtime/emit/alter-table.ts:241-250`), not stranded
   under a new name pointing at incomplete data.

`KVStoreProvider.renameTableStores`'s doc comment (`kv-store.ts`) now states
what happens when a provider omits the hook: the generic copy fallback above,
correct but O(table size) and not backend-native-speed, with a pointer at
implementing the hook for an efficient move.

Both `@quereus/plugin-react-native-leveldb` and
`@quereus/plugin-nativescript-sqlite` ship `deleteTableStores` but not
`renameTableStores` — confirmed by grep before closing this out — so both now
get correct (if O(n), not instant) renames with **no plugin-side change**;
they exercise the `deleteTableStores` reclaim branch of the fallback, not the
`console.warn` orphan branch.

## Test coverage added

`packages/quereus-store/test/rename-store-copy-fallback.spec.ts`, against a
persistent in-memory provider modeled on `createPersistentProvider()` in
`rename-catalog-durability.spec.ts` but with `renameTableStores` *omitted*
(and `deleteTableStores` implemented, mirroring the two real mobile
providers):

- **Happy path**: creates a table with a secondary index (`create index ix_v
  on t (v)`), inserts 10 rows, asserts both the data store and the index
  store are populated pre-rename. Renames `t` → `t2`. Asserts: all 10 rows
  readable via `select ... from t2`; a predicate on the indexed column (`where
  v = 50`) still resolves correctly (this is what actually exercises the
  index-store copy arm, not just the data-store arm); the old-named data AND
  index stores no longer exist post-rename (via the test provider's own
  `stores` map — proves `deleteTableStores` reclaimed them, not just that the
  copy happened); the new-named stores hold exactly the copied rows.
- **Failure propagation**: patches the new-named data store's `put()` to
  throw on its first call, mid-copy. Asserts `alter table t rename to t2`
  throws (not swallowed), and that the table's original row is still readable
  under the OLD name `t` afterward — i.e. the catalog was never rewritten to
  point `newName` at an incomplete copy.

Ran `yarn workspace @quereus/store run test` (full suite, not just the new
file): **1377 passing, 0 failing**. Several *pre-existing* tests
(`alter-events.spec.ts`, `database-events.spec.ts`) use test-local providers
that also lack both `renameTableStores` and `deleteTableStores` — these now
print the new orphan `console.warn` (visible in the test run's stdout) but
still pass; they were silently hitting the exact bug this ticket fixes before
today and just weren't asserting on it.

`yarn workspace @quereus/store run typecheck` and `npx tsc -b
packages/quereus-store/tsconfig.json` both clean. `yarn workspace @quereus/store
run lint` is the package's intentional `echo 'No lint configured'` no-op (only
`packages/quereus` has a real lint per `AGENTS.md`) — not run against this
package's source.

## Gaps / things the reviewer should know

- **No test exercises the `console.warn`-orphan branch directly** (provider
  with neither `renameTableStores` nor `deleteTableStores`) — it's only
  incidentally exercised by pre-existing unrelated tests (see above), not
  asserted on. If you want tighter coverage, a small provider missing both
  hooks, asserting the warning fires and the old store handle is closed
  (`store.put()` throws “closed” afterward), would close that gap.
- **Not verified against the real LevelDB or IndexedDB providers** — only the
  in-memory test double. Both real store-backed plugins (`quereus-plugin-leveldb`,
  `quereus-plugin-indexeddb`) DO implement `renameTableStores` natively, so
  they never touch this fallback; only the two mobile plugins
  (`quereus-plugin-react-native-leveldb`, `quereus-plugin-nativescript-sqlite`)
  do, and neither package has an automated test suite in this repo to run
  against (no device/simulator harness here) — this is an acknowledged gap
  the ticket itself accepted (difficulty: easy, generic fallback specifically
  chosen to avoid needing per-backend mobile work).
- **Performance**: the fallback is a full read-then-write copy, single entry
  at a time, no batching. Fine for the ticket's stated goal (correctness over
  speed on backends that can't move natively) but a very large table renamed
  on a mobile backend will be slow. Already called out in the
  `renameTableStores` doc comment as the documented tradeoff, not something I
  consider a follow-up bug.
- I did not add batching to `copyEntries` (e.g. via `store.batch()`) — the
  ticket explicitly asked for a streaming one-at-a-time copy ("don't buffer
  the whole table in memory"), and `put()` per entry already satisfies that
  without introducing a batch-size tuning parameter. If profiling ever shows
  this path hot, batching in chunks (matching `DEFAULT_MAX_BATCH_BYTES`'s
  pattern in `store-module-base.ts`) would be the next step — not filed as a
  ticket since it's speculative until a real workload shows up.
