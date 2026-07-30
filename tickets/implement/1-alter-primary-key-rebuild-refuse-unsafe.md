---
description: Changing a table's primary key on a backend that cannot do it itself makes the engine quietly rebuild the table, and that rebuild can leave the table unreadable or — if the surrounding transaction is rolled back — destroy rows that were committed long before. Refuse the rebuild in both situations instead of producing a broken result.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAlterPrimaryKey (~1420); rebuildTableWithNewShape (~1530); rebuildViaShadowTable (~1687)
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts  # isExplicitTransactionOpen — reuse, do not reinvent
  - packages/quereus/test/alter-table-conformance.spec.ts   # makeNoAlterModule (~543); the `alterPrimaryKey` arm (~198) and the exemption comment (~602)
  - docs/sql-ddl.md                                         # ~624 — the ALTER PRIMARY KEY rebuild-fallback sentence
  - docs/module-authoring.md                                # ~905 — already documents the "refuse with BUSY, not UNSUPPORTED" contract; extend with the two new engine guards
difficulty: medium
---

# Background

`alter table … alter primary key` first asks the table's backend to re-key itself
(`module.alterTable` with `{ type: 'alterPrimaryKey' }`). Both built-in backends (the in-memory
one and the key-value store one) do that in place. A backend that cannot raises `UNSUPPORTED`,
and `runAlterPrimaryKey` falls through to a generic rebuild — `rebuildViaShadowTable`, which
runs four ordinary SQL statements through `db._execWithinTransaction`:

```
create table <table>__rekey_<timestamp> (… same columns, new primary key …)
insert into <shadow> (cols) select cols from <table>
drop table <table>
alter table <shadow> rename to <table>
```

Two of the rebuild's failure modes destroy or strand user data. Both are fixed here by
**refusing the rebuild** rather than by trying to make it safe — there is no correct outcome
available in either case (see *Why refuse* below).

Both reproductions below use the stub backend the ALTER conformance suite already builds,
`makeNoAlterModule` in `packages/quereus/test/alter-table-conformance.spec.ts` (~543): it
delegates storage to an inner in-memory module and deliberately omits both the `alterTable`
and `renameTable` hooks. Verified on current `main`.

# Defect 1 — no `renameTable` hook ⇒ the table becomes unreadable

The rebuild's last step renames the shadow table over the original. A backend that files its
rows under the table's name must hear about that rename; the engine calls `module.renameTable`
only when the module has one, and otherwise performs a catalog-only rename. A backend with
neither hook — no `alterTable` (so it takes the rebuild) and no `renameTable` (so it never
learns of the swap) — ends up with its rows still stored under the shadow name while the
catalog says otherwise. Plain autocommit, no transaction needed:

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using noalter;
insert into t values (5, 5, 'pre');
alter table t alter primary key (a, b);   -- reports success
select * from t;
-- QuereusError: Module 'noalter' connect failed for table 't':
--   Memory table definition for 't' not found. Cannot connect.
```

The conformance suite never catches this because the `alter primary key` arm is marked exempt
from the no-hook leg (`stubUnsupported: false`, and the explanatory comment at ~602), and the
one test that *does* exercise the rebuild opts the rename hook back in
(`makeNoAlterModule({ withRenameTable: true })`).

# Defect 2 — `rollback` after the statement destroys previously committed rows

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using noalter;
insert into t values (5, 5, 'pre');   -- committed
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
rollback;
select * from t;  -- []  — the committed row is gone
```

The two halves of the rebuild have different transactional lifetimes. The **schema** half (the
`drop table` and the `rename`) escapes rollback: that is the settled `'non-transactional'`
DDL tier from `feat-ddl-transaction-capability` (see
`packages/quereus/src/vtab/capabilities.ts` § `DdlTransactionality`). The **data** half (the
row copy) is staged in the transaction and *is* undone. So `rollback` keeps the new, empty
table and discards the copy of the rows that table replaced. Committed data the transaction
never touched is destroyed.

The same statement sequence is reachable today through `@quereus/isolation`: its `alterTable`
refuses a primary-key change while the issuing transaction has rows staged, and it raises that
refusal as `UNSUPPORTED`, which `runAlterPrimaryKey` swallows on its way into this rebuild.
That contract violation is fixed separately in
`isolation-pk-refusal-busy-not-unsupported` — it is the isolation layer's bug, whereas the
guard below is the engine's backstop for *any* backend.

This is a different failure from `backlog/bug-rolled-back-rows-violate-surviving-ddl`, which
is about a surviving *constraint* being violated by rows a rollback brought back. Here the
rows are simply gone.

# Why refuse rather than repair

