---
description: Fixed a crash where deleting a row from a table that other tables point at with "on delete cascade" could fail the commit with an internal error; needs a review pass.
files:
  - packages/quereus/src/vtab/memory/layer/interface.ts (new noteDerivedChild / hasDerivedChildren on Layer)
  - packages/quereus/src/vtab/memory/layer/transaction.ts (counter + constructor call + clearBase precondition doc)
  - packages/quereus/src/vtab/memory/layer/base.ts (counter)
  - packages/quereus/src/vtab/memory/layer/manager.ts (promoteCommittedHead, isLayerInUse, chainContains, disconnect)
  - packages/quereus/test/vtab/layer-collapse-mutated-base.spec.ts (new regression spec)
  - docs/memory-table.md (Layer Promotion / Layer Collapse bullets)
repro: verified
---

# Layer collapse detached a layer other layers were still inheriting from

## What was wrong

`MemoryTableManager.tryCollapseLayers()` called `clearBase()` on the committed head while
other live BTrees were still built over that head's trees. `inheritree` tracks its
base-immutability contract with a version total (`chainVersion()`); dropping the base
pointer removes the base's whole contribution from that total, so every already-derived
child's snapshot instantly stops matching and its next `checkBase()` throws
`MutatedBaseError` — with no row having moved. The throw surfaces one step later, in the
`TransactionLayer` constructor (`new BTree(…, { base })` calls `base.getCount()`, which
calls `checkBase()`).

## What changed

**The fix (this is the load-bearing part).** `Layer` gained `noteDerivedChild()` /
`hasDerivedChildren()`, implemented as a plain counter on both `BaseLayer` and
`TransactionLayer`. The `TransactionLayer` constructor calls `parent.noteDerivedChild()`
before it builds anything over the parent, and `promoteCommittedHead()` refuses to promote
a layer that reports derived children. The counter never decrements — there is no
layer-destruction hook, and the manager's `connections` map cannot serve as a liveness
registry because `disconnect` removes connections that are still live and are committed
later (`MemoryTable.ensureConnection` reuses exactly such a connection).

**Adjacent gaps, defence in depth.**
- `disconnect()` now defers on `connection.hasOpenWork()` instead of "has an uncommitted
  pending layer". After an eager savepoint the connection's uncommitted rows live in
  `readLayer` with `pendingTransactionLayer === null`, so the old test dropped a live
  connection from the map.
- `isLayerInUse()` now walks **both** `readLayer`'s and `pendingTransactionLayer`'s
  ancestor chains, each to the chain root, instead of only the pending chain (which
  additionally stopped early on a non-`TransactionLayer`).
- `tryCollapseLayers()` no longer loops. The old `while` re-tested
  `_currentCommittedLayer`, which its body never reassigned, so a collapsible head was
  `clearBase()`d up to ten times per call. Promotion detaches the head but leaves it where
  it is, so there is never a second layer to promote; the body moved into
  `promoteCommittedHead()`, called once.
- Two hand-rolled ancestor walks in `commitTransaction` were folded into the new
  `chainContains()` helper (identical logic, both guarded so the rewrite is exact).

## Use cases to test / validate

New spec: `packages/quereus/test/vtab/layer-collapse-mutated-base.spec.ts`.

1. **Cascade with zero matching child rows** — parent `P`, child `C` with
   `references P(id) on delete cascade`, no rows in `C`. `delete from P where id = 2`
   followed by an unrelated `update`. This is the minimal trigger: the cascade still opens
   and releases a savepoint on the parent's connection but deletes nothing, so the layer
   ordering that dodges the bug when child rows exist never happens.
2. **Cascade with real child rows** — same shape with rows present. Passed before the fix
   too; kept so the guard cannot be "fixed" by breaking this path.
3. **Two interleaved write chains on one `Database`** — `insert` into an unreferenced
   table plus `insert or replace` into a table a `on delete cascade` foreign key points at
   (the replace runs the delete side, hence the same path), two chains under
   `Promise.all`. Asserts all 6 event rows land and both state rows reach their final
   value.

Verified the spec actually reproduces: with the guard and the `disconnect` change
temporarily disabled, cases 1 and 3 fail with exactly the reported
`MutatedBaseError … at new TransactionLayer … at MemoryTableManager.commitTransaction`;
case 2 passes. Restored, all three pass.

Other things worth exercising by hand: savepoint-heavy transactions (`savepoint` /
`rollback to` / `release`) on a table with cascading foreign keys, and an `alter table`
inside an explicit transaction on such a table — both touch the connection-liveness code
the `disconnect` change moved.

## Validation run

| check | result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` (whole monorepo) | all green — 8700 passing in `packages/quereus`, 0 failing anywhere |
| `yarn lint` | clean |
| `yarn typecheck` | clean |
| `yarn workspace @sitecad/sim test --run lifecycle` (consumer, against rebuilt dist) | 12 passed (was 1 failing) |
| `yarn workspace @sitecad/site-cad test ground-model` (consumer) | 92 passed (was 1 failing) |

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## Known gaps — please look here first

- **Phase 2 has no failing-before test.** The Phase-1 guard alone fixes both reproductions
  (measured: with only `hasDerivedChildren` restored and the `disconnect` change still
  disabled, all three cases pass). The `disconnect` / `isLayerInUse` / loop changes are
  reasoned fixes for independently-reachable gaps, not test-driven ones — nothing in the
  suite fails if they are reverted. If the reviewer wants them nailed down, they need
  targeted unit tests against `MemoryTableManager` internals rather than SQL-level ones.
- **Collapse is now rarer, and it was already not firing.** Measured on 50 autocommit
  inserts into one table: the primary BTree's base chain is 51 deep both before and after
  this change — `tryCollapseLayers` never promoted anything in that workload either way.
  So this is not a regression, but it does mean nothing reclaims the layer chain for a
  long-lived table, and the guard makes that permanent rather than incidental. The tripwire
  is parked as a `NOTE:` comment at the guard site in
  `MemoryTableManager.promoteCommittedHead` (`manager.ts`): if layer-chain memory growth
  ever shows up, switch the promotion to inheritree's `BTree.flatten()` — a real O(n)
  independent copy that leaves the old tree valid for its children — behind a chain-depth
  threshold, rather than loosening the guard.
- **Residual, not covered by the new guard:** `hasDerivedChildren()` protects trees derived
  *from* the promoted layer. It says nothing about a reader still holding the promoted
  layer's *former base* — and per inheritree's docs `clearBase()` is a pointer drop, so the
  promoted tree keeps sharing nodes by identity with that base. `isLayerInUse` covers this
  only for connections still attached to `manager.connections`, which is not authoritative.
  Not reachable from any test I could construct; `flatten()` is the real answer if it ever
  bites.
- **`isLayerInUse` was deliberately not widened to `knownConnections()`** (which would also
  cover registered-but-detached connections). It would be more correct in principle and
  would block collapse in essentially every case, since any view of the head reaches the
  head's parent. Left as-is; noted here because it is the obvious "why not just…".
- **New retention path in `disconnect`.** A connection with an eager savepoint snapshot now
  stays in `manager.connections` until it commits or rolls back. Previously that retention
  applied only to uncommitted pending layers. A transaction abandoned without either would
  hold the connection (and its layer chain) alive. The same hazard already existed for
  pending layers, so this widens it rather than introducing it.
