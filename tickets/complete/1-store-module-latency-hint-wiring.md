---
description: A storage backend built on the shared key-value store framework can now tell the query planner how slow it is to answer its first row; no built-in backend claims to be slow, so nothing plans differently today.
files:
  - packages/quereus-store/src/common/kv-store.ts                    # KVStoreProvider.expectedLatencyMs — the optional declaration
  - packages/quereus-store/src/common/cost-profile.ts                # resolveExpectedLatencyMs — validate-and-warn helper
  - packages/quereus-store/src/common/index.ts                       # exports resolveExpectedLatencyMs
  - packages/quereus-store/src/common/store-module-base.ts           # public readonly expectedLatencyMs, resolved in the constructor
  - packages/quereus-store/test/expected-latency-plan.spec.ts        # NEW — resolution + planner + execution, 7 tests
  - packages/quereus-plugin-indexeddb/src/provider.ts                # NOTE: measured, deliberately undeclared
  - packages/quereus-plugin-leveldb/src/provider.ts                  # NOTE: unmeasured, deliberately undeclared
  - packages/quereus/src/planner/cost/index.ts                       # NOTE: the two consumers read the field on different scales
  - packages/quereus-store/README.md                                 # § Backend first-row latency
  - docs/module-capabilities.md                                      # expectedLatencyMs inventory row
  - docs/optimizer-costing.md                                        # § First-row latency in cost comparisons
difficulty: medium
---

# Provider-declared first-row latency for store-backed modules

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
  interface field the planner reads off the registered module, and it resolves to a concrete
  `0` rather than `undefined` — matching `IsolationModule`, which already forwards
  `this.underlying.expectedLatencyMs ?? 0`, so an isolation-wrapped store module inherited
  the new value with no downstream change.

**No in-tree backend declares a number.** That is the ticket's finding, not an omission: the
IndexedDB decision is measured and recorded at the provider, the LevelDB one is explicitly
unmeasured, and the two remaining in-tree providers (React Native LevelDB, NativeScript
SQLite) are in-process backends in the same position as LevelDB's.

## Review findings

Reviewed the implement diff `daf2661e2` with fresh eyes before the handoff summary, then
walked every consumer of the field across the engine, the isolation wrapper, all four in-tree
providers, and every doc naming it.

**Verified sound — no change needed**

- **The wiring itself.** `StoreModuleBase` resolves once at construction; `StoreModule`
  (via `StoreModuleCatalog` / `StoreModuleRename`) is the only class in the chain, so there
  is no subclass shadowing. `TableReferenceNode.computePhysical` lifts only values `> 0`
  (`reference.ts:248-251`), which is what makes a resolved `0` observably identical to
  declaring nothing.
- **No wrapper drops the hint.** `IsolationModule` is the only `VirtualTableModule` wrapper
  in tree and already forwards it; `createCountingProvider` and `createInMemoryProvider` are
  standalone providers, not decorators, so there is no provider-level forwarding hole.
- **Malformed declarations.** `resolveExpectedLatencyMs` warns and falls back for negative,
  `NaN`, `Infinity`, and (through `Number.isFinite`) any non-number a JavaScript caller
  passes. Matches `resolveCostField`'s discipline and its `console.warn` idiom.
- **Every cross-reference resolves.** `backlog/feat-per-row-latency-cost-for-remote-scans`,
  `backlog/debt-leveldb-cost-profile-measurement`, and
  `packages/quereus-plugin-indexeddb/bench/README.md` all exist.
- **File sizes.** Largest file touched is 513 lines (`kv-store.ts`, `wc -l`); nothing is near
  a size-debt threshold. Comment density in the two provider `NOTE:` blocks is high but
  matches the surrounding house style, which records decisions at the site by design.

**Minor findings — fixed in this pass**

- **One factual error in a decision comment.** The IndexedDB `NOTE:` claimed "nothing in the
  hash-join cost path reads it". `rule-join-physical-selection.ts:430-432` does charge the
  hash and merge candidates `leftLatencyMs + rightLatencyMs`. The NOTE's *conclusion* still
  holds — hash pays one open per side, the seek plan pays per outer row — but a reader
  deciding whether to declare would have been misled about the mechanism. Reworded to state
  the asymmetry instead of a false absolute.
- **Execution over the new plan shape was untested** — the handoff's own "largest untested
  surface". Added a seventh test: the same join, run to completion under both providers,
  asserting identical rows. This drives a batched fan-out over a `StoreModule` (async
  coordinator, `serial` concurrency mode) for the first time anywhere in the suite. It
  passes — the latency hint changes plan choice and not answers.
- **Two doc pointers aimed at the wrong paragraph.** `kv-store.ts` and the spec header both
  sent readers to the store README's *§ Backend cost profile* for the latency rationale,
  which lives in the *§ Backend first-row latency* paragraph added by this change. Repointed.
- **`cost-profile.ts`'s file header described only cost ratios** while the file now also
  holds the latency resolver — the mismatch the handoff flagged as "a reviewer may reasonably
  want it split". A split is not warranted at 187 lines for one 10-line function that shares
  the resolve-once-at-construction lifecycle; widening the header one sentence removes the
  mismatch instead.
