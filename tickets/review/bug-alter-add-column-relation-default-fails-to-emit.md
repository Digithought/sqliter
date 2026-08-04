description: Adding a column to an existing table used to fail outright when the new column's default value (or its generated expression, or its CHECK) was written as a query over another table — that is now fixed, plus test coverage and docs.
files:
  - packages/quereus/src/planner/nodes/alter-table-node.ts   # the fix — getChildren/withChildren now expose backfill + CHECK expressions
  - packages/quereus/src/runtime/emit/alter-table.ts         # cross-reference comment on the param-slot order (unchanged logic)
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts  # OPT-009 structural guard — extended with AlterTableNode
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic  # new — main-schema arms
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic  # extended — temp-schema arms
  - docs/invariants.md   # OPT-009 — third code: line
  - docs/sql-alter.md    # §ADD COLUMN — subquery-in-value-source note
repro: verified
difficulty: easy
---

## What changed

`AlterTableNode` (`planner/nodes/alter-table-node.ts`) extended `VoidNode`, which returns
`[]` from `getChildren()`. Its ADD COLUMN action holds two `ScalarPlanNode`s — the per-row
backfill expression (a non-foldable DEFAULT or a `GENERATED ALWAYS AS` expression) and any
CHECK predicates on the new column — reachable only through the `action` union, not through
`getChildren()`. The optimizer rewrites subtrees only via `getChildren()`
(`planner/framework/pass.ts`), so a subquery inside either expression reached the runtime
still logical and died with an internal-looking error (`No emitter registered for
Aggregate`, or `RetrieveNode ... was not rewritten to a physical access node`). A simple
(non-subquery) expression survived, which is why this went unnoticed until now.

This was the third and last instance of invariant OPT-009 ("every held expression is a
child", `docs/invariants.md`) — the same defect `DmlExecutorNode` and `ConstraintCheckNode`
had, fixed earlier by `bug-dml-side-expressions-invisible-to-optimizer` (see
`tickets/complete/`). The fix here follows that ticket's template exactly:

- `addColumnExpressions()` — private helper returning `[backfill.node?, ...checks.predicates[].node]` for an `addColumn` action, `[]` otherwise.
- `getChildren()` returns that list.
- `withChildren()` validates the count, narrows to `ScalarPlanNode` via the existing `asScalarNodes` helper, short-circuits on an unchanged identity round-trip, and otherwise rebuilds `action` (spread, not mutated) with the rewritten nodes sliced back into `backfill` / `checks.predicates` — same order.

**The child order matters and is now cross-referenced in both directions**: a comment in
`AlterTableNode.addColumnExpressions()` points at `emitAlterTable`'s `params`
(`runtime/emit/alter-table.ts`), and a comment there points back — both say backfill first,
then CHECK predicates in order. `getRelations()` (returning `[this.table]`) is unchanged;
the `TableReferenceNode` is deliberately still not a child.

## Test coverage added

**`test/optimizer/dml-child-exposure.spec.ts`** (OPT-009 structural guard, kept as one file
rather than renamed — implementer's call per the ticket, lower blast radius): six new tests
under `AlterTableNode ADD COLUMN expression exposure to the optimizer`, covering
backfill-only, backfill+CHECK, a non-`addColumn` action (zero children), identity
round-trip, a **non-identity slot-substitution** round-trip (swaps the two slots so a
slot-order bug would show up as a mismatch, not just survive an identity check — the DML
review flagged that identity alone proves nothing), and wrong-child-count rejection. All 13
tests in the file pass (7 pre-existing + 6 new).

**`test/logic/41.14-alter-add-column-subquery-backfill.sqllogic`** (new): the five
main-schema arms from the ticket's reproduction table, now all passing — subquery-aggregate
DEFAULT, subquery-scalar (`LIMIT 1`) DEFAULT, `GENERATED ALWAYS AS` over a subquery,
DEFAULT+CHECK where the CHECK passes, and the same shape where the CHECK fails (asserts the
table is left with none of the previously-added columns changed... actually asserts the
table is left exactly as it was after the four successful ADDs, i.e. the rejected `zz`
column never appears).

**`test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic`** (extended): three new
arms under a new `ALTER TABLE ADD COLUMN's per-row backfill / CHECK, same rule` section,
right after the existing bulk-CHECK-scan section (whose comment now says the per-row path is
covered too). Verifies a per-row backfill / CHECK on a `temp`-schema table resolves a bare
relation name against the *table's own* schema, not the session's `schema_path` — both
directions (accept when true against the owning schema's table, reject when only true
against the session-path decoy), closing the untestable gap the sibling ticket
`bug-column-default-ignores-owning-table-schema` recorded (it wrapped the code but couldn't
exercise this arm because this bug blocked it).

## Validation run

- `yarn workspace @quereus/quereus run build` — clean, no errors.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file typecheck).
- `node scripts/check-docs.mjs` — 2 failures, both pre-existing and already tracked in `tickets/.pre-existing-known.md` under `debt-docs-size-ratchet-red-again` (`docs/schema.md`, `docs/sync.md`, both untouched by this diff). `docs/invariants.md` and `docs/sql-alter.md` pass.
- `yarn test` (full workspace) — **8671 passing, 13 pending, 0 failing**. (8664 baseline from the ticket + 6 new unit tests + 2 new sqllogic-file test cases, roughly reconciles; not independently re-verified test-by-test.)
- `yarn test:store` was **not** run — the diff is planner plan-node logic plus test/docs only, no vtab/store code, per the ticket's own guidance that it's optional here. If a reviewer wants belt-and-suspenders, it's a one-command follow-up (`yarn test:store`), not expected to differ.

## Known gaps / things the reviewer should know

- I did not rename `dml-child-exposure.spec.ts` to a broader name despite it now covering three node types — the ticket left this as an implementer's call and I chose the lower-risk option (no filename change, no consumers to update). If a reviewer prefers the rename, `docs/invariants.md`'s `guard:` line for OPT-009 would need updating too (path only; the `describe` title text used as the symbol match is unaffected either way since I didn't rename the top-level describe blocks).
- The `withChildren` slot-substitution test swaps a backfill-slot node into the CHECK slot and vice versa purely structurally (both are `ScalarPlanNode`s) — it does not construct a *semantically* well-typed swapped tree (the two slots have different row scopes: existing-columns-only vs existing+new). That mirrors the equivalent DML test's approach and is intentional: the guard is about slot bookkeeping, not semantic validity of a deliberately-broken substitution.
- I did not add a fourth/fifth sqllogic arm for a **generated column** default reading another table in the schema-authored-isolation file — the ticket's Phase 2 spec only asked for the three arms it listed (subquery DEFAULT, DEFAULT+CHECK pass, DEFAULT+CHECK reject); generated-column-over-subquery is exercised in `41.14` instead (main-schema only), not cross-schema. If schema-authored generated-column defaults specifically need a cross-schema regression test, that's a gap.
- No new negative/error-message assertions beyond `-- error: CHECK constraint failed` / `-- error: CHECK` substring matches (matching the sqllogic convention already used in sibling files).
