---
description: The persistent store still orders and deduplicates duration and JSON primary keys by their raw text bytes; it must stop advertising that order as meaningful and must treat equal-meaning values (like "1 hour" vs "60 minutes") as the same key.
prereq: duration-json-semantic-ordering-engine
files:
  - packages/quereus-store/src/common/store-table.ts             # keyOrderMatchesCollation, pkOrderPreservingPrefixLength (~line 193-232), leadingPkRangeIsOrderSafe
  - packages/quereus-store/src/common/store-module.ts            # buildPkOrderingAdvertisement (~line 2913), range-seek gating (~line 2689)
  - packages/quereus-store/src/common/key-builder.ts             # PK key byte encoding
  - packages/quereus/src/types/temporal-types.ts                 # TIMESPAN.compare — reference-date resolution to reuse for normalization
  - packages/quereus/src/types/json-type.ts                      # JSON canonical text — already identity-faithful
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # asserts byte-order advertisement for `any` PK — verify declared type, likely unaffected
difficulty: hard
---

# Semantic ordering for TIMESPAN and JSON — persistent store side

## Context

Prereq `duration-json-semantic-ordering-engine` records the ruling (see its header section):
**a value's canonical order is its logical type's `compare`** — TIMESPAN by elapsed time,
JSON by structural deep-compare. The engine side makes Sort, comparison operators, and row
identity follow that rule. This ticket makes the persistent store stop contradicting it.

The store physically orders PK keys by memcmp of encoded bytes (canonical text for these
types). Two consequences under the ruling:

1. **Ordering advertisement is now a lie for these types.** `PT2H` < `PT90M` in bytes but
   `PT2H` > `PT90M` in elapsed time. If the store advertises PK order (`providesOrdering` /
   `monotonicOn`) or claims a leading-PK range seek on a TIMESPAN or JSON member, the
   absorb-Sort rule elides a Sort that would now produce a *different* (semantic) order, or a
   byte-window seek returns semantically wrong rows.
2. **Key identity is wrong for TIMESPAN.** `PT60M` and `PT1H` are the same elapsed time but
   different bytes: the store accepts both as distinct PK rows, while the ruling (and the
   in-memory table) says duplicate. JSON is fine on identity — canonical-text encoding already
   equates structurally-equal values (`canonicalJsonString` sorts object keys); only JSON
   *ordering* diverges from bytes.

## Already landed by the prereq (engine ticket) — do not redo

The engine ticket (`duration-json-semantic-ordering-engine`) had to touch the store to keep
its test suite green, and landed the read-side declines ahead of this ticket:

- `keyOrderMatchesCollation` now returns false for a semantic-ordering member (it checks the
  new `LogicalType.semanticOrdering` flag via the engine's exported `hasSemanticOrdering`),
  which voids the PK-order advertisement and byte-window range seeks through the existing
  `pkOrderPreservingPrefixLength` / `leadingPkRangeIsOrderSafe` machinery (former work item 1).
- The stale `pkOrderPreservingPrefixLength` doc comment was rewritten (former work item 2).
- Beyond the original plan, byte-EQUALITY windows were also declined — `analyzePKAccess`'s
  point arm and `analyzeIndexAccess`'s EQ-prefix arm stop at a semantic-ordering member,
  because a byte-EQ window UNDER-fetches the type's equality (`PT120M` never hits the
  `PT2H` key) and no residual can resurrect a skipped row.
- `matchesFilters` → `compareValues` now compares a pushed constraint on a semantic-ordering
  column through `createTypedComparator` (the full-scan residual is type-aware).
- `any-json-pk-binary-key.spec.ts` was updated: json/timespan PK ordering asserts a real Sort
  matching the memory table; a timespan PK range-scan test was added (former work item 5's
  first half). `yarn test` and `yarn test:store` are green with all of the above.

## Remaining work

3. **Normalize TIMESPAN key identity.** Encode TIMESPAN PK / unique-index key members in a
   canonical semantic form so semantically-equal spellings collide (`PT60M` ≡ `PT1H` → one
   key). Normalization must place equal-`compare` values on identical bytes, using the same
   reference-date resolution as `TIMESPAN.compare` for calendar units (`P1M` etc.). The
   key-normalizer path the store already uses for collation folding (`KeyNormalizer` /
   `resolvePkKeyCollations` plumbing) is the natural hook. The stored row still returns the
   original inserted text (normalization affects key identity, not the serialized row) — same
   contract as NOCASE key folding.
4. **Unique/secondary indexes** over these types get the same identity treatment as the PK.
5. **Tests.** Re-check `any-json-pk-binary-key.spec.ts`: an `any`-typed PK has no custom
   `compare`, so byte order remains legitimate there — the rule keys on the declared logical
   type. If the spec covers json-*typed* keys, update those assertions. Add store logic
   coverage (run via `yarn test:store`) for: timespan-PK ordering matches memory table,
   duplicate rejection of `PT60M` after `PT1H`, range predicate on timespan PK returns
   semantically correct rows via residual filter, JSON PK `order by` returns structural order.

## Edge cases & interactions

- **Composite PKs**: a TIMESPAN member mid-key truncates the ordering-advertisement prefix at
  its position (existing truncation semantics); identity normalization still applies to that
  member regardless of position.
- **Existing on-disk data** written with unnormalized keys: backwards compatibility is
  explicitly not a goal yet (project-wide stance) — no migration required, but say so in the
  handoff so the reviewer doesn't flag it.
- **Calendar-unit durations** (`P1M`, `P1Y`): normalization and `compare` must agree — same
  reference date — or two values could normalize equal but compare unequal (or vice versa).
- **Uniqueness conflict reporting**: rejecting `PT1H` as a duplicate of `PT60M` must surface
  as the ordinary UNIQUE/PK constraint violation (and honor `on conflict` actions), not a
  store-level error.
- **Isolation layer** (`quereus-isolation`): overlay/underlying merge adopts the table's PK
  comparator — verify the store's comparator/encoder change keeps overlay shadowing intact
  for normalized keys (a write of `PT1H` must shadow a committed `PT60M` row).
- **Declarative schema round-trip**: no schema-shape change expected, but the equivalence
  harness should stay green.

## TODO

- TIMESPAN key normalization (PK + unique indexes) via the key-normalizer path; the engine
  now exposes `TIMESPAN_TYPE.groupKey` (total seconds against the same reference date as
  `compare`) — reuse that resolution so key identity and `compare` cannot drift
- Duplicate rejection test: insert `PT60M` after `PT1H` into a timespan PK → UNIQUE/PK
  violation honoring `on conflict` (today the store accepts both as distinct rows while the
  memory table collapses them — the remaining identity gap)
- Once identity keys are order-preserving-normalized (total seconds), consider re-opening the
  seek/advertisement declines the engine ticket added (they key off `semanticOrdering` in
  `keyOrderMatchesCollation` / `analyzePKAccess` / `analyzeIndexAccess`) — decline is correct
  but costs full scans on such columns
- Engine planner note: a full-PK EQ on a semantic-ordering PK still lets the ENGINE infer
  ≤1-row from PK uniqueness, but the store can hold two semantic-equal spellings until key
  normalization lands — normalization closes this soundness gap too
- Isolation-layer shadowing check (`PT1H` write shadows committed `PT60M`) per edge cases
- `yarn test` + `yarn test:store` green
- Update `docs/` store/module notes if they state byte-order guarantees for these types
