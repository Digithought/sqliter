---
description: Filling in the empty values of a column that is part of a table's row identity is now treated as a change of identity on every backend — refused when it would merge rows, otherwise physically re-keyed — so rows no longer silently merge, deleted rows no longer come back, and the persistent backend can find and delete the backfilled rows again.
files:
  - packages/quereus/src/vtab/memory/layer/alter-column.ts (`pkColumnRekeyed` set for a key-member value rewrite)
  - packages/quereus/src/vtab/memory/layer/manager.ts (`validateAlterColumnPlan` rewrite arm runs `validateRekeyedPrimaryKey` with the converted-row mapper; base rebuild now asserts distinct keys)
  - packages/quereus/src/vtab/memory/layer/base.ts (`rebuildPrimaryTreeFromRows` gained `assertDistinctKeys`)
  - packages/quereus/src/vtab/memory/layer/row-convert.ts (`makePrimaryKeyConverter`)
  - packages/quereus/src/vtab/memory/layer/transaction.ts (`convertColumn` re-derives staged deletion keys)
  - packages/quereus-store/src/common/store-module-alter-column.ts (`pkRekeyNeeded` widened; value rewrite ordered before the re-key)
  - packages/quereus-store/src/common/store-table.ts (`validateRekeyedPrimaryKey` optional `mapRow`)
  - packages/quereus-isolation/src/alter-migration.ts (`derivePkRekey` `set not null` arm; marker re-key in `backfillStagedNotNull`)
  - packages/quereus-isolation/src/isolation-module.ts (`committedRowsOf`; `forwardedViaAlterSchema` gate)
  - packages/quereus/test/logic/41.2.3-alter-column-set-not-null-pk-backfill.sqllogic (12 sections, cross-backend)
  - packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts
  - docs/schema.md, docs/sql-alter.md, docs/memory-table.md, docs/store.md, docs/store-catalog-persistence.md
---

# `alter column … set not null` on a key column: validate and re-key — complete

## What shipped

A table that declares no `primary key` is keyed by all of its columns, and those columns stay
nullable. Tightening one of them to `not null` backfills its NULLs from the column's DEFAULT —
which moves the row's identity, because the identity *is* the values. `(NULL, 1)` and `(0, 1)`
become the same row under `default 0`.

Every backend now treats that backfill as a primary-key re-key rather than a payload rewrite:

- **Before mutating anything**, the same two-question collision check `set collate` on a key
  column already ran, but judged over the rows *as the backfill will leave them*. Two rows the
  transaction can see converging on one key is `CONSTRAINT`; a collision confined to committed
  rows the transaction has deleted (which a rollback must restore) is `BUSY`. Either refusal
  leaves the table, the schema and the transaction untouched.
- **On acceptance the keys physically move.** The memory backend re-derives each open layer's
  staged deletion keys under the backfill (`TransactionLayer.convertColumn` →
  `makePrimaryKeyConverter`), so a row deleted in the transaction stays deleted. The store applies
  the value rewrite first and then `rekeyRows` re-encodes each data key from the rewritten row, so
  the backfilled row is findable by an equality seek, deletable, and no longer duplicable. The
  isolation overlay re-keys its staged deletion markers, dropping first any marker the backfill
  collapses onto a live row.
- A tightening that sees no NULL in the transaction's effective rows stays metadata-only on every
  backend and moves no key — including in the isolation overlay, whose re-key arm re-runs the
  underlyings' own "is any visible row NULL here" gate before deciding.

## Review findings

### Checked

Read the implement diff first, ahead of the handoff: all three backend legs, the five changed
docs (and the paragraphs they cross-reference), the new `.sqllogic` file, and both new spec
suites. Angles covered: correctness of the deletion-replay argument, gate parity across the three
backends, block ordering in the store, resource cleanup on the new row scan, type safety of the
new optional-mapper parameters, source-file size, comment accuracy, and test coverage against
happy path / edge / error / regression / interaction.

Two claims were load-bearing enough to attack directly rather than read:

- **The unguarded deletion replay.** `convertColumn` replays staged deletions under re-derived
  keys with no `deletionTargets` identity check; its soundness rests entirely on the pre-pass
  having refused every converging pair. The handoff named the shape it believed unpinned — a NULL
  row inserted *and* deleted inside one transaction alongside a visible NULL, which would leave a
  deletion whose key no walked layer holds the pre-image of, letting the replay delete an
  unrelated committed row. Built that case and ran it in memory mode, then again with a
  `savepoint`/`release` between the insert and the delete. Both answered `BUSY` from the
  layer-chain pass: the memory backend keeps a per-statement layer, and neither the statement
  boundary nor `release` merges the insert's layer away, so the deleted row is still physically
  resident in a walked layer where it converges with the row it would have collapsed onto. No
  reachable path to the unguarded replay was found. **Not filed** — filing a bug I could not
  reach would be filing a suspicion as an observation.
