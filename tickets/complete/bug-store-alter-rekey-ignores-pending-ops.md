description: On tables backed by the persistent store, an ALTER TABLE that rewrites the stored rows used to ignore rows written earlier in the same open transaction, corrupting or losing them on commit; those ALTERs now flush the pending writes first, so the rewrite sees every live row.
files:
  - packages/quereus-store/src/common/store-module.ts        # ddlCommitPendingOps (~1181) + its 6 alterTable call sites, renameTable
  - packages/quereus-store/src/common/store-table.ts         # hasAnyRows, rowsWithNullAtIndex, iterateEffectiveValuesAtIndex, mapRowsAtIndex NOTE
  - packages/quereus-store/src/common/transaction.ts         # savepoint docblocks
  - packages/quereus-store/test/alter-pending-ops.spec.ts    # 26 regression tests
  - docs/store.md                                            # "DDL that implicitly commits"
difficulty: medium
----

# Row-rewriting `ALTER TABLE` now DDL-commits before touching storage

## What was wrong

`StoreModule.alterTable`'s row-rewriting arms call `StoreTable.migrateRows` /
`rekeyRows` / `mapRowsAtIndex`, which scan and batch-write the **committed** key-value
store directly. The transaction coordinator, meanwhile, buffers pending writes as
`(keyBytes, valueBytes, store)` triples encoded at DML time under the *pre-ALTER*
schema. Nothing reconciled the two, so on the eventual `commit` the stale-schema ops
replayed over the rewritten store: rows landed under keys nothing could find, deletes
addressed keys that no longer existed, rows came back with the wrong column count, and
values came back with the wrong physical type.

`renameTable` already handled this class by committing the coordinator before moving
the on-disk directory. The `alterTable` arms never got the same treatment.

## What changed

- **New private helper `StoreModule.ddlCommitPendingOps()`** — commits the module-wide
  coordinator if a transaction is open, carrying the full explanation. `renameTable`
  now calls it too, so the reasoning lives in one place.
- **Called from each rewriting arm**, immediately before the first physical write and
  after every throw-only validation that can reject without the flush. Six arms:
  `ADD COLUMN`, `DROP COLUMN`, `ALTER PRIMARY KEY`, `SET COLLATE` on a PK member, and
  (added during review) `SET DATA TYPE` across physical representations plus a
  backfilling `SET NOT NULL`.
