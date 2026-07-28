---
description: When a query filters a large stored table by a set of key values produced by a subquery, the engine reads the whole table and checks each row. Design a way to hand that set of keys to the storage backend so it can look up just those rows instead.
prereq: feat-uncorrelated-in-semijoin
files:
  - packages/quereus/src/vtab/best-access-plan.ts            # the plan-time module contract
  - packages/quereus/src/vtab/filter-info.ts                 # the runtime channel to a module's query()
  - packages/quereus/src/vtab/index-descriptor.ts            # IndexPlanKind / AccessPath
  - packages/quereus/src/vtab/idx-str.ts                     # plan= code encoding
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus-store/src/common/store-module.ts        # tryIndexAccessPlan, equalitySeekCardinality
  - packages/quereus-store/src/common/store-table.ts         # scanMultiSeek — the runtime that would be reused
difficulty: hard
---

# Design: push a runtime key set into the storage access path

## The problem in plain terms

`delete from big where id in (select id from small)` reads every row of `big`.
After `feat-uncorrelated-in-semijoin` lands it will read every row of `big` *once*
(a hash semi join over the small side) instead of repeatedly — linear, not quadratic —
but it still touches the whole table. If `big.id` is indexed and `small` returns 50 rows,
the right answer is 50 index lookups.

Users work around this today by hand-writing chunked literal lists
(`where id in (1, 2, 3, …)`), which *does* get index lookups: `feat-store-in-list-index-pushdown`
(complete) taught the store backend to serve a literal `IN` list as a multi-value index
seek. The gap is that the values must be known when the query is planned. A subquery's
values are only known when it runs.

## What is already built (do not redesign these)

- **Runtime floor.** `quereus-in-subquery-set-probe` materializes an uncorrelated IN
  subquery once into a lookup set and probes it per outer row.
- **Planner shape.** `feat-uncorrelated-in-semijoin` (prereq) turns WHERE-position
  uncorrelated `IN` into a semi join, so the key set is a normal relational input.
- **Literal key-set seeks in the store.** `StoreTable.scanMultiSeek` already takes N key
  tuples, dedupes and sorts them into byte-ordered windows, and scans them lazily through
  the ordinary index path — so read-your-own-writes, `limit` early exit, and the isolation
  layer's ordered overlay merge all keep working. `StoreModule.tryIndexAccessPlan`
  advertises this as `IndexPlanKind: 'multiSeek'` (`plan=5`). It declines above 1000 keys
  and on semantically-ordered columns.

**The runtime that this feature needs already exists.** What is missing is a way to hand it
a set whose size and contents are not known until execution.

## Architecture decision (settled — do not re-litigate)

Two ways to turn a subquery-derived key set into index lookups:

**(A) Runtime-valued key-set constraint — chosen.** Extend the access-plan protocol so a
module can accept an `IN` constraint whose values arrive at execution time, and give the
runtime a channel to deliver them. The module receives all K keys in one call and can batch,
sort, and dedupe them — which is exactly what `scanMultiSeek` does, and what preserves
index-order emission for the isolation layer.

**(B) Index-nested-loop join — not this ticket.** Drive from the small side and seek the
large side once per driver row. This is a general join capability and is already specified
as `backlog/feat-index-nested-loop-join`, which explicitly says the `IN`-subquery and DML
case is left to this line of work. Doing (B) here would duplicate that ticket and would give
the store K separate `query()` calls instead of one batched, order-preserving scan.

## Sketch of (A)

Three surfaces change. The plan pass should confirm and refine this shape, not invent a new
one.

**Plan-time contract (`vtab/best-access-plan.ts`).** A `PredicateConstraint` with `op: 'IN'`
today carries its values in `value` as an array. Add a form that carries **no** values and
instead an estimated cardinality, so a module can cost the choice:

```ts
// on PredicateConstraint (vtab-level)
/** IN whose members are produced at execution time; `value` is absent. */
readonly runtimeSet?: { readonly estimatedCount?: number };
```

