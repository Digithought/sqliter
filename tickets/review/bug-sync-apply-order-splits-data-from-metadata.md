description: A device receiving a batch of changes out of order could delete a row from its tables while still recording that it had the row — and then advertise that row to other devices. The receiving code now sorts each batch by timestamp before touching the tables, so tables and bookkeeping always agree.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts              # the fix: orderDataChangesByHLC + orderMigrationsByHLC + ordered emitRemoteChanges
  - packages/quereus-sync/src/sync/store-adapter.ts                  # buildRowOp NOTE replaced with the caller-supplies-HLC-order contract
  - packages/quereus-sync/src/sync/manager.ts                        # SyncManager.applyChanges doc: order-independence contract
  - packages/quereus-sync/test/sync/apply-order-independence.spec.ts # NEW — 5 specs on real Database peers
  - docs/sync.md                                                     # § Conflict Resolution, after the in-batch paragraph (~line 129)
difficulty: medium
----

## What was wrong

Two layers answered "which write survives" by two different rules:

- `change-applicator.ts` resolved and reconciled by **HLC**.
- `store-adapter.ts` decided what the actual table row became by replaying each row
  group in **arrival order** (`buildRowOp`), because `DataChangeToApply` carries no
  timestamp.

They agreed only while arrival order happened to match HLC order. `getChangesSince`
guarantees that for a *single sender*, but `applyChanges` takes whatever array its
caller hands it and never validated or re-sorted it — the coordinator's
`onBeforeApplyChanges` approval hook returns a caller-supplied array, and the
REST/WebSocket ingress accepts an arbitrary array from any client.

## What changed

Three lists leave `change-applicator.ts` as plain arrays replayed in list order.
All three are now HLC-sorted there — the one place that still holds the HLCs — rather
than adding an HLC to `DataChangeToApply` (threaded through the whole store seam) or
rejecting unordered input (which would reject batches the coordinator legitimately
assembles):

- **`orderDataChangesByHLC(resolvedDataChanges)`** — the store apply list, built once
  before each `admitGroup` call (both in `applyChanges` and in `drainTableGroup`),
  replacing the incremental `dataChangesToApply.push(...)`.
- **`orderMigrationsByHLC(changes)`** — the DDL list. The per-changeset migration loop
  was hoisted out of the data loop into a batch-wide `PHASE 1a` pre-pass over the
  HLC-sorted migrations. **This arm was listed as unverified in the fix ticket; it is a
  real defect and is now verified** (see below).
- **`emitRemoteChanges`** — sorts its entries by HLC before grouping by site. The
  ticket left this as a decision; ordered was chosen. It is built from the same
  reconciled list, so leaving it unordered would hand a listener the batch's facts in
  an order contradicting the state just committed. Ordering lives inside
  `emitRemoteChanges`, so the wire-apply and drain call sites both get it.

Both sorts are stable, and `compareHLC` is a total order over
`(wallTime, counter, siteId, opSeq)`, so equal HLCs — the same fact — keep arrival
order. A global sort suffices for the data list because the adapter groups by table
then by row, so only the relative order *within one row group* is load-bearing.

Contract documented in three places: the `applyChanges` doc comment
(change-applicator.ts), the `SyncManager.applyChanges` interface doc (manager.ts), and
`docs/sync.md` § Conflict Resolution — a new paragraph right after the in-batch
tombstone rule, whose "one batch equals separate batches" claim was only true once this
landed.

## Verification — every arm confirmed by reverting the fix

Each sort was temporarily neutered and the specs re-run, so the tests are proven to
catch the defect rather than merely to pass:

| Arm | With fix | Sort removed |
|---|---|---|
| reversed batch, `allowResurrection: true` | `[{id:1,note:'y'}]` | `[]` (table empty, metadata intact — the split) |
| two senders merged later-HLC-first | table+cell both `'b'` | table `'a'`, cell `'b'` |
| reversed `create_table` + `drop_table` | table absent | table **present** (dropped upstream) |

The other two specs (`allowResurrection: false`; the drain) pass **both** ways — they
are regression pins, not repros. Called out honestly: the drain's held entries already
come back HLC-ordered (`buildQuarantineKey` puts the HLC bytes first), so that spec
pins the contract rather than exercising a live inversion, exactly as the fix ticket
predicted.

## Use cases to exercise / re-check

- **A caller merging two senders' batches.** Not reachable from one sender's
  `getChangesSince` — the change log keeps at most one entry per `(pk, column)`, so a
  single sender never emits two facts for one column. Worth probing the coordinator
  ingress (`packages/sync-coordinator/src/service/coordinator-service.ts:366`) against
  the new contract.
- **A batch reordered in transit.** `[...sets].reverse()` on any real changeset array;
  state must match the in-order receiver's exactly, including what
  `getChangesSince(thirdSite)` relays.
- **DDL reordering beyond create+drop.** Only `create_table` → `drop_table` is pinned.
  `add_index` / `drop_index` and the `*_column` migrations replay through the same list
  and are untested for ordering.
- **`applyChanges` counters.** `ApplyResult` is order-insensitive by construction
  (sums), and the reversed-batch default-config spec asserts the reordered and in-order
  receivers report identical `{applied, skipped, conflicts}` — but only for that one
  shape.

## Known gaps

- **Schema migrations were hoisted out of the per-changeset loop.** DDL still runs
  before all DML (`admitGroup` applies schema changes first), so this is behaviour-
  preserving for an ordered batch — but it is a structural change to `applyChanges`
  worth a careful read, not just a diff skim.
- **Only `create_table`/`drop_table` DDL ordering is tested** (see above).
- **The `emitRemoteChanges` sort is asserted only indirectly.** No spec reads an
  `onRemoteChange` payload's order; the decision rests on the argument above.
- **No spec covers a reordered batch that also carries DDL and data for the same
  table** — `computeBatchTableDelta` already works batch-wide, so this is believed
  fine, but unexercised.
- **A tripwire was parked** (see findings below), not fixed.

## Tripwire parked

`change-applicator.ts`, at the migration loop's `migration.schemaVersion ??
getCurrentVersion() + 1` fallback: a `NOTE:` comment records that the fallback reads
storage no migration in this batch has written yet, so two same-table migrations that
both omit `schemaVersion` would compute the same version and collapse onto one `sm:`
key. Unreachable today — `SchemaMigration.schemaVersion` is a required field and
`collectSchemaMigrations` always carries the stored value — so it is conditional, not a
latent defect. Parked at the site rather than filed.

## Validation run

- `yarn workspace @quereus/sync run test` — **599 passing, 0 failing** (594 before, +5 new).
- `yarn typecheck` — clean (exit 0).
- `yarn lint` — clean (exit 0).
- `yarn test` (whole workspace) — clean (exit 0); no pre-existing failures surfaced.
