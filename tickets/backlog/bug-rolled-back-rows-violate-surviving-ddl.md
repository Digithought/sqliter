----
description: When a transaction deletes rows, then changes the table's rules or a column's type, then rolls back, the rule change stays but the deleted rows come back — leaving the table holding data its own schema says is impossible, with no error ever raised.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # effectiveDdlRows, validateUniqueOverEffectiveRows, validateRekeyedUniqueStructures; alterColumn set-data-type branch (~2130-2185)
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus-store/src/common/store-module.ts   # alterColumnSetDataType (~2401) — same effective-rows-only validation
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus/test/alter-table-conformance.spec.ts
  - packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row-memory.sqllogic  # memory-only exclusion that should go away with the fix
  - docs/memory-table.md                                # § DDL and transactions
difficulty: hard
----

# Rolled-back rows can violate the schema change that outlived them

## Root cause

Schema changes in Quereus are not part of the surrounding transaction: a `rollback` does not
undo a `create index` or an `alter table`. That *is* the decided contract for the memory
backend — `feat-ddl-transaction-capability` settled it as the `'non-transactional'` tier, and
raising memory to the fully-transactional tier is the separate backlog ticket
`feat-transactional-ddl-native-backends`.

Separately — and correctly, per `docs/memory-table.md` § DDL and transactions — a schema change
that has to inspect existing rows inspects the rows *the issuing transaction can see*
(`effectiveDdlRows`): the committed rows, plus that transaction's own uncommitted inserts,
minus its own uncommitted deletes.

Put those two facts together and the deletes can be taken back while the rule they justified
stays in force. The table is then holding rows that its own schema forbids, and nothing will
ever notice. **This is one root cause across every row-validating DDL statement** — unique
indexes, collation changes and column retypes are all instances of it, not separate bugs.

## Why it matters

The end state is silent and durable. Verified: after the rollback, a **unique-index seek
returns TWO rows for one key** — a scan happily serves both, and a later insert of a third
duplicate may be accepted or rejected depending on which candidate the enforcement path
happens to compare. Nothing re-validates, because from the engine's point of view the
constraint was already validated. For the retype case the catalog says one thing and the
stored data says another: `where v = 20`-style equality and any index/UNIQUE ordering on the
column see a value of the wrong physical type.

This is the exact "no silent divergence" contract the ALTER conformance matrix exists to
protect.

## Reproductions

All on the memory backend, on `main` at the time of writing.

**A. `create unique index`, undone by `rollback to savepoint`:**

```sql
create table t (id integer primary key, v text);
insert into t values (1, 'a');
begin;
  insert into t values (2, 'a');   -- duplicate, uncommitted
  savepoint s;
  delete from t where id = 2;      -- duplicate gone, from this transaction's point of view
  create unique index ix on t (v); -- accepted: only one 'a' is visible
  rollback to s;                   -- row 2 is back
commit;
-- t now holds ('a'), ('a') under a UNIQUE index on v.
```

**B. `alter column … set collate`, undone by a whole-transaction `rollback`:**

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
insert into t values (1, 'a'), (2, 'A');   -- distinct under BINARY
begin;
  delete from t where id = 2;
  alter table t alter column v set collate nocase;  -- accepted: only 'a' is visible
rollback;
-- The column is still NOCASE and the index is still keyed NOCASE, but row 2 ('A') is back.
```

Case B is a behavior change: before the pending-rows work landed, the collation change
re-checked the committed rows directly and would have refused this ALTER. Refusing it was
also wrong (it blocks the legal case where the transaction really does commit the delete),
so this is not a matter of reverting anything.

**C. `alter column … set data type`, undone by a whole-transaction `rollback`** — a strict
subset of the same fault, previously filed separately:

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

Case C reproduces on **both** underlying modules — plain memory (no `using isolated`) and
isolation-wrapped memory (`using isolated`) — so it is not an isolation-layer issue. It was
found while reviewing `bug-isolation-retype-leaves-staged-rows-unconverted`, which closed a
different (overlay-side) hole; that fix is correct and unrelated, and this one predates it.

## What a fix has to decide

The semantics question is settled (`feat-ddl-transaction-capability`): memory stays on the
`'non-transactional'` tier for now, so "make the schema change roll back too" is **not** this
bug's fix — that is `feat-transactional-ddl-native-backends`, a separate, much larger effort.
Within the settled contract:

- **Recommended:** re-validate the affected structures at `rollback to savepoint` (and at
  whole-transaction `rollback`) when row-validating DDL ran inside the transaction, paying an
  extra scan for a rare statement shape. Accepts every legal case; the only cost lands on the
  transaction that actually created the hazard. The open sub-question is where a failure
  *goes*, since the rollback itself cannot fail — convert-or-reject has nowhere useful to
  report to.
- Or: refuse row-validating DDL when the issuing transaction has uncommitted *deletes* on the
  table — the narrowest rule that closes the hole, at the cost of rejecting a legal case.
  (For the retype arm this is the same shape as "validate over the committed rows regardless
  of pending deletes": safest and simplest, but rejects a retype whose only offending value
  the user has already deleted — the case the current rule was written to allow.)
- Or, for the retype arm only: **document it** as a known limitation like the
  materialized-view retype corner in `docs/materialized-views.md`, and pin it with a test so
  it cannot silently change. This does not address arms A and B.

An interim mitigation already exists: `pragma ddl_transaction_policy = 'strict'` (from
`feat-ddl-transaction-capability`) refuses the DDL inside the transaction outright, closing
this hole for applications that opt in — but the default remains permissive, so the bug still
needs a fix.

## The memory and store legs already disagree behind the isolation wrapper

Found while reviewing `bug-retype-same-class-skips-value-validation`, which widened the retype
validation to retypes that keep the storage class (text → date), so this corner now reaches
many more statements.

When the table sits behind the isolation layer, a transaction's DELETE is a tombstone in the
wrapper's overlay. The memory module is handed the wrapper's merged row stream and honors it,
so the deleted row's offending value does not block the retype. The store module's convert
pre-pass ignores that stream and scans its own committed rows, so it still sees the deleted
row and **rejects**. Same statement, same data, opposite answers depending on the backing
module.

The test pinning the accepting behavior therefore had to be marked memory-only:
`packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row-memory.sqllogic`.
Whichever option is chosen, closing this should also remove that exclusion — the
reject-on-pending-deletes option makes both legs reject; the re-validate and document options
require the store's pre-pass to read the wrapper-supplied `EffectiveRowSource` the way
`alterColumnSetNotNull` already does (see the NOTE in `StoreModule.alterColumnSetDataType`).
The memory and store legs must agree either way — they share the validation shape today and
the conformance matrix asserts they behave identically.

## Documentation

`docs/memory-table.md` § DDL and transactions needs updating; it currently carries a paragraph
pointing here.
