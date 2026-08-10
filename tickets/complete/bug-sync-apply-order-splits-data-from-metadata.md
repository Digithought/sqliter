description: A device receiving a batch of changes out of order could delete a row from its tables while still recording that it had the row — and then advertise that row to other devices. The receiving code now sorts each batch by timestamp before touching the tables, so tables and bookkeeping always agree.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts              # orderDataChangesByHLC + orderMigrationsByHLC + ordered emitRemoteChanges
  - packages/quereus-sync/src/sync/store-adapter.ts                  # buildRowOp: caller-supplies-HLC-order contract
  - packages/quereus-sync/src/sync/manager.ts                        # SyncManager.applyChanges doc
  - packages/quereus-sync/test/sync/apply-order-independence.spec.ts # 7 specs on real Database peers
  - docs/sync.md                                                     # § Conflict Resolution
----

## What shipped

Two layers answered "which write survives" by two different rules. `change-applicator.ts`
resolved and reconciled by hybrid logical clock (HLC) timestamp; `store-adapter.ts`
decided what the table row actually became by replaying each row group in **arrival**
order, because `DataChangeToApply` carries no timestamp. They agreed only while arrival
order matched HLC order — true for one sender's `getChangesSince`, not true for the
arrays `applyChanges` actually receives (the coordinator's `onBeforeApplyChanges` hook
returns a caller-supplied array; REST/WebSocket ingress accepts an arbitrary array).

Three lists leave `change-applicator.ts` as plain arrays replayed in list order; all
three are now HLC-sorted there, in the one place that still holds the HLCs:

- `orderDataChangesByHLC(resolvedDataChanges)` — the store apply list, built once per
  `admitGroup` call (both `applyChanges` and `drainTableGroup`).
- `orderMigrationsByHLC(changes)` — the DDL list; the per-changeset migration loop was
  hoisted into a batch-wide `PHASE 1a` pre-pass.
- `emitRemoteChanges` — sorts before grouping by site, so both call sites get it.

Both sorts are stable and `compareHLC` is a total order over
`(wallTime, counter, siteId, opSeq)`, so equal HLCs — the same fact — keep arrival
order. A global sort suffices because the adapter groups by table then row, so only
order *within one row group* is load-bearing.

## Review findings

### Verified as correct

- **`compareHLC` really is a total order.** The claim the whole fix rests on holds:
  `clock/hlc.ts:77` compares all four components, `opSeq` last, so two facts from one
  transaction are ordered rather than tied.
- **A global sort is sufficient.** `store-adapter.ts` `groupChangesByTable` /
  `groupChangesByRow` both push in list order into `Map`s, so each row group preserves
  the sorted relative order. Table-group iteration order changes (now first-appearance
  by HLC), which the adapter's own comment states is not a dependency order.
- **The other two `applyToStore` drivers already honor the new contract.**
  `snapshot.ts:204` sorts each table's cells by HLC before building its ops;
  `snapshot-stream.ts` reconciles cells per row before flushing, so it emits one op per
  row and has no ordering dependency. The `store-adapter.ts` doc's "anything else
  driving this callback owes it the same ordering" is accurate, not aspirational.
- **The DDL hoist is behaviour-preserving.** The migration loop only *reads*
  (`getCurrentVersion`, `getMigration`) and appends to two lists; nothing it does
  affects, or is affected by, data resolution. `computeBatchTableDelta` was already
  batch-wide, so the unknown-table gate sees the same answer as before.
- **The sort helps under a custom `conflictResolver` too.** Two same-cell changes in one
  batch both resolve against pre-batch state, so both can be `'applied'`; the metadata
  collapse (`keepMaxHLC`) is HLC-based regardless of the resolver, and the data list now
  matches it. Pre-fix the table could hold the resolver's loser.
- **The coordinator needs no change.** `sync-coordinator/src/service/coordinator-service.ts:366`
  substitutes `result.approved` wholesale for the batch, confirming the hook really can
  reorder — which is exactly what the new contract absorbs.

### Fixed in this pass (minor)

