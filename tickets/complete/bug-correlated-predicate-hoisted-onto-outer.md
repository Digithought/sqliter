---
description: A query combining an ORDER BY with an EXISTS subquery used to fail with a "no row context" error, or silently return the wrong rows, because the subquery's own condition was mistakenly applied to the outer table too. Fixed, reviewed, and covered by tests.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts               # the fix
  - packages/quereus/src/planner/building/coercion.ts                           # wrapInCast EXPLAIN rendering
  - packages/quereus/test/logic/07.7.6-correlated-predicate-scope.sqllogic       # row-set coverage
  - packages/quereus/test/plan/correlated-predicate-scope.spec.ts                # plan-shape + direct-API coverage
  - docs/invariants.md                                                          # OPT-025
  - docs/optimizer-retrieve.md                                                   # "Constraint sweep scope"
difficulty: medium
---

# A correlated subquery's predicate was copied onto the outer relation

## What was wrong

```sql
create table a (id integer primary key, i integer);
create table t (id integer primary key, s text);
insert into a values (1, 1), (2, 2), (3, 3);
insert into t values (1, '1'), (2, '2');

select a.id from a where exists (select 1 from t where t.s = a.i);            -- worked: {1,2}
select a.id from a where exists (select 1 from t where t.s = a.i) order by a.id;
-- Error: No row context found for column s.
```

The optimizer's constraint sweep (`extractConstraintsForTable`) attributed a predicate found
*anywhere* in a subtree to the table it was asked about. A subquery body hangs off a scalar
expression, so the outer `Filter`'s subtree contained the inner `t.s = a.i`. Asked for
constraints on `a`, the sweep returned that inner comparison as an equality constraint on
`a.i`. The memory module cannot handle it, so it came back as `moduleCtx.residualPredicate`
and `rule-select-access-path` materialized it as a `Filter` reading column `s` over the scan
of `a` — which has no such column.

Only the `ORDER BY` form failed because `trySortAbsorbViaIndexOrdering` (grow-retrieve) is the
one caller that sweeps a whole subtree rather than a single `Filter`'s own predicate.

## What changed

**`constraint-extractor.ts`** — `extractConstraintsForTable` sweeps via a new
`walkPredicatesConstraining`, which visits a predicate only when the target table reference
sits in that predicate's own relational *input*. A relational node reached through a scalar
child is a subquery body — a different scope — so what it contains cannot mark an enclosing
node's input. Recursion still descends into subquery bodies, so an inner scan of the same
table still collects its own (legitimately correlated) predicates.

Incidental in the same function: `createTableInfosFromPlan(...)` hoisted out of the
per-predicate callback (it used to rebuild the whole table-info list per predicate); and
`extractConstraintsAndResidualForTable` deleted along with its now-callerless helpers
`walkPlanForPredicates` and `combineResiduals` — no callers anywhere in the repo, and it
carried the identical unguarded sweep.

**`coercion.ts`** — `wrapInCast` synthesized its `AST.CastExpr` with a `literal null`
placeholder for `expr`. `formatExpression` renders a node from its AST rather than from its
children, so every coerced operand printed as `cast(null as integer)` in EXPLAIN while the
real operand child was intact. Now carries `operand.expression`. Cosmetic only.

**Docs** — invariant **OPT-025 — A predicate constrains only tables in its own relational
input** in `docs/invariants.md`, linked to a *Constraint sweep scope* section in
`docs/optimizer-retrieve.md`.

## Test coverage

`packages/quereus/test/logic/07.7.6-correlated-predicate-scope.sqllogic` — row sets, each
shape with no `order by`, with `order by`, and mostly with `order by … desc`:

- `exists (select 1 from t where t.s = a.i)` (the repro), operands reversed, and the
  correlated column in the select list.
- `not exists (…)` over the same shape — where hoisting gives a **wrong answer** rather than
  an error, so only the row set catches it.
- `a.i in (select t.id from t where t.s = a.i)`.
- `exists (select 1 from t where t.id = a.i)` — same-type, keeping the decorrelating
  semi-join path covered.
