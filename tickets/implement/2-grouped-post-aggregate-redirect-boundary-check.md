---
description: Three separate parts of the query planner each have to remember, on their own, to translate a summary query's grouping columns into the summarised row's columns — and one of them forgetting has now caused two user-visible bugs. Route them all through one place and add a build-time check that catches the next omission.
prereq: bug-order-by-grouping-key-spelling-breaks-window-query
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # redirectToGroupKeys, assertGroupedWindowCoverage, buildHavingFilter, GroupedRedirectContext
  - packages/quereus/src/planner/building/select.ts               # buildSelectStmt — where the context is built and where the plan is finished
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowPhase — today's only caller that both redirects AND checks
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy — the third caller, wired by the prereq ticket
  - docs/runtime.md                                               # § Corollary: a published source row reaches only the adjacent consumer
  - packages/quereus/test/logic/07.5-window.sqllogic              # coverage lives beside the existing grouped-window block
difficulty: hard
---

# Make the grouped post-aggregate seam enforce itself

## The problem this ticket removes

A GROUPED query builds several expressions that run **above** the AggregateNode: the
rebuilt SELECT list, the window phase's specifications and function arguments, the HAVING
predicate, and the ORDER BY sort keys. All of them are built against a scope that falls
through to the **pre-aggregate** select scope, so a perfectly legal spelling of a grouping
key — `wg.a` against `group by a`, or `a || '!'` against `group by a || '!'` — binds to a
base-table attribute that the aggregate's output row does not carry.

`redirectToGroupKeys` (`select-aggregates.ts`) is the rewrite that fixes that, and each
builder has to remember to call it. Two have already shipped as bugs from a builder that
did not:

