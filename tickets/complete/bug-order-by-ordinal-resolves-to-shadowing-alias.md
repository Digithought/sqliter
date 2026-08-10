---
description: Sorting or grouping by column number (`order by 2`, `group by 1`) now points at the numbered result column instead of being turned back into a column name, so a column alias or a same-named column from another table can no longer hijack it.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts       # SelectListEntry, the two binding helpers
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy + `outputRelation` alignment guard
  - packages/quereus/src/planner/building/select.ts               # threads the output relation from all three branches
  - packages/quereus/src/planner/building/select-aggregates.ts    # GROUP BY / pre-aggregate sort / ordinal-aware aggregate detection
  - packages/quereus/src/planner/building/select-compound.ts      # compound call site renamed onto the shared helper
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # regression block (implement + review additions)
  - docs/sql-select.md                                            # GROUP BY + ORDER BY positional bullets
difficulty: medium
repro: verified
---

# `order by <number>` binds to an output position, not to a name

## Outcome

A positional reference in `order by` / `group by` now means "the Nth result
column" rather than "re-plan the text that produced the Nth result column".

- **Above the projection** (the common `order by N`): binds to the Nth *output
  attribute* of the relation whose attributes are the result columns. This is the
  mechanism compound (`union`/`intersect`/`except`) ORDER BY already used; that
  helper was generalized into `resolveOrdinalOutputColumn` and both paths share it.
- **Below/beside the projection** (GROUP BY, pre-projection sorts, pre-aggregate
  sorts, pre-window sorts): no output attributes exist yet, so the authored
  expression is re-planned — except for a column that came from a star, which
  carries its exact source attribute (`SelectListEntry.sourceAttribute`) and is
  referenced directly instead of through the star's unqualified synthesized name.
- `orderByContainsAggregates` resolves a positional reference against the select
  list before testing for aggregates, so `select count(*) as c from t order by 1`
  takes the post-aggregate ORDER BY path like the spelled-out
  `order by count(*)`.

Consequences that are now locked in: a select-list alias cannot shadow the
target, two same-named columns under a star cannot be confused, and a computed
column (window function, aggregate) is read from the output rather than
recomputed in a scope that could not evaluate it.

## Review findings

The implement-stage diff (`42d00d41`) was read first, then probed against a live
`Database.eval` build across ~60 query shapes, then re-checked against the
planner sources it touches.

### Correctness — no defects found in the change

Every risk the handoff flagged was probed and each behaved as the handoff
claimed. Specifically checked and correct:

- **The alignment guard's two fallback shapes.** A window query containing `*`
  (`select *, row_number() over (…) w from t order by 1|2`) falls back to the
  select list, resolves the star entry's source attribute, and sorts correctly;
  the out-of-range range still comes from the select list (`order by 5` →
  `1..4`), not from the window projection's single attribute.
- **The star-source reference used above a projection.** `buildSourceAttributeReference`
  builds a reference to an *input* attribute and the sort that consumes it sits
  above the projection. That resolves because `emitProject` keeps a source-row
  slot set per row and `emitSort` evaluates its key expressions inside the
  per-row pull loop, not after materializing. Verified by reading both emitters
  and by the passing star/window fallback cases.
- **The same fallback above an `AggregateNode`,** the one shape the handoff did
  not enumerate: when ORDER BY names an aggregate, the sort is applied *before*
  the grouped query's final projection exists, so a second ordinal key in the
  same clause takes the select-list fallback. `select jt2.*, count(*) n … group
  by 1,2 order by count(*) desc, 2` matches its qualified-name control. Now
  covered by a test.
- **Grouped `select *` with no final projection** (`select * from t group by
  1,2,3 order by 2`), DISTINCT, LIMIT, `nulls first`/`nulls last`, a column with
  a declared `collate nocase`, CTEs, derived tables, `insert … select … order by
  N`, a view body, and `values` — all match their name-spelled controls.
- **Attribute-id aliasing.** `ProjectNode` deliberately preserves a bare column
  reference's attribute id through an alias, so binding to output position N and
  binding to the underlying column produce the same id; a select list that
  projects one source column twice yields duplicate ids but identical values, so
  the last-wins row-descriptor entry is harmless.
- **`resolveOrdinalOutputColumn`'s range** is the relation's full output arity.
  For a `SetOperationNode` that surfaces membership flag columns those flags
  would be addressable — but flags are introduced by optimizer rewrites, long
  after this runs at build time, so it is unreachable. Parked as a `NOTE:`
  tripwire at the site rather than filed.

