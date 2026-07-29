---
description: Joining two tables with the shorter `using (col)` syntax can return no rows where writing the same join out longhand as `on left.col = right.col` returns the expected rows, because the short form skips a type-conversion step the long form performs.
files:
  - packages/quereus/src/planner/building/coercion.ts     # insertCrossTypeCoercion — the step USING never reaches
  - packages/quereus/src/runtime/emit/join.ts             # evaluateUsingCondition — the USING comparator
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts  # extractEquiPairsFromUsing
difficulty: medium
---

# `using (col)` and `on l.col = r.col` disagree when the two columns have different types

## What happens

When a comparison's two sides have types that cannot be compared meaningfully as stored,
the planner inserts a conversion on one side. `insertCrossTypeCoercion` does this for `=`,
`BETWEEN`, `IN` value lists and simple `CASE`. A `using` join never goes through it — it
resolves its columns by name and compares them directly — so the two spellings of the same
join can give different answers.

Reproduced at HEAD (2026-07-27) with a `json` column against a `text` column:

```sql
create table ja (id integer primary key, j json);
create table jb (id integer primary key, s text);
insert into ja values (1, '{"a":1,"b":2}');
insert into jb values (1, '{"b":2,"a":1}');

-- long form: the text side is converted to json, the documents compare structurally
select ja.id from ja join jb on ja.j = jb.s;                    -- 1 row (correct)

-- short form over the same two columns renamed to a common name
select 1 from (select j as k from ja) x
        join (select s as k from jb) y using (k);               -- 0 rows (wrong)
```

At runtime a `json` value is a JavaScript object and a `text` value is a string. The
comparison the `using` path performs ranks them by storage class, so they can never be
equal — which is exactly the reason `insertCrossTypeCoercion` exists.

## Expected behavior

A `using (c)` join must produce the same rows as the equivalent `on l.c = r.c`, for every
pair of column types. Today that holds only when the two columns share a type.

## Notes for whoever picks this up

The obvious narrow fix — teach the `using` comparator to convert an object-typed operand's
counterpart the way the cast does — patches this one pairing but leaves the general
divergence in place (the numeric ↔ textual arm of the same function is also skipped).
The structural fix is to desugar `using (c)` into the equivalent `on` condition during
plan building so it inherits coercion, collation resolution and comparison routing for
free; that has to preserve `using`'s output-column merging (the joined column appears
once, not twice), which is why it is not a one-liner.

Related: `mixed-type-equi-join-key-drops-semantic-matches` fixes a different `using`
divergence (duration columns) by routing the comparator through the shared comparison
rule; it explicitly does not attempt this one.
