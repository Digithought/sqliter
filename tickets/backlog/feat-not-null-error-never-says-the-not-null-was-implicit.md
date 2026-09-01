---
description: Quereus makes every column NOT NULL unless you write `null`, which is the opposite of SQLite, Postgres and MySQL. When a write then fails, the error names a constraint the user never wrote and gives them nothing to search for — so a schema ported from another database fails with a message that reads like an engine bug.
files:
  - packages/quereus/src/schema/column.ts                # createDefaultColumnSchema — `notNull: defaultNotNull`, the implicit source
  - packages/quereus/src/schema/table.ts                 # columnDefToSchema — resolves an explicit `null` / `not null` against the session default
  - packages/quereus/src/schema/manager.ts               # buildColumnSchemas — the table-level mirror
  - packages/quereus/src/runtime/row-constraints.ts      # :260 — the message site: `NOT NULL constraint failed: <table>.<col>`
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # :464 — the lens path mints the same message text
  - packages/quereus/src/core/database.ts               # :349 — the `default_column_nullability` option that flips the posture
  - docs/architecture.md                                 # § Design Differences from SQLite — "Default NOT NULL Columns"
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The behaviour is correct and documented, so this is a message and a schema field bought purely for diagnosability — a maintainer may prefer to spend the same effort on the general user-facing advisory channel that `blocked/feat-advisory-when-primary-key-declared-nullable` and `blocked/feat-experimental-feature-runtime-notice` are both waiting on, and get this for free on top of it.
---

# `NOT NULL constraint failed` never says the NOT NULL was implicit

## The report

GitHub issue [#26](https://github.com/gotchoices/quereus/issues/26) reads as a bug: binding
an explicit `null` to a column declared `text default 'X'` throws
`NOT NULL constraint failed`, while omitting the column applies the default fine. The
reporter's expected behaviour is SQLite's and Postgres's — an explicit NULL beats the
default and stores NULL.

**It is not a bug.** Quereus makes a column NOT NULL unless it says `null`
(`docs/architecture.md` § Design Differences from SQLite), so `Mid text default 'X'` *is*
`Mid text not null default 'X'`, and rejecting an explicit null is exactly right.

Verified on `main` at `v4.17.1` (`bd52505ba`) — every supported spelling already works:

```
create table Q (Id text primary key, Mid text default 'X');
insert into Q (Id, Mid) values ('1', null);    -- ERR NOT NULL constraint failed: Q.Mid   (correct)
insert into Q (Id) values ('3');               -- OK, Mid = 'X'

create table Q (Id text primary key, Mid text null default 'X');
insert into Q (Id, Mid) values ('1', null);    -- OK, Mid = null

pragma default_column_nullability = 'nullable';
create table Q (Id text primary key, Mid text default 'X');
insert into Q (Id, Mid) values ('1', null);    -- OK, Mid = null
```

The issue's secondary complaint — that the error can name an unrelated nullable sibling
rather than the offending column — **is already fixed**. The four-column reproduction from
#26 now reports `Q.Mid`, the right column. `runtime/row-constraints.ts:249-254` carries the
attribution rule and cites `test/logic/03.4-defaults.sqllogic` as its guard.

## What is actually wrong

The message is accurate and useless. `NOT NULL constraint failed: Q.Mid` names a constraint
that appears nowhere in the user's DDL, so:

- there is nothing in it to search for. The word that would resolve this in one step —
  the fact that NOT NULL is the *default* — never appears;
- it is indistinguishable from the genuine case where the user *did* write `not null`, which
  is the case that needs no explanation;
- it lands at exactly the moment the divergence bites: someone porting a schema from another
  engine, running their first insert.

This is the same class as the two questions already sitting in `blocked/`
(`feat-advisory-when-primary-key-declared-nullable`,
`feat-experimental-feature-runtime-notice`): a deliberate departure from every other SQL
dialect that is silent until it surprises someone. It differs from those in one useful way —
**an error message is a channel that already reaches the user**, so this arm does not need the
general advisory mechanism those two are blocked on. It can land alone.

## Shape of the fix

The engine cannot currently tell the two cases apart. `ColumnSchema.notNull` is a plain
boolean and `createDefaultColumnSchema` sets it from `defaultNotNull` with no record of
where it came from (`schema/column.ts:98-108`). So:

1. **Record the provenance on the column** — something like
   `notNullSource: 'declared' | 'implicit'` on `ColumnSchema`, set at the two sites that
   resolve nullability (`schema/table.ts` `columnDefToSchema`, `schema/manager.ts`
   `buildColumnSchemas`, plus the ALTER path at `runtime/emit/alter-table.ts:704`). This is
   the *representation* half and is what makes any downstream message possible; a bare
   message tweak that guesses would be wrong for a column the user really did declare.
2. **Say it in the message**, only when implicit. Roughly:
   `NOT NULL constraint failed: Q.Mid (columns are NOT NULL unless declared 'null' — write "Mid text null default 'X'", or set pragma default_column_nullability = 'nullable')`.
   Both message sites must agree — `runtime/row-constraints.ts:260` and the lens path at
   `planner/mutation/lens-enforcement.ts:464` mint the string independently today, which is
   its own small defect: they should share one helper so they cannot drift.
3. **Do not change any behaviour.** No write that succeeds today may fail, and none that
   fails may succeed. The only observable change is error text — which means every test
   asserting on the exact message needs sweeping (`grep -rn "NOT NULL constraint failed"
   packages/quereus/test`).

## Adjacent, deliberately out of scope

`ColumnSchema` gaining a provenance field would also let `explain schema` / the DDL
generator annotate which nullability the user actually wrote, and would give the two blocked
advisory tickets their trigger condition for free. Worth noting when this is picked up, but
not a reason to grow it.
