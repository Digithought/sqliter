---
description: A table can be created with a computed-column formula that no insert can ever evaluate — the create succeeds, and then every single write to the table fails. Adding the same column to an existing table is correctly refused up front, so the two ways of declaring it disagree.
files:
  - packages/quereus/src/schema/generated-column-refs.ts   # classifyQualified — returns 'foreign' for a qualifier nothing binds
  - packages/quereus/src/schema/table.ts                   # ~1498, ~1554 — the consumers that skip 'foreign' refs
  - packages/quereus/src/planner/building/alter-table.ts   # validateAddColumnGeneratedRefs pre-flight (the ALTER side that does reject)
  - packages/quereus/src/planner/building/generated-column-scope.ts  # where the write-time failure surfaces
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic  # § 4 pins the `old.` instance as current behavior
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Tightening declaration-time acceptance can reject a body some existing schema already stores, so anyone with such a table would find it fails to reload — and since every write to those tables already fails, the practical gain is a better error at a better time rather than new working behavior.
---

# `CREATE TABLE` accepts a generated expression that no write can evaluate

## What goes wrong

A `generated always as (...)` body may refer to a column by a qualified name —
`other.v`, `old.a`. The declaration-time analysis asks: does anything inside the
expression bind that qualifier? If an inner `FROM` binds it, the reference belongs to
that source and is fine. If **nothing** binds it, the analysis still calls the
reference "someone else's" and lets the declaration through. At write time there is no
such thing for it to resolve against, so it fails — every time, for the life of the
table.

The result is a table the engine created without complaint that no `INSERT`, `UPDATE`,
or upsert can ever touch.

## Reproduction (verified, run against the engine)

```sql
create table d (k integer primary key, v integer);

-- accepted — no complaint
create table g (id integer primary key, a integer,
                x integer generated always as (d.v + 1) stored);

insert into g (id, a) values (1, 3);
-- QuereusError: d.v isn't a column
```

`d` is a real table, but nothing inside the body selects from it, so `d.v` names
nothing the row scope can supply. Every write to `g` fails identically, forever. The
same shape with `old.a` instead of `d.v` behaves the same way, and is pinned as current
behavior in `41-generated-column-errors.sqllogic` § 4.

## The same declaration is refused the other way round

`ALTER TABLE ... ADD COLUMN` runs a stricter pre-flight and rejects both spellings at
declaration time, leaving the table untouched:

```sql
alter table g add column x integer generated always as (d.v + 1);
-- QuereusError: d.v isn't a column     <- raised by the ALTER, no column added
```

So the two ways of declaring the identical column disagree about whether it is legal.
That disagreement is the sharper half of the bug: it is not a matter of taste which one
is right, because a `CREATE TABLE` that succeeds here produces a table that cannot be
used at all.

## Root cause

One decision point: the classifier in `schema/generated-column-refs.ts` that labels
each reference in a generated body. Its answer for a qualified reference is either
"binds the owning row", "binds something else", or "cannot tell". A qualifier that no
frame binds falls into "binds something else", which the consumers in `schema/table.ts`
skip entirely — no existence check, no error.

"Binds something else" is doing two jobs it cannot distinguish between: *an inner FROM
exposes this name* (resolvable, fine) and *nothing at all binds this qualifier*
(resolvable by nothing, fatal). While those share one label, no consumer can reject the
second without also rejecting the first.

## What "done" looks like

- The classifier distinguishes an unbound qualifier from a legitimately foreign one, so
  the fatal case is representable and the harmless case is not caught by mistake.
- One declaration-time acceptance check over generated bodies, reached by both
  `CREATE TABLE` and `ALTER TABLE ADD COLUMN`, so the two can no longer disagree about
  the same declaration. The ALTER pre-flight is the behavior to converge on.
- Coverage: for each of `old.<col>` and `<other table>.<col>` with no binding `FROM`,
  `CREATE TABLE` is rejected with the same message and at the same point in the
  statement's life as `ALTER TABLE ADD COLUMN` is today; a body that *does* select from
  another table (`(select v from d where d.k = id limit 1)`) keeps working unchanged.
- `41-generated-column-errors.sqllogic` § 4 flips from pinning create-then-fail to
  pinning rejection at `CREATE TABLE`.

## Adjacent, not in scope

Whether a `CHECK` constraint body carrying an unbound qualifier behaves the same way
was not tested here. It has no equivalent declaration-time reference analysis to
extend, so it is a separate question.
