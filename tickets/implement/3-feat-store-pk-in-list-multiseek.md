---
description: On the persistent storage backend, looking up a list of rows by their primary key reads the whole table instead of fetching just those rows. The planner arm that fixes this is now written; the test suite proving it is correct is not.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # DONE — the PK arms
  - packages/quereus-store/src/common/store-table-scan.ts           # DONE — doc comment only
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts        # DONE — plan-level cases
  - packages/quereus-store/test/index-scan-batching.spec.ts         # DONE — stale comment
  - packages/quereus-store/test/pushdown.spec.ts                    # TODO — literal-list coverage
difficulty: medium
---

# Store: plan a primary-key multi-seek for `pk in (…)` — remaining test coverage

**Partially implemented.** A prior run hit its token budget after landing the planner
arm and the plan-level tests, but before writing the end-to-end literal-list coverage
and before running the build/test suites. The design decisions are settled and recorded
in code comments — do **not** re-derive them. What follows is what landed, then what is
left.

## What already landed (verify, don't rewrite)

`packages/quereus-store/src/common/store-module-access-plan.ts`:

- `pkOrderPreservingPrefixLength(...)` hoisted above both primary-key arms.
- `pinnedPkColumns` (a Set of `'='` column indexes) replaced by `resolvePrimaryKeyPins`,
  which does a per-PK-column `find` over `equalitySeekKeyCount`, multiplies the counts
  into `seekKeyCount`, and ORs `isMultiValueEquality` into `isMultiSeek`.
- The full-PK-equality branch splits on `isMultiSeek`:
  - not multi-seek → the pre-existing point lookup, **plus a new `setSeekColumns(pkColumns)`**.
    That addition is load-bearing and is the one thing here that changes behaviour for
    plain `'='` predicates too: it routes the plan through `rule-select-access-path`'s
    index-aware arm instead of its legacy PK arm. Needed because the arm now also claims a
    single-element `IN`, which the legacy arm (`op === '='` only) would leave seeked
    nowhere. For a plain `'='` the two arms build an identical `_primary_` `plan=2` seek
    under an identical collation-cover lookup — but this is the change with the widest
    blast radius in the diff, so the full suites are what confirm it.
  - multi-seek → `primaryKeyMultiSeekPlan(...)`, a new function at the bottom of the file:
    gates on `MAX_MULTI_SEEK_KEYS` and on `hasSemanticOrdering` for any PK member (both
    return `null`, which **falls through** to the arms below rather than returning
    cost-only); costs as `eqMatch(max(1, min(estimatedRows, seekKeyCount)), seekKeyCount *
    INDEX_SEEK_COST)`; forces `setIsSet(false)`; names `_primary_`; sets every PK column as
    seek columns; claims positionally; and merges
    `buildPkOrderingAdvertisement(...)` into the result.
- `EQ_OPS` deleted; `equalityRoles` lost its `ops` parameter and now always uses
  `EQ_OR_IN_OPS`; the `EQ_OR_IN_OPS` doc comment rewritten.

`store-table-scan.ts`: `scanMultiSeekPrimary`'s doc comment no longer claims the branch is
unreachable from this module's plans.

`test/index-scan-batching.spec.ts` (~line 309): the same stale claim, corrected.

`test/runtime-key-set-plan.spec.ts`: the `declines a runtime set on the primary key` test
is inverted — it now asserts the `_primary_` claim, `isSet === false`, the
`primary key multi-seek(4)` explanation, and that the runtime-set and literal-IN forms
plan identically. Two sibling cases added (TIMESPAN PK declines; the cap is exclusive at
1000). The file header comment no longer says the PK arm refuses every IN.

`npx tsc -p tsconfig.json --noEmit` in `packages/quereus-store` passes. **Nothing else has
been run.**

## What is left

### Literal-list coverage in `packages/quereus-store/test/pushdown.spec.ts`

Add a block alongside the existing `IN-list multi-seek (feat-store-in-list-index-pushdown)`
describe, reusing its `planOps` / `planDetails` / `ids` helpers and the
`IN-list multi-seek narrowing (counting data store)` block's `CountingKVStore` setup:

- single-column PK: basic list; duplicates collapse to one row each; a NULL member is
  dropped; an empty/all-NULL list yields zero rows **without a scan**; a no-match list.
- composite PK `(a, b)`: `a in (…) and b in (…)` cross-product; a PARTIAL pin
  (`a in (…)` only) keeps today's behaviour.
- over-cap list (1001 keys) declines and stays correct; exactly 1000 still seeks.
- a `timespan` PK declines (semantic-ordering gate) and stays correct.
- `order by pk` elides its `Sort` and rows come back in PK order — assert the order
  **without** a JS re-sort. Cover a `primary key (pk desc)` table too. This is the one
  claim in the diff that can produce wrong-order rows if the ordering advertisement is
  wrong, so assert both the elision and the order.
- narrowing proof on the counting data store: `iterateEntryCount === 0`, and the point
  keys resolve in one `getMany` round trip.
- a memory-module oracle comparison, mirroring `IN-list results match the memory-module
  oracle`.

### Validation

- `yarn build`
- `yarn test`
- `yarn test:store`

Stream long output (`… 2>&1 | tee /tmp/foo.log; tail -n 80 /tmp/foo.log`) — never a silent
redirect.

Pay particular attention to failures that trace back to the `setSeekColumns` addition on
the point-lookup arm: any full-primary-key `'='` predicate against a store-backed table now
takes the index-aware path in `rule-select-access-path`. If something regresses there and
the cause is genuinely the routing rather than a test asserting the old plan shape, the
fallback is to set seek columns only when the branch claimed an `IN` — but prefer fixing
the real cause, because two shapes for one arm is how the plan and the scan drift apart.

## TODO

- Write the `pushdown.spec.ts` literal-list block described above.
- Run `yarn build`, then `yarn test` and `yarn test:store`; fix what the diff broke.
- Hand off to `review/` with an honest note on what the tests do and do not cover — in
  particular that isolation-wrapped read-your-own-writes over a `_primary_` multi-seek is
  deliberately out of scope here (it belongs to `feat-store-pk-key-set-seek-coverage`),
  even though the overlay path was reasoned about: `IsolatedTable.resolveScanIndex` maps a
  `role: 'primary'` access path to a PK-ordered merge, and the memory module's
  `scan-plan.ts` decodes a `_primary_` `plan=5` into `equalityKeys`, so the shape is
  believed to work and is simply untested here.
