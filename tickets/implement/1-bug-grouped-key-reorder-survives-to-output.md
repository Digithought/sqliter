---
description: A query that groups on two or more columns can hand its columns back in the wrong order whenever the optimizer works out that one grouping column can be derived from another; make the optimizer put the columns back where the query asked for them.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts  # the rewrite that shifts output positions — the one site to change
  - packages/quereus/src/planner/nodes/project-node.ts                              # ProjectNode ctor: predefinedAttributes / per-projection attributeId
  - packages/quereus/src/planner/building/select-aggregates.ts                       # aggregateOutputIsSelectList — its doc-comment forward-references this ticket
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts                      # one existing assertion changes; new cases go here
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic            # result-level coverage
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts           # rule-level coverage
  - docs/materialized-views.md                                                       # § "Group-key reorder" (line ~281) documents the shift as baseline
  - docs/sql-select.md                                                               # § 3.3 states the guarantee being restored
difficulty: medium
repro: verified
---

# Restore select-list column order after GROUP BY FD simplification

## The defect

`docs/sql-select.md` § 3.3 promises a grouped query's output columns follow the
select list. With ≥2 grouping columns, when `rule-groupby-fd-simplification`
fires, they do not.

Confirmed by running each of these on memory tables at `main`
(`create table pk (v integer primary key, g text)`, `nk (a text, b text)`,
`nj (a text, c text)`):

| query | columns returned | expected |
|---|---|---|
| `select g, v, count(*) as c from pk group by g, v` | `v, g, c` | `g, v, c` |
| `select a, b, count(*) as c from nk where a = b group by a, b` | `b, a, c` | `a, b, c` |
| `select nk.a, nk.b, nj.a, nj.c, count(*) as c from nk join nj on nk.a = nj.a group by nk.a, nk.b, nj.a, nj.c` | `b, a, c, a, c` | `a, b, a:1, c, c:1` |

Names and values move together — the aggregate's attributes carry both — so this
is a *positional* defect, not a name/value mismatch. Anything binding by position
gets the wrong column: `row[0]`, `insert into t select …`, a `union` arm.
Anything binding by name or attribute id is unaffected, which is why an alias in
the select list (`select g as gg, v as vv, …`) hides it: the alias forces a
projection above the aggregate.

## Cause

`ruleGroupByFdSimplification` drops a grouping column that is functionally
determined by the survivors and re-emits it as a picker `min(<col>)` aggregate.
An `AggregateNode`'s output layout is fixed — grouping keys first, then aggregate
results — so a dropped key necessarily moves from its key slot down into the
aggregate block. Every consumer that binds by attribute id is fine; the statement
result, when the aggregate is the query root with no projection above it, binds
by position.

## Fix — cap the rewrite with an order-restoring projection

When (and only when) the rewrite permutes the output attribute order, wrap the
new `AggregateNode` in a `ProjectNode` that re-emits the same attribute ids in
their original order. Downstream binding is unchanged (same ids, forwarded — the
provenance walk in `planner/analysis/attribute-provenance.ts` treats a
republished id as a forward, not a second origination), and positional consumers
see select-list order again.

This exact patch was prototyped and verified — all four repro queries return
correct column order, and `yarn test` came back **5377 passing, 1 failing**, the
one failure being the plan-shape assertion described under *Test fallout* below.
Replace the closing `return new AggregateNode(...)` of the rule with:

```ts
	const newAgg = new AggregateNode(
		node.scope,
		node.source,
		keptGroupBy,
		newAggregates,
		undefined,
		newAttrs,
	);

	// The rewrite may permute output positions (kept keys, then pickers, then the
	// original aggregates). Attribute ids survive, so every id-bound consumer is
	// fine — but the statement result binds by POSITION when this node is the query
	// root, so cap the permuting case with a projection that restores the original
	// order. No-op when the drop happened to be order-preserving.
	const permuted = newAttrs.some((a, i) => a.id !== aggAttrs[i].id);
	if (!permuted) return newAgg;

	const newIndexById = new Map(newAttrs.map((a, i) => [a.id, i]));
	const projections = aggAttrs.map(attr => ({
		node: new ColumnReferenceNode(
			node.scope,
			{ type: 'column', name: attr.name } satisfies AST.ColumnExpr,
			attr.type,
			attr.id,
			newIndexById.get(attr.id)!,
		) as ScalarPlanNode,
		alias: attr.name,
		attributeId: attr.id,
	}));
	return new ProjectNode(node.scope, newAgg, projections, undefined, aggAttrs.slice(), false);
```

plus `import { ProjectNode } from '../../nodes/project-node.js';`.

