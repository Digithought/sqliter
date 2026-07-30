---
description: A query with an ORDER BY and an EXISTS subquery used to fail with a "no row context" error, or silently return wrong rows; the subquery's own condition was being applied to the outer table as well. Fixed, with tests and docs.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts               # the fix
  - packages/quereus/src/planner/building/coercion.ts                           # wrapInCast EXPLAIN rendering
  - packages/quereus/test/logic/07.7.6-correlated-predicate-scope.sqllogic       # new row-set coverage
  - packages/quereus/test/plan/correlated-predicate-scope.spec.ts                # new plan-shape coverage
  - docs/invariants.md                                                          # new OPT-025
  - docs/optimizer-retrieve.md                                                   # new "Constraint sweep scope" section
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
one caller that sweeps a whole subtree rather than a single `Filter`'s own predicate. Only the
cross-type comparison reached it, because with matching types (`t.id = a.i`) the decorrelation
rule rewrites the EXISTS into a semi join and no correlated conjunct is left inside a subquery.

## What changed

**`constraint-extractor.ts`** — `extractConstraintsForTable` now sweeps via a new
`walkPredicatesConstraining`, which visits a predicate only when the target table reference
sits in that predicate's own relational *input*. A relational node reached through a scalar
child is a subquery body — a different scope — so what it contains cannot mark an enclosing
node's input. Recursion still descends into subquery bodies, so an inner scan of the same
table still collects its own (legitimately correlated) predicates.

Two incidental changes in the same function:
- `createTableInfosFromPlan(...)` is hoisted out of the per-predicate callback (it used to
  rebuild the whole table-info list for every predicate visited).
- `extractConstraintsAndResidualForTable` was **deleted** — it had no callers anywhere in the
  repo and carried the identical unguarded sweep. With it gone, `walkPlanForPredicates` and
  `combineResiduals` had no callers either and were deleted too.

**`coercion.ts`** — `wrapInCast` synthesized its `AST.CastExpr` with a `literal null`
placeholder for the `expr` field. `formatExpression` renders a node from its AST rather than
from its children, so every coerced operand printed as `cast(null as integer)` in EXPLAIN
while the real operand child was intact. Now carries `operand.expression`, so the same node
renders `cast(t.s as integer) = a.i`. Cosmetic only — no behavioural change.

**Docs** — new invariant **OPT-025 — A predicate constrains only tables in its own relational
input** in `docs/invariants.md` (between OPT-024 and OPT-030), linked to a new
*Constraint sweep scope* section in `docs/optimizer-retrieve.md`. `node scripts/check-docs.mjs`
passes.

## Use cases for testing / validation

New row-set coverage: `packages/quereus/test/logic/07.7.6-correlated-predicate-scope.sqllogic`.
Every shape appears with no `order by`, with `order by`, and (mostly) with `order by … desc`,
asserting equal row sets:

- `exists (select 1 from t where t.s = a.i)` — the repro; also with operands reversed, and
  with the correlated column in the select list (different Project shape).
- `not exists (…)` over the same shape — the case where hoisting gives a **wrong answer**
  rather than an error, so only the row set catches it.
- `a.i in (select t.id from t where t.s = a.i)`.
- `exists (select 1 from t where t.id = a.i)` — same-type, so the decorrelating semi-join path
  stays covered.
- An outer conjunct alongside the subquery (`a.id > 1 and exists (…)`), pinning that a genuine
  outer constraint is still applied while the inner one is still ignored.
- A subquery over the **same** table as the outer relation (`exists (select 1 from a a2 where
  a2.id = 2)`), pinning that an inner equality on the primary key is not counted as covering
  the outer instance's key.
- DELETE and UPDATE driven by a correlated `EXISTS` / `NOT EXISTS` — the mutation planner walks
  the same Retrieve/access-path rules.

New plan-shape coverage: `packages/quereus/test/plan/correlated-predicate-scope.spec.ts`.
Row sets alone would pass again if a later rewrite merely relocated the duplicate, so this
suite pins:
- the top-level program carries no `filter(cast(t.s as integer) = a.i)` and exactly one
  `filter(` instruction (the EXISTS/NOT EXISTS predicate itself);
- the `Sort` is still absorbed (no `sort(` at top level) — the precondition being guarded; if
  this stops holding, the assertions above would pass for the wrong reason;
- the inner comparison still exists inside the EXISTS sub-program, rendered as
  `filter(cast(t.s as integer) = a.i)` — which doubles as the guard for the `wrapInCast` fix.

**Both new test files were confirmed to fail without the fix.** The gate was temporarily
neutralized (`inScope = true`, restoring the old sweep semantics) and re-run: the sqllogic file
reproduced `No row context found for column s`, and the plan spec showed the hoisted
`filter(cast(t.s as integer) = a.i)` over `IndexScan(a)`.

### Validation run

- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — **7988 passing, 0 failing, 13 pending** in `packages/quereus`; 2611 passing
  across the other workspaces; 0 failing overall.
- `node scripts/check-docs.mjs` — OK.

## Known gaps — treat as starting points, not a finish line

- **Store mode not run.** `yarn test:store` (LevelDB backend) re-runs the logic corpus,
  including the new `07.7.6` file, and was not run here — it is the slow path and nothing in
  the change is module-specific, but the new sqllogic has not actually executed against it.
  The expected row orders assume an ascending primary-key walk for the un-`order by` queries,
  which is the same assumption the neighbouring `07.7.5` file already makes.
- **The covered-key half of the fix is only indirectly tested.** `extractCoveredKeysForTable`
  (→ `binding-extractor`, delta/change-scope classification) inherits the gate, closing a
  second latent unsoundness: a subquery's inner `a.id = 5` could previously be counted as
  covering the *outer* `a`'s primary key, claiming ≤1 row for a relation with many. The two
  new tests that touch it (`exists (select 1 from a a2 where a2.id = 2)` and its `not exists`
  sibling) only check row sets through the normal SELECT path; they do **not** drive the delta
  executor / assertion-residual machinery where a false ≤1-row claim actually does damage. A
  reviewer wanting to close this properly should look at the incremental-maintenance and
  `CREATE ASSERTION` suites for a shape that exercises the classification directly.
- **Scope test is structural, not semantic.** `walkPredicatesConstraining` decides scope by
  "relational child of a relational node". That is correct for how subqueries attach today,
  but it is a shape rule, not a proof. A future node type that exposes a relational input
  outside `getChildren()` would be missed by the sweep (the base `getRelations()` filters
  `getChildren()`, and every override returns fields that are in `getChildren()`, so this is
  fine today — and the deleted `walkPlanForPredicates` had the same property).
- **`wrapInCast` now carries the operand's AST.** Verified green across the suite and it makes
  EXPLAIN truthful, but it means the synthetic cast node's AST is no longer a throwaway — any
  consumer that compares `CastNode.expression` structurally now sees a real subtree where it
  used to see `literal null`. Nothing in the repo appeared to do that; worth a skim.
- **Tripwire parked in code:** `NOTE:` at `walkPredicatesConstraining`
  (`constraint-extractor.ts`) — the sweep recurses over the native stack, as the sweep it
  replaced did. Fine at today's plan depths; if a generated query ever overflows, convert to
  the explicit-stack shape `PlanNode.computePostOrder` uses.
