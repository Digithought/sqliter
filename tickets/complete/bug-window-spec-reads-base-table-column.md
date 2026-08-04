---
description: Sorting or partitioning a window function by a grouping key written a different way than the GROUP BY wrote it — table-qualified, alias-qualified, differently-cased, or as a whole expression — used to crash with an internal error; it now returns results.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # GroupKeyIndex, indexGroupKeys, GroupedWindowContext, redirectToGroupKeys
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowPhase — applies the redirect, then the strict assert
  - packages/quereus/src/planner/building/select.ts               # ~line 234-250, builds the context handed to the window phase
  - packages/quereus/test/logic/07.5-window.sqllogic              # grouped + window section, ~line 855 and ~line 915-985
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # ~line 61, select-list side of the key-spelling rule
  - docs/sql-select.md                                            # group by behavior list, ~line 609 and ~line 614
  - docs/window-functions.md                                      # "Grouped queries" section, ~line 52
repro: verified
---

# Window specification in a grouped query can name its grouping key by any spelling

## What shipped

In a grouped query the plan is `Aggregate → [HAVING Filter] → Window → Project`.
The `WindowNode` evaluates its `partition by` / `order by` / argument expressions over
the aggregate's own output row, which carries only the grouping keys and the aggregate
results. Those expressions are built against a scope that falls through to the
pre-aggregate select scope, so several legal spellings of a grouping key bound to a
**base-table** column the aggregate row never had, and the query died at runtime with
`No row context found for column a`.

Two arms in the window phase, both from the implement stage:

**Arm 1 — redirect.** `redirectToGroupKeys` walks each built window-specification
expression and each window-function argument and rewrites every subtree that *is* a
grouping key into a `ColumnReferenceNode` on the AggregateNode's own output column for
that key. Two rules per node, in order: the subtree's identity fingerprint equals a
GROUP BY expression's (covers a non-bare key written out again, and nested occurrences,
because the walk recurses), or the node is a column reference on the *base* attribute id
of a bare-column grouping key (covers every qualifier spelling). Otherwise it recurses
into scalar children only.

**Arm 2 — strict guard.** After redirection nothing legitimate may still name a
base-table attribute, so the coverage `assertGroupByCoverage` checks in the window phase
is **AggregateNode output attribute ids only**.

The review stage added a third piece and split out a shared one:

**Identity fingerprints.** Group-key fingerprints now fold identifier case
(`expressionToIdentityString`, the same function the sibling
`bug-aggregate-match-ignores-string-literal-case` ticket introduced for aggregate
matching) while keeping quoted literals byte-exact. So `group by A || '!'` covers a
later `a || '!'` — in the window specification *and* in the select list — but
`a || 'X'` and `a || 'x'` remain different keys.

**One group-key index.** `GroupKeyIndex` / `indexGroupKeys` is the single place the two
"where does this grouping key live on the aggregate's output row" maps are built,
shared by the window phase's redirect and the select list's
`buildFinalAggregateProjections`.

## Review findings

### Read first, then the handoff

Read the implement diff (`git show 8f47d7f3`) and the current state of all three touched
source files before the handoff summary, then exercised ~30 query shapes by hand against
`Database.eval` (grouped + windowed with qualified / aliased / expression / cased /
nested / collate-wrapped / case-expression / frame-bound / distinct-argument /
multi-spec / HAVING / PK-table / subquery-source spellings, plus the negatives).

### Fixed in this pass

- **Group-key fingerprints were identifier-case-sensitive.** SQL identifiers are not.
  `select a || '!' as k, row_number() over (order by A || '!') … group by a || '!'` was
  rejected with `Column 'A' must appear in the GROUP BY clause`, and the *select-list*
  path had the same hole (`select A || '!' from wg group by a || '!'` — a pre-existing
  defect the new window map inherited, at the same mechanism). Swapped all six group-key
  fingerprint sites (build + lookup in `buildGroupByCoverage` / `findUngroupedColumnRef`,
  `indexGroupKeys`, `redirectToGroupKeys`, `buildFinalAggregateProjections`) from
  `expressionToString` to `expressionToIdentityString`. Literal case still separates
  keys, which is the behavior the sibling ticket established; both directions are now
  asserted in the corpus.
- **The two group-key maps were built twice, identically.** `buildGroupedWindowContext`
  duplicated the `groupByFingerprints` + `groupKeyByAttrId` pair that
  `buildFinalAggregateProjections` already built ~700 lines away. Extracted
  `GroupKeyIndex` + `indexGroupKeys`; both callers use it, and
  `GroupedWindowContext` carries one `groupKeys` field instead of two loose maps. This
  is also what made the case fix a single edit rather than six divergent ones.
