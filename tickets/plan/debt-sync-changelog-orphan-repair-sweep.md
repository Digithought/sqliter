description: Devices that were already syncing before the recent leak fix still carry the dead bookkeeping entries they accumulated; there is no way to clean those out, so they stay forever.
files:
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quoomb-web/src/sync/sync-maintenance.ts
difficulty: easy
----

## Background

Sync keeps an index of recent changes so a device can ask a peer "what changed since
X?" without reading the whole database. Each index entry is a pointer at a record
elsewhere in the store.

Until recently, deleting a record left its index entry behind. Those dead pointers
are harmless to correctness — the reader checks whether the target still exists and
skips the entry when it does not — but they accumulate with every delete a device has
ever performed, and each one costs a lookup on every "what changed since X?" scan.

`1-sync-changelog-orphan-cleanup` stopped new ones from being created: entries are now
deleted in the same write as the record they point at. That fix works forwards only.
It finds entries to delete *by way of* the record being deleted, so an entry whose
record is already gone can never be reached by it.

## What is missing

Any database that ran an affected build keeps its accumulated dead entries
permanently. There is currently no way to get rid of them, and no way to tell how many
a given database has.

## What a fix looks like

A one-shot repair pass over the index: walk every entry, ask the existing resolver
whether its target still exists, delete the entry when it does not. It is inherently
safe — an entry that resolves to nothing already produces no output — so it needs no
coordination with peers and can run at any time.

Open questions for whoever picks this up, not decided here:

- Does it run automatically (once, on open, recorded so it does not repeat) or only on
  demand?
- Is it exposed through the existing maintenance sweep that already calls tombstone
  pruning, or as a separate operation?
- Is a count worth reporting so operators can see whether their database was affected?

## Why it is filed rather than done

It is real but not urgent: the cost is storage plus a small per-scan overhead, both
proportional to a device's historical delete volume, and nothing is incorrect. Filed
during review of `1-sync-changelog-orphan-cleanup`, which called it out as an
explicit gap.
