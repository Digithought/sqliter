description: Tables kept in persistent key-value storage cannot yet serve a query while another query is saving data, so those reads still wait. Give the storage layer a way to hand out a stable view of the last saved data so those reads can run immediately too.
prereq: concurrent-reads-engine-path
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/store-table-scan.ts, packages/quereus-store/src/common/transaction.ts, packages/quereus-store/src/common/kv-store.ts, packages/quereus-isolation/src/isolation-module.ts
difficulty: hard
----

# Committed-snapshot reads for store-backed tables

The engine's concurrent committed-read path (a read-only statement that runs
without the execution mutex, against each table's last committed state) is gated
on a module declaring `readCommittedSnapshot`. Only the in-memory table
declares it; the store stack declares `false`, so every store-backed read still
queues behind an in-flight write — including a write parked in a slow commit.

That is the fail-closed outcome, and it is correct. It is also the configuration
most persistence-using applications actually run, so the payoff of the whole
concurrent-read line of work is capped until this lands.

## Why the store stack cannot serve it today

- `StoreModule.connect` returns a **shared cached** `StoreTable` per table key,
  so a per-connection "read committed only" mode has nowhere to live — every
  caller gets the same instance.
- `StoreTable`'s scan merges the table coordinator's pending-op view over the
  committed store whenever a transaction is open, so a read taken during a
  commit flush observes partially applied ops.
- Under the isolation wrapper the staged rows live in the overlay and the
  underlying store holds only committed data — but the *flush* at commit writes
  those rows into the underlying store incrementally, so a concurrent read of
  the underlying during that flush sees a half-applied commit: some rows
  present, matching secondary-index entries not yet written.

The last point is the substantive one. The obligation the engine's flag encodes
is not "hide the staged rows" — it is "serve a state consistent as of some
commit boundary and keep serving that same state for the life of the scan,
including across index-driven access paths". A short result set from an
index-driven plan during a flush is exactly the failure mode.

## Shape of the work

Two viable directions; pick one with a measurement, not a preference.

1. **Pin a snapshot at connection open.** Requires the KV provider layer to
   expose a point-in-time read view. Some backends have this natively
   (LevelDB snapshots); IndexedDB and the in-memory provider do not, so it would
   need building or the capability would be per-provider — which then needs a
   per-provider `readCommittedSnapshot`, not a per-module one.
2. **Publish the commit atomically.** Make the flush land as one visible switch
   (write to a side location, then swap a root pointer) so a live read can never
   observe a partial one. Cost and feasibility differ sharply per provider.

Either way, the acceptance bar is the conformance harness shipped with the
concurrent-read work (`runCommittedReadConformance`,
`packages/quereus/src/vtab/test-support/committed-read-conformance.ts`): with a
commit artificially parked mid-publish, a committed read must return a snapshot
that is self-consistent across columns and identical between an index-driven
plan and a full scan.

## Adjacent

`backlog/bug-store-committed-ref-sees-uncommitted-rows` covers a *separate*,
smaller defect: a raw `StoreModule` (no isolation wrapper) ignores
`_readCommitted` entirely, so `committed.<table>` returns uncommitted rows even
with no concurrency involved. Fixing that does not deliver this ticket, and this
ticket would subsume it.