- **Gate parity.** Three independent copies of "does any visible row hold NULL at this column"
  now have to agree, or the overlay re-keys markers the underlying did not move (or vice versa).
  Confirmed all three read the same row stream and the same condition:
  `planTightenNotNull`'s `hasNullValue` (memory), the inline scan in `alterColumnSetNotNull`
  (store), and `anyRowNullAt` (isolation). The isolation scan's stream is a re-callable factory,
  so consuming it here does not starve the copy handed to the underlying, and its early `return`
  closes the iterator through normal `for await` semantics.

Also confirmed: `pkRekeyNeeded` in the store widens on `valueConvert !== undefined`, which is set
only when a NULL is actually visible — a metadata-only tightening still re-keys nothing; and a
retype of a key member is refused locally by `alterColumnSetDataType`, so `rewrite` plus
`pkColumnRekeyed` really is only ever the backfill.

Lint clean. `yarn test` green (exit 0, all workspaces). `yarn test:store` green (9616 passing,
33 pending, 0 failing). No pre-existing failures surfaced, so nothing was written to
`tickets/.pre-existing-error.md`.

### Fixed in this pass (minor)

- **Silent-merge backstop on the base rebuild.** `BaseLayer.rebuildPrimaryTreeFromRows` inserted
  each row without checking for a key already present. Every prior caller passed rows that were
  distinct by construction; the new value-rewrite path is the first whose input can carry two
  rows on one key, so any hole in the pre-pass would land as a silently merged row — the exact
  failure this ticket exists to remove. Added an opt-in `assertDistinctKeys` duplicate check (the
  same invariant check `rebuildPrimaryTreeStrict` already makes, with the message the rest of this
  work uses), passed only when `plan.pkColumnRekeyed`; every other caller skips the per-row
  lookup.
- **`docs/store.md` gave a reason that the diff had made false.** It justified refusing a retype
  of a key member as "the value rewrite is payload-only and would leave the row's key bytes
  encoded under the old type" — but the diff reordered the store so the rewrite precedes the
  re-key, and the bytes would now follow. Rewritten to the reason that still holds (a retype
  moves the key's type and comparator, and nothing exercises the byte path), matching the code
  comment the diff updated. Same file: "for both re-keying statements" → "every", since there are
  three.
- **`.sqllogic` section numbers jumped 7 → 9**, which reads as a deleted case. Renumbered.
- **Comment run-on** in `store-module-alter-column.ts`: the new `convertRow` doc had merged into
  the preceding UNIQUE-scan `NOTE` with no blank line between them. Separated.

### Test gap closed

The suite covered the primary tree thoroughly but never a **secondary index** across the re-key —
index entries embed the primary key, which the backfill just moved. Added § 12: an index over an
untouched column, with the backfill applied inside an open transaction so both rebuild paths run
(the base / store re-key, and `TransactionLayer.convertColumn`'s per-layer index rebuild), then
asserting the index-driven seek and delete still resolve, in the transaction and after commit.
Passes in both memory and store mode.

### Major findings

**None.** The two items the handoff listed as known gaps were weighed and left:

- A *foreign* overlay's staged live row converging with a committed row the issuer backfills is
  applied last-writer-wins at that connection's flush. This is the documented design of the
  isolation layer — only the issuing connection's overlay feeds validation — and the identical
  shape already exists for `set collate`. Not new, and fixing it is a change to that design, not
  to this ticket's code.
- The poison message for the tightening covers two causes with one sentence. It names both
  explicitly ("a NULL with no usable default, or two rows converging on one primary key under the
  backfill"), so a reader can tell which applies to their rows.

Source-file size was checked (`wc -l`: `manager.ts` 3,918; `isolation-module.ts` 2,000;
`alter-migration.ts` 1,186 — all grown by this work). All three are already listed by name in
`tickets/backlog/debt-oversized-source-files.md`; per the site-claim rule that is evidence on an
existing ticket, not a new one, and the line counts there are already stale by design.

### Tripwires

- The two the implementer parked stand as written: the extra effective-row scan per key-member
  `set not null` with open overlays (`derivePkRekey`), and the collision message naming the
  second row's pre-change tuple where the underlyings name the post-change one.
- **Gate parity** (above) is recorded as a tripwire, not a ticket, and deliberately: nothing is
  wrong today, and it only becomes work *if* one backend's NULL-visibility gate changes without
  the other two following. The `NOTE:` at `derivePkRekey` is where a future editor of that gate
  meets it. A shared predicate would have to live in `@quereus/quereus` and be imported by two
  other packages to replace four lines each — not worth paying before the condition trips.

## Verified

`yarn build`, `yarn lint`, `yarn test`, `yarn test:store` — all green after the review's changes.
The new `.sqllogic` file passes in both backends, including the section added here.
