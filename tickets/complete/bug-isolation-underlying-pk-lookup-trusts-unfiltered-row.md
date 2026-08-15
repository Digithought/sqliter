---
description: |
  The transaction isolation layer used to ask a storage module "is there already a row with this
  key?" and believe the first row it got back without checking its key. Storage modules are allowed
  to answer with more rows than were asked for, so the layer could report a duplicate-key error for
  a key that is not in the table, or silently drop a row being saved. All three places that ask the
  question now verify the answer, and the review found and fixed a fourth place with the same
  problem: a read that merges saved-but-uncommitted rows with stored ones could return rows the
  query never asked for.
files:
  - packages/quereus-isolation/src/pk-probe.ts                     # NEW — the one trust decision
  - packages/quereus-isolation/src/isolated-table.ts               # probes, PK shape cache, merged-read window re-check
  - packages/quereus-isolation/src/flush.ts                        # rowExistsInUnderlying
  - packages/quereus-isolation/src/filter-info.ts                  # doc corrections + readonly params
  - packages/quereus/src/vtab/filter-info.ts                       # makeIndexEqSeekFilterInfo — omit: true → false
  - packages/quereus-isolation/test/pk-probe-unfiltered.spec.ts    # NEW — 23 cases
  - docs/design-isolation-layer.md                                 # § Full-scan merge contract
  - docs/module-authoring.md                                       # § Claiming handledFilters
difficulty: medium
---

# Isolation-layer reads now verify answers from modules that never claimed the filter

## The invariant

A `FilterInfo` binds a module only when the module *claimed* those constraints through its own
`getBestAccessPlan`. That claim is what earns the engine the right to drop the residual predicate
above the module. Without it, the module may legally answer with **any superset** of the rows
asked for — up to the whole table — and a module that cannot seek the requested columns is right to
do exactly that. (A column whose logical type orders by meaning rather than by stored bytes —
`TIMESPAN`, `JSON`: `'PT120M'` and `'PT2H'` are one value but two stored strings — cannot be
seeked byte-wise at all.)

Two families of read inside the isolation layer consume such an answer:

1. **Hand-built `FilterInfo`** — the layer builds one itself and calls `VirtualTable.query()`
   directly, so no negotiation happened at all and no engine sits above the call.
2. **Someone else's negotiated `FilterInfo`** — a merged read negotiates with the *underlying*
   module and then reads the *overlay*, which claimed nothing.

Both must re-check every row they get back. The two in-repo modules masked the whole class: the
store module re-applies its own filters after degrading a declined seek, and the memory module's
typed BTree seeks fine. Nothing caught it until a host supplied a scan-only module.

## What changed

### Implement stage — the three primary-key probes

New `packages/quereus-isolation/src/pk-probe.ts` holds the one trust decision:

- `PkKeyShape` / `makePkKeyShape(schema, resolveCollation)` — per-primary-key-column comparison
  functions (the type's own `compare` for a semantic-ordering column, else the declared collation)
  plus per-column sort directions.
- `PkEquals` / `makePkEquals` / `pkEqualsFromShape` — collation-aware, semantic-ordering-aware
  "same logical key?" test.
- `probeRowByPk(table, pkIndices, pk, pkEquals)` — drives the primary-key seek and checks the key
  of **every** row it gets back before believing it.

| site | old behaviour | consequence |
|---|---|---|
| `IsolatedTable.getUnderlyingRow` | returned the first row yielded | `UNIQUE constraint failed: <table> PK.` for a key not in the table |
| `flush.ts` `rowExistsInUnderlying` | returned `true` on the first row yielded | commit flush classified a fresh key as an `update`, wrote against a key that does not exist, and **silently lost the row** |
| `IsolatedTable.getOverlayRow` | returned the first row yielded | live when a host passes a scan-only module as `IsolationConfig.overlay` |

Two properties of `probeRowByPk` are load-bearing: it scans the **whole** iteration rather than
stopping at row #1 (stopping would convert today's false positive into a false negative that lets a
genuine duplicate key through), and the comparison is the *same* function the write path uses for
key identity (a binary compare would call `'apple'` and `'APPLE'` different keys under a `NOCASE`
primary key).

