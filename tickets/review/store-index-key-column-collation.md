---
description: The persistent store now writes each secondary index's text values using the rule declared on the indexed column itself, instead of one table-wide text-sorting rule, so stored bytes agree with how the database actually compares those values. Review the write/read/rebuild/merge paths that all had to move together.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # NEW resolveIndexKeyCollations
  - packages/quereus-store/src/common/key-builder.ts                # buildIndexKey reshaped to two IndexKeyHalf objects; buildIndexPrefixBounds gains collations
  - packages/quereus-store/src/common/store-table-base.ts           # validateKeyCollations over index key collations; NEW assertIndexKeyCollationsCanKey
  - packages/quereus-store/src/common/store-table-scan.ts           # indexKeyCollations helper (memoized), threading, NEW getIndexComparator
  - packages/quereus-store/src/common/store-table-constraints.ts    # updateSecondaryIndexes, findIndexForUniqueConstraint (_uc_ preference), indexSeekHonorsEnforcementCollation restated, findUniqueConflictViaIndex
  - packages/quereus-store/src/common/store-module-index-build.ts   # buildIndexEntries threads index collations
  - packages/quereus-store/src/common/store-module-index.ts         # createIndex pre-validates index key collations
  - packages/quereus-store/src/common/store-module-alter-column.ts  # SET COLLATE on indexed non-PK column now rebuilds covering indexes
  - packages/quereus-store/src/common/store-module-schema-sync.ts   # NEW per-table try/catch + eviction in the rehydrate reconcile loop (not in the ticket spec — see gaps)
  - packages/quereus-store/src/common/implicit-unique-index.ts      # stale comment fixed (gate now load-bearing)
  - packages/quereus-isolation/src/isolated-table.ts                # doc-only: buildDescriptorComparators / preference comment
  - packages/quereus/src/index.ts                                   # exports CompareFn (one-line addition)
  - packages/quereus-store/test/index-column-collation.spec.ts      # NEW, 19 tests
  - packages/quereus-store/test/key-builder.spec.ts                 # updated to new buildIndexKey shape + per-column collation test
  - packages/quereus-store/test/custom-collation-key.spec.ts        # two tests rewritten to the new contract (old premise obsolete)
  - docs/store.md                                                   # per-column index key collation, SET COLLATE rebuild, re-index-on-upgrade note
---

# Review: secondary-index columns now key under the column's collation, not the table key collation

## What changed, in one paragraph

A store table's secondary-index KEY bytes used to encode every text index-column value
under the table key collation K (`collation = …` module option, default NOCASE). Every
comparison against those values — the scan residual, the planner's cover analysis,
UNIQUE enforcement — already used the index column's own effective collation C
(index `COLLATE` ?? table column collation ?? BINARY). The bytes now encode under C,
via a new `resolveIndexKeyCollations` (pk-key-resolution.ts) threaded through every
site that writes, seeks, rebuilds, or merges index bytes. The PK suffix and data-store
bytes are unchanged.

## The five encode/seek sites that must stay byte-identical

All resolve through `resolveIndexKeyCollations` (directly, or via the memoized
`StoreTableScan.indexKeyCollations`):

- `StoreTableConstraints.updateSecondaryIndexes` — DML maintenance (delete + insert)
- `buildIndexEntries` (store-module-index-build.ts) — CREATE INDEX and every rebuild
- `StoreTableConstraints.findUniqueConflictViaIndex` — UNIQUE enforcement seek
- `StoreTableScan.analyzeIndexAccess` / `buildIndexRangeBounds` — read windows
- `StoreTableScan.scanMultiSeek` — per-IN-tuple windows (fold now under C)

`buildIndexKey` was reshaped from 8 positional args into two symmetric
`{ values, directions, collations, transforms }` halves (`IndexKeyHalf`), per the
ticket's recommendation. `buildIndexPrefixBounds` gained a positional `collations`
param in the same slot order as `buildPkPrefixBounds`.

## Decisions a reviewer should check hardest

1. **`resolveIndexKeyCollations` deviates slightly from the ticket's suggested
   snippet, deliberately.** The ticket's code passed `col.collation ?? tableCol.collation`
   into `pkKeyCollationName`, whose textual branch returns that collation *verbatim* —
   so an undecorated text column would have come back `undefined` and silently fallen
   back to K at encode time, the exact bug being fixed. The implementation passes
   `?? 'BINARY'` so `undefined` means never-text only. The doc comment states this.

