----
description: Let each storage backend declare how expensive its random row reads and index seeks really are, so the query planner stops pricing a browser-database lookup as if it were as cheap as a disk-backed one.
files:
  - packages/quereus-store/src/common/cost-profile.ts (NEW — the profile type, parity defaults, resolver)
  - packages/quereus-store/src/common/kv-store.ts (`KVStoreProvider` — optional `costProfile` declaration)
  - packages/quereus-store/src/common/index.ts (export the new type + helpers)
  - packages/quereus-store/src/common/store-module-base.ts (resolve + cache the profile in the ctor, next to `atomicProvider`)
  - packages/quereus-store/src/common/store-module.ts (`getBestAccessPlan` — pass the profile through)
  - packages/quereus-store/src/common/store-module-access-plan.ts (ROW_RESOLUTION_COST / INDEX_SEEK_COST become profile-derived; the seek-vs-scan veto stays parity-priced)
  - packages/quereus-plugin-indexeddb/src/provider.ts (declares the measured profile)
  - packages/quereus-store/test/cost-profile.spec.ts (NEW)
  - packages/quereus-store/test/key-set-seek-store.spec.ts (regression fingerprint — 16 tests)
  - packages/quereus-store/test/pushdown.spec.ts (parity regression fingerprint)
  - packages/quereus-plugin-indexeddb/bench/README.md (the measurements the declared numbers come from)
  - packages/quereus-store/README.md (docs — the access-planning section)
difficulty: medium
----

# Problem

The store module prices every backend the same. Two constants in
`store-module-access-plan.ts` carry the whole assumption:

- `ROW_RESOLUTION_COST = 1.0` — "resolving one secondary-index entry to its row costs about
  what one sequentially scanned row costs."
- `INDEX_SEEK_COST = 0.5` — "positioning one seek key costs half a sequentially scanned row."

Both are true enough for LevelDB (block cache, in-process reads) and false for IndexedDB,
where every point read is a separate request across a browser IPC boundary. The measured
consequence, from the prereq benchmark (`packages/quereus-plugin-indexeddb/bench/README.md`,
Chromium 151, 2026-08-14): a full scan reads a row in 0.0047 ms at 20k rows and ~0.011 ms at
100k, while the index path resolves a matched row in 0.0169–0.0175 ms (20k) and
0.0406–0.0465 ms (100k) — a 3.6×–4.2× ratio end to end, where the model says 1.3×.

The store framework already has the idiom for per-backend variation: things a provider
declares about itself (`beginAtomicBatch`, `readCommittedSnapshot`, `concurrencyMode`). Cost
belongs on that list.

# What to build

## The declaration

New file `packages/quereus-store/src/common/cost-profile.ts`:

```ts
/**
 * What one storage backend's basic operations cost, RELATIVE to reading one row
 * sequentially during a full scan (which is 1.0 by definition — the unit
 * `AccessPlanBuilder.fullScan` charges per row).
 *
 * Every field is optional; an omitted field takes the parity default, which
 * reproduces the module's pre-profile constants exactly. A provider that
 * declares nothing plans byte-identically to before.
 */
export interface KVCostProfile {
	/**
	 * Resolving ONE secondary-index entry to the row it names — a random point read
	 * of the data store, batched through `getMany`. Default 1.0.
	 */
	readonly pointRead?: number;

	/**
	 * The per-seek-key cost of a multi-seek: positioning one index window AND
	 * reading the row(s) it names. It is a WHOLE-key cost, not just the
	 * positioning half, because the multi-seek arms deliberately charge no
	 * separate per-row resolution (see the arm comments). Default 0.5.
	 */
	readonly seekPositioning?: number;
}

export type ResolvedCostProfile = Required<KVCostProfile>;

/** Today's constants, and the default for any backend that declares nothing. */
export const PARITY_COST_PROFILE: ResolvedCostProfile = { pointRead: 1.0, seekPositioning: 0.5 };

/** Fill in defaults; replace any non-finite or non-positive field with its parity value and log. */
export function resolveCostProfile(profile: KVCostProfile | undefined): ResolvedCostProfile;
```

Declared on the PROVIDER, not the store — profiles are per-backend, one provider is the
per-backend singleton, and `StoreModuleBase` already holds it without opening anything:

```ts
export interface KVStoreProvider {
	/** How expensive this backend's basic operations are; omitted = parity defaults. */
	readonly costProfile?: KVCostProfile;
	// … existing members
}
```

`StoreModuleBase` resolves it once in the constructor and keeps it in a `protected readonly
costProfile: ResolvedCostProfile` — the same treatment `atomicProvider` gets, and for the same
reason (fixed for the provider's lifetime). `StoreModule.getBestAccessPlan` passes it as a new
fifth parameter of `computeBestAccessPlan`.

## The consumer

In `store-module-access-plan.ts`:

- `ROW_RESOLUTION_COST` and `INDEX_SEEK_COST` stop being module constants. The single-window
  seek arms (`eq`, `prefixRange`, `range`) charge `rows * profile.pointRead`; both multi-seek
  arms (secondary in `tryIndexAccessPlan`, primary in `primaryKeyMultiSeekPlan`) charge
  `seekKeyCount * profile.seekPositioning`.
- **The seek-vs-scan veto keeps pricing resolution at the parity 1.0.** `IndexPlanCandidate`
  gains a `vetoCost` — the arm's cost recomputed with `PARITY_COST_PROFILE.pointRead` — and the
  `bestSeekPlan.plan.cost <= scanPlan.cost` comparison uses it instead. Ranking between index
  arms keeps using the declared (truthful) cost, and the returned plan's advertised `cost` is
  the declared one. See *Decision 3* below for why, in a comment at the site.
- The existing long comments at `ROW_RESOLUTION_COST` / `ARM_SELECTIVITY` / both multi-seek
  arms stay and get updated for the profile — they are the reasoning this ticket is built on,
  not stale text to delete.

## IndexedDB's declaration

`IndexedDBProvider` declares `readonly costProfile = { pointRead: 3.0, seekPositioning: 5.0 }`
with a comment citing the bench file and the derivation below. LevelDB, the React Native
LevelDB, the NativeScript SQLite provider and `InMemoryKVStore`-based test providers declare
**nothing** — parity, unchanged behavior, no unmeasured guesses.

# Decisions already settled (do not re-litigate; record them in comments)

## Decision 1 — the declared IndexedDB numbers, and how they were derived

All from `packages/quereus-plugin-indexeddb/bench/README.md`, Chromium 151 / Windows 11,
200-byte rows, page size 256, medians. Units: one sequentially scanned row = 1.

*Point read.* Arm A (today's two-store path) per matched row, minus the index-entry paging it
also pays, over arm C's per-scanned-row cost. Index entries are read sequentially and page
256-at-a-time; the bench's closest measurement of an entry read is arm B2 at 0.8× a data row,
so entry paging is charged at 0.8:

| size / clustering | arm A per row | entry paging | resolution | ÷ scan row | ratio |
|---|---|---|---|---|---|
| 20k, 25% sel, either | 0.0169–0.0175 ms | 0.8 × 0.0047 | ~0.0131 ms | 0.0047 | **2.8** |
| 100k, 25%, clustered | 0.0406 ms | 0.8 × 0.011 | ~0.0318 ms | 0.011 | **2.9** |
| 100k, 25%, uniform | 0.0465 ms | 0.8 × 0.011 | ~0.0376 ms | 0.011 | **3.4** |

Band 2.8–3.4 ⇒ **declare 3.0**. The subtraction is an estimate, not a measurement: the bench
never timed two-store index paging alone. State that in the comment.

*Seek positioning.* One multi-seek key costs an index window request PLUS a row read, neither
amortized across a page: ≈ 2 × the point-read cost above ⇒ 0.026 ms at 20k (5.5 scan-rows) and
~0.062 ms at 100k (5.7). **Declare 5.0** — rounded slightly down, so a borderline key-set seek
keeps firing rather than being priced out on a rounding decision.

These are request-latency dominated. A slower device scales both numbers together, which is
why the profile is expressed as a ratio and not in milliseconds.

## Decision 2 — two knobs, not three; no `entryRead`

The plan spec floated a third knob for index-entry reads. Excluded, deliberately:

- The per-row entry term is the ENGINE's — `AccessPlanBuilder.eqMatch` charges `rows * 0.3`,
  `rangeScan` charges `rows * 0.5`, both internal to the builder and shared with the memory
  module. Scaling it from a store profile means either restating the builder's formula in the
  store (exactly the drift `addCost`'s doc comment exists to prevent) or growing a new builder
  surface — for a term the bench puts at 0.8× a data row, i.e. within noise of parity.
- Leave a `NOTE:` tripwire at the profile type: *if a backend ever shows index-entry reads
  pricing very differently from data rows, add `entryRead` and give `AccessPlanBuilder` a
  per-row-entry hook rather than restating its formula here.*

## Decision 3 — the veto stays parity-priced (the plan ticket's open question)

The plan ticket flagged that raising resolution cost is arm-DISABLING, not arm-tuning: with
`ARM_SELECTIVITY` a fixed fraction of the table, the `range` arm flips to "scan wins" at
`pointRead > 2.83`, `prefixRange` at `> 6.17`, `eq` at `> 9.7` — for every query, on every
table. IndexedDB's measured band (2.8–3.4) straddles the range arm's flip point exactly.

Settled: **apply the profile to advertised cost and to ranking between index arms; keep the
seek-vs-scan veto at parity until `store-column-statistics` lands.** Reasoning, to be recorded
at the site:

- The flip is a knife edge, and it sits on the *guess*, not the measurement. At the modelled
  30% selectivity the bench says seek and scan are within ~10% of each other (87.5 ms vs
  92.6 ms at 20k/25%) — the measurement cannot resolve which side of the line the arm belongs
  on.
- The error is wildly asymmetric. Disabling the arm costs up to 25× when the real predicate
  is selective (a range matching 1% of 20k rows: 3.8 ms seeked vs 95 ms scanned). Keeping it
  costs ~10% in the case the guess describes.
- Deriving a wholesale, every-query arm shutdown from a knife-edge measurement of a number
  the model only guesses at is not a defensible trade at this stage. `store-column-statistics`
  (plan/, sequenced immediately after) replaces the guess with a real estimate and deletes this
  clamp; that ticket has been updated to say so.

Consequence to state plainly in the ticket's own comment and in the docs: **on this pass the
`pointRead` knob changes advertised costs and cross-index ranking, not which plan is chosen.**
The live lever is `seekPositioning`, which is what actually moves the engine's key-set-seek
break-even — see Decision 4.

## Decision 4 — what `seekPositioning` does to `rule-key-set-seek`, and why it is safe

The engine probes the module at 2 and 1000 keys, fits a line, and solves for the key count at
which a seek overtakes the displaced plan (`interpolateBreakEven`). With the store's multi-seek
cost `k·S + 0.3·min(N, k·0.1N)` against a scan baseline of `N`, the break-even lands at
roughly `N/(2S)`:

| profile | break-even key count | comment |
|---|---|---|
| parity (S = 0.5) | ≈ 2N | effectively "always seek", i.e. today |
| IndexedDB (S = 5) | ≈ N/5 — 18 keys at N=100, 186 at N=1000, ceiling-capped above N≈5000 | matches the physics: seeking k keys costs 5k, scanning costs N |

That IS the fix for the motivating production complaint (a join-shaped query where a hand-rolled
full-scan workaround beat the "optimized" plan 337 ms vs 981 ms).

The one behavior change worth naming: on an IndexedDB-profiled store with **fewer than ~10
rows**, the two-key probe already costs more than the scan baseline, `interpolateBreakEven`
returns 0, and `rule-key-set-seek` declines the rewrite entirely. Right answer, right cost —
but it must be a TESTED, deliberate outcome, not a surprise. The 16 `key-set-seek-store.spec.ts`
tests run on parity providers and must stay green untouched.

## Decision 5 — the primary-key multi-seek is slightly over-charged, and that is accepted

`seekPositioning` also prices `primaryKeyMultiSeekPlan`, where a seek key costs one point read
and no index indirection (≈ 3 units on IndexedDB, charged 5). Splitting the knob in two to
model that would double the tuning surface for a bias that only ever makes a very large
`where pk in (…)` prefer a scan slightly sooner than it should. Accepted; record it as a
`NOTE:` at that arm.

# TODO

## Phase 1 — the surface

- Add `packages/quereus-store/src/common/cost-profile.ts`: `KVCostProfile`,
  `ResolvedCostProfile`, `PARITY_COST_PROFILE`, `resolveCostProfile`. Reject non-finite and
  non-positive fields per-field (fall back to that field's parity value) and log a warning via
  `createLogger` — a third-party provider's bad declaration must not break planning, and must
  not pass silently either.
- Add the optional `costProfile` member to `KVStoreProvider` in `kv-store.ts`, with the
  `entryRead` tripwire `NOTE:` on the type.
- Export the type and helpers from `packages/quereus-store/src/common/index.ts`.

## Phase 2 — thread it through

- `StoreModuleBase`: resolve once in the constructor into `protected readonly costProfile`,
  beside `atomicProvider`, with the "fixed for the provider's lifetime" reasoning.
- `StoreModule.getBestAccessPlan`: pass it to `computeBestAccessPlan` as a new parameter.
- `store-module-access-plan.ts`: delete the two module constants, take the profile as a
  parameter, apply it at the four sites (three single-window arms via `seekingArm`, the
  secondary multi-seek, the primary multi-seek). Move the surviving reasoning from the deleted
  constants' doc comments onto the profile fields and the arms.
- Add `vetoCost` to `IndexPlanCandidate` and use it in the seek-vs-scan comparison, with
  Decision 3 stated at the site (and a pointer that `store-column-statistics` removes it).

## Phase 3 — declare IndexedDB

- `IndexedDBProvider.costProfile = { pointRead: 3.0, seekPositioning: 5.0 }`, with the
  derivation table from Decision 1 in the comment and a pointer to `bench/README.md`.
- `NOTE:` tripwire at that declaration: the provider wraps every store in `CachedKVStore` by
  default, and the bench measured raw IndexedDB. A warm LRU cache makes point reads much
  cheaper than 3.0; the profile is a static cold-path declaration and cannot express that. If
  cache-hit rates ever become measurable at plan time, revisit.
- Leave LevelDB / React Native LevelDB / NativeScript SQLite / in-memory undeclared. A short
  comment in `packages/quereus-plugin-leveldb/src/provider.ts` saying parity is a deliberate,
  unmeasured default and naming the backlog ticket that would measure it.

## Phase 4 — tests

New `packages/quereus-store/test/cost-profile.spec.ts` (the existing `pushdown.spec.ts` shows
the hand-rolled `KVStoreProvider` test-double pattern to copy):

- **Parity is byte-identical.** For a fixture with a PK, a single-column index and a composite
  index, plan the same set of queries against (a) a provider declaring nothing, (b) one
  declaring `{ pointRead: 1.0, seekPositioning: 0.5 }`. Assert full equality of `cost`, `rows`,
  `indexName`, `seekColumnIndexes`, `handledFilters`, `explains` for every case.
- **`pointRead` scales the single-window arms.** `eq` arm cost = `0.3 + rows * (0.3 + pointRead)`,
  `range` = `0.2 + rows * (0.5 + pointRead)`, `prefixRange` likewise — checked at two declared
  values.
- **`seekPositioning` scales both multi-seek arms.** Secondary: `k*S + 0.3*multiRows`. Primary
  (`where pk in (…)`): `k*S + 0.3*rows`.
- **The veto is profile-independent (pins Decision 3).** With `pointRead: 50` — far past every
  arm's flip point — the chosen plan is still the index seek: same `indexName`,
  `seekColumnIndexes`, `handledFilters`; only `cost` differs from parity. A comment naming
  Decision 3, so a future reader changing the policy knows this test encodes it.
- **Malformed declarations.** `{ pointRead: -1 }`, `{ pointRead: NaN }`, `{ seekPositioning: 0 }`
  each fall back to that field's parity value and leave the other field's declared value intact.
- **Row sets are identical under every profile.** Run the same queries end-to-end under parity
  and an IndexedDB-like profile and assert equal result rows — a cost profile must never change
  an answer.

In `key-set-seek-store.spec.ts` (or a sibling, if that file's fixtures do not take a custom
provider):

- All 16 existing tests green, unmodified, on their parity providers.
- New: on an IndexedDB-profiled store with ~200 rows, the key-set rewrite still fires (assert
  on `explains` / the plan tree, as that spec already does).
- New: on an IndexedDB-profiled store with ~5 rows, the rewrite declines — and the query
  returns the same rows as under parity. Pins Decision 4's small-table outcome as deliberate.

Run: `yarn build`, `yarn test 2>&1 | tee /tmp/test.log`,
`yarn workspace @quereus/plugin-indexeddb test`, `yarn lint`, `yarn typecheck`.
`yarn test:store` (LevelDB) is a nice-to-have here — LevelDB stays undeclared so its plans are
unchanged by construction; run it streamed if it fits the window, otherwise say so in the
handoff.

## Phase 5 — docs

- `packages/quereus-store/README.md`, the access-planning section: extend the "A seek priced
  above a full scan is dropped" paragraph with a short **Backend cost profile** subsection —
  the two knobs, their unit (sequential row = 1), the parity defaults, IndexedDB's declared
  values, and the plain statement that the seek-vs-scan veto is deliberately still priced at
  parity while selectivity is a fixed guess.
- `packages/quereus-plugin-indexeddb/README.md`: one paragraph — this backend declares itself
  expensive for random reads, what that changes (key-set seeks stop firing on small tables),
  and the pointer to `bench/README.md`.

# Edge cases & interactions

- **Undeclared profile ⇒ zero drift.** The whole existing pushdown / multi-seek / key-set
  regression surface runs on `InMemoryKVStore`-backed providers that declare nothing. Any
  diff there is a bug in this ticket, not a re-baseline. Do not update an expected cost to
  make a test pass.
- **A profile must never change a row set.** Every arm the veto drops keeps its filters
  unclaimed, so the residual `Filter` survives and the answer is identical. The end-to-end
  equal-rows test above is the guard.
- **`rule-key-set-seek`'s three probes.** They synthesize runtime-set filters, so they land on
  the multi-seek arms, which are exempt from the veto and stay linear in key count under any
  constant `seekPositioning`. Two things must hold and should be checked by hand while
  implementing: the probe answers still NAME an index (a probe answered with no index name is
  read as "module declined" and kills the rewrite), and the cost stays a straight line in `k`.
- **A vetoed single-window arm can still shadow a multi-seek.** `computeBestAccessPlan` picks
  the cheapest seek candidate first and only then applies the veto; if the winner is a vetoed
  single-window arm, the multi-seek candidate is discarded with it and the module answers with
  a scan. Pre-existing (there is a `NOTE:` about it at the comparison), and raising `pointRead`
  makes single-window arms *less* likely to win the ranking, so this ticket narrows the hole
  rather than widening it. Do not fix it here; do not make it worse.
- **The advertised cost feeds the engine, not just this module.** A store index seek on
  IndexedDB now advertises ~3× its old cost, which reaches join ordering, cache decisions, and
  `rule-key-set-seek`'s `baselineCost` for a seek leaf (a higher baseline means MORE key-set
  rewrites, partly offsetting the higher seek curve). Intended — the number is truer — but
  check `runtime-key-set-plan.spec.ts` and `index-scan-batching.spec.ts` for plan-shape
  assertions that move.
- **Wrapper stores.** `CachedKVStore` wraps a store, not a provider, so it cannot shadow the
  declaration; `IsolatedStoreModule` constructs a `StoreModule` with the same provider, so the
  profile flows through unchanged. Nothing to forward — but if a wrapper *provider* is ever
  added it must forward `costProfile`, and the resolver's default must not silently hide that.
- **Zero and one-row tables.** `Math.max(1, …)` clamps on `rows` are load-bearing (an
  `EmptyResultNode` fold hangs off `rows: 0`); scaling costs must not touch them. A profile
  changes cost only, never `rows`.
- **`MAX_MULTI_SEEK_KEYS` and the collation / semantic-ordering gates** are soundness gates and
  are cost-independent. No profile value may reach them.
- **Third-party providers.** `costProfile` is optional on a public interface, so every existing
  implementation compiles untouched — verify the four in-repo providers and the two test
  doubles need no edit beyond the IndexedDB declaration.

# Key numbers to re-derive if a comment is edited

With `R` = `pointRead` and `S` = `seekPositioning` (sequential row = 1):

- `eq` arm: `0.3 + 0.1N·(0.3 + R)`; beats a scan while `R < 9.7`
- `prefixRange`: `0.2 + 0.15N·(0.5 + R)`; `R < 6.17`
- `range`: `0.2 + 0.3N·(0.5 + R)`; `R < 2.83`
- secondary multi-seek: `k·S + 0.3·min(N, k·0.1N)` — exempt from the veto
- primary multi-seek: `k·S + 0.3·max(1, min(N, k))`
- full scan: `N`
- key-set-seek break-even ≈ `N/(2S)`
