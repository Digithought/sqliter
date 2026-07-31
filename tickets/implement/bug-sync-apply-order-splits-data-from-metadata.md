description: When a device receives a batch of changes in an unexpected order, it can delete a row from its tables while still believing it has the row — and then tell other devices the row exists. Make the receiving code sort the batch by timestamp so the tables and the bookkeeping always agree.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts   # applyChanges + drainTableGroup — build the store apply list here
  - packages/quereus-sync/src/sync/store-adapter.ts       # buildRowOp — arrival-order replay; its NOTE points at this ticket
  - packages/quereus-sync/src/sync/protocol.ts            # DataChangeToApply (carries no HLC — deliberately unchanged)
  - packages/quereus-sync/test/sync/_peer-harness.ts      # makePeer / relay — the repro runs on real Database peers
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts  # existing in-batch delete + re-creation specs
  - docs/sync.md                                          # § Conflict Resolution ~line 127, § Change log invariant ~line 378
difficulty: medium
repro: verified
----

## What is wrong

Two layers answer "which write survives" by two different rules:

- **`change-applicator.ts`** resolves and reconciles by **HLC** (`resolveChange`,
  `reconcileInBatchDeletes`).
- **`store-adapter.ts`** decides what the actual table row becomes by replaying
  each row group in **arrival order** (`buildRowOp`), because the internal
  `DataChangeToApply` record carries no timestamp.

They agree only while arrival order happens to match HLC order.
`getChangesSince` guarantees that for a **single sender**, but `applyChanges`
takes whatever array of transactions its caller hands it and never validates or
re-sorts it. The coordinator's `onBeforeApplyChanges` approval hook
(`packages/sync-coordinator/src/service/coordinator-service.ts:366`) returns a
caller-supplied array, and the REST/WebSocket ingress accepts an arbitrary array
from any client.

## Reproduced (both arms, against real `Database` peers)

Throwaway specs on `test/sync/_peer-harness.ts`, run at `693a48f5`. Both were
confirmed failing before the fix and passing after.

**Arm 1 — delete + re-creation, `allowResurrection: true`.** Origin does three
local transactions on `orders` row 1: insert `'x'`, delete, insert `'y'`.
Receiver applies `[...sets].reverse()`:

```
[in-order  ] rows [{"id":1,"note":"y"}]  cells [id, note]  relays delete + id=1 + note='y'
[reordered ] rows []                     cells [id, note]  relays delete + id=1 + note='y'
```

The reordered receiver has **no table row** but identical bookkeeping to the
correct receiver — so it advertises row 1 to every peer while not having it.

**Arm 2 — two senders writing one column, default config.** Peer A inserts
`(7,'a')`; A relays to B; B updates `note='b'`. A caller merges both peers'
changesets into one array (`[...fromB, ...fromA]`) — exactly what the
coordinator hook can produce:

```
[recv] table note = "a"      <- store kept the last-arriving write
[recv] cell  note = "b"      <- metadata kept the max-HLC write
```

Note arm 2 is **not** reachable from a single sender's `getChangesSince` output:
the change log keeps at most one entry per `(pk, column)`, so one sender never
emits two facts for the same column. It needs a caller that merges two senders'
batches — which the coordinator ingress does not prevent.

## The fix

Order the store apply list by HLC in the one place that still has the HLCs —
`change-applicator.ts`, where `ResolvedChange.dataChange` is collected. Do **not**
add an HLC to `DataChangeToApply` (it is threaded through the whole store seam)
and do **not** validate/reject unordered input (that would reject batches the
coordinator legitimately assembles). Make `applyChanges` order-**independent**
instead, and say so in its contract.

Prototype validated locally: `@quereus/sync` **594 passing, 0 failing** with the
change in place. The prototype was reverted before this handoff — the tree is
clean, so the implementer applies it fresh together with the tests and docs.

