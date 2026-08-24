---
description: Eleven test files each define their own private copy of the same fake "slow storage" fixture used to test how the planner handles network delay, and the copies have already drifted apart in what they claim to do.
files:
  - packages/quereus/test/optimizer/parallel-async-gather.spec.ts
  - packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts
  - packages/quereus/test/optimizer/parallel-fanout.spec.ts
  - packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts
  - packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
  - packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts
  - packages/quereus/test/optimizer/fk-trust-gated-by-capability.spec.ts
  - packages/quereus/test/optimizer/inclusion-dependencies.spec.ts
  - packages/quereus/test/optimizer/join-latency-cost.spec.ts
  - packages/quereus-store/test/expected-latency-plan.spec.ts       # 11th copy, different package
tradeoffs: Each copy is three lines and keeping it next to the tests that use it makes a spec readable on its own; a maintainer may prefer that self-containment to a shared helper the reader has to go look up.
---

# One fake slow-storage table type, copied ten times

## What exists

Several planner behaviors only switch on when a storage module reports that its
tables are slow to answer — the delay before the first row arrives. No real
in-tree module is slow, so the tests fake one: a memory-backed table type that
claims a 25 ms delay.

Ten optimizer spec files each declare their own private copy of that type
(`grep -rln "expectedLatencyMs = 25" packages/quereus/test` lists them). The
number 25 is also the default threshold several planner rules compare against,
so the copies are all pinned to the same value by coincidence of everyone
picking the same constant, not by anything enforcing it.

The doc comments above the copies have already drifted — some describe the
fixture generally, some describe only the rule that spec happens to test, and
one calls it "the synthetic remote-vtab stand-in used by every parallel/latency
optimizer spec" while in fact being a tenth private copy.

## Why it matters

The next latency-sensitive spec adds an eleventh. If the threshold a rule
compares against ever moves, whoever moves it has to find ten declarations to
know whether the tests still exercise the intended side of the boundary — and
the drifted comments make it easy to believe a copy is shared when it is not.

## What "done" looks like

One shared test helper exporting the fake slow-storage table type, with the
delay it reports stated once and its relationship to the rule thresholds
explained in one place. The ten specs import it. Behavior of every existing test
is unchanged — this is only about where the declaration lives.

## Arm added by review of `store-module-latency-hint-wiring`

There is now an eleventh copy, and it is outside `packages/quereus`:
`packages/quereus-store/test/expected-latency-plan.spec.ts` builds its own
slow-backend stand-in — a key-value provider that reports a 30 ms delay — to
prove that a storage backend's declared delay reaches the planner.

It differs from the ten in *what* it fakes (a slow storage backend behind the
store module, not a fake table type), so it cannot simply import a fake table
type. What it shares is the part this ticket is actually about: a bare number
picked to sit just above the threshold the planner rules compare against, with
nothing tying the two together. Whoever moves that threshold now has eleven
places to find, in two packages.

Worth considering when this is done: export the threshold-related constant
itself alongside the shared fake, so a spec in another package can say "just
above the threshold" rather than writing `30` and hoping.
