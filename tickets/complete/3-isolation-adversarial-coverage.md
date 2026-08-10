description: Added adversarial tests to the transaction-isolation layer for the genuinely-untested hard cases (one connection not seeing another's uncommitted writes, two connections writing the same key, range reads staying incremental), and corrected the storage plugins' help text that wrongly promised "snapshot isolation".
prereq:
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts (cross-connection describe; fullScan now reuses engine builder)
  - packages/quereus-isolation/test/merge-iterator.spec.ts (iteration-laziness describe)
  - packages/quereus-plugin-indexeddb/src/plugin.ts + README.md (corrected snapshot-isolation claim)
  - packages/quereus-plugin-leveldb/src/plugin.ts + README.md (corrected)
  - packages/quereus-plugin-nativescript-sqlite/src/plugin.ts + README.md (corrected)
  - packages/quereus-plugin-react-native-leveldb/src/plugin.ts + README.md (corrected)
difficulty: medium
----

## What shipped

Adversarial-gap test coverage for the isolation layer (`packages/quereus-isolation`):
**6 new tests, 0 duplicates** across two describes — cross-connection isolation
(read-your-own-writes vs sibling visibility, write-write last-writer-wins, commit-order
tiebreak, redundant-recommit no-op) and merge-iterator laziness (streaming, not
full-materialization). Suite: **230 passing**. All test-only in the isolation package;
no `src/` behavior changed there.

Review also corrected a **live documentation defect** the tests directly disprove — see
findings.

## Review findings

Read the implement diff (`a8c41b9e`) with fresh eyes before the handoff. Verified the
white-box APIs the tests drive (`setConnectionOverlay` / `getConnectionOverlay` /
`commitConnectionOverlays` / `getUnderlyingState` / `overlayModule` / `createOverlaySchema`)
all exist, and confirmed the asserted last-writer-wins semantics against
`flush.ts:71` (insert-vs-update decided by whether the PK already exists underlying) and
`commitConnectionOverlays` (clears each committed overlay). Ran `tsc -p tsconfig.test.json
--noEmit` (exit 0) and the isolation suite (230 passing) before and after every edit.

**Test quality (checked — no defect):**
- Not vacuous: the write-write tests assert both in-flight per-connection reads *and* the
  post-commit winner; the commit-order-flip test proves order (not fixed dbA precedence)
  decides. The laziness thresholds (`≤2`, `≤4`) are tight against actual pull counts
  (1 and ~3-4) and fail loudly at 100 under a materializing rewrite — real teeth.
- Cleanup present: `afterEach` closes both connections; laziness tests call `iter.return?.()`.

**Fixed inline (minor):**
- *DRY / drift risk* — the new cross-connection describe hand-rolled a `fullScan()`
  `FilterInfo` literal, duplicating the canonical `makeFullScanFilterInfo` (already imported
  in the same file, and whose whole reason for existing per `filter-info.ts` is "keep the
  several scan sites from drifting"). Replaced the literal with a reference to the engine
  builder. Tests still 230 green.
- *False "snapshot isolation" doc claim across 4 storage plugins* — `plugin.ts` JSDoc on the
  `isolation` settings field, plus README feature bullets/tables, in **indexeddb, leveldb,
  nativescript-sqlite, react-native-leveldb**, all advertised "snapshot isolation". That
  contradicts AGENTS.md ("read-your-own-writes; not snapshot isolation") and is exactly
  disproven by the new write-write test (last-writer-wins, no conflict detection). The prior
  doc-correction ticket (`complete/1-iso-doc-actual-isolation-guarantee`) swept only the
  isolation package + `docs/` + AGENTS.md/CLAUDE.md and **missed the plugins**. Corrected all
  8 source sites to "read-committed + read-your-own-writes, no write-write conflict detection
  — not snapshot isolation". The implement handoff called this "tracked by strategic rec #3";
  it was not tracked by any live ticket — hence the inline fix. `dist/*.d.ts` copies left
  alone (regenerate on build). The `dml-executor.ts` / `concurrent-scan.spec.ts` "snapshot
  isolation" mentions are a *different, correct* concept (per-scan vtab query snapshot) and
  were left untouched.

**Major findings → new tickets: none.** Nothing rose above a mechanical doc fix.

**Tripwires / floors (recorded, not ticketed):**
- The cross-connection tests exercise the flush/commit *resolution* via white-box overlay
  injection, not a statement-level `BEGIN…COMMIT` across two SQL sessions (this harness lets
  only one `Database` hold the SQL schema for a shared module). A two-engine-over-shared-store
  end-to-end would be higher-fidelity but heavier. Conditional; noted in the describe's header
  comment where a future editor meets it.
- The laziness guard is unit-level on `mergeStreams` (the primitive); it does not assert that
  `IsolatedTable.query` streams a bounded range incrementally end-to-end. A full-materialization
  regression introduced *above* `mergeStreams` would slip past it. Conditional; the
  merge-iterator laziness describe's comment already calls this out at the site.
- Coordination note for any future move toward snapshot isolation: the two `write-write` tests
  are the ones that must flip from last-writer-wins to first-committer-wins/abort. Called out
  inline in the cross-connection describe header.

**Not verified (out of scope for a doc-only change):** did not rebuild the 4 plugin packages —
edits are comment/README text with no runtime surface; their lint is an intentional no-op.

**Empty categories, explicitly:** no error-path or type-safety defects found (tsc clean, all
white-box APIs type-check against real signatures); no resource leaks (all connections/iterators
closed); no security surface (test + doc changes only).
