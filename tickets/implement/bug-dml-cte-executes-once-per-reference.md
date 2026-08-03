---
description: A query can name a block that inserts, updates or deletes rows and hands them back; if the query mentions that block more than once, the write happens once per mention instead of once, which either fails with a duplicate-key error or silently applies the change twice.
files:
  - packages/quereus/src/planner/building/with.ts                     # buildCommonTableExpr — where the CTE node is constructed
  - packages/quereus/src/planner/nodes/cte-node.ts                    # CTENode — regenerates its identity object on every rebuild
  - packages/quereus/src/runtime/emit/cte.ts                          # emitCTE — keys the shared per-execution buffer
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts # constructs a replacement CTENode
  - packages/quereus/src/planner/cache/materialization-advisory.ts    # markCTEMaterialization constructs a replacement CTENode
  - packages/quereus/src/planner/analysis/const-pass.ts               # replaceBorderNodes — the rewrite that splits a shared node (context; no edit needed)
  - packages/quereus/src/runtime/emit/recursive-cte.ts                # already keys its buffer the way this fix needs (precedent)
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts             # existing plan-shape spec for DML-bodied CTEs
  - packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic          # existing CTE edge-case row-set tests
repro: verified
difficulty: medium
---

# A data-modifying `with` block must run once per statement, not once per mention

## What is wrong

SQL lets a `with` clause name a statement that changes rows and returns them:

```sql
with c as (insert into t (k) values (1) returning k) select …
```

The write inside that block must happen **exactly once** per statement execution, no matter how
many times the rest of the query names `c`. Today it happens once per mention.

## Reproduced on `main` at `ec951582`

Each row below was run against a fresh in-memory database. "table after" is the contents of `t`
once the statement finished.

| statement | result | table after | correct? |
|---|---|---|---|
| `with c as (insert into t (k) values (1) returning k) select (select count(*) from c) a, (select count(*) from c) b` | `UNIQUE constraint failed: t PK.` | empty | no — should be `a=1,b=1`, `t={1}` |
| same insert, referenced via `from c c1 join c c2 on c1.k = c2.k` | `UNIQUE constraint failed: t PK.` | empty | no |
| `with c as (update t set v = v + 1 returning k, v) select (select count(*) from c) a, (select count(*) from c) b` (`t` starts at `v=0`) | `a=1, b=1` | `v=2` | **no — silent double-apply** |
| `with c as (delete from t where k = 1 returning k) select (select count(*) from c) a, (select count(*) from c) b` (`t={1,2}`) | `a=1, b=0` | `{2}` | no — `b` should be `1` |
| `with c as materialized (insert …) …` referenced twice | `UNIQUE constraint failed: t PK.` | empty | no — the explicit hint does not rescue it |
| `with c as (insert …) select * from c` (one mention) | `k=1` | `{1}` | yes |

The update row is the dangerous one: no error, plausible-looking output, wrong data.

## Why it happens — two independent causes, one requirement

The runtime already has the right mechanism: when a `CTENode` carries `materialize = true`,
`emitCTE` drives the body once per statement execution into a shared buffer and every mention
replays that buffer. Both causes below are reasons that mechanism fails to engage.

### Cause A — the reference count never reaches two

`MaterializationAdvisory.shouldMaterializeCTE` turns buffering on when the `CTENode` has two or
more parents in the plan. But when the same CTE name is used with the same alias from two
different places — e.g. two scalar subqueries, `(select count(*) from c)` twice — `buildFrom`
(`planner/building/select.ts`, the `cteReferenceCache` lookup) hands back the **same**
`CTEReferenceNode` object for both. One reference node ⇒ the `CTENode` has one parent ⇒ the gate
reads "referenced once" ⇒ no buffering. That single reference node is nevertheless emitted twice
(once per subquery), so the body runs twice.

Measured: for the `update` row above, the optimized plan contains exactly **one** `CTENode`
instance, and the update still applies twice.

### Cause B — the buffer key is not stable across plan rewrites

`emitCTE` keys its per-execution buffer on `plan.id`, the plan node's unique id. That is only
correct while every mention points at the *same* `CTENode` object. The optimizer does not
guarantee that:

- `replaceBorderNodes` in `planner/analysis/const-pass.ts` (the constant-folding pass) is a plain
  recursive rewrite with no memo, so a node reachable from two parents is rebuilt **once per
  parent path**. A DML body built from `values (…)` folds to a table literal, so this fires for
  exactly the shapes in the table above; a body reading a real table (`insert into t select … from u`)
  does not fold, stays shared, and behaves correctly today.
- `ruleCteOptimization` and `MaterializationAdvisory.markCTEMaterialization` each construct a
  replacement `CTENode` directly, and `CTENode.withChildren` does too — all of them let the
  constructor mint a **fresh** `tableDescriptor` identity object.

Measured: `insert … values` referenced twice yields **two** distinct `CTENode` instances in the
optimized plan; the same statement with a non-foldable body yields one. And with an explicit
`materialized` hint, both copies carry `materialize = true` and the statement *still* inserts
twice — two ids, two buffers.

Note the contrast: `RecursiveCTENode` already threads its `tableDescriptor` through
`withChildren` / `withMaterialize`, and `emitRecursiveCTE` already keys its buffer on that
descriptor rather than on the node id, precisely so that duplicated copies share one buffer. This
fix brings `CTENode` in line with that existing precedent.

## Expected behaviour

