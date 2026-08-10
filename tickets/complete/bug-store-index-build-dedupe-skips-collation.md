---
description: Fixed a bug where creating a case-insensitive unique index over a JSON column in the persistent store could succeed even though existing rows already broke that uniqueness rule — the check run when the index is built now matches the check the store runs on every write.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # storeDedupeKeyTransform + jsonDedupeKey + resolveDedupeKeyTransforms
  - packages/quereus-store/src/common/store-module-index-build.ts   # both dedupe-signature call sites; two NOTE tripwires
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # corrected stale docstring at pkKeyCollationName
  - packages/quereus-store/test/unique-constraints.spec.ts          # committed-row build regression + branch-boundary test
  - packages/quereus-store/test/isolated-store.spec.ts              # wrapper (mid-transaction) build regression
  - docs/store.md                                                   # § JSON/OBJECT key encoding rewritten (review)
---

# Build-time UNIQUE dedupe now reproduces the write-time comparison

## What shipped

A `json` column's value used to be signed for the build-time UNIQUE duplicate check
through `storeSemanticKeyTransform`, which returns the structural key bytes
(`jsonStructuralKey`). `serializeKey` runs a column's collation normalizer only over a raw
`string` — a `Uint8Array` is tagged `x:` as opaque bytes and the normalizer never runs — so
an index-level `COLLATE NOCASE` was silently dropped when the index was built, while the
write path (`JSON_TYPE.compare`, which does honor the collation for a string/string pair)
still enforced it. `CREATE UNIQUE INDEX … (d COLLATE NOCASE)` could therefore succeed over
two case-variant rows that a later `INSERT` of a third variant would reject.

`storeDedupeKeyTransform` is the dedupe-signature twin of `storeSemanticKeyTransform`: a
declared-`json` value that is a **top-level string scalar** is left as a string (so the
normalizer runs), every other node still gets the structural bytes. That boundary is exactly
`JSON_TYPE.compare`'s — it consults the collation only on the string/string branch and hands
everything else to `deepCompareJson`, which takes no collation. TIMESPAN defers through
unchanged (its `compare` ignores collation and its `groupKey` already collides equal
spellings on both paths).

Both build/validate sites use it: `buildIndexEntries`' in-pass `seen` check (which needed a
second transform array — `indexTransforms` still feeds `buildIndexKey` and must stay the
hard-structural physical key bytes) and `assertNoDuplicateRows`, shared by
`validateUniqueOverExistingRows` and `validateUniqueIndexOverRows`.

Repro, now rejected on both backends:

```sql
create table t (id integer primary key, d json) using store;
insert into t values (1, '"a"'), (2, '"A"');
create unique index ix on t (d collate nocase);   -- now: UNIQUE constraint failed
```

## Review findings

The implement diff was read first, before the handoff summary.

**Correctness of the fix — traced end to end, no defects found.** Four things had to hold
and each was checked against source rather than taken from the handoff:

- `serializeKey` tags a string `s:` and a byte array `x:` (`util/key-serializer.ts`), so
  splitting JSON string scalars onto the string path cannot collide them with any
  structurally-keyed node — the JSON string `"9"` and the JSON number `9` stay distinct,
  matching the type's `number < string` rank.
- `JSON_TYPE.compare` (`types/json-type.ts:61`) applies the handed collation **only** when
  both sides are strings; `deepCompareJson` has no collation parameter, so a nested string
  leaf is always code-point compared. The transform's branch is the same boundary — neither
  wider (which would reject builds the write path admits) nor narrower.
- Write-time enforcement for the `json` + index-`COLLATE` shape genuinely reaches the typed
  comparator: `indexSeekHonorsEnforcementCollation` sees key collation `BINARY` against
  enforcement `NOCASE` and declines the index seek, routing to the full scan, whose
  per-column compare is `uniqueEnforcementComparators` → `createTypedComparator(JSON_TYPE,
  NOCASE)`. So the two sides now agree in **both** directions, not just the reported one.
- Rows carry parsed JSON (`serialization.ts` round-trips through `JSON.parse`), so
  `typeof v === 'string'` cannot misfire on an object serialized as text — the failure mode
  that would have broken reorder-equal object identity. Already pinned by
  `json-semantic-key-order.spec.ts` "rejects `create unique index` over existing
  reorder-equal spellings", which exercises the non-string branch and still passes.

**Fixed inline — DRY / drift risk at the two dedupe sites.** Both sites open-coded the same
`map(… => storeDedupeKeyTransform(columns[i]?.logicalType))` expression with different
accessors, the exact duplication that let the physical and dedupe transforms drift in the
first place. Added `resolveDedupeKeyTransforms(colIndices, columns)` next to its physical
twin `resolveIndexKeyTransforms` and routed both sites through it. Also hoisted the
per-call arrow in `storeDedupeKeyTransform` to a named `jsonDedupeKey` (one allocation, one
place to document the branch), and gated `buildIndexEntries`' transform array on `seen`
like its normalizers, so a non-UNIQUE build resolves nothing.

