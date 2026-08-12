---
description: A shared test battery that every storage plugin runs, to prove that dropping a table really erases its data, has nothing checking the battery itself still works — if an edit ever neutered one of its checks, every plugin would keep reporting green.
files:
  - packages/quereus-store/src/testing/kv-reclaim-conformance.ts    # the battery; its assertions are inline in the it() blocks
  - packages/quereus-store/test/store-name-distinctness.spec.ts     # the sibling battery's self-check — the shape to copy
  - packages/quereus-store/src/testing/kv-naming-conformance.ts     # exports its core assertion standalone for that reason
difficulty: medium
tradeoffs: The battery was watched failing by hand twice (deliberately breaking a provider makes the right cases fail), so this buys durability against a future edit rather than fixing anything wrong today — and extracting the assertions makes the battery a little less direct to read.
---

# The store-reclaim battery has no test of its own

## Background

`runStoreReclaimConformance` is a shared battery every storage plugin registers. It holds a
plugin to one rule: when the engine tells it to delete a dropped table's storage, that storage
must come back EMPTY — not merely closed. Two plugins shipped without doing that, which is why
the battery exists.

Its sibling battery, `runStoreNameDistinctness`, is built so it can be tested itself: its core
assertion is exported standalone, and `test/store-name-distinctness.spec.ts` drives that
assertion against deliberately-broken stand-in providers to confirm it really fails on each
kind of defect. The reclaim battery has no equivalent. Its assertions live inline inside its
test cases, so nothing outside the battery can exercise them.

## Why it matters

The battery's whole value is that it fails when a plugin is wrong. Nothing today would notice
if an edit made a case stop asserting — a case that silently passes looks exactly like a
correct plugin, across all four plugins at once, forever. That is the same failure mode the
naming battery's self-check exists to prevent.

## What would close it

Extract the reclaim battery's assertions the way the naming battery's are extracted, then
drive them from a spec in `packages/quereus-store/test/` against stand-in providers built to
be wrong in each of the ways a real provider has been: one that only closes its handle without
erasing, one that erases a store and its siblings too, one that erases only the first chunk of
a large store, one that throws on a store that never existed. Each broken stand-in must make
exactly the intended case fail.

## Not part of this

Nothing here runs on a real phone; the two mobile plugins are exercised against in-process
stand-ins for their native storage. Real-device verification is a separate concern and this
ticket does not address it.
