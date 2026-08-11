---
description: On the persistent storage backend, looking up a list of rows by their primary key reads the whole table instead of fetching just those rows — the fast path exists and works for other indexed columns, but the query planner never selects it for a primary key.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # computeBestAccessPlan — the PK arms; EQ_OPS vs EQ_OR_IN_OPS
  - packages/quereus-store/src/common/store-table-scan.ts           # scanMultiSeekPrimary (~line 1139) — the runtime arm, already written
  - packages/quereus-store/src/common/pk-key-resolution.ts          # pkOrderPreservingPrefixLength, keyOrderMatchesCollation
  - packages/quereus/src/vtab/best-access-plan.ts                   # equalitySeekKeyCount / isMultiValueEquality / AccessPlanBuilder
  - packages/quereus-store/test/pushdown.spec.ts                    # literal-list coverage lives here
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts        # plan-level runtime-set coverage; has a decline test to invert
  - packages/quereus-store/test/index-scan-batching.spec.ts         # stale "not reachable" comment
difficulty: medium
---

# Store: plan a primary-key multi-seek for `pk in (…)` — planner arm + literal list

Scope narrowed from the original ticket after a design pass (see **Design findings**
below — they are the whole point of this rewrite; do not re-derive them). This ticket
builds the planner arm and covers it for the **literal-list** shape
(`where pk in (1, 2, 3)`).

The `in (select …)` / `KeySetSemiJoin` shape and the isolation-wrapped
read-your-own-writes coverage moved to `feat-store-pk-key-set-seek-coverage`
(`prereq:` this one).

## What happens today

`select … from t where pk in (1, 2, 3)` full-scans a store-backed table.
`computeBestAccessPlan`'s primary-key arm matches `'='` and nothing else, so no plan
ever names a `_primary_` multi-seek. The secondary-index arm has used `EQ_OR_IN_OPS`
since `feat-store-in-list-index-pushdown`, which is why the same query on a non-key
indexed column is fast.

The runtime arm already exists and is correct: `scanMultiSeekPrimary`
(store-table-scan.ts ~line 1139) encodes one data key per tuple, deduplicates, sorts
ascending by encoded key, and point-reads each in `ROW_RESOLUTION_BATCH` batches.

A downstream application hits exactly this: rendering one account's ledger wants the
sibling rows of N transactions fetched by key. It full-scans two tables and filters in
JavaScript (~800 ms at 36 000 rows) rather than issue the targeted read.

## Design findings (from the investigation pass — build to these)

### Where the arm goes

`computeBestAccessPlan`'s current order is: full-PK equality point lookup → leading-PK
range → secondary indexes (cost-ranked) → full scan.

Put the multi-seek arm **inside** the full-PK-equality branch, splitting on
`isMultiValueEquality`, i.e. *before* the leading-PK range arm. That is what keeps a
full-primary-key list from being shadowed by a range on the leading column
(`bug-store-pk-range-preempts-cheaper-index` — do not fix the general arm-competition
problem here). Say so in a comment at the arm.

A **gate decline falls through** to the arms below rather than returning cost-only.
That is safe: an `IN` is not in `RANGE_OPS`, so the leading-PK-range arm cannot grab
it, and it lands on the secondary-index arms / full scan exactly as today.

`pkOrderPreservingPrefix` is currently computed *after* the point-lookup arm. Hoist the
`pkOrderPreservingPrefixLength(...)` call above both PK arms — the new arm's ordering
advertisement needs it. It is cheap (a short loop over PK members).

### Pinning the key

Replace the `pinnedPkColumns` Set with a per-PK-column `find`, which preserves the
invariant its comment protects for free: `a = 1 and a = 2` on a composite PK `(a, b)`
finds a filter for `a`, none for `b`, and correctly reports the key unpinned.

```ts
/** The equality pins covering the WHOLE primary key, or null when a member is unpinned. */
interface PrimaryKeyPins {
    /** Cross-product of the per-column seek-key counts (1 for a plain '='). */
    readonly seekKeyCount: number;
    /** true ⇒ delivered as a `plan=5` multi-seek, not a single point read. */
    readonly isMultiSeek: boolean;
}
```