`isolated-table.ts` collapsed its two per-schema comparator caches into one `pkShapeCache` built by
`makePkKeyShape`, so `keysEqual`, `getComparePK`, and the probes all derive from a single
definition. `packages/quereus/src/vtab/filter-info.ts`'s `makeIndexEqSeekFilterInfo` now stamps
`aConstraintUsage[].omit: false` — `omit` is an *output* of `getBestAccessPlan`, and a hand-built
`FilterInfo` cannot assert it on the module's behalf.

### Review stage — the fourth site

`IsolatedTable.queryOverlayAsMergeEntries` handed the overlay the `FilterInfo` negotiated with the
underlying and yielded whatever came back. The engine had already dropped the residual on the
*underlying's* claim, so a host-supplied scan-only `IsolationConfig.overlay` leaked every staged row
into the answer of a point query. It now re-applies `buildConstraintMatcher` over the overlay's
stream — the same re-check `mergedSecondaryIndexQuery` already ran over its full overlay scan.
Tombstones bypass the matcher deliberately (they carry null non-PK columns, and an out-of-window
tombstone can only shadow a primary key the underlying stream does not carry).

`buildConstraintMatcher`'s two "no window pushed" returns became a shared `MATCH_ALL_ROWS`
constant, so the caller identity-tests it and skips the per-row call on the full-scan path — which
is every merged read the default memory overlay serves.

## Review findings

### Fixed in this pass

- **Major — a fourth site of the ticket's own class, at the merged read.** The implement stage
  fixed the three probes and wrote the invariant down, but `queryOverlayAsMergeEntries` trusts a
  `FilterInfo` the overlay never negotiated. **Confirmed with a repro before fixing**: with a
  `ScanOnlyMemoryModule` wired as `IsolationConfig.overlay`, `select k, v from t where k = 2`
  inside a transaction staging keys 2 and 3 returned *both* rows. Fixed as described above; the
  new case `a staged PK-point read returns only the matching row` fails without the fix.
- **Minor — the duplicate-key assertions swallowed the error.** Every conflict case was
  `try { … } catch { threw = true }` + `expect(threw).to.be.true`, which a typo in the SQL would
  also satisfy. Replaced with an `expectConstraintFailure(run, /UNIQUE constraint failed/i)` helper
  that asserts on the message.
- **Minor — `EMPTY_PK_SHAPE` was defined twice**, once in `pk-probe.ts` (private) and once in
  `isolated-table.ts`. `EMPTY_PK_KEY_SHAPE` is now exported from `pk-probe.ts` and used by both.

### Coverage added (the gaps the implement handoff flagged, closed)

The spec went from 12 cases to 23.

- **`getOverlayRow` against a scan-only overlay** — the handoff's top gap ("asserted, not directly
  exercised"). New describe `isolation reads vs an OVERLAY that scans` (5 cases) wires
  `ScanOnlyMemoryModule` to `IsolationConfig.overlay`: a staged point read, a staged
  update/tombstone still shadowing correctly, a commit through the scan-only overlay, and two
  duplicate-conflict sanity arms.
- **A semantic-ordering (TIMESPAN) primary key** — the handoff noted the `makePkKeyShape` semantic
  branch was untested. New describe (3 cases): a re-spelled duplicate (`'PT2H'` then `'PT120M'`) is
  a duplicate, a staged re-spelling stays one row, distinct spans both land.
- **Write shapes the original spec did not reach**: a staged delete, a delete + re-insert of the
  same key in one transaction, and a rolled-back transaction.

