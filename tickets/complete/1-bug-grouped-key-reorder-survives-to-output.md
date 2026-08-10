---
description: A grouped query that named two or more grouping columns could hand its columns back in the wrong order; the optimizer now puts them back in the order the query asked for.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts  # the fix — order-restoring cap, extracted into `restoreOutputOrder`
  - packages/quereus/src/planner/building/select-aggregates.ts                       # doc-comment forward-reference dropped
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts                      # column-name coverage + two-Project stack assertion
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic            # value coverage, `insert … select`, both `union` arm positions
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts           # rule-level cap present/absent cases
  - packages/quereus/test/plan/aggregates/group-by-fd-order-cap.sql                  # golden for the capped plan shape
  - docs/materialized-views.md                                                       # § forgo guard bullet + backing-shape NOTE
  - docs/optimizer-rules.md                                                          # rule entry mentions the cap
  - docs/optimizer-rule-families.md                                                  # stale "base reorders" claim corrected
difficulty: medium
---

# Complete: select-list column order restored after GROUP BY FD simplification

## What was wrong

`select g, v, count(*) as c from pk group by g, v` returned its columns as
`v, g, c`. `docs/sql-select.md` § 3.3 promises select-list order.

`ruleGroupByFdSimplification` drops a grouping column that the surviving
grouping columns functionally determine (`v` is the primary key, so it
determines `g`) and re-emits the dropped one as a picker `min(g)` aggregate. An
aggregate node's output layout is fixed — grouping keys first, then aggregate
results — so a dropped key necessarily leaves its key slot and lands in the
aggregate block, behind the surviving keys. Attribute ids survive the move, so
everything that binds by id was fine; the consumers that bind by **position**
(the statement result when the aggregate is the query root, `insert … select`,
a `union` arm) got the shifted order.

## What shipped

One behavioural site: the rule's return. When (and only when) the new layout
permutes the output attribute order, the new aggregate is wrapped in a
`ProjectNode` that re-emits the same attribute ids in their original order.
Order-preserving drops (the dropped keys were already a suffix of the grouping
list) return the bare aggregate exactly as before, so the common
`group by <pk>, <other>` shape gains nothing and costs nothing.

`preserveInputColumns` is `true`. With `predefinedAttributes` supplied the flag
cannot change this node's attributes either way, so it is inert today; `true`
was chosen because every projection in the cap is a bare column reference
republishing its source attribute id, and because it stays correct if a later
rebuild ever drops `predefinedAttributes`. `ColumnReferenceNode.columnIndex` is
advisory (`runtime/emit/column-reference.ts` resolves by attribute id through
the row descriptor) but is set to the attribute's index in the new aggregate.

The rule's header comment and the `aggregateOutputIsSelectList` doc-comment in
`select-aggregates.ts` were updated to state the new contract.

## Behaviour, before → after

On memory tables `pk (v integer primary key, g text)`, `nk (a text, b text)`,
`nj (a text, c text)`:

| query | now returns |
|---|---|
| `select g, v, count(*) as c from pk group by g, v` | `g, v, c` |
| `select a, b, count(*) as c from nk where a = b group by a, b` | `a, b, c` |
| `select nk.a, nk.b, nj.a, nj.c, count(*) as c from nk join nj on nk.a = nj.a group by nk.a, nk.b, nj.a, nj.c` | `a, b, a:1, c, c:1` |

The three FD drivers are distinct and all three are covered: a primary key, a
`where a = b` equivalence class, and a join equality. An alias in the select
list (`select g as gg, …`) always hid the bug, because the alias forces a
projection above the aggregate.

## Tests

- `test/plan/grouped-projection-shape.spec.ts` — `getColumnNames()` for all
  three repro queries; the pre-existing *"projects a grouped select list even
  when it needs no expression rewriting"* case now pins the two-Project stack
  (cap on the aggregate, select-list projection above).
- `test/optimizer/rule-groupby-fd-simplification.spec.ts` — cap Project present
  when the drop permutes, absent when the dropped key was already a suffix.
- `test/logic/07.3.2-grouped-select-list-shape.sqllogic` — values for the three
  repro shapes, the `insert … select` positional case, and (added in review)
  a grouped query as a `union` arm in **both** positions.
- `test/plan/aggregates/group-by-fd-order-cap.{sql,plan.json}` — golden for the
  capped plan shape (added in review).

Every one of these was verified to bite: with the cap temporarily short-circuited
and everything rebuilt, all four files fail (column names `['v','g','c']` vs
`['g','v','c']`; the join case collapsing to three columns; the insert-select
type error; the union arms pairing `'z'` against `v` and swapping values under
correct names; the golden mismatching). The short-circuit was removed before the
final run.

## Validation

From the repo root, after the review edits: `yarn build` clean, `yarn lint`
clean, `yarn test` **0 failing** (8660 in `packages/quereus` + 2865 across the
other workspaces). `yarn docs:check` reports the two known ratchet overages
(`docs/schema.md`, `docs/sync.md`) already tracked as
`debt-docs-size-ratchet-red-again` — not re-reported, untouched here.

## Review findings

### Checked and clean

- **The cap's construction.** Every id in `aggAttrs` is present in `newAttrs`
  (it is a permutation), so the `newIndexById.get(...)!` assertion cannot throw.
  Attribute ids, types, and names all round-trip; the cap's `RelationType`
  column names come from `alias: attr.name` with `ProjectNode`'s duplicate-name
  suffixing, which is exactly what a builder projection over the same aggregate
  would produce — verified against unaliased aggregates (`count(*)`,
  `sum(v)`), a dropped column whose name collides with an aggregate's
  (`select g, v, min(g) …`), and the duplicate-name join case.
