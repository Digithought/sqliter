---
description: When a table's storage backend cannot change its own primary key, the engine used to silently rebuild the table — which could leave the table unreadable, or destroy already-committed rows if the surrounding transaction was rolled back. Both situations are now refused with a clear error instead.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts             # runAlterPrimaryKey guards (~1500-1545); rebuildViaShadowTable doc (~1735)
  - packages/quereus/test/no-alter-module.ts                     # NEW — shared no-`alterTable` stub module
  - packages/quereus/test/alter-table-conformance.spec.ts        # alterPrimaryKey arm now in the no-hook sweep
  - packages/quereus/test/alter-primary-key-in-transaction.spec.ts  # NEW describe at the end — 4 regression tests
  - docs/sql-ddl.md                                              # ALTER PRIMARY KEY § — two fallback preconditions
  - docs/module-authoring.md                                     # § `alterPrimaryKey` — same two guards, module-author view
difficulty: medium
---

# What changed

`alter table … alter primary key` asks the table's backend to re-key itself first
(`module.alterTable` with `{ type: 'alterPrimaryKey' }`). A backend that cannot raises
`UNSUPPORTED`, and `runAlterPrimaryKey` fell through to a generic rebuild
(`create shadow` → `insert … select` → `drop original` → `rename shadow`). Two of that
rebuild's failure modes destroyed or stranded user data. Both are now **refused** at the point
the rebuild is chosen — after the native attempt, before `rebuildTableWithNewShape` — because
neither has a correct outcome available.

Order is capability first, transaction second (the capability refusal is unconditional, so it
is the more informative answer when both apply):

1. **Module has no `renameTable`** ⇒ `StatusCode.UNSUPPORTED`, sited on the table and module,
   message contains "does not support". The rebuild ends by renaming a shadow table over the
   original; a backend that never hears about the rename keeps its rows under the shadow name
   and the rebuilt table cannot be opened at all.
2. **An explicit (`BEGIN`-opened) transaction is open** ⇒ `StatusCode.ERROR`. The rebuild's
   schema half (`drop` + `rename`) survives `rollback` while its row copy does not, so a
   rollback keeps the new *empty* table and discards the copy of the rows it replaced —
   destroying rows committed before the transaction began. Deliberately **not** `BUSY`: a retry
   inside the same transaction can never succeed. Refused under the default
   `ddl_transaction_policy = 'permissive'` too.

Uses `isExplicitTransactionOpen(db)` from `ddl-transaction-policy.ts` — **not** `getAutocommit()`.
In autocommit the ALTER's own `_ensureTransaction()` has already opened an *implicit*
transaction, so `getAutocommit()` alone reads `false` and a naive check would refuse the one
case the rebuild handles correctly.

Also: the `catch (e) { if UNSUPPORTED ⇒ fall through }` at the native attempt now logs at warn
(`warnLog`, naming module / schema / table / swallowed message) instead of discarding the error
with no trace. The swallow itself is unchanged — it is the documented module protocol.

`rebuildViaShadowTable`'s doc comment now states both preconditions and why each has no
repair, so the next reader meets the reasoning at the code.

# Testing / validation

`yarn build`, `yarn test` (7931 passing in `packages/quereus`, all workspaces green), `yarn lint`
all pass. No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Manual reproduction (both defects, from the ticket)

Defect 1 — previously reported success then failed to read back:

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using noalter;
insert into t values (5, 5, 'pre');
alter table t alter primary key (a, b);   -- now: UNSUPPORTED, "does not support …"
select * from t;                          -- still readable, still keyed on (a)
```

Defect 2 — previously lost the committed row:

```sql
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);   -- now: ERROR, "not allowed inside an explicit transaction"
rollback;
select * from t;                          -- [(5, 5, 'pre')] — committed row survives
```

`noalter` is the stub backend from `packages/quereus/test/no-alter-module.ts`.

## Automated coverage

- **`packages/quereus/test/no-alter-module.ts`** (new) — `makeNoAlterModule` moved out of
  `alter-table-conformance.spec.ts` so both specs share one stub. Delegates storage to an inner
  memory module; omits `alterTable` always and `renameTable` unless `withRenameTable: true`.
- **`alter-table-conformance.spec.ts`** — the `alterPrimaryKey` arm is now `stubUnsupported: true`,
  so it joins the no-hook sweep and asserts the sited `UNSUPPORTED` plus an unchanged key. The
  exemption comment names only the two arms that remain exempt (`addConstraint CHECK`,
  `renameColumn`). The separate `withRenameTable: true` rebuild test is unchanged — it is the
  honored leg. Arm label shortened from `alterPrimaryKey (memory: native in-place re-key)` to
  `alterPrimaryKey` (the memory-specific note moved to a comment) since it now names both legs.
- **`alter-primary-key-in-transaction.spec.ts`** — new `describe` with four tests: the refusal
  leaves the transaction open, usable, and `rollback` keeps the committed row and the original
  key; a `commit` after the refusal keeps the transaction's own writes; the same statement is
  still **honored in autocommit** (the `isExplicitTransactionOpen` trap — this is what fails if
  someone swaps in `getAutocommit()`); and a module missing `renameTable` is refused with
  `UNSUPPORTED` even in autocommit, with the table still readable.

## What a reviewer should push on

- **Message wording is load-bearing in one place only.** The conformance sweep matches
  `/does not support|not support/i` against the missing-`renameTable` message. The other three
  assertions (`/explicit transaction/i`, `/\bt\b/`, `does not support`) are my own new tests, so
  they are as strong as I made them — not an independent check.
- **No coverage for a savepoint-only nesting.** `savepoint` without `begin` does not open an
  explicit transaction; I did not test whether that shape reaches the rebuild. Worth a look.
- **The empty-key case is untested against the guards.** `alter primary key ()` is a legal
  statement; it takes the same code path, but I only exercised non-empty key lists.
- **Autocommit rebuild failure mid-way is unchanged and untested here.** If the rebuild's
  `insert … select` fails, the existing `catch` drops the shadow and rethrows — but the `drop`
  of the original has not happened yet at that point, so it should be safe. I did not verify
  this; it is pre-existing behavior either way.
- **The store package's ALTER suite was not run** (`yarn test:store`). The store re-keys
  natively so it never reaches these guards, and `yarn test` covers the isolation leg — but
  that reasoning is inherited from the ticket, not something I re-verified.

## Related known gap (fixed elsewhere, not here)

`@quereus/isolation`'s `alterTable` refuses a primary-key change with `UNSUPPORTED` when the
issuing transaction has rows staged. Inside an explicit transaction, guard 2 now catches that
and the statement is refused cleanly instead of losing data. But the contract violation itself
(an `UNSUPPORTED` used for a *state-dependent* refusal, which the engine is documented to
swallow) is still there and is fixed by `isolation-pk-refusal-busy-not-unsupported`. Guard 2 is
the engine's backstop for any backend; it does not remove a module's own obligation to refuse
with `BUSY`, since that refusal must also happen when the module's own `alterTable` succeeds
structurally.
