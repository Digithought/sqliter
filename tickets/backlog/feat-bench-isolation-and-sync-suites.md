---
description: The transaction-isolation layer and the sync engine have no performance measurements at all, even though both sit directly on paths where a slowdown would be felt by every read or every replicated change.
prereq: bench-store-suite
files:
  - packages/quereus-isolation/src/            # the overlay every read and write passes through when enabled
  - packages/quereus-sync/src/                 # sync engine
  - packages/quereus-sync-client/src/
  - packages/sync-coordinator/src/
  - packages/plugin-loader/src/
  - packages/quereus/bench/run.mjs             # harness the suites would plug into
tradeoffs: Both subsystems are still moving, and sync performance depends on network and coordinator behavior that a local benchmark cannot represent honestly - a number measured here may not predict anything a user experiences.
---

# Why

Two packages sit on hot paths and have no performance coverage of any kind.

**The isolation layer** wraps a storage module and maintains an overlay so a transaction
reads its own uncommitted writes. Every read inside a transaction consults that overlay;
every write adds to it. Its cost is therefore paid by every operation in every transaction
for anything using it. There is an open idea in the backlog for overlay fast paths
(`feat-isolation-overlay-fast-paths`) - an optimization proposal with no measurement to
justify or evaluate it, which is the usual sign that a benchmark is missing.

**The sync engine** replicates changes between replicas. Its costs are of a different
kind - per-change encode and decode, changelog scanning, snapshot handling, batch sizes -
and at least two of them are already known to be suspect: a backlog item notes the repair
path rescans the changelog on every tick, and another notes snapshots are held entirely in
memory. Both are performance claims, neither measured.

**The plugin loader** is a smaller case: it runs once at startup, so the only interesting
number is startup cost, and only if it turns out to be large.

# What would help

For the isolation layer, the natural design is the one the store suite already needs: run
the same workloads with the layer present and absent, and report the ratio. That ratio is
the overlay's cost, it is machine independent, and it is exactly the number the fast-path
proposal needs to justify itself. Overlay depth (a transaction with few writes versus many)
is the dimension to vary, since the overlay's cost should be a function of what it holds.

For sync, the honest scope is the local, deterministic half: how long it takes to encode
and decode a change, how the changelog scan grows with changelog length, how a snapshot
scales with database size, and how batching affects throughput. Anything involving a real
network belongs in a different kind of test than a benchmark, and pretending otherwise
produces numbers that mislead.

# Why this is filed as future work

Neither subsystem is where a regression would hurt most today - the engine and the storage
layer are. But the isolation ratio in particular is cheap to produce once the store
benchmark suite exists, since it is the same workloads with one wrapper toggled, and it
turns an existing optimization proposal from a guess into a decision.
