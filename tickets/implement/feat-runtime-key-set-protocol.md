---
description: Teach storage backends to answer "I will give you a list of key values, but not until the query actually runs" — so a later change can hand them a list built from a subquery instead of one typed into the SQL text.
files:
  - packages/quereus/src/vtab/best-access-plan.ts               # PredicateConstraint + validateAccessPlan
  - packages/quereus/src/vtab/memory/module.ts                  # findEqualityMatches + the two ordering gates
  - packages/quereus-store/src/common/store-module.ts           # equalitySeekCardinality, claimFirstPerRole, tryIndexAccessPlan
  - packages/quereus/test/vtab/access-path.spec.ts              # existing access-plan unit tests
  - docs/module-authoring.md                                    # § 2. Index-Based Access (Standard)
difficulty: medium
---

# Plan-time protocol: an `IN` constraint whose values arrive at execution time

## Why

`where col in (1, 2, 3)` already becomes an index multi-seek: the planner knows the three
values, so `getBestAccessPlan` sees an `IN` filter carrying `value: [1,2,3]`, the module
claims it, and `rule-select-access-path` emits a `plan=5` multi-seek `FilterInfo` with
three seek keys.

`where col in (select … )` cannot do that, because the values only exist once the query
runs. This ticket adds the one plan-time fact a module needs in order to say *"yes, I could
seek that column, and here is the index and the cost"* **without being told the values** —
and pins down exactly what it will receive at execution time in exchange.

This ticket changes **no runtime code and no `FilterInfo`**. It is the protocol half only;
`feat-key-set-semi-join` builds the engine side that uses it.

## The contract

Add to the vtab-level `PredicateConstraint` (`packages/quereus/src/vtab/best-access-plan.ts`):

```ts
/**
 * Describes an `IN` constraint whose member values are produced at execution time
 * (typically from a subquery). Present ⇒ `value` is absent.
 */
export interface RuntimeSetSpec {
	/**
	 * Hard ceiling on the number of seek keys the engine will deliver at query() time.
	 * The engine enforces it: a larger set never reaches the module — the engine falls
	 * back to a full scan on its own.
	 */
	readonly maxCount: number;
	/** Planner's estimate of the actual count, when it has one. Advisory. */
	readonly estimatedCount?: number;
}

export interface PredicateConstraint {
	// … existing fields …
	/** Set only when `op === 'IN'` and the members are not known at plan time. */
	readonly runtimeSet?: RuntimeSetSpec;
}
```

**What a module must understand.** A filter with `op: 'IN'` and `runtimeSet` set means:
"treat this as an `IN` over `columnIndex` with between 1 and `maxCount` values; I cannot
tell you which."

**What a module promises by accepting** (`handledFilters[i] = true`, plus `indexName` and
`seekColumnIndexes`): it can serve that column as a multi-seek on the named index.

**What the engine promises in return** — and this is the part that keeps the module's
runtime untouched: at `query()` time the module receives a **`plan=5` multi-seek
`FilterInfo` that is byte-for-byte the same shape a literal `IN` list produces today** —
`idx=<name>(0);plan=5;inCount=K` with `K` EQ constraints on the seek column and `K` values
in `args`, `1 ≤ K ≤ maxCount`. There is no new runtime field, no new plan code, and no way
for a module to tell a runtime-derived set from a hand-written list. If the actual set is
empty or larger than `maxCount`, the module is never asked to seek it at all.

**Declining** is always safe: leave `handledFilters[i] = false`. The engine keeps its
existing semi-join plan and nothing is lost but the speed-up.

Only single-column runtime sets exist today (an `IN` subquery yields one column), so a
module may assume `seekColumnIndexes.length === 1` when it accepts one. It must still
decline any constraint it cannot serve.

## Shared helpers (DRY — three call sites already duplicate this test)

Both modules currently spell "is this `IN` usable as an equality role, and how many seeks
is it worth" inline, with `Array.isArray(f.value) && f.value.length > 0`. Adding
`runtimeSet` would fork that test five ways. Export from `best-access-plan.ts` instead:

