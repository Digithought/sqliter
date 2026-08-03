---
description: Queries that sort or filter by a range over a duration or JSON column in a persistent table currently read the whole table and re-sort it, even though the stored rows are already in the right order. Turn those shortcuts back on so such queries seek to the rows they need and skip the sort.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts        # keyOrderMatchesCollation (the blanket decline); new per-type predicates live here
  - packages/quereus-store/src/common/json-key.ts                 # jsonStructuralKey; add jsonKeyEncodable
  - packages/quereus-store/src/common/store-table-scan.ts         # buildPKRangeBounds, buildIndexRangeBounds, indexKeyCollations (memo pattern to mirror)
  - packages/quereus-store/src/common/key-builder.ts              # buildIndexPrefixBounds — the "callers pass NO transforms" NOTE
  - packages/quereus-store/src/common/store-module-access-plan.ts # computeBestAccessPlan / tryIndexAccessPlan / buildPkOrderingAdvertisement (no code change expected — verify)
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts    # 3 tests assert "Sort still runs" / "window declined"
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # line ~135 asserts "Sort still runs"
  - packages/quereus-store/test/json-semantic-key-order.spec.ts   # line ~176 asserts "advertisement stays declined"
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts       # the precedent for raising on an unkeyable seek bound
  - docs/types.md                                                 # § Semantic ordering, ~line 480
  - docs/store.md                                                 # § "What the PK-order advertisement is measured against", ~line 670
difficulty: hard
---

# Re-open ordering advertisements and range windows over TIMESPAN / JSON key columns

## Background

Two logical types carry **semantic ordering**: their `compare` defines an order that
storage-class + collation comparison does not reproduce.

- `TIMESPAN` ranks by elapsed time — `'PT90M' < 'PT2H'` though the text sorts the
  other way.
- `JSON` ranks structurally — `{"a":2} < {"a":10}` though canonical text sorts the
  other way.

Two earlier tickets made the store's **physical key bytes** reproduce those orders.
`duration-json-semantic-ordering-store` routes a TIMESPAN key member through the
type's `groupKey` (total seconds against the same reference date `compare` uses), so
the member encodes down the NUMERIC path and memcmp order is elapsed-time order.
`bug-json-pk-store-scan-order` routes a JSON key member through `jsonStructuralKey`
(json-key.ts), a tagged self-delimiting byte form whose memcmp order reproduces
`deepCompareJson`. Both are resolved by `storeSemanticKeyTransform`
(pk-key-resolution.ts) and are already threaded into every key-**writing** site.

The **read** side never caught up. `keyOrderMatchesCollation` still declines outright
for any semantic-ordering column:

```ts
if (hasSemanticOrdering(column?.logicalType)) return false;
```

That one line closes three things at once: the PK-order advertisement
(`pkOrderPreservingPrefixLength` → `buildPkOrderingAdvertisement`), the leading-PK
range window (`analyzePKAccess` → `buildPKRangeBounds`), and the leading-column
secondary-index range window (`indexLeadingRangeIsOrderSafe`). So
`select … from t order by <timespan pk>` full-scans and runs a real `Sort`, and
`where <json pk> > …` full-scans and re-checks every row through the type-aware
residual. Correct, just slower than it needs to be.

This ticket re-opens the **order-shaped** half: advertisements and range windows. The
**equality-shaped** half (PK point lookups, secondary-index EQ-prefix seeks) is ticket
`feat-store-semantic-key-point-seeks`, which builds on the predicates added here.

## Design

### 1. An explicit per-type assertion, not a blanket un-decline

The re-openable set is a claim about specific types, not about "has a transform" —
`validateSemanticKeyTransforms` can only check a transform *exists*, and nothing forces
a future type's transform to be order-preserving. So the gate is a named allow-list in
`pk-key-resolution.ts`:

```ts
/**
 * True when this semantic-ordering type's store key bytes memcmp in EXACTLY the type's
 * `compare` order — and byte-equal exactly when `compare` says equal — for every value a
 * store-backed table can HOLD.
 *
 * An explicit per-type assertion, deliberately NOT "storeSemanticKeyTransform(type) !== undefined":
 * a transform is only required to be identity-faithful, and `validateSemanticKeyTransforms`
 * can check only that one exists. A type absent here keeps the pre-existing blanket decline —
 * no byte window, no ordering advertisement, answered by full scan + the type-aware residual.
 */
export function semanticKeyOrderIsFaithful(type: LogicalType | undefined): boolean;
```

Implemented as `hasSemanticOrdering(type) && (type.name === TIMESPAN_TYPE.name || type.name === JSON_TYPE.name)`.
Match by **name**, not object identity — same dual-module-instance reason
`storeSemanticKeyTransform` already documents (the logic suite runs the engine from
`src` via ts-node while the store resolves `@quereus/quereus` to `dist`, so each side
holds its own type singletons). `TIMESPAN_TYPE` is exported from `@quereus/quereus`
(`types/index.ts`); `JSON_TYPE` is already imported in this file.

Then `keyOrderMatchesCollation` **falls through** rather than returning true:

```ts
if (hasSemanticOrdering(column?.logicalType) && !semanticKeyOrderIsFaithful(column?.logicalType)) return false;
if (!columnCanHoldText(column)) return true;
if (compareCollation.toUpperCase() !== keyCollation.toUpperCase()) return false;
return (db as DatabaseInternal)._isCollationOrderPreserving(keyCollation);
```

Falling through matters. `logicalTypeCanHoldText` returns true for both `json`
(physical type OBJECT, not in the never-text set) and `timespan` (physical type TEXT),
so the collation checks below are still reached — and they are what correctly declines
a `json` **index** column carrying an explicit non-BINARY `COLLATE` (index DDL does not
type-gate the way column DDL does; such a column's key bytes are hard-BINARY while
`matchesFilters` re-compares under the declared name). Returning `true` early would
silently re-open that unsound shape.

### 2. Why the stored-value claim holds

**TIMESPAN.** Every write path coerces through `coerceRowToSchema` /
`buildRowCoercion` → `TIMESPAN_TYPE.parse`, which raises on anything
`Temporal.Duration.from` (or the human-readable fallback) cannot read and normalizes
the survivor to `Duration.toString()`. `StoreTable.update`'s `preCoerced` fast path is
the engine having already run the same conversion. The ALTER retype/backfill path runs
`validateAndParse` too. So **every stored TIMESPAN value parses**, `groupKey` returns a
number for all of them, and every stored key member is a fixed-width `NUMERIC(total
seconds)` whose memcmp order is elapsed-time order. The unparseable-fallback branch of
`groupKey` (raw text ⇒ TEXT-tagged bytes, which sort above every NUMERIC-tagged key) is
unreachable for stored values. Confirm this by reading the write paths rather than
taking it on trust, and state the finding in the handoff.

**JSON.** Every stored value is a `JSON_TYPE.parse` output: SQL `null`, boolean,
number, string, array, or plain object — never a blob, never a bigint. `jsonStructuralKey`
encodes all of those, and its tag order (`null 0x01 < bool 0x02 < number 0x03 <
string 0x04 < array 0x05 < object 0x06`) reproduces both `deepCompareJson`'s rank order
and — for cross-storage-class pairs, where `createTypedComparator` short-circuits before
reaching `JSON_TYPE.compare` — `getStorageClass`'s `NULL < NUMERIC < TEXT < BLOB <
OBJECT`. (Boolean is NUMERIC-class and also ranks below JSON numbers structurally, so
the two agree.) SQL `NULL` never reaches a transform — `encodeCompositeKey` exempts it
and emits the `0x00` NULL tag, which sorts below the BLOB tag the structural bytes
travel under, matching `compareNulls` / `orderByNullResult`'s NULL-first placement.

### 3. Probe values are a separate question

`semanticKeyOrderIsFaithful` is a claim about values the table **holds**. A seek bound
is a value from the query, which nothing coerces to the column's declared type. Two
concrete under-fetches result:

- `where d > 5` on a `timespan` column. `createTypedComparator` short-circuits on the
  storage-class mismatch *before* `TIMESPAN.compare` runs, so every stored (TEXT-class)
  value ranks above the NUMERIC probe and the predicate admits every row. But
  `groupKey(5)` passes the non-string through unchanged, so the byte window is
  `> NUMERIC(5)` and a row storing `'PT1S'` (total 1) falls outside it. Rows lost.
- `where d > 'not a duration'`. `TIMESPAN.compare` falls back to BINARY text against the
  canonical stored text; `groupKey` falls back to the raw text, which encodes TEXT-tagged
  and therefore sorts above every NUMERIC-tagged stored key. Different position, rows lost.

So add the companion predicate:

```ts
/**
 * True when `probe`'s key bytes sit at the position the type's `compare` gives it relative to
 * every STORED value — the per-VALUE precondition a re-opened window needs on top of
 * {@link semanticKeyOrderIsFaithful}, which is a claim about stored values only.
 */
