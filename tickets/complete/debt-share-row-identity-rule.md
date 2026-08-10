description: Merged two copies of the "same primary key, same row?" rule (used by the transaction-isolation layer and the sync engine) into one shared implementation, so the two can no longer silently drift apart.
files:
  - packages/quereus/src/util/key-serializer.ts               # resolvePkIdentityKeying, makePkIdentitySerializer (the one recipe)
  - packages/quereus/src/index.ts                             # public exports
  - packages/quereus/test/util/pk-identity.spec.ts            # added in review: 17 direct contract tests
  - packages/quereus-isolation/src/overlay-rows.ts             # makePkKeySerializer is now a thin wrapper
  - packages/quereus-sync/src/metadata/pk-identity.ts          # resolvePkKeying is now a thin wrapper
  - docs/sync.md                                               # updated in review
  - docs/design-isolation-layer.md                             # updated in review
----

## Outcome

The rule "are these two primary keys the same row?" — per pk column, run the value through
its logical type's semantic key transform (TIMESPAN's `groupKey`, so `'PT1H'` ≡ `'PT60M'`),
then serialize under its key-collation normalizer (`'apple'` ≡ `'APPLE'` under `nocase`),
NULL-grouping rather than NULL-poisoning — now has exactly one implementation, in
`packages/quereus/src/util/key-serializer.ts`:

- `resolvePkIdentityKeying(table, resolveNormalizer)` → `{ normalizers, transforms }`
- `makePkIdentitySerializer(table, resolveNormalizer)` → `(pk) => string`

Both take a structural `PkIdentityTable` (`columns` + optional `primaryKeyDefinition`)
rather than the full `TableSchema`, so a lighter stub works, and both degrade a missing
`primaryKeyDefinition` / a pk column with no `logicalType` to raw value identity instead of
throwing. A real `TableSchema` never reaches either defensive path.

`@quereus/isolation`'s `makePkKeySerializer` and `@quereus/sync`'s `resolvePkKeying` are
each now a one-line delegation. `@quereus/sync`'s `PkKeying` type, `encodePkIdentity`, and
`RAW_PK_KEYING` were deliberately left untouched — only the *derivation* is shared, not the
consuming API — because three sync test files build `PkKeying` object literals by hand.

## Review findings

**Checked:** the implement diff read before the handoff summary; behavior equivalence of
both wrappers against the code they replaced; import-cycle and layering risk of the new
util→planner import; whether a third copy of the rule exists elsewhere; docs touched and
docs that *should* have been touched; lint; the full test suites of all three affected
packages.

**Behavioral equivalence — no defects found.** The shared function reconstructs
`{ logicalType, collation }` rather than passing the whole column through to
`pkKeyCollationName`. Confirmed safe: `pkKeyCollationName`
(`planner/analysis/comparison-collation.ts:391`) reads only those two fields, so nothing is
dropped. The isolation side previously called `resolver(pkKeyCollationName(column))`
unconditionally while the shared version guards on `logicalType` — for a real `TableSchema`
(always typed) that is identical, and for a stub it is strictly more defensive. The sync
side is a byte-for-byte match of what it replaced.

**Minor — fixed in this pass:**

- *No direct test for the new shared code* (the implementer flagged this honestly). Added
  `packages/quereus/test/util/pk-identity.spec.ts` — 17 cases against hand-built structural
  stubs, no `Database`/vtab/sync engine: which collation each column class is keyed under
  (textual → its own declared collation; text-capable-but-not-textual and temporal →
  `BINARY`; never-text → no collation even when it declares `COLLATE`), primary-key order
  rather than schema order, presence/absence of the semantic transform, and serialized
  identity (NOCASE folding, BINARY case-sensitivity, TIMESPAN spelling folding, numeric
  storage-class folding, composite-column independence, per-column normalizer isolation,
  NULL grouping), plus all three stub-degradation paths.
- *Stale docs.* `docs/sync.md` described `metadata/pk-identity.ts` as resolving the keying
  itself, and `docs/design-isolation-layer.md` § "Merging overlay and underlying" named
  `serializeRowKey` as the encoder for the modified-PK set without naming the actual entry
  point. Both now point at the shared function and say the two layers cannot drift. No
  other doc mentions this rule (searched `docs/` and every package README).

**Major — none.** No new tickets filed. The change is a pure de-duplication with no
behavior delta, and the deliberate non-change to `keys.ts` is correctly justified.

**Tripwire (recorded, not ticketed):** the new `util/key-serializer.ts` →
`planner/analysis/comparison-collation.ts` import is the only util→planner *value* import in
the package. Verified acyclic today — `comparison-collation.ts` pulls `util/comparison.js`,
`planner/analysis/predicate-shape.js`, and `common/`, none of which reach back to
`key-serializer.ts`. Parked as a `NOTE:` at the import site naming what would close the
cycle and the escape hatch (move `pkKeyCollationName` down into `types/`).

**Not a third copy:** `quereus-store`'s `resolvePkKeyCollations`
(`common/store-table.ts:141`) already delegates the same branch decision to
`pkKeyCollationName`; it adds only a store-specific fallback collation and uppercasing, and
returns collation *names* for on-disk byte-order encoding rather than normalizers for
value-equality. All three layers now converge on the one primitive. Nothing to fold in.

## Verification

- `yarn build` (full monorepo) — clean.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) — clean.
- `yarn workspace @quereus/quereus run test` — 7765 passing, 13 pending (was 7748 + the 17
  new cases; the 13 pending are pre-existing and untouched).
- `yarn workspace @quereus/sync run test` — 594 passing.
- `yarn workspace @quereus/isolation run test` — 342 passing.
- No pre-existing failures surfaced.
