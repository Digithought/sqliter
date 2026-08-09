---
description: The built-in listing of integrity rules always shows an empty list of the tables each rule depends on, even when the rule clearly depends on one. Derive that list the same way the enforcement path already does, so the two cannot disagree.
files:
  - packages/quereus/src/runtime/emit/create-assertion.ts            # emitCreateAssertion — the broken discovery walk (lines 45-85)
  - packages/quereus/src/planner/analysis/binding-extractor.ts       # collectTableRefs (line 131) — the correct walk, currently private
  - packages/quereus/src/core/database-assertions.ts                 # compileUnderSuppression (line 320) — the plan-for-analysis recipe to match
  - packages/quereus/src/schema/assertion.ts                         # AssertionDependentTable / IntegrityAssertionSchema.dependentTables
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts    # remapDependentTables — starts seeing real entries once this lands
  - packages/quereus/test/assertion-rename-propagation.spec.ts       # line 89-112 test, currently vacuous, comment names this bug
  - packages/quereus/test/logic/06.3.3-introspection-tags.sqllogic   # line 180 — only checks the column is valid JSON
repro: verified
difficulty: medium
---

# Derive `dependentTables` from the plan the same way the evaluator does

## What is wrong

`create assertion` records which base tables the rule's body reads, and shows
them in the `dependent_tables` column of `assertion_info()`. For the normal way
of writing an assertion the recorded list is empty:

```
create table t ( x integer primary key );
create assertion a1 check (not exists (select 1 from t where x < 0));
-- dependent_tables is []   (expected: main.t)
```

Enforcement is unaffected — the commit-time evaluator never reads this field, it
derives its own (correct) base-table set when it compiles the body. The damage is
limited to the introspection column and to anything that later trusts it.

## Root cause — measured

`emitCreateAssertion` plans the violation query and then walks the plan tree for
table references, descending only through each node's `getRelations()`. In
`select 1 where not (not exists (select 1 from t …))` the table reference lives
under a *scalar subquery expression* hanging off the `where`, which
`getRelations()` does not enumerate — so the walk never reaches it. Practically
every assertion is written as `not exists (select … from <table>)` or
`(select count(*) from <table> …) = 0`, so practically every assertion records
nothing.

`binding-extractor.ts`'s `collectTableRefs` walks `getChildren()` instead and
finds them. That is the walk the evaluator's `extractBindings` uses, and it is
right.

Measured on the four shapes below (scratch script, run in-process at HEAD, since
deleted). `built` = `_buildPlan` output; `analysis` = plus
`optimizer.optimizeForAnalysis`; `optimize` = `db.getPlan`, i.e. what the create
path calls today:

| assertion body                                    | today (stored) | getChildren on built | getChildren on analysis | getChildren on optimize |
|---------------------------------------------------|----------------|----------------------|-------------------------|-------------------------|
| `not exists (select 1 from t where x < 0)`         | `[]`           | `main.t`             | `main.t`                | `main.t`, `main.t`      |
| `(select count(*) from t where x < 0) = 0`         | `[]`           | `main.t`             | `main.t`                | `main.t`, `main.t`      |
| `not exists (select 1 from t join u … )`           | `[]`           | `main.t`, `main.u`   | `main.t`, `main.u`      | each twice              |
| `not exists (select 1 from v)`  (`v` a view over `t`) | `[]`        | `main.t`             | `main.t`                | `main.t`, `main.t`      |
| `1 = 1`                                            | `[]`           | `[]`                 | `[]`                    | `[]`                    |

Two things fall out of that table:

- Swapping `getRelations()` for `getChildren()` alone is **not** the fix. The
  create path plans with `db.getPlan()`, which runs the full physical
  optimization; that leaves two distinct `TableReferenceNode` instances per table
  in each of these plans, so a naive walk would list every table twice with two
  different `relationKey`s. Plan for *analysis* instead, which is what the
  evaluator does and is strictly a prefix of the same pass pipeline (structural
  passes only — `Optimizer.optimizeForAnalysis`, `optimizer.ts:1426`).
