description: A query inside a transaction that looks up several rows by primary key (or by a secondary index) in one shot could return a changed row twice — once new, once stale — or bring back a deleted row, when the lookup list was not already sorted; this is now fixed, with tests and docs updated to match.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/interface.ts, packages/quereus/src/runtime/emit/key-set-semi-join.ts, packages/quereus/test/vtab/multiseek-key-order.spec.ts, packages/quereus-isolation/test/key-set-seek-merge.spec.ts, docs/module-authoring.md, docs/design-isolation-layer.md, docs/memory-table.md
difficulty: easy
---

## What landed

Root cause (see the prior `fix/` and `implement/` tickets for the full derivation): the
in-memory backend's multi-seek (`plan=5`, e.g. `WHERE pk IN (3, 1, 2)`) visited its seek
keys in seek-argument order (the order the `IN` list was written), not the scanned
structure's own key order. `quereus-isolation`'s merge (`mergeStreams` /
`mergedSecondaryIndexQuery`) assumes an index access path with `role: 'primary'` — for
**any** plan kind, including a multi-seek — emits in ascending (or, for a `DESC` leading
key, descending) key order, and mis-pairs a staged row against a stale stored row when
that assumption is violated. The persistent store backend (`quereus-store`) already sorted
its multi-seek windows for exactly this reason; the memory backend was the outlier.

### The fix

`scanLayerResolved`'s multi-seek branch (`packages/quereus/src/vtab/memory/layer/scan-layer.ts`,
in the `plan.equalityKeys` arm) now sorts the seek keys before visiting them, under:

- `primaryKeyComparator` (from `layer.getPkExtractorsAndComparators`) when
  `plan.indexName === 'primary'`;
- `layer.getSecondaryIndex(plan.indexName).compareKeys` (the `MemoryIndex`'s own BTree
  comparator) otherwise.

The sort is reversed when `plan.descending` is set (a reverse walk of the structure emits
its keys backwards too). Both comparators already fold each column's logical type,
declared collation, and `DESC` direction — the same ones the scanned BTree is keyed by —
so the seek order matches the tree's physical order exactly.

`Layer.getSecondaryIndex` was declared optional in `layer/interface.ts` even though both
implementations (`BaseLayer`, `TransactionLayer`) always provide it; tightened to
non-optional rather than adding a second silent-fallback path (a second reviewer should
confirm there are no other `Layer` implementers outside this package — I checked and found
only these two).

`emitKeySetSemiJoin`'s own pre-existing seek-key sort (`key-set-semi-join.ts`) is now
redundant against both shipped backends, but is not dead: it's the only sort for any
backend that doesn't do its own. Left in place with a `NOTE:` explaining why.

### Docs updated

- `docs/module-authoring.md` — new paragraph stating the contract a module owes: a
  `multiSeek` access path must emit in the scanned index's own key order, independent of
  (and in addition to) the existing "don't claim `providesOrdering`" guidance.
- `docs/design-isolation-layer.md` § Key Ordering — the primary-key merge-order rule now
  states it holds "regardless of the plan kind," not just for scan/range plans.
- `docs/memory-table.md` — new bullet under Current Limitations for the multi-seek sort.

### Stale references retired

- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts` no longer describes the
  literal-list form as unfixed/unpinned (it previously named this bug as still open at
  two places in its comments); both were rewritten to point at the new test block.
- `tickets/backlog/feat-store-pk-in-list-multiseek` was not touched, per the prior
  ticket's instruction — it's unblocked by this fix but that's for whoever picks it up
  next to notice.

## Test coverage added

**Engine-side** (`packages/quereus/test/vtab/multiseek-key-order.spec.ts`, 5 new tests,
plain `MemoryTableModule`, no isolation layer): pins that a bare multi-seek — no isolation
involved — emits in ascending/descending index-key order rather than seek-argument order,
for: ascending PK, `DESC` PK, composite PK (cross-product), ascending secondary index,
`DESC` secondary index. Each asserts the *raw* row order from a query with no `ORDER BY`
(so nothing downstream re-sorts the result) — this is the most direct pin of the actual
bug mechanism.

**Isolation-side** (`packages/quereus-isolation/test/key-set-seek-merge.spec.ts`, new
`describe('literal IN-list multi-seek …)` block, 5 tests): staged update survives exactly
once in its new form; staged delete does not resurrect; a `DESC` primary key case (see the
in-line comment there for exactly why that specific list/update-target combination is
needed to trigger the pre-fix bug — it's more subtle than the ascending case: the merge
only mis-fires when the staged key ranks ahead of the *first* out-of-order literal); a
composite primary key cross-product case; and a secondary-index case that was already
tolerant of disorder before this fix, pinned to confirm the new sort doesn't break it.

**Validation method**: every one of these 10 new tests was confirmed to actually fail
against the pre-fix code (sabotaged the sort back out locally, reran, restored) — 8 of the
10 fail without the fix (the DESC-secondary and "tolerant" secondary-index cases pass
either way, by design, since they're pinning "doesn't break," not "was broken"). `yarn
build` is required before the isolation package's tests reflect an engine-side change —
that package resolves `@quereus/quereus` to its built `dist`, not `src` (documented at the
top of the spec file; tripped me up once during this work, worth knowing before touching
that file again).

## Verification run

- `yarn build` — clean.
- `yarn test` — **8070 passing** in `packages/quereus` (was 8065; +5 new), **355 passing**
  in `quereus-isolation` (+5 new), zero failures across every other workspace.
- `yarn lint` — clean (only `packages/quereus` runs real lint + test-file typecheck; every
  other workspace no-ops by design).
- `yarn typecheck` — clean across all workspaces.
- Did not run `yarn test:store` — this ticket never touches `quereus-store` code, only
  cites its existing (unchanged) sort behavior in docs/comments. A reviewer wanting extra
  confidence that nothing regressed there could run it, but I don't expect it to surface
  anything: no store file is in this diff.

## Known gaps / things I did not chase

- I did not add a test for a **mixed-binding** multi-seek (values from an OR-collapse or a
  runtime parameter rather than pure literals — see `rule-select-access-path.ts`'s
  `Array.isArray(inConstraint.valueExpr)` branch). The fix sorts `plan.equalityKeys`
  regardless of how those `BTreeKey` values were produced, so I don't have a specific
  reason to expect this path behaves differently, but it is untested by this change.
- The "quieter symptom" noted in the original ticket — the memory module's
  `providesOrdering` advertisement for a `_primary_` plan being technically false for an
  *unsorted* multi-seek — is now moot (the multi-seek is sorted, so the advertisement is
  true), but I did not add a test that specifically pins `providesOrdering` truthfulness
  for a multi-seek plan. Low risk: nothing was found (in this ticket or its predecessor)
  that acts on that advertisement for a multi-seek plan today.
- I did not audit other `Layer`-consuming call sites beyond `scan-layer.ts` and
  `manager.ts` for behavior that might have silently depended on `getSecondaryIndex` being
  optional (e.g. any code using `'getSecondaryIndex' in layer` or similar duck-typing). A
  grep for `getSecondaryIndex` turned up nothing of that shape, but I did not exhaustively
  search for structural-typing tricks.
