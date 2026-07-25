---
description: The persistent store now treats equal-meaning duration values (like "1 hour" vs "60 minutes") as the same key — duplicates are rejected, conflict actions fire, and staged transaction writes shadow the committed row across spellings.
files:
  - packages/quereus/src/util/comparison.ts              # semanticKeyTransform helper
  - packages/quereus/src/index.ts                        # exports semanticKeyTransform + serializeKey
  - packages/quereus-store/src/common/encoding.ts        # KeyValueTransform; transforms in encodeCompositeKey
  - packages/quereus-store/src/common/key-builder.ts     # transforms threaded through all key/bounds builders
  - packages/quereus-store/src/common/store-table.ts     # resolvePkKeyTransforms / typed unique compares / keysEqual / rekeyRows
  - packages/quereus-store/src/common/store-module.ts    # index rebuild transforms; dedupe signatures; ALTER SET TYPE handling
  - packages/quereus-isolation/src/isolated-table.ts     # shadow keys, comparePK, keysEqual, merged UNIQUE compares
  - packages/quereus-isolation/src/overlay-rows.ts       # makePkKeySerializer canonicalizes
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts   # coverage (16 tests)
  - docs/types.md                                        # store identity paragraph in "Semantic ordering"
---

# Semantic key identity for TIMESPAN in the persistent store — complete

## What shipped

Under the semantic-ordering ruling (docs/types.md), a value's identity is its logical
type's `compare`. The store used to accept `'PT1H'` and `'PT60M'` as two distinct
primary-key rows while the in-memory backend collapsed them to one. Closed by threading
one new concept everywhere key bytes are made:

- The engine exports `semanticKeyTransform(logicalType)` — the type's `groupKey` as a
  value transform, defined only where the stored form is not canonical for equality
  (today: TIMESPAN → total seconds against the same reference date `compare` uses).
- `quereus-store` threads per-column transforms (parallel to the existing per-column key
  collations) through `encodeCompositeKey` → `buildDataKey` / `buildIndexKey` /
  `buildPkPrefixBounds` / `buildIndexPrefixBounds`. `StoreTable` resolves them once and
  every key-producing path uses them: DML data keys, secondary-index maintenance, the
  UNIQUE-enforcement probe, `rekeyRows` (ALTER), and `StoreModule.buildIndexEntries`.
- Value-level equality sites got the matching typed compare: `StoreTable.keysEqual`, the
  three UNIQUE conflict finders, and the build-time dedupe signatures.
- ALTER `SET DATA TYPE` onto/off a transform-bearing type re-validates UNIQUEs and
  rebuilds secondary indexes.
- Isolation layer: overlay PK shadow keys, `keysEqual`, the fallback `comparePK`, merged
  UNIQUE compares, and descriptor comparators are all semantic-aware — a staged `'PT1H'`
  write shadows a committed `'PT60M'` row.

Because TIMESPAN's transform yields a number, its key bytes now also ORDER by elapsed
time — but the read-side ordering declines were deliberately left closed. Re-opening is
backlog `feat-reopen-timespan-store-seeks`.

## Review findings

### Checked

Read the implement diff first, then the surrounding code: every `buildDataKey` /
`buildIndexKey` / `encodeCompositeKey` / `*PrefixBounds` call site in the repo (two
`buildIndexPrefixBounds` sites pass no transforms — both are correctly unreachable for a
semantic-ordering column, guarded by the prefix break in `analyzeIndexAccess` and by
`keyOrderMatchesCollation` respectively); the ALTER `alterColumnChange` rework; the
dedupe-signature rewrite; the whole isolation diff; `docs/types.md`; and the interaction
with the triage commit that landed on `comparison.ts` after the implement commit.
Behaviour was probed live against the in-memory KV provider rather than reasoned about:
JSON and TIMESPAN primary-key scan order (store vs memory), overlay shadowing under a
transaction, DESC primary keys, fractional durations, and non-unique index rebuild after
`set data type timespan`.

`yarn lint` and `yarn typecheck` green. `yarn test` green (no failures across all
workspaces). `yarn test:store` **7174 passing, 0 failing** — the pre-existing
`15.1-semantic-ordering.sqllogic` failure the implementer reported was fixed by the
triage commit that followed, so nothing remains outstanding there.

### Major — new tickets filed

