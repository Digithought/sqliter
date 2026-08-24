---
description: Storage backends have no way to tell the query planner how slow they are to answer, so a plugin built on the shared key-value store framework — including a future network-backed one — is always planned as if it were in-memory.
files:
  - packages/quereus-store/src/common/kv-store.ts                    # KVStoreProvider — add the optional declaration next to costProfile (~line 336)
  - packages/quereus-store/src/common/cost-profile.ts                # resolveCostProfile / resolveCostField — the validate-and-warn pattern to mirror
  - packages/quereus-store/src/common/store-module-base.ts           # constructor resolves provider capabilities once (lines 233-240)
  - packages/quereus-store/src/common/store-module.ts                # StoreModule — implements VirtualTableModule; readCommittedSnapshot sits here (~line 125)
  - packages/quereus-store/src/testing/memory-provider.ts            # in-memory provider; must keep declaring nothing
  - packages/quereus-store/README.md                                 # cost-profile section (lines ~103, ~436) — where the new knob is documented
  - packages/quereus-plugin-indexeddb/src/provider.ts                # costProfile precedent (~line 106); gets a NOTE, not a number — see below
  - packages/quereus-plugin-leveldb/src/provider.ts                  # "measured and declined" costProfile NOTE (~line 102) — gets a matching latency line
  - docs/module-capabilities.md                                      # surface inventory row for expectedLatencyMs (line 52) is stale
  - packages/quereus/src/vtab/module.ts                              # VirtualTableModule.expectedLatencyMs contract (line 138)
  - packages/quereus/src/planner/cost/index.ts                       # indexNestedLoopJoinCost — the only shared formula that consumes it (line 164)
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # batched candidate gate (lines 195, 205)
  - packages/quereus/src/planner/optimizer-tuning.ts                 # the 25 ms threshold gates (lines 164, 284)
difficulty: medium
---

# Let a key-value provider declare its first-row latency

## What is missing

Quereus' query planner has one number a storage module can use to say "I am slow
to answer": `expectedLatencyMs`, declared as a static field on
`VirtualTableModule` (`packages/quereus/src/vtab/module.ts:138`) and defined as
**first-row latency** — how long an iterator opened over one of the module's
tables takes to hand back its first row. `TableReferenceNode.computePhysical`
(`packages/quereus/src/planner/nodes/reference.ts:244-251`) lifts it onto the
leaf's physical properties, and it propagates up the tree as `max(children)`.