- The write executes once per statement execution; every mention of the block reads the same set
  of returned rows.
- This holds regardless of how many mentions there are, what shape they take (join, scalar
  subquery, `from`), whether the body is constant-foldable, and what materialization hint is
  written. An explicit `not materialized` on a data-modifying block does **not** license
  re-execution — correctness beats the hint, the same call the recursive-CTE branch already makes
  (see the comment in `markCTEMaterialization`).
- Non-data-modifying CTEs keep their current behaviour exactly: a plain `select`-bodied CTE
  referenced twice from two scalar subqueries still evaluates twice today, and that stays fine
  (it is a performance question, tracked separately in
  `backlog/bug-cte-cache-gate-reads-unknown-as-empty`).

## The fix (spiked and validated)

The four edits below were applied on `main` at `ec951582`, verified against every row of the
repro table, and `yarn test` was run to completion: **8488 + 370 + 113 + 63 + 17 + 28 + 1291 +
648 + 52 + 31 + 34 + 134 + 22 passing, 0 failing.** The spike was then reverted — the working
tree is clean and this ticket is the handoff, not the code.

1. **`planner/nodes/cte-node.ts`** — give the constructor an optional trailing
   `tableDescriptor?: TableDescriptor` parameter, assign `this.tableDescriptor = tableDescriptor ?? {}`
   in the constructor body (drop the field initializer), and pass `this.tableDescriptor` through
   `withChildren`. Mirrors `RecursiveCTENode`.
2. **`planner/rules/cache/rule-cte-optimization.ts`** — pass `cteNode.tableDescriptor` when it
   builds the replacement `CTENode`. (One added argument. This file is also named by
   `backlog/bug-cte-cache-gate-reads-unknown-as-empty`, which is about the *caching gate* a few
   lines above; the two do not overlap.)
3. **`planner/cache/materialization-advisory.ts`** — same one-argument addition in
   `markCTEMaterialization`.
4. **`runtime/emit/cte.ts`** — key `rctx.cteMaterializations` on `plan.tableDescriptor` instead of
   `plan.id`. The map's declared key type in `runtime/types.ts` is already
   `string | TableDescriptor`, so no type change is needed. Update the comment above it: the key
   is now the CTE's stable identity, which survives the optimizer rebuilding the node.
5. **`planner/building/with.ts`** — in `buildCommonTableExpr`, construct a CTE whose body is an
   `insert` / `update` / `delete` with `materialize = true` unconditionally, and leave every other
   body exactly as it is today (`materialize` defaulted, hint preserved for the advisory pass).
   Replace the existing comment block above the `new CTENode(...)` so it explains both halves.

Edits 1–4 are what make a *split* node still share one buffer; edit 5 is what makes buffering
unconditional for a data-modifying body. Both are required — neither alone fixes every row of the
repro table.

## Deliberately out of scope

An **unreferenced** data-modifying block (`with c as (insert …) select 42`) does not run at all
today — the planner drops the whole CTE, so there is no node left to mark. SQLite and PostgreSQL
both run it. That is a genuine deviation, but it resolves at a different code site (something has
to anchor the block into the plan — `SinkNode` in `planner/nodes/sink-node.ts` looks like the
natural vehicle), so it is filed separately as
`backlog/bug-unreferenced-dml-cte-never-runs`. Do not try to fix it here; do not regress it
either — the "referenced zero times" case must keep returning `42` without error.

## TODO

Phase 1 — make the identity stable

- Thread an optional `tableDescriptor` through the `CTENode` constructor and `withChildren`
- Pass the existing descriptor through in `ruleCteOptimization` and in `markCTEMaterialization`
- Key `emitCTE`'s per-execution buffer on `plan.tableDescriptor`; refresh the surrounding comment

Phase 2 — make buffering unconditional for a data-modifying body

- In `buildCommonTableExpr`, set `materialize = true` for `insert` / `update` / `delete` bodies
- Confirm `shouldMaterializeCTE`'s `!node.materialize` guard leaves the already-marked node alone,
  and that an explicit `not materialized` hint on a DML body no longer re-enables re-execution
- Consider whether `CTENode.toString()` should surface the buffered state the way
  `RecursiveCTENode.toString()` does (` [buffered]`); if you add it, regenerate the affected
  golden plans

Phase 3 — tests

- Row-set coverage in `test/logic/` (new file alongside `13.3-cte-edge-cases.sqllogic`, or extend
  it): every row of the repro table above — insert/update/delete bodies, referenced twice via
  scalar subqueries and via a join, foldable (`values`) and non-foldable (`select … from u`)
  bodies, plus explicit `materialized` and `not materialized` hints, plus the
  referenced-once and referenced-zero-times controls
- Plan-shape coverage in `test/plan/cte-dml-plan-shape.spec.ts`: a DML-bodied CTE carries
  `materialize = true` on every `CTENode` instance in the optimized plan, and all those instances
  share one `tableDescriptor`
- Guard that a plain `select`-bodied CTE is untouched: `test/plan/cte-materialization.spec.ts` and
  `test/optimizer/plan-shape-decisions.spec.ts` must stay green unmodified

Phase 4 — validate and document

- `yarn lint && yarn build && yarn test`
- Update the CTE materialization description in `docs/optimizer.md` (and `docs/runtime.md` if it
  describes the buffer key) to say that a data-modifying CTE is always buffered and that the
  buffer is keyed on the CTE's stable descriptor, not the plan node id
