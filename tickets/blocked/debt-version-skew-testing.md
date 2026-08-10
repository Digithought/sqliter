----
description: Nothing checks whether two devices running slightly different versions of Quereus can still sync with each other; this asks a human whether the project is ready to promise that they can, since testing it only makes sense once we intend to support it.
files:
  - packages/quereus-sync (the sync protocol — the serialization most exposed to version differences)
  - packages/quereus-sync-client / packages/sync-coordinator (the client/coordinator pair that has drifted before)
----

**Blocked — category (a): a decision only a human should make.** It unblocks when someone
answers: *does Quereus intend to support mixed-version deployments — devices or services on
different releases syncing with each other?* The engineering work here is small and
well-understood; what is missing is the product commitment that would make it worth doing.

## Background, for a reader with no context

Quereus can sync data between devices. When it does, one side serializes changes into a wire
format and the other side decodes them. If both sides always run the exact same release,
that format can change freely. If they can run different releases, every change to it risks
breaking an older peer.

**Version-skew testing** is the check for that: pin one side at version N and the other at
version N-1, and assert they still interoperate.

## The question, plainly

Do we promise that a device or service on an older release can still sync with a newer one?
Only if the answer is yes does a version-skew test earn its keep — otherwise it tests a
guarantee we have deliberately not made.

## What happens if we do nothing

Nothing breaks today. `AGENTS.md` currently states the project's position outright:
**"Backwards compat: don't worry yet."** Under that stance, a wire-format change is simply
allowed, and all peers are expected to upgrade together. The risk arrives later, and
silently — the first real deployment where two peers upgrade at different times will hit a
decode failure, and no test will have warned about it. There is no deadline; the exposure
appears only when mixed-version deployments become real.

Note that the nearest concrete risk this would guard — client/coordinator protocol drift — is
already addressed more directly by the sync-protocol shared-module and migrate/version work
(both in `tickets/complete/`) and by the end-to-end coordinator round-trip test
(`sync-coordinator-e2e-roundtrip`), which catches *current* drift without any multi-version
harness.

## Options

1. **RECOMMENDED DEFAULT — keep it parked; do not build it yet.** Consistent with the stated
   project stance, and the current-drift risk is already covered. Revisit when either of the
   triggers below fires.
2. **Commit to mixed-version sync and build the test.** The smallest useful form is *not* a
   dual-install matrix: serialize a changeset with the current codec, then decode it with a
   **pinned prior codec snapshot** — a committed golden fixture of the older wire format — and
   assert it still applies. One test file, one fixture, no npm version juggling. This is the
   right first iteration if the answer is yes.
3. **Commit to mixed-version sync but defer the test until a version-negotiation boundary
   exists.** Reasonable if the protocol is about to gain explicit versioning anyway — the test
   is much more meaningful once there is a declared compatibility window to test against.

## Triggers that would flip the default

- The project decides to support mixed-version sync deployments (a coordinator serving
  clients that upgrade at different times), **or**
- the sync protocol gains an explicit version negotiation / migration boundary whose
  compatibility window needs testing across real version pairs.

## How reversible is this call

The *test* is fully reversible — build it or delete it at any time, at low cost. The
underlying commitment is not: once mixed-version sync is promised to users, every future wire
format change inherits a compatibility obligation, and walking that back is a breaking change.
That asymmetry is the reason this is a human's call and not an engineering one.
