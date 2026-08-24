---
description: A storage backend built on the shared key-value store framework can now tell the query planner how slow it is to answer its first row; no built-in backend claims to be slow, so nothing plans differently today.
files:
  - packages/quereus-store/src/common/kv-store.ts                    # KVStoreProvider.expectedLatencyMs — the new optional declaration
  - packages/quereus-store/src/common/cost-profile.ts                # resolveExpectedLatencyMs — validate-and-warn helper
  - packages/quereus-store/src/common/index.ts                       # exports resolveExpectedLatencyMs
  - packages/quereus-store/src/common/store-module-base.ts           # public readonly expectedLatencyMs, resolved in the constructor
  - packages/quereus-store/test/expected-latency-plan.spec.ts        # NEW — the whole-chain spec
  - packages/quereus-plugin-indexeddb/src/provider.ts                # NOTE: measured, deliberately undeclared
  - packages/quereus-plugin-leveldb/src/provider.ts                  # NOTE: unmeasured, deliberately undeclared
  - packages/quereus/src/planner/cost/index.ts                       # NOTE: the two consumers read the field on different scales
  - packages/quereus-store/README.md                                 # § Backend first-row latency
  - docs/module-capabilities.md                                      # expectedLatencyMs inventory row
  - docs/optimizer-costing.md                                        # § First-row latency in cost comparisons
difficulty: medium
---

# Review: provider-declared first-row latency for store-backed modules

## What shipped

The engine has one number a storage module uses to say "I am slow to answer":
`VirtualTableModule.expectedLatencyMs`, defined as **first-row latency** — how long an
iterator opened over one of the module's tables takes to hand back its first row. Before
this change `StoreModule` never declared it and `KVStoreProvider` had no field a backend
could declare it *through*, so a third-party provider over a network-reached key-value store
had no path to the planner at all. This adds that path, end to end, and nothing else.

The wiring copies `costProfile` beat for beat:

```
KVStoreProvider.expectedLatencyMs?      (public, optional, provider-declared)
      |
      v  resolveExpectedLatencyMs — once, in StoreModuleBase's constructor
StoreModuleBase.expectedLatencyMs       (PUBLIC readonly number, always concrete)
      |
      v  TableReferenceNode.computePhysical lifts it onto the leaf; propagates as max(children)
the planner's latency-gated rules and indexNestedLoopJoinCost
```

Two deliberate departures from the cost-field pattern, both documented at the code:

- **`0` is accepted as a valid declaration.** `resolveCostField` rejects `<= 0` because a
  zero cost is unusable; a zero *latency* is meaningful (in-process). The reject predicate is
  `!Number.isFinite(v) || v < 0`.
- **The resolved field is `public`, not `protected`.** It *is* the `VirtualTableModule`
  interface field the planner reads off the registered module. It resolves to a concrete `0`
  rather than `undefined` when nothing is declared — matching `IsolationModule`, for the same
  two reasons (`0` is observably identical to omitting the hint since the leaf only lifts
  values `> 0`, and a concrete number satisfies the optional property under
  `exactOptionalPropertyTypes`).

No downstream change was needed. `IsolationModule` already forwards
`this.underlying.expectedLatencyMs ?? 0` through a getter, so an isolation-wrapped store
module inherits the new value for free (`isolation-layer.spec.ts:4529-4541` already covers
that forwarding, and still passes).

**No in-tree backend declares a number.** That is the ticket's finding, not an omission —
see *Decisions recorded in the code* below.

## How to validate

```
yarn build && yarn typecheck && yarn lint
yarn test
yarn workspace @quereus/plugin-indexeddb test
yarn workspace @quereus/plugin-leveldb test
```