- **`fix/bug-json-pk-store-scan-order`** — a JSON primary key in the store is scanned in
  canonical-text byte order while JSON's own `compare` (and the memory backend) orders it
  structurally. Under a transaction the isolation merge cannot align the two streams:
  an updated row surfaces **twice**, and a deleted row stays visible for the rest of the
  transaction. Reproduced live (`[2]` / `[10]` / `[3]` keys). Confirmed **pre-existing** —
  reproduces with this ticket's isolation changes reverted — but it is the same
  order-vs-identity question this ticket answered for TIMESPAN, and JSON was left with an
  identity-faithful key that is not order-faithful. `docs/types.md` now says so and points
  at the ticket.
- **`fix/bug-sync-pk-metadata-key-identity`** — the handoff flagged `quereus-sync` as
  unexamined; it is. `encodePK` is a bare `JSON.stringify` of the raw primary-key values,
  so sync's per-row column-version and tombstone records are filed under the literal
  spelling. A collated text key (`'apple'` / `'APPLE'`) or a duration key
  (`'PT1H'` / `'PT60M'`) can split one row into two sync identities. Found by reading, not
  reproduced — the ticket's first task is the failing test.

### Minor — fixed in this pass

- Added a regression test: overlay shadowing across spellings when the scan is driven by
  a secondary index rather than the plain primary-key merge
  (`timespan-semantic-key-identity.spec.ts`, now 16 tests).
- `docs/types.md` "Semantic ordering" claimed JSON store keys are fine because canonical
  text is identity-faithful. True for identity, misleading about ordering — corrected,
  with a pointer to the JSON ticket.

### Tripwire — parked as a code comment, not a ticket

`resolvePkKeyTransforms` in `packages/quereus-store/src/common/store-table.ts` now carries
a `NOTE:` recording that `StoreTable` publishes no `comparePrimaryKey`, so the isolation
layer merges against its own type-based comparator and this table's key **byte order** has
to agree with it. Identity-faithful is not enough — the next semantic-ordering type added
needs an order-preserving transform, or it repeats the JSON failure.

### Verified as non-issues

- `TIMESPAN.groupKey` cannot throw: unparseable input returns the raw string, non-strings
  pass through. A bad value can never crash a key encode.
- The `keyTransformChanged` gate in `alterColumnChange` compares against `undefined`, not
  between two freshly-allocated closures — correct despite `semanticKeyTransform` returning
  a new function each call.
- `dedupeRowSignature`'s transform array is positionally aligned with its `colIndices` at
  both call sites.
- A JSON primary key takes the BINARY key collation (`pkKeyCollationName`), so the new
  structural `keysEqual` does not disagree with the key bytes on letter case.
- DESC primary keys, composite keys with a mid-key duration member, and fractional
  durations (`'PT1.5H'` vs `'PT90M'`) all collapse correctly — transforms are applied
  before DESC byte inversion.

### Empty categories, stated explicitly

- **No pre-existing test failures to report.** `tickets/.pre-existing-known.md` is empty
  and both suites are green, so no `.pre-existing-error.md` was written.
- **No blocked items.** Nothing here needs a human decision that the two filed tickets
  cannot carry.
- **`mergedSecondaryIndexQuery`'s shadow set remains code-review-only**, as the implementer
  admitted. Three attempts to reach it (non-unique index, unique index, instrumented call
  site) all showed the planner choosing a different access path for an isolated store
  table, so it could not be driven from SQL. The new secondary-index test exercises the
  neighbouring path and passes; the gap is recorded here rather than papered over.

## Known limitations carried forward (not re-flagged)

- Memory backend still admits `'PT60M'` after `'PT1H'` in a plain UNIQUE column —
  `fix/bug-memory-unique-timespan-spelling`.
- On-disk data written before this change is not migrated; backwards compatibility is
  waived project-wide (AGENTS.md).
- The `alterColumnChange` primary-key-rekey-on-retype arm is unreachable through SQL today
  (the engine bans `set data type` on a primary-key column) — kept as defense in depth.
- Adjacent in-flight tickets touch the same ALTER region:
  `fix/bug-set-data-type-skips-unique-index-revalidation` (still valid — the new gate
  re-validates only transform changes) and
  `fix/bug-store-pk-column-set-data-type-corrupts-keys` (may be partly obsoleted by the
  engine-level ban; worth checking during its triage).

## Tickets spawned by this ticket (implement + review)

- `fix/bug-json-pk-store-scan-order` — review.
- `fix/bug-sync-pk-metadata-key-identity` — review.
- `fix/bug-memory-unique-timespan-spelling` — implement.
- `backlog/feat-reopen-timespan-store-seeks` — implement.