export function semanticProbeIsKeyFaithful(type: LogicalType | undefined, probe: SqlValue): boolean;
```

- Not a semantic-ordering type ⇒ `true` (nothing to check).
- `TIMESPAN` ⇒ `typeof probe === 'string' && typeof type.groupKey?.(probe) === 'number'`.
  A number output means the value parsed; the raw-string fallback (or a non-string
  probe) means it has no faithful byte position. Call `type.groupKey` — the column's own
  type object — not the imported singleton's, for the dual-instance reason above.
- `JSON` ⇒ `jsonKeyEncodable(probe)` (new, below).
- Anything else ⇒ `false` (kept consistent with `semanticKeyOrderIsFaithful`, which is
  also false there, so no window is built for such a type anyway).

### 4. `jsonKeyEncodable` (new, json-key.ts)

A recursive walk returning `false` iff the value holds a `Uint8Array` or a `bigint`
anywhere, `true` otherwise:

- **Blob.** `pushJsonNode` raises `INTERNAL` for one, while `createTypedComparator`
  happily ranks it by storage class (BLOB, between TEXT and OBJECT). Declining keeps
  `where j > x'01'` returning its rows instead of erroring.
- **Bigint.** The structural encoder folds it to a double (lossy above 2^53), while
  `deepCompareJson`'s `jsonTypeOrder` drops a bigint into its `default:` arm and gives it
  the *object* rank — so the comparator and the bytes place it in two different regions
  entirely. Decline.
- **Unpaired surrogate in a string leaf or object key.** Deliberately **not** declined:
  `jsonStructuralKey` raises, and it must keep raising. That is the rule the text PK
  already carries — `lone-surrogate-keys.spec.ts` § "rejects a range-seek bound built
  from a lone-surrogate literal" — a bound with no faithful byte position is refused,
  never silently widened or narrowed. This is a behaviour change for a `json` column
  (today such a query full-scans and answers by storage class); the change is intended
  and needs a test naming it.

Keep the walk in json-key.ts next to `pushJsonNode` so the two node-kind switches stay
visibly paired. It runs on probe values only — a handful per query.

### 5. Range windows widen; they never decline

Both range-bound builders already skip a NULL/missing bound, on the argument that
skipping only *widens* the window and `matchesFilters` remains the authoritative
collation- and type-aware row filter. Extend that same skip:

```ts
if (c.value === undefined || c.value === null) continue;
if (!semanticProbeIsKeyFaithful(logicalType, c.value)) continue;   // widen, don't decline
```

- `buildPKRangeBounds` — the column is `access.columnIndex` (the leading PK member).
- `buildIndexRangeBounds` — the leading index column; pass its `logicalType` in
  alongside the existing `dir` / `collation` arguments.

Dropping every bound degrades to full-scan bounds, which is exactly the pre-ticket
behaviour. Note the asymmetry in the code comments: a *range* bound can be dropped
because the window only grows; an *equality* window cannot (that is why the point arms
in the follow-up ticket must decline rather than widen).

The planner side claims range filters handled from the **schema** alone
(`pkOrderPreservingPrefixLength` / `indexLeadingRangeIsOrderSafe`), so a runtime widen
on an unfaithful probe cannot lose a predicate: the residual `Filter` the engine dropped
is reproduced by `matchesFilters`, which every scan arm applies. Say so where the widen
happens — it is the non-obvious part.

### 6. Thread index key transforms into the byte windows

`encodePkPrefixBounds` and `encodeDataKey` already pass `this.pkKeyTransforms`, so the
**PK** side needs no plumbing. The **index** side does: all three
`buildIndexPrefixBounds` call sites pass no `transforms`, which key-builder.ts's own NOTE
flags as sound only while every semantic-ordering column is declined upstream. Without
this, a re-opened index range window would address raw-value bytes while the index store
holds transformed ones — and it would under-fetch silently, since a range window
carries no residual able to resurrect a missed row (the engine's `Filter` is gone;
`matchesFilters` only rejects, it cannot add rows a window skipped).

Add a memoized `indexKeyTransforms(index)` to `StoreTableScan`, mirroring
`indexKeyCollations` exactly — same `WeakMap<TableIndexSchema, {columns, transforms}>`
shape and the same "invalidate when the columns array is replaced" rule (an ALTER can
retype a column without minting a new index object). Back it with the existing
`resolveIndexKeyTransforms` in pk-key-resolution.ts. Thread it into **all three**
call sites — `analyzeIndexAccess`'s prefix arm, `buildIndexRangeBounds`, and
`scanMultiSeek` — even though the first and third only ever see `undefined` entries
today. Uniformity is the point: the footgun the NOTE describes goes away instead of
moving. Rewrite that NOTE to say the transforms are now threaded.

### 7. What needs no change (verify, don't rewrite)

- `computeBestAccessPlan` / `tryIndexAccessPlan` / `buildPkOrderingAdvertisement` —
  all three read the shared predicates, so re-opening `keyOrderMatchesCollation` opens
  the plan side automatically. Confirm with `query_plan` output in the tests.
- `analyzePKAccess`'s point arm and `analyzeIndexAccess`'s EQ-prefix arm — still declined
  via `pkHasSemanticOrderingMember()` / the `hasSemanticOrdering` prefix break. **Leave
  them alone**; they are the follow-up ticket.
- The multi-seek declines (`tryIndexAccessPlan`'s `isMultiSeek` arm,
  `scanMultiSeek`'s and `scanMultiSeekPrimary`'s `multiSeekMalformed` throws) — stay as
  they are. A multi-seek drops the residual across its merged windows and has no
  widen-to-full-scan degradation available. Tracked in backlog
  `feat-store-semantic-key-multiseek`.
- `getIndexComparator` already claims the type's `compare` as the emitted index-key byte
  order for a semantic-ordering column, so it is already consistent with this re-open.
- UNIQUE enforcement, `keysEqual`, the isolation overlay's PK comparators — all already
  route through the transforms and `resolvePkSemanticEquality`.

## Edge cases & interactions

Every one of these needs a test. The memory table is the oracle throughout: assert the
store's rows/order equal the same query against an identical non-store table.

**Under-fetch regressions (the reason the probe gate exists)**

- `where d > 5` on a `timespan` PK — numeric probe, storage-class mismatch. Store must
  return exactly what memory returns (every row).
- `where d > 'not a duration'` on a `timespan` PK — unparseable string probe, BINARY-text
  fallback. Must equal memory.
- `where j > x'01'` on a `json` PK — blob probe. Must equal memory and must **not** raise
  `INTERNAL`.
- A `timespan` **secondary index** with a range predicate — the transform-threading
  regression. Without threaded transforms the window addresses raw-text bytes and the
  query returns nothing; assert both the rows and that the plan seeks.

**Raise, don't widen**

- A `json` range bound whose string leaf or object key carries an unpaired surrogate must
  raise with the existing `unpaired surrogate` message shape (drain a `select`; the error
  surfaces on first pull, per `lone-surrogate-keys.spec.ts`'s `rejects` helper). Add it to
  that spec's `describe('a declared `json` primary key')` block, alongside the text-PK
  precedent it mirrors.

**Collation shapes that must STAY declined**

- `create index ix on t (j collate nocase)` over a `json` column, then a range predicate:
  no seek, rows still correct. `keyOrderMatchesCollation`'s fall-through is what declines
  it; a `return true` short-circuit would break this test.
- Same shape over a `timespan` index column.

**Ordering advertisement**

- `order by <timespan pk>` — no `Sort` in the plan, order equals the memory table's, and
  equals `['PT90M','PT2H']` for that pair.
- `order by <json pk>` over mixed kinds (`null`, `true`, `{"a":1}`) — no `Sort`, order
  equals memory. `json-semantic-key-order.spec.ts` already pins that sequence; it becomes
  a test of the store's byte order rather than of `Sort`.
- **DESC** PK member (`d timespan primary key desc`) — `order by d desc` elides the Sort
  and matches memory. Bit-inversion over a variable-length escaped encoding (the JSON
  case) inverts the `0x00` terminator to `0xff`, which is above every inverted content
  byte, so a proper prefix correctly sorts last; assert it rather than assume it.
- **Composite PK** `(d timespan, id integer)` — the advertisement covers both members;
  `order by d, id` elides the Sort and a range on `d` seeks.
- Composite PK whose **second** member is semantic-ordering — the order-preserving prefix
  length must still count it (both members are faithful).
- A **partial** prefix: composite PK `(t text collate <equality-only custom collation>,
  d timespan)` — the prefix must truncate at the text member, so `order by t, d` still
  Sorts. `collation-order-preserving.spec.ts` has the custom-collation fixtures.

**Ranges**

- `where d >= 'PT59M'` finds a row stored as `'PT1H'` — the bound and the stored value
  are different spellings; the window must be in elapsed-time space, not text space.
- `BETWEEN` (one lower + one upper bound) and a redundant same-side pair (the tighter must
  win) over a `timespan` PK.
- A range whose window is empty must return no rows without scanning past it.
- NULL in a semantic-ordering **secondary-index** column (nullable, unlike a PK member) —
  the index scan must place NULL first, matching memory.

**Cross-subsystem**

- **Isolation overlay.** The advertisement's real consumer. Inside a transaction, insert /
  update / delete a `timespan`- and a `json`-keyed row, then `order by <pk>` and a range
  query: the overlay merges its pending rows against the underlying stream by the PK
  comparator, and the underlying stream is now advertised as ordered — the two must
  interleave correctly. `json-semantic-key-order.spec.ts`'s second `describe`
  (`createIsolatedStoreModule`) is the fixture to extend.
- **Read-your-own-writes over a narrowed window.** `iterateEffective` restricts the
  pending merge to the same `bounds`, so a pending row inside the range window must
  appear and one outside must not — the range arm now narrows where it previously
  full-scanned.
- **ALTER.** `alter table … alter column d set type timespan` (from `text`) followed by an
  `order by` / range query — `updateSchema` recomputes the transforms and collations, so
  the advertisement must be live against the new schema on the same table instance.
  Also confirm the backfill rejects an unparseable existing value (that is what keeps the
  stored-value claim true).
- **Multi-seek stays declined.** `where d in ('PT1H','PT2H')` on an indexed `timespan`
  column must still return the correct rows (cost-only plan, residual retained) and must
  not throw.

## TODO

### Phase 1 — predicates

- Add `jsonKeyEncodable(value: SqlValue): boolean` to `json-key.ts`: recursive walk,
  false on any `Uint8Array` or `bigint` node, true otherwise. Document why unpaired
  surrogates are deliberately *not* declined here.
- Add `semanticKeyOrderIsFaithful` and `semanticProbeIsKeyFaithful` to
  `pk-key-resolution.ts`, with the reasoning above in their doc comments (why an explicit
  allow-list; why the probe question is separate from the stored-value question; the two
  concrete TIMESPAN under-fetches).
- Import `TIMESPAN_TYPE` from `@quereus/quereus` in `pk-key-resolution.ts`.
- Unit-test the predicates directly (a new spec or an addition to `json-key.spec.ts`),
  independent of any SQL plumbing.

### Phase 2 — re-open the gate

- Rewrite `keyOrderMatchesCollation`'s semantic-ordering branch to fall through to the
  collation checks for a faithful type; update its doc comment and drop the
  `feat-reopen-timespan-store-seeks` reference.
- Verify (do not rewrite) that `pkOrderPreservingPrefixLength`,
  `indexLeadingRangeIsOrderSafe`, `computeBestAccessPlan`,
  `buildPkOrderingAdvertisement` and `leadingPkRangeIsOrderSafe` all open as a
  consequence.

### Phase 3 — index transform plumbing

- Add memoized `indexKeyTransforms(index)` to `StoreTableScan`, mirroring
  `indexKeyCollations` (same WeakMap + columns-identity invalidation).
- Thread `transforms` into all three `buildIndexPrefixBounds` call sites.
- Rewrite the NOTE in `key-builder.ts` (`buildIndexPrefixBounds`, ~line 365) to record
  that transforms are now threaded.

### Phase 4 — probe gating on range bounds

- `buildPKRangeBounds`: skip a bound failing `semanticProbeIsKeyFaithful` for the leading
  PK column's type.
- `buildIndexRangeBounds`: take the leading index column's `logicalType` and do the same;
  update its caller in `analyzeIndexAccess`.
- Document the widen-vs-decline asymmetry at both sites.

### Phase 5 — tests

- Update the three "Sort still runs" / "window declined" assertions:
  `any-json-pk-binary-key.spec.ts` (the `json` PK advertisement, the `timespan` PK
  advertisement, and the `timespan` PK range scan), `timespan-semantic-key-identity.spec.ts`
  (~line 135), `json-semantic-key-order.spec.ts` (~line 176). Rewrite the file-header
  comments in all three: they currently *explain* the declines.
- Add the lone-surrogate `json` range-bound rejection to `lone-surrogate-keys.spec.ts`.
- Add the edge-case tests enumerated above. Prefer extending `pushdown.spec.ts` for
  seek/plan assertions and `any-json-pk-binary-key.spec.ts` for the advertisement ones,
  rather than minting a new spec file per case.

### Phase 6 — docs

- `docs/types.md` § Semantic ordering (~line 480): rewrite the "seeks over
  semantic-ordering members remain declined" paragraph. Point the remaining declines
  (equality seeks, multi-seek) at the two follow-up slugs.
- `docs/store.md` § "What the PK-order advertisement is measured against" (~line 670):
  the semantic-ordering sentence now states the per-type assertion and the probe gate.
- Update the slug references in `pk-key-resolution.ts` (~line 327),
  `store-table-scan.ts` (~line 137) and `key-builder.ts` (~line 370).

### Phase 7 — validate

- `yarn build`
- `yarn workspace @quereus/store run test 2>&1 | tee /tmp/store-test.log; tail -n 80 /tmp/store-test.log`
  (confirm the package's actual workspace name and test script first)
- `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- `yarn lint`
- `yarn test:store` exercises the store path against LevelDB and is the natural home for
  a regression here; run it if it fits the idle-timeout window, and say in the handoff
  whether it ran.

## Notes for the implementer

- `store-table-scan.ts` is 1023 lines and `store-table-base.ts` is 1033 (`wc -l`), both
  past the ~1000-line seam `docs/store.md` records for this chain. Keep new logic in
  `pk-key-resolution.ts` / `json-key.ts` where it naturally belongs rather than growing
  the scan layer. The split itself is backlog `debt-split-store-table-scan-and-base`.
- `store-module-access-plan.ts` is the deliberate mirror of `store-table-scan.ts`: a plan
  that claims a filter the scan then declines to window drops the residual `Filter` and
  returns wrong rows. Any change to one is a change to the other — that is why this
  ticket keeps every decline in the shared predicates rather than restating them.
