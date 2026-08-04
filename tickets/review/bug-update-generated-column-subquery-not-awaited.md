----
description: Fixed a bug where updating a row in a table with an auto-computed column defined by a sub-query stored a meaningless placeholder instead of the computed number; regression tests added.
files:
  - packages/quereus/src/runtime/emit/update.ts                      # the fix (phase-2 generated-column recompute)
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic  # regression coverage, sections 6 & 7
  - docs/determinism.md                                              # added "deterministic does not imply synchronous" note
repro: verified
----

# UPDATE stored a Promise in a generated column whose expression is a sub-query

## What was wrong

A generated column (`generated always as (…)`) whose expression contains a scalar
sub-query computed correctly on `insert`, but any later `update` of the same row replaced
it with a value that serialised as `{}` — a raw `Promise` object written straight into the
row and coerced/stored.

The generated-column recompute in `emitUpdate` (phase 2) called each assignment evaluator
*without* awaiting it, justified by a comment asserting that a deterministic generated
expression "cannot contain scalar subqueries and always return synchronously". That premise
was false: `validateDeterministicGenerated` only rejects `random()` / `now()`-style
non-determinism, and a sub-query over a table is perfectly deterministic within a
statement — so it passes the gate and its evaluator returns a `Promise`.

## What changed

`packages/quereus/src/runtime/emit/update.ts`:

- Phase 2 now uses `withAsyncRowContext` (the await-capable twin of `withRowContext`,
  already present in `runtime/context-helpers.ts`) and awaits each evaluator.
- Added `generatedRowDescriptor` — a distinct descriptor object carrying the same
  attribute IDs as `sourceRowDescriptor`. `RowContextMap` is keyed by descriptor
  *identity*, so reusing `sourceRowDescriptor` meant the phase-2 teardown deleted the
  update emitter's own streaming slot registration. This is hygiene, not the bug fix —
  the defect is fixed either way — but it removes reliance on the underlying scan
  happening to backstop the lookup.
- Deleted the false comment; replaced with one stating that phase 2 may evaluate
  asynchronously because deterministic does not imply synchronous.
- Added a `NOTE:` tripwire at the site: both phases use a bare `await`, which costs a
  microtask per evaluator even for synchronous ones. If UPDATE row throughput ever shows
  up as hot, switch both loops to the `raw instanceof Promise ? await raw : raw` idiom
  used at the constraint-check evaluator sites. Not done now — it would expand the diff
  and phase 1 already used a bare `await`, so the two phases stay consistent.

`docs/determinism.md`: added a callout under the intro that deterministic does not imply
synchronous, since that inference is the exact trap this bug fell into and the doc is
where a future reader reasons about what the validators guarantee.

`test/logic/41-generated-column-extras.sqllogic`: two new sections (6 and 7).

## Use cases to test / validate

Section 6 — `t_src` (3 rows) + `t_sub` with `g integer generated always as ((select count(*) from t_src))`:

- After `insert`, `g` = 3 for both rows (this always worked; pinned as a control).
- After `update t_sub set w = 5 where id = 1` — an unrelated column — `g` is still `3`,
  not `{}`. **This is the assertion that fails without the fix** (verified: reverting the
  fix produces `Actual: {"id":1,"w":5,"g":{}}` at that exact line).
- After two more rows land in `t_src`, a further `update` recomputes `g` to `5` — proving
  the value is genuinely re-evaluated, not carried forward from the stored row.
- A multi-row `update t_sub set w = w + 10` with no `where` — exercises the phase-2
  context install/teardown across loop iterations, which is where the separate
  `generatedRowDescriptor` matters.

Section 7 — chained generated columns across the async path: `g` from a sub-query,
`g2 generated always as (g * 2) stored`. Confirms the topological-order recompute
(`generatedColumnTopoOrder`, applied in `planner/building/update.ts`) still feeds the
freshly-awaited `g` into `g2`. Also uses the `stored` spelling where section 6 uses the
bare spelling, so both parse forms are covered.

Manual repro from the original ticket, for a reviewer who wants to see it by hand:

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);
create table ug (id integer primary key, w integer,
                 g integer generated always as ((select count(*) from c)));
insert into ug (id, w) values (1, 1);
update ug set w = 5 where id = 1;
select id, w, g from ug;   -- was [{"id":1,"w":5,"g":{}}], now [{"id":1,"w":5,"g":3}]
```

## Validation run

- `node ... mocha packages/quereus/test/logic.spec.ts --grep 41-generated-column` — 3 passing.
- Negative control: temporarily reverted the phase-2 change and re-ran; the new test
  fails with `Actual: {"id":1,"w":5,"g":{}}` / `Expected: {"id":1,"w":5,"g":3}`. So the
  test genuinely catches the bug rather than passing vacuously. Fix restored afterwards.
- `yarn workspace @quereus/quereus run test` — **8674 passing, 13 pending, 0 failing**.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn lint` (repo-wide) — clean.

## Known gaps — please poke at these

- **Store backend not exercised.** Only `yarn test` (memory-backed) was run.
  `yarn test:store` (LevelDB) was not — it is slow and the fix is in the emitter, above
  the storage layer, so it should be backend-independent. Unverified assumption, though.
- **Other DML paths reasoned about, not all tested.** `insert` was already correct (the
  original ticket verified it, and section 6 pins it). `ALTER TABLE ADD COLUMN` backfill
  was inspected — `runtime/emit/alter-table.ts` already uses
  `valueRaw instanceof Promise ? await valueRaw : valueRaw`, so it is safe — but there is
  no test for a sub-query generated expression added via `ALTER TABLE ADD COLUMN`.
  That would be worth adding if a reviewer thinks the gap is real. Note `docs/sql-alter.md`
  records a separate pre-existing limitation there: inside a `GENERATED ALWAYS AS`
  expression a subquery may not name another table's column *unqualified*. Untouched by
  this ticket.
- **`withRowContext` now has zero callers in `src/`.** It is still exported and still
  documented as a public runtime helper in `docs/runtime.md` § Pattern 2, so it was kept
  deliberately. If the reviewer would rather it go, that is a judgement call, not a
  correctness one.
- **Interaction with generated columns under UNIQUE / PRIMARY KEY constraints was not
  tested on the async path.** Sections 4 and 5 of the same file cover that for synchronous
  expressions only. A sub-query-generated UNIQUE column is an odd schema to write, so this
  was judged low-value, but it is a real hole in the matrix.
- **No test for a sub-query generated column inside an explicit transaction** or one whose
  sub-query reads the table being updated. The latter in particular could have surprising
  read-your-own-writes semantics and was not investigated.