All green as handed off. `yarn test:store` was **not** run — it is the slow LevelDB-backed
re-run of the engine's logic tests, and this change adds no behavior on a provider that
declares nothing (which LevelDB's does not).

The new spec alone:

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/expected-latency-plan.spec.ts" --reporter spec
```

## Use cases the new spec pins

`packages/quereus-store/test/expected-latency-plan.spec.ts`, 6 tests in two groups.

**Resolution** — the module field:

- a provider declaring `30` yields `new StoreModule(provider).expectedLatencyMs === 30`;
- a provider with **no such property at all** (the shape a pre-change third-party provider
  has) yields `0`;
- a declared `0` is accepted (the `< 0` vs `<= 0` difference from cost fields);
- `-1`, `NaN` and `Infinity` each resolve to `0` and each emit exactly one `console.warn`
  naming `expectedLatencyMs` — asserted by swapping `console.warn`, the same technique
  `cost-profile.spec.ts` uses.

**Reaching the planner** — the part that matters, because a module field nothing reads is
not a feature. A four-row memory-module outer joined to a 200-row `StoreModule` inner:

- provider declaring 30 ms → the plan contains exactly one `FanOutLookupJoin` with
  `outerMode === 'batched'`, over one `EagerPrefetch`;
- **the same query, same fixture, provider declaring nothing → zero of each.** This negative
  arm is what makes the spec a regression guard rather than a snapshot: it fails if the
  wiring is removed *or* if the batched shape starts forming for unrelated reasons.

30 ms is frankly synthetic; it is above the 25 ms the latency gates all sit at, and nothing
about the test depends on any real backend's number. The fixture mirrors the engine's own
`packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts`, including that spec's
`batchedOuterMinRows: 0` — the 256-row cardinality gate is a separate gate and not what this
file tests.

Plan shape is read through the public `serializePlanTree` (JSON), because the node classes
themselves are engine-internal and not exported from `@quereus/quereus`, so the `instanceof`
assertions the engine's own spec uses are unavailable from this package.

## Decisions recorded in the code

The ticket's investigation concluded that **the honest number for IndexedDB does not do what
the original bug report assumed, and declaring it would move plans the wrong way.** Rather
than file that as more tickets, it is recorded at the sites:

- `packages/quereus-plugin-indexeddb/src/provider.ts` — a `NOTE:` beside its `costProfile`:
  no latency declared, and that is a *measured* decision. Measured band from bench arm B;
  two reasons (every gate that switches the latency machinery on is 25 ms and the real
  numbers clear none of them; the only shared formula the field reaches charges the **seek**
  plan, never the scan, which is backwards on a backend where the hash join's inner-side full
  scan is the catastrophic arm). Revisit condition: when
  `backlog/feat-per-row-latency-cost-for-remote-scans` lands a scan-side per-row latency,
  re-derive both together.
- `packages/quereus-plugin-leveldb/src/provider.ts` — appended to its existing
  "no costProfile, deliberately" comment: no latency either, and unlike the cost profile this
  one is **unmeasured** — nothing has ever timed LevelDB's first-row latency.
- `packages/quereus/src/planner/cost/index.ts` at `indexNestedLoopJoinCost` — a `NOTE:`
  recording that the field's two consumers read it on incompatible scales: the
  `*ThresholdMs` gates read wall-clock milliseconds, this formula reads engine cost units
  where 1.0 is one scanned row. They agree only where a scanned row costs about 1 ms — true
  of the 25-100 ms network backends the machinery was designed for, off by roughly two orders
  of magnitude for a sub-millisecond one. Inert while every gate sits at 25 ms and no
  sub-millisecond backend declares a value; the note says explicitly not to "fix" it by
  inflating a declaration, which would lie to the gates.

## Docs updated

- `packages/quereus-store/README.md` — new **Backend first-row latency** paragraph after the
  cost-profile section: what the knob means, that it is wall-clock and not a ratio (and why
  that makes declare-only-measured sharper), that `0` is valid here unlike a cost field, and
  that no in-tree provider declares one.
- `docs/module-capabilities.md` — the `expectedLatencyMs` inventory row read `0` under
  **store** and `via store` under **leveldb / indexeddb**, which overstated what existed
  (there was no provider surface at all). Now says provider-declared, defaulting to 0, and
  that neither plugin declares one.
- `docs/optimizer-costing.md` § *First-row latency in cost comparisons* — the sentence
  claiming "a network-backed module (a sync- or IndexedDB-backed one) would declare a real
  number" now says IndexedDB deliberately declines and why, plus a paragraph on the unit
  mismatch that mirrors the `indexNestedLoopJoinCost` note.

## Known gaps — treat these as the floor, not the finish line

- **The planner arm of the spec fires only one rule.** It proves a declared latency reaches
  `rule-join-physical-selection` / `toBatchedOuter`. The gather and prefetch-probe rules read
  the same propagated value and are *not* covered here; they were out of the ticket's scope,
  and nothing in-tree declares a latency that would reach them.
- **The spec lowers `batchedOuterMinRows` to 0.** That is the precedent's approach and keeps
  the test fast and about latency alone, but it means the spec does not prove the shape forms
  under the shipped 256-row default. The ticket suggested seeding a >256-row outer instead;
  that path was not taken and was not measured. A reviewer who wants the stronger claim would
  need to check the cost arithmetic still favors the batched fan-out at that scale — with a
  large outer the per-outer-row latency charge grows against the hash join, and it is not
  obvious without running it which way it lands.
- **No execution assertions.** Plan shape only. The engine's own batched-fan-out spec covers
  execution against a memory module; running rows through a batched fan-out over a real
  `StoreModule` (async coordinator, `serial` concurrency mode → connection-lock path) is
  untested. This is the largest untested surface the change makes reachable — though only for
  a provider that declares a latency, of which there are none in-tree.
- **`resolveExpectedLatencyMs` lives in `cost-profile.ts`.** Placed there per the ticket, as
  the file holding provider-declared planner inputs; but the file's own header describes cost
  ratios, and this value is not one. The helper's doc comment says so explicitly. A reviewer
  may reasonably want it split into its own module.
- **`createInMemoryProvider` (the shared testing double) gained no `expectedLatencyMs`
  option**, per the ticket's instruction to leave it declaring nothing. The spec wraps it
  with a spread instead. If a second spec ever needs this, the option is the DRY-er move and
  mirrors how `costProfile` is already handled there.
- **The IndexedDB band in the new `NOTE:` is derived, not directly measured.** It subtracts a
  row payload from the smallest whole round trip in the existing bench; no benchmark measures
  first-row latency in isolation. The comment quotes no decimals, deliberately, for the same
  reason the neighbouring `costProfile` comment does not.