**Non-vacuity re-verified after the additions.** Short-circuiting `probeRowByPk`'s check *and*
the new merged-read matcher together fails 14 of the 23 cases. Separately, degrading
`makePkKeyShape`'s comparators to plain BINARY fails the NOCASE case-rewrite case and the TIMESPAN
staged-re-spelling case — so the collation arm and the semantic-comparator arm each have a test
that actually pins them.

### Checked and clean — no action

- **The overlay PK-index assumption the handoff asked to verify.** `IsolationModule.createOverlaySchema`
  builds the overlay as `{...baseSchema}` with the tombstone column *appended*, so
  `primaryKeyDefinition` and the primary-key columns are the same objects the table carries. The
  table's `PkEquals` and PK column indices address an overlay row unchanged. The assumption holds.
- **`getComparePK`'s rewritten fallback.** `compares` has exactly one entry per primary-key column,
  as `collations` did before it (`resolveCollationFunctions` returns one per definition entry);
  positions past the primary-key definition degrade to BINARY in both. Behaviour-identical.
- **The `omit: true → false` change is genuinely inert.** Grepped every `.omit` read in the repo:
  only the declaration in `index-info.ts` and the three writers. Nothing consumes the flag.
- **No other unverified consumer.** Every `.query(` call site under `packages/quereus-isolation/src`
  is a full scan the layer filters itself, a `probeRowByPk` call, or a loop that re-checks each row
  (`findUnderlyingUniqueConflict`).

### Recorded, not filed

- The implement stage's tripwire stands as a `NOTE:` on `probeRowByPk`: a module that cannot seek
  now pays a full scan per probe; if a scan-only backend shows up as slow on write-heavy
  transactions, cache the probe per statement rather than restoring the trust. Still conditional,
  still not work.
- No new tripwires. The merged-read matcher was a real defect the moment a scan-only overlay is
  supplied, not a conditional concern, so it was fixed rather than parked.

### Noticed, out of scope

- `probe-store.mjs` at the repository root is a committed debug scratch script left by a different
  ticket's error path (commit `67a9c443a`, `duration-json-semantic-ordering-engine`). Not touched —
  it is not this ticket's file — but a human sweeping the root will want to delete it.

### Not filed

No tickets were opened. The one major finding resolved at a single named site with a small fix and
a passing regression test, which makes filing it strictly worse than fixing it.

## Docs

`docs/design-isolation-layer.md` § Full-scan merge contract now states the invariant in both
directions — hand-built `FilterInfo` *and* someone else's negotiated one — and names the two merged
paths and why each re-applies the window. `docs/module-authoring.md` § Claiming handledFilters
notes that a caller driving `query()` outside the planner has no engine residual and owns the
re-check. `packages/quereus-isolation/src/filter-info.ts`'s comment claiming a module ignoring an
index hint "still applies the equalities as a residual filter" — the same false belief, written
down — was corrected during implement.

## Validation

All green, no pre-existing failures surfaced.

- `yarn build` — clean
- `yarn typecheck` — clean (this type-checks the new spec: the isolation package's `typecheck`
  script runs `tsc -p tsconfig.test.json --noEmit`)
- `yarn lint` — clean
- `yarn workspace @quereus/isolation test` — 410 passing / 0 failing (was 399 after implement; the
  12 implement-stage cases were reworked into 23)
- `yarn workspace @quereus/quereus test` — 9601 passing / 25 pending / 0 failing (5m). Matters
  because `packages/quereus/src/vtab/filter-info.ts` is touched.
- `yarn workspace @quereus/store test` — 1794 passing
- `yarn workspace @quereus/sync test` — 725 passing; `@quereus/sync-client` — 85 passing;
  `@quereus/plugin-loader` — 119 passing

Not run: `yarn test:store` (the LevelDB re-run of the engine logic tests). Nothing here is
store-specific — the store module was already immune, since it re-applies its own filters after
degrading a declined seek — but that is reasoning, not a run. `yarn test` as a single fan-out
exceeds the 10-minute agent budget, so the packages were run individually instead; between them
they cover every workspace with a test script.
