---
description: When a device tightens a rule on a table (for example "this column may no longer be empty") right after filling in the values that satisfy it, other devices report a sync error and only succeed on the next sync round.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts   # createStoreAdapter: schema changes applied before data changes
  - packages/quereus-sync/src/sync/admission.ts       # applyDataToStore / admitGroup — turns the DDL error into a failed admission unit
  - packages/quereus-sync/src/sync/sync-context.ts    # throwIfApplyErrors
repro: verified
---

# Tightening DDL runs before the data that satisfies it

## What happens

A receiving device applies a batch's schema changes **before** the batch's row
changes. That ordering is right for a change that *loosens* or *extends* a table
(adding a column, dropping a constraint): the rows that follow need the new shape
to land in. It is wrong for a change that *tightens* one, because the tightening
is only legal against rows the device does not have yet — they are in the same
batch, queued behind it.

Observed (this exact sequence, run against two real engines):

1. Both devices hold `orders` with one row whose `note` is empty (NULL).
2. Device A fills it in, then runs
   `alter table orders alter column note set not null`.
3. Both changes relay to device B in one batch.
4. B applies the schema change first, against a row that is still empty, and the
   engine refuses: `column note contains NULL values`.
5. The whole batch is reported as failed — the caller of `applyChanges` sees
   `apply-to-store failed for 1 change(s): main.orders (alter_column): column note
   contains NULL values`.

It is **not** a permanent block: the row values do get written during the same
failed attempt, so the next sync round re-delivers the batch and the schema
change succeeds. The costs are a spurious, alarming error surfaced to the
application, and one wasted round trip before the devices agree.

## Why it matters now

Before table alterations replicated at all, only `create table` and
`create index` could hit this ordering. Now every tightening form crosses the
wire, so the same shape applies to at least:

- `alter column … set not null` (verified above)
- `add constraint unique (…)` — the receiving device may still hold a duplicate
  row the origin had already deleted
- `alter column … set data type` narrowing an existing column
- `alter primary key` onto columns whose values are not yet unique locally

## What good would look like

Either the tightening statement is ordered behind the same batch's row changes,
or a schema change that fails for a data reason is retried once after the rows
have been written, rather than failing the batch outright. "Schema before data"
is a deliberate rule (a new column has to exist before rows referencing it
arrive), so the fix has to keep that property for the extending forms — it is a
sequencing question, not a rule to discard.

Whatever the shape, the end state should be: this sequence converges in one sync
round and reports no error.
