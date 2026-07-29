---
description: When a query checks that a value appears in another table's key column and a declared foreign key already guarantees it is there, the planner now skips reading that other table entirely — the shortcut used to give up on the ordinary way of writing the check.
files:
  - packages/quereus/src/planner/util/ind-utils.ts                          # new resolveTableColumnMapping / mapColumnsToTable; isRowPreservingPathToTable gained a throughProject option
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts               # 7 plan tests, replacing the old tolerant one
  - packages/quereus/test/optimizer/inclusion-dependencies.spec.ts          # 5 unit tests for the new mapping helper
  - packages/quereus/test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic    # answer-level cases
  - docs/optimizer-rule-families.md
  - docs/optimizer-rules.md
difficulty: medium
---

# Foreign-key semi-join fold now sees through the projection — implementation summary

## The shape that was declining

`select * from emp where dept_id in (select id from dept)` decorrelates into
`SemiJoin(emp, Project[id](dept))`. The uncorrelated-`IN` arm of
`rule-subquery-decorrelation` deliberately uses the subquery tree **verbatim**
as the join's right side, so the right side is always a `ProjectNode` — and
`isRowPreservingPathToTable` accepted only `TableReference` / `Retrieve` /
`Alias` / `Sort`. The FK fold therefore never fired for the plain `IN` spelling,
even with `dept_id not null references dept(id)` declared. Answers were correct;
only the plan improvement was lost.

(The ticket also claimed `tableSchemaOf` could not see through a `Project`. It
could — `extractTableSchema` descends any single-relation wrapper. The only
blocking gate was `isRowPreservingPathToTable`. `tableSchemaOf` is now gone;
see below.)

## What changed

### `planner/util/ind-utils.ts`

- **`isRowPreservingPathToTable(node, options?)`** takes an optional
  `{ throughProject: true }`. Default behavior is byte-identical to before, so
  `rule-join-elimination` and `rule-fanout-lookup-join` are untouched. With the
  option, `ProjectNode` is peeled too — a projection never removes rows, which
  is all this predicate is about.
- **`resolveTableColumnMapping(node)`** (new) resolves a subtree to the single
  base table it reads, plus `columnOf[i]` = the base-table column index behind
  output column `i` (or `undefined` when that output column has no base-table
  origin). The map is built by **attribute identity**, not by walking node
  kinds: a `TableReferenceNode` mints one attribute per table column in order,
  every pass-through wrapper republishes that id, and any computed expression
  carries a fresh id and so maps to `undefined`. This means it works through
  wrappers nobody enumerated (Filter, Distinct, Limit, …) and declines on
  computed columns for free.
- **`mapColumnsToTable(cols, mapping)`** (new) translates a rule's equi columns,
  returning `undefined` if any column has no base-table origin.
- **`tableSchemaOf` deleted** — it was a one-line re-export of
  `extractTableSchema` whose only two callers are the rules below, and both now
  need the mapping, not just the schema.

### The two folders

`rule-semi-join-fk-trivial` and `rule-anti-join-fk-empty` now resolve a
`TableColumnMapping` for **both** sides and translate their equi columns to
base-table indices before calling `lookupCoveringFK`; the right side is checked
for row-preservation with `throughProject: true`.

The left side's translation is not incidental. The equi-pairs a rule extracts
index each side's *output* attributes, whereas `lookupCoveringFK` speaks
base-table column indices. Before this change the parent-side `Project` gate was
the only thing preventing an output/table index coincidence from folding a join
that was never redundant — peeling projections without translating would have
turned a missed optimization into a wrong answer. Two concrete coincidences are
pinned as tests:

- `dept_id in (select dname from dept)` — `dname` is output column 0, the same
  index as the referenced column `dept.id`.
- `(select dept_id, id from emp) e where e.id in (select id from dept)` — the
  derived table puts `emp.id` at the index `emp.dept_id` occupies in the table.

Both must keep the semi join (and both return no rows).

The nullable-FK branch of the semi fold builds `Filter(L, fk is not null)` over
L's **output** columns; that predicate deliberately uses the untranslated
indices (now named `childOutputCols`), not the base-table ones.

## Use cases to exercise

Setup: `dept(id integer primary key, dname text)`;
`emp(id integer primary key, dept_id integer not null references dept(id))`;
`emp_opt` same but `dept_id integer null references dept(id)`. Note quereus
columns default to **NOT NULL** — nullable needs an explicit `null`.

| Query | Expected plan |
|---|---|
| `select id from emp where dept_id in (select id from dept)` | no join, no read of `dept` |
| `select id from emp_opt where dept_id in (select id from dept)` | no join, `Filter … is not null`, no read of `dept` |
| `… in (select id from (select dname, id from dept))` | folds (reordering projection translated) |
| `… in (select id from dept where dname = 'eng')` | semi join kept (parent rows filtered) |
| `… in (select id + 0 from dept)` | semi join kept (computed, no table origin) |
| `… in (select dname from dept)` | semi join kept (index coincidence) |
| `select e.id from (select dept_id, id from emp) e where e.id in (select id from dept)` | semi join kept (child-side coincidence) |

All seven are in `test/plan/subquery-decorrelation.spec.ts`, asserting both the
plan shape (`countSemiJoins`, and that no node reads `main.dept`) and the answer.
The answer half is duplicated in
`test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic` so a future plan change
cannot quietly change results.

## Validation run

- `yarn workspace @quereus/quereus run test` — 7783 passing, 13 pending.
- `yarn test` (all workspaces) — passing.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file typecheck) — clean.
- `yarn build` — clean.

## Known gaps / things worth a reviewer's attention

- **A separate, pre-existing wrong-answer bug was found and filed, not fixed:**
  `tickets/fix/bug-fk-alignment-derived-table-indices.md`. The same
  output-index-vs-table-index confusion exists in `rule-join-elimination`'s
  outer-join path (via `checkFkPkAlignment`, which has no row-preserving guard
  for LEFT/RIGHT), and it is reachable today — the ticket carries a runnable
  repro that loses a row. This change does not touch that rule and does not
  widen the default `isRowPreservingPathToTable`, so it neither causes nor
  worsens it; verify that claim if you want, then keep the two separate.
  `rule-fanout-lookup-join` has the same untranslated indices on its
  `atMostOne-left` path — **not** reproduced, flagged in the ticket as open.
- The anti-join folder got the same treatment on the assumption that uniformity
  is cheaper than divergence. As the original ticket suspected, no anti-join
  shape reachable today carries a `Project` right side (the `NOT EXISTS` descent
  arm strips it), so **that half of the change has no behavioral test** — it is
  covered only by the existing anti-join tests continuing to pass. If a reviewer
  prefers unexercised generality not to ship, reverting just
  `rule-anti-join-fk-empty` to `tableSchemaOf`-equivalent behavior is
  self-contained.
- `resolveTableColumnMapping` builds a fresh `attrId → column` map per candidate
  join (two per rule invocation). `getAttributes()` is `Cached` on both nodes, so
  the cost is one map build over a table's column count — small enough that no
  tripwire comment was added in the code; noted here so the observation is not
  lost if the folders ever run over very wide tables.
- Not attempted: folding through `DISTINCT` on the parent side. `select distinct
  id from dept` preserves which *values* are present, so the semi fold would be
  sound, but `isRowPreservingPathToTable` rejects it and the existing rules'
  contract is row-preservation, not value-preservation. Out of scope; no ticket
  filed (speculative until a workload wants it).