`StoreModule` — the class the LevelDB, IndexedDB, React-Native-LevelDB and
NativeScript-SQLite plugins each register as their virtual-table module
(`packages/quereus-store/src/common/store-module.ts:125`, instantiated at each
plugin's `plugin.ts`) — never declares it, and `KVStoreProvider` has no field a
backend could declare it *through*. So there is no path at all: a third-party
provider over an HTTP or WebSocket-backed key-value store, which is exactly the
case the planner's latency machinery was built for, cannot tell the planner
anything today.

This ticket adds that path. It deliberately does **not** put a number on
IndexedDB or LevelDB — see *Why no backend declares a number yet*, which is the
substance of the investigation and should be read before touching either
provider.

## The wiring

The `costProfile` capability already runs this exact path and should be copied
beat for beat:

```
KVStoreProvider.costProfile?      (public, optional, provider-declared)
      |
      v  resolved ONCE in the constructor — a backend property, fixed for the
         provider's lifetime, and the consumer runs per planned query
StoreModuleBase.costProfile       (protected, resolved, always concrete)
      |
      v
StoreModule.getBestAccessPlan -> computeBestAccessPlan
```

Add, alongside it:

```ts
// packages/quereus-store/src/common/kv-store.ts, next to costProfile
interface KVStoreProvider {
  /** First-row latency, in milliseconds, of an iterator opened over this
   *  backend's stores. Omitted means 0 (in-process). Declare only MEASURED
   *  numbers — see the store README for why an unmeasured guess is worse
   *  than omitting the field. */
  readonly expectedLatencyMs?: number;
}
```

resolved in `StoreModuleBase`'s constructor beside `resolveCostProfile`, and
surfaced as a **public** `readonly expectedLatencyMs: number` so
`StoreModule implements VirtualTableModule` satisfies the optional field with a
concrete `number`. Return `0` rather than `undefined` when the provider declares
nothing — the same choice `IsolationModule` already made and documented
(`packages/quereus-isolation/src/isolation-module.ts:298-299`), for the same two
reasons: `0` is observably identical to omitting the hint (the leaf only lifts
values `> 0`), and a concrete number satisfies the optional property under
`exactOptionalPropertyTypes`.

Validation mirrors `resolveCostField`
(`packages/quereus-store/src/common/cost-profile.ts:147-160`): a public optional
field on a public interface, so a third-party provider can declare anything.
Warn and fall back to `0` rather than throw — with one difference from the cost
fields, where `<= 0` is unusable: **`0` is a perfectly valid latency**, so the
reject predicate is `!Number.isFinite(v) || v < 0`, not `<= 0`.

No change is needed anywhere downstream. `IsolationModule` already forwards
`this.underlying.expectedLatencyMs ?? 0` through a getter, and
`isolation-layer.spec.ts:4529-4541` already covers that forwarding — an
isolation-wrapped store module inherits the new value for free.

## Why no backend declares a number yet

The source ticket assumed picking IndexedDB's number was a measurement task with
a value waiting to be read off the existing benchmark. The measurements exist,
and they say the honest number does not do what the ticket wanted — and that
declaring one anyway would move IndexedDB's plans in the *wrong* direction.

**The measured numbers.** `packages/quereus-plugin-indexeddb/bench/README.md`
(Chromium 151 / Windows 11, 200-byte rows, medians) has the relevant cells. The
smallest whole IndexedDB round trip in the harness — arm B, 20 rows resolved in
1 request — is **0.4 ms** on a 20k-row table and **2.0-2.5 ms** on a 100k-row
table. Subtracting the row payload at the measured full-scan rate (0.0047 ms/row
at 20k, ~0.011 ms/row at 100k) leaves a first-row latency of roughly **0.3 ms to
2.3 ms** depending on table size.

**Every gate that turns the latency machinery on is 25 ms.**
`batchedOuterThresholdMs`, `gatherThresholdMs` and `prefetchProbeThresholdMs` all
default to 25 (`packages/quereus/src/planner/optimizer-tuning.ts:284` and
neighbours), chosen to match the synthetic high-latency test fixture. The
batched-seek flip in `rule-join-physical-selection.ts` builds its candidate for
any positive latency (line 195) but then routes through `toBatchedOuter`, which
enforces the 25 ms threshold (`rule-fanout-batched-outer.ts:142`) and a 256-outer-row
minimum. At 0.3-2.3 ms, IndexedDB clears none of them. **Declaring IndexedDB's
real latency would not make batched seeks fire.** The claim on GitHub issue #30
that the batched-seeks work "matters most for remote/networked backends like your
IndexedDB store" is wrong on this backend at these numbers, and the source
ticket's framing inherited that.

**The one formula it does move, it moves backwards.** `expectedLatencyMs` reaches
exactly one shared cost function: `indexNestedLoopJoinCost`
(`packages/quereus/src/planner/cost/index.ts:164-172`), which adds it per outer
row, charged to the **seek** plan. Hash join pays no latency at all — nothing in
the hash-join cost path reads the field. So a positive declaration makes
index-nested-loop look worse against hash join, and *only* that. On IndexedDB
that is the wrong way round: the hash join's "one scan of the inner side" is the
catastrophic arm on this backend (bench arm C: 93-1,180 ms, versus 0.4-512 ms for
the index arms), because a full scan there is thousands of round trips that the
cost model prices as one. That gap is already filed as
`backlog/feat-per-row-latency-cost-for-remote-scans`; this investigation has been
appended to it as evidence. **Until a scan-side per-row latency exists, declaring
first-row latency alone on IndexedDB is a net-negative plan skew, not an
improvement.**

**A second reason to be wary of the number itself.** The two consumers read the
field on incompatible scales. The 25 ms gates are literal wall-clock
milliseconds. `indexNestedLoopJoinCost` adds it to unitless cost constants under
the stated "ms-equivalent cost" convention (`docs/optimizer-costing.md:78`: "one
unit of `expectedLatencyMs` is one engine cost unit"), where one unit is
`SEQ_SCAN_PER_ROW = 1.0`, i.e. one scanned row. Those two readings agree only if
one scanned row costs about 1 ms. On IndexedDB a scanned row costs 0.0047-0.011
ms, so the same honest 0.4 ms is worth roughly 40-85 cost units on the ratio
scale and 0.4 on the declared scale — a ~100x disagreement. The convention is
fine for its design target (a network backend at 25-100 ms, where latency swamps
engine cost and the ratio stops mattering) and incoherent for a sub-millisecond
one. Do not resolve this by inflating the declaration to the ratio value: that
would lie to the wall-clock gates. Record it as a `NOTE:` and leave it.

**LevelDB** gets the same answer for an additional reason: nothing has measured
its first-row latency. Its provider already declined to declare a `costProfile`
after measuring (`packages/quereus-plugin-leveldb/src/provider.ts:102-119`), on
the principle that an unmeasured declaration is worse than the default. The same
principle applies here with no measurement at all to lean on.

## Test plan

The wiring needs a test that proves the whole chain — provider declaration
reaching an actual planner decision — without depending on any real backend's
number. Use a provider that declares a frankly synthetic high latency (30 ms,
above the 25 ms gates), wrapped around the existing in-memory provider, and
assert the plan shape.

Precedent to mirror: `packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts`
builds this assertion against the private `HighLatencyMemoryModule` fixture; the
new test does the same shape against the real `StoreModule`. It belongs in
`packages/quereus-store/test/` (Mocha; the package already depends on
`@quereus/quereus` and already has plan-shape specs — `cost-profile.spec.ts` and
`column-statistics-plan.spec.ts` are the closest models). Remember the batched
flip also needs `estimatedRows >= 256` on the outer side (`batchedOuterMinRows`),
so the fixture table has to be seeded past that or have its row count advertised.

## TODO

Phase 1 — the provider surface

- Add `readonly expectedLatencyMs?: number` to `KVStoreProvider` in
  `packages/quereus-store/src/common/kv-store.ts`, immediately after
  `costProfile`, documented in the same voice: what the number means, that it is
  first-row latency and not per-row, that omitting it means 0, and that only
  measured values belong there.
- Add a `resolveExpectedLatencyMs(declared: number | undefined): number` helper
  next to `resolveCostField`. Accept `0`; warn-and-fall-back-to-`0` on `NaN`,
  `Infinity` or negative. Export it from `common/index.ts` alongside
  `resolveCostProfile` if that is how the cost helper is exported.
- Resolve it once in `StoreModuleBase`'s constructor
  (`store-module-base.ts:236-240`) into a **public** `readonly expectedLatencyMs: number`,
  with a doc comment giving the same "fixed for the provider's lifetime, consumer
  runs per query, malformed third-party declaration warns once" rationale the
  `costProfile` field carries.
- Confirm `StoreModule` type-checks as `VirtualTableModule` with the concrete
  `number` (the interface field is `readonly expectedLatencyMs?: number` under
  `exactOptionalPropertyTypes`).
- Leave `packages/quereus-store/src/testing/memory-provider.ts` declaring
  nothing, so it resolves to 0 and the golden-plan sweep is untouched.

Phase 2 — the test

- New spec under `packages/quereus-store/test/` — suggested name
  `expected-latency-plan.spec.ts`. Define a small provider that delegates to the
  in-memory provider and declares `expectedLatencyMs = 30`.
- Assert the declaration reaches the module: `new StoreModule(provider).expectedLatencyMs === 30`,
  and that a provider declaring nothing yields `0`.
- Assert it reaches the planner: build a join whose inner side is a
  `StoreModule`-backed table on that provider, with the outer side estimated
  above `batchedOuterMinRows` (256), and assert the chosen plan is the batched
  fan-out — mirroring the assertions in
  `packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts`.
- Assert the negative direction too: the same query against a provider declaring
  nothing does **not** produce the batched shape. This is what makes the test a
  regression guard rather than a snapshot.
- Cover the malformed declaration (`-1`, `NaN`) resolving to `0` with a warning,
  the way `cost-profile.spec.ts` covers its equivalents.

Phase 3 — record the two decisions in the code, and fix the stale doc

- `packages/quereus-plugin-indexeddb/src/provider.ts`, next to the existing
  `costProfile` block: a `NOTE:` recording that no `expectedLatencyMs` is
  declared, that this is a *measured* decision, the measured band (0.3-2.3 ms
  from bench arm B), the two reasons (below every 25 ms gate; the only formula it
  moves charges the seek plan and not the scan, which is backwards on this
  backend), and the revisit condition — **when
  `feat-per-row-latency-cost-for-remote-scans` lands a scan-side per-row latency,
  re-derive both together.** Match the existing comment's discipline about not
  quoting false precision.
- `packages/quereus-plugin-leveldb/src/provider.ts`, appended to the existing
  "no costProfile, deliberately" comment: one line saying no `expectedLatencyMs`
  either, and that unlike `costProfile` this one is unmeasured — nothing has
  timed LevelDB's first-row latency — so the declare-only-measured rule applies a
  fortiori.
- A `NOTE:` at `indexNestedLoopJoinCost`
  (`packages/quereus/src/planner/cost/index.ts:164`) recording the scale
  mismatch: the 25 ms gates read the field as wall-clock while this formula reads
  it as cost units where 1.0 is one scanned row, and those agree only when a
  scanned row costs ~1 ms — true for the network backends this was designed for,
  false by ~100x for a sub-millisecond one. Fine while every gate sits at 25 ms
  and no sub-millisecond backend declares a value; revisit if either changes.
- `docs/module-capabilities.md:52` — the `expectedLatencyMs` row currently reads
  `0` under **store** and `via store` under **leveldb / indexeddb**, which
  overstates what exists (there is no provider surface at all today). Update to
  say provider-declared, defaulting to 0, and that no in-tree provider declares
  one.
- `packages/quereus-store/README.md` — document the new knob in the section that
  already covers `costProfile` (around lines 103 and 436), including the
  declare-only-measured rule.
- `docs/optimizer-costing.md:76` says "a network-backed module (a sync- or
  IndexedDB-backed one) would declare a real number". After this ticket that
  sentence is misleading about IndexedDB specifically — soften it to the
  hypothetical network-backed case.

Phase 4 — validate

- `yarn build`
- `yarn test` (includes the new `quereus-store` spec)
- `yarn lint` and `yarn typecheck`
- `yarn workspace @quereus/quereus-plugin-indexeddb test` and the LevelDB
  equivalent, to confirm the comment-only changes there disturb nothing.
- Note in the review handoff whether `yarn test:store` was run — it is the slow
  LevelDB-backed re-run and is not required by this change, which adds no
  behavior on a provider that declares nothing.
