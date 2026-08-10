---
description: Changing a table's primary key part-way through a transaction used to leave the change notifications for earlier writes identifying their rows by the old primary key; those notifications are now rewritten to use the new key before the commit delivers them.
files:
  - packages/quereus/src/core/database-events.ts            # rekeyBatchedDataEvents + 3 module-level helpers
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAlterPrimaryKey — both arms call it
  - packages/quereus/test/alter-table-events.spec.ts        # engine auto-event path cases (+15 after review)
  - packages/quereus-store/test/alter-events.spec.ts        # store path cases (+10)
  - docs/usage.md                                           # § Subscribing to Data Changes
  - docs/module-events.md                                   # § Row-Shape, Table-Name, and Row-Key Contract…
---

# What was wrong

A change-notification event (`DatabaseDataChangeEvent`) carries a `key`: the primary-key values
identifying the row it describes. Quereus already guaranteed that a commit's events describe the
table **as it is at delivery** — row images rewritten to the post-ALTER column layout, table name
rewritten across a mid-transaction rename. `key` was not covered, so an
`ALTER TABLE … ALTER PRIMARY KEY` inside a transaction left every event the transaction had
already recorded carrying the *retired* key's values. A key of the wrong arity matches no row a
consumer holds, so the write is dropped or filed under a phantom identity — silently, because the
commit reports success.

# What shipped

`DatabaseEventEmitter.rekeyBatchedDataEvents(schemaName, tableName, oldPkIndices, newPkIndices)`
in `database-events.ts` — the third batched-event fixup beside `remapBatchedDataEvents` (row
shape) and `renameBatchedEvents` (table name), built to the same shape: early-return when not
batching, `namesTable()` matcher, `allDataEventStores()` enumeration (base batch plus every open
savepoint layer), synchronous, best-effort. Each event's new key is projected from that event's
**own** row image — `newRow` for an insert, `oldRow` for a delete, and for an update whichever
image reproduces the recorded key under the retired key's columns (`selectKeySourceImage`), which
keeps the fix neutral to the separate producer disagreement tracked as
`fix/bug-update-event-key-disagrees-across-producers`.

Both arms of `runAlterPrimaryKey` call it: the native arm after `module.alterTable` returns and
before the catalog swap (the store's `alterPrimaryKeyChange` flushes its queued events into the
engine batch *during* that call, so they must be present before the walk), the rebuild fallback
after `rebuildTableWithNewShape` returns.

Docs: `docs/usage.md` § *Subscribing to Data Changes* and the § *Row-Shape, Table-Name, and
Row-Key Contract Across Mid-Transaction ALTER* section — which the concurrent docs-split triage
moved from `module-authoring.md` into the new `docs/module-events.md`, carrying this ticket's
subsection with it intact (verified in the review pass; `files:` above records the new home).

Tests: 25 cases across the engine auto-event path (`packages/quereus/test/alter-table-events.spec.ts`,
15 of them) and the store path (`packages/quereus-store/test/alter-events.spec.ts`, 10). The
implementer verified by mutation that disabling the walk fails exactly the new cases and nothing
else.

# Review findings

## Checked and clear

- **The re-key walk itself** — matcher, store enumeration, in-place `{...event, key}` replacement,
  and the three bail-out paths all mirror the two neighbouring fixups. No divergence found.
- **The docstring's claim that the maintenance-collision channel needs no counterpart.** Verified
  at the source: `runAlterTable` rejects every structural ALTER on a maintained table up front
  (`alter-table.ts:89`), leaving only rename and the derivation lifecycle verbs — so a
  materialized view's primary key cannot change mid-transaction. Claim is accurate.
- **The sync layer sees the re-keyed events.** `quereus-sync` captures changes via
  `onTransactionCommit`, i.e. after delivery, so the re-key reaches its change log. Pinned by the
  existing `onTransactionCommit carries the re-keyed key too` case.
- **The `tableSchema` liveness question the implement ticket answered** — re-verified from a
  different angle than the implementer's (see the two new composition tests below), not just
  re-read.
- **The memory module's own native event path** (`new MemoryTableModule(emitter)`, events held in
  its per-layer pending-change log) — probed directly. A mid-transaction ALTER PRIMARY KEY on that
  path delivers **no events at all**, not stale-keyed ones: the rebuild fallback discards the layer
  and its change log with it. That is `fix/bug-alter-primary-key-mid-transaction-loses-memory-rows`,
  whose ticket already states the event loss explicitly. Nothing to add and no stale-key hole there.
- **`sqlValueIdentical` as the image-match test.** It compares under BINARY, i.e. identity rather
  than collated equality — correct here, since both sides are derived from the same row image and
  the question is "was this key projected from this image", not "are these values equal".

## Found and fixed in this pass (minor)

- **`selectKeySourceImage` guessed silently when neither update image reproduced the recorded key.**
  The implement ticket flagged this itself as the change's weakest spot: three genuine bail-outs log
  at warn, but the tie-break's give-up path produced a key with no signal at all — against the
  project's "don't eat it silently, log at least" rule. Now warns, naming the event, the recorded
  key and the retired key columns, and saying which image it fell back to. Suppressed when the
  update carries no image at all, since the caller already reports that case.
- **`key`-absent logged at warn, which it is not.** `key` is optional on the public event interface
  and `docs/usage.md` documents it as "if available", so a module may legitimately never populate
  it — in which case an ALTER PRIMARY KEY warned once per batched event for a supported
  configuration. Demoted to debug, with the reasoning at the site. The two real anomalies (no usable
  image, new key column out of bounds) stay at warn.
