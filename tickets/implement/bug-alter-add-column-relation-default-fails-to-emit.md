---
description: Adding a column to an existing table fails outright when the new column's default value (or its generated expression, or its CHECK) is written as a query over another table — the statement errors instead of filling the new column in. Make it work, the way the equivalent create-table-plus-insert already does.
files:
  - packages/quereus/src/planner/nodes/alter-table-node.ts   # THE fix site — expose held expressions via getChildren/withChildren
  - packages/quereus/src/planner/nodes/plan-node.ts          # `asScalarNodes` helper (already exists, reuse)
  - packages/quereus/src/planner/nodes/dml-executor-node.ts  # reference implementation of the same fix
  - packages/quereus/src/runtime/emit/alter-table.ts         # emitter param-slot order the child order must match
  - packages/quereus/src/planner/building/alter-table.ts     # where backfill/checks nodes are built (no change expected)
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts  # existing OPT-009 structural guard, extend
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic  # nearest sibling coverage
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic  # schema-narrowing arms
  - docs/invariants.md                                       # OPT-009 — add the third code site + guard
  - docs/sql-alter.md                                        # §ADD COLUMN behaviour note
repro: verified
difficulty: easy
---

# ALTER TABLE ADD COLUMN: expose the backfill / CHECK expressions to the optimizer

## Root cause — one site

`AlterTableNode` (`planner/nodes/alter-table-node.ts`) extends `VoidNode`, which returns `[]`
from `getChildren()`. The ADD COLUMN action carries two sets of already-built
`ScalarPlanNode`s — `action.backfill.node` (the per-row DEFAULT / `generated always as`
expression) and `action.checks.predicates[].node` (the per-row CHECK predicates) — reachable
only through the action union. `getChildren()` is the only channel the optimizer rewrites
subtrees through (`planner/framework/pass.ts` descends via `getChildren()`), so those
subtrees stay logical. A simple expression survives (nothing needed rewriting); a subquery
reaches emit un-physicalized and dies with an internal-looking error.

This is the **third instance of invariant OPT-009** ("every held expression is a child",
`docs/invariants.md`). The first two — `DmlExecutorNode` and `ConstraintCheckNode` — were
fixed by `bug-dml-side-expressions-invisible-to-optimizer` (see `tickets/complete/`), and
that fix is the template to copy here.

A sweep of `planner/nodes/` confirms this is the **last** site: only
`alter-table-node.ts` both extends `VoidNode` and holds a `ScalarPlanNode`
(`grep -l VoidNode *.ts | xargs grep -l ScalarPlanNode` → `alter-table-node.ts`,
`plan-node.ts`).

## Reproduction (verified at `9c920252`, in-memory `Database`)

| statement | before |
| --- | --- |
| `alter table a1 add column w integer default (select count(*) from d)` | `No emitter registered for Aggregate` |
| `alter table a1 add column x integer default ((select k from d limit 1))` | `RetrieveNode for table 'd' was not rewritten to a physical access node.` |
| `alter table a1 add column g integer generated always as ((select count(*) from d))` | `No emitter registered for Aggregate` |
| `alter table a1 add column z integer default (new.id) check ((select count(*) from d) = 1)` | (blocked — the backfill fails first) |

The bulk CHECK scan (`validateBackfillAgainstChecks`, literal-default path) is **not**
affected — verified: `add column y integer default 0 check ((select count(*) from d) = 1)`
works today. Only the per-row arms are broken.

## The fix (prototyped and verified, then reverted — apply as-is)

Add to `AlterTableNode`, importing `asScalarNodes` and `type PlanNode` from `./plan-node.js`:

```ts
	/**
	 * Every user expression this node holds, in the fixed order the emitter's parameter
	 * slots use (see `emitAlterTable`): the ADD COLUMN backfill first, then its per-row
	 * CHECK predicates. Empty for every other action.
	 */
	private addColumnExpressions(): readonly ScalarPlanNode[] {
		if (this.action.type !== 'addColumn') return [];
		const out: ScalarPlanNode[] = [];
		if (this.action.backfill) out.push(this.action.backfill.node);
		for (const predicate of this.action.checks?.predicates ?? []) out.push(predicate.node);
		return out;
	}

	override getChildren(): readonly PlanNode[] {
		return this.addColumnExpressions();
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expressions = this.addColumnExpressions();
		if (newChildren.length !== expressions.length) {
			throw new Error(`AlterTableNode expects ${expressions.length} children, got ${newChildren.length}`);
		}
		if (expressions.length === 0) return this;
		const rewritten = asScalarNodes(newChildren, 'AlterTableNode addColumn');
		if (rewritten.every((node, i) => node === expressions[i])) return this;

		const action = this.action as Extract<AlterTableAction, { type: 'addColumn' }>;
		let cursor = 0;
		const backfill = action.backfill ? { ...action.backfill, node: rewritten[cursor++] } : undefined;
		const checks = action.checks
			? { ...action.checks, predicates: action.checks.predicates.map(p => ({ ...p, node: rewritten[cursor++] })) }
			: undefined;
		return new AlterTableNode(this.scope, this.table, { ...action, backfill, checks }, this.sql);
	}
```

Points that matter:

