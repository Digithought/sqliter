----
description: The browser-storage plugin is tested against a Node stand-in for the browser's database rather than a real browser; this asks a human whether it is worth setting up a real-browser test run now, or waiting until something actually goes wrong.
files:
  - packages/quereus-plugin-indexeddb/test (8 specs, all against the Node stand-in today)
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/src/manager.ts (open/upgrade lifecycle — the part most likely to behave differently in a real browser)
----

**Blocked — category (a): a decision only a human should make.** It unblocks when someone
answers: *do we spend the tooling budget to run part of the IndexedDB plugin's tests inside
a real headless browser now, or do we wait for a trigger?* This is a cost/benefit call about
where test effort goes, with no defensible default an agent can pick — hence a human.

## Background, for a reader with no context

**IndexedDB** is the database built into web browsers. Quereus has a plugin
(`packages/quereus-plugin-indexeddb`) that stores data in it. Because running tests in a
real browser is slow and awkward, those tests currently run in Node against
**`fake-indexeddb`** — a faithful-but-not-identical reimplementation of the browser API. All
8 of the plugin's specs use it, and they run fast under mocha in Node.

The stand-in is good, not perfect. Things it cannot fully model: the real
`onupgradeneeded` / version-change transaction semantics (what happens when the stored schema
version changes while other tabs hold the database open), real key ordering inside an object
store, structured-clone edge cases for unusual values, and browser storage-quota and blocking
behavior.

## The question, plainly

Should we stand up a small headless-browser run (Playwright, or a Karma-style runner) that
executes a handful of the plugin's tests against a real browser IndexedDB — or keep relying
on the Node stand-in until a real-browser-only bug actually bites?

## What happens if we do nothing

The Node stand-in stays the only harness. Everyday behavior stays covered, and it stays
fast. The exposure is narrow but real: a bug that is green under the stand-in and broken in
Chrome or Safari ships undetected, most likely in the database-open/upgrade path. Nothing
degrades over time, and the decision can be revisited at any point.

## Options

1. **RECOMMENDED DEFAULT — wait for a trigger.** Keep the Node stand-in as the only harness
   and revisit when *either* a real-browser-only bug ships (something green under the
   stand-in, broken in a browser), *or* a CI pipeline exists to host a headless-browser job.
   Rationale: the stand-in already covers the behavioral contract the conformance suite pins;
   the extra bugs a browser would catch are lifecycle quirks, not the common path. A headless
   browser in the test pipeline is real ongoing weight (install, flakiness, maintenance) for
   that marginal gain, and CI is currently out of scope by product decision — a browser smoke
   run is most valuable *wired into CI*, so building it now buys less than building it later.
2. **Build a smoke run now.** A handful of round-trip and upgrade cases only, not a re-run of
   the suite. Buys early warning on the upgrade path, which is the riskiest divergence. Costs
   a browser dependency in the test toolchain and someone's time keeping it green.
3. **Full browser suite.** Not recommended by anyone — the fast Node suite should stay the
   exhaustive one; a browser run should always be a smoke test.

## How reversible is this call

Fully reversible and cheap either way. Choosing to wait costs nothing but the exposure
above. Choosing to build it and later regretting it means deleting a test script and a dev
dependency. No stored data, public API, or user-visible behavior is affected.

## New evidence since this was filed (does not change the question)

A performance change to the plugin's range read (`perf-indexeddb-batch-range-reads`) replaces
a per-row read with a whole-page read. Its effect is measurable in this repo only as a count
of requests made to the browser database, not as elapsed time: the Node stand-in's timings
say nothing about a real browser. So there is now a concrete piece of work that *would* have
used a browser run if one existed — a scan of ~20,000 rows, timed before and after. That is
one more small item on option 2's side of the ledger; it does not settle the call.

## New evidence (2026-08-14): a real-browser-only bug actually occurred

Option 1's revisit trigger — "a real-browser-only bug ships (green under the stand-in,
broken in a browser)" — has now fired once, in the benchmark harness rather than the plugin
itself: `bench/arms.mjs`'s `deleteDb` treated IndexedDB's `onblocked` event as fatal.
`fake-indexeddb` never delivers `onblocked`, so all specs were green; real Chromium delivers
it routinely on the close-then-delete pattern, which intermittently made the harness skip its
two headline measurement arms while still reporting success. Found and fixed during review of
`idb-native-index-bench`. The plugin's own `manager.ts` handles `onblocked` correctly, so no
shipped-code bug — but the divergence class this ticket names is now demonstrated, not
hypothetical.

## Already settled — do not re-open here

The **default** test harness for IndexedDB was decided by the parent plan
(`test-coverage-and-build-tooling`) and the KVStore conformance work
(`test-kvstore-conformance-suite`): Node `fake-indexeddb`. That stays the primary,
CI-friendly path regardless of how this ticket is answered. This decision is only about the
optional real-browser supplement.
