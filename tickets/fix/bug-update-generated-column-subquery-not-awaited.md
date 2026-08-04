----
description: Updating a row in a table whose auto-computed column is defined by a sub-query stores a meaningless placeholder value instead of the computed number.
files:
  - packages/quereus/src/runtime/emit/update.ts        # the un-awaited evaluator call
  - packages/quereus/src/planner/building/update.ts    # where the generated-column assignment is appended
  - packages/quereus/src/planner/validation/determinism-validator.ts  # the guarantee the comment relies on
repro: verified
----

# UPDATE stores a placeholder in a generated column whose expression is a sub-query

## What goes wrong

A generated column (`generated always as (…)`) whose expression contains a scalar
sub-query is computed correctly on `insert`, but any later `update` of the same row
replaces it with a value that serialises as `{}` — not a number, not null, not an error.

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);

create table ug (
  id integer primary key,
  w  integer,
  g  integer generated always as ((select count(*) from c))
);

insert into ug (id, w) values (1, 1);
select id, w, g from ug;      -- [[1, 1, 3]]   correct

update ug set w = 5 where id = 1;
select id, w, g from ug;      -- [[1, 5, {}]]  wrong
```

Verified on the memory backend at `HEAD`. Two controls confirm the shape:

- `update plain set w = (select count(*) from c) …` — a *user-written* `set` with the same
  sub-query stores `3` correctly.
- a generated column with a non-sub-query expression (`generated always as (w * 2)`)
  recomputes correctly on `update`.

So it is specific to the generated-column recompute path, and specific to expressions that
evaluate asynchronously.

## Root cause

`packages/quereus/src/runtime/emit/update.ts` evaluates assignments in two phases. Phase 1
(user-written assignments) awaits each evaluator. Phase 2 (generated columns) does not:

```ts
// Generated expressions are validated as deterministic (see
// validateDeterministicGenerated in update.ts builder), so they cannot
// contain scalar subqueries and always return synchronously.
if (generatedIndices.length > 0) {
    withRowContext(rctx, sourceRowDescriptor, () => updatedRow, () => {
        for (const i of generatedIndices) {
            const value = assignmentEvaluators[i](rctx) as SqlValue;   // <- not awaited
            updatedRow[assignmentTargetIndices[i]] = value;
        }
    });
```

The stated premise is false. `validateDeterministicGenerated` rejects *non-deterministic*
constructs (`random()`, `now()`, and friends); it does not reject sub-queries — a sub-query
over a table is perfectly deterministic within a statement. So an evaluator for such an
expression returns a `Promise`, and the raw promise object is written into the row, coerced,
and stored. `{}` is that promise round-tripping through JSON.

The comment is also the reason the synchronous shape was chosen: the loop runs inside
`withRowContext`, a synchronous callback that installs the row context for the duration of
the call. Awaiting inside it is not a one-line change — the row context has to stay
installed across the await, so the fix has to either make `withRowContext` await-capable or
restructure phase 2 to establish the context another way.

## Expected behavior

`update` recomputes a generated column to the same value the equivalent `insert` would
produce, whatever the expression's shape. If some expression shape genuinely cannot be
supported on the update path, it must be rejected at `create table` / `alter table` time
with a clear message — never silently stored.

## Notes for whoever picks this up

- The insert path is unaffected because it computes generated columns through a
  `ProjectNode` chain (`createGeneratedColumnProjection` in
  `planner/building/insert.ts`), which awaits normally.
- Worth checking whether the same un-awaited assumption exists anywhere else that leans on
  "deterministic ⇒ synchronous" — that inference is wrong in general and may have been
  copied.
- Found while investigating `bug-schema-defaults-bind-callers-cte` (now in `implement/`);
  the two are independent and touch different files.
