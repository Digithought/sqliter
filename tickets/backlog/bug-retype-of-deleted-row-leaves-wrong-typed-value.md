---
description: If you delete a row and then change a column's type in the same transaction, the deleted row is ignored during the type check — so if you then roll back, the row comes back holding a value that does not match the column's declared type.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn / set data type branch (~2130-2185), the `effectiveDdlRows()` vs base-rewrite split
  - packages/quereus-store/src/common/store-module.ts    # alterColumnSetDataType (~2401), same effective-rows-only validation
  - packages/quereus/test/alter-table-conformance.spec.ts
difficulty: medium
---

# Retype validates the rows the transaction can see, but the deleted ones stay in the table

## What happens

`alter table t alter column v set data type integer` refuses to run if any value in `v`
cannot be converted. It decides that by walking the **effective** rows — the committed rows
overlaid with the current transaction's own pending writes — so a row the transaction has
already deleted is deliberately not counted against the ALTER. That is a reasonable rule
while the delete is going to land.

It stops being reasonable when the transaction **rolls back**. The delete is undone and the
row returns, but the ALTER is not undone (DDL in Quereus is not transaction-scoped). The
result is a row whose stored value contradicts its own column's declared type.

```sql
create table t (id integer primary key, v text);
insert into t values (1, 'abc');
insert into t values (2, '20');
begin;
delete from t where id = 1;                                -- 'abc' now invisible…
alter table t alter column v set data type integer;        -- …so the retype is accepted
rollback;                                                  -- the delete is undone
select id, v from t;   -- 1|'abc'  2|20
-- table_info('t') reports v INTEGER, but row 1 holds the text 'abc'
```

## Why it matters

This is the exact "no silent divergence" contract the ALTER conformance matrix exists to
protect: after the rollback the catalog says one thing and the stored data says another,
with no error raised at any point. Downstream, `where v = 20`-style equality and any
index/UNIQUE ordering on `v` see a value of the wrong physical type.

## Scope

Reproduced on **both** underlying modules, so this is not an isolation-layer issue:

- plain memory module (no `using isolated`) — as written above;
- isolation-wrapped memory module (`using isolated`) — identical outcome.

It was found while reviewing `bug-isolation-retype-leaves-staged-rows-unconverted`, which
closed a different (overlay-side) hole. That fix is correct and unrelated; this one predates
it and lives in the underlying modules' own validation, not in the isolation wrapper.

## Expected behavior

Not obvious — this needs a decision, which is why it is filed as a spec rather than a plan:

- **Option A — count deleted rows too.** Validate the retype over the *committed* rows
  regardless of pending deletes. Safest and simplest, but rejects a retype whose only
  offending value the user has already deleted, which is the case the current rule was
  written to allow.
- **Option B — convert-or-reject at rollback.** Keep the permissive validation, but make the
  rollback path re-check restored rows against the current column type. Expensive and the
  failure has nowhere useful to go (the rollback itself cannot fail).
- **Option C — document it.** Declare the corner a known limitation like the materialized-view
  retype corner in `docs/materialized-views.md`, and pin it with a test so it cannot silently
  change.

Whichever is chosen, the memory and store legs must agree — they share the validation shape
today and the conformance matrix asserts they behave identically.

## Update: the two legs already disagree behind the isolation wrapper

Found while reviewing `bug-retype-same-class-skips-value-validation`, which widened this same
validation to retypes that keep the storage class (text → date), so the corner now reaches many
more statements.

When the table sits behind the isolation layer, a transaction's DELETE is a tombstone in the
wrapper's overlay. The memory module is handed the wrapper's merged row stream and honors it, so
the deleted row's offending value does not block the retype. The store module's convert pre-pass
ignores that stream and scans its own committed rows, so it still sees the deleted row and
**rejects**. Same statement, same data, opposite answers depending on the backing module.

The test that pins the accepting behavior therefore had to be marked memory-only:
`packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row-memory.sqllogic`. Whichever
option is chosen above, closing it should also remove that exclusion — Option A makes both legs
reject, and Options B/C require the store's pre-pass to read the wrapper-supplied
`EffectiveRowSource` the way `alterColumnSetNotNull` already does (see the NOTE in
`StoreModule.alterColumnSetDataType`).
