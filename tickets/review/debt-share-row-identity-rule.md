description: Merged two copies of the "same primary key, same row?" rule (used by the transaction-isolation layer and the sync engine) into one shared implementation, so the two can no longer silently drift apart.
files:
  - packages/quereus/src/util/key-serializer.ts             # new: resolvePkIdentityKeying, makePkIdentitySerializer (the one recipe)
  - packages/quereus/src/index.ts                           # new public exports
  - packages/quereus-isolation/src/overlay-rows.ts           # makePkKeySerializer now a thin wrapper
  - packages/quereus-sync/src/metadata/pk-identity.ts        # resolvePkKeying now a thin wrapper
  - packages/quereus-sync/src/metadata/keys.ts               # UNCHANGED — PkKeying/encodePkIdentity shape preserved on purpose
difficulty: easy
----

## What changed

`packages/quereus/src/util/key-serializer.ts` (alongside `serializeKeyNullGrouping`, which
it builds on) now owns the ONE implementation of "are these two primary keys the same row?":

- `resolvePkIdentityKeying(table, resolveNormalizer)` — for each pk column, resolves its
  key-collation normalizer (`pkKeyCollationName`) and its logical type's semantic key
  transform (`semanticKeyTransform`, e.g. TIMESPAN's `groupKey`), returning
  `{ normalizers, transforms }`.
- `makePkIdentitySerializer(table, resolveNormalizer)` — composes the above with
  `serializeKeyNullGrouping` into a `(pk) => string` closure.

Both take a structural `PkIdentityTable` (`columns` + optional `primaryKeyDefinition`), not
the full `TableSchema` type, so a lighter test stub still works — and both are defensive
about a missing `primaryKeyDefinition` or a pk column with no `logicalType` (degrades to
identity normalizer / no transform rather than throwing), matching the sync side's
pre-existing defensiveness. A real `TableSchema` never hits either defensive path.

Both are exported from `@quereus/quereus`'s public `index.ts`.

**`@quereus/isolation`'s `makePkKeySerializer`** (`overlay-rows.ts`) is now a one-line thin
wrapper: pulls the resolver off the `Database` and delegates to `makePkIdentitySerializer`.

**`@quereus/sync`'s `resolvePkKeying`** (`metadata/pk-identity.ts`) is now a one-line thin
wrapper: delegates to `resolvePkIdentityKeying`, whose return shape is exactly `PkKeying`'s
(`{ normalizers, transforms }`).

**Deliberately left unchanged:** `packages/quereus-sync/src/metadata/keys.ts`'s `PkKeying`
type, `encodePkIdentity`, and `RAW_PK_KEYING` all keep their existing shape/behavior — three
sync test files (`test/metadata/keys.spec.ts`,
`test/sync/staged-transaction-metadata.spec.ts`, plus `test/metadata/pk-identity.spec.ts`)
construct or inspect `PkKeying` object literals directly (`{ normalizers: [...],
transforms: [...] }`), so changing that shape would have required touching pinned fixtures.
Only the *derivation* of `{ normalizers, transforms }` from a schema is now shared — not the
consuming API.

## Why this shape (for the reviewer)

The ticket's suggested shape was "one function, `(table, resolver) => (pk) => string`". That
works cleanly for isolation (which only ever needs the closure). Sync needs the split
`{ normalizers, transforms }` descriptor — it's cached per-`TableSchema` object in a
`WeakMap`, has a `RAW_PK_KEYING` sentinel variant, and (per the tests above) callers build
one by hand in a few places. So the actual shared/duplicated logic — "which normalizer and
which transform for pk column N" — now lives in exactly one place
(`resolvePkIdentityKeying`), and `makePkIdentitySerializer` is a convenience composition on
top of it for the closure-shaped caller. No behavior/recipe is duplicated; only the
call-site glue (closure vs. descriptor) differs, and that glue is trivial (~5 lines) and was
already present identically on both sides before this change.

## Verification performed

- `yarn build` (full monorepo, project-references) — clean.
- `yarn typecheck` (full monorepo) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 7748 passing, 13 pending (pre-existing
  pending, untouched).
- `yarn workspace @quereus/sync run test` — 594 passing, including the pinned
  `test/metadata/pk-identity.spec.ts` (all 9 cases: nocase folding, binary case-sensitivity,
  timespan folding, composite-key independence, bigint/number numeric-class folding, the
  `createPkKeyingResolver` raw/oracle/re-resolve cases, `makePkIdentityEncoder` agreement)
  and `test/metadata/keys.spec.ts` (34 cases combined with the two suites below, all
  passing when run directly with the `spec` reporter for individual visibility).
- `yarn workspace @quereus/isolation run test` — 342 passing, including
  `isolation-layer.spec.ts` and `alter-table-conformance.spec.ts` (both exercise
  nocase/timespan overlay row-alignment scenarios that go through `makePkKeySerializer`).
- No test file was edited. No fixture was edited.

## Known gaps / things I did not do

- **No new direct unit test for `resolvePkIdentityKeying`/`makePkIdentitySerializer` in
  `packages/quereus` itself.** The new code is exercised transitively (via
  `pk-identity.spec.ts` for the sync side and the isolation integration specs for the
  overlay side), which is exactly the byte-identical-output guarantee the ticket asked for
  — but there's no test living next to the new implementation in `packages/quereus/test`
  that pins its own contract directly (e.g. against a hand-built minimal `PkIdentityTable`
  stub, independent of a real `Database`). Worth adding if this code gets touched again.
- **Layering note:** `util/key-serializer.ts` (a low-level util module) now imports a value
  from `planner/analysis/comparison-collation.ts` (`pkKeyCollationName`). I checked there's
  no import cycle (comparison-collation.ts and its transitive deps never import
  key-serializer.ts — confirmed by full-repo grep), and the build/typecheck are clean, but
  this is a new util→planner value-import direction with no other precedent in the
  package. If the codebase has an informal layering rule against this, it's worth a second
  look — I didn't find one written down.
- Did not touch `packages/quereus-store`'s `resolvePkKeyCollations` (mentioned in
  `pkKeyCollationName`'s doc comment as making "the identical decision" for a *different*
  purpose — on-disk byte-order PK key encoding, not value-equality identity). Out of scope
  per the ticket; noting it exists in case a future ticket wants to fold it in too.
