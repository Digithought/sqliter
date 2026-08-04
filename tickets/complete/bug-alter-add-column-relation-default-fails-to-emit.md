----
description: Adding a column to an existing table used to fail outright when the new column's default value (or its generated expression, or its CHECK) was written as a query over another table — that is now fixed, with test coverage and docs.
files:
  - packages/quereus/src/planner/nodes/alter-table-node.ts   # the fix — getChildren/withChildren expose backfill + CHECK expressions
  - packages/quereus/src/runtime/emit/alter-table.ts         # cross-reference comment on the param-slot order
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts  # OPT-009 structural guard
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic
  - docs/invariants.md   # OPT-009
  - docs/sql-alter.md    # § ADD COLUMN
repro: verified
----

# ALTER TABLE ADD COLUMN with a relation-reading value source

## What was wrong, and the fix

`AlterTableNode` extended `VoidNode`, whose `getChildren()` returns `[]`. Its ADD COLUMN
action holds two kinds of `ScalarPlanNode` — the per-row backfill expression (a non-foldable
DEFAULT, or a `GENERATED ALWAYS AS` expression) and any inline CHECK predicates on the new
column — reachable only through the `action` union. The optimizer rewrites subtrees solely
via `getChildren()` (`planner/framework/pass.ts`), so a subquery inside either reached the
runtime still logical and died with an internal-looking error (`No emitter registered for
Aggregate`, or `RetrieveNode … was not rewritten to a physical access node`). A simple
expression survived, which is why it went unnoticed.

This was the third instance of invariant OPT-009 ("every held expression is a child"), after
`DmlExecutorNode` and `ConstraintCheckNode`. The fix follows that template: a private
`addColumnExpressions()` returning `[backfill.node?, ...checks.predicates[].node]`;
`getChildren()` returns it; `withChildren()` validates the count, narrows via `asScalarNodes`,
short-circuits an unchanged round-trip, and otherwise rebuilds `action` (spread, not mutated)
with the rewritten nodes sliced back into the same slots. The child order is the emitter's
`params` slot order and is cross-referenced in both directions. `getRelations()` still returns
`[this.table]`; the `TableReferenceNode` is deliberately not a child.

## Review findings

### Verified correct (adversarial probes, not just re-reading)

- **Slot bookkeeping under more than two slots.** Two inline CHECKs on one added column are
  legal, and the implementer's tests only covered one. Probed a backfill + 2 CHECKs plan:
  3 children, correct order, `withChildren` rotates them back correctly. **No defect** — but
  the coverage gap was real, so tests were added (below).
- **Per-row evaluation of a *correlated* subquery.** Exposing the backfill subtree newly
  subjects it to the cache/materialization advisory, whose `CacheNode` is a run-once fence.
  A correlated backfill wrongly cached would replay one row's value across every row. Probed
  a correlated subquery DEFAULT and a correlated subquery inside a CHECK over a three-row
  table: each existing row gets its own value. **No defect.**
- **Every arm the implementer wrote uses a single-row table**, which cannot distinguish
  per-row evaluation from one evaluation replayed. Closed by the multi-row arms added below.
- **"Third and last instance of OPT-009" claim.** Audited all 68 files in
  `planner/nodes/` for plan-node-valued fields (including ones nested in unions, arrays and
  maps) against every `emitPlanNode` / `emitCallFromPlan` call site in `runtime/emit/`.
  **Claim holds** — no emitted-but-unexposed expression remains. Three nodes hold plan nodes
  out-of-band but *inert* (no emitter reads them); see the tripwire below.
- **`checks` without `backfill`.** The cursor in `withChildren` starts at 0 and the emitter's
  `args.slice(backfill ? 1 : 0)` agrees, so the two stay consistent even in that shape (which
  the builder does not currently produce). **No defect.**
- **`yarn test:store` — which the implementer skipped.** Run. The new `41.14` arms pass under
  the store module, so that file's "runs under both modules" claim is now actually verified.

### Minor — fixed in this pass

- **`docs/invariants.md` OPT-009's `guard:` line named only the first `describe` block**, so
  the new `AlterTableNode …` block was undocumented. `scripts/check-docs.mjs` permits exactly
  one `guard:` line, so it now points at the substring `exposure to the optimizer` — the tail
  of both describe titles — rather than adding a second line.
