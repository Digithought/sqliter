description: When an insert falls back to updating an existing row (the "on conflict do update" form), auto-computed columns are left holding their old, now-wrong values, and it is also possible to write a bogus value straight into one — both of which a plain update correctly prevents.
files:
  - packages/quereus/src/planner/building/insert.ts   # buildUpsertClauses — the one site to change
  - packages/quereus/src/planner/building/update.ts   # the correct behaviour, to mirror
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic
  - docs/sql-ddl.md                                   # "Generated Columns" bullets that today claim otherwise
repro: verified

# `on conflict do update` skips generated-column recompute (and lets you assign one)

## What happens

A generated column is one the user never writes: `g integer generated always as (w * 2)`.
The engine is supposed to compute it on every `insert` and every `update`. It does — except
on the `insert … on conflict … do update set …` path (an "upsert": try to insert, and if the
row is already there, update it instead). There the column is left exactly as the previously
stored row had it, so it silently disagrees with its own definition.

Two arms, both at the same code site:

**Arm A — stale value.** The recompute never runs.

```sql
create table t (id integer primary key, w integer,
                g integer generated always as (w * 2));
insert into t (id, w) values (1, 1);              -- g = 2, correct
insert into t (id, w) values (1, 7)
  on conflict (id) do update set w = 7;
select id, w, g from t;
-- observed: {"id":1,"w":7,"g":2}      <- g still derived from the OLD w
-- expected: {"id":1,"w":7,"g":14}
```

Same with a subquery-valued generated expression (`g generated always as ((select count(*) from c))`):
after rows are added to `c`, an upsert leaves `g` at the old count while a plain `update` on the
same table refreshes it. Nothing about this is specific to subqueries — the plain `w * 2` case
above is enough.

**Arm B — assignable.** The upsert form accepts an assignment to a generated column, which a
plain `update` rejects with `Cannot UPDATE generated column 'g'`:

```sql
insert into t (id, w) values (1, 7)
  on conflict (id) do update set g = 99;
-- observed: succeeds, 99 is stored in g
-- expected: rejected, same as `update t set g = 99`
```

## Root cause — one site

`packages/quereus/src/planner/building/insert.ts`, inside the upsert-clause builder
(the `clause.action === 'update'` branch, the loop over `clause.assignments` that
fills the `assignments` map).

It builds *only* the assignments the user wrote. Compare `packages/quereus/src/planner/building/update.ts`,
which does two extra things this branch does not:

- rejects a SET whose target column is `generated`, and
- after the user's assignments, appends one implicit assignment per generated column,
  walking `tableSchema.generatedColumnTopoOrder` so a generated column that reads another
  generated column sees the freshly computed value.

The upsert branch never routes through `buildUpdateStmt`, so it inherits neither. Both arms
therefore resolve at this one site.

## Expected behaviour

An upsert that takes the DO UPDATE arm should leave the row in exactly the state a plain
`update` with the same SET list would leave it: every generated column recomputed from the
post-update row, in dependency order; and `set <generated column> = …` rejected up front.

Note that whatever recomputes the generated columns here must **await** each evaluated value —
a generated expression may embed a scalar subquery and return a Promise. That was the subject
of `bug-update-generated-column-subquery-not-awaited`; do not repeat it on this path. If the
recompute ends up appended as ordinary assignments the way `building/update.ts` does it, the
already-fixed UPDATE emitter handles that for free.

## Scope notes

- The `on conflict … do nothing` arm writes nothing and is unaffected.
- `on conflict … replace` (delete-then-insert) routes through the INSERT path, which does
  recompute generated columns. Unaffected — but worth a test so it stays that way.
- `docs/sql-ddl.md` § Generated Columns currently states "The value is computed at
  INSERT/UPDATE time" and "Cannot INSERT into or UPDATE a generated column directly."
  Both are true of every path *except* this one. Once fixed the doc needs no change; it is
  listed here only so whoever fixes this confirms it rather than adding a limitation note.
- Test coverage belongs alongside the existing generated-column cases in
  `test/logic/41-generated-column-extras.sqllogic`: cover a plain arithmetic generated
  column, a chained one (generated-from-generated), a subquery-valued one, the rejection
  of `do update set <generated>`, and the `replace` arm as a control.

## How it was found

Probed by hand during the review of `bug-update-generated-column-subquery-not-awaited`,
using the sqllogic runner (`node packages/quereus/test-runner.mjs --grep <file>`) against a
scratch `.sqllogic` file. Both arms reproduced on `main` at c18352fc. Pre-existing: that
ticket's diff touches only `src/runtime/emit/update.ts`, which this path does not reach for
its assignment set.