```ts
/**
 * Order one reconciled batch's store operations by HLC.
 *
 * `DataChangeToApply` carries no timestamp, so the store adapter replays each row
 * group in ARRIVAL order ({@link buildRowOp}) while resolution and
 * {@link reconcileInBatchDeletes} decide by HLC. `applyChanges` takes whatever
 * transaction array its caller hands it — the coordinator's approval hook and the
 * REST/WebSocket ingress neither preserve nor produce timestamp order — so arrival
 * order is not trustworthy. Sorting here, in the one place that still holds the
 * HLCs, makes the table contents follow the same rule as the metadata whatever
 * order the batch arrived in. Stable: equal HLCs keep arrival order (an identical
 * HLC is the same fact).
 */
function orderDataChangesByHLC(applied: readonly ResolvedChange[]): DataChangeToApply[] {
	const withOps = applied.filter(
		(resolved): resolved is ResolvedChange & { dataChange: DataChangeToApply } =>
			resolved.dataChange !== undefined,
	);
	withOps.sort((a, b) => compareHLC(a.change.hlc, b.change.hlc));
	return withOps.map(resolved => resolved.dataChange);
}
```

Both call sites already accumulate `resolvedDataChanges` (every `'applied'`
outcome, in reconciled order), so the incremental `dataChangesToApply.push(...)`
in `applyChanges` and in `drainTableGroup` is dropped and replaced by one
`const dataChangesToApply = orderDataChangesByHLC(resolvedDataChanges);` before
each `admitGroup` call.

Why a global sort is safe: the adapter groups by table, then by row, so only the
relative order *within one row group* is load-bearing. `compareHLC` is a total
order over `(wallTime, counter, siteId, opSeq)`, and `Array.prototype.sort` is
stable, so equal HLCs (the same fact) keep arrival order.

Why it lands the resurrection case right: `reconcileInBatchDeletes` already
skipped every column change at or below the winning delete's HLC, so the only
column ops left for that row are strictly later than the delete — the sort puts
the delete first and `buildRowOp` rebuilds the row from primary key + nulls,
which is what the metadata says happened.

## Schema migrations — the same assumption, unverified

`schemaChangesToApply` is also built in arrival order, so a reordered batch could
run `drop_table` after the `create_table` that should follow it. Not reproduced —
treat it as a check to run, not a stated defect. `pendingSchemaMigrations` carries
each `migration.hlc`, so sorting is available if the check finds a real ordering
dependency. Watch the `schemaVersion ?? getCurrentVersion() + 1` fallback in
`applyChanges`, which reads storage per migration in arrival order.

## Contract

`applyChanges` accepts a transaction array in any order and produces the same
state as the HLC-ordered array. Say that in its doc comment and in `docs/sync.md`,
so the coordinator and any future ingress can rely on it rather than each
re-deriving an ordering guarantee.

## TODO

- Add `orderDataChangesByHLC` to `change-applicator.ts` and use it at both
  `admitGroup` call sites (`applyChanges`, `drainTableGroup`), replacing the
  incremental `dataChangesToApply` pushes.
- Decide whether `emitRemoteChanges`' payload should be HLC-ordered too — it is
  built from the same reconciled list and carries the same arrival-order
  inversion. Cheap to do; note the decision either way in the handoff.
- Check the schema-migration arm above: either sort `schemaChangesToApply` /
  `pendingSchemaMigrations` by HLC, or record why arrival order is safe there.
- Replace the `NOTE` block at `buildRowOp` (`store-adapter.ts`) — it currently
  describes the defect and names this ticket. State instead that the caller
  delivers HLC-ordered ops, and where that ordering is established.
- Document the order-independence contract on `applyChanges` and in `docs/sync.md`
  (§ Conflict Resolution's in-batch paragraph ~line 127 already claims one batch
  equals separate batches — that claim is only true once this lands).
- Tests in `packages/quereus-sync/test/sync/` on the real-peer harness:
  - reversed changeset array + `allowResurrection: true` leaves the re-created row
    present in `select * from orders` AND in the cell records, matching the
    in-order receiver exactly (state + what `getChangesSince` relays to a third
    site id).
  - reversed array under the default `allowResurrection: false` leaves the row
    deleted in both places.
  - two senders' batches merged with the later-HLC sender first: table value and
    cell record both end at the max-HLC value.
  - a drain (`drainTableGroup`) equivalent for at least one of the above — held
    entries come back HLC-ordered today (`buildQuarantineKey` puts the HLC bytes
    first), so this pins that rather than exercising a live inversion.
- Run `yarn lint`, `yarn typecheck`, `yarn test` before handing off.