- Views expand during plan building, not during optimization, so an assertion
  over a view already reports the underlying base table either way. No extra work
  needed for that case.

## The shape to build

Do not fix the walk in place — delete it and share one definition, so the create
path and the evaluator cannot drift apart again.

- Export `binding-extractor.ts`'s table-reference collection (today the private
  `collectTableRefs`) as a named function returning the relationKey → base map,
  and keep `extractBindings` on it. One walk, one `relationKey` format
  (`<schema>.<table>#<nodeId>`), one place to change if the plan shape ever moves
  again.
- Have `emitCreateAssertion` build its plan the way
  `AssertionEvaluator.compileUnderSuppression` does — parse `violationSql`,
  `_buildPlan` under `_homeSchemaPath(schemaName)`, `optimizeForAnalysis`, all
  inside `withSuppressedAssertionHoist` — and feed the shared collector.
  Consider lifting that "plan an assertion body for analysis" recipe into one
  helper both callers use; the evaluator needs the analyzed plan itself, so the
  helper should return the plan, not just the table list. Use judgement on
  whether the extra indirection pays for itself — the collector being shared is
  the part that matters.
- Keep the failure non-fatal. A discovery failure must still only warn and leave
  the list empty, exactly as now: the builder already proved this body plans, and
  making create-assertion fail here would be a new failure mode. (The separate
  question of a body naming a missing table is
  `fix/bug-assertion-body-can-name-missing-table`'s, not this ticket's.)

### What `relationKey` is and is not

`AssertionDependentTable.relationKey` embeds a plan-node id from whichever plan
built it. Node ids come from a process-wide counter, so a recorded `relationKey`
will **never** equal the key the evaluator computes for the same table at commit
time — it only tells two references to the same table apart *within one recorded
list*. That is true today and stays true after this change. Say so in the
`AssertionDependentTable` doc comment while you are there, so nobody builds a
lookup on it.

## Tests

The existing catalog test at `assertion-rename-propagation.spec.ts:89` ("TABLE
rename re-keys the informational dependentTables entries") is vacuous today —
`before` and `after` are both empty, and a comment says so, naming this bug. It
becomes a real test once the list is populated; strengthen it and drop the
comment.

`test/logic/06.3.3-introspection-tags.sqllogic:180` only checks that
`dependent_tables` parses as JSON, which an empty list satisfies.

## TODO

- Export the table-reference collector from
  `packages/quereus/src/planner/analysis/binding-extractor.ts` and keep
  `extractBindings` using it. Name it for what it does over a plan, not for
  bindings.
- Rewrite the discovery block in `emitCreateAssertion`
  (`runtime/emit/create-assertion.ts:45-85`) to plan for analysis under hoist
  suppression and use the shared collector. Keep the `try`/`warnLog` shape and
  the "never fatal" comment; update the comment text that describes the walk.
- Decide whether to share the plan-for-analysis recipe with
  `AssertionEvaluator.compileUnderSuppression`
  (`core/database-assertions.ts:320`) or leave the two call sites building it
  separately from the same primitives. Record the call in a comment either way.
- Document in `schema/assertion.ts` that `relationKey` is meaningful only within
  one recorded list and is not comparable to a runtime relation key.
- Strengthen `test/assertion-rename-propagation.spec.ts:89` to assert the entry
  actually names `main.t` before the rename and `main.t2` after, and remove the
  comment pointing at this bug.
- Add coverage that a plain `not exists (select … from t)` assertion records
  exactly one entry for `main.t` (one entry, not two — that is the regression
  guard against re-introducing the physical plan), and that a two-table body
  records both. A catalog-level spec is the natural home; if it goes in
  `06.3.3-introspection-tags.sqllogic` instead, assert on the parsed contents,
  not just `json_valid`.
- Check `docs/functions.md` (line ~497) and any assertion doc that describes
  `dependent_tables` still reads true.
- Run `yarn test` and `yarn lint` from the repo root.
