description: A subquery written inside a conflict-handling clause, or inside the clause that supplies extra values to a write, used to crash the query; it now runs correctly.
files:
  - packages/quereus/src/planner/nodes/dml-executor-node.ts        # getChildren/withChildren — main fix
  - packages/quereus/src/planner/nodes/constraint-check-node.ts    # second fix site (mutation-context values)
  - packages/quereus/src/runtime/emit/constraint-check.ts          # added a NOTE at the pre-existing skip-if-no-value branch
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts     # new structural guard spec
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic  # pinned failures converted to real assertions
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic   # Test 17b converted to a real assertion
  - packages/quereus/test/logic/46-mutation-context.sqllogic       # new Tests 15/16-equivalent: subquery context values + CHECK
  - packages/quereus/test/logic/47-upsert.sqllogic                 # new: subquery upsert expressions + multi-clause ON CONFLICT
  - docs/invariants.md                                             # new OPT-009
  - docs/optimizer.md                                              # Plan Node Hierarchy → Key Methods, cross-linked to OPT-009
difficulty: easy
repro: verified
---

# Expose DML side expressions to the optimizer — implemented

## What was fixed

`PlanNode.getChildren()` is the only channel the optimizer rewrites subtrees through.
Two plan nodes held user-written expressions **outside** that channel, so a *simple*
expression there worked (nothing to rewrite) but a **subquery** in the same position
always crashed at runtime with an internal-looking error (`No emitter registered for
Aggregate`, or an un-physicalized `RetrieveNode`):

- `DmlExecutorNode` — every `on conflict … do update` assignment value, its optional
  per-clause `where` condition, and `with context <var> = <expr>` values.
- `ConstraintCheckNode` — the same `with context` values (it already exposed its
  constraint expressions and NOT NULL default evaluators).

Fix: both nodes now include those expressions in `getChildren()`, in a canonical order
(`DmlExecutorNode`: source, then per-clause assignments-then-where in clause order, then
context values in declaration order; `ConstraintCheckNode`: source, constraints, NOT NULL
defaults, then context values), and `withChildren()` slices the rewritten children back
into the same slots — including the constructor arguments (`upsertClauses` /
`mutationContextValues` maps) that must be rebuilt from the new expressions, not passed
through from `this`. `InsertNode` / `UpdateNode` / `DeleteNode` were investigated and are
**not** third sites — they carry a `mutationContextValues` reference but no emitter reads
it from them (only `DmlExecutorNode` and `ConstraintCheckNode` do, and all three logical
nodes share the same `Map` instance the builders hand to the executor node), so touching
them would be redundant (the optimizer memoises by node id).

Also added a `NOTE:` comment at `runtime/emit/constraint-check.ts`'s context-row builder
(the `if (valueExpr)` skip a prior investigation flagged as a latent misalignment risk —
confirmed still unreachable today, since `emitDmlExecutor` throws first on a missing
value, but worth flagging in place rather than filing a ticket for a non-issue).

## Verified behavior (see test coverage below for the exact assertions)

- **Correlated subqueries just work** — no new machinery needed. The runtime already
  wraps every upsert evaluator in the existing-row and proposed-row contexts, so
  `… do update set w = (select v from p where p.id = excluded.id)` and `… where p.id =
  q.id` (the conflicting existing row) both resolve correctly.
- **Multi-clause `on conflict (a) … on conflict (b) …`** is genuine Quereus grammar
  (parser.ts loops `while (match(ON))`), and the child ordering/slicing between clauses
  is exercised by a dedicated test (see 47-upsert.sqllogic below) — this is the shape
  that most directly exercises the fix, since a bug in the per-clause slice math would
  cross-wire one clause's rewritten expression into another clause's slot.
- **`new.<col>` inside `with context` stays rejected** — context values are
  documented as evaluated once per statement, not per row. It fails at name resolution
  before the optimizer runs, so it's unrelated to this fix (confirmed still the case).

## Test coverage added / changed

