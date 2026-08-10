---
description: When a query checks that a value appears in another table's key column and a declared foreign key already guarantees it is there, the planner now skips reading that other table entirely — the shortcut used to give up on the ordinary way of writing the check. Implemented and reviewed.
files:
  - packages/quereus/src/planner/util/ind-utils.ts                          # resolveTableColumnMapping / mapColumnsToTable; isRowPreservingPathToTable gained a throughProject option
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts               # 11 plan tests
  - packages/quereus/test/optimizer/inclusion-dependencies.spec.ts          # 5 unit tests for the mapping helper
  - packages/quereus/test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic    # answer-level IN cases
  - packages/quereus/test/logic/08.1-semi-anti-join.sqllogic                # answer-level anti-join and composite-FK cases
  - docs/optimizer-rule-families.md
  - docs/optimizer-rules.md
difficulty: medium
---

# Foreign-key semi/anti-join folds now see through a projection

## What was wrong

`select * from emp where dept_id in (select id from dept)` decorrelates into
`SemiJoin(emp, Project[id](dept))` — the uncorrelated-`IN` arm of
`rule-subquery-decorrelation` uses the subquery tree verbatim as the join's
right side, so the right side is always a `ProjectNode`. The guard
`isRowPreservingPathToTable` accepted only `TableReference` / `Retrieve` /
`Alias` / `Sort`, so the foreign-key fold never fired for the plain `IN`
spelling even with `dept_id not null references dept(id)` declared. Answers were
correct; only the plan improvement was lost.

## What changed

### `planner/util/ind-utils.ts`

- **`isRowPreservingPathToTable(node, options?)`** takes an optional
  `{ throughProject: true }`. Default behavior is unchanged, so
  `rule-join-elimination` and `rule-fanout-lookup-join` are untouched. With the
  option, `ProjectNode` is peeled too — a projection never removes rows.
- **`resolveTableColumnMapping(node)`** resolves a subtree to the single base
  table it reads, plus `columnOf[i]` = the base-table column index behind output
  column `i` (or `undefined` when that output column has no base-table origin).
  Built by **attribute identity**, not by walking node kinds: a
  `TableReferenceNode` mints one attribute per table column in order, every
  pass-through wrapper republishes that id, and any computed expression carries a
  fresh id and so maps to `undefined`. This works through wrappers nobody
  enumerated (Filter, Distinct, Limit, …) and declines on computed columns for
  free.
- **`mapColumnsToTable(cols, mapping)`** translates a rule's equi columns,
  returning `undefined` if any column has no base-table origin.
- **`tableSchemaOf` deleted** — a one-line re-export of `extractTableSchema`
  whose only two callers now need the mapping, not just the schema.

### The two folders

`rule-semi-join-fk-trivial` and `rule-anti-join-fk-empty` resolve a
`TableColumnMapping` for **both** sides and translate their equi columns to
base-table indices before calling `lookupCoveringFK`; the right side is checked
for row-preservation with `throughProject: true`.

The left side's translation is not incidental. The equi-pairs a rule extracts
index each side's *output* attributes, whereas `lookupCoveringFK` speaks
base-table column indices. Before this change the parent-side `Project` gate was
the only thing preventing an output/table index coincidence from folding a join
that was never redundant — peeling projections without translating would have
turned a missed optimization into a wrong answer.

The nullable-FK branch of the semi fold builds `Filter(L, fk is not null)` over
L's **output** columns; that predicate deliberately uses the untranslated
indices (`childOutputCols`), not the base-table ones.

## Behavior, pinned by tests

Setup: `dept(id integer primary key, dname text)`;
`emp(id integer primary key, dept_id integer not null references dept(id))`;
`emp_opt` the same with `dept_id integer null`. Quereus columns default to
**NOT NULL**, so nullable needs an explicit `null`.

| Query | Expected plan |
|---|---|
| `select id from emp where dept_id in (select id from dept)` | no join, no read of `dept` |
| `select id from emp_opt where dept_id in (select id from dept)` | no join, `Filter … is not null`, no read of `dept` |
| `… in (select id from (select dname, id from dept))` | folds (reordering projection translated) |
| `… in (select id from dept where dname = 'eng')` | semi join kept (parent rows filtered) |
| `… in (select id + 0 from dept)` | semi join kept (computed, no table origin) |
| `… in (select dname from dept)` | semi join kept (index coincidence) |
| `select e.id from (select dept_id, id from emp) e where e.id in (select id from dept)` | semi join kept (child-side coincidence) |
| `not exists (select 1 from (select dname, id from dept) d where d.id = emp.dept_id)` | anti join folds to empty, no read of `dept` |
| `not exists (… where d.other = empx.dept_id)` over `deptx(id, other)` | anti join kept (index coincidence) |
| composite `(fa, fb) references p(a, b)`, `exists (… (select b, a, extra from p) q where q.a = c.fa and q.b = c.fb)` | folds (both columns translated) |
| same with the pairing permuted (`q.a = c.fb and q.b = c.fa`) | semi join kept |

