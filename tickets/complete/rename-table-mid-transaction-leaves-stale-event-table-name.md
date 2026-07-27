---
description: Renaming a table part-way through a transaction used to leave the change notifications for earlier writes labelled with the old table name; they are now relabelled so every notification names the table as it exists when the notification is delivered.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                       # renameBatchedEvents + the shared match/store helpers
  - packages/quereus/src/runtime/emit/alter-table.ts                   # call site in runRenameTable (~line 229)
  - packages/quereus/test/alter-table-events.spec.ts                   # 9 cases (engine auto-event + memory-native paths)
  - packages/quereus/test/mv-coarsening-collision-telemetry.spec.ts    # 2 cases added in review — the collision channel
  - packages/quereus-store/test/alter-events.spec.ts                   # 1 case (store path)
  - docs/usage.md                                                      # as-of-delivery contract now covers tableName
  - docs/module-authoring.md                                           # same, plus who upholds it
  - docs/memory-table.md                                               # why the memory module needs no relabel
  - docs/materialized-views.md                                         # collision events are as-of-delivery too
difficulty: medium
---

# What shipped

`ALTER TABLE … RENAME TO` executed inside an open transaction relabels the change events
the transaction has already recorded, so a commit delivers every event under the table's
current name.

`DatabaseEventEmitter.renameBatchedEvents(schemaName, oldTableName, newTableName)` walks
the base batch plus every open savepoint layer of two channels — data events and
maintenance-collision events — matching `(schemaName, tableName)` case-insensitively and
replacing the label. It early-returns when not batching (in autocommit the earlier events
were already delivered under the name the table had at the time, which is correct).
Synchronous and un-failable: it moves no value and reads no schema, so unlike the
row-shape sibling `remapBatchedDataEvents` it needs no per-event `try`. `key`,
`oldRow`/`newRow` and `changedColumns` are untouched.

`runRenameTable` calls it after `module.renameTable(...)` and before
`schema.removeTable(oldName)`. Both halves of that ordering matter and are commented in
place: after the module call so a module failure leaves the event batch as untouched as
the catalog, and because the store module's `renameTable` calls `ddlCommitPendingOps()`,
which flushes its queued write events into the engine batch under the old name *during*
that call — they must already be in the batch when the walk runs.

Batched **schema** events are deliberately not relabelled (a schema event records a DDL
operation, not current state — its `objectName` and its `ddl` text would have to be
rewritten together); that is `fix/sync-schema-migrations-replicate-empty-ddl`'s question.

All three producer paths end up correct: the engine auto-event path and the store module
by the engine relabel, the memory module's native path on its own (it stamps `tableName`
at commit from the manager's current name, which the rename already moved).

# Review findings

Reviewed the implement diff (`3d9eacbe`) against the current tree: `database-events.ts`,
`alter-table.ts` (all five `remapBatchedDataEvents` call sites plus `runRenameTable` end
to end), the store module's `renameTable` / `ddlCommitPendingOps` / `finalizeRename`
ordering, the sync engine's `handleTransactionCommit` consumption of the events, all three
test files, and the four docs the diff touched.

**Fixed in this pass (minor):**

- *The collision-channel walk was code-only, untested.* The implement handoff judged the
  fixture too expensive to build. It is not — `mv-coarsening-collision-telemetry.spec.ts`
  already had the exact shape, so two cases were added there: a mid-transaction rename of a
  coarsened-key materialized view with a colliding merge batched under the old name, and
  the savepoint-layer variant that exercises the `collisionEventLayers` arm specifically.
  Both assert the delivered `tableName` *and* that the committed-collision counter keys on
  the new name. Mutation-checked: disabling the collision walk fails both and nothing else.
- *Three copies of the `(schema, table)` match rule and two of the store enumeration.*
  Extracted `namesTable(event, schemaLower, tableLower)` (module-level) and
  `allDataEventStores()` / `allCollisionEventStores()` (private), now used by both
  `remapBatchedDataEvents` and `renameBatchedEvents`. Single-sources the matching rule, so
  a future change to it (matching by module, say) cannot hit one walk and miss the other.
- *`docs/materialized-views.md` did not mention the collision channel's new behavior* even
  though the code now relabels it. Added one sentence to § Coarsened backing keys.

**Filed as new work (major):**

