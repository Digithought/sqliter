description: Added tests for two rarely-hit safety checks in the transaction layer's handling of primary-key sort-order changes, so a future refactor that breaks either one now turns a test red.
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new test + 2 helpers in the "foreign overlays under a cross-connection PK re-key" suite
  - packages/quereus/test/memory-vtable.spec.ts               # new "TransactionLayer.rekeyPrimaryKey deletion replay" suite
  - packages/quereus-isolation/src/isolation-module.ts        # comment-only: NOTE on the foreign-poison branch
difficulty: medium
----

# Coverage added for two primary-key re-sort safety paths

Both paths were believed correct going in; this ticket was coverage, not a bug hunt. No
behavior changed. The only non-test edit is a comment (see *Tripwire* below).

## What was covered

### 1. A second connection's staged rows refuse the re-sort for the *retryable* reason

Changing the collation of a primary-key column re-sorts the table. Every other open
connection's uncommitted staging area has to adopt that change or be marked "poisoned" (its
owner is told at its next read/write/commit and recovers by rolling back).

Two refusal kinds route to poison. A genuine duplicate — two staged rows collapsing onto one
key — was already tested. The *retryable* refusal was not: the storage module raises it when
the change is unrepresentable given the connection's savepoint history, and it must poison
that one connection rather than abort the connection that issued the change.

New test: `poisons a foreign overlay whose staging table refuses the re-key as RETRYABLE`
(`packages/quereus-isolation/test/isolation-layer.spec.ts`).

The existing tests in that suite could not reach it because they write every staged row at
once with no transaction open — those writes autocommit, leaving a one-layer history that can
always be re-sorted. The new helper `injectOverlayRowsBehindSavepoint` opens a real
transaction on the staging table, writes the rows, then takes a savepoint, so the rows sit in
an immutable snapshot a later `rollback to` could restore. Two rows that collide under the new
sort order cannot both live in a re-sorted staging table, so the storage module refuses.

The test asserts all three outcomes the routing has to get right:
- the issuing connection's change still applies (returned schema *and* the live shared table),
- the second connection is poisoned and its commit then aborts,
- the refusal was **not** silently absorbed — the staging table object is the same one
  (adopted in place, not swapped) and never adopted the new sort order.

### 2. A replayed deletion must remove the row it actually deleted

Deep in the memory table, re-sorting rewrites each open transaction layer. A deletion recorded
in a layer is replayed by looking its key up in the already re-sorted parent — and under the
new order that lookup can land on a *different* row whose key now compares equal. Deleting
that row would silently discard data the transaction had just written. A check confirms, under
the *old* sort order, that the row found is the row this layer removed.

New suite: `TransactionLayer.rekeyPrimaryKey deletion replay`
(`packages/quereus/test/memory-vtable.spec.ts`), two tests:
- **the guard fires** — parent layer stages `'a'`, child layer deletes `'A'`; after a
  BINARY→NOCASE re-key the child's replayed deletion finds the parent's `'a'`, and must leave
  it alone (and leave no deletion in the replay log).
- **the guard is not over-broad** — same chain but the child deletes `'a'`, the row it really
  removed; the replay must still delete it.

As the ticket predicted, no end-to-end route reaches this: an earlier validation pass refuses
every chain that could produce the arrangement. The tests therefore build the layer chain
directly (`BaseLayer` + two `TransactionLayer`s, re-keyed oldest-first), bypassing the manager
and hence that pass. The existing `TransactionLayer.hasChanges()` suite in the same file is
the precedent for that style.

## Validation performed

- `yarn build` — clean.
- `yarn test` (all workspaces) — green, 0 failing. No pre-existing failures surfaced;
  `tickets/.pre-existing-error.md` was not written.
- `yarn lint`, `yarn typecheck` — clean (the isolation package's `typecheck` type-checks its
  spec files too).
- **Mutation-checked all three new tests** — each was re-run against a deliberately broken
  source and confirmed to fail, then the source was reverted:
  - route the retryable refusal to a rethrow instead of poison → the isolation test fails with
    the storage module's `BUSY` escaping out of `IsolationModule.alterTable`, confirming the
    test really drives `assertNoPrimaryKeyCollisionInLayer` (the representability arm) on a
    *foreign* overlay and not the already-covered duplicate arm.
  - disable the deletion-identity check → test 1 fails, the parent's row is gone.
  - make the check always refuse → test 2 fails, the child's own deletion is skipped.
  `git status` after the run shows only the intended files modified.

## Suggested review focus / known gaps

- **The isolation test is white-box, like the rest of its suite.** The second connection's
  staging area is built by hand (create staging table → `begin` → writes → `savepoint`) rather
  than by a second `Database` running real SQL. That matches how every other test in the
  suite injects staged state, but it does mean the engine's own route to this shape
  (connection B runs DELETE + INSERT + SAVEPOINT, connection C then issues the ALTER) is still
  unexercised end-to-end. Making that real would need one table visible in two database
  catalogs, which is a bigger change than this ticket. Worth a reviewer's judgement on whether
  it is worth filing.
- **The unit test constructs an arrangement the engine refuses upstream.** That is by design
  (it is the only way to reach the check), but it means the two tests pin the check's contract
  rather than any reachable end-user scenario. If a reviewer decides the check should instead
  be deleted and the validation pass relied upon, these tests are what would have to go with
  it — the ticket's original reasoning was the opposite, keep the check so the validation pass
  can be loosened later.
- The unit tests reach into layer internals (`recordUpsert` / `recordDelete` / `getOwnWrites`
  / `getModificationTree`). They will need updating if that surface moves. All of it was
  already public and already used by the neighbouring `hasChanges()` suite.

## Tripwire parked

Noticed while tracing the foreign-overlay path: when the primary-key re-sort is refused *after*
the migration has already dropped collapsed deletion markers from that staging area, the drops
are not undone (the connection that issued the change does undo its own). Harmless today —
poison is terminal, so the only exit is a rollback that discards the staging area whole. Parked
as a `NOTE:` comment on the poison branch in
`packages/quereus-isolation/src/isolation-module.ts` (`applyInPlaceOverlayChange`), the one
place a future change to poison recovery would have to read. This is the only non-test edit in
the diff.