2. **`findIndexForUniqueConstraint`** now prefers, among column-set matches, the index
   named `implicitUniqueIndexName(schema, uc)` (the constraint's own `_uc_*`), falling
   back to the first match otherwise. The name-first lookup is *scoped to the
   column-set candidates* — a user index squatting on the `_uc_*` name with different
   columns is never picked. The reachable silent-duplicate case
   (explicit `collate binary` index + NOCASE `unique(email)`) is tested directly.

3. **`indexSeekHonorsEnforcementCollation`** is restated as exact per-column equality
   between `resolveIndexKeyCollations(index, …)` and `uniqueEnforcementCollations(schema, uc)`
   (upper-cased, never-text exempt), and now takes the chosen index. Kept because the
   name-squatting path in `withImplicitUniqueIndexes` can still hand the fallback a
   collation-divergent same-columns index.

4. **`getIndexComparator` on `StoreTableScan`** mirrors `MemoryTable`'s: per column,
   `createTypedComparator(logicalType, resolvedKeyCollation)`, negated for DESC,
   resolved against the *materialized* schema so `_uc_*` names resolve. The isolation
   layer already prefers it over its descriptor fallback. This closes the K=BINARY +
   nocase-column merge-order regression the ticket's table predicted, and also fixes
   the previously-broken "no index COLLATE, declared-nocase column" row.

5. **Rehydrate reconcile loop change (NOT in the ticket spec).**
   `validateKeyCollations` now validates index key collations, so `updateSchema` in
   `rehydrateCatalog`'s post-import reconcile can throw where it previously could not
   (an index naming a collation the reopening connection never registered). Unhandled,
   one bad table aborted the *whole* rehydrate. The loop now try/catches per table:
   records the error in `result.errors` and **evicts** the instance from
   `this.tables` (+ `dispose()`), so the table is not left live on the import-time
   index-less schema (which would accept DML without maintaining its indexes). The
   next statement reconnects and the StoreTable constructor re-raises at point of use
   — the pre-existing test `custom-collation.spec.ts` "raises rather than falling
   back to BINARY after a reopen" passes unchanged through this path. Review the
   eviction: `this.stores` handles are deliberately left cached (reconnect reuses
   them), and dispose is fire-and-forget (`void`).

6. **CREATE INDEX pre-validation** (`assertIndexKeyCollationsCanKey`, called before
   the physical index store is created). Not explicitly requested; without it an
   empty-table CREATE INDEX with a comparator-only collation would only fail at the
   post-build `updateSchema`, leaking the just-created store directory.

7. **ALTER COLUMN … SET COLLATE (non-PK)** rebuild condition extended:
   `(rewritesValues || keyTransformChanged || (collationChanged && indexCoversAlteredColumn)) && !pkRekeyNeeded`,
   where coverage is checked against the materialized (`_uc_*`-included) schema. The
   pre-mutation `validateUniqueOverExistingRows` walk already fires on
   `collationChanged`, so the non-enforcing rebuild's contract holds.

## What was intentionally NOT done

- **The three read-side guards stand** (`eqSafeToHandle`, `rangeSafeToHandle`,
  `indexRangeIsOrderSafe`). They are now merely conservative (decline `C ≠ K` cases a
  C-encoded window could serve); collapsing them is
  `implement/store-index-collation-guard-collapse` (prereq on this slug, already on
  the board). Doc comments at all three sites were rewritten to say so.
- **`buildDescriptorComparators`' BINARY fallback in quereus-isolation is untouched**
  (would change memory-table merge order); doc comment notes the store now supplies
  its own comparators. I did not conclude the memory behavior is wrong, so no backlog
  ticket was filed.
- PK-side encoding, `scanMultiSeekPrimary`, and the PK-suffix bytes: unchanged.

## Validation performed

- `yarn build` — clean; `yarn lint` — clean (includes the engine's tsc pass over test
  files); `yarn typecheck` — clean.
- `yarn test` — all workspaces green (engine 8277, store 1269, isolation 367, sync
  643, others; 0 failing).
- `yarn test:store` — logic suite vs LevelDB store module: 8269 passing, 21 pending,
  0 failing (~3 min).
- **Mutation check** (ticket-mandated): temporarily forcing
  `resolveIndexKeyCollations` to return all-`undefined` (reverting to K encoding)
  fails 7 of the 19 new tests: the 3 unit resolution tests, the multi-seek window
  order test, both DDL-time comparator-only rejection tests, and the isolation
  merge-order test. The UNIQUE-enforcement tests *pass* under the mutation because
  the restated seek guard reads the same resolver and declines to the always-correct
  full scan — graceful degradation by design, not missing coverage; a reviewer
  wanting stricter sensitivity would need to mutate the encode path independently of
  the guard.

## Test coverage vs the ticket's edge-case list (and honest gaps)

Covered in `test/index-column-collation.spec.ts` (19 tests): default shape (index
seek + memory oracle + seek-plan assertion), build-vs-maintenance byte agreement,
`_uc_*`-vs-explicit under-fetch, `any` UNIQUE index case-variants (memory oracle),
partial-UNIQUE scope transition under K=BINARY, DESC NOCASE unique window under
K=BINARY, explicit BINARY index over NOCASE column reads, multi-seek fold order
(byte-order asserted, PKs chosen so the old single-K-window order differs), SET
COLLATE non-PK rebuild (lookup + derived-UNIQUE enforcement + collide-rejection),
SET COLLATE on a PK member re-encoding the index-column half, reopen with explicit
index COLLATE, comparator-only rejection at CREATE INDEX and at CREATE TABLE
(`_uc_*`), isolation overlay merge order. Never-text byte-identity is pinned in
`key-builder.spec.ts` (integer with/without collation entry → identical bytes).

Gaps a reviewer may want to probe:

- **The reopen test pins the COLLATE round-trip through UNIQUE enforcement, not a
  read lookup.** A plain `where email = 'ANN'` cannot observe the index COLLATE —
  the predicate compares under the *column's* collation, so the residual correctly
  filters regardless (my first attempt at the ticket's suggested read-lookup form
  failed for exactly this semantic reason, pre-close as well as post-reopen). If a
  collated-predicate pushdown (`where email collate nocase = …` served by the index)
  exists, a read-side pin could be added.
- **No direct unit test of `getIndexComparator`'s per-column output** (DESC negation,
  semantic-ordering types); it is covered end-to-end by the isolation merge test and
  structurally mirrors `MemoryTable.getIndexComparator` (which has its own unit
  suite in `packages/quereus/test/capabilities.spec.ts`).