**Defect 2** has no correct outcome while the rebuild is available inside an explicit
transaction. Making the schema half roll back would require transactional DDL, which no
built-in module offers (`DdlTransactionality: 'transactional'` — "No built-in module reaches
this tier today"). Making the data half survive rollback would mean committing part of the
user's transaction behind their back. Refusing is the only answer that loses nothing, and it
is what the isolation layer already tries to say. Note this refusal is *narrower* than the
existing `pragma ddl_transaction_policy = 'strict'` gate: that gate refuses the whole class of
module-dispatching DDL inside a transaction for callers who opt in, on the grounds that the
schema change merely *escapes* rollback. The rebuild is worse than escaping — it destroys
committed rows — so it is refused under the default `'permissive'` policy too.

**Defect 1** is a static capability gap: for a backend with no `renameTable`, the rebuild can
never produce a readable table, in any transaction state. A sited refusal is strictly better
than a statement that reports success and leaves the table unopenable.

# Design

Both guards belong at the point where `runAlterPrimaryKey` decides to rebuild — after the
native attempt has failed or been skipped, immediately before
`rebuildTableWithNewShape(...)` at `alter-table.ts:1510`. Placing them there covers both
entry paths into the rebuild (module has no `alterTable`; module raised `UNSUPPORTED`) with
one check each, and a module that raised `UNSUPPORTED` has by contract mutated nothing, so the
refusal still leaves the catalog, the table, and the enclosing transaction untouched.

Order the two checks **capability first, transaction second**: the missing-hook refusal is
unconditional (that backend can never take this path), so it is the more informative answer
when both apply.

```
// in runAlterPrimaryKey, replacing the bare `// Rebuild fallback` comment

if (!module.renameTable) throw QuereusError(…, StatusCode.UNSUPPORTED)
if (isExplicitTransactionOpen(rctx.db)) throw QuereusError(…, StatusCode.ERROR)
await rebuildTableWithNewShape(…)
```

**Codes and messages.**

- Missing `renameTable` ⇒ `StatusCode.UNSUPPORTED`, sited on the table and the module. The
  message **must** contain the words `does not support` (or `not support`) so it satisfies the
  conformance suite's stub-leg matcher `/does not support|not support/i`. State the mechanism
  plainly: the fallback finishes by renaming a shadow table over this one, and without the
  hook the backend would keep the rows under the shadow name.
- Explicit transaction open ⇒ `StatusCode.ERROR`, matching `assertDdlTransactionPolicy`'s
  choice for its own statement-level refusal. Deliberately **not** `BUSY`: retrying inside the
  same transaction can never succeed, so a retryable code would mislead. Say what to do
  instead — commit or roll back first and re-issue in autocommit mode.

**Use `isExplicitTransactionOpen(db)` from `ddl-transaction-policy.ts`; do not hand-roll the
check.** Its doc comment explains the exact trap: in autocommit the ALTER's own
`_ensureTransaction()` has already opened an *implicit* transaction, so `db.getAutocommit()`
alone reads `false` and a naive check would refuse the autocommit case — the one case the
rebuild handles correctly. The helper combines `!getAutocommit() && !_isImplicitTransaction()`.

**Do not narrow the `catch (e) { if UNSUPPORTED ⇒ fall through }` at
`alter-table.ts:1500-1506`.** The swallow is the documented protocol (`docs/module-authoring.md`
§ *`alterPrimaryKey`*, ~905: "throw `UNSUPPORTED`… `runAlterPrimaryKey` catches that specific
code and falls back to a generic shadow-table rebuild"), and the same paragraph already tells
module authors to use a non-`UNSUPPORTED` code (`BUSY`) for a state-dependent refusal. It does,
however, currently discard the caught error with no trace, which conflicts with the project
rule against silently eating exceptions: **log it at warn** before falling through, naming the
module, the table, and the message. That one line is the whole of the point-4 engine work.

# Docs

- `docs/sql-ddl.md` ~624: the rebuild-fallback sentence currently reads as unconditional. State
  the two preconditions (the backend must have a `renameTable` hook; the statement must not be
  inside an explicit transaction) and what happens when either fails.
- `docs/module-authoring.md` ~905: the `alterPrimaryKey` paragraph already warns that the
  fallback copies committed rows only. Add the two engine-side guards to it, so a module author
  reading "the engine falls back to a rebuild" learns when it does not.

# TODO

- Add the missing-`renameTable` guard in `runAlterPrimaryKey`, immediately before
  `rebuildTableWithNewShape`, raising a sited `UNSUPPORTED` whose text matches
  `/does not support|not support/i`.
- Add the explicit-transaction guard after it, using `isExplicitTransactionOpen` imported from
  `./ddl-transaction-policy.js`, raising a sited `StatusCode.ERROR`.
- Add a `warnLog` where the native attempt's `UNSUPPORTED` is swallowed (~1501), naming module,
  table, and the swallowed message.
- Update the `alterPrimaryKey` arm in `packages/quereus/test/alter-table-conformance.spec.ts`
  to `stubUnsupported: true` so it joins the no-hook sweep, and rewrite the exemption comment
  at ~602 to name only the two arms that remain exempt (`addConstraint … check`, `renameColumn`).
  Keep the separate `withRenameTable: true` rebuild test — it is the honored leg.
- Add regression coverage for defect 2: seed a committed row on the stub backend
  (`withRenameTable: true`), open an explicit transaction, insert, issue
  `alter table … alter primary key`, assert the refusal, assert the transaction is still open
  and usable, then `rollback` and assert the committed row is still there and the primary key
  is unchanged. Reasonable home: a new `describe` in `packages/quereus/test/alter-primary-key-in-transaction.spec.ts`,
  whose header comment already frames the mid-transaction-rebuild data-loss family.
- Add regression coverage for defect 1 beyond the conformance sweep only if the sweep does not
  already read back the table — the sweep's `confirm(db, 'rejected')` asserts the primary key
  is unchanged, which is enough.
- Update `docs/sql-ddl.md` and `docs/module-authoring.md` as above.
- Run `yarn build`, then `yarn test` (streamed, `2>&1 | tee /tmp/t.log`), then `yarn lint`.
  `packages/quereus-isolation` and `packages/quereus-store` both have ALTER conformance suites
  that go through `runAlterPrimaryKey`; `yarn test` covers the isolation one, and the store
  re-keys natively so it never reaches these guards — no `yarn test:store` run is needed.
