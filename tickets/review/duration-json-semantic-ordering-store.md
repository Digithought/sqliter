---
description: The persistent store now treats equal-meaning duration values (like "1 hour" vs "60 minutes") as the same key — duplicates are rejected, conflict actions fire, and staged transaction writes shadow the committed row across spellings.
prereq: duration-json-semantic-ordering-engine
files:
  - packages/quereus/src/util/comparison.ts              # new semanticKeyTransform helper (engine)
  - packages/quereus/src/index.ts                        # exports semanticKeyTransform + serializeKey
  - packages/quereus-store/src/common/encoding.ts        # KeyValueTransform; transforms in encodeCompositeKey
  - packages/quereus-store/src/common/key-builder.ts     # transforms threaded through all key/bounds builders
  - packages/quereus-store/src/common/store-table.ts     # resolvePkKeyTransforms / typed unique compares / keysEqual / rekeyRows
  - packages/quereus-store/src/common/store-module.ts    # index rebuild transforms; dedupe signatures; ALTER SET TYPE handling
  - packages/quereus-isolation/src/isolated-table.ts     # shadow keys, comparePK, keysEqual, merged UNIQUE compares
  - packages/quereus-isolation/src/overlay-rows.ts       # makePkKeySerializer canonicalizes
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts   # new coverage
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts           # comment updates only
  - docs/types.md                                        # store identity paragraph in "Semantic ordering"
---

# Semantic key identity for TIMESPAN in the persistent store — implemented

## What was built

The ruling (docs/types.md "Semantic ordering"): a value's identity and order are its
logical type's `compare`. The engine prereq already made the store DECLINE ordering
advertisements and byte windows over TIMESPAN/JSON members. This ticket closed the
remaining **identity** gap: the store used to accept `'PT1H'` and `'PT60M'` as two
distinct PK rows while the memory table collapsed them.

Mechanism — one new concept threaded everywhere key bytes are made:

- Engine exports `semanticKeyTransform(logicalType)`: the type's `groupKey` wrapped as
  a value transform, defined only for semantic-ordering types whose stored form is not
  canonical for equality (today: TIMESPAN → total seconds against the same reference
  date as `compare`; JSON needs none — canonical text is already identity-faithful).
- `quereus-store` threads per-column transforms (parallel to the existing per-column
  key collations) through `encodeCompositeKey` → `buildDataKey` / `buildIndexKey` /
  `buildPkPrefixBounds` / `buildIndexPrefixBounds`. `StoreTable` resolves them once
  (`resolvePkKeyTransforms` / `resolveIndexKeyTransforms`) and every key-producing
  path uses them: DML data keys (all raw `buildDataKey` call sites now funnel through
  `encodeDataKey`), secondary-index maintenance, the UNIQUE-enforcement probe,
  `rekeyRows` (ALTER), and `StoreModule.buildIndexEntries` (index build/rebuild).
- Because TIMESPAN's transform yields a number, its key bytes also ORDER by elapsed
  time now — but the read-side declines were deliberately left closed (see
  `keyOrderMatchesCollation`'s comment); re-opening is backlog
  `feat-reopen-timespan-store-seeks`.
- Value-level equality sites got the matching typed compare: `StoreTable.keysEqual`
  (self-PK exclusion), the three UNIQUE conflict finders
  (`uniqueColumnComparators`), and the build-time dedupe signatures
  (`dedupeRowSignature` in store-module, used by `CREATE UNIQUE INDEX` and
  ADD CONSTRAINT validation).
- ALTER: `SET DATA TYPE` onto/off a transform-bearing type now re-validates UNIQUEs
  and rebuilds secondary indexes (and would re-key a PK, though the engine bans
  SET TYPE on PK columns, so that arm is defensive). `rekeyRows` resolves post-ALTER
  transforms, so its pass-1 collision check rejects a collapsing retype
  all-or-nothing.
- Isolation layer: the overlay's PK shadow keys (`makePkKeySerializer`, the
  modified-PK set in `mergedSecondaryIndexQuery`), `keysEqual`, the fallback
  `getComparePK`, the merged UNIQUE-check compares, and `buildDescriptorComparators`
  are all semantic-aware — a staged `'PT1H'` write shadows a committed `'PT60M'` row.

