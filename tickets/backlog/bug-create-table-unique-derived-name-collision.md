----
description: If someone names a uniqueness rule using a prefix the engine reserves for its own internal names, and that name happens to be the one the engine would generate for a different rule on the same table, one of the two rules quietly stops working. Changing the table later is refused for the same reason, but creating it is not.
files:
  - packages/quereus/src/schema/manager.ts                     # createTable — where the CREATE-time constraint checks live, ~2767
  - packages/quereus/src/schema/catalog.ts                     # assertUniqueConstraintIndexNameFree + its NOTE on the backend-dependent input
  - packages/quereus/src/vtab/memory/layer/manager.ts          # ensureUniqueConstraintIndexes — where the two names meet
  - packages/quereus/test/index-ddl-roundtrip.spec.ts          # "two UNIQUE constraints deriving one structure name…" pins the current shape
repro: verified
difficulty: medium
----

## The problem

Every `UNIQUE` rule is enforced through a hidden index the user never sees. A named
rule's hidden index takes the rule's name; an unnamed one gets a generated name
`_uc_<columns>` — for example `unique (c)` generates `_uc_c`. The `_uc_` prefix is
reserved for the engine.

Nothing stops a user from *typing* that prefix as a constraint name. When they do,
and it lands on the generated name of another rule on the same table, two rules want
one hidden index. `ALTER TABLE` refuses that (on the in-memory backend), but
`CREATE TABLE` runs no equivalent check, so the table is created and one of the two
rules is left pointing at a structure built for the other rule's column — after which
it accepts duplicates it should reject.

## Measured

Current tree, in-memory backend:

```sql
create table t (id integer primary key, c integer, b integer,
                constraint _uc_c unique (b),   -- reserved-prefix name
                unique (c));                   -- generates the same name

insert into t values (1, 5, 7);
insert into t values (2, 5, 8);   -- accepted; `unique (c)` should reject it
insert into t values (3, 6, 7);   -- rejected, as expected: `_uc_c` still works
```

The table ends up with one hidden index, `_uc_c`, keyed on `b`. `unique (c)` adopts
it and therefore checks the wrong column. The rule that owns the name is unharmed.

This was measured on the in-memory backend only. The persistent store does not
materialize hidden indexes into the table's index list at all, so the shape there is
different and was not checked — do that during the fix.

## Why it is filed rather than fixed

Reaching it requires typing an engine-reserved prefix into a constraint name, which
no ordinary schema does. The existing behavior is also already documented as a known
corner (see the note on `findIndexShadowedByUniqueConstraint` in `schema/catalog.ts`,
which records that the two backends disagree here). It is nevertheless a silent loss
of enforcement, not a cosmetic quirk, which is why it is a bug rather than debt.

## Expected behavior

`CREATE TABLE` should refuse a table whose `UNIQUE` rules cannot all get their own
hidden index — i.e. when two of them resolve to the same hidden-index name — with a
`CONSTRAINT`-class error naming both rules, matching what `ALTER TABLE` already does.
The refusal must be the same on both backends, which means comparing the rules'
*derived names* against each other rather than against whatever index list a
particular backend happens to have materialized.

Two things must keep working unchanged:

- an ordinary named rule beside an unnamed one over different columns (the normal
  case — the names simply do not collide);
- a rule reusing a genuinely matching user index over the same columns, which is
  matched on columns rather than names and is not affected.

Reading the catalog of a database written before the rule should keep working
(warn and proceed), like every other guard of this kind here.
