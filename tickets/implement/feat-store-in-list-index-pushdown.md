---
description: When a query matches an indexed column against a list of values, the persistent storage backend currently reads the whole table instead of using the index; make it use the index the way the in-memory backend already does.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/test/pushdown.spec.ts, packages/quereus-store/README.md, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/idx-str.ts
difficulty: hard
---

## Problem

Against the store module, with `child(pid)` carrying a secondary index `idx_child_pid`:

- `select pid from child where pid = 3 limit 1` → `INDEXSEEK child USING idx_child_pid`
- `select pid from child where pid in (1, 2, 3, 4, 5) limit 1` → `FILTER` over
  `INDEXSCAN child USING _primary_` — a full scan with a residual filter.

The memory module serves both shapes from the index. The gap is entirely store-side and
splits in two:

1. **Plan side.** `StoreModule.tryIndexAccessPlan`
   (`packages/quereus-store/src/common/store-module.ts:2991`) builds its equality seek prefix
   from `f.op === '='` only, so an `IN` constraint never contributes a seek column and the
   index is never named.
2. **Runtime side.** `StoreTable` (`packages/quereus-store/src/common/store-table.ts`) has no
   handler for the engine's multi-seek access path at all. If the plan side alone were widened,
   `StoreTable.analyzeIndexAccess` would `find()` only the FIRST of the N pushed equality
   constraints and silently answer with the rows for one list value — a wrong result, not a
   slow one. **Both sides must land together.**

## How the engine encodes an IN seek

`rule-select-access-path.ts:490-650` turns a module's `indexName` + `seekColumnIndexes`
plan into an `IndexSeekNode` whose `FilterInfo` is:

- `idxStr` = `idx=<indexName>(0);plan=5;inCount=<N>[;seekWidth=<W>]` — `plan=5` is
  `multiSeek` (`planKindFromCode`, `packages/quereus/src/vtab/idx-str.ts`); `seekWidth`
  is absent (⇒ 1) for a single-column IN and present for a composite cross-product.
- `accessPath` = `{ kind: 'index', index, plan: 'multiSeek' }`.
- `constraints` = exactly `N * W` entries, all `IndexConstraintOp.EQ`, `argvIndex` running
  `1 … N*W`, column `seekCols[i % W]`. There are **no** non-seek constraints in the list.
- `args` (bound at emit time from the seek-key expressions, `runtime/emit/scan.ts:130`) =
  the `N * W` seek values in `argvIndex` order.

So tuple `i` is `args[i*W … i*W+W-1]`, and its per-column meaning comes from the parallel
constraint entries. Two properties the module MUST supply itself, because the planner does
not always pre-reduce the list (a parameter-bound / mixed-binding IN keeps its raw value
expressions — see `reduceLiteralSeekValues` and the `valueExpr` branch in the same file):

- A tuple with any NULL component matches nothing and must be **skipped**.
- Duplicate tuples must **not** re-emit their row — `IN` is set membership, not a bag.
  The memory module's reference implementation is `scanLayer` in
  `packages/quereus/src/vtab/memory/layer/scan-layer.ts:50-80` (dedups yielded rows by
  encoded primary key).

## Design

### Plan side — `StoreModule`

Introduce a second operator group next to `EQ_OPS` (`store-module.ts:176`):

```ts
const EQ_OPS = ['='] as const;              // unchanged — PK arm keeps this
const EQ_OR_IN_OPS = ['=', 'IN'] as const;  // secondary-index arm only
```

**Do not widen `EQ_OPS` itself.** It is also used by the primary-key equality arm
(`computeBestAccessPlan`, `store-module.ts:2878`), and claiming an `IN` on the PK would emit a
`_primary_` multi-seek whose emission order breaks the isolation layer's primary-key merge.
PK IN support is deliberately deferred — see `tickets/backlog/feat-store-pk-in-list-multiseek`.
Give `equalityRoles` an explicit `ops` parameter (or add a sibling `equalityInRoles`) so the
two arms cannot drift into each other.

In `tryIndexAccessPlan`:

- Treat a filter as equality-capable when `f.op === '='` **or**
  `f.op === 'IN' && Array.isArray(f.value) && (f.value as unknown[]).length > 0`. Note
  `PredicateConstraint.value` is typed `SqlValue` and the array is cast in
  `constraint-extractor.ts`; use the `as unknown[]` idiom the engine uses
  (`memory/module.ts:63`). Individual elements may be `undefined` for parameter-bound
  values — **only the length is meaningful at plan time**.