## How to validate

- `yarn test` — green (all workspaces).
- `yarn test:store` — 2323 passing, **1 pre-existing failure** (below).
- Focused: `node --import ./packages/quereus-store/register.mjs
  node_modules/mocha/bin/mocha.js
  "packages/quereus-store/test/timespan-semantic-key-identity.spec.ts"` — 15 tests:
  PK duplicate rejection with the memory table as oracle, `on conflict
  ignore/replace`, re-spelling UPDATE as in-place, cross-spelling UPDATE/DELETE
  addressing, composite PK mid-key member, PK ordering vs memory, secondary-UNIQUE
  rejection + index maintenance across a re-spelling UPDATE, `create unique index`
  build-time rejection, ALTER SET TYPE rejection/rebuild, and three isolated-store
  tests (shadowing rewrite, cross-spelling DELETE, in-transaction PK conflict).
- `yarn lint`, `yarn typecheck`, and `tsc -p packages/quereus-store/tsconfig.test.json`
  are green.

## Pre-existing failure (reported, not mine)

`15.1-semantic-ordering.sqllogic:134` fails in STORE mode only:
`select d from il where d in ('PT120M','PT30M')` returns 0 rows. Verified identical
at HEAD (2b39ba4f) in a clean worktree — the engine's `In` plan-node residual is not
semantic-ordering-aware, and store mode exposes it because the store declines the
multi-seek that memory mode plans instead. Filed `tickets/.pre-existing-error.md`
with the diagnosis; do not chase it here.

## Known gaps / honest notes for the reviewer

- **Memory backend divergence**: memory tables still ACCEPT `'PT60M'` after `'PT1H'`
  in a plain UNIQUE column (PK is fine). Filed `fix/bug-memory-unique-timespan-spelling`;
  the new spec deliberately omits the memory oracle for that one case.
- **No test** drives `mergedSecondaryIndexQuery`'s shadow set or
  `buildDescriptorComparators` with a timespan PK under isolation (needs a secondary-
  index scan plan on the underlying while an overlay exists); the fixes there are
  code-reviewed-only.
- **On-disk data written before this change** (text-encoded timespan keys) is not
  migrated and becomes unreachable under the new encoding — backwards compatibility
  is waived project-wide (AGENTS.md), stated here so it isn't re-flagged.
- **Unparseable timespan values** pass through the transform as raw text (matching
  `TIMESPAN.compare`'s BINARY-text fallback, so identity stays exact); write-time
  coercion normally rejects them. Mixed parseable/unparseable byte-order divergence
  only matters if the seek declines are ever re-opened — noted in the backlog ticket.
- **quereus-sync** serializes PKs through its own change-log paths; whether it
  buckets equal-elapsed spellings was not examined (all sync tests green). If sync
  replicates a re-spelled PK as a distinct row on a peer, that would be an engine/sync
  identity question, not a store keying one.
- The `alterColumnChange` PK-rekey-on-retype arm is unreachable through SQL today
  (engine bans SET DATA TYPE on PK columns) — kept as defense in depth.
- **Adjacent in-flight tickets touch the same ALTER region**:
  `fix/bug-set-data-type-skips-unique-index-revalidation` (general value-collapsing
  retype, e.g. text '1'/'01' → integer 1 — my `keyTransformChanged` gate re-validates
  only TRANSFORM changes, so that ticket stays valid and will merge into the same
  `alterColumnChange` block) and `fix/bug-store-pk-column-set-data-type-corrupts-keys`
  (may be partly obsoleted by the engine-level SET-TYPE-on-PK ban this ticket ran
  into at runtime/emit/alter-table.ts ~974 — worth checking during its triage).

## Tickets spawned

- `fix/bug-memory-unique-timespan-spelling` — memory plain-UNIQUE gap.
- `backlog/feat-reopen-timespan-store-seeks` — re-open seeks/advertisements now that
  TIMESPAN key bytes are order-preserving.
- `tickets/.pre-existing-error.md` — engine `In` node semantic gap (store mode).
