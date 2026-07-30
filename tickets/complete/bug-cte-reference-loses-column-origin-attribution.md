---
description: A query that reads from a `with` clause now guesses how many rows a filter keeps using the real collected statistics, matching what the same query written as a subquery already did. Engine change, regression tests, and review pass are all done.
files:
  - packages/quereus/src/planner/util/column-origins.ts                      # the walk (fix-stage commit)
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # the consumer (fix-stage commit)
  - packages/quereus/test/optimizer/column-origins.spec.ts                   # +5 cases
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # +12 cases
  - docs/optimizer.md                                                        # updated (fix-stage commit)
difficulty: medium
---

# CTE columns keep their base-table attribution

## What the problem was

When the planner estimates how many rows a `where` clause keeps, it looks up the
filtered column's collected statistics. To do that it has to know which real table
column an output column came from — `collectColumnOrigins`
(`planner/util/column-origins.ts`) answers that by walking down the plan.

`CTEReferenceNode` re-publishes its body's columns under brand-new internal column
ids, so the walk lost the trail at every `with` clause. The same filter written as a
subquery or a view kept its estimate; written as a `with`, it fell back to a flat
0.1 guess. Query results were always correct — only the row estimate, and therefore
possibly the chosen plan, differed.

## What landed

**Engine.** `ColumnOrigin.ref` (a `TableReferenceNode`) was doing two jobs: standing
for *which relation* an attribute came from, and supplying the `TableSchema` to look
statistics up in. Those are now split — `ColumnOrigin.relation` is an opaque
`RelationInstance` token compared by reference and never dereferenced,
`ColumnOrigin.table` keeps the schema role.

The walk does not descend through a `CTEReferenceNode`. It maps the body's origins
positionally onto the reference's own attribute ids, and mints a fresh
`RelationInstance` per (reference, underlying relation) pair. That last part is the
crux: two references to one `with` clause share a single body subtree, so re-using the
body's instances would collapse both arms of a CTE self-join into one relation and
`rule-filter-selectivity` would read `a.qty > b.qty` as "a column compared to a
constant". Body origin maps are memoized per `collectColumnOrigins` call.

`rule-filter-selectivity.ts` moved its identity comparisons from `origin.ref` to
`origin.relation`; `conjunctRelations` returns `Map<RelationInstance, TableSchema>`
instead of `Set<TableReferenceNode>`.

**Tests.** 17 cases across the two optimizer spec files — 13 from the implement stage,
4 added during review.

`test/optimizer/column-origins.spec.ts`, at the level of the origin map itself so a
failure points at the walk rather than at the estimate:

- a CTE reference contributes one relation instance and one entry per republished base
  column, keyed by the reference's own attribute ids
- two references to one CTE contribute two distinct relation instances sharing one
  `TableSchema`
- three references contribute three distinct instances *(added in review)*
- a column computed inside the CTE body has no entry
- a recursive CTE reference contributes nothing

`test/optimizer/filter-selectivity.spec.ts`, end-to-end stamped selectivity:

- a filter over a plain CTE column stamps `1/ndv(o.qty)` and equals what the same query
  spelled as a subquery stamps
- five CTE spellings that only vary the column list all stamp `1/ndv(o.qty)`
- a CTE body reading a view stamps `1/ndv(o.qty)` *(added in review)*
- a `with` clause attached to an `insert … select` stamps `1/ndv(o.qty)` *(added in review)*
- a column computed inside the CTE body stamps the same value under two alias spellings,
  and not `1/ndv(o.qty)`
- CTE self-join `a.qty = b.rid` stamps `1/max(ndv(qty), ndv(rid))`, explicitly not
  `1/ndv(qty)`; and `a.cat = 'a' and a.qty > b.qty` stamps the combined pair
- a CTE body that is itself a join keeps its two sides distinct, and a cross-relation
  equality within one reference estimates from `joinSelectivity`