- An outer conjunct alongside the subquery (`a.id > 1 and exists (…)`).
- **An outer column compared to a constant inside the subquery** (`not exists (select 1 from
  t where a.i = 2)`) — added during review; see findings.
- A subquery over the same table as the outer relation.
- DELETE and UPDATE driven by a correlated `EXISTS` / `NOT EXISTS`.

`packages/quereus/test/plan/correlated-predicate-scope.spec.ts` — plan shape plus direct
calls into the changed function:

- no `filter(cast(t.s as integer) = a.i)` at top level, and exactly one top-level `filter(`;
- the `Sort` is still absorbed (the precondition being guarded — if this stops holding the
  shape assertions would pass for the wrong reason);
- the inner comparison still exists inside the EXISTS sub-program, which doubles as the guard
  for the `wrapInCast` fix;
- `extractConstraintsForTable` called directly: nothing attributed to the outer table from a
  subquery predicate, the genuine outer conjunct still attributed, and a subquery scan's own
  predicates still collected.

## Review findings

### Verified — the fix is sound, and both guards bite

Re-derived the failure from the diff before reading the handoff, then re-ran the
implementer's neutralization independently: with the gate replaced by the original unguarded
sweep, `07.7.6` reproduces `No row context found for column s` and the plan spec shows
`filter(cast(t.s as integer) = a.i)` over `IndexScan(a)`. The handoff's claim held.

Checked that the gate cannot *lose* legitimate constraints. Every caller
(`rule-select-access-path`, `trySortAbsorbViaIndexOrdering`, `change-scope` ×2,
`binding-extractor`) derives its relation key from `createTableInfoFromNode(<a
TableReferenceNode>)`, which is exactly what the `#<nodeId>` suffix match keys on, and each
passes a plan whose `getChildren()` chain reaches that reference. Confirmed empirically with
a direct-API test: a subquery scan's own `t.id > 0 and t.s = 'x'` is still collected in full.

### Found and fixed in this pass

- **Missing coverage for the one shape the `correlated` flag cannot catch** — an *outer*
  column compared to a *constant* inside the subquery body
  (`not exists (select 1 from t where a.i = 2)`). Its value side is a literal, so
  `computeCoveredKeysForConstraints`'s `correlated` guard passes it through and it looks like
  an ordinary covering equality on `a`. Verified this is a genuine pre-fix wrong-answer:
  under the old sweep the query returns `[]`; correct is `{1,3}`. None of the shapes in
  `07.7.6` covered it. Added to the sqllogic file (EXISTS, NOT EXISTS, both `order by`
  directions, and mixed with a genuinely correlated conjunct) and to the plan spec.
- **Two inaccurate claims about the covered-keys half of the fix.** The handoff and
  `docs/optimizer-retrieve.md` both stated that the gate stops a subquery's `a.id = 5` from
  being counted as covering the *outer* `a`'s primary key, and the sqllogic file carried a
  `exists (select 1 from a a2 where a2.id = 2)` case presented as the guard for it. That
  cannot happen: the inner scan is a distinct `TableReferenceNode` whose attributes get fresh
  ids from `PlanNode.nextAttrId()`, so `a2.id` never matched the outer instance's attribute
  set and those cases pass pre-fix. The real shape is the outer-column-vs-constant one above.
  Corrected the doc paragraph and the two test comments; kept the self-reference cases as
  cheap coverage, now labelled as such rather than as a regression guard.
- **No direct coverage of the changed function.** Every guard the implementer wrote depends
  on the sort-absorb path being taken — an optimizer change that stopped routing this query
  through `trySortAbsorbViaIndexOrdering` would silently defang all of them (the spec's
  "still absorbs the Sort" test would flag it, but only as a failure with no stated cause).
  `test/planner/constraint-extractor.spec.ts` has ~2900 lines and never touches
  `extractConstraintsForTable`. Added an `extractConstraintsForTable` block that builds an
  analyzed plan and calls the function directly — three assertions, two of which were
  confirmed to fail under the old sweep.