Per column take the FIRST filter with `equalitySeekKeyCount(f) !== null`, multiply the
counts, and OR `isMultiValueEquality(f)`. Same predicates and same positional pick the
secondary arm and `rule-select-access-path`'s `eqBySeekCol` use, so the module's claim
and the rule's pick cannot disagree. `isMultiSeek` is NOT `seekKeyCount > 1` — a
runtime-valued set is delivered as `plan=5` even at `maxCount === 1`.

### `EQ_OPS` becomes dead — collapse it

Broadening the PK arms means both arms claim through `EQ_OR_IN_OPS`, leaving `EQ_OPS`
with no caller. Delete it and drop the now-pointless `ops` parameter from
`equalityRoles`. Rewrite the `EQ_OR_IN_OPS` doc comment — it currently states the PK
arms deliberately keep `EQ_OPS` because a `_primary_` multi-seek would break the
isolation layer's merge, which this ticket makes false (that merge bug was fixed as
`bug-isolation-multiseek-merge-order`, and `scanMultiSeekPrimary` emits ascending by
encoded key specifically to satisfy it).

Consequence worth stating in the commit: a **single-element** literal `pk in (20)` now
also takes the PK arm, as an ordinary `plan=2` point seek (`isMultiValueEquality` is
false for it). That matches what the secondary-index arm already does and what
`rule-select-access-path`'s `findPrefixEq` already accepts.

### No collation gate is needed — and that is not an oversight

The secondary-index arm gates on `indexPrefixSeekIsCollationExact`. The PK arm needs no
equivalent, for two independent reasons; **write this down at the arm**, because its
absence otherwise reads as a missing check:

- `reconcilePkCollations` (store-module-schema-rewrite.ts) rewrites an undecorated text
  PK column's declared collation to the table key collation K at CREATE time, so for
  every PK member the key collation, the declared collation, and the collation
  `matchesFilters` re-compares under are the same name. The divergent shape the
  secondary arm declines (a collation-blind `json`/temporal column under an index column
  carrying an explicit non-BINARY `COLLATE`) cannot occur on a PK: column DDL type-gates
  that `COLLATE` out, and those types are declined by the semantic-ordering gate anyway.
- `scanMultiSeekPrimary` re-applies `matchesFilters` per resolved row, so even a
  hypothetical coarser window over-fetches and is trimmed rather than under-fetching.

The multi-seek is exactly the existing point arm run N times, so its collation exposure
is the point arm's, unchanged.

### Gates

- `seekKeyCount > MAX_MULTI_SEEK_KEYS` (1000) → decline.
- `hasSemanticOrdering(tableInfo.columns[colIdx]?.logicalType)` on ANY PK member →
  decline. Mirrors `StoreTableScan.pkHasSemanticOrderingMember`, which
  `scanMultiSeekPrimary` throws `multiSeekMalformed` on. Those throws stay as the
  assertion that the plan never produced one.
- `scanMultiSeekPrimary` also throws when `seekWidth` does not cover the whole primary
  key, so the plan's `seekColumns` must be **every** PK column in
  `primaryKeyDefinition` order.

### Cost

```ts
// The PK is unique, so each seek key matches at most one row — no `multiRows` clamp
// artifact, and no ROW_RESOLUTION_COST: the point read IS the row read, with no
// index-entry → row indirection to charge for.
const rows = Math.max(1, Math.min(estimatedRows, seekKeyCount));
AccessPlanBuilder.eqMatch(rows, seekKeyCount * INDEX_SEEK_COST)
    .setIsSet(false)                       // eqMatch defaults isSet to `rows <= 1`
    .setIndexName('_primary_')
    .setSeekColumns(pkColumns)
    .setHandledFilters(claimFirstPerRole(request.filters, equalityRoles(pkColumns)))
    .setExplanation(`Store primary key multi-seek(${seekKeyCount})`)
```

`Math.max(1, …)` is **load-bearing, not defensive**: `rows: 0` on a plan that claims
every filter makes `rule-select-access-path` replace the whole table access with an
`EmptyResultNode` (its "module proved the predicate unsatisfiable" fold). An empty-at-
plan-time table would then return nothing for rows written by the same statement.