```ts
/**
 * Number of seek keys an equality-role filter contributes at plan time:
 *   1                        for `=`
 *   value.length             for a well-formed literal `IN` (elements may be undefined —
 *                            only the LENGTH is meaningful at plan time)
 *   runtimeSet.maxCount      for a runtime-set `IN`
 *   null                     when the filter cannot fill an equality role
 */
export function equalitySeekKeyCount(f: PredicateConstraint): number | null;

/** True when the filter seeks more than one key — i.e. it walks the index out of order. */
export function isMultiValueEquality(f: PredicateConstraint): boolean;
```

`packages/quereus-store/src/common/store-module.ts` already has a private
`equalitySeekCardinality` with exactly the first three lines of that behaviour — delete it
and import the shared one. Its doc comment ("Mirrors the exact predicate
`rule-select-access-path`'s `eqBySeekCol` uses") moves to the shared function and must stay
true: the rule's `eqBySeekCol` pick and this helper are one decision in two places.

## Call sites to convert

**`packages/quereus-store/src/common/store-module.ts`**
- `equalitySeekCardinality` (line ~208) → replaced by the shared helper.
- `claimFirstPerRole` (line ~248): the `f.op !== 'IN' || equalitySeekCardinality(f) !== null`
  well-formedness test.
- `tryIndexAccessPlan` (line ~3062): `eqFilter` lookup and the `inCount` product.
- The existing gates then apply unchanged and are exactly right for a runtime set:
  - `inCount > MAX_MULTI_SEEK_KEYS` (1000) → cost-only decline. With `maxCount` at the
    engine's ceiling this is the store's own ceiling check; the two happen to be equal
    today, which is fine — if the engine ever raises its ceiling the store declines and
    the feature quietly switches off rather than breaking.
  - semantic-ordering seek column (`TIMESPAN` / `JSON`) → cost-only decline. Correct: the
    byte-equality windows would under-fetch and the multi-seek carries no residual.
  - the key-collation `eqSafeToHandle` gate → unchanged.
- `tryIndexAccessPlan` is only reached for **secondary** indexes; `computeBestAccessPlan`'s
  primary-key arm uses `EQ_OPS` (no `IN`). That stays true here: a runtime set on the PK
  declines, exactly as a literal `IN` on the PK does today. PK coverage arrives for free
  when `backlog/feat-store-pk-in-list-multiseek` and
  `backlog/bug-isolation-multiseek-merge-order` land — no change to this protocol is
  needed then.

**`packages/quereus/src/vtab/memory/module.ts`**
- `findEqualityMatches` (line ~596): the `IN` arm and its `inCardinality` product.
- Line ~63 — the single-value-`IN`-is-an-equality test. A runtime set is never
  single-valued at plan time (`maxCount ≥ 2` from the engine), so it must NOT match here.
- Line ~431 — the multi-value-`IN` bail-out.
- Lines ~713 and ~782 — `usesMultiInOnOrderedCol` / `breaksOrdering`. Both must treat a
  runtime set as multi-value, i.e. **ordering-breaking**. This is load-bearing: a
  multi-seek visits the index in seek-key order, not column order, so a plan that claimed
  `providesOrdering` over a runtime set would elide a `Sort` it needed.
- The memory module **implements** rather than declines. Declining would leave the whole
  feature untestable outside the store package (see the prior plan ticket's open question);
  implementing costs four call-site edits because the runtime already handles
  `inCount`/`seekWidth` generically in `vtab/memory/layer/scan-plan.ts`.

## Validation

Extend `validateAccessPlan` (or add a request-side validator called from the same place):

- `runtimeSet` present with `op !== 'IN'` → `StatusCode.FORMAT`.
- `runtimeSet` present **and** `value` present → `StatusCode.FORMAT`. The two are mutually
  exclusive; a module reading `value` on a runtime set would seek on garbage.
- `runtimeSet.maxCount < 1` or non-integer → `StatusCode.FORMAT`.

These fire on the request, so they catch an engine bug at the boundary rather than letting
a module improvise.

## Edge cases & interactions

- **A module that ignores `runtimeSet` entirely** (any third-party module today) sees
  `op: 'IN'` with `value === undefined`. Every existing well-formedness test is
  `Array.isArray(f.value) && length > 0`, which is false — so it declines. Verify this by
  test with a stub module that has *not* been updated: it must return
  `handledFilters: [false]` and the request must not throw.
- **Both a runtime set and a literal `IN` on the same column.** `claimFirstPerRole` /
  `eqBySeekCol` claim the FIRST role-filling filter in `request.filters` order. The engine
  side never builds such a request in `feat-key-set-semi-join` (it probes with exactly one
  filter), but the protocol must not become order-dependent by accident — assert the
  first-wins behaviour with a two-filter request so a later widening cannot silently
  change which one is seeked.
- **Composite index, runtime set on the leading column only.** `tryIndexAccessPlan`'s
  prefix loop breaks at the first column with no equality filter, so it claims a
  single-column prefix of a multi-column index. That is a legal `seekColumnIndexes` of
  length 1 and the store's `scanMultiSeek` handles `seekWidth=1` against a wider index
  (`seekWidth > indexCols.length` is the only rejection). Cover it.
- **`maxCount` exactly at `MAX_MULTI_SEEK_KEYS`** → accept. **One above** → cost-only
  decline with the filter unhandled. Both directions tested.
- **Semantic-ordering column** (`TIMESPAN`): decline in both modules, and assert the
  returned plan is cost-only (filter unhandled) rather than a seek with the filter claimed
   — claiming it would drop the residual and lose rows.
- **`estimatedCount` absent** must behave identically to `estimatedCount` present; it is
  advisory and neither module is required to read it.
- **Partial index** — `tryIndexAccessPlan` already returns null for `index.predicate`;
  confirm a runtime set does not sneak past that.

## Tests

Unit tests calling `getBestAccessPlan` directly (no SQL), in the style of
`packages/quereus/test/vtab/access-path.spec.ts`, for **both** modules:

- runtime set on an indexed column → accepted, `indexName` set,
  `seekColumnIndexes` equal to `[col]`, `handledFilters[0] === true`.
- runtime set on an unindexed column → declined (`handledFilters[0] === false`), plan is a
  scan.
- `maxCount` above / at the store's 1000 cap.
- semantic-ordering column → declined.
- collation mismatch that the store's `eqSafeToHandle` rejects → declined.
- memory module: a runtime set on a column that also carries `requiredOrdering` must NOT
  claim `providesOrdering`.
- an un-updated stub module declines without throwing.
- `validateAccessPlan` rejects each malformed shape above.

## Docs

`docs/module-authoring.md` § "2. Index-Based Access (Standard)": a subsection
**"Runtime-valued `IN` sets"** stating the contract verbatim — what `runtimeSet` means,
that `value` is absent, what accepting promises, that the delivered `FilterInfo` is an
ordinary `plan=5` multi-seek indistinguishable from a literal list, and that the engine —
not the module — enforces `maxCount` and falls back to a scan above it. Say plainly that
declining is always correct.

## TODO

- [ ] Add `RuntimeSetSpec` and `PredicateConstraint.runtimeSet` to `vtab/best-access-plan.ts`.
- [ ] Add exported `equalitySeekKeyCount` / `isMultiValueEquality`; delete the store's
      private `equalitySeekCardinality` and re-point its three call sites.
- [ ] Convert the memory module's four `IN` call sites, including both ordering gates.
- [ ] Add the three request-side validations.
- [ ] Unit tests for both modules plus the un-updated-stub case.
- [ ] `docs/module-authoring.md` § 2 subsection.
- [ ] `yarn lint`, `yarn build`, `yarn test` green. `yarn test:store` is worth one run here
      since the store module changed, even though no query shape produces a runtime set yet.
