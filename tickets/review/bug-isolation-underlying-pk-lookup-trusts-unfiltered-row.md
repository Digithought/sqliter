---
description: |
  The transaction isolation layer used to ask a storage module "is there already a row with this
  key?" and believe the first row it got back without checking its key. Storage modules are allowed
  to answer with more rows than were asked for, so the layer could report a duplicate-key error for
  a key that is not in the table, or silently drop a row being saved. All three places that ask the
  question now verify the answer.
files:
  - packages/quereus-isolation/src/pk-probe.ts                     # NEW — the one trust decision
  - packages/quereus-isolation/src/isolated-table.ts               # getUnderlyingRow, getOverlayRow, keysEqual, getComparePK, PK shape cache
  - packages/quereus-isolation/src/flush.ts                        # rowExistsInUnderlying
  - packages/quereus-isolation/src/filter-info.ts                  # doc corrections + readonly params
  - packages/quereus/src/vtab/filter-info.ts                       # makeIndexEqSeekFilterInfo — omit: true → false
  - packages/quereus-isolation/test/pk-probe-unfiltered.spec.ts    # NEW — 12 cases
  - docs/design-isolation-layer.md                                 # § Full-scan merge contract
  - docs/module-authoring.md                                       # § Claiming handledFilters
difficulty: medium
---

# Isolation-layer primary-key probes now verify the rows they get back

## What was wrong

Three places in the isolation layer asked "does a row with this primary key exist?" by building a
`FilterInfo` by hand and passing it straight to `VirtualTable.query()`, then taking row #1 of the
answer.

That is unsound. A hand-built `FilterInfo` is a **request for a seek, not a contract**: the module
never went through `getBestAccessPlan`, so it never claimed those constraints, and there is no
engine above a direct `query()` call to reapply the unclaimed ones as a residual filter. A module
that cannot seek the requested columns is entitled to answer with any superset of the requested
rows — up to the whole table. That is not a broken module; it is the documented, correct behaviour
when a column's logical type orders by meaning rather than by stored bytes (`TIMESPAN`, `JSON`:
`'PT120M'` and `'PT2H'` are one value but two stored strings).

The two in-repo modules happen to mask it — the store module re-applies its own filters after
degrading a declined seek, and the memory module's typed BTree seeks fine — so nothing in the repo
caught it until a host supplied a scan-only module.

| site | old behaviour | consequence |
|---|---|---|
| `IsolatedTable.getUnderlyingRow` | returned the first row yielded | `UNIQUE constraint failed: <table> PK.` for a key not in the table |
| `flush.ts` `rowExistsInUnderlying` | returned `true` on the first row yielded | commit flush classified a fresh key as an `update`, wrote against a key that does not exist, and **silently lost the row** |
| `IsolatedTable.getOverlayRow` | returned the first row yielded | dormant with the default memory-table overlay; live when a host passes a scan-only module as `IsolationConfig.overlay` (a public option) |

The two flush/conflict arms had to land together: fixing only the conflict check converts a loud
false error into quiet data loss (confirmed — see *How this was verified* below).

## What changed

**New `packages/quereus-isolation/src/pk-probe.ts`** — the one place the trust decision lives:

- `PkKeyShape` / `makePkKeyShape(schema, resolveCollation)` — per-primary-key-column comparison
  functions (the type's own `compare` for a semantic-ordering column, else the declared collation)
  plus per-column sort directions.
- `PkEquals` / `makePkEquals` / `pkEqualsFromShape` — collation-aware, semantic-ordering-aware
  "same logical key?" test.
- `probeRowByPk(table, pkIndices, pk, pkEquals)` — drives the primary-key seek and checks the key
  of **every** row it gets back before believing it.

Two properties of `probeRowByPk` are load-bearing:

- It scans the **whole** iteration rather than checking row #1 and stopping. Stopping early would
  convert today's false positive ("a row came back ⇒ the key is taken") into a false negative
  ("row #1 is not it ⇒ the key is free"), which lets a genuine duplicate key through and corrupts
  the table. For a module that actually seeks, the iteration is one row and nothing changes.
- The comparison is the *same function* the write path uses for key identity. A binary compare
  would call `'apple'` and `'APPLE'` different keys under a `NOCASE` primary key, splitting one
  row into two.

**`isolated-table.ts`** — `getUnderlyingRow` and `getOverlayRow` now call `probeRowByPk`. The
per-schema comparator caches (`pkCollationCache`, `pkSemanticCache`) collapsed into one
`pkShapeCache` built by `makePkKeyShape`, so `keysEqual`, `getComparePK`, and the probes all derive
from a single definition. `keysEqual` is now a one-line delegate to that cached `PkEquals` —
behaviour-identical to the code it replaced. The now-unused `buildPKPointLookupFilter` helper is
gone.

**`flush.ts`** — `rowExistsInUnderlying` routes through `probeRowByPk`. The `PkEquals` is built
once per flush from `underlyingSchema` + `underlyingTable.db.getCollationResolver()` (no signature
change needed; `VirtualTable.db` is public).

**`packages/quereus/src/vtab/filter-info.ts`** — `makeIndexEqSeekFilterInfo` now stamps
`aConstraintUsage[].omit: false`. `omit` is an **output** of `getBestAccessPlan` — the module's own
claim that it applied a filter — and a hand-built `FilterInfo` cannot assert it on the module's
behalf. This is inert today: nothing in the repo reads the flag (`table-access-nodes.ts` counts
`aConstraintUsage.length` for EXPLAIN only), and the negotiated path in `rule-select-access-path`
builds its own `aConstraintUsage` inline and still sets `omit: true`, where it is earned.

**Doc corrections** — `makeSecondaryIndexEqSeekFilter`'s comment claimed a module ignoring the
index hint "still applies the equalities as a residual filter". That was the same false belief,
written down; it now states the real reason its one caller (`findUnderlyingUniqueConflict`) is
safe: that caller re-checks every returned row itself. `docs/design-isolation-layer.md` states the
invariant next to the scan list; `docs/module-authoring.md` notes that a caller driving `query()`
outside the planner has no engine residual and owns the re-check.

## How this was verified

New spec `packages/quereus-isolation/test/pk-probe-unfiltered.spec.ts` (12 cases, 3 describes)
drives the layer against `ScanOnlyMemoryModule` — a `MemoryTableModule` that declines every pushed
filter in `getBestAccessPlan` and proxies every `query()` to a full scan. That is a *legal* module
shape, and declining at plan time keeps ordinary SQL correct (the engine keeps the residual above
the module), so only the hand-built probes see the unfiltered answer.

**The spec was confirmed non-vacuous.** With the verification in `probeRowByPk` short-circuited
(`if (true || pkEquals(...))`), **7 of the 12 cases fail** — the conflict-check arm as
`ConstraintError: UNIQUE constraint failed: t PK.` on a distinct key, and the flush arm as silent
row loss. Restored, all 12 pass.

Coverage:

- integer PK — autocommit second insert; fresh PK inside an explicit transaction; several fresh
  PKs in one transaction (the flush arm alone); PK-relocating update + reuse of the freed key;
  non-relocating update
- compound PK — keys sharing a leading column stay distinct
- `text collate nocase` PK — a case-only PK rewrite stays one row; a case-differing insert is
  correctly a duplicate; genuinely distinct text keys both land
- sanity arms in every group: a genuine duplicate still conflicts, including one staged in a
  transaction where the duplicate is *not* the first row of the scan (that one is what pins the
  whole-iteration requirement)

## What a reviewer should push on

Honest gaps, in rough order of how much I would want a second pair of eyes:

- **`getOverlayRow` verification is asserted, not directly exercised.** The new spec supplies a
  scan-only *underlying*; it never passes a scan-only module as `IsolationConfig.overlay`. That
  arm is covered only by reasoning (the same helper, the same `PkEquals`) plus the fact that the
  default memory overlay serves the seek so verification is a no-op there. A test that wires
  `IsolationConfig.overlay` to `ScanOnlyMemoryModule` would close it.
- **The `PkEquals` used to verify overlay rows is the *table's*, not the overlay's.** The overlay
  schema appends the tombstone column after the table's own columns, so the table's PK column
  indices address an overlay row unchanged and the PK columns' collations/types are the same
  objects. I believe this is right and noted it in the `getOverlayRow` doc comment, but it is an
  assumption worth checking against the overlay-creation path rather than taking from me.
- **`getComparePK`'s fallback was rewritten, not just moved.** It previously read
  `collations[i] ?? BINARY_COLLATION` per position; it now reads `compares[i] ?? <binary>`. Same
  degradation for a key longer than the PK definition, but it is the merge-order comparator, so a
  drift here would show up as mis-shadowed rows rather than an error. Worth a read.
- **No test covers a semantic-ordering (`TIMESPAN` / `JSON`) primary key.** The original report
  came from that direction, but the trigger is the module rather than the type, so the spec uses
  `integer` and `text` for legibility. The semantic-comparator path in `makePkKeyShape` is
  therefore exercised only by the pre-existing tests that used the code it replaced.
- **No performance measurement.** A module that cannot seek now pays a full scan per probe instead
  of returning a wrong answer. I did not measure the cost against any real scan-only backend — see
  the tripwire below.

## Review findings (from implement)

- Parked a tripwire as a `NOTE:` on `probeRowByPk` (`packages/quereus-isolation/src/pk-probe.ts`):
  a module that cannot seek now pays a full scan per probe; if a scan-only backend ever shows up
  as slow on write-heavy transactions, cache the probe per statement rather than restoring the
  trust. Conditional, not currently work.

## Validation run

All green, no pre-existing failures surfaced.

- `yarn workspace @quereus/isolation test` — 399 passing (was 387; +12 new), 0 failing
- `yarn build` — clean
- `yarn test` — full workspace fan-out, exit 0. Notable counts: `@quereus/quereus` 9601 passing /
  25 pending / 0 failing (6m), isolation 399, store 1794, sync 725, plus the smaller packages.
  The engine suite matters here because `packages/quereus/src/vtab/filter-info.ts` is touched.
- `yarn typecheck` — clean (this is what type-checks the new spec: the isolation package's
  `typecheck` script runs `tsc -p tsconfig.test.json --noEmit`)
- `yarn lint` — clean

Not run: `yarn test:store` (LevelDB re-run of the engine logic tests). Nothing in this change is
store-specific — the store module was already immune, since it re-applies its own filters after
degrading a declined seek — but that is reasoning, not a run.
