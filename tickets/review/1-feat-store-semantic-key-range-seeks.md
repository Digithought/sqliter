---
description: The persistent store now uses its already-correctly-ordered key bytes to answer sorting and range-filter queries over duration (TIMESPAN) and JSON key columns directly, instead of reading the whole table and re-sorting. Review the soundness gates and the tests that pin them.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts        # semanticKeyOrderIsFaithful, semanticProbeIsKeyFaithful, keyOrderMatchesCollation fall-through
  - packages/quereus-store/src/common/json-key.ts                 # jsonKeyEncodable
  - packages/quereus-store/src/common/store-table-scan.ts         # probe gates on both range-bound builders; indexKeyTransforms memo; transforms threaded into 3 buildIndexPrefixBounds sites
  - packages/quereus-store/src/common/key-builder.ts              # buildIndexPrefixBounds NOTE rewritten (transforms now threaded)
  - packages/quereus-store/test/semantic-key-predicates.spec.ts   # NEW — unit tests for the three predicates
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts    # 3 rewritten assertions + new "re-opened windows" describe (12 tests)
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # advertisement test, 2 ALTER tests, 2 isolation-merge tests
  - packages/quereus-store/test/json-semantic-key-order.spec.ts   # Sort-elision test, 2 isolation-merge tests
  - packages/quereus-store/test/collation-order-preserving.spec.ts # timespan index seek re-opened; partial-prefix truncation test
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts       # json range-bound lone-surrogate rejection
  - packages/quereus-store/test/pushdown.spec.ts                  # timespan window visit-count + empty-window tests
  - docs/types.md                                                 # § Semantic ordering rewritten
  - docs/store.md                                                 # § advertisement paragraph rewritten
---

# Review: re-opened ordering advertisements and range windows over TIMESPAN / JSON key columns

## What was built

The store's key bytes for TIMESPAN (total-seconds transform) and JSON (structural byte
form) already memcmp in each type's `compare` order; only the read side still declined
every seek/advertisement over such columns. This ticket re-opens the **order-shaped**
half — ordering advertisements and leading-column range windows — behind two new gates
in `pk-key-resolution.ts`:

- `semanticKeyOrderIsFaithful(type)` — an explicit per-type allow-list (name-matched
  TIMESPAN + JSON), deliberately not inferred from "a transform exists". Anything else
  keeps the old blanket decline.
- `semanticProbeIsKeyFaithful(type, probe)` — the per-VALUE gate on seek bounds (query
  values are never coerced to the column type): TIMESPAN requires a string whose
  `groupKey` parses to a number; JSON requires `jsonKeyEncodable` (new, json-key.ts —
  false iff a `Uint8Array` or `bigint` appears anywhere in the value).

`keyOrderMatchesCollation` now **falls through** to its collation checks for a faithful
type instead of returning false (or true) early — the fall-through is what still
declines a `json`/`timespan` INDEX column carrying an explicit non-BINARY `COLLATE`.
Both range-bound builders (`buildPKRangeBounds`, `buildIndexRangeBounds`) **skip** an
unfaithful bound the same way they skip a NULL one: a dropped range bound only widens
the window, and `matchesFilters` reproduces the predicate under the type's compare.
The index side additionally got `StoreTableScan.indexKeyTransforms` (WeakMap memo
mirroring `indexKeyCollations`, invalidated when the columns array is replaced) threaded
into **all three** `buildIndexPrefixBounds` call sites — without it a re-opened index
range window addresses raw-value bytes while the index holds transformed ones and
silently under-fetches.

Left alone on purpose: the PK point arm and index EQ-prefix arm (declined via
`pkHasSemanticOrderingMember` / the `hasSemanticOrdering` prefix break — that is
`feat-store-semantic-key-point-seeks`, sequence 2 in implement/), and every multi-seek
decline (backlog `feat-store-semantic-key-multiseek`). No change was needed in
`store-module-access-plan.ts` — it reads the shared predicates, and the plan side opened
automatically (confirmed via `query_plan` assertions in the tests).

## Findings the ticket asked to be stated