All eleven are in `test/plan/subquery-decorrelation.spec.ts`, asserting both the
plan shape (`countSemiJoins` / anti-join count, and that no node reads
`main.dept`) and the answer. The answers are duplicated in
`test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic` (the `IN` cases) and
`test/logic/08.1-semi-anti-join.sqllogic` (the anti-join and composite-FK cases)
so a future plan change cannot quietly change results.

## Review findings

### Checked and clean

- **Soundness of the one loosening.** The only widened gate is `throughProject`
  on the parent side; both index translations strictly *tighten*. Peeling a
  `ProjectNode` is sound because it never drops rows and never carries `DISTINCT`
  (that is a separate node), and a semi/anti join is indifferent to right-side
  multiplicity.
- **The attribute-identity premise.** `resolveTableColumnMapping` assumes "same
  attribute id ⇒ same value", which is the plan invariant column-ref resolution
  and FD/EC propagation already rest on. Verified against `ProjectNode`'s
  `getAttributes`: a bare `ColumnReferenceNode` projection republishes the source
  id, everything else mints a fresh one.
- **Left side has no row-preserving guard, and needs none.** `L ⋉ R` drops rows
  from L; if every surviving L row still satisfies the inclusion, folding is
  sound regardless of what filtered/grouped/limited L. `findBaseTableReference`
  declines on any multi-relation subtree (joins, set operations), so the left
  schema can never come from the wrong table.
- **Error handling / resource cleanup / type safety.** Nothing to report: the
  rules are pure functions returning `PlanNode | null`, allocate no resources,
  and the diff introduces no `any` and no swallowed exceptions.
- **Source hygiene.** `ind-utils.ts` is 323 lines with one purpose per exported
  function; the new helpers are short and the doc comments state the *why*.
  No finding.
- **Docs.** `docs/optimizer-rule-families.md` and `docs/optimizer-rules.md` were
  read in full around the change. `docs/optimizer-fd.md` and
  `docs/optimizer-joins.md` also name these helpers; both remain accurate,
  because the default behavior is unchanged and `throughProject` is opt-in.

### Found and fixed in this pass

- **The handoff's claim that the anti-join half is unexercised is wrong.** A
  `NOT EXISTS` over a *derived* parent table reaches it:
  `not exists (select 1 from (select dname, id from dept) d where d.id = emp.dept_id)`
  folds under the new rule and did not under the old one (verified by swapping the
  pre-change sources back in and re-running). Added two anti-join plan tests (the
  fold and the index-coincidence decline) plus answer-level pins in
  `08.1-semi-anti-join.sqllogic`. The change is behavior, not unexercised
  generality, and is now covered.
- **Composite foreign keys were untested through a projection** — the riskiest
  path, since `lookupCoveringFK`'s positional pairing and the per-side index
  translation have to agree on both columns. Added a fold case and a
  permuted-pairing decline case, plan and answer.
- **Stale sentence in `docs/optimizer-rule-families.md`.** Its list of reasons
  the FK rules abstain still named `Project` unconditionally. Rewritten to say
  which rules it still applies to, and to add the new "computed equi column"
  reason.

### Recorded as a tripwire, not a ticket

- `isRowPreservingPathToTable`'s `RetrieveNode` branch does not pass `options`
  into the pushed-down pipeline, so a `Retrieve` whose pipeline is
  `Project(TableReference)` is rejected even under `throughProject`. That is
  conservative (a missed fold, never a wrong answer) and unreachable today — no
  bundled module accepts projection pushdown on a semi/anti-join parent side.
  Parked as a `NOTE:`-tagged comment at the branch in `ind-utils.ts`.

### Found, already tracked elsewhere — not re-filed

- Probing correlated `EXISTS` over a cross-type comparison
  (`dept.dname TEXT = emp.dept_id INTEGER`) crashes with `No row context found
  for column dname`: predicate pushdown copies the subquery's correlated conjunct
  onto the outer scan. Reproduces with the pre-change rule sources, with no
  foreign key present, and with a plain scalar subquery instead of `EXISTS` — it
  has nothing to do with this diff. Already owned by
  `tickets/fix/bug-correlated-predicate-hoisted-onto-outer`.
- The implement stage filed `tickets/fix/bug-fk-alignment-derived-table-indices`
  for the same output-index-vs-table-index confusion in `rule-join-elimination`'s
  outer-join path. Its repro was re-run and does lose a row. Also re-run with the
  pre-change sources: identical result, so this change neither causes nor worsens
  it. Correctly left separate.

### Not done, deliberately

- Folding through `DISTINCT` on the parent side. `select distinct id from dept`
  preserves which *values* are present, so the fold would be sound, but the
  existing rules' contract is row-preservation, not value-preservation.
  Speculative until a workload wants it; no ticket filed.

## Validation

- `yarn workspace @quereus/quereus run lint` (eslint + test-file typecheck) — clean.
- `yarn workspace @quereus/quereus run test` — 7787 passing, 13 pending.
- `yarn test` (all workspaces) — passing.
- `yarn build` — clean.
- Confirmed the new `.sqllogic` assertions actually execute (a deliberately wrong
  expected value fails the run, then reverted) — a silently-skipped block would
  otherwise look identical to a passing one.
