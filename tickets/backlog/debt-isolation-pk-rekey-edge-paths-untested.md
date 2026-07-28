----
description: Two rarely-hit safety paths in the transaction layer's collation-change handling have no test covering them, so a future refactor could silently break them without any test going red.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # applyInPlaceOverlayChange — the BUSY→poison routing
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # "foreign overlays under a cross-connection PK re-key" suite
  - packages/quereus/src/vtab/memory/layer/transaction.ts     # installNetOwnWrites — the deletionTargets identity check
difficulty: medium
----

# Untested safety paths in the primary-key collation re-key

Changing the collation of a primary-key column re-sorts the whole table. Two guards were added
to make that safe in edge cases, and neither has a test exercising it. Both are believed
correct; the gap is coverage, not a known defect.

## 1. Another connection's staged rows can't follow the change

When one connection changes a primary-key column's collation, every *other* open connection's
uncommitted staging area has to adopt the same change. If a connection's staged rows can't
physically be re-sorted that way, its staging area is marked "poisoned" — its owner is told at
its next read/write/commit and recovers by rolling back.

Two refusal kinds route to poison: a genuine duplicate (two staged rows collapsing onto one
key), and a *retryable* refusal the storage module raises when the change is unrepresentable
given the connection's savepoint history. The first is tested. The second is not.

Why it wasn't covered: the existing cross-connection tests inject a staging table directly and
write all its rows at once, so its internal history is a single layer and it can always be
re-sorted. Producing the retryable refusal needs a staging area with a real savepoint stack on
a second connection, which the current white-box harness doesn't drive.

**Wanted:** a test where a second connection's staging area refuses the re-sort for the
retryable reason and ends up poisoned (not rethrown, not silently migrated), while the issuing
connection's change still applies.

## 2. A replayed deletion must remove the row it actually deleted

Deep inside the memory table, re-sorting rewrites each open transaction layer. A deletion
recorded in a layer is replayed by looking its key up in the re-sorted parent — and under the
new sort order that lookup can land on a *different* row whose key now compares equal. Deleting
that row would silently discard data the transaction had just written.

A check was added so the replay confirms, under the *old* sort order, that the row it found is
the row it removed. No test reaches it: an earlier validation pass refuses every arrangement
that could trigger it, so the check is pure insurance today.

**Wanted:** a white-box unit test on the transaction layer that constructs the arrangement
directly (bypassing the validation pass) and asserts the unrelated row survives. If that proves
impractical, say so in the ticket's resolution rather than deleting the check — the check is
what lets the validation pass be loosened later without re-introducing the data loss.