- **Store mode run** — the handoff's top known gap. Ran `07.7.6` against the LevelDB backend
  (`node test-runner.mjs --store --grep "07.7.6"`): passes, including the new cases. The
  un-`order by` queries' assumed ascending primary-key row order holds there too.
- **Source hygiene** in the diff: removed a dead `if (!plan) return false` guard on a
  non-nullable parameter and a pointless `child as unknown as PlanNode` double cast
  (`getChildren()` already returns `readonly PlanNode[]`); hoisted the loop-invariant
  `isRelationalNode(plan)` out of the child loop and moved the scope comment above it.
- **DRY in the new spec**: one test hand-rolled prepare/`getDebugProgram`/finalize that the
  existing `programOf` helper already does; switched to the helper. Gave `constraintsFor` an
  explicit return type.

### Found and parked as a tripwire (not a ticket)

- **`walkPredicatesConstraining` follows `getChildren()` only.** The handoff asserted that
  every `getRelations()` override returns fields already in `getChildren()`. That is false:
  `InsertNode.getRelations()` returns `[source, table]` while `getChildren()` returns
  `[source]`, and `AddConstraintNode` / `AlterTableNode` are `VoidNode`s with no children but
  a `table` relation. So a target key naming one of those DML/DDL target references is
  unreachable by the sweep. Harmless today — those references carry their own attribute ids
  that no predicate in the plan mentions, so the old unguarded sweep found nothing for them
  either, and `binding-extractor` falls back to `{kind: 'global'}` on an empty covered-key
  set. Genuinely conditional, so recorded as a `NOTE:` at the function rather than filed.
- The recursion-depth `NOTE:` the implementer parked at the same function is retained.

### Checked and clean — no findings

- **Behaviour of the hoist.** `createTableInfosFromPlan(plan)` was already computed from the
  same root on every iteration, and `extractConstraints` does not mutate the `TableInfo`
  array, so hoisting it is a pure win.
- **Deleted exports.** No references to `extractConstraintsAndResidualForTable`,
  `walkPlanForPredicates`, or `combineResiduals` anywhere in `src/`, `test/`, or `docs/`
  (only stale `dist/` build output, which is regenerated).
- **`wrapInCast` carrying a real operand AST.** Nothing in the repo compares
  `CastNode.expression` structurally or rebuilds a plan node from a `CastExpr`'s `expr`
  field; `CastNode` itself reads only `targetType`, and its `toString` already went through
  the operand child. Full suite green.
- **Docs freshness.** Read every doc mentioning `constraint-extractor` (`invariants.md`,
  `optimizer-fd.md`, `optimizer-rule-families.md`, `sqlite-test-crosscheck.md`,
  `zero-bug-plan.md`); none described the swept behaviour or the deleted exports, so only
  the two files the change already touched needed edits.
- **Error handling / resource cleanup.** Every `Database` in the new spec is closed in
  `afterEach`; every prepared statement goes through `programOf`, which finalizes in a
  `finally`. No new `catch` swallows anything.
- **File size.** `constraint-extractor.ts` is ~1700 lines, which is large, but the change is
  net-negative on it and the review's additions are comments. Not worth splitting inside this
  ticket.

### Noticed, deliberately not actioned

- `createResidualFilter` (`constraint-extractor.ts`) is exported, has a `TODO: Implement`
  body that returns `undefined`, is covered by unit tests, and has no callers in `src/`.
  Pre-existing and outside this diff — flagged here only so it is not rediscovered as new.
- `extractCoveredKeysForTable` calls `createTableInfosFromPlan(plan)` and then
  `extractConstraintsForTable`, which builds the same list again; `analyzeRowSpecific` does
  this once per table reference. Pre-existing redundancy, unchanged by this ticket, and the
  implementer's hoist already removed the worse per-predicate version.

## Validation

- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — **7992 passing, 0 failing, 13 pending** in `packages/quereus`; all other
  workspaces green; 0 failing overall.
- `node test-runner.mjs --store --grep "07.7.6"` — passes (LevelDB backend).
- `node scripts/check-docs.mjs` — OK.
