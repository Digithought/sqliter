----
description: When two uniqueness rules on one table end up wanting the same internal name for the hidden structure that enforces them, one of the two quietly stops working. Changing the table later is refused for that reason, but creating it is not — and ordinary column names can trigger it, no unusual spelling needed.
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
different — see the store note under the second route below, which found it unaffected.

## Second route — no reserved prefix, no unusual spelling (found in review, 2026-07-31)

The generated name joins the covered column names with `_`. So a single column named
`a_b` generates the same name as the column pair `(a, b)`, and two perfectly ordinary
`UNIQUE` declarations collide:

```sql
create table t (id integer primary key, a_b integer, a integer, b integer,
                unique (a_b), unique (a, b));

insert into t values (1, 1, 1, 1);
insert into t values (2, 2, 1, 1);   -- accepted; `unique (a, b)` should reject it
insert into t values (3, 1, 3, 3);   -- rejected, as expected: `unique (a_b)` works
```

Measured on the in-memory backend, current tree (`repro: verified`). The table ends up
with one hidden index, `_uc_a_b`, keyed on `a_b`; the pair rule adopts it and checks the
wrong column. The duplicate-rule guard added by
`bug-duplicate-unnamed-unique-constraint` does not and should not fire here — `(a_b)`
and `(a, b)` are genuinely different rules.

The persistent store is **not** affected: it resolves a rule's serving index by
comparing *columns* rather than names (`findIndexForUniqueConstraint` in
`quereus-store/src/common/store-table-constraints.ts`), finds none that matches, and
falls back to a correct full scan. So this is an in-memory-backend defect, and the two
backends silently disagree on whether the second rule enforces.

This route raises the priority: the original one needed a user to type an
engine-reserved prefix, this one needs only a column named with an underscore beside a
two-column rule over those names. Whoever picks this up should consider promoting it out
of `backlog/` rather than treating it as a corner case.

## Why it was originally filed rather than fixed

The first route requires typing an engine-reserved prefix into a constraint name, which
no ordinary schema does. The existing behavior is also already documented as a known
corner (see the note on `findIndexShadowedByUniqueConstraint` in `schema/catalog.ts`,
which records that the two backends disagree here). It is nevertheless a silent loss
of enforcement, not a cosmetic quirk, which is why it is a bug rather than debt. The
second route above removes the "no ordinary schema does that" argument.

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
