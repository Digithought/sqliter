---
description: Creating a case-insensitive unique index over a JSON column succeeds on the persistent store even when existing rows already violate it, leaving a table the store's own inserts would reject. Make the check that runs while an index is built agree with the check that runs on every write.
files:
  - packages/quereus-store/src/common/store-module-index-build.ts   # dedupeRowSignature + its two callers — the site to change
  - packages/quereus-store/src/common/pk-key-resolution.ts          # storeSemanticKeyTransform — where the dedupe-side twin belongs
  - packages/quereus-store/src/common/json-key.ts                   # jsonStructuralKey — the transform that swallows the collation
  - packages/quereus/src/util/key-serializer.ts                     # serializeKey: normalizes string values only (unchanged)
  - packages/quereus/src/types/json-type.ts                         # JSON_TYPE.compare — the equality the signature must reproduce
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # stale comment at pkKeyCollationName (see "Second arm")
  - packages/quereus-store/test/unique-constraints.spec.ts          # ~line 864: the existing test pinning the write-side of this shape
  - packages/quereus-store/test/index-column-collation.spec.ts      # style model for the new regression test
repro: verified
difficulty: easy
---

# Build-time UNIQUE dedupe must reproduce the write-time comparison

## The defect, reproduced

Two rows hold the JSON string scalars `"a"` and `"A"`. `create unique index … (d collate nocase)`
over them:

```
create table t (id integer primary key, d json) using store;
insert into t values (1, '"a"'), (2, '"A"');
create unique index ix on t (d collate nocase);   -- store: SUCCEEDS.  memory: UNIQUE constraint failed
insert into t values (3, '"A"');                  -- store: UNIQUE constraint failed
```

The store admits the index over two rows that violate it, then refuses the very
insert that would have produced that state. Verified by running both backends
side by side.

The two other shapes the original ticket asked about were checked and are **not**
affected — confirmed by running the same statements:

- **TIMESPAN** (`'PT1H'` / `'PT60M'` under an index `collate nocase`): both
  backends reject. TIMESPAN's `compare` ignores the collation it is handed, and
  its `groupKey` transform (total seconds) collides the two spellings on both
  paths, so build and write already agree.
- **Table-level `unique(...)`** (`validateUniqueOverExistingRows`, reached by
  `alter table … add constraint … unique`): admits `"a"` and `"A"`, which is
  **correct** — a non-index-derived constraint enforces under the *column's*
  declared collation, and a `json` column can never carry a non-BINARY one
  (column DDL rejects it, `LogicalType.supportedCollations` is empty for JSON).
  The write path agrees. No change needed there.

So the divergence is reachable through exactly one shape: an **index-level**
`COLLATE` on a JSON column.

## Root cause — one site

Both duplicate checks live in `store-module-index-build.ts`, and both build a
string signature through `dedupeRowSignature`. The signature runs each value
through its column's key transform (`storeSemanticKeyTransform`) *before*
`serializeKey` applies the per-column collation normalizer. For a JSON column
that transform is `jsonStructuralKey`, which returns a `Uint8Array` — and
`serializeKey` only ever applies a normalizer to a **string** value (it tags a
byte array `x:` and never consults the normalizer). The NOCASE normalizer is
therefore dropped on the floor and the two rows sign differently.

The write path (`store-table-constraints.ts` → `uniqueEnforcementComparators`)
routes a semantic-ordering column through `createTypedComparator(JSON_TYPE, C)`,
and `JSON_TYPE.compare` **does** apply the collation when both operands are
string scalars. Hence: write-time NOCASE, build-time BINARY.

## The correction

Give the *signature* path its own transform, separate from the *physical key
bytes* path. The physical index key must stay hard-BINARY structural bytes
(`resolveIndexKeyCollations` returns `'BINARY'` for a collation-blind type, and
three separate guards already decline to seek such an index — that is by
design and must not change). Only the dedupe signature needs to become
collation-aware, and only for the case `JSON_TYPE.compare` treats as text:

```ts
// pk-key-resolution.ts, alongside storeSemanticKeyTransform
export function storeDedupeKeyTransform(type: LogicalType | undefined): KeyValueTransform | undefined {
    // JSON's compare applies the collation to a STRING-SCALAR pair and ranks
    // everything else structurally, so the signature leaves a string for
    // serializeKey's normalizer and keeps structural bytes for the rest.
    if (hasSemanticOrdering(type) && type.name === JSON_TYPE.name) {
        return (v: SqlValue) => (typeof v === 'string' ? v : jsonStructuralKey(v));
    }
    return semanticKeyTransform(type);
}
```

Then feed it to both signature sites — `buildIndexEntries`' in-pass `seen` check
and `assertNoDuplicateRows` (shared by `validateUniqueOverExistingRows` and
`validateUniqueIndexOverRows`, the wrapper/isolation twin). Note
`buildIndexEntries` needs a **second** transform array: `indexTransforms` still
feeds `buildIndexKey` and must keep using `storeSemanticKeyTransform`.