- **"No double rebuild" on PK-member SET COLLATE** is asserted behaviorally
  (results correct), not structurally (rebuild count not instrumented).
- **Semantic-ordering (TIMESPAN/JSON) index columns**: transforms and collations are
  threaded independently and existing suites cover the transforms; no new test
  combines a semantic-ordering index column with the new collation threading (its
  key collation is hard-BINARY, so the combination is low-risk).
- Two pre-existing tests in `custom-collation-key.spec.ts` were rewritten because
  their premise ("a text index column keys under K") is the behavior this ticket
  removes; the replacements assert the new contract in both directions (unusable K
  no longer blocks an undecorated column; the column's own unusable collation is
  rejected). Worth a second pair of eyes that nothing else relied on the old premise.

## Tripwires / observations parked

- `store-module.ts` (~line 427, rename/load-path comment) still says "Physical key
  bytes are always K-encoded" — a PK-side comment already stale before this ticket
  (per-column PK collations landed earlier; divergence tracked by the
  `store-pk-collate-legacy-reopen-divergence` note in docs/store.md). Out of this
  ticket's index-side scope; left as-is.
- `scanIndex`'s multi-seek `extraTuples` OR is now redundant for byte-equal windows
  (byte-equal ⇒ C-equal); kept, with the comment explaining why (safety by
  construction + custom equality-only normalizers). See the `MultiSeekWindowContext`
  doc in store-table-scan.ts.

## On-disk impact (documented in docs/store.md)

Secondary-index key bytes change for any text index column whose effective collation
differs from K. No format-version marker exists; previously-persisted databases with
such indexes must be re-indexed (drop + recreate) or recreated. Data-store bytes and
the PK suffix inside index keys are unchanged.