`setIsSet(false)` is likewise load-bearing — `AccessPlanBuilder.eqMatch` sets
`isSet = rows <= 1`, which a one-key runtime set would satisfy.

The arm returns immediately from the PK branch, so it never reaches the
seek-versus-scan comparison lower down — the same exemption the secondary multi-seek
arm gets explicitly, for the same reason (`rule-key-set-seek` reads this cost as a
straight line at 2 and 1000 keys and abandons its rewrite if a probe stops naming an
index). Note that in the comment so a later reader does not "fix" it by adding the
comparison.

Worked break-even, to sanity-check the numbers against `rule-key-set-seek`'s
interpolation (`slope = (cost@1000 − cost@2) / 998`, `breakEven = floor(2 + (baseline −
cost@2)/slope)`), on a single-column-PK table:

| table rows | cost @2 keys | cost @1000 keys | scan baseline | breakEven |
|-----------:|-------------:|----------------:|--------------:|----------:|
| 1000       | 1.6          | 800             | 1000          | 1000 (clamped) |
| 4          | 1.6          | 501.2           | 4             | 6         |

So a 3-key set against a 4-row table still seeks — which the follow-up ticket's
isolation tests depend on.

### Ordering advertisement

`scanMultiSeekPrimary` sorts its points ascending by encoded data key, which IS
primary-key order (per-column DESC inversion is baked into the bytes). Run the plan
through `buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix)`,
the same gate every other primary-key arm uses, so `… where pk in (…) order by pk`
elides its `Sort`.

Assert both the elision and the row order in a test — this is the one claim here that
can produce wrong-order rows if it is wrong.

## TODO

- Hoist the `pkOrderPreservingPrefixLength` call above the PK arms in
  `computeBestAccessPlan`.
- Replace `pinnedPkColumns` with the per-PK-column pin helper above; split the branch on
  `isMultiSeek`.
- Add the multi-seek arm: gates, cost, `isSet: false`, full-PK seek columns, positional
  filter claiming, `_primary_` index name, ordering advertisement.
- Delete `EQ_OPS`, drop `equalityRoles`' `ops` parameter, rewrite the `EQ_OR_IN_OPS`
  doc comment.
- Update `scanMultiSeekPrimary`'s doc comment: the stale ticket path
  (`tickets/backlog/feat-store-pk-in-list-multiseek`) and the "NOT reachable from this
  module's own plans today" sentence, which this ticket makes false.
- Update the same stale claim in the `primary-key multi-seek (scanMultiSeekPrimary)`
  describe block of `packages/quereus-store/test/index-scan-batching.spec.ts` (~line
  309). The test drives the protected method directly and still passes; only the comment
  is wrong.
- Invert `runtime-key-set-plan.spec.ts`'s `declines a runtime set on the primary key
  (the PK arm takes '=' only)` (~line 284) — it must now assert the claim, and keep
  asserting that the runtime-set and literal-IN forms plan identically.
- Add literal-list cases to `pushdown.spec.ts`, alongside the existing
  `IN-list multi-seek (feat-store-in-list-index-pushdown)` block, using its
  `planOps` / `planDetails` / `CountingKVStore` helpers:
  - single-column PK: basic list, duplicates collapse to one row each, NULL member
    dropped, empty/all-NULL list yields zero rows **without a scan**, no-match list.
  - composite PK `(a, b)`: `a in (…) and b in (…)` cross-product; a PARTIAL pin
    (`a in (…)` only) keeps today's behavior.
  - over-cap list (1001 keys) declines and stays correct; exactly 1000 still seeks.
  - a `timespan` PK declines (semantic-ordering gate) and stays correct.
  - `order by pk` elides its `Sort` and rows come back in PK order — assert order
    without a JS re-sort. Cover a `primary key (pk desc)` table too.
  - narrowing proof on the counting data store: `iterateEntryCount === 0`, and the
    point keys resolve in one `getMany` round trip.
  - a memory-module oracle comparison, mirroring `IN-list results match the
    memory-module oracle`.
- Run `yarn build`, then `yarn test` and `yarn test:store`.