**Stored-value claim verified by reading the write paths, not taken on trust.**
`StoreTable`'s insert and update arms (store-table.ts:364, 468) run every non-`preCoerced`
row through `coerceRowToSchema` → `validateAndParse` → `TIMESPAN_TYPE.parse`, which
raises a `TypeError` for anything `Temporal.Duration.from` / the human-readable fallback
cannot read and normalizes survivors to `Duration.toString()`; `preCoerced` means the
engine's DML emitter already ran the same `validateAndParse`. The ALTER retype backfill
uses `validateAndParse` too — a new test pins that it refuses an unparseable existing
value. So every stored TIMESPAN parses, `groupKey` is numeric for all stored values, and
the TEXT-tagged raw-text fallback is unreachable for stored keys. JSON stored values are
`JSON_TYPE.parse` outputs (never blob/bigint), all encodable by `jsonStructuralKey`.

**Deliberate behaviour change:** a range bound on a declared-`json` PK whose string (or
object key) carries an unpaired surrogate now RAISES (`unpaired surrogate` message)
where it previously full-scanned. This mirrors the text-PK rule and is pinned in
`lone-surrogate-keys.spec.ts` § "a declared `json` primary key".

## Use cases to validate in review

- **Under-fetch regressions (the reason the probe gate exists):** `where d > 5` and
  `where d > 'not a duration'` on a timespan PK, `where j > x'01'` on a json PK — each
  must equal the memory table (and the blob probe must not raise INTERNAL). Pinned in
  any-json-pk-binary-key.spec.ts.
- **Transform threading:** a range over a timespan **secondary index** must seek AND
  return the memory table's rows (collation-order-preserving.spec.ts "re-opens the
  TIMESPAN index range"). Without threading, the seek returns nothing.
- **Fall-through decline:** `create index … (j collate nocase)` / `(d collate nocase)`
  + range → no seek, rows correct.
- **Advertisements:** timespan PK / json PK `order by` with no Sort in the plan; DESC
  members (including json's inverted variable-length encoding — proper prefix sorts
  last); composite PKs with the semantic member leading or second; truncation at an
  equality-only custom-collation text member ahead of a timespan member.
- **Cross-subsystem:** isolation-overlay merge over the now-advertised ordered stream
  (staged insert/update/delete interleave at elapsed-time/structural positions; range
  windows include a pending row inside and exclude one outside); ALTER retype to
  timespan re-resolves the memoized index transforms on the same table instance;
  IN-list on an indexed timespan column stays cost-only (re-spelled member still
  matches) and does not throw.
- **Window narrowing is real:** pushdown.spec.ts counts visited entries (≤4 of 60 for a
  selective range; 0 for an empty window).

## Validation performed

- `yarn build` — clean.
- `yarn workspace @quereus/store run test` — 1326 passing, 0 failing.
- `yarn test` — all workspaces green (engine 8612 passing / 13 pending; no failures).
- `yarn test:store` (logic suite vs LevelDB) — 8604 passing / 21 pending, 0 failing. Ran to completion in ~4 minutes.
- `yarn lint`, `yarn workspace @quereus/store run typecheck` — clean.

## Known gaps / notes for the reviewer

- **JSON range windows with plan-level seek assertions are thin.** The json-PK seek
  correctness is covered via memory-oracle row equality (blob probe, lone-surrogate
  raise, isolated-range merge with a `json(…)` bound), but no test asserts a
  *plan-level* SEEK plus visit-count narrowing for a json PK the way pushdown.spec does
  for timespan. Text-literal probes on json columns are TEXT-class (they rank below all
  arrays/objects), so a selective json window needs a `json(…)`-valued bound; whether
  the planner pushes that as a constraint was not separately verified — the tests
  assert row correctness either way.
- **`getIndexComparator` order-agreement for timespan index columns inside the overlay
  merge** is exercised only indirectly (the isolated-store secondary-index shadowing
  test pre-dates this ticket and passes). No new test drives an isolation merge off a
  *range-seeked* timespan secondary index specifically.
- The engine-side absorb-Sort behavior is trusted through `query_plan` output; no
  assertion inspects `providesOrdering` fields directly.
- `store-table-scan.ts` grew from 1023 to 1085 lines (`wc -l`), further past the
  ~1000-line seam docs/store.md records. New logic went to pk-key-resolution.ts /
  json-key.ts where possible; the split remains backlog
  `debt-split-store-table-scan-and-base`.