- **Child order must equal the emitter's parameter order.** `emitAlterTable`
  (`runtime/emit/alter-table.ts`, `params`) is backfill-first-then-checks and slices `args`
  the same way; `addColumnExpressions()` reproduces exactly that order. Keep the two in
  sync — a comment at each site pointing at the other is warranted.
- **`getRelations()` stays overridden** returning `[this.table]`. The `TableReferenceNode`
  is deliberately *not* a child (it is not, today, and ALTER works); leaving it out keeps the
  child indices purely scalar.
- **Rebuild, do not pass `this.action` through.** The action object is spread with fresh
  `backfill` / `checks` so the returned node cannot hold a stale pre-rewrite subtree — the
  same trap the DML ticket's review called out.

### Verified results with the patch applied

All five main-schema arms behave correctly (`d` has 1 row, `a1` has 1 row):

```
OK   add column w integer default (select count(*) from d)                    -> w = 1
OK   add column x integer default ((select k from d limit 1))                 -> x = 1
OK   add column g integer generated always as ((select count(*) from d))      -> g = 1
OK   add column z integer default (new.id) check ((select count(*) from d) = 1)  -> z = 1
FAIL add column zz integer default (new.id) check ((select count(*) from d) = 99)
     => CHECK constraint failed: _check_zz ((select count(*) from d) = 99)   [correct rejection]
```

`yarn test` with the patch in place: **8664 passing, 13 pending, 0 failing** across the whole
workspace — identical to the baseline recorded by the previous ticket. No regressions.

## Closing the sibling ticket's untestable gap

`bug-column-default-ignores-owning-table-schema` (complete) wrapped `buildAddColumnChecks`
in `schemaAuthoredContext` but recorded the arm as untestable, because per-row CHECK
predicates only exist when there is a per-row backfill — i.e. exactly what this bug blocked.
With the patch, that arm is testable and **verified to work**. Setup: `main.c` with 3 rows,
`temp.c` with 1 row, `temp.t` with 1 row (note: `create table temp.c (…)` — this engine has
no `create temp table` syntax):

```
OK   alter table temp.t add column n integer default (select count(*) from c)   -> n = 1  (temp.c, not main.c)
OK   alter table temp.t add column m integer default (new.id) check ((select count(*) from c) = 1)   [accepted]
FAIL alter table temp.t add column mm integer default (new.id) check ((select count(*) from c) = 3)  [rejected]
```

Both directions, so it distinguishes a narrowed path from a check that silently did nothing.
Land these as real coverage.

## TODO

**Phase 1 — the fix**

- Apply the `addColumnExpressions()` / `getChildren()` / `withChildren()` patch above to
  `packages/quereus/src/planner/nodes/alter-table-node.ts`.
- Cross-reference comments: at `emitAlterTable`'s `params` construction, note that the slot
  order is defined by `AlterTableNode.addColumnExpressions()`, and vice versa.

**Phase 2 — coverage**

- Extend the OPT-009 structural guard (`test/optimizer/dml-child-exposure.spec.ts`) with
  `AlterTableNode`: children exposed in the documented order for backfill-only,
  checks-only-with-backfill, and both; `withChildren` substituting a distinct node into each
  slot lands it back in the right slot (not just the identity round-trip — the DML review
  found that identity alone short-circuits and proves nothing); wrong-child-count rejection;
  and a non-`addColumn` action exposing zero children. The file name is now narrower than its
  subject — rename it (e.g. `child-exposure.spec.ts`) and update the `guard:` pointer in
  `docs/invariants.md`, or add a sibling spec, implementer's call.
- New SQL logic file (suggest `test/logic/41.14-alter-add-column-subquery-backfill.sqllogic`,
  beside `41.13-alter-add-column-generated-backfill.sqllogic`) covering the four main-schema
  arms above plus the CHECK-rejection arm, and asserting the table is left unchanged when the
  ALTER is rejected.
- Append the three `temp`-schema arms to
  `test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic`, next to the existing
  "ALTER TABLE ADD COLUMN's CHECK, validated over the existing rows" section — that section's
  comment currently describes only the bulk scan; extend it to say the per-row predicates are
  now covered too.

**Phase 3 — docs**

- `docs/invariants.md` OPT-009: add
  `packages/quereus/src/planner/nodes/alter-table-node.ts — getChildren, withChildren` as a
  third `code:` line, and update `guard:` if the spec is renamed. Watch the 120-word
  per-invariant cap `scripts/check-docs.mjs` enforces — the body may need no change at all.
- `docs/sql-alter.md` §ADD COLUMN: state that an expression DEFAULT, a `GENERATED ALWAYS AS`
  expression, and an inline CHECK on the new column may all read other tables (subqueries
  included), and are evaluated per existing row during backfill.

**Phase 4 — validation**

- `yarn test` (expect 8664+ passing, 0 failing) and `yarn workspace @quereus/quereus run lint`.
- `node scripts/check-docs.mjs` — `docs/schema.md` and `docs/sync.md` are pre-existing
  over-ratchet, tracked as `debt-docs-size-ratchet-red-again` in
  `tickets/.pre-existing-known.md`. Anything else is yours.
- `yarn test:store` is optional: the diff is planner plan-node logic only, no vtab/store code.