The two branches cannot collide: `serializeKey` tags a string `s:` and a byte
array `x:`, and `JSON_TYPE.compare` never equates a string scalar with a
non-string. The signature is never persisted (it is a `Set` key for one build),
so there is no on-disk compatibility concern.

**This was prototyped and verified during the fix stage**: with the change in
place the repro above rejects on both backends, TIMESPAN and TEXT behaviour is
unchanged, and the whole `@quereus/store` suite passes (1286 passing, 0
failing). The prototype was then reverted — nothing is in the tree.

### Why not close the index-DDL gap instead

The original ticket floated rejecting `COLLATE nocase` on an index column whose
type declares no supported collations. That is tempting — `comparison-collation.ts`
already *claims* DDL rejects it — but it would delete behaviour the project has
deliberately specified and tested: `unique-constraints.spec.ts` ~line 864 ("a
JSON column with an index COLLATE falls back to the full scan") pins the NOCASE
write-time enforcement of exactly this shape, and the memory backend enforces it
too. Removing a supported-and-tested shape is a design decision, not a bugfix.
Aligning build with write keeps every existing answer and closes the gap.

## Second arm — a comment that is currently false

`pkKeyCollationName`'s docstring
(`packages/quereus/src/planner/analysis/comparison-collation.ts`, near the end of
the block above the function) says of `json` and the temporal types:

> (Those types also declare `supportedCollations: []`, so DDL rejects a
> non-BINARY COLLATE on them anyway — the hard-coding is a backstop, not the
> primary gate.)

That is true for **column** DDL (`validateCollationForType`) and false for
**index** DDL: `SchemaManager.buildIndexSchema` (and its rehydrate twin
`importIndex`) resolve an index column's collation with a bare
`normalizeCollationName(collation || tableColSchema.collation || 'BINARY')` and
apply no type gate — which is what makes this bug reachable at all. Correct the
comment to say the hard-coding **is** the only gate for an index column. Do not
add the gate; see above.

## Tripwire to record (not a ticket)

`dedupeRowSignature` reproduces a type's equality by hashing, while the write
path reproduces it by comparing. They agree today only because each transformed
type was checked by hand. Leave a `NOTE:` at `dedupeRowSignature` saying: the
signature normalizes **string** values only, so any future logical type that
both carries a key transform and honors a collation in its `compare` must be
given a `storeDedupeKeyTransform` branch, or its build-time check silently
degrades to BINARY. Conditional on a new type existing — record it at the site,
not as queued work.

## TODO

- Add `storeDedupeKeyTransform` to `packages/quereus-store/src/common/pk-key-resolution.ts`, documented as the dedupe-signature twin of `storeSemanticKeyTransform` (and note in `storeSemanticKeyTransform`'s docstring that it is the *physical key bytes* resolver, so the pair is discoverable from either side).
- Use it for both signature sites in `store-module-index-build.ts`: `buildIndexEntries`' `seen` check (a new array — leave `indexTransforms` feeding `buildIndexKey` alone) and `assertNoDuplicateRows`.
- Add the `NOTE:` tripwire at `dedupeRowSignature`.
- Correct the stale parenthetical in `pkKeyCollationName`'s docstring (`packages/quereus/src/planner/analysis/comparison-collation.ts`).
- Regression test in `packages/quereus-store/test/` (model it on `index-column-collation.spec.ts`, which already carries the persistent-provider + `attempt()` helpers): a JSON column with pre-existing `'"a"'` / `'"A"'` rows must reject `create unique index … (d collate nocase)`, with a memory table as the oracle; assert the store and memory errors agree. Add the TIMESPAN and TEXT cases as controls so a future over-broad transform change is caught.
- Extend the test to the wrapper path if it is reachable: `validateUniqueIndexOverRows` is the twin used when a wrapper module (`createIsolatedStoreModule`) supplies the rows to judge. If DDL-in-transaction restrictions make it unreachable from SQL, say so in the handoff rather than forcing it.
- Unverified edge worth a look while in the file, and worth naming in the handoff either way: a **comparator-only** custom collation (registered with no key normalizer) on a JSON index column. The store's DDL-time `validateKeyCollations` checks the *key* collation, which is hard-BINARY for JSON, so it passes — but `indexDedupeNormalizers` then asks the resolver for that name at build time and the resolver throws on a normalizer-less collation. If that is what happens, it is a confusing error, not a correctness hole; record it as a `NOTE:` rather than growing this ticket.
- Check whether `packages/quereus-store/README.md` (the row-validating-DDL paragraph, ~line 300) or `docs/types.md` § "Semantic ordering" state the build-time rule in a way this change makes stale; update if so.
- Run `yarn workspace @quereus/store run test` and `yarn test`.
