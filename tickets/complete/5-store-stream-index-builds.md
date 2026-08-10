description: Building a table index in the persistent store now flushes to disk in bounded chunks instead of holding the whole index in memory, a failed CREATE INDEX cleans up the half-built index, and a custom flush budget now survives closing and reopening the database.
files:
  - packages/quereus-store/src/common/store-module.ts        # DEFAULT_MAX_BATCH_BYTES + resolveMaxBatchBytes, StoreModuleConfig.maxBatchBytes, parseConfig, connect vtabArgs (fixed key), createIndex teardown, buildIndexEntries chunked flush, rebuildSecondaryIndexes budget
  - packages/quereus-store/src/common/store-table.ts         # StoreTableConfig.maxBatchBytes
  - packages/quereus-store/test/stream-index-build.spec.ts   # spec (now 7 tests; +1 reopen regression)
  - docs/store.md                                            # Configuration: documented collation + max_batch_bytes module options
----

# Complete: stream index builds in bounded chunks + clean up a failed CREATE INDEX

Bounded-memory index builds shipped. `StoreModule.buildIndexEntries` flushes its
write batch and starts a fresh one once accumulated serialized key bytes cross a
`max_batch_bytes` budget (module arg; default 8 MiB), so building an index on a
table larger than memory no longer buffers the whole index in one batch. A failed
`CREATE INDEX` now tears the freshly created index store down (new try/catch),
fixing a pre-existing empty-directory leak. See the implement handoff (commit
`ticket(implement): store-stream-index-builds`) for the full design rationale.

## Review findings

Reviewed the implement diff with fresh eyes, then the handoff. Checked: chunk
flush logic + byte accounting, teardown correctness vs `dropIndex`, the two
documented tripwires, config round-trip across reopen, type safety, docs, and the
full store test suite.

### Fixed inline (minor)

- **`max_batch_bytes` was silently dropped on reopen (real defect).** The implement
  handoff claimed the budget "persists across close→reopen for free," but it did
  not. `connect` receives the **raw DDL arg record** (snake_case keys —
  `effectiveModuleArgs` from `manager.ts`, `tableSchema.vtabArgs` from
  `runtime/utils.ts`), yet line 650 copied `options.maxBatchBytes` (camelCase),
  which is always `undefined` there. So `connect`'s config always fell back to the
  8 MiB default, and any table instance cached from that path (then returned by
  `getOrReconnectTable`) used the default for a later `CREATE INDEX` / `ALTER`
  rebuild — the configured knob vanished after reopen. Collation escaped the bug
  only because its arg key equals its config field name. **Fix:** read
  `options?.max_batch_bytes ?? options?.maxBatchBytes` (raw key first, parsed field
  as a defensive fallback). **Regression test added** — a reopen case that drives
  `rebuildSecondaryIndexes` via `ALTER ... SET COLLATE` and asserts the persisted
  tiny budget still chunks the rebuild (`nonEmptyFlushes > 1`); it **fails** on the
  old camelCase read and **passes** with the fix (both verified by toggling the
  source). Impact was bounded-memory/perf, not data correctness (the fallback was
  still a bounded 8 MiB, never unbounded) — hence minor, fixed here rather than
  a new ticket.

- **Docs (minor).** `docs/store.md` `## Configuration` documented neither
  `collation` nor the new `max_batch_bytes`. Added a "Module options" list covering
  both, noting persistence-across-reopen and that the budget bounds the write batch
  only (not the UNIQUE dedup set).

### Checked, no change needed

- **Chunk flush logic + byte accounting.** `batchBytes` only accrues on an actual
  `batch.put`; predicate-skipped and NULL-key rows never inflate it. `>=` threshold
  with `maxBatchBytes` clamped to a positive floor → no infinite loop even at a
  1-byte budget. Final `batch.write()` correctly handles the residual and the
  empty-table / exactly-hit-budget cases (providers accept an empty write). Both
  callers iterate the *data* store and write the *index* store (different stores),
  so a mid-stream flush never mutates the stream being read. Correct.

- **Failed-build teardown.** `createIndex`'s new try/catch mirrors `dropIndex`
  exactly (`releaseIndexStore` → `deleteIndexStore` else `closeIndexStore`), and the
  teardown is itself guarded so a teardown throw logs (`console.warn`, matching the
  file's convention) rather than masking the original build error. `getIndexStore`
  is deliberately outside the try — a failure there created nothing this module owns.
  Correct.

- **The two tripwires** (UNIQUE `seen` set unbounded for the whole build; the clear
  pass in `rebuildSecondaryIndexes` buffering all index keys into one batch) are
  appropriately recorded as `NOTE:` code comments at their exact sites, not tickets
  — genuinely conditional ("only if the index/key set ever dominates memory"). Left
  as-is; the associated backlog ticket `debt-store-atomic-batch-bounded-memory`
  covers the broader single-batch peak.

- **Pre-existing partial-ALTER-rebuild hazard.** Confirmed pre-existing (the clear +
  build were already two separate commits before this ticket); chunking does not
  widen it in kind. Not introduced here, out of scope.

### Not filed

No major findings → no new `fix`/`plan`/`backlog` tickets. No new tripwires beyond
the two the implementer already recorded.

## Validation

- New spec `packages/quereus-store/test/stream-index-build.spec.ts`: **7 passing**
  (6 original + 1 reopen regression).
- Full `@quereus/store` suite: **945 passing** (944 + the new test).
- `@quereus/store` `tsc --noEmit`: clean.

No pre-existing test failures surfaced; `tickets/.pre-existing-error.md` not written.