- **The README named two in-tree providers where there are four.** "No in-tree provider
  declares one" was true, but only LevelDB and IndexedDB were accounted for. Added the React
  Native LevelDB and NativeScript SQLite providers, in the same position as LevelDB's.

**Measured, and recorded as a `NOTE:` rather than left as an open question**

- The handoff flagged that the spec lowers `batchedOuterMinRows` to 0 and that it was "not
  obvious without running it" whether the batched shape forms at the shipped 256-row default.
  Ran it: the same fixture with a 300-row outer and untouched tuning plans a **`HashJoin`
  over an `IndexScan`** — no fan-out at all. That is the cost model behaving as
  `docs/optimizer-joins.md` documents (under a 30 ms declaration the seek plan overtakes hash
  join only once the *inner* table is enormous — near 128k rows at 25 ms and a 20k-row
  outer), not the wiring failing. A fixture that would show the batched shape at shipped
  defaults needs an inner table far too large for a unit test. Recorded at the fixture in
  `expected-latency-plan.spec.ts` so nobody re-derives it.

**Conditional / speculative — parked, not filed**

- The unit-scale mismatch between the `*ThresholdMs` gates (wall-clock ms) and
  `indexNestedLoopJoinCost` (cost units, 1.0 = one scanned row) is already a `NOTE:` at
  `planner/cost/index.ts` from the implement pass, with its revisit condition. Confirmed
  inert — every gate is 25 ms and no in-tree module declares a sub-millisecond value — and
  left alone.

**Filed as evidence on an existing ticket, not as a new one**

- The new spec is an eleventh private copy of the "fake slow backend" fixture, and the first
  outside `packages/quereus`. `backlog/debt-shared-high-latency-test-module` already owns
  that class; appended an arm naming the new instance and the suggestion that the shared
  helper also export the threshold constant, so a cross-package spec stops hardcoding `30`.

**Considered and declined**

- **`createInMemoryProvider` gained no `expectedLatencyMs` option.** The spec wraps it with a
  spread instead, and that spread is load-bearing: it produces a provider with *no such
  property at all*, which is the exact shape a pre-change third-party provider has and the
  one the default path must handle. One caller, and the option would blur that. Revisit when
  a second spec needs it.
- **Gather and prefetch-probe rule coverage.** Those two rules read the same propagated leaf
  value the covered rule reads; once the leaf carries the number, which rule consumes it is
  the engine's business, and the engine's own optimizer specs cover them against a synthetic
  high-latency table type. Not duplicated here.
- **A conformance assertion on `expectedLatencyMs` in `runKVProviderConformance`.** The
  battery tests store *behavior*, not static hints, and `costProfile` is not asserted there
  either; a bad declaration already cannot break planning.

## Validation

All run at the end of the review pass, all green:

```
yarn build            # ok
yarn typecheck        # ok (fans out; store's pass covers test/ via tsconfig.test.json)
yarn lint             # ok
yarn test             # 0 failing across every workspace
yarn workspace @quereus/store test               # 1929 passing (was 1928 + the new execution test)
yarn workspace @quereus/plugin-indexeddb test    # 179 passing
yarn workspace @quereus/plugin-leveldb test      # 89 passing
```

`yarn test:store` was not run, by the implement ticket's reasoning: it is the slow
LevelDB-backed re-run of the engine's logic tests, and LevelDB's provider declares no
latency, so the change adds no behavior on that path.

The new spec alone:

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/expected-latency-plan.spec.ts" --reporter spec
```

## What the spec pins

`packages/quereus-store/test/expected-latency-plan.spec.ts`, 7 tests in two groups.

**Resolution** — a declared `30` reaches the module; a provider with no such property
resolves to `0`; a declared `0` is accepted (the `< 0` vs `<= 0` difference from cost
fields); `-1`, `NaN` and `Infinity` each resolve to `0` and each warn once, naming the field.

**Reaching the planner** — a four-row memory-module outer joined to a 200-row `StoreModule`
inner:

- declaring 30 ms → exactly one `FanOutLookupJoin` with `outerMode === 'batched'`, over one
  `EagerPrefetch`;
- the same query and fixture declaring nothing → zero of each (the arm that makes this a
  regression guard rather than a snapshot);
- both plans executed → identical rows.

Plan shape is read through the public `serializePlanTree` (JSON) because the node classes
and the `PlanNode` type are engine-internal and not exported from `@quereus/quereus`, so the
`instanceof` assertions the engine's own spec uses are unavailable from this package.

## Remaining gaps, accurately stated

- **The planner arm exercises one rule.** The gather and prefetch-probe rules read the same
  propagated value; see *Considered and declined* above for why they are not duplicated here.
- **The batched shape is not pinned at production cardinalities.** Measured above and
  recorded at the fixture: at shipped defaults this fixture plans a hash join, and showing
  otherwise needs an inner table too large for a unit test.
- **The IndexedDB band in its `NOTE:` is derived, not directly measured** — it subtracts a
  row payload from the smallest whole round trip in the existing bench; no benchmark measures
  first-row latency in isolation. The comment quotes no decimals, deliberately, as the
  neighbouring `costProfile` comment does not.