**Fixed inline — stale documentation the handoff cleared but which was in fact wrong.**
`docs/store.md` § *JSON (OBJECT-class) PK / index key encoding* claimed a JSON value keyed
as a PK or index column "encodes through a canonical JSON string". That has been false for a
**declared** `json` column since `bug-json-pk-store-scan-order` moved it to
`jsonStructuralKey` — canonical text is now only the generic OBJECT path for an `any`
column. The paragraph is the natural home for the rule this ticket created and said nothing
about it. Rewritten: retitled to OBJECT-class, split out the declared-`json` structural
form, and added a paragraph stating where a declared-`json` index column's `COLLATE` *does*
bite (top-level string scalar, both build- and write-time; nested leaves unaffected).
`docs/types.md` § *Semantic ordering* and `packages/quereus-store/README.md` were read in
full and are accurate as written — neither states a build-time dedupe rule.

**Added inline — the branch boundary was untested.** Both new tests from the implement pass
prove the fix REJECTS what it should. Nothing proved it does not over-reject, which is the
mirror-image defect a slightly-too-wide transform would introduce. New test
`unique-constraints.spec.ts` § *collation guard* → "a JSON index COLLATE folds only
top-level string scalars, so distinct nodes still build": under `COLLATE NOCASE`, the JSON
string `"9"`, the JSON number `9`, `["a"]`, `["A"]` and `"b"` all build into one unique
index; write-time then still rejects `"B"` and still admits `["B"]`. Runs against the store
and against a memory table as oracle.

**Handoff's known gaps, re-checked.**

- *TIMESPAN / TEXT controls not duplicated into the new tests* — confirmed both exist and
  run (`timespan-semantic-key-identity.spec.ts`, and the TEXT build/DML-agreement test
  immediately above the new JSON one). Cross-referencing rather than re-asserting is the
  right call; no change.
- *Comparator-only custom collation on a `json` index column* — confirmed pre-existing and
  untouched: `indexDedupeNormalizers` looks up the column's declared name and
  `keyNormalizers` throws for a name with no normalizer. Confirmed that **throwing is the
  correct outcome**, not a hole: a signature that cannot bucket cannot dedupe, and
  `docs/store.md` already states comparator-only collations are rejected rather than keyed
  under someone else's bytes. Only the message is confusing (the key-collation gate passed
  moments earlier), which is cosmetic. Left as the implement pass's `NOTE:`, not filed.

**Checked and found clean, with reasons — not "looks good".**

- *Resource cleanup* — nothing in the diff acquires a handle, store, or batch; the one
  unbounded structure (`seen`) is pre-existing and already carries its own `NOTE:`.
- *Error handling* — the only new control flow throws `QuereusError(CONSTRAINT)` on the
  first duplicate before any index entry is written; nothing is caught and swallowed.
- *Type safety* — no `any`, no widened assertion. `yarn workspace @quereus/store run
  typecheck` clean; `yarn lint` (which type-checks the engine's test files) clean.
- *Source hygiene* — `pk-key-resolution.ts` 458 lines, `store-module-index-build.ts` 373
  (`wc -l`); both new functions are 3 and 5 lines, single-purpose, named rather than
  commented into existence. Neither file is near its neighbours' size debt.
- *No new tickets filed.* The one structural oddity this bug depends on — index DDL
  applying no collation type gate, so `COLLATE NOCASE` on a `json` column is legal at all —
  is a deliberate, documented design decided in `store-index-collation-guard-collapse`
  ("the one shape that still declines everywhere"), not an undiscovered defect. Nothing else
  survived verification as major.
- *No new tripwires.* The two the implement pass recorded (the generalized future-type
  hazard at `dedupeRowSignature`, the confusing comparator-only error at
  `indexDedupeNormalizers`) are both at the right sites and both still accurate; nothing
  further was conditional-but-fine.

## Validation

- `yarn lint` — clean across all workspaces.
- `yarn workspace @quereus/store run typecheck` — clean (source changes are store-only;
  the doc change is prose).
- `yarn test` (full monorepo) — 0 failing. Store 1285 passing (1284 + the test added this
  pass), engine 8279, isolation 370, sync 643, plus the smaller packages. No
  `.pre-existing-error.md` written; nothing failed.
- Not run: `yarn test:store` (the LevelDB re-run of the engine logic suite). This change is
  in the store's build-time dedupe path, which that suite does exercise, but its wall-clock
  puts it outside an agent-runnable budget; the store package's own 1285-test suite covers
  both affected call sites directly.
