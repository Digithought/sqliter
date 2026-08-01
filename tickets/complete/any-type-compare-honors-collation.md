---
description: A column that can hold any kind of value and is declared case-insensitive was case-insensitive in ordinary queries but case-sensitive inside indexes and primary keys, so adding an index changed query answers and duplicate checks missed duplicates. The two now agree.
files:
  - packages/quereus/src/types/builtin-types.ts                        # ANY_TYPE.compare applies its collation arg; collationAware on TEXT/ANY
  - packages/quereus/src/types/logical-type.ts                         # LogicalType.collationAware
  - packages/quereus/src/util/comparison.ts                            # isCollationAware()
  - packages/quereus/src/planner/analysis/comparison-collation.ts      # pkKeyCollationName branches on collationAware
  - packages/quereus-store/src/common/encoding.ts                      # REVIEW FIX: encodeObject no longer applies a collation normalizer
  - packages/quereus-store/src/common/pk-key-resolution.ts
  - packages/quereus-store/src/common/store-module-schema-rewrite.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-sync/src/metadata/pk-identity.ts
  - packages/quereus/test/logic/06.4.5-any-collate-declared-keys.sqllogic   # repro cases 1-5, memory + store
  - packages/quereus/test/logic/43.1-default-collation.sqllogic             # REVIEW: undecorated `any` stays BINARY
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts              # REVIEW: object-valued `any collate nocase` PK members
  - docs/types.md, docs/store.md, docs/design-isolation-layer.md
---

# Complete: `ANY_TYPE.compare` honors the collation it is handed

## What shipped

