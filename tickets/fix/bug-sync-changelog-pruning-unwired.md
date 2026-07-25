description: The running sync server keeps a log of every change forever — the code that is supposed to trim old entries exists but is never actually called, so memory and storage grow without bound.
files:
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/quereus-sync/src/sync/
----

## Problem

The sync change log has a pruning path, but nothing in the running coordinator actually
invokes it. So the change log grows unbounded for the life of the process/store — a slow
memory and storage leak.

Surfaced by the same review that produced the shared-protocol work; carved out here because
it is independent of the wire-format unification.

## Direction / open questions (for the fix pass)

- Locate the existing pruning function and confirm it is correct but simply uncalled.
- Decide the trigger: retention-horizon sweep (there is already a `retentionHorizonMs` in
  `SyncConfig` and host-driven eviction sweeps for basis tables — the pruning likely belongs
  on the same host-driven cadence, not a library-internal timer), vs. prune-on-write.
- Confirm pruning cannot drop changes a not-yet-caught-up peer still needs (interaction with
  delta-sync eligibility, which is also bounded by `retentionHorizonMs`).

Needs investigation to scope; not a mechanical fix. Route through `fix/` when picked up.
