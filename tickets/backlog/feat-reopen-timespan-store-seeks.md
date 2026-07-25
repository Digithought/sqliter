---
description: Now that the persistent store keys durations by their elapsed time, the fast lookups and sort-skipping it switched off for duration columns could be safely switched back on — today such queries fall back to scanning the whole table.
files:
  - packages/quereus-store/src/common/store-table.ts    # keyOrderMatchesCollation (the decline), analyzePKAccess point arm, analyzeIndexAccess EQ-prefix arm
  - packages/quereus-store/src/common/store-module.ts   # computeBestAccessPlan / tryIndexAccessPlan / buildPkOrderingAdvertisement (module-side mirrors)
  - packages/quereus-store/src/common/encoding.ts       # KeyValueTransform — why TIMESPAN key bytes now order by compare
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # ordering tests that assert the current Sort-still-runs behavior
---

# Re-open store seeks / ordering advertisements over TIMESPAN keys

Ticket `duration-json-semantic-ordering-store` made the store encode TIMESPAN PK and
index key members through `TIMESPAN.groupKey` (total seconds against the same reference
date as `compare`). Consequence: for every parseable duration, the physical byte order
now IS the type's `compare` order, and byte equality IS the type's equality.

The read-side declines the engine ticket added are therefore now merely conservative
for TIMESPAN (they remain required for JSON, whose canonical-text bytes cannot
reproduce structural order):

- `keyOrderMatchesCollation` returns false for any semantic-ordering member → no
  PK-order advertisement, no range windows → full scan + Sort.
- `analyzePKAccess` point arm and `analyzeIndexAccess` EQ-prefix arm stop at a
  semantic-ordering member → point lookups full-scan.

Re-opening them needs a per-type distinction ("this type's key encoding is
order/identity-faithful"), not the blanket `hasSemanticOrdering` gate — e.g. a
LogicalType flag or a store-side predicate keyed on the presence of an
order-preserving `groupKey`. Constraint values seek through the same
`KeyValueTransform` plumbing, so window construction already normalizes correctly.

Edge to decide before widening: an UNPARSEABLE stored value falls back to raw-text
key bytes (numeric-tagged keys sort before text-tagged ones), while `compare` falls
back to BINARY text comparison — mixed parseable/unparseable pairs would break the
order equivalence. Today `coerceRowToSchema` rejects unparseable timespans at write
time, so this may be vacuous — verify, and gate the advertisement on that guarantee.

Update the "advertisement declined" comments/tests in
`any-json-pk-binary-key.spec.ts` and `timespan-semantic-key-identity.spec.ts` when
this lands; both currently assert Sort-still-runs and name this slug.
