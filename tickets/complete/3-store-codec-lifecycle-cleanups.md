description: Reviewed and accepted a store-package pass that fixes a failed-commit row-count leak, makes table rename carry its statistics, and de-duplicates a byte-to-hex helper plus a per-call encoder allocation.
prereq: store-tablekey-split-mis-routes-dotted-identifiers
files:
  - packages/quereus-store/src/common/transaction.ts            # commit() — failure fires onRollback for all callbacks
  - packages/quereus-store/src/common/store-module.ts           # renameTable (~2070) — stats re-keyed old→new
  - packages/quereus-store/src/common/serialization.ts          # hoisted module-level textEncoder
  - packages/quereus-store/src/common/bytes.ts                  # lookup-table bytesToHex + NOTE on main-pkg dups
  - packages/quereus-store/src/common/cached-kv-store.ts        # private toHex removed → routes through bytesToHex
  - packages/quereus-store/src/common/memory-store.ts           # keyToHex now aliases bytesToHex
  - packages/quereus-store/src/common/store-table.ts            # (read-only) real stats-callback pair verified
  - packages/quereus-store/src/common/events.ts                 # (read-only) emitDataChange swallows listener throws
  - packages/quereus-store/test/transaction.spec.ts             # commit-failure stats-clear tests
  - packages/quereus-store/test/rename-stats-migration.spec.ts  # rename keeps row count
  - packages/quereus-store/test/bytes.spec.ts                   # hex output + ordering invariant
----

# Complete: store codec + lifecycle cleanups

Four store-package changes reviewed and accepted **as-is** — no inline fixes were
required. Adversarial pass confirmed all four correct, well-tested, and
doc-consistent. `yarn workspace @quereus/store run test` → **910 passing**;
`yarn workspace @quereus/store run build` (tsc) → clean.

## What the change does (unchanged from implement handoff)

1. **Failed commit no longer leaks stats deltas (correctness).** A `notified` flag
   in `TransactionCoordinator.commit`; on any pre-notify throw the `finally` fires
   `onRollback` for every callback before `clearTransaction()`, so a commit that
   throws leaves every callback's pending row-count delta at 0 instead of leaking it
   into the next transaction on the module-wide coordinator.
