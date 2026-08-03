---
description: Looking up a single row by a duration or JSON key in a persistent table still reads the whole table instead of jumping straight to the row. Turn that direct lookup back on, including across different spellings of the same duration.
prereq: feat-store-semantic-key-range-seeks
files:
  - packages/quereus-store/src/common/store-table-scan.ts     # analyzePKAccess point arm, analyzeIndexAccess EQ-prefix arm, pkHasSemanticOrderingMember
  - packages/quereus-store/src/common/pk-key-resolution.ts    # semanticProbeIsKeyFaithful (added by the prereq ticket)
  - packages/quereus-store/src/common/store-module-access-plan.ts  # the full-PK-equality arm and tryIndexAccessPlan's eq arm (no change expected — verify)
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts
  - packages/quereus-store/test/json-semantic-key-order.spec.ts
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts
  - packages/quereus-store/test/pushdown.spec.ts
  - docs/types.md   # § Semantic ordering
---

# Re-open point / EQ-prefix seeks over TIMESPAN and JSON key columns

## Background

The prereq ticket (`feat-store-semantic-key-range-seeks`) established that a `timespan`
or `json` key column's physical bytes reproduce the type's `compare` order for every
value a store-backed table can hold, and added the two predicates that state it:
`semanticKeyOrderIsFaithful(type)` and `semanticProbeIsKeyFaithful(type, probe)`. It
re-opened the order-shaped read arms (ordering advertisements, range windows).

The **equality**-shaped arms are still declined, in two places:

- `StoreTableScan.analyzePKAccess` — the full-PK-equality arm is skipped whenever
  `pkHasSemanticOrderingMember()` holds, so `where d = 'PT1H'` on a `timespan` primary
  key full-scans instead of doing one point read.
- `StoreTableScan.analyzeIndexAccess` — the contiguous leading-prefix EQ loop `break`s
  on `hasSemanticOrdering`, so an index whose leading column is such a type never
  produces a prefix window.

Both declines were correct when byte equality was a strict *subset* of the type's
equality: `'PT1H'` and `'PT60M'` are one hour but were two distinct key byte strings, so
a point window under-fetched, and no residual could resurrect a row a window skipped.
Since `duration-json-semantic-ordering-store` and `bug-json-pk-store-scan-order` the
transforms collapse those spellings onto one key, so the declines are now purely
conservative.

Re-opening them is not only a speed-up: `where d = 'PT60M'` should *find* the row stored
as `'PT1H'`, which today it does — via the full-scan residual — and must keep doing via
the seek.

## Design

### 1. The PK point arm

Replace the schema-level `pkHasSemanticOrderingMember()` gate with a per-value one over
the collected equality values:

```ts
if (allEq && eqValues.every((v, i) => semanticProbeIsKeyFaithful(
        schema.columns[pkColumns[i]]?.logicalType, v))) {
    return { type: 'point', values: eqValues };
}
```

An EQ window is a single byte position: unlike a range bound it cannot be *widened*, so
an unfaithful probe must **decline the whole point arm** and fall through to
`{ type: 'scan' }`, where `matchesFilters` re-checks under the type's `compare`. Say so
in a comment right there — the widen-vs-decline asymmetry with `buildPKRangeBounds` is
the non-obvious part of this change.

Declining at runtime is safe even though `computeBestAccessPlan`'s full-PK-equality arm
already claimed the filters handled and the engine dropped the residual `Filter`: every
scan arm applies `matchesFilters`, which ANDs every pushed constraint under the column's
real comparator. The plan's claim is about which *filters* the module honours, not about
which physical arm it uses.

**Do not delete `pkHasSemanticOrderingMember()`.** `scanMultiSeekPrimary` still needs it —
a primary-key multi-seek has no widen-to-scan degradation (its merged windows drop rows
outright, and a full-scan fallback would AND N mutually-exclusive equalities to zero
rows), so it must keep throwing `multiSeekMalformed`. Re-point its doc comment at
`feat-store-semantic-key-multiseek` and drop the "re-opening is tracked in
`feat-reopen-timespan-store-seeks`" sentence.