- **Overclaimed order-insensitivity.** Both the `applyChanges` doc comment and
  `docs/sync.md` § Conflict Resolution said everything outside the three sorted lists is
  "order-insensitive by construction", enumerating only counters / quarantine holds /
  watermark. Two observable things are not: `onConflictResolved` fires from the resolve
  loop in arrival order, and an `onUnknownTable` event reports the *first* changeset that
  referenced the table as the straggler origin, so a reordered batch can name a different
  relayer. Both are telemetry, never stored facts — the committed-state guarantee stands.
  Narrowed the claim in both places rather than changing behaviour.

- **Two test gaps closed** (`apply-order-independence.spec.ts`, now 7 specs):
  - *`onRemoteChange` payload is HLC-ordered even when the batch was not.* The implement
    handoff flagged this sort as asserted only indirectly. **Proven to catch the defect**:
    with the `emitRemoteChanges` sort removed the spec fails
    (`expected 'column' to equal 'delete'`).
  - *Reversed batch carrying DDL and data for one table.* Passes with either sort removed,
    so it is a **pin, not a repro** — labelled as such in the spec. One sender's change log
    keeps at most one entry per `(pk, column)`, so reversing its changesets cannot invert
    two writes to one cell, and a single `create_table` has nothing to be ordered against.
    It pins the DDL-before-DML relation across a reordered array.

### Filed as a new ticket (major)

- **`tickets/fix/bug-sync-batch-of-drop-then-recreate-hides-the-table`** — the same
  order-blindness the fix removed from the *replay* of schema steps survives in what the
  receiver *concludes* from them. `computeBatchTableDelta` collects `create_table` and
  `drop_table` into two plain sets and the admission gate reads
  `(inBasis || created) && !dropped`, so a batch carrying create → drop → create for one
  table diverts every row for it, even though the HLC-ordered schema steps leave the
  table present. The post-apply reactive drain skips the table for the same reason.
  **Reproduced on real peers**: `{applied: 3, skipped: 0, conflicts: 0, transactions: 4,
  unknownTable: 2}` with the table present and empty; a later `drainHeldChanges()`
  returns 2 and the row appears. Convergence delay under the default `quarantine`
  disposition; permanent row loss under `ignore`. Distinct code site from this ticket's
  diff, hence a ticket rather than an inline fix. Checked the board first — the two
  existing sync tickets touching this file
  (`bug-sync-recreated-table-inherits-dropped-table-metadata`,
  `bug-sync-migration-version-key-ignores-object-kind`) address different sites.

### Tripwire carried forward from implement

`change-applicator.ts` PHASE 1a, at the `migration.schemaVersion ?? getCurrentVersion() + 1`
fallback: a `NOTE:` records that the fallback reads storage no migration in this batch
has written yet, so two same-table migrations that both omit `schemaVersion` would
collapse onto one `sm:` key. Unreachable today (`SchemaMigration.schemaVersion` is
required and `collectSchemaMigrations` always carries the stored value), so it stays a
comment at the site. Confirmed still accurate.

### Deliberately not raised

- **Comment and doc volume.** The three rationale blocks (code comment, interface doc,
  `docs/sync.md`) restate each other at length. Left alone: the surrounding file — and
  `admission.ts`, `store-adapter.ts`, the rest of `docs/sync.md` — is uniformly written
  this way, so trimming here would make the change read as the odd one out.
- **Remaining DDL-ordering coverage.** `add_index` / `drop_index` / the `*_column`
  kinds replay through the same sorted list as `create_table` / `drop_table`; there is no
  per-kind branch for the sort to get wrong, so the untested kinds are not a distinct
  risk. Not filed.
- **Row pk spelling under collation-variant keys.** `buildRowOp` takes `changes[0].pk`,
  which is now the min-HLC spelling instead of the first-arriving one, while the metadata
  files the max-HLC spelling. Both are valid addresses for one identity; the divergence
  is pre-existing and already documented at `snapshot.ts:198`. Not a regression.

## Validation

- `yarn workspace @quereus/sync run test` — **601 passing, 0 failing** (599 before, +2 new).
- `yarn test` (whole workspace) — clean, exit 0. No pre-existing failures surfaced.
- `yarn typecheck` — clean. `yarn lint` — clean.
