description: On the persistent storage backend, changing which columns make up a table's primary key inside a transaction throws away that transaction even when the change is rejected — so the user loses unrelated work they had not committed yet.
files:
  - packages/quereus-store/src/common/store-module-alter.ts   # alterPrimaryKeyChange: ddlCommitPendingOps() runs before rekeyRows' duplicate pass
  - packages/quereus-store/src/common/store-table.ts           # validateRekeyedPrimaryKey / rekeyRows
  - packages/quereus-store/src/common/store-module-base.ts     # ddlCommitPendingOps and its documented transaction consequences
  - packages/quereus-store/test/alter-primary-key-persistence.spec.ts
difficulty: medium
----

# `alter table … alter primary key` rejects only after spending the transaction

## Expected behavior

A statement that is going to be *refused* should leave the user's open transaction exactly
as it found it. The user gets an error, decides what to do, and their earlier uncommitted
work is still there to commit or roll back.

## What happens instead

On the store (persistent) backend, `alter table t alter primary key (…)` writes out — and
thereby commits — every buffered write of the enclosing transaction *before* it checks
whether the new primary key is even legal. If two rows turn out to collapse onto one key
under the new definition, the statement fails with a `CONSTRAINT` error, the table itself
is untouched (good), but the transaction is already gone. Any earlier statement in that
transaction is now permanently committed, and a following `rollback` cannot undo it.

The sibling statement `alter table t alter column … set collate` on a primary-key column
used to behave the same way and no longer does: it now asks its legality question over the
rows the transaction can see, before the flush, so a refusal is harmless. `alter primary
key` was deliberately left alone at the time and is the remaining case.

## Notes for whoever picks this up

- The check that needs to move earlier is the duplicate-key pass inside
  `StoreTable.rekeyRows`. A ready-made pre-flush probe already exists next to it:
  `StoreTable.validateRekeyedPrimaryKey`, written for the `set collate` path. It takes the
  new key definition, the post-change columns, and the row stream the transaction can see.
- `alterPrimaryKeyChange` currently does not receive the caller-supplied effective-row
  stream at all (unlike the ALTER COLUMN arm, which takes a `rows?` parameter). It would
  need it, or it can read the table's own effective stream — the transaction-isolation
  wrapper already refuses this statement outright when the issuing transaction has staged
  rows for the table, so on that path the two streams agree.
- Expected shape once fixed: the same `CONSTRAINT` error and message, arriving *before*
  anything is flushed, with the transaction still usable.
- The current post-flush behavior is written down in `docs/store.md` (the paragraph on
  validation that runs after the commit) — that paragraph needs updating with the fix.