`ANY_TYPE.compare` declared only two parameters, so the collation
`createTypedComparator` passed as its third argument was dropped: every declared-key
structure over an `any` column (memory PK/index BTrees, the store's key bytes, the
isolation overlay's shadow keys) compared BINARY while `=`, ranges, `order by`,
`group by`, `distinct` and `in` honored the declared COLLATE. Creating an index
changed answers, and PK/UNIQUE admitted duplicates DISTINCT collapsed.

The fix is the signature change plus an explicit marker:

- `LogicalType.collationAware?: boolean` on `TEXT_TYPE` and `ANY_TYPE`, tested through
  `isCollationAware()` rather than object identity.
- `ANY_TYPE.compare: (a, b, collation) => compareSqlValuesFast(a, b, collation ?? BINARY_COLLATION)`.
- `pkKeyCollationName` branches on the new flag instead of `isTextual`, so an
  `any collate nocase` key column resolves to `'NOCASE'` at every site that derives a
  key collation — store, isolation overlay, sync pk-identity — transitively.

An undecorated `any` column does not move: `resolveDefaultCollation` gates the session
`default_collation` on the type's `supportedCollations`, which ANY does not declare, and
`reconcilePkCollations` deliberately keeps its `isTextual` gate. Only an explicit
non-BINARY COLLATE re-keys.

## Behavior changes

- On-disk key bytes changed for `any` columns carrying an explicit non-BINARY COLLATE.
  Backwards compatibility is out of scope per AGENTS.md; a database written before this
  change with that column shape reads wrong through the new code.
- `alter table … alter column <any pk> set collate nocase` is now a real physical re-key;
  colliding rows refuse with CONSTRAINT before any mutation, matching the text-PK rule.
- Isolation PK semantics for `any collate nocase primary key` inverted by design: the
  case variant is a PK violation and case-only rewrites shadow across spellings.
- Aggregate `distinct`, `group by`, `min`/`max` over an `any collate nocase` column now
  fold case, agreeing with row-level DISTINCT (pinned in review, see below).

## Review findings

### Checked and clean

`hashKeyCollationName` and the engine key serializer (both text-capable-gated, not
`isTextual`-gated) needed no change; the ALTER re-key and index-rebuild paths are
collation-generic, not type-gated, and the store test confirms the `any` PK re-key;
`reconcilePkCollations` keeping `isTextual` is correct and now carries its rationale;
`resolveDefaultCollation` does return BINARY for ANY (verified by reading, then pinned —
below); `compareSameType` consults the collation on the TEXT/TEXT branch only, so the
"honoring the collation is total over ANY's value space" claim holds for scalars.
No source-size debt: the diff is comment-and-test heavy, and no touched file grew a
function or a file past what its neighbors run.

### Major — fixed in this pass

**Object-valued members of an `any collate nocase` key folded on case.**
`encodeObject` (`quereus-store/src/common/encoding.ts`) ran the collation's key
normalizer over the canonical JSON string, while every engine comparator treats
OBJECT-class values as collation-blind (`compareSameType` consults the collation only
for TEXT/TEXT; `util/key-serializer.ts` normalizes only string values). Harmless while
an `any` column always keyed BINARY — this change made the folding reachable. Verified
against a memory table as oracle:

- uniqueness: the store rejected `{"a":1}` after `{"A":1}`; memory admitted both.
- order: `order by k` returned `[{"a":2},{"B":1}]` from the store and
  `[{"B":1},{"a":2}]` from memory — the comparator's own code-point order, inverted by
  the lowercased key bytes.

Fixed by encoding the canonical string verbatim (`encodeObject` now takes no collation
at all). Text values in the same column still fold under NOCASE. Regression test added
to `any-json-pk-binary-key.spec.ts` covering both arms plus the text arm;
`docs/store.md` § JSON (OBJECT-class) PK / index key encoding corrected — it said
"collation still applies to the canonical string as for text".

### Minor — fixed in this pass

**Six passages assert JSON's `compare` "ignores the collation argument". It does not** —
`JSON_TYPE.compare` applies the collation to a string-scalar pair and ranks structurally
otherwise. The *classification* is unaffected (JSON still keys hard-BINARY, and for a
better reason: its compare is not the generic storage-class + collation comparison), but
the stated rationale was false. Reworded in `comparison-collation.ts`,
`pk-key-resolution.ts` (×2), `isolated-table.ts`, `docs/store.md` (×2), `docs/types.md`.

### Test gaps — filled in this pass

- The handoff's own noted gap: no direct pin that an undecorated `any` stays BINARY
  under a session `default_collation`. Added an arm to
  `43.1-default-collation.sqllogic` (schema collation *and* a `=` answer), next to the
  existing JSON/temporal arm.
- Aggregate `distinct` / `group by` / `min` / `max` over `any collate nocase` are
  user-visible answers that this change moves, and case 4 only counted distinct values
  that had no case variants. Added case 5 to `06.4.5-any-collate-declared-keys.sqllogic`
  pinning all four, before *and* after the index — so index-invariance covers the
  identity paths too, on both backends.

### Major — filed as a ticket

`fix/bug-store-index-build-dedupe-skips-collation` — the store's build-time UNIQUE
dedupe (`dedupeRowSignature`) signs a JSON value through its byte-array key transform,
so the per-column collation normalizer (string-only) never runs, while write-time
enforcement compares through `JSON_TYPE.compare`, which does honor it. Consequence:
`create unique index … (jsoncol collate nocase)` over already-violating rows succeeds on
the store and is refused by memory. Verified against both backends. **Pre-existing** —
nothing in this diff touched JSON or the build path — and filed separately rather than
folded in here.

### Tripwires

No new ones. The implementer's `NOTE:` at `pkKeyCollationName` (a schema-stub caller
handing an `any` column with `collation` unset would fall into the store's K-fallback;
unreachable from a real `ColumnSchema`) is still accurate and stays at the site. The
`comparisonSemanticsDiffer` over-report of `text ↔ any` remains documented in its own
doc block as the harmless O(rows) re-sort it is.

## Validation

- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — 0 failing; engine 8279 passing / 13 pending, store 1282, isolation 370,
  sync 643, all other packages green.
- `yarn test:store` — 8271 passing / 21 pending, 0 failing (exercises the changed
  on-disk key bytes, including the `encodeObject` fix).
