description: If one transaction both changes rows in a table and drops that table, the sync engine throws while recording the transaction afterwards and discards the whole transaction's record — so every other change in that transaction, including changes to unrelated tables, silently never replicates to other devices.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # handleTransactionCommit (~line 707), recordDataEvent, recordColumnVersions
  - packages/quereus-sync/src/metadata/pk-identity.ts       # createPkKeyingResolver — throws for a table with no definition
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts
difficulty: medium
----

## What is wrong

Sync records a committed transaction *after* the fact: the engine hands it the batch of
changes, and sync writes its bookkeeping for each one. To write bookkeeping for a row,
it must first work out that row's identity, and that requires the table's definition.

If the table's definition is gone by the time this runs — because the same transaction
dropped it — looking it up throws. The throw is caught, but only at the very top of the
handler, which wraps the *whole transaction*. So one unresolvable table takes down the
recording of everything else in that transaction: other tables' row changes, and the
schema migrations (including the `drop table` itself).

The result is a silent replication hole. The transaction committed locally and the user
sees their data; other devices never hear about any of it. The only trace is a
`[Sync] Error handling transaction commit: ...` console line and an error event.

## How to reproduce

In one transaction: update rows in table `a`, update rows in table `b`, then
`drop table a`. After commit, sync's change log contains nothing from that transaction —
not `b`'s update, not the drop.

The identity lookup failure is already visible in the existing suite's output (the
message reads `No table schema for main.<name> — sync pk identity is unresolvable`),
just not as a dedicated test.

## Why it is new

Before per-row bookkeeping moved to identity-based keys, a missing table definition was
survivable during capture: the code fell back to placeholder column names and wrote
slightly wrong bookkeeping, but the rest of the transaction still recorded. Now the
lookup is mandatory and fatal.

## Expected behavior

A table that cannot be resolved at capture time should cost *only that table's* changes,
not the transaction. Concretely:

- Skip the unresolvable table's row changes, log which table and how many changes were
  dropped, and continue recording the rest of the transaction.
- Consider whether a drop should instead be handled up front: if the transaction contains
  a `drop table X`, X's row changes in that same transaction arguably should not be
  captured at all — the drop supersedes them — which turns an error path into an
  intentional skip.
- Whatever is chosen, the `drop table` schema migration itself must still replicate.

Worth deciding at the same time: whether dropping a table should also purge that table's
leftover sync bookkeeping, so a later table of the same name does not inherit a previous
incarnation's history. (This was flagged during review of `bug-sync-pk-metadata-key-identity`
as an open question and belongs with this work if the answer is yes.)

## Test coverage to add

- One transaction mixing a dropped table's row changes with an untouched table's row
  changes: the untouched table's changes must reach a peer.
- The `drop table` migration itself must reach a peer from that same transaction.
