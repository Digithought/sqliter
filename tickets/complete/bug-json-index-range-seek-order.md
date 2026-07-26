---
description: An indexed column holding JSON documents silently returned the wrong rows for range and some equality queries, because a stored JSON array was mistaken for a multi-column key. Fixed, reviewed, and covered by tests.
files:
  - packages/quereus/src/vtab/memory/types.ts                              # BTreeKey invariant + keyParts / leadingKeyPart
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts                  # keyIsTuple on ResolvedScanComparators
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                   # seekKeyHasNull + 4 early-termination sites
  - packages/quereus/src/vtab/memory/layer/manager.ts                      # event key, covering-MV source PK
  - packages/quereus/src/vtab/memory/utils/primary-key.ts                  # primaryKeyArity()
  - packages/quereus/src/util/comparison.ts                                # objectCanonicalCache NOTE
  - docs/types.md                                                          # JSON Keys caveat
  - docs/memory-table.md                                                   # "scan-path key shape comes from arity"
  - packages/quereus/test/logic/06.9.3-json-index-range-seek.sqllogic      # regression file (memory + store)
  - packages/quereus/test/vtab/json-primary-key-seek.spec.ts               # JSON-primary-key + event-key spec
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic   # comment correction
---

# A JSON array value was misread as a composite index key

## What was wrong

The in-memory table module stores a one-column primary key or index key as a bare
value and a multi-column one as an array of values. Nothing on the stored key says
which it is, so six places in the scan path recovered the shape by asking
`Array.isArray(key)`.

A JSON array value *is* a JavaScript array. So for an index over a JSON column, the
stored document `[1]` was read as the one-element key tuple `(1)`, and every bound
check then compared against the number `1` instead of against the document `[1]`.
An indexed JSON column returned a different — smaller, arbitrarily holed — row set
than the identical unindexed query, and equality against a document containing a
JSON `null` (`[null]`) returned nothing at all.

It was **not** an ordering disagreement: the index tree's comparator, `<`/`>`/BETWEEN
at runtime, and ORDER BY all rank JSON documents by the same structural compare, and
did so before the fix. No storage-format or ordering change was needed.

The persistent store module and the isolation layer never had the defect — the store
encodes JSON key members to opaque bytes, and isolation builds its keys from column
indexes. Neither has a shape test to get wrong.

## What was done

The key's shape is fully determined by the scanned structure's **arity**, which the
schema already knows. That number is now threaded to every consumer instead of being
guessed from the value:

- `vtab/memory/types.ts` documents the invariant on `BTreeKey` (*the scalar-vs-tuple
  choice is a function of arity alone and is never recoverable from the value*) and
  exports `keyParts(key, keyIsTuple)` / `leadingKeyPart(key, keyIsTuple)`.
