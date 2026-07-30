description: A query inside a transaction that looked up several rows by primary key (or by a secondary index) in one shot could return a changed row twice — once new, once stale — or bring back a deleted row, when the lookup list was not already sorted; fixed, with tests and docs.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/interface.ts, packages/quereus/src/runtime/emit/key-set-semi-join.ts, packages/quereus/test/vtab/multiseek-key-order.spec.ts, packages/quereus-isolation/test/key-set-seek-merge.spec.ts, docs/module-authoring.md, docs/design-isolation-layer.md, docs/memory-table.md
---

## What landed

The in-memory table's multi-value lookup (`plan=5`, e.g. `where pk in (3, 1, 2)`) visited
its seek keys in the order the `IN` list was written rather than in the scanned
structure's own key order. `quereus-isolation` merges a table read with the rows a
transaction has staged but not committed, pairing the two streams by index-key order for
any read whose index resolves as the primary key — so an out-of-order read mis-paired a
staged row against a stale stored row: a changed row could appear twice (new and stale),
and a deleted row could reappear. The persistent-store backend already sorted its
multi-seek windows; the memory backend was the outlier.

### Fix

`scanLayerResolved`'s multi-seek branch sorts its seek keys before visiting them, under the
primary-key comparator for a primary-key seek, or the named secondary index's own BTree
comparator (`MemoryIndex.compareKeys`) otherwise — reversed for a descending walk. Both
comparators already fold each key column's logical type, declared collation and `DESC`
direction, so the seek order matches the tree's physical order exactly.

`Layer.getSecondaryIndex` was declared optional despite both implementations
(`BaseLayer`, `TransactionLayer`) always providing it; tightened to non-optional, which
also retired a silent-fallback branch in the secondary-index scan path.

`emitKeySetSemiJoin`'s own seek-key sort is now redundant against both shipped backends but
is not dead — it is the only sort for a backend that does not sort itself. Kept, with a
`NOTE:` saying so.

Docs updated: `docs/module-authoring.md` (the ordering contract a third-party module owes
for a multi-value seek, independent of the existing `providesOrdering` guidance),
`docs/design-isolation-layer.md` § Key Ordering (the merge-order rule holds for every plan
kind, not only plain and range scans), `docs/memory-table.md` (limitations bullet).

### Tests

- `packages/quereus/test/vtab/multiseek-key-order.spec.ts` — 7 tests against a plain
  memory table with no isolation layer, each asserting the *raw* row order of a query with
  no `order by`, so nothing downstream re-sorts: ascending primary key, `DESC` primary key,
  composite primary key (cross-product seek), ascending secondary index, `DESC` secondary
  index, parameter-bound `in (?, ?, ?)`, and an `OR`-chain collapsed into the same plan.
  All 7 confirmed to fail with the sort removed.
- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts` — 5 tests through the
  isolation layer: a staged update survives exactly once in its new form; a staged delete
  does not resurrect; a `DESC` primary key case; a composite primary key case; and a
  secondary-index case that already tolerated disorder, pinned so the new sort does not
  break it. Each asserts the read really was served as a multi-value seek rather than
  passing vacuously on a full scan.

Note for anyone editing the isolation package's specs: that package's mocha run resolves
`@quereus/quereus` to its built `dist`, so `yarn build` is required before an engine-side
change shows up there.

## Review findings

**Checked:** the implement diff read first, before its handoff summary; the multi-seek sort
for correctness under each comparator; every `Layer` implementer (only `BaseLayer` and
`TransactionLayer` — the interface tightening is safe, and no duck-typing on
`getSecondaryIndex` exists); comparator identity (`MemoryIndex.compareKeys` is a readonly
arrow property, so passing it as a bare function loses no `this`); the descending arm's
correctness against a `DESC` leading key; every doc that mentions a multi-value seek
(`optimizer.md`, `optimizer-rules.md`, `optimizer-streaming.md`, `store.md` carry no stale
ordering claim); whether the new tests exercise the intended plan rather than passing
vacuously; full `yarn build`, `yarn test`, `yarn lint`, `yarn typecheck`.

**Fixed in this pass (minor):**

- The 20-line inline sort in `scanLayerResolved` was extracted to a named
  `orderSeekKeys(keys, plan, layer, primaryKeyComparator)` helper, cutting the multi-seek
  branch back to one readable line and moving the rationale to the helper's own doc
  comment. No behavior change; the key type aliases are structurally identical, so no casts
  were needed.
- Closed the handoff's own stated test gap: added the parameter-bound (`in (?, ?, ?)`) and
  `OR`-collapsed cases, the two non-literal ways the engine reaches this plan. Both were
  verified to fail with the sort removed, so they exercise the real plan.
- Re-verified the whole spec against the sort removed: **all 7** engine-side tests fail
  without the fix, including the `DESC`-secondary-index case the handoff expected to pass
  either way.

**Filed as a new ticket (major, pre-existing and dormant):**
`backlog/debt-memory-reverse-secondary-pk-order` — when the memory table reads a secondary
index, rows sharing one indexed value are always emitted in ascending primary-key order,
*including* on a backwards walk, whereas the isolation merge reverses the whole composite
ordering (primary-key tie-break included) for a reversed read. That would corrupt
transactional reads for any index value covering two or more rows. It is unreachable today:
no engine path emits the `ordCons=DESC` marker or the descending plan codes that set the
flag, and the one caller that does pass a descending request only ever walks the primary
key tree (both confirmed by instrumenting the module's `idxStr` during review — a
descending `order by` on an indexed column is served by sorting downstream instead). Not a
tripwire, because it is definitely wrong the moment that dormant path runs; a code `NOTE:`
at the site points at the ticket.

**Tripwires:** none beyond the one above, which is a ticket rather than a tripwire for the
reason stated.

**Considered and dismissed:** sorting the seek keys before filtering NULL-bearing ones is
harmless — the typed comparators handle NULL (index BTrees hold NULL keys), so this is
ordering of a few extra keys, not a defect. The handoff's other stated gap — no test
pinning `providesOrdering` truthfulness for a multi-value seek — stays open by choice: the
advertisement is now true (the seek is sorted), and nothing consumes it for this plan kind.

**Not run:** `yarn test:store`, as before — no `quereus-store` file is in this diff, which
only cites that backend's existing sort in docs and comments.