- **Test coverage: four compositions the specs did not pin.** The implementer's cases cover each
  operation in isolation plus `DROP COLUMN` → `ALTER PRIMARY KEY`; these four were verified
  empirically during review but nothing failed if they broke. Added to the engine spec:
  - `RENAME TO` then `ALTER PRIMARY KEY` — the re-key matches events by the table's *current* name,
    which the rename relabel already wrote onto them, so this is the case that fails if
    `runAlterPrimaryKey` ever resolves a build-time schema snapshot instead of the live one. This is
    the load-bearing test behind the liveness claim.
  - `ALTER PRIMARY KEY` then `RENAME TO` — the later relabel must leave the new key alone.
  - Two `ALTER PRIMARY KEY`s in one transaction, with an update in the batch — the second re-key
    must read the *first* one's key as the retired one, both for the column indices and for the
    image tie-break.
  - `ROLLBACK TO SAVEPOINT` after an `ALTER PRIMARY KEY` — see below.

## Investigated, turned out not to be a defect

- **Savepoint rollback of the ALTER itself.** The re-key rewrites events in the base batch, which a
  later `ROLLBACK TO SAVEPOINT` does not discard — so on its face the schema could revert while the
  events kept the new key. Probed: `ROLLBACK TO SAVEPOINT` does **not** revert DDL in Quereus (the
  altered key, the added column and the rename all survive it), so the re-keyed events stay
  consistent with the committed schema. The shape and rename families each already pin this
  semantic; the key family now does too, with a comment stating that all three fixups would need
  undo if DDL ever became savepoint-scoped. Not a defect, and the engine-wide question of
  savepoint-scoped DDL is well outside this ticket.

## Filed as a new ticket (major)

- `backlog/debt-emit-source-files-too-large` — `runtime/emit/alter-table.ts` (2,155 lines, touched
  by this diff) and `runtime/emit/materialized-view-helpers.ts` (3,093) are both far past the size
  at which this project has previously split a file; the isolation package got its own splitting
  tickets at ~1,800 lines. Pre-existing, no behaviour concern, filed as backlog debt rather than
  fixed here — a split is its own change and would swamp this diff.

## Tripwires parked (conditional — deliberately not tickets)

- **Double re-key if the native arm's post-call catalog work ever raises `UNSUPPORTED`.** The
  re-key sits inside the `try` whose `catch` falls through to the rebuild, so an `UNSUPPORTED`
  raised *below* it would re-key twice. A second pass is idempotent for every event except a
  PK-moving update, whose tie-break no longer recognizes the already-rewritten key. Unreachable
  today — `schema.addTable` raises no `UNSUPPORTED`, leaving only a `table_modified` listener as a
  theoretical source. `NOTE:` at the call site in `alter-table.ts`, saying to narrow the `try` to
  the `module.alterTable` call if that ever changes.
- **A row image left at its pre-ALTER layout by a failed earlier remap.** The re-key's indices are
  read against the current layout; only an out-of-bounds index is detectable, so a long-enough
  stale image would project the wrong column instead of bailing out. Requires the earlier
  best-effort remap to have failed on that image *and* an ALTER PRIMARY KEY in the same
  transaction. `NOTE:` in the `rekeyBatchedDataEvents` docstring, saying to thread the current
  column count through and skip mismatched images if those failures stop being a logged rarity.

## Not closed, and why

- **`yarn test:store` (LevelDB) still not run**, as at implement: it re-runs the engine's logic
  tests against the LevelDB store module and routinely exceeds the ticket runner's 10-minute idle
  budget, so it is not agent-runnable here. The store code path was exercised through
  `packages/quereus-store`'s in-memory KV provider, which drives the same
  `StoreModule.alterPrimaryKeyChange` / `ddlCommitPendingOps` code; the LevelDB-specific layer
  remains unverified. Left for CI or a human.
- **`rebuildViaShadowTable` — the third rebuild path — remains untested**, unchanged from the
  implement handoff's disclosure. No in-tree module reaches it for an ALTER PRIMARY KEY (memory
  takes the in-place rebuild, store the native arm), and reaching it needs a module whose
  `alterTable` throws `UNSUPPORTED` and that is not a `MemoryTableModule`. The re-key call sits
  after `rebuildTableWithNewShape` returns and so covers the path by construction only. Not
  escalated to a ticket: it is one arm of a fixup whose other two arms are covered, and the
  implement handoff already names what a test would need.
- **Cross-connection batches stay out of reach**, as they already are for the rename relabel — the
  event emitter is per-`Database`. Moot under `quereus-isolation`, which refuses the ALTER outright
  to a connection with staged rows.

# Validation

From the repo root, against the final tree: `yarn build` ✅, `yarn lint` ✅ (exit 0),
`yarn typecheck` ✅, `yarn test` ✅ — 10,493 assertions passing across the workspace, zero failing.
`packages/quereus/test/alter-table-events.spec.ts` 60 passing; `@quereus/store` 1,186 passing.

`yarn docs:check` ✅ — **now green.** The four failures the implement stage recorded in
`tickets/.pre-existing-error.md` were resolved out-of-band by the docs-split triage commit
(`3229685c`), which also removed that file. Nothing left to disclose.

The implementer's scratch probe file (`packages/quereus/test/zz-scratch-probe.spec.ts`, untracked)
was left behind by the interrupted first review run; its questions are answered above and the
valuable ones are now real spec cases, so the file was deleted.