- **`preserveInputColumns: true` is genuinely inert here.** `ProjectNode`'s
  attribute cache returns `predefinedAttributes` before consulting the flag, and
  no emitter reads it — grepped every consumer. The implementer's reasoning
  holds; the comment was tightened to say "inert today, correct tomorrow"
  rather than appealing to what the builder does.
- **Rule ordering.** `materialized-view-rewrite-aggregate` is registered well
  before `groupby-fd-simplification`, so the MV matcher still sees the pristine
  aggregate and the cap cannot block a match. `projection-pruning` fires on
  Project-over-Project and can only shrink the cap, never mis-map it.
- **No rule re-fire loop.** The kept grouping columns are already a minimal
  cover, so the rule returns `null` on the aggregate it just produced.
- **Physical property propagation.** The cap is a pure permutation, so keys,
  FDs, equivalence classes, ordering, and `monotonicOn` all project through
  `ProjectNode.computePhysical` intact. Confirmed no ordering regression: an
  `order by <group key>` over a grouped query keeps its `Sort` node with the cap
  *and* without it, and with no FD drop at all — the Sort is not eliminated on
  any of the three, so the cap changes nothing there.
- **`collectProducingExprs` shadowing.** The cap contributes self-referential
  `attrId → ColumnReference(attrId)` entries, but so does every builder
  select-list projection over an aggregate today, and
  `resolveTransitiveSourceCol` carries a `seen` guard. No new hazard.
- **Positional and structural consumers, exercised directly** (not just via the
  suite): `union all` with the grouped arm first *and* second, `insert … select`,
  subquery-in-`from`, CTE, `distinct`, `limit`, `order by` name and ordinal,
  `having`, a 3-key mid-list drop, an expression group key alongside a dropped
  bare key, `exists` over a grouped subquery, and materialized-view create /
  read / post-insert maintenance over a permuting body. All correct.

### Fixed in this pass (minor)

- **`docs/optimizer-rule-families.md` § Aggregate-rollup arm was left stale.**
  It still claimed the `group-key-pinned` guard exists because the base "would
  diverge from `rule-groupby-fd-simplification`'s column reorder" — the reorder
  the change removed. Rewritten to say the divergence is gone and point at
  `mv-group-key-pinned-guard-obsolete`. (The implement pass updated the same
  claim in `docs/materialized-views.md` but missed this second site.)
- **`docs/optimizer-rules.md` rule entry described only the attribute-id
  preservation**, which now reads as the whole contract. Added the cap and the
  positional consumers it protects.
- **`union` arm coverage — the gap the handoff flagged — closed**, both arm
  positions, in the `.sqllogic` file. Both bite hard with the cap disabled.
- **Golden plan for the capped shape added** (`aggregates/group-by-fd-order-cap`),
  the other flagged gap. Regenerating goldens rewrote four unrelated snapshots
  with LF endings only — `git diff` on them is empty, so no content changed.
- **The rule function had grown to ~180 lines with the cap inlined as a trailing
  section.** Extracted into `restoreOutputOrder(rewritten, originalAttrs,
  newAttrs, scope)` — a named function stating the invariant, per AGENTS.md's
  "decomposed sub-funcs > grouped sections". Behaviour identical.

### Filed as tickets

None. Nothing found rose to a separate ticket: the two doc-staleness items and
the two coverage gaps were all small enough to close inline, and no defect
survived the probing above.

### Tripwires (parked, deliberately not ticketed)

- **Extra row copy from the stacked Project-over-Project.** Parked by the
  implementer as a `NOTE:` at the cap site in
  `rule-groupby-fd-simplification.ts`. Confirmed accurate and left in place: it
  is one copy on a plan that only exists when the rule fires *and* permutes, and
  the collapse it describes needs no index rebinding.
- **Materialized-view backing column order changed for permuting bodies.**
  `deriveBackingShape` reads the backing column list positionally off the
  *optimized* body plan, so a grouped MV body whose FD simplification permutes
  now derives a backing in select-list order where it used to derive the shifted
  one. The new order is the correct one, and only a backing persisted by a
  durable store module *before* this fix could hold the old one. Parked as a
  `NOTE:` bullet in `docs/materialized-views.md` § Shape-aware, stating plainly
  that which `classifyBackingReshape` arm a pure permutation lands on has not
  been analyzed — measuring it needs a pre-fix persisted backing, which is out
  of scope here and only matters under the project's (currently deferred)
  backwards-compatibility posture.

### Explicitly not re-audited

The handoff noted that downstream pattern-matchers were validated by the suite
rather than read. This pass read the ones that could plausibly care — the MV
aggregate fragment matcher, `collectProducingExprs`, `projection-pruning`, and
the rule registration order — and exercised delta-aggregate maintenance through
a live MV over a permuting body. Matchers with neither a code path reachable
from a permuting aggregate nor a test were not enumerated one by one.

## Follow-up on the board

`mv-group-key-pinned-guard-obsolete` (in `tickets/implement/`, with this ticket
as its prereq) retires the `group-key-pinned` forgo now that the base and the
view path agree on column order. The guard, its failure reason, and its test are
deliberately untouched here — retiring them needs base-vs-view positional
agreement evidence, which is that ticket's job.

`docs/sql-select.md` § 3.3 already states the select-list-order guarantee
unconditionally; confirmed, no wording change needed.