2. **Rename migrates statistics.** `renameTable` now reads the old `__stats__` key,
   writes the value under the new key, then deletes the old key (was: delete-only,
   which reset a renamed table's `getEstimatedRowCount()` to 0 until re-gathered).
3. **One hoisted `TextEncoder`** reused across `serializeRow`/`serializeValue`/
   `serializeStats` instead of a per-call allocation.
4. **One fast `bytesToHex`** (256-entry lookup table); `cached-kv-store.ts`'s
   private `toHex` deleted and `memory-store.ts`'s `keyToHex` reduced to an alias.

## Review findings

### Checked and CONFIRMED correct

- **Item 1 — callback-failure semantics.** Read the real stats callbacks in
  `store-table.ts` (`applyPendingStats` folds `pendingStatsDelta` into `cachedStats`
  and zeroes it; `discardPendingStats` just zeroes). The coordinator-level test's
  `makeStatsTable()` model is faithful to that pair. Verified **no double-fire**: an
  explicit `rollback()` after a failed `commit()` is a no-op because `commit`'s
  `finally` already ran `clearTransaction()`, so `rollback()` early-returns on
  `!this.inTransaction`. Verified the discard path is only reached by a real I/O
  write throw (all deltas discarded cleanly, no callback applied yet) or the
  documented defensive `applyPendingStats`-throws corner — because `emitDataChange`
  (`events.ts:158`) swallows listener errors, the events loop inside the `try` cannot
  propagate. Invariant "a commit that throws leaves every delta at 0" holds.
- **Item 2 — rename ordering.** Traced the sequence in `renameTable`:
  `ddlCommitPendingOps` → `existing.dispose()` (flushes buffered stats **under the
  old key** — `flushStats` keys on the still-old `this.tableName`) → `renameTableStores`
  (data + index dirs only) → stats re-key. So the re-key read sees the current
  estimate even for row counts below the 100-row flush threshold. The
  `rename-stats-migration.spec.ts` provider mirrors the shipped unified-`__stats__`
  layout (getStatsStore ignores its table arg), so it exercises the real path.
- **Item 4 — ordering invariant.** New `bytesToHex` output is byte-identical to both
  removed helpers (lowercase, zero-padded, two chars/byte). Confirmed the test oracle
  matches the real store: `bytes.spec.ts` asserts against `localeCompare`, and
  `InMemoryKVStore` orders via `compareHex` which is also `localeCompare`
  (`memory-store.ts:32`). Store-package hex consolidation is complete — the only other
  `toString(16)` uses in `quereus-store/src` are `encoding.ts`'s 4-hex sort-value
  encoder and a type-prefix error string, neither a key encoder.
- **Item 3.** `TextEncoder` is stateless; a single shared instance is safe.

### Public API / external breakage — none

Both removed helpers were module-private (`cached-kv-store.ts`'s `toHex` never
exported; `memory-store.ts`'s `keyToHex` never exported). `bytesToHex`'s signature is
unchanged. No other package referenced them (the `toHex` in
`packages/quereus/src/util/key-tuple-codec.ts` is the separate main-package copy, not
this one). Store `build` (the consumer-facing surface for the leveldb/indexeddb
plugins) is green.

### Docs — checked, consistent, no update needed

`packages/quereus-store/README.md` already documents the unified `__stats__` store
(line 37) and that `renameTableStores` relocates data + index stores only (stats live
in the unified store and are re-keyed by `StoreModule`, which the code now does).
Nothing in the README claimed rename discards stats, and nothing documented the commit
callback-failure semantics that would now be stale.

### Tripwires (recorded, not filed as tickets)

- **`bytes.ts` top-of-file `NOTE:`** — ~10 other byte→hex encoders in
  `packages/quereus` (`util/serialization.ts`, `util/key-tuple-codec.ts`,
  `vtab/memory/utils/primary-key-encode.ts`, `planner/analysis/*`) duplicate this
  logic. Different package, different key concerns — a future consolidation, out of
  scope here. Parked at the code site by the implementer; left in place.
- **`store-module.ts` ~2079 `NOTE:`** — the rename re-key reaches the old value only
  when `getStatsStore(newName)` returns a store containing the old key (true for the
  shipped unified providers and for any provider that physically relocates a per-table
  stats store). A hypothetical provider with per-table stats stores that are NOT
  relocated by `renameTableStores` would orphan the value — but the old delete-only
  code lost it just the same, so no regression, and no shipped provider does this.
  Parked at the code site; left in place.

### Known gaps carried forward (accepted, not blocking)

- **`yarn test:store` (LevelDB-backed) not run** — validated against memory-backed
  `yarn test` only. Item 2 is the one that most warrants a real-provider spot-run; the
  unified-stats test provider models the real layout but is not the real store.
  Deferred to a human/CI spot-run rather than run inside the ticket (per store-suite
  runtime).
- **Item 1 end-to-end variant not added.** Tests are coordinator-level with a faithful
  callback model, not a live `StoreTable` DML forced to fail its commit. The
  coordinator model exercises the exact fixed code path; reaching a live `StoreTable`
  and forcing its commit to throw is fiddly and low marginal value given the path is
  already covered. Left as belt-and-suspenders for a future pass if desired.

### Empty categories (explicit)

- **No minor findings to fix inline** — the four changes are self-consistent, the
  ordering/aliasing invariants hold, and the tests cover happy path, both write-failure
  paths (atomic + fallback), the next-transaction-baseline regression, the clean-commit
  no-rollback case, and the hex ordering oracle.
- **No new major tickets filed** — nothing rose to the "reachable defect" bar; the two
  conditional concerns are genuinely conditional (tripwires above), not latent defects.

## Prereq

Depends on `store-tablekey-split-mis-routes-dotted-identifiers` (the
`tableKey.split('.')` dotted-identifier mis-route — a separate correctness bug), which
lands first.

## End