- `complete/3-bug-qualified-group-key-in-select-list-breaks-window-query` — the SELECT list
- `implement/1-bug-order-by-grouping-key-spelling-breaks-window-query` — ORDER BY (this
  ticket's prereq)

Both surfaced as the same internal runtime error naming a column the user did read:

```
No row context found for column a. The column reference must be evaluated within the
context of its source relation.
```

Two more sites are un-redirected right now and correct only by accident of where their
node sits in the plan — see *Sites* below. `docs/runtime.md` § *Corollary: a published
source row reaches only the adjacent consumer* already states the rule being violated:
**plan-time binding must never depend on the representative source row.** Nothing enforces
it.

## Sites

| Site | Redirects today? | Why it currently works |
| --- | --- | --- |
| SELECT-list rebuild (`buildFinalAggregateProjections`) | yes | — |
| Window specs / args (`buildWindowPhase`) | yes | — |
| ORDER BY (`applyOrderBy`) | after the prereq ticket | — |
| HAVING (`buildHavingFilter`) | **no** | its FilterNode sits directly on the aggregate's yield, where the representative source row is still live |
| `preWindowSort` keys (`select.ts` ~line 331) | **no** | that SortNode sits *below* the WindowNode, likewise on the live yield |
| Early ORDER BY placement (`select.ts` ~line 241, `orderByAppliedEarly`) | **no** | only taken for aggregate queries with no window function and no GROUP BY keys to redirect onto |

Verified at HEAD: `select a, row_number() over (order by a) rn from wg group by a having
wg.a = 'x'` and `… having upper(wg.a) = 'X'` both return correct rows, with `wg.a` bound
to the base attribute.

## Arm 1 — one choke point

Every post-aggregate expression of a grouped query should reach the redirect through one
call, rather than each builder remembering to ask. Concretely: a single exported helper on
`GroupedRedirectContext` that takes a built expression and returns the redirected one, used
by all six sites in the table. HAVING is the one that changes behaviour internally — once
its grouping-key references land on aggregate **output** attributes, its own
`findUngroupedColumnRef` check must keep accepting them (it already admits output attribute
ids via `buildGroupByCoverage`'s `groupedOutputAttributes`) and must keep rejecting a
genuinely ungrouped column with its existing "HAVING references non-grouped column"
message.

The early-ORDER-BY placement needs `groupedRedirectContext` built before it runs; today it
is built ~20 lines later. Moving the construction up is mechanical — it depends only on the
AggregateNode and its GROUP BY expressions, both of which exist by then.

`select-aggregates.ts` is 1,486 lines and already listed in
`backlog/debt-oversized-source-files` with this exact redirect half called out as having
three prospective callers. Splitting the file is that ticket's job, not this one's; do not
grow it further than the choke point requires.

## Arm 2 — a boundary check that makes the class fail loudly at plan time

Once a grouped query's plan is built, no node **above** the AggregateNode should reference
an aggregate-input attribute id that is absent from the aggregate's output.
`assertGroupedWindowCoverage` already answers exactly this question off
`GroupedRedirectContext` — it descends into relational children, and it flags only
attribute ids belonging to *this* query's pre-grouping columns, leaving a subquery's own
columns and correlated references to an enclosing query alone.

Applied once to the finished plan — walking from the query root and not descending into the
AggregateNode itself — it would have caught the ORDER BY case, the SELECT-list case, and
any future post-aggregate operator, at build time with the user-facing GROUP BY message
instead of an internal runtime error.

### The one behaviour change, and its measured size

An ORDER BY naming a genuinely **ungrouped** column is accepted today:

```sql
select a, row_number() over (order by a) rn from wg group by a order by b;  -- returns rows
select a from wg group by a order by b;                                     -- returns rows
```

Both sort by an arbitrary representative row's `b`. The check rejects them. That is a
user-visible strictness change and the decision this ticket carries.

Measured, not assumed. An instrumented build (the prereq's redirect applied, then every
sort key that still referenced a pre-grouping attribute logged) over the whole engine
suite — `node test-runner.mjs` in `packages/quereus`, 9541 passing — produced **18** such
keys, **all** from `test/fuzz.spec.ts` generated queries of the shape
`order by cast(<ungrouped column> like '_ello' as real)`. Zero from `test/logic`, zero from
any hand-written spec. The same instrumentation on the `preWindowSort` branch produced
**zero**. `fuzz.spec.ts` tolerates any `QuereusError` (`execAndDrain` / `evalAndDrain`,
~lines 554–576), so a plan-time rejection does not fail it.

**Recommendation: take the strict check.** It makes ORDER BY consistent with the SELECT
list and HAVING, which already reject ungrouped columns; the queries it starts rejecting
return arbitrary results today, which is a wrong-result bug in its own right; and no test
in the repo asserts the current permissive behaviour.

**The alternative, if a reviewer wants zero behaviour change:** fire only for references
that sit above a *buffering* operator (today, `WindowNode`), which is where the
representative row genuinely dies. That still catches both shipped bugs and leaves
`order by b` alone — but "which operators break the context" has no representation in the
plan today, so it has to be invented, and the resulting invariant is weaker and harder to
state than the one `docs/runtime.md` already claims. Pick one deliberately; do not ship
both.

Whichever is chosen, `docs/runtime.md` § *Corollary* must be updated to say what is now
enforced, where, and what the escape hatch is.

## TODO

Phase 1 — choke point

- Move `groupedRedirectContext` construction in `buildSelectStmt` above the early
  ORDER BY placement so every post-aggregate site can reach it.
- Add the single redirect entry point in `select-aggregates.ts` and route all six sites in
  the *Sites* table through it, replacing the ad-hoc `redirect(...)` closure in
  `buildWindowPhase` and the direct call added by the prereq ticket.
- Redirect HAVING's predicate; confirm its ungrouped-column rejection still fires with its
  existing message, and that `having wg.a = 'x'` / `having upper(wg.a) = 'X'` still return
  correct rows both windowed and not.
- Redirect the `preWindowSort` keys.

Phase 2 — boundary check

- Add the finished-plan assertion for grouped queries, reusing
  `assertGroupedWindowCoverage`'s walk with a stop condition at the AggregateNode.
- Decide strict vs buffering-only (recommendation above); record the decision and its
  revisit condition as a `NOTE:` at the check's site.
- If strict: the error must carry the user-facing "must appear in the GROUP BY clause or be
  used in an aggregate function" wording and the offending expression's source location.

Phase 3 — coverage and docs

- `test/logic/07.5-window.sqllogic`, beside the existing grouped-window block: pin HAVING
  and `preWindowSort` spellings windowed and unwindowed; pin the ungrouped `order by b`
  outcome (rows or error, per the decision), replacing the pin the prereq ticket leaves
  behind; pin a post-aggregate correlated subquery reading an ungrouped column, which the
  check should now reject at plan time instead of dying at run time (see the NOTE on
  `findUngroupedColumnRef` in `select-aggregates.ts`).
- Update `docs/runtime.md` § *Corollary: a published source row reaches only the adjacent
  consumer* with what is enforced and where.
- Run `yarn test` from `packages/quereus` (~3 min) and `yarn lint` in that package.