### 2. The secondary-index EQ-prefix arm

Replace the `break` on `hasSemanticOrdering` with a `break` on an **unfaithful probe**:

```ts
for (let i = 0; i < indexCols.length; i++) {
    const eq = /* … find the EQ constraint on indexCols[i] … */;
    if (!eq) break;
    const value = filterInfo.args[eq.argvIndex - 1];
    if (!semanticProbeIsKeyFaithful(this.tableSchema!.columns[indexCols[i]]?.logicalType, value)) break;
    eqValues.push(value);
}
```

Stopping the prefix *short* is sound where declining a point read is required: a prefix
window over fewer columns is a strict **superset** of the longer one, and `matchesFilters`
re-checks the dropped column. If the stop leaves `eqValues` empty, control falls to the
range arm exactly as it does today.

The transforms this window needs are already threaded — the prereq ticket added the
memoized `indexKeyTransforms(index)` and passed it to all three `buildIndexPrefixBounds`
call sites. Verify that the prefix arm's slice is `indexKeyTransforms(index).slice(0,
eqValues.length)`, aligned with the existing `directions` / `collations` slices.

`indexPrefixSeekIsCollationExact` still runs after the loop and is what declines a
`json` / temporal index column carrying an explicit non-BINARY `COLLATE` (key bytes
hard-BINARY, residual under the declared name). Leave it in place and test that shape.

### 3. Why a faithful EQ probe gives an exact window

**TIMESPAN.** Stored values are all canonical, `Temporal.Duration.from`-parseable text
(every write path coerces through `TIMESPAN_TYPE.parse`), so every stored key member is
`NUMERIC(total seconds)`. A faithful probe is a parseable string, so it encodes to
`NUMERIC(total seconds)` too, and byte equality is exactly elapsed-time equality — which
is exactly what `TIMESPAN.compare` calls equal. `'PT60M'` and `'PT1H'` land on one key.
(`Temporal.Duration` does **not** normalize units on round-trip, so both spellings can be
the stored text; only the key collapses them.)

**JSON.** A faithful probe is anything `jsonKeyEncodable` admits, and
`jsonStructuralKey` is injective over those up to exactly the identities
`deepCompareJson` calls equal — object keys are sorted (reorder-equal objects collide),
`2` and `2.0` are one double, `-0` normalizes to `+0`.

### 4. What needs no change (verify, don't rewrite)

- `computeBestAccessPlan`'s full-PK-equality arm and `tryIndexAccessPlan`'s equality arm
  already claim their filters handled for these columns — they never consulted
  `hasSemanticOrdering` on the plain-EQ path. Confirm with `query_plan`.
- The multi-seek declines stay (`tryIndexAccessPlan`'s `isMultiSeek` arm,
  `scanMultiSeek`'s and `scanMultiSeekPrimary`'s throws). Backlog
  `feat-store-semantic-key-multiseek`.
- UNIQUE enforcement and `keysEqual` already collapse spellings through the transforms
  and `resolvePkSemanticEquality`.

## Edge cases & interactions

The memory table is the oracle for every row-set assertion.

**The headline behaviours**

- `where d = 'PT60M'` finds the row stored as `'PT1H'`, and the plan is a `_primary_`
  point lookup rather than a scan.
- `where j = json('{"b":2,"a":1}')` finds the row stored as `'{"a":1,"b":2}'`.
  (A `json` column compared against a bare TEXT literal matches nothing on **either**
  backend — storage-class mismatch in the generic EQ path — so JSON probes must be
  written through `json(...)`. `json-semantic-key-order.spec.ts` ~line 220 records that
  constraint. If a `json(...)` probe turns out not to be pushed down as a constraint,
  confirm with `query_plan` and say so in the handoff rather than working around it.)
- A secondary index whose leading column is `timespan` / `json`, with an EQ predicate:
  the prefix window seeks and returns the right rows. Without the threaded transforms
  from the prereq this returns nothing — keep it as an explicit regression.

**Declines (the probe gate)**

- `where d = 5` on a `timespan` key — numeric probe. Must return exactly what memory
  returns (nothing: `createTypedComparator` short-circuits on the storage-class mismatch)
  and must not seek to a bogus `NUMERIC(5)` key.
- `where d = 'not a duration'` — unparseable string probe. Must equal memory.
- `where j = x'01'` on a `json` key — blob probe. Must equal memory and must **not** raise
  `INTERNAL` out of `jsonStructuralKey`.
- A **composite** PK with one `timespan` member and one plain member, where the timespan
  probe is unfaithful: the *whole* point arm declines (a point window cannot widen), rows
  still correct.
- A composite **index** whose interior column's probe is unfaithful: the prefix stops
  there, the shorter window is used, rows still correct — the case that distinguishes
  "stop the prefix" from "decline the arm".
- An index prefix that stops at position 0 falls through to the range arm / full scan.

**Raise, don't decline**

- `where j = <json value whose string leaf carries an unpaired surrogate>` must raise the
  existing `unpaired surrogate` error, matching the text-PK precedent and the range-bound
  case the prereq ticket added. Behaviour change from today's silent zero rows; test it
  in `lone-surrogate-keys.spec.ts`'s declared-`json`-PK block.

**Collation shapes that must stay declined**

- `create index ix on t (j collate nocase)` with an EQ predicate — no seek
  (`indexPrefixSeekIsCollationExact`), rows still correct.

**Writes and transactions**

- `delete from t where d = 'PT60M'` removes the row stored as `'PT1H'`; `update … where
  d = 'PT60M'` likewise. These now route through the re-opened point arm, so they are the
  data-loss-shaped direction of the change — assert the surviving rows explicitly.
- Inside a transaction: insert a `'PT1H'` row, then `select … where d = 'PT60M'` in the
  same transaction must find it (`readLiveRowByPk` → `readEffectiveRowByKey` over the
  pending overlay), and after a pending delete must not.
- Isolation overlay: a point lookup against a `createIsolatedStoreModule` table with a
  pending shadow row at a differently-spelled key must return the overlay's row, not the
  underlying one.
- `insert or replace` / `on conflict` across spellings must keep behaving as
  `json-semantic-key-order.spec.ts` and `timespan-semantic-key-identity.spec.ts` already
  pin — the point arm is now also the read half of those paths.

**Multi-seek stays declined**

- `where d in ('PT1H','PT2H')` on an indexed `timespan` column returns the correct rows
  via the cost-only plan and must not throw `Malformed multi-seek FilterInfo`.

## TODO

- Re-open `analyzePKAccess`'s point arm behind `semanticProbeIsKeyFaithful` over the
  collected EQ values; comment the widen-vs-decline asymmetry.
- Keep `pkHasSemanticOrderingMember()` for `scanMultiSeekPrimary`; rewrite its doc comment
  (it currently describes the point-arm decline it no longer causes) and re-point the slug.
- Re-open `analyzeIndexAccess`'s EQ-prefix loop: break on an unfaithful probe rather than
  on `hasSemanticOrdering`; confirm the transform slice is aligned with the
  directions/collations slices.
- Verify the plan side needs no change (`query_plan` on each shape).
- Add the tests enumerated above; extend the existing specs rather than minting new files
  where the fixtures already exist.
- Update `docs/types.md` § Semantic ordering: the only remaining store decline is
  multi-seek. Sweep for any stale "seeks over semantic-ordering members remain declined"
  wording left in `docs/store.md`, `pk-key-resolution.ts`, `store-table-scan.ts` and the
  spec headers.
- Validate: `yarn build`, then the store package tests, `yarn test`, `yarn lint` — each
  streamed with `2>&1 | tee /tmp/<name>.log` followed by a separate `tail`. Run
  `yarn test:store` if it fits the idle-timeout window and report whether it did.
