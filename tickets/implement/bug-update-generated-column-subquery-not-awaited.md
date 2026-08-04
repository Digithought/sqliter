----
description: Updating a row in a table whose auto-computed column is defined by a sub-query stores a meaningless placeholder value instead of the computed number; the fix is verified and needs landing with regression tests.
files:
  - packages/quereus/src/runtime/emit/update.ts        # the un-awaited evaluator call (the one site to change)
  - packages/quereus/src/runtime/context-helpers.ts    # withAsyncRowContext — the await-capable helper to use
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic  # where the regression test belongs
repro: verified
----

# UPDATE stores a placeholder in a generated column whose expression is a sub-query

## What goes wrong

A generated column (`generated always as (…)`) whose expression contains a scalar
sub-query computes correctly on `insert`, but any later `update` of the same row replaces
it with a value that serialises as `{}` — a raw `Promise` object written straight into the
row.

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);

create table ug (
  id integer primary key,
  w  integer,
  g  integer generated always as ((select count(*) from c))
);

insert into ug (id, w) values (1, 1);
select id, w, g from ug;      -- [{"id":1,"w":1,"g":3}]   correct

update ug set w = 5 where id = 1;
select id, w, g from ug;      -- [{"id":1,"w":5,"g":{}}]  wrong
```

Reproduced at `HEAD` on the memory backend. Controls confirm the shape: a *user-written*
`set g2 = (select count(*) from c)` stores `3` correctly, and a generated column with a
non-sub-query expression (`generated always as (w * 2)`) recomputes correctly. So the
defect is specific to the generated-column recompute path on `update`, and specific to
expressions that evaluate asynchronously.

## Root cause — one site

`packages/quereus/src/runtime/emit/update.ts`, the phase-2 loop (currently lines 99–107).
Phase 1 (user-written assignments) awaits each evaluator; phase 2 (generated columns) does
not, on the strength of this comment:

```ts
// Generated expressions are validated as deterministic (see
// validateDeterministicGenerated in update.ts builder), so they cannot
// contain scalar subqueries and always return synchronously.
```

The premise is false. `validateDeterministicGenerated`
(`planner/validation/determinism-validator.ts`) only checks
`expr.physical.deterministic === false` — it rejects `random()`, `now()` and friends. A
sub-query over a table is perfectly deterministic within a statement, so it passes, its
evaluator returns a `Promise`, and the promise object is written into the row, coerced,
and stored.

Delete that comment along with the code it justifies — the "deterministic ⇒ synchronous"
inference is wrong in general and must not survive in the file.

## The fix (verified)

`withAsyncRowContext` already exists in `runtime/context-helpers.ts` and is the
await-capable twin of `withRowContext` — it keeps the row context installed across the
await and tears it down in `finally`. The change is a swap plus awaiting the evaluator:

```ts
// import: withRowContext -> withAsyncRowContext (update.ts is the only caller of
// withRowContext in src/, but the helper stays — it is documented public runtime API
// in docs/runtime.md § Pattern 2)

if (generatedIndices.length > 0) {
    await withAsyncRowContext(rctx, generatedRowDescriptor!, () => updatedRow, async () => {
        for (const i of generatedIndices) {
            const value = await assignmentEvaluators[i](rctx) as SqlValue;
            updatedRow[assignmentTargetIndices[i]] = value;
        }
    });
    if (coerceGenerated) updatedRow = coerceGenerated(updatedRow);
}
```

with, next to the `coerceGenerated` construction:

```ts
// Distinct descriptor object carrying the same attribute IDs as `sourceRowDescriptor`,
// so tearing the phase-2 context down does not evict the streaming source slot (the
// context map is keyed by descriptor identity).
const generatedRowDescriptor = generatedIndices.length > 0
    ? buildRowDescriptor(plan.source.getAttributes())
    : undefined;
```

Both halves were run: repro fixed (`g` = `3` after update, single-row and multi-row), and
`yarn workspace @quereus/quereus run test` passed 8674 / 13 pending with the patch applied.

### On the separate descriptor object

`RowContextMap` is keyed by descriptor **identity**. Today phase 2 passes
`sourceRowDescriptor` — the same object the streaming `slot` registered — so the
`withRowContext` teardown deletes the update emitter's own slot registration from the map.
That is survivable only because the underlying scan installs its own context over the same
attribute IDs and backstops the lookup (measured: passing `sourceRowDescriptor` to
`withAsyncRowContext` also fixes the repro and also passes the suite). The distinct
descriptor removes the reliance on that accident; it is hygiene, not the bug fix. Keep it,
but if it complicates something, dropping it does not reintroduce the defect.

### Hot-path note

`runtime/async-util.ts` documents that a bare `await x` costs a microtask even when `x` is
not a thenable, and the codebase's convention at per-row evaluator sites is
`const raw = ev(rctx); const v = raw instanceof Promise ? await raw : raw;` (see
`emit/constraint-check.ts:175` and `:457`). Phase 1 of this same function uses a bare
`await` today, so bare `await` in phase 2 is consistent with its neighbour. Matching the
`instanceof Promise` idiom in **both** phases is a reasonable optional tidy-up; do not let
it expand the diff if it turns out to be noisy.

## Checked: the bad assumption is not copied elsewhere

Swept `src/` for other evaluator calls relying on "deterministic ⇒ synchronous". The two
other per-row evaluator sites (`emit/constraint-check.ts:175`, `:457`) already branch on
`instanceof Promise`. The only other "resolves synchronously" claim is in
`core/database-materialized-views-analysis.ts:501`, and it is sound: that path gates on
`assertSingleRowEvaluable`, which explicitly excludes sub-queries, and it surfaces a
Promise result loudly rather than storing it.

## TODO

- Swap phase 2 of `emitUpdate` (`runtime/emit/update.ts`) to `withAsyncRowContext` + an
  awaited evaluator call, per the patch above; add the `generatedRowDescriptor`.
- Delete the false "cannot contain scalar subqueries / always return synchronously"
  comment; replace it with one that says phase 2 may evaluate asynchronously (a generated
  expression may embed a scalar sub-query — deterministic does not imply synchronous).
- Add regression coverage to `test/logic/41-generated-column-extras.sqllogic`: a table with
  `g integer generated always as ((select count(*) from c))`, asserting the value after
  `insert`, after an `update` of an unrelated column, and after the row count of `c` changes
  and a further `update` reruns the recompute (proves the value is recomputed, not carried).
  Cover the multi-row `update … set w = w + 10` (no `where`) case too — it exercises the
  phase-2 context teardown across iterations.
- Add a chained case: a generated column whose sub-query expression feeds another generated
  column (`generated always as (g * 2)`), so the topological-order recompute is exercised on
  the async path.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`.
