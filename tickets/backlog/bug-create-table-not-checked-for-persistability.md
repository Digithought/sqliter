---
description: Creating a persistent table whose definition contains a character that cannot be saved to disk appears to succeed; if nobody ever reads or writes that table, it silently disappears when the database is reopened.
files:
  - packages/quereus/src/schema/manager.ts                        # createTable — no persistability pre-flight for the new table
  - packages/quereus/src/vtab/module.ts                           # assertCatalogObjectPersistable — the 'table' kind exists but create never asks
  - packages/quereus-store/src/common/store-table-base.ts         # initializeStore — today's only site that raises the encoding error
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts       # existing coverage: the error surfaces at first INSERT, not at CREATE
repro: static
---

## What is wrong

Text that contains a lone half of a surrogate pair (an unpaired UTF-16 code unit —
the halves that normally only appear as a pair to encode an emoji or other
astral-plane character) has no valid UTF-8 encoding. Persistent storage keys text
by its UTF-8 bytes, so the store refuses to write such text: every lone surrogate
would collapse onto the same replacement character and distinct schemas would
collide.

A `create table … using store` whose *generated definition text* contains one —
a quoted column name, a `default '…'` string constant, a `check` constraint's
string literal — is not refused. The statement succeeds and the table works for
the rest of the session. What happens next depends on whether anyone touches it:

- Read or written at least once → the error is raised on that first statement
  (an `insert` fails with "cannot store persisted schema text containing an
  unpaired surrogate"). Confusing (the wrong statement is blamed) but not silent.
- Never read and never written → nothing raises. The write that would have failed
  runs on a background queue that logs and swallows. The table is simply gone at
  the next reopen.

The second case is the loss. It became reachable when table definitions started
being saved at creation time rather than at first access
(`bug-store-untouched-table-and-early-view-never-persisted`); before that, an
untouched table was lost regardless of its contents, so this narrower case was
invisible inside the broader one.

## Why it is not already covered

The engine has a pre-flight veto for exactly this — a synchronous hook every
registered module is asked before an object is registered, so a module that could
not durably save it can refuse the statement cleanly
(`VirtualTableModule.assertCatalogObjectPersistable`). It already accepts a
`'table'` kind. But `create table` never asks: the kind is only offered during a
`rename` propagation scan, on the reasoning that a create already routes through
`module.create`, whose failure reaches the statement. That reasoning holds for
anything `module.create` itself checks — and `module.create` does not check
whether the table's generated definition text can be encoded.

Views and materialized views are already covered (they have no module hook at all,
so the veto is their only gate).

## Expected behavior

`create table … using store` with an unencodable definition should be refused on
the statement, leaving no table registered and no storage created — the same clean
no-op `create view` with an unencodable name already produces. The error should
name the unpaired surrogate.

Once that is in place, the deferred error at first storage access
(`StoreTableBase.initializeStore`) becomes unreachable for tables created through
SQL, and the two existing tests in `lone-surrogate-keys.spec.ts` that assert the
error arrives at the `insert` should assert it arrives at the `create` instead.

## Scope note

This is about *encodability of the definition text*, not about the table's own
name — an unencodable table name is already refused at create, by the guard that
builds the storage key.
