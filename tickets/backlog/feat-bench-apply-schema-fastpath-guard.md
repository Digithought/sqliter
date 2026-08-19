---
description: A shortcut that makes re-applying an unchanged schema much faster was measured once by hand on one machine; nothing checks that it still works, so if it silently stopped taking the shortcut nobody would notice.
files:
  - packages/quereus/bench/apply-schema-unchanged.mjs   # the existing one-off harness
  - packages/quereus/bench/suites/                      # where a standing benchmark pair would live
  - docs/schema.md                                      # quotes the one-off numbers
tradeoffs: The fast path is already covered for correctness by the test suite, so this guards only its performance - and it costs a second benchmark that deliberately runs the slow path, which is wall-clock spent measuring something nobody wants to be fast.
---

# What this is about

Re-declaring a schema that has not changed used to do a full comparison every time: collect
the current catalog, diff it against the declaration, and generate a migration plan that
turns out to be empty. A fast path now short-circuits that by re-rendering both sides and
comparing the two strings.

`packages/quereus/bench/apply-schema-unchanged.mjs` measured the win once, by hand, on one
machine, and `docs/schema.md` quotes the result. Nothing measures it on an ongoing basis. If
a change caused the fast path to stop engaging - a rendering that is no longer stable, a
snapshot that is invalidated too eagerly - the correctness tests would all still pass, and
the only symptom would be that re-applying a schema quietly got several times slower again.

# What would settle it

A pair of benchmarks in the suite, and a bound on the ratio between them:

- the no-op re-apply on the fast path, and
- the same no-op re-apply with the applied-state snapshot poisoned, so it pays the full
  comparison.

The ratio between the two is what the guard bounds. A ratio is the right shape here for the
same reason it is elsewhere in the suite: it cancels out machine speed, so it can be checked
from a single run with no baseline file, and it trips when the fast path stops engaging
rather than when the machine is busy.

The existing harness already builds a suitable 54-table / 14-view declaration and already
knows how to poison the snapshot; the benchmark shapes come straight out of it.

# Why the existing harness is not simply moved

`apply-schema-unchanged.mjs` is a decomposition: it prices the individual internal steps the
fast path removed, added, and still pays. The benchmark framework measures one operation per
benchmark and cannot express that, so folding the harness in would keep one number and lose
the five that make it useful. That decision is recorded at the file itself. This ticket adds
a standing guard *alongside* it; it does not replace it.