- **`docs/window-functions.md` was stale.** Its "Grouped queries" section still described
  only the plan-time coverage check, with no mention of the redirect that is now the
  first of two passes. Rewritten to describe both passes and the subquery gap below.
  (`docs/sql-select.md` was updated by the implement stage; extended here with the
  case rule.)

### Filed as a new ticket

- **`fix/bug-window-spec-subquery-reads-base-table-column`** — a grouping key named
  inside a *subquery* in a window specification still dies with the exact internal error
  this ticket set out to remove:
  `select a, row_number() over (order by (select max(t.b) from wg t where t.a = wg.a)) from wg group by a`
  → `No row context found for column a`. Both the redirect and the coverage assert stop
  at a relational child, so a **correlated** reference out of that subquery is neither
  rewritten nor rejected. Pre-existing (neither pass descended before the change either),
  reachable today, verified by running it. Not asserted in the corpus, deliberately —
  pinning an internal error as expected output would have to be undone by the fix; the
  ticket carries the repro. A `NOTE:` at `redirectToGroupKeys` points at the slug.

### Checked, nothing found

- **Arm 1's text-matching limitation is currently unreachable.** The handoff invited a
  failing case for "a subtree that reads like a grouping key but resolves to something
  else". Every shape that would exercise it needs a correlated reference inside a window
  specification, and all of those fail earlier today — downward into a subquery by the
  bug filed above, upward to an enclosing relation by the strict coverage set. So the
  mis-redirect is masked rather than fixed; the `NOTE:` stays.
- **Functional dependency.** `select id, a, row_number() over (order by wp.a) … group by id`
  on a primary-keyed table is rejected — but so is the plain `select id, a from wp group by id`,
  so the window path agrees with the select list rather than being stricter. Not a defect
  of this change; this engine does not do SQLite's bare-column relaxation anywhere.
- **Shapes that work and stay working:** multiple distinct window specifications over one
  grouped query, `HAVING` + window, an explicit frame with a qualified order key,
  `count(distinct wg.a) over ()`, a grouping key inside a `case` expression or a
  `collate` wrapper, `upper(wg.a)`, and the grouped+windowed query composed as a CTE
  source.

### Tests added

Eight assertions the implement stage left uncovered, all in the memory-backed corpus:

- `07.5-window.sqllogic` — identifier-case spelling of a non-bare key (positive);
  literal-case divergence (negative, still `must appear in the GROUP BY clause`);
  qualified key nested in a larger window expression; `collate` wrapper; the two
  negatives the handoff said were "verified by hand, not added to the corpus"
  (`order by wg.b`, and `b || '!'` against `group by a || '!'`); and the
  aggregates-without-GROUP-BY shape, pinning that it is rejected by the select-list
  mixing rule before the window phase is reached — the handoff's "no corpus assertion
  pins that message" gap.
- `07.3-group-by-extras.sqllogic` — the select-list side of the same case rule, positive
  and negative.

### Not done, with reason

- **No tripwire `NOTE:` for the redirect's stringify cost.** The implement handoff flagged
  it as unmeasured. It is one `expressionToIdentityString` per node of a window
  specification, on a walk that runs immediately before `assertGroupByCoverage` — which
  already stringified every node of the same tree before this ticket. Constant factor on
  a tree bounded by the size of an `over (…)` clause; there is no condition under which
  it becomes work, so it is not a tripwire.
- **`yarn test:store` not run.** Pure planner-building change with no vtab or storage
  surface; per AGENTS.md the store run is for store-specific diagnosis or release prep.

## Validation run

- `yarn build` — clean.
- `yarn lint` (repo root, fans out) — clean.
- `yarn test` (repo root, all workspaces) — clean: 8693 passing / 13 pending / 0 failing
  in `@quereus/quereus`, all other workspaces green.
- `packages/quereus/test/logic.spec.ts` alone — 348/348 corpus files passing.

`tickets/.pre-existing-error.md` was not written; nothing failed.

## Related tickets left open

- `fix/bug-window-spec-subquery-reads-base-table-column` (filed here).
- `backlog/bug-window-spec-cannot-name-group-key-by-select-alias` — naming a grouping key
  by its select-list alias inside `over (…)`; different root cause (name resolution in
  `createAggregateOutputScope`), fenced on both sides by corpus assertions.
