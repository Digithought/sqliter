---
description: Changing a table's primary key part-way through a transaction used to leave the change notifications for earlier writes identifying their rows by the old primary key; those notifications are now rewritten to use the new key before the commit delivers them.
prereq:
files:
  - packages/quereus/src/core/database-events.ts            # rekeyBatchedDataEvents + 3 module-level helpers
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAlterPrimaryKey — both arms call it
  - packages/quereus/test/alter-table-events.spec.ts        # engine auto-event path cases (+11)
  - packages/quereus-store/test/alter-events.spec.ts        # store path cases (+10)
  - docs/usage.md                                           # § Subscribing to Data Changes
  - docs/module-authoring.md                                # § Row-Shape, Table-Name, and Row-Key Contract…
difficulty: medium
---

# What was wrong

A change-notification event (`DatabaseDataChangeEvent`) carries a `key`: the primary-key
values identifying the row it describes. Quereus already guaranteed that a commit's events
describe the table **as it is at delivery** — row images rewritten to the post-ALTER column
layout, table name rewritten across a mid-transaction rename. `key` was not covered, so an
`ALTER TABLE … ALTER PRIMARY KEY` inside a transaction left every event the transaction had
already recorded carrying the *retired* key's values.

Reproduced before the fix (store-backed table, in-memory KV provider):

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using store;
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
commit;
```

delivered `key: [1]` against a committed row `(1, 9, 'x')` under a two-column key. A key of
the wrong arity matches no row a consumer holds, so the write is dropped or filed under a
phantom identity — silently, because the commit reports success.

# What changed

**`DatabaseEventEmitter.rekeyBatchedDataEvents(schemaName, tableName, oldPkIndices, newPkIndices)`**
(`database-events.ts`), the third batched-event fixup beside `remapBatchedDataEvents` (row
shape) and `renameBatchedEvents` (table name). Same shape as the rename relabel: early-return
when not batching, `namesTable()` matcher, `allDataEventStores()` enumeration (base batch +
every open savepoint layer), synchronous, no per-event `try` — it reads no schema and
evaluates no expression, only projecting values already in the row image.

Three module-level helpers alongside it:

- `projectKey(row, indices)` — projection, or `undefined` if any index is out of bounds.
- `keyMatchesImage(row, indices, key)` — whether projecting `row` reproduces `key`, using
  `sqlValueIdentical` (new import from `util/comparison.js`; no cycle, `comparison.ts` pulls
  only `common/` and `types/`).
- `selectKeySourceImage(event, oldPkIndices)` — which image to re-project from: `newRow` for
  an insert, `oldRow` for a delete, and for an update whichever image reproduces the recorded
  `key` under the retired key's columns, falling back to `newRow ?? oldRow` when both match
  (the ordinary case — the update touched no PK column) or neither does.

Best-effort, matching `remapBatchedDataEvents`' stance toward historical images: an event with
no `key`, no usable image, or an image too short for `newPkIndices` keeps its `key` and logs at
warn, rather than failing an otherwise-valid ALTER.

**Both arms of `runAlterPrimaryKey`** (`alter-table.ts`) call it, with `oldPkIndices` from
`tableSchema.primaryKeyDefinition` and `newPkIndices` from the `newPkDef` the function already
builds. The native arm calls it *after* `module.alterTable(...)` returns and *before*
`schema.addTable(...)` — the store's `alterPrimaryKeyChange` runs `ddlCommitPendingOps()`,
which flushes its queued write events into the engine batch **during** that call, so they must
already be in the batch when the walk runs. The rebuild fallback calls it after
`rebuildTableWithNewShape(...)` returns. Both call sites carry the ordering rationale as a
comment, mirroring `runRenameTable`'s.

**Docs**: `docs/usage.md` § *Subscribing to Data Changes* (the `key` table row plus a new
as-of-delivery paragraph); `docs/module-authoring.md` § heading renamed to *Row-Shape,
Table-Name, and Row-Key Contract Across Mid-Transaction ALTER* with a third subsection stating
the same engine-vs-module split of responsibility the section already states for row shape and
table name.

## Ticket TODO that asked a question — answered

> Confirm `tableSchema` inside `runAlterPrimaryKey` is the live schema at run time, not a
> stale build-time snapshot.

**It is live**, so no catalog re-resolution was added. Verified empirically, not by reading:
`create table t (a, z, b, v, primary key (a)); alter table t drop column z; alter table t
alter primary key (b);` lands `primaryKeyDefinition = [{index: 1}]` — index 1 is `b` in the
*post-drop* layout `(a, b, v)`; a stale snapshot would have produced index 2. Holds whether
the two ALTERs are separate `db.exec()` calls or two statements inside one `db.exec()`, and on
both the memory and the store module. Statements compile one at a time as execution reaches
them. Pinned by the `a DROP COLUMN then an ALTER PRIMARY KEY in one transaction compose` case
in both spec files, so a change to that compilation order fails a test rather than silently
mis-keying.

# Validation performed

From the repo root: `yarn build` ✅, `yarn lint` ✅, `yarn typecheck` ✅, `yarn test` ✅
(10,589 passing, 0 failing). `yarn test:store` (LevelDB path) was **not** run — see *Known
gaps*.

`yarn docs:check` fails with 4 pre-existing documentation failures; recorded in
`tickets/.pre-existing-error.md`. Three are on docs this ticket never touched
(`invariants.md`, `runtime.md`, `sync.md`). The fourth is `module-authoring.md` exceeding the
12000-word cap — it was already 12145 words at `HEAD`, and this ticket's required subsection
took it to 12345. Disclosed there in full.

## New test cases

`packages/quereus-store/test/alter-events.spec.ts` (+10) is the **primary** home — the store
re-keys in place, so the rows survive and each delivered `key` is asserted **together with the
committed row** via a new `assertRows` helper. `packages/quereus/test/alter-table-events.spec.ts`
(+11) covers the engine auto-event path with `key` assertions only.

Both files cover: widening `(a) → (a, b)`; narrowing `(a, b) → (a)`; re-keying to a column
absent from the old key (`(a) → (b)` — catches a fix that merely pads or truncates the old
value list); an `update` crossing the re-key; a `delete` crossing it; an event recorded inside
an open savepoint layer; an autocommit ALTER leaving an already-delivered event alone; an ALTER
on one table leaving another's keys alone; `DROP COLUMN` then `ALTER PRIMARY KEY` composing;
and the PK-moving-update neutrality case below. The engine file adds an `onTransactionCommit`
case pinning that the grouped channel carries the same re-keyed `key`.

### The PK-moving-update case is worth a reviewer's attention

The two producers genuinely disagree about which key a PK-moving `update` records — probed
directly on `update t set a = 2 where a = 1`:

| producer | delivered `key` |
|---|---|
| engine auto-event path (memory) | `[1]` — the **pre**-update key |
| store module | `[2]` — the **post**-update key |

That disagreement is `fix/bug-update-event-key-disagrees-across-producers`, deliberately out
of scope here. `selectKeySourceImage` is neutral to it by construction, and the test asserts
neutrality rather than a value: it first runs the same update with **no ALTER** to learn what
key that producer records, then requires the re-keyed run to deliver exactly that key with `b`
appended. Each spec file therefore exercises a *different* branch of the tie-break — the
engine one the `oldRow` branch, the store one the `newRow` branch — and neither will need
editing when the sibling ticket lands.

### Mutation check (as the ticket required)

Disabling the walk (`if (MUTATION) return;` at the top of `rekeyBatchedDataEvents`, rebuilt,
both suites re-run) fails **exactly** the new cases and nothing else:

- engine spec: 9 of 10 new cases fail (the 10th, `an autocommit ALTER PRIMARY KEY does not
  re-key an already-delivered event`, is a negative case and correctly stays green); all 34
  pre-existing cases stay green.
- store spec: 8 of 9 then-present new cases fail, same negative case green; all 6 pre-existing
  cases stay green.

Mutation reverted (`grep MUTATION` is clean; the final full `yarn test` ran against the
reverted tree).

# Known gaps — treat the above as a floor

- **`yarn test:store` (LevelDB) was not run.** It re-runs the `packages/quereus` logic tests
  against the LevelDB store module and routinely exceeds the runner's 10-minute idle budget,
  so it is not agent-runnable inside a ticket. The store path here was exercised through
  `packages/quereus-store`'s in-memory KV provider instead, which drives the same
  `StoreModule.alterPrimaryKeyChange` / `ddlCommitPendingOps` code — but the LevelDB-specific
  layer is unverified by me.
- **`rebuildViaShadowTable` — the third rebuild path — is untested here.** The two modules in
  the repo take the other two paths (memory → `rebuildMemoryTable`, store → native
  `alterTable`), so nothing in-tree reaches the shadow-table rebuild for an ALTER PRIMARY KEY.
  The re-key call sits after `rebuildTableWithNewShape` returns and so covers it by
  construction, but by construction only. A reviewer wanting to close this would need a
  third-party-style module whose `alterTable` throws `UNSUPPORTED` and is not a
  `MemoryTableModule`. Worth a skim of whether that path's DROP+RENAME churn generates its own
  spurious events under the shadow name — if it does, that is a separate pre-existing defect,
  not one this ticket introduced.
- **Cross-connection batches are out of reach**, as they already are for the rename relabel:
  the event emitter is per-`Database`. Under `quereus-isolation` the case is moot — a
  connection with staged rows is refused the ALTER outright (`isolation-module.ts:1336`).
- **No `NOTE:` tripwire was parked** — nothing conditional surfaced. The walk is O(batched
  events for the table) per ALTER PRIMARY KEY, the same cost profile as the two existing
  fixups it sits beside, so there was nothing to flag that the neighbouring code does not
  already imply.
- **The memory rebuild path still loses the transaction's own rows.** Unchanged and untouched
  by this ticket: `fix/bug-alter-primary-key-mid-transaction-loses-memory-rows`. The engine
  spec's new cases therefore assert the delivered `key` **only, never row survival**, with a
  block comment naming that slug — mirroring how the rename spec parks its deferred row
  assertion. A reviewer should not read the engine cases as evidence that rows survive.

# Suggested review focus

- The image-selection rule in `selectKeySourceImage`. It is the one judgement call in the
  change: is "re-project whichever image reproduces the recorded key" the right neutrality
  stance, or should the re-key instead force one convention and let the sibling ticket adopt
  it? The fallback when *neither* image matches (`newRow ?? oldRow`, silently) is the weakest
  spot — it currently produces a key with no warning, unlike the three genuine bail-outs.
- The `after module.alterTable, before schema.addTable` placement in the native arm. It is
  load-bearing for the store (its queued events arrive *during* the call) and the comment says
  so, but a reviewer should confirm the failure mode: if a future module flushed its queue
  *after* returning, those events would miss the walk entirely and no test would catch it.
- Whether `docs/usage.md`'s new paragraph is honest for a reader on the **memory** module,
  where a mid-transaction ALTER PRIMARY KEY delivers a correctly re-keyed event for a row that
  did not survive. The paragraph describes the `key` contract truthfully; it does not mention
  the row loss, which is the sibling ticket's to state.