- **`docs/sql-alter.md` overstated the new capability.** It claimed a `GENERATED ALWAYS AS`
  expression "may read other tables — subqueries included". It may not, if the subquery names
  the other table's column *unqualified* — see the new ticket below. The note now states the
  limitation and the qualified-name workaround.
- **Test coverage.** Added to `dml-child-exposure.spec.ts`: a backfill + two CHECKs case that
  **rotates** three children (a cursor that stalls inside the predicate list survives the
  existing two-element swap but fails this). Added to `41.14-…sqllogic`: a multi-row section
  with a correlated subquery DEFAULT, a correlated subquery inside a CHECK, two inline CHECKs
  where the *second* fails (a slot-order bug would misreport which), the same two both
  passing, and a `GENERATED ALWAYS AS` over a correlated subquery.

### Major — new ticket filed

- `backlog/bug-generated-column-subquery-column-refs-misread` — the generated-column
  dependency analysis (`extractGeneratedColumnDependencies`, `packages/quereus/src/schema/table.ts`)
  walks the expression without scope tracking, so an unqualified column name inside a subquery
  is read as a reference to the table being defined. Reproduced both a false "column not found"
  rejection and a false "cyclic dependency" rejection. Pre-existing and not ALTER-specific
  (`CREATE TABLE` rejects the same expression); found while probing this ticket's fix. Board
  checked first — no open ticket claims that site.

### Tripwires — recorded, not ticketed

- Three nodes hold plan nodes outside `getChildren()`: `RetrieveNode.bindings`,
  `LensAuxiliaryAccessNode.routables[].auxScan`, `IndexSeekNode.pushedConstraints[]`. All are
  inert today — no emitter reads them — so they only go stale after a rewrite, exactly like
  the already-documented `mutationContextValues` exemption. Each now carries a `NOTE:` at its
  declaration saying why it is exempt and what would end the exemption; `docs/invariants.md`
  OPT-009's Exempt paragraph indexes all four.

### Not changed, deliberately

- `dml-child-exposure.spec.ts` keeps its name despite covering three node types. Renaming
  buys nothing and would require re-pointing the `guard:` line; the implementer's call stands.
- The `withChildren` substitution tests swap/rotate structurally without building a
  semantically well-typed tree (the slots have different row scopes). Intentional and matching
  the DML tests — the guard is about slot bookkeeping, not semantic validity.
- `AlterTableNode.getLogicalAttributes()` spreads `...this.action`, so EXPLAIN output for an
  ADD COLUMN now includes the `backfill` / `checks` objects (plan nodes and row descriptors).
  Pre-existing shape, untouched by this diff, and not worth churn here.

### Categories with nothing to report

- **Resource cleanup / error handling**: nothing found. The diff adds no I/O, no allocation
  with a lifetime, and one `throw` on a child-count mismatch that matches the sibling nodes'
  wording. The emitter's existing `try/finally` around the row slots is unchanged.
- **Source hygiene**: nothing found. `alter-table-node.ts` grew 38 lines, all inside one
  4-line helper and two short overrides; no file crossed a size threshold.
- **Type safety**: nothing found. No `any`; the one cast (`this.action as Extract<…, {type:
  'addColumn'}>`) is guarded by the `expressions.length === 0` early return above it.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (full workspace) — 8672 passing, 13 pending, **0 failing**.
- `yarn workspace @quereus/quereus run test:store` — 2762 passing, 2 pending, **1 failing**:
  `07.3.2-grouped-select-list-shape.sqllogic`, a store-mode grouped-select-list shaping
  mismatch unrelated to this diff (this review's `src/` changes are comment-only). Not
  previously in `tickets/.pre-existing-known.md`, so recorded in
  `tickets/.pre-existing-error.md` for the triage pass.
- `node scripts/check-docs.mjs` — 2 failures, both the `docs/schema.md` / `docs/sync.md`
  word-count ratchet already tracked under `debt-docs-size-ratchet-red-again`.
  `docs/invariants.md` and `docs/sql-alter.md` pass (OPT-009's body stays inside the 120-word
  limit, which an earlier draft of the Exempt paragraph had breached).