- **Structural guard** (new): `test/optimizer/dml-child-exposure.spec.ts`. Builds a plan
  with a 2-clause `on conflict` (each clause has a subquery assignment AND a subquery
  `where`) plus a subquery `with context` value, on a table that also has a CHECK
  constraint and a NOT NULL DEFAULT column (to exercise the exact bound-slice bug the
  `ConstraintCheckNode` fix corrects — an unbounded `notNullDefaults` slice would swallow
  the context-value tail). Asserts: `getChildren()` count and identity-inclusion of every
  held expression for both node types, and `withChildren(getChildren())` round-trips to
  the *same instance* (the short-circuit path). **I reverted the fix locally (`git stash`
  on just the two node files) and re-ran this spec to confirm it fails without the fix**
  (`expected 1 to equal 6` on the `DmlExecutorNode` count assertion) — it's a real guard,
  not a vacuous one.
- `13.8-insert-with-clause-visibility.sqllogic`: the final pinned-as-error section (five
  statements) is now real `→ [...]` result assertions; comment rewritten out of
  present-tense-bug phrasing.
- `06.4-schema-search-path.sqllogic`: Test 17b (ON CONFLICT + WITH SCHEMA reaching a
  subquery) converted from pinned error to a real `returning name` assertion.
- `47-upsert.sqllogic`: new section — subquery in a `do update set` value, subquery in
  the clause `where` (both branches: condition true and false), subquery correlated to
  `excluded.<col>`, subquery correlated to the unqualified (existing-row) column, and a
  2-target multi-clause `on conflict` where each conflict routes to its own clause.
- `46-mutation-context.sqllogic`: three new tables (`ctx_insert`/`ctx_update`/
  `ctx_delete`), each pairing a subquery `with context` value with a CHECK constraint
  that reads it — one passing case and one failing case per statement kind (INSERT,
  UPDATE, DELETE), proving the rewritten value reaches `ConstraintCheckNode` for all
  three operations, not just the DML executor.

Full `packages/quereus` suite: **8653 passing, 13 pending** (pre-existing skips,
unrelated), 0 failing. `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) and
`yarn typecheck:test` both clean.

## Known gaps / things I did not chase

- **Test 17b's assertion is coarse-grained**: it only proves the ON CONFLICT subquery
  executes and returns a plausible value (`"3"`) via one `RETURNING` row on a real
  multi-schema table; it doesn't independently re-derive the count the way
  `13.8`/`47-upsert` do against a smaller fixture. If the WITH SCHEMA + ON CONFLICT
  interaction has its own edge cases beyond "the subquery now runs", they aren't covered
  here specifically — though `47-upsert.sqllogic` covers the ON CONFLICT subquery shapes
  thoroughly without WITH SCHEMA in the mix.
- **`new.<col>` inside `with context`** was reconfirmed still rejected (out of scope,
  documented behavior) but I did not add a regression test pinning that rejection — it
  wasn't touched by this change and was already implicitly covered by existing negative
  test discipline elsewhere in the suite (not verified explicitly by me this round).
- The `NOTE:` comment I added is exactly that — a note, not a fix or a test. It documents
  a currently-unreachable latent risk; if `emitDmlExecutor`'s upstream guard is ever
  loosened, this is the place that would misalign.
- I did not run `yarn test:store` (LevelDB-backed logic tests) — the ticket's build/test
  instructions call for the default `yarn test` during implement, and store-mode is
  flagged as "only for store-specific diagnosis or release prep". This fix touches only
  planner/runtime plan-node logic, not vtab/store code, so I judged it low-risk, but a
  reviewer wanting store-path confidence should run it.

## Pre-existing, unrelated failure noted (already tracked)

`scripts/check-docs.mjs` (word-count ratchet) flags `docs/schema.md` and `docs/sync.md` as
over their ratchets — unrelated to this ticket (I only touched `docs/invariants.md` and
`docs/optimizer.md`, both of which pass the checker's Check B for the new invariant
entry). Already tracked in `tickets/.pre-existing-known.md` under
`debt-docs-size-ratchet-red-again` (in-flight) — no action taken here, per the pre-existing-failure
protocol.