A module that cannot handle it simply leaves `handledFilters[i] = false` and the engine
keeps the semi join. The store's existing 1000-key cap becomes a *runtime* decision (it
cannot count keys at plan time), so the contract must say what a module does when the
delivered set exceeds what it is willing to seek: fall back to a scan inside `query()`, or
have the engine cap and re-drive. **Pick one and write it into `docs/module-authoring.md`.**

**Runtime channel (`vtab/filter-info.ts`).** `FilterInfo.args` is a flat `SqlValue[]` whose
length is fixed at plan time by the `constraints`/`argvIndex` mapping, so the key set cannot
travel there. Add a separate field, e.g.:

```ts
/** Execution-time key tuples for a runtime `IN`-set plan. Column order matches seekColumnIndexes. */
readonly keySet?: { readonly columnIndexes: readonly number[]; readonly tuples: readonly (readonly SqlValue[])[] };
```

**Access-path identity (`vtab/index-descriptor.ts`, `vtab/idx-str.ts`).** `plan=5`
(`multiSeek`) encodes its tuple count and width in the `idxStr` at plan time. A runtime set
needs either a new `IndexPlanKind` (`'runtimeMultiSeek'`) or an explicit "count is dynamic"
marker on the existing one. Consumers that parse the access path — notably the isolation
layer's ordered merge — must be able to tell the two apart.

**Who materializes the set, and where it attaches.** The likely shape is a physical node
that owns both the key-set subplan and the target access:

```
SetSeekSemiJoin
├─ keySource: the (deduped, single-column) inner relation
└─ target:    TableAccess(big) whose access plan carries the runtime IN-set constraint
```

Its emitter drains `keySource` once, dedupes, fills `FilterInfo.keySet`, opens the target
once, and streams the matching rows. Because the constraint is an equality on the seek
column, each target row matches at most one distinct key, so the output is exactly semi-join
semantics with no dedup pass needed.

## What the plan pass must resolve

- **Choosing seeks vs scan.** K seeks beat an N-row scan only for small K / large N, and K
  is unknown at plan time. Decide between: a shape-based heuristic (only when the target is
  large and the key source is provably small); a plan-time estimate from
  `estimatedRows` (weak — see `backlog/debt-access-node-catalog-cardinality`); or a runtime
  decision after the set is built. The ticket's origin note calls this a natural consumer of
  runtime cardinality feedback (`backlog/known/2-adaptive-query-optimization`, Tier 1/2) with
  scan + probe as the safe default. **A runtime choice made after the set is materialized is
  the strongest option and should be evaluated first** — the set is already in hand and its
  exact size is known.
- **Where the rule fires.** From the semi join produced by the prereq ticket, or from the
  `InNode` directly (which would also cover shapes the semi-join rewrite declines)?
- **Collation and semantic ordering.** The seek column must be seekable under the join key's
  *resolved* comparison collation, not its declared one — the same gate `tryIndexAccessPlan`
  already applies for literal `IN`. Semantic-ordering columns (`TIMESPAN`, `JSON`) must
  decline, as they do today.
- **Isolation layer.** `IsolatedTable.buildConstraintMatcher` interprets a `multiSeek` plan
  by decomposing it into per-column `IN` sets. Confirm a runtime set decomposes identically,
  and that emission order stays index-key order (the overlay merge depends on it).
  `backlog/bug-isolation-multiseek-merge-order` is open in this area.
- **Memory module.** Does the in-memory vtab implement the runtime set too, or decline and
  keep the semi join? Declining is acceptable but means no test coverage outside the store
  package — decide deliberately.
- **DML.** `DELETE` / `UPDATE` are the headline case. Confirm the mutation machinery is happy
  with the new node as its source, and that a self-referencing statement
  (`delete from a where x in (select y from a)`) keeps the materialize-once snapshot
  semantics that the set-probe path established.

## Decomposition hint

This will not fit one implement ticket. Expect roughly: (1) protocol + engine node +
emitter, with the memory module either implementing or explicitly declining; (2) store module
plan side + reuse of `scanMultiSeek`; (3) isolation-layer verification. Chain them with
`prereq:`.

## TODO

- [ ] Confirm or revise the three-surface sketch against the current code.
- [ ] Resolve every open question in "What the plan pass must resolve".
- [ ] Emit `implement/` tickets sized to one agent run each, chained by `prereq:`.