Two points to settle while implementing:

- `preserveInputColumns` was passed `false` in the prototype. The builder's own
  select-list projections use the default `true`. With `predefinedAttributes`
  supplied the flag does not change this node's attributes, but it is readable by
  other rules, so pick deliberately and say why in a comment.
- `ColumnReferenceNode.columnIndex` is advisory here: `runtime/emit/column-reference.ts`
  resolves by attribute id through the row descriptor. Set it correctly anyway.

Also update the rule's header comment — it currently states *"positions may shift,
attribute IDs do not"* as the rewrite's contract, which is what this change ends.

### Alternatives considered and rejected

- **Decline the rewrite when it would permute.** Cheapest, obviously sound, but
  it gives up the optimization on the common `group by <other>, <pk>` shape: the
  dropped column sits at index 0 there, so the drop always permutes.
- **Force a final projection at build time for any grouped query with ≥2 bare-column
  grouping keys.** Pays a projection on *every* such query even when the rule never
  fires, and re-routes 2-key grouped materialized-view bodies from
  residual-recompute to full-rebuild (`test/incremental/delta-aggregate.spec.ts`).
  The cap-in-the-rule approach pays only when the rewrite actually permutes.

## Test fallout

One existing assertion changes. `test/plan/grouped-projection-shape.spec.ts:80`
(*"projects a grouped select list even when it needs no expression rewriting"*)
asserts exactly one `PROJECT` for `SELECT v, g FROM gk GROUP BY g, v`. With the
cap there are two, stacked:

```
PROJECT SELECT v, g          <- the builder's select-list projection
PROJECT SELECT g, v          <- the cap
STREAMAGGREGATE GROUP BY v  STREAM AGG min(g) AS g
```

That is the intended shape, not a regression — update the assertion to pin the
stack (cap directly above the aggregate, select-list projection above it) and say
in the test's comment why two exist.

The stacked-projection cost is a tripwire, not follow-up work: it is one extra
row copy on a plan that only appears when the rule fires *and* permutes. Record it
as a `NOTE:` at the cap site — *if grouped-plan row-copy overhead ever shows up in
a profile, collapse a permutation-only `Project` over `Project`; the collapse needs
no index rebinding because column references resolve by attribute id at runtime.*

## Coverage to add

`test/plan/grouped-projection-shape.spec.ts` — column-name assertions (the
`columnNames` helper already there) for all three repro queries, in the
*with aggregates in the SELECT list* describe block. Note the tables it defines
today: `gk` has the PK case; the equality-driven and join cases need `nk`/`nj`
fixtures (`nk` exists; a second no-PK table sharing a column name does not).

`test/logic/07.3.2-grouped-select-list-shape.sqllogic` — result-row coverage for
the same three, so the values are pinned positionally and not just the names.

`test/optimizer/rule-groupby-fd-simplification.spec.ts` — a case asserting the
cap `Project` appears when the rewrite permutes and does **not** appear when the
dropped keys were already a suffix of the grouping list.

## Docs

- `docs/materialized-views.md` § "Group-key reorder" (~line 281) describes the
  base's column reorder as something the view rewrite must reproduce. Rewrite it:
  the base no longer reorders. The forgo guard it justifies is retired by
  `mv-group-key-pinned-guard-obsolete`; cross-reference rather than duplicating.
- `docs/sql-select.md` § 3.3 — no wording change needed, but confirm the
  guarantee now reads as unconditional.

## TODO

- Add the cap `ProjectNode` to `ruleGroupByFdSimplification`, gated on the
  permuted check; import `ProjectNode`.
- Decide and comment the `preserveInputColumns` value.
- Update the rule's header comment: the rewrite now preserves positions as well
  as attribute ids.
- Add the `NOTE:` tripwire at the cap site about collapsing a stacked
  permutation-only projection if it ever profiles hot.
- Update `test/plan/grouped-projection-shape.spec.ts:80` to expect the two-Project
  stack, with a comment explaining it.
- Add the three repro queries to `test/plan/grouped-projection-shape.spec.ts`
  (column names) and `test/logic/07.3.2-grouped-select-list-shape.sqllogic`
  (rows), adding the `nj` fixture where needed.
- Add rule-level cases (permuting vs order-preserving drop) to
  `test/optimizer/rule-groupby-fd-simplification.spec.ts`.
- Drop the forward-reference to this ticket from the `aggregateOutputIsSelectList`
  doc-comment in `packages/quereus/src/planner/building/select-aggregates.ts`.
- Rewrite `docs/materialized-views.md` § "Group-key reorder".
- Run `yarn test` and `yarn lint` from the repo root.