- Build `eqCols` with that predicate, exactly as today (contiguous leading prefix of the
  index columns).
- `inCount` = product over `eqCols` of that column's IN cardinality (`1` for a plain `=`) —
  the engine builds the full cross-product for a composite seek.
- Decline (return the existing `costOnly(...)` plan) when:
  - `inCount > MAX_MULTI_SEEK_KEYS` (define as `1000`; the FK RESTRICT batch chunk is 500,
    so this leaves headroom while stopping a `a in (1..100) and b in (1..100)` explosion), or
  - any seek column's logical type `hasSemanticOrdering` (TIMESPAN / JSON) and `inCount > 1`.
    `StoreTable.analyzeIndexAccess` already breaks its EQ prefix on such a column
    (`store-table.ts:1493`); for a plain EQ that degrades safely to scan + residual, but for a
    multi-seek the residual is gone, so byte-equality under-fetch would lose rows.
- Collation safety is unchanged: an `IN` is N equalities, so the existing `eqSafeToHandle`
  (K coarser-or-equal to the index column's effective collation C) is exactly the right gate.
- Claim `handledFilters` positionally with `claimFirstPerRole(request.filters,
  equalityRoles(eqCols, EQ_OR_IN_OPS))`. This matches the rule's own pick — `eqBySeekCol` in
  `rule-select-access-path.ts:452` takes the FIRST `=`-or-IN constraint per column — so a
  later redundant constraint on the same column stays unhandled and survives as a residual.
- Cost / rows for `inCount > 1` (keep the existing `eqMatch(rows, 0.3)` formula for
  `inCount === 1` so nothing regresses):
  - `perKeyRows = max(1, floor(estimatedRows * 0.1))` (the existing EQ-seek estimate)
  - `rows = min(estimatedRows, inCount * perKeyRows)`
  - `cost = inCount * INDEX_SEEK_COST + rows * 0.3`, `INDEX_SEEK_COST = 0.5`
  - `isSet = false` (mirrors `MemoryTableModule.evaluateIndexAccess`'s `setIsSet(!isMultiSeek)`)

  The per-seek term matters: without it a 500-key IN over a 10-row table would price below a
  full scan and issue 500 seeks to read 10 rows.
- Advertise **no ordering** (`providesOrdering` / `monotonicOn` / `supportsAsofRight`) — the
  index arm already advertises none, and it must stay that way for multi-seek.

### Runtime side — `StoreTable`

Add a multi-seek arm and dispatch to it **first**, at the very top of `query()`
(`store-table.ts:1163`), *before* `analyzePKAccess`. Ordering matters: on a table whose PK
column is also the leading column of the chosen secondary index, `analyzePKAccess` would
otherwise match the first EQ constraint and answer with a single-value point lookup.

```
query(filterInfo)
  ├─ multiSeek?  → scanMultiSeek(...)          // NEW, checked first
  ├─ PK point / PK range                        // unchanged
  ├─ secondary index point / range               // unchanged
  └─ full scan                                   // unchanged
```

Detection: `decodeIdxStr(filterInfo.idxStr)` → `planKindFromCode(spec.plan) === 'multiSeek'`.
(`filterInfo.accessPath.plan` says the same thing, but `inCount` / `seekWidth` live only in
the idxStr params, so one decode covers both.)

`scanMultiSeek` steps:

1. `W = parseInt(params.seekWidth ?? '1')`, `N = parseInt(params.inCount ?? '0')`.
2. Validate: `N >= 1`, `W >= 1`, `filterInfo.args.length >= N * W`, `constraints.length >=
   N * W`, and the index resolves via `resolveIndexFromIdxStr`. **On failure throw a
   `QuereusError(..., StatusCode.INTERNAL)`** naming the idxStr — do NOT fall through to the
   full-scan arm. The plan already dropped the residual, and `matchesFilters` ANDs every
   pushed constraint, so a fall-through would AND N mutually-exclusive equalities and return
   zero rows: a silent wrong answer.
3. Group the args into `N` tuples of width `W`, pairing each with its constraint entries'
   `iColumn` (columns come from `constraints[i*W … i*W+W-1]`, which is also how the per-tuple
   residual re-check is built).
4. Drop any tuple with a `null` / `undefined` component.
5. Encode each tuple's window with `buildIndexPrefixBounds(values, this.encodeOptions,
   indexDirections.slice(0, W))` — the same call `analyzeIndexAccess` makes, so DESC columns
   and the table key collation K are handled identically.
6. **Dedup** tuples by `bytesToHex(bounds.gte)` — this collapses both literal duplicates
   (`in (5, 5)`) and values that are distinct in SQL but identical under K
   (`in ('a', 'A')` with K = NOCASE).
7. **Sort** the surviving windows ascending by `compareBytes(gte)`. Encoded-byte order *is*
   index-key order (per-column DESC inversion is already baked into the bytes), so the
   concatenated output is emitted in index-key order — the order the isolation overlay merge
   expects from an index scan (`isolated-table.ts` § `mergedSecondaryIndexQuery`) and the
   same guarantee the existing single-window index arm gives. This is why the sort is not
   optional cosmetics.
8. For each window, reuse `scanIndex(indexStore, { index, type: 'point', bounds }, tupleFilterInfo)`
   where `tupleFilterInfo = { ...filterInfo, constraints: <this tuple's W entries> }`. That
   keeps `matchesFilters` as the authoritative collation-aware row re-check per seek key
   (windows are only supersets) and reuses the existing stale-entry / deleted-row defenses.
9. Cross-window row dedup: give `scanIndex` an optional `seen?: Set<string>` parameter and
   have it skip an entry whose `bytesToHex(entry.value)` (the stored data key) is already in
   the set, **before** the `readEffectiveRowByKey` lookup — so a duplicate also costs no
   extra data-store read. Single-window callers pass nothing and pay nothing. Needed because
   `buildIndexPrefixBounds` returns `lt: undefined` when the encoded prefix is all-`0xff`
   (`incrementLastByte` overflow), which makes that one window unbounded above and therefore
   overlapping; distinct non-overflowing prefixes are disjoint by the self-delimiting
   composite-key encoding.
10. Resolve `resolveFilterCollations(filterInfo, indexColumnCollations(index))` ONCE outside
    the loop and thread it in (it dedups by column, so it is identical for every tuple).

Also add a `_primary_` / no-secondary-index branch to `scanMultiSeek`: each tuple is a full
primary key, so dedup + sort by `encodeDataKey(tuple)` and `readLiveRowByPk` each, applying
the same per-tuple `matchesFilters`. `StoreModule` never emits such a plan today (see the PK
note above), but the branch converts a would-be silent wrong answer into correct-but-unclaimed
behavior if one ever arrives, and it is what a future PK-IN enablement will build on. Say so
in a comment so it does not read as dead code.

## Edge cases & interactions

- **Wrong-order emission is not an option.** Windows must be scanned in ascending encoded-key
  order (step 7). Under the isolation layer a secondary-index scan is merged with the
  overlay by `(indexKey, PK)`; an out-of-order underlying stream misplaces overlay rows in
  the output.
- **Read-your-own-writes.** Each window goes through `iterateEffective`, which merges the
  transaction's pending index puts/deletes within *that* window. Test: `begin`, insert a row
  whose indexed value is in the IN list, query, see it.
- **Duplicate list values** — `in (3, 3)` and (with K = NOCASE) `in ('a', 'A')` must each
  yield the row once.
- **NULL in the list** — `in (1, null, 3)` must return the same rows as `in (1, 3)`, and
  `in (null)` / an all-NULL list must return nothing (the planner collapses an all-NULL
  *literal* list to an empty result before reaching the module; the parameter-bound form
  reaches the module and must be handled).
- **Parameter-bound lists** — `where v in (?, ?, ?)`: no plan-time literal reduction happens,
  so the runtime dedup/NULL-skip is the only line of defense. This is the shape the FK
  RESTRICT batch (`packages/quereus/src/runtime/foreign-key-actions.ts:175`) emits.
- **Composite index cross-product** — `where a in (1,2) and b in (10,20)` on `(a,b)` arrives
  as `seekWidth=2;inCount=4`; `where a in (1,2) and b = 5` as `seekWidth=2;inCount=2`.
- **Single-element IN** — `v in (1)` never becomes `plan=5`; the engine routes it through the
  ordinary `eqSeek` path. Must keep working, including `v in (?)`.
- **`inCount` above the cap** and **semantic-ordering seek columns** fall back to the
  cost-only plan: the residual stays, the answer is right, only the speed-up is lost.
- **Collation-unsafe index** (K finer than the column's collation, e.g. K = BINARY over a
  NOCASE column, or an `ANY` column) must still decline exactly as the EQ arm does today.
- **DESC index column** — bit-inverted key bytes; the sort in step 7 and the bounds in step 5
  both operate on encoded bytes, so DESC needs no special case, but it needs a test.
- **Partial index** — still excluded from access planning (`if (index.predicate) return null`).
- **Stale index entries** (post-rollback) and **rows deleted since indexing** — already
  handled inside `scanIndex`; the multi-seek arm must not bypass those checks.
- **`limit` pushdown** — the multi-seek stream is lazy per window; do not materialize all
  windows' rows before yielding, or `… in (…) limit 1` loses its early exit.
- **No ordering claim.** Confirm `select … where v in (3,1,2) order by v` still gets a Sort
  (or a different plan) and returns sorted rows.

## Tests

Extend `packages/quereus-store/test/pushdown.spec.ts` — its
`describe('secondary-index scan (store-index-scan-read-primitive)')` block and its
`CountingKVStore` / `planOps` helpers are the right home.

Plan-shape:
- `where age in (25, 30)` on an indexed `age` picks `INDEXSEEK` (matching the existing
  `expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i)` style), not SEQSCAN.
- Composite index `(a, b)`: `a in (1,2) and b in (10,20)` picks the index seek.
- An IN over the cap, and an IN on a TIMESPAN/JSON indexed column, both stay on the scan
  path and still return correct rows.

Result-correctness (the important half — assert exact rows, ordered):
- basic `in` list; duplicates; NULL in the list; all-NULL parameter list; empty result;
  parameter-bound list (`stmt.bindAll`); NOCASE column with case-variant list entries;
  DESC index column; composite cross-product; single-element IN.
- Cross-check a few shapes against the memory module as an oracle, the way the existing
  bigint/blob/real tests in this spec do (`expect(storeRows).to.deep.equal(memRows)`).

Narrowing proof (this is what makes it a real fix, since rows alone can't distinguish a seek
from a scan): with a `CountingKVStore`, seed 100 rows, run `where v in (5, 7, 9)` on an
indexed `v`, and assert the *data* store visits only a handful of entries — a full scan would
visit 100. (Index entries are read from the index store, which the counting provider leaves
plain; the assertion is on the data-store `get`s the seek resolves.)

Read-your-own-writes: inside a transaction, insert a row whose indexed value is in the list
and assert it surfaces.

## TODO

Phase 1 — plan side
- Split `EQ_OPS` into the PK-only group and an `EQ_OR_IN_OPS` group; parameterize
  `equalityRoles` so the PK arm cannot pick up `IN`
- Widen `tryIndexAccessPlan`'s equality-prefix detection to `IN`, compute `inCount`
- Add the `MAX_MULTI_SEEK_KEYS` and semantic-ordering declines (cost-only fallback)
- Add the multi-seek cost/rows/isSet estimate; keep the `inCount === 1` path byte-identical
- Document the PK deferral in a comment pointing at `feat-store-pk-in-list-multiseek`

Phase 2 — runtime side
- Add `scanMultiSeek` (tuple grouping, NULL skip, key dedup, byte sort, per-tuple residual)
- Dispatch to it first in `query()`, ahead of `analyzePKAccess`
- Add the optional `seen` set parameter to `scanIndex`, checked before the row read
- Add the `_primary_` tuple branch with its "not reachable from this module's own plans yet"
  comment
- Throw `StatusCode.INTERNAL` on a malformed multi-seek `FilterInfo` rather than falling
  through to the scan arm

Phase 3 — validate + document
- Add the tests above to `packages/quereus-store/test/pushdown.spec.ts`
- `yarn build`, then `yarn workspace @quereus/store test 2>&1 | tee /tmp/store-test.log`
- `yarn test 2>&1 | tee /tmp/test.log` (engine untouched, but the access-path rule is shared)
- `yarn typecheck`
- Add a short paragraph to `packages/quereus-store/README.md` where the index-store layout is
  described (§ Storage Architecture, around the "Index values" bullet) stating that an
  `IN`-list on an indexed column is served as one deduplicated, key-ordered seek per distinct
  list value
