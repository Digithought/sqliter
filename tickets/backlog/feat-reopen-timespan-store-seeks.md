---
description: Now that the persistent store keys durations by their elapsed time and JSON values by their structural order, the fast lookups and sort-skipping it switched off for those columns could be safely switched back on — today such queries fall back to scanning the whole table.
files:
  - packages/quereus-store/src/common/store-table.ts    # keyOrderMatchesCollation (the decline), analyzePKAccess point arm, analyzeIndexAccess EQ-prefix arm, storeSemanticKeyTransform
  - packages/quereus-store/src/common/store-module.ts   # computeBestAccessPlan / tryIndexAccessPlan / buildPkOrderingAdvertisement (module-side mirrors)
  - packages/quereus-store/src/common/encoding.ts       # KeyValueTransform — why TIMESPAN/JSON key bytes now order by compare
  - packages/quereus-store/src/common/json-key.ts       # the structural JSON key encoding and its order argument
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # ordering tests that assert the current Sort-still-runs behavior
---

# Re-open store seeks / ordering advertisements over TIMESPAN and JSON keys

Ticket `duration-json-semantic-ordering-store` made the store encode TIMESPAN PK and
index key members through `TIMESPAN.groupKey` (total seconds against the same reference
date as `compare`), and ticket `bug-json-pk-store-scan-order` did the analogous thing
for JSON (a structural byte encoding, `json-key.ts`, whose memcmp order reproduces the
structural `compare`). Consequence: for every well-formed value of either type, the
physical byte order now IS the type's `compare` order, and byte equality IS the type's
equality.

The read-side declines the engine ticket added are therefore now merely conservative
for both types:

- `keyOrderMatchesCollation` returns false for any semantic-ordering member → no
  PK-order advertisement, no range windows → full scan + Sort.
- `analyzePKAccess` point arm and `analyzeIndexAccess` EQ-prefix arm stop at a
  semantic-ordering member → point lookups full-scan.

Re-opening them needs a per-type distinction ("this type's key encoding is
order/identity-faithful"), not the blanket `hasSemanticOrdering` gate — e.g. a
LogicalType flag or a store-side predicate keyed on the presence of a
`storeSemanticKeyTransform` entry (today that set — TIMESPAN and JSON — is exactly
the re-openable set, but nothing forces a future transform to be order-preserving,
so an explicit per-type assertion is safer). Constraint values seek through the same
`KeyValueTransform` plumbing, so window construction already normalizes correctly.

Edges to decide before widening:

- The two `buildIndexPrefixBounds` calls in `StoreTable` (`analyzeIndexAccess`'s
  EQ-prefix arm and `buildIndexRangeBounds`) pass NO key transforms. That is sound
  only because both arms decline semantic-ordering columns today. Thread the
  column's transforms through before re-opening either arm, or the seek window will
  address raw-value bytes while the index holds transformed ones — a silently
  under-fetching window with no residual able to resurrect the missed rows.

- TIMESPAN: an UNPARSEABLE stored value falls back to raw-text key bytes
  (numeric-tagged keys sort before text-tagged ones), while `compare` falls back to
  BINARY text comparison — mixed parseable/unparseable pairs would break the order
  equivalence. Today `coerceRowToSchema` rejects unparseable timespans at write time,
  so this may be vacuous — verify, and gate the advertisement on that guarantee.
- JSON: a probe value that is a string leaf holding an unpaired surrogate makes the
  structural encoder RAISE while the comparator would have answered — a widened seek
  must surface that error exactly as the write path does (the lone-surrogate spec
  pins the message shape), not silently decline.

Update the "advertisement declined" comments/tests in
`any-json-pk-binary-key.spec.ts` and `timespan-semantic-key-identity.spec.ts` when
this lands; both currently assert Sort-still-runs and name this slug.