- `layer/plan-filter.ts` — `ResolvedScanComparators` gains `keyIsTuple`, derived as
  `(indexColumns?.length ?? 1) !== 1` (`!== 1`, not `> 1`: the zero-column singleton
  primary key's extractor returns `[]`, so it stores a tuple too).
- `layer/scan-layer.ts` — `seekKeyHasNull` and the four early-termination sites take
  the flag.
- `layer/manager.ts` — the data-change event's `key` field and the covering
  materialized view's `newSourcePk` shape from `primaryKeyArity(schema)`.
- `utils/primary-key.ts` — new `primaryKeyArity(schema)`, using the *same* fallback
  `createPrimaryKeyFunctions` uses, so the two arities cannot drift.

Three prose sites that asserted the wrong cause were corrected (`util/comparison.ts`,
`docs/types.md`, `06.9.2-json-structural-equality.sqllogic`), and `docs/memory-table.md`
gained a bullet recording that scan-path key shape comes from arity.

## Coverage

- `test/logic/06.9.3-json-index-range-seek.sqllogic` — deliberately without
  `using memory`, so it runs in store mode too and pins that the two modules agree.
  Four tables over the same 20-row corpus spanning every JSON kind: an unindexed
  reference, a single-column index on the JSON column, a composite index with the
  JSON column trailing, and one with it leading. Every range / `between` / `=` / `in`
  query is asserted against both the indexed and the unindexed table.
- `test/vtab/json-primary-key-seek.spec.ts` — the JSON **primary key** half (awkward
  to express in a store-mode logic file), plus the data-change event's key shape both
  ways.

## Review findings

### Checked

- Read the implement-stage diff (`bfda42f5`) in full before the handoff summary.
- Swept `vtab/memory` for every remaining shape sniff. The only `Array.isArray` calls
  left are in `module.ts` on `filter.value` for `IN`-list constraints — planner
  constraint values, not BTree keys. Clean.
- Confirmed the neighbouring key producers are already arity-driven and cannot
  reintroduce the defect: `encodePrimaryKey` takes the arity explicitly, `MemoryIndex`
  branches on `specColumns.length`, and `safeIterate` is shape-agnostic.
- Confirmed the claim that other modules are unaffected: `quereus-isolation` builds
  its merge sort keys from column indexes (`isolated-table.ts` `buildSortKey`), and
  `quereus-store` encodes JSON key members structurally. Neither has a shape test.
- Checked that `keyIsTuple` cannot silently fall back to the wrong value. When
  `resolveIndexColumns` cannot find the named index it returns `undefined`, which
  would yield `keyIsTuple === false` — but `getSecondaryIndexTree` throws on the same
  name a few lines later, so no scan ever runs with that shape. Both lookups are
  exact-name, so there is no case-sensitivity mismatch between them.
- Checked that `primaryKeyArity`, `resolveIndexColumns`' primary branch, and
  `createPrimaryKeyFunctions` use the same expression, so the arities cannot drift.
  (Their `?? all columns` fallback is dead in all three — `TableSchema.primaryKeyDefinition`
  is non-optional and table creation synthesizes an all-columns PK when none is
  declared — but it is dead *consistently*, so it is left alone.)
- Confirmed the new tests are not vacuous. Dumped `query_plan()` for each shape: every
  JSON predicate plans as an `INDEXSEEK` (`plan=2` point seek, `plan=3` range,
  `plan=7` prefix-range), never a residual filter over a scan.
- Hand-derived the logic file's `order by v` sequence from the structural rank order
  (null < boolean < number < string < array < object, then element-wise) and confirmed
  every position, including `[] < [null] < [1] < [9,9] < [[1,2],[3]]` and
  `{} < {"a":1} < {"a":2} < {"a":10} < {"b":1}`. This closes the handoff's caveat that
  the expectations were generated by running the queries rather than derived.
- `yarn build` clean. `yarn lint` clean. `yarn test`: 7254 passing, 13 pending, 0
  failing. `yarn test:store`: 7246 passing, 21 pending, 0 failing. No pre-existing
  failures surfaced.

### Fixed in this pass (minor)

- **Coverage gap the handoff flagged.** There was no test with a JSON column in a
  *leading* composite index position — the direction a fix that hard-coded "scalar"
  would have broken. Added section 5 to `06.9.3-json-index-range-seek.sqllogic`: a
  `(v, g)` index exercising a range bound and a `between` on the leading document
  column, plus a whole document as the equality **prefix** with an integer range on
  the trailing column (the `plan=7` path, which is the only consumer of `keyParts`
  for prefix comparison). Runs in memory and store mode; both green.
- **A doc claim that overreached.** The corrected NOTE on `objectCanonicalCache`
  (`util/comparison.ts`) said the branch "is only reached for a value whose column is
  NOT declared `json`". The branch is reached wherever an OBJECT value is ordered with
  no declared JSON logical type to route it, which is not only column comparisons.
  Reworded.
- **The "unverified" covering-materialized-view site is unobservable, not merely
  untested.** The handoff called `newSourcePk` in `manager.ts` the one remaining blind
  spot. Built the fixture it said was hard to construct (a JSON single-column primary
  key, a table-level UNIQUE, and a covering MV over it), instrumented the site to
  confirm the MV path is actually taken, then reverted the line to `Array.isArray` and
  re-ran INSERT / UPDATE / REPLACE / self-write / genuine-conflict cases. Behaviour was
  identical in every case: a wrong shape there can only *widen* the candidate set (the
  row fails its own self-exclusion), and the caller's loop re-excludes self through the
  real primary-key comparator. So no query result can observe that line, and no test
  can pin it. Recorded that reasoning in a comment at the site so it is not re-opened
  as a blind spot. The change itself is still correct and stays.

### Judged and accepted, no change

- **`isComposite` still uses `> 1` while `keyIsTuple` uses `!== 1`** in
  `scan-layer.ts`'s seek-key construction. The handoff asked for this to be judged. The
  reasoning holds: they differ only for a zero-arity primary key, which arises only
  from an explicitly empty PK definition, and neither seek-key branch can be reached
  with one (an equality prefix needs a PK column to fill; a range bound needs a column
  to constrain). The existing `NOTE:` at the site states this and says what to change
  if a zero-arity plan ever does arrive.
- **`seekKeyHasNull` now allocates a one-element array on the scalar path** where it
  previously did a bare `=== null`. It runs once per point seek and once per `IN`-list
  element, never per row, and the shared helper is what keeps the invariant in one
  place. Not worth open-coding.

### Tripwire recorded

- `layer/manager.ts`, event-emit site — on the tuple path the event hands listeners the
  stored key array itself, because `VTableDataChangeEvent.key` is a mutable
  `SqlValue[]`. Pre-existing (the old sniff aliased it the same way) and harmless while
  no listener mutates it; an in-place edit would re-order the primary tree under its
  comparator. `NOTE:` added at the site saying to copy there if a mutating listener
  ever appears.

### Major findings

None. No new tickets filed. No correctness defect was found in the fix itself, and no
behaviour was found that the fix left broken.