- `backlog/bug-alter-primary-key-leaves-stale-event-key` — the same as-of-delivery contract
  is broken for the event's `key` field: `alter table t alter primary key (a, b)` after a
  write in the same transaction delivers the row's key as the retired single-column value.
  Reproduced on a plain `new Database()`; a consumer cannot match a key of the wrong arity,
  so the write is silently dropped or lands under a phantom identity. **Not a regression
  from this ticket** — no ALTER arm has ever rewritten `key`, and a rename correctly leaves
  it alone.

**Checked and clean (no finding):**

- *Ordering hazards.* Relabelling at rename time (rather than at flush) is what makes the
  composite cases right, and they are all covered: chained renames, the three-step name
  swap, and `create t` → write → `rename to t2` → `create t` again → write, where a
  flush-time pass would mislabel the second table's events. No producer queues an
  old-named event after the walk: the store flushes inside `renameTable` (before), and the
  memory module stamps at commit from its current name (after, but correctly).
- *Scope of the collision walk.* Complete rather than partial: every structural ALTER on a
  maintained table is rejected up front (`alter-table.ts:89`), so RENAME TO is the only
  ALTER whose fixup that channel can ever need. There is no missing `remapBatchedDataEvents`
  equivalent for collisions.
- *Other rename entry points.* `runRenameTable` is the only one; the isolation layer emits
  no events of its own, and no module-side path mints a table-named event outside the three
  producers already covered.
- *`{ ...event }` fidelity.* `remote`, `key`, `changedColumns` and both row images survive
  the relabel; asserted by the update/delete cases.
- *Docs.* All four files the diff touched were read against the new code and are accurate;
  the one gap (materialized-views.md) is listed above. No other doc describes the event
  contract.
- *Lint / tests.* `yarn build`, `yarn lint`, `yarn test` from the repo root: clean, 7383 +
  1077 + the rest passing, 0 failing. No pre-existing failures surfaced, so
  `tickets/.pre-existing-error.md` was not written.

**Tripwires (noted, not ticketed):**

- *A synced peer loses slightly more, not less, across a mid-transaction rename.* The sync
  engine logs each data event under `event.tableName`, so pre-rename rows now go on the
  wire under the new name — which the peer does not have, because no ALTER replicates any
  DDL text today. Before this change those rows landed in the peer's still-old-named table.
  The peer was already diverging from the moment of the rename either way, and both halves
  are the *same* already-tracked root cause: `fix/sync-schema-migrations-replicate-empty-ddl`
  (no `ddl` on any ALTER event) and
  `backlog/bug-alter-table-emits-no-schema-event-without-native-module-emitter` (the engine
  auto-event path emits no ALTER schema event at all). Parked at the `runRenameTable` call
  site, where the existing `NOTE:` already routes the reader to that ticket — no new comment
  was needed. Not a reason to hold this change: the relabel is what makes the events
  self-consistent once rename replication lands.
- *`database-events.ts` is ~1030 lines* and the class carries listeners, batching, savepoint
  layers, collision counting and module hookup. Not split now — the seams are clean and the
  file is navigable — but it is the obvious candidate the next feature on this class should
  split rather than extend.

**Known gap accepted as-is:** `begin; create table t; insert; alter table t rename to t2;
commit` still delivers a `create` schema event naming `t` alongside data events naming
`t2`. Deliberate, documented at the call site, and owned by
`fix/sync-schema-migrations-replicate-empty-ddl`.

# Deferred assertion — restore when the memory-module fix lands

`fix/memory-table-rename-with-savepoint-loses-transaction-rows` (filed during implement):
on the memory module, a transaction that renames a table *and* uses a savepoint silently
discards every row the transaction wrote — `MemoryTableManager.renameTable` mints a new
`tableSchema` object without calling `adoptSchemaOnOpenLayers`, so `commitTransaction`'s
reference-identity guard (`layer/manager.ts:471`) refuses to publish the savepoint
snapshot. Independent of this ticket's diff.

Consequence here: the savepoint-and-rename cases in `alter-table-events.spec.ts` assert
only the delivered event names, not that the rows survived. The DROP COLUMN twin asserts
row survival; the RENAME twin carries a `NOTE:` in its place. **Restore that row assertion
once the fix lands** — right now the file would pass even if the rename kept losing data.