### Fixed in this pass

- **Test coverage** for everything the handoff listed as unexhausted, plus the
  aggregate-path fallback it had not identified, appended to
  `28.2-orderby-expression-extras.sqllogic`: three-way qualified stars (positions
  4 and 6 produce opposite orders, each paired with its qualified-name control),
  the ORDER-BY-names-an-aggregate + ordinal shape, grouped `select *` with
  ordinals in both clauses, ordinal + direction + second key + LIMIT, `nulls
  first`/`nulls last`, a collated column, CTE and derived-table forms, `order by
  0`, and the window-with-star out-of-range message. The block was confirmed to
  actually assert (a deliberately corrupted expectation fails the run).
- The `NOTE:` tripwire in `select-ordinal.ts` described above.

### Filed as separate tickets

- **`backlog/bug-order-by-ordinal-with-collate-ignored`** — `order by 2 collate
  nocase` is not recognized as a positional reference, becomes a constant, and
  the query comes back unsorted with no error; `group by 1 collate nocase` groups
  by a constant. Pre-existing (`extractOrdinalValue` never handled `collate`) and
  called out in the handoff as unfiled. Fixing it needs the requested collation
  plumbed onto the resulting sort key, and the SQLite-compatible spec confirmed,
  so it is its own ticket rather than an inline fix.
- **`backlog/bug-text-minmax-numeric-coercion`** — appended a second arm, not a
  new ticket, because the root cause is that ticket's site. `rule-groupby-fd-simplification`
  re-derives an FD-redundant GROUP BY column with a synthesized `min(col)`
  picker, and `min` applies numeric-string coercion, so `select k, s from t group
  by k, s` returns `7` / `1.5` for a `text` column holding `'007'` / `'1.50'`.
  Same query without the primary key in the GROUP BY keeps the text. This reaches
  queries containing no user-written aggregate at all, which raises that
  ticket's priority. Unrelated to this change (the name-spelled GROUP BY path is
  byte-identical before and after).
- **`fix/bug-window-function-over-grouped-query-crashes`** — appended a note, not
  a new ticket, for the same reason: `select *, row_number() over (…) w from t
  order by 4` still raises `No emitter registered for WindowFunctionCall`,
  because the star arm makes the alignment guard fail and the ordinal re-plans
  the window expression. Pre-existing and fixed automatically when that ticket's
  star arm lands.

### Source hygiene, docs, and the categories that came back empty

- `select-ordinal.ts` is 193 lines with four short exported functions, each with
  a doc comment that explains *why* the two binding modes exist. No size or
  decomposition concern. No `any`, no swallowed exceptions, no resource handling
  in this code path.
- `docs/sql-select.md` is the only doc that specifies positional references and
  both its GROUP BY and ORDER BY bullets were updated correctly by the
  implementer; `docs/architecture.md` and the other topic docs mention ordinals
  only in unrelated senses (`row_number()`, `mutation_ordinal()`), so nothing
  else needed touching. Verified by reading, not assumed.
- **Performance:** none found. The change removes a double evaluation (the sort
  reads the computed output column instead of recomputing the expression) and
  adds no per-row work. `buildSelectListEntries` re-reads `input.getAttributes()`
  once per star column, which is a cached call at build time.
- **Optimizer interaction:** the handoff flagged that no audit was done of rules
  reshaping the final `ProjectNode`. Not audited exhaustively here either — the
  rules that rebuild a `ProjectNode` (`rule-projection-pruning`,
  `rule-predicate-pushdown`, `rule-join-elimination`, `rule-scalar-cse`,
  `rule-fanout-lookup-join`) all thread `preserveInputColumns` and predefined
  attributes through, which preserves the ids a sort key binds to, and the full
  suite is green. Stated as evidence, not proof.

### Validation

`yarn lint` and `yarn test` (whole monorepo, 8662 quereus + 2900 other tests)
pass on a clean tree. Nothing skipped or disabled. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written — the two pre-existing
defects found above are wrong-answer bugs that no test asserts, not failing
tests.

## Still open elsewhere (unchanged)

- `*` dropped from any window query — `fix/bug-window-function-over-grouped-query-crashes`.
- `select count(*) as c from t order by c` → `Column not found: c` —
  `backlog/bug-ungrouped-aggregate-order-by-cannot-see-its-own-columns`.
- `select count(*) as b, b as q from g group by b` → `ambiguous column name: b`;
  fails at select-list build time with or without an ordinal.