- a CTE joined to a real table combines both sides
- a CTE reference inside a correlated `exists` subquery stamps `1/ndv(o.cat)` *(added in review)*
- a CTE body containing `union all`, and one containing `group by`, leave the filter
  unstamped

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsc -p
  tsconfig.test.json --noEmit`).
- `yarn test` (all workspaces, repo root) — green. Quereus core 8146 passing, 13
  pending; no failures in any workspace.
- The two optimizer spec files alone: 81 passing.

Negative controls were run by the implement stage against a temporarily-broken engine
and reverted: removing the CTE branch from the walk failed 10 of its 13 cases; keeping
the positional remap but re-using the body's own relation instances failed 2.

## Review findings

**Read first, then the handoff.** The fix-stage diff (`4202705e`, engine + docs) and the
implement-stage diff (`7f6c5ed2`, tests) were both read before the handoff summary.

### Correctness of the engine change — nothing found

Each load-bearing assumption was traced to its source rather than taken from the
comment that asserts it:

- *Positional remap.* `CTEReferenceNode.buildAttributes` maps `CTENode.getAttributes()`
  one-for-one and `CTENode.buildAttributes` copies `id: attr.id` from its source, so
  index *i* names the same column on all three levels. `withChildren` on the reference
  preserves the old attribute list, so a rewritten body could in principle desynchronise
  the lists — checked the two rules that could change a relation's column count
  (`rule-projection-pruning`, `rule-cte-optimization`) and neither can alter a CTE body's
  output arity: pruning only fires on Project-over-Project and trims the *inner* one, and
  CTE optimization only inserts a `CacheNode`, which forwards ids. A shorter body list
  would in any case skip the column (`bodyAttrs[i]` undefined) rather than mis-attribute it.
- *Unbounded recursion.* `bodyOriginsOf` populates its cache only after `collect` returns,
  so a cycle would recurse forever. A CTE can only reference itself when recursive, and a
  recursive body is a `RecursiveCTENode`, which `isRowMerging` rejects at the reference
  before the body is ever walked. The working-table node inside a recursive body is
  `InternalRecursiveCTERefNode`, a zero-ary node the walk simply bottoms out on.
- *Per-reference instance mint.* Correct, and now pinned at three references as well as two.
- *Aggregate bodies.* `collect` checks `isRowMerging` but not `isRowRegrouping`, so a
  `group by` body's forwarded group-key ids do get origins. That matches the existing,
  deliberately-documented behaviour for an aggregate between a Filter and a join
  (`rule-filter-selectivity.ts`, "NOTE: an `aggregate` between the Filter and the join…")
  and is identical to what the equivalent inline subquery does. Not a divergence.

### Test coverage — gaps closed

The handoff listed four shapes as "simply unexercised": a CTE reference inside a
correlated subquery, a `with` clause on `insert`/`update`/`delete`, a CTE body reading a
view, and a CTE referenced 3+ times. All four were exercised by hand first and all four
behave correctly, so all four became tests in this pass (see the list above) rather than
tickets. The `update`/`delete` spellings were checked by hand too and stamp correctly;
only the `insert` form became a test, since all three plan the same `CTEReferenceNode`
and the `insert` form yields the least ambiguous "first Filter in the plan".

Two handoff caveats were reviewed and accepted as-is:

- *`still estimates a single-relation conjunct over one arm of a CTE self-join` is not a
  discriminator for the per-reference mint.* Correct, and its comment already says the
  binding case is the sibling test. Left alone; adding an assertion for the coincidence
  would pin a provider fallback, not the fix.
- *No `.sqllogic` result-correctness case.* The change moves estimates only. Result
  correctness across CTE join shapes was spot-checked by direct execution during this
  review — which is how the runtime bug below was found — and existing logic tests cover
  CTE results. No new logic case added.

### Major — one new ticket, pre-existing and outside this diff

`tickets/fix/bug-cte-reference-as-second-join-source-fails-at-runtime` —
`with c as (select cat, qty, rid from o) select count(*) from r join c on c.rid = r.id`
throws `QuereusError: No row context found for column rid`. The same join with the
sources swapped works, as does the identical inline subquery and the identical plain
table. Confirmed **not** caused by this ticket: the failure is byte-identical with
`column-origins.ts` and `rule-filter-selectivity.ts` reverted to their `dbeafd08`
contents (the engine files were restored afterwards and `git diff -- packages/quereus/src`
is empty). The plan holds a `where` predicate bound to attribute ids the
`CTEReferenceNode` beneath it no longer publishes, which also explains a milder second
symptom: in that join order a `where` conjunct over the CTE silently gets no estimate,
where the working order estimates it. Both symptoms and the narrowing table are in the
ticket.

### Tripwires — none new

The handoff's "memoization is not pinned" concern is a performance property with no
correctness consequence, and its scope limit (the cache lives inside one
`collectColumnOrigins` call, so N filters over one CTE re-walk the body N times) is
already recorded in the `NOTE:` at `rule-filter-selectivity.ts` (~line 100) covering the
same O(N·subtree) cost. Nothing to add; a new comment would duplicate that one.

### Docs — verified, no change needed

`docs/optimizer.md` was re-read in full around the statistics section: the old "a filter
over a `with` clause currently estimates nothing" claim is gone and the replacement text
matches the code, including the per-reference mint and the recursive/`union all`/`group by`
opacity. The three source doc-comments (`column-origins.ts` header,
`rule-filter-selectivity.ts` header, `addCTEColumns`) agree with each other and with the
implementation. `row-population.ts` needed no change — a CTE reference is handled by an
`instanceof` branch in the walk, not by the nodeType predicate. No other doc mentions
column-origin attribution.

### Hygiene — acceptable

`column-origins.ts` is 175 lines with four short single-purpose functions;
`rule-filter-selectivity.ts` is 369 lines and decomposed per concern. Comments explain
*why* rather than restating code. `RelationInstance = object` is weak typing in the
abstract — any object satisfies it — but the token is documented as never dereferenced
and a branded type would exclude `TableReferenceNode`, which is deliberately its own
instance. Left as is. The handoff flagged SQL casing: `filter-selectivity.spec.ts` is
uppercase throughout (~60 pre-existing statements) and `column-origins.spec.ts` is
lowercase; new cases match their file. AGENTS.md prefers lowercase, but converting one
file wholesale is unrelated churn inside a bug-fix review — not done, and not filed,
since it is a one-command cleanup whenever that file is next edited substantially.