- **Probes that gate those arms now read effectively** (committed store overlaid with
  the open transaction's pending writes), so a rejection happens *before* the flush and
  leaves the transaction alive: `hasAnyRows` (`ADD COLUMN`'s NOT-NULL-without-DEFAULT
  check), `rowsWithNullAtIndex` (`SET NOT NULL`), and a new throw-only convertibility
  pass over `iterateEffectiveValuesAtIndex` (`SET DATA TYPE`).
- **`addConstraint`'s UNIQUE arm** documents why it is exempt (writes no rows).
- **`docs/store.md`** gained a "DDL that implicitly commits" subsection listing exactly
  which statements flush, which do not, which validations survive a rejection, and what
  happens to an open savepoint.

### Deliberate posture (documented, pinned by tests)

1. The coordinator is module-wide, so a rewriting ALTER commits **every** table's
   pending ops. Same as `renameTable`.
2. Two validations cannot run before the flush and therefore throw with the enclosing
   transaction already committed (storage unmutated, only the transaction gone):
   `rekeyRows`' duplicate-key pass, and the per-row NOT NULL check on an `ADD COLUMN`
   backfill expression.
3. A DDL-commit clears the savepoint stack. A later `ROLLBACK TO` / `RELEASE` warns and
   degrades rather than throwing — mirroring the memory module's identical posture.

## Review findings

### Checked
Read the implement diff before the handoff summary. Audited every `alterTable` arm and
`renameTable` for physical writes vs. the coordinator buffer; traced every caller of
`migrateRows` / `rekeyRows` / `mapRowsAtIndex` / `rowsWithNullAtIndex` / `hasAnyRows` /
`rebuildSecondaryIndexes` / `buildIndexEntries`; re-derived the flush-vs-validation
ordering in each arm; exercised the savepoint path the handoff flagged as unaudited;
re-checked both "verified, not defended" claims; read `docs/store.md` against the code.
Ran `yarn build`, `yarn lint`, `yarn test`, `yarn workspace @quereus/store test`, and
`yarn test:store` — all clean, zero failures, no pre-existing failures surfaced.

### Major — three live instances of the same defect, missed by the fix (fixed in this pass)
`alterTable`'s `alterColumn` case has two more arms that rewrite rows physically, ~130
lines above the `SET COLLATE` arm the implementer fixed. Neither flushed. Reproduced
each against the in-memory provider before touching anything:

- `alter column c set data type integer` on a `text` column: the pre-existing row
  converted to a number; a row inserted earlier in the same transaction replayed as the
  string `'7'`. The column's physical type was no longer uniform.
- `alter column c set not null`, no `DEFAULT`: `rowsWithNullAtIndex` read committed-only,
  so a NULL inserted earlier in the same transaction was invisible. The ALTER was waved
  through and the transaction then committed a NULL into a NOT NULL column.
- `alter column c set not null` with a literal `DEFAULT`: the backfill rewrote only
  committed rows; the same transaction's NULL row survived the backfill and landed NULL.

Fixed in place, mirroring the pattern the implementer established rather than inventing
a second one: `rowsWithNullAtIndex` now reads effectively; `SET DATA TYPE` gained a
throw-only convertibility pass over the live rows (so an unconvertible pending value
rejects the statement with the transaction intact) before flushing and rewriting; both
arms call `ddlCommitPendingOps()` before their `mapRowsAtIndex`. Extracted the
conversion closure so the probe and the rewrite cannot drift.

Also factored `StoreTable.iterateEffectiveValuesAtIndex` — one live-value scan shared by
`rowsWithNullAtIndex` and the new probe — rather than duplicating the deserialize loop.

Nine new tests (26 total in the file, up from 17): pending insert, pending delete, and
rejection-leaves-transaction-alive for each of the two arms, plus two DDL-commit-posture
tests (a backfilling `SET NOT NULL` flushes; a no-op `SET NOT NULL` with no live NULL
does not, and its transaction still rolls back).

### Minor — stale documentation (fixed in this pass)
`TransactionCoordinator.releaseSavepoint` / `rollbackToSavepoint` both name
`replaceContents`/`renameTable` as the only DDL-commit sites that can clear the savepoint
stack out from under them. Six `alterTable` arms now do so too. Updated both docblocks,
added the savepoint consequence to `ddlCommitPendingOps`' docblock and to `docs/store.md`.
`docs/store.md` also claimed the re-key duplicate pass was the only validation stranded
after the flush; the `ADD COLUMN` backfill's per-row NOT NULL check is a second one.
Corrected.

### Verified, no change needed
- **Savepoint interaction** (the handoff's top open question). `begin; savepoint sp1;
  insert; alter table t add column ...; rollback to sp1; commit` warns
  (`rollback-to savepoint depth 0 out of range ... transaction was committed out from
  under it`) and keeps the row with its new column. No corruption, no crash, no silent
  swallow — it logs. The degrade is deliberate, documented in `transaction.ts`, and
  mirrors `vtab/memory/layer/connection.ts`. Whether it should instead raise is a
  cross-module semantics question that predates this ticket and is unchanged by it; not
  filed, because changing it in the store alone would desynchronize it from the memory
  module.
- **`hasAnyRows` blast radius.** Still exactly one caller. The effective read is now the
  consistent house style for these probes (three of them), so inlining it at the call
  site would be the odd one out.
- **`dropColumn` on a PK member.** Confirmed unreachable: the engine rejects it at
  `packages/quereus/src/runtime/emit/alter-table.ts:728` (`Cannot drop PRIMARY KEY
  column`).
- **`addConstraint`, `dropConstraint`, `renameConstraint`, `renameColumn`, `SET DEFAULT`,
  `DROP NOT NULL`, `SET DATA TYPE` within one physical representation** write no rows;
  correctly exempt from the flush.
- **`createIndex`** builds from `iterateEffectiveEntries`, so it needs no flush — the
  doc's claim holds.
- **`mapRowsAtIndex`, `migrateRows`, `rekeyRows`** all build their batch fully before
  writing, so a mid-scan throw leaves storage untouched. The all-or-nothing claims in the
  arm comments are real.

### Tripwires (recorded as code comments, not tickets)
- `rebuildSecondaryIndexes` (`store-module.ts`) reads the data store committed-only and
  writes index stores outside the coordinator — sound only because both callers flush
  first. Pre-existing `NOTE:` from the implement pass; verified accurate.
- `mapRowsAtIndex` (`store-table.ts`) has the same shape. Added a matching `NOTE:` in its
  docblock now that its two callers flush.

### Not fixed / not filed
Nothing. The tests still drive only the in-memory KV provider; the LevelDB path is
covered transitively by `yarn test:store` (6770 passing), and the defect lives in
`StoreModule`/`StoreTable`, above the provider seam, so a provider-specific regression
test would pin nothing the in-memory tests don't.

## Validation performed

- `yarn workspace @quereus/store test` — **837 passing, 0 failing** (up from 828; 9 new).
- `yarn test` (all workspaces) — 0 failing.
- `yarn test:store` (quereus logic tests against the LevelDB store module) — 6770
  passing, 15 pending, 0 failing.
- `yarn build` clean, `yarn lint` clean.
- Each of the three newly-found bugs was reproduced as a failing assertion before the
  fix and re-run green after; the implementer's negative control (stub
  `ddlCommitPendingOps` to a no-op → 11 of 17 original tests fail) still holds.
