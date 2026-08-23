description: A HAVING clause inside a subquery can now compare against a column of the surrounding query, the same way WHERE always could. Previously the engine rejected it as an ungrouped column.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the whole change
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # cases, ~line 370-440
  - packages/quereus/test/logic/07.5-window.sqllogic              # lines 1372-1377 pin the rejection message (untouched, still green)
  - docs/sql-select.md                                            # §3.4 HAVING
----

# HAVING admits a correlated reference to an enclosing query

## What changed

A subquery may correlate to the query that contains it. Quereus supported that in
`where` but not in `having`: HAVING's coverage check flagged **any** column reference
that was not one of *this* query's grouping keys or aggregates, and a reference to an
enclosing query's column is neither, so it came out as "ungrouped".

HAVING's blunt allow-list was replaced with the predicate the engine already uses for
the same question elsewhere — `isPreGroupingReference`:

```ts
context.aggregateInputAttrIds.has(attrId) && !context.outputAttrIds.has(attrId)
```

True **only** for a column of *this* query's pre-grouping input that the grouped row no
longer carries. An enclosing query's column and a subquery's own column both fall
outside it by construction. It is the same predicate the finished-plan check
(`assertGroupedPlanCoverage` → `findUngroupedPostAggregateRef`) already used, so the two
checks now agree instead of HAVING carrying its own rule.

Three edits, all in `packages/quereus/src/planner/building/select-aggregates.ts`:

- **`findUngroupedPostAggregateRef` gained a `skipSubqueries` parameter.** With it set,
  the child loop `continue`s on a relational child instead of recursing. HAVING passes
  it. Reason: an ungrouped reference to *this* query's column buried inside a HAVING
  subquery has always been rejected by the finished-plan check with the general `Column
  '<name>' must appear in the GROUP BY clause or be used in an aggregate function`
  wording, and descending here would pre-empt that with HAVING's own message.
- **`buildHavingFilter` derives a `coverageContext`.** `buildAggregatePhase` builds
  `groupedRedirectContext` only when there are GROUP BY keys, so an aggregate query with
  no `group by` reached HAVING with `undefined` — and had the same bug. HAVING falls back
  to `buildGroupedRedirectContext([], aggregateAttributes, sourceInput)`. Used for the
  coverage check **only**; `redirectPostAggregate` still receives the real
  `groupedRedirectContext` so a non-grouped query keeps its pass-through branch.
- **`buildGroupByCoverage` lost its `groupedOutputAttributes` parameter.** It existed
  only for the HAVING call site; the remaining caller (`validateAggregateProjections`)
  always passed one argument.

Thrown `QuereusError` text and `loc` are byte-identical to before.

### Why dropping the grouping-key allow-list is safe

`redirectPostAggregate` has already run over `havingExpression` by the time the check
happens, so a grouping key reached by any spelling the redirect handles (bare, qualified,
nested, whole-subtree fingerprint) is already an AggregateNode-**output** reference, and
`isPreGroupingReference` returns false for those. The `07.5-window.sqllogic` pins around
line 1365 exercise exactly that path and stayed green untouched.

## Review findings

Read the implement diff (`2fc00c4d0`) before the handoff summary, then read the whole of
`select-aggregates.ts` around the change, both callers of the two touched helpers, the
gate at `select.ts:427`, and both `.sqllogic` files. Ran nine hand-built probe queries
against the `wg` fixture through a throwaway script (deleted afterwards) covering
correlation depth, enclosing-grouped-query interaction, EXISTS, function-nested outer
columns, and the ORDER BY / SELECT-list analogues.

### Correctness of the change itself — nothing found

The reasoning behind dropping the allow-list holds up, and the probes agree with it. Every
shape that should now work does, and every shape that should still be rejected still is,
with the same message. Verified beyond what the implementer tested:

- correlating **two** levels out of a HAVING works;
- an inner HAVING naming the enclosing query's **grouping key** works when the enclosing
  query is itself grouped;
- an inner HAVING naming an **ungrouped** column of an enclosing grouped query is still
  rejected — by the enclosing query's finished-plan check, under the general wording;
- a correlated HAVING inside `exists` works;
- an outer column nested inside a function call (`having t.a = lower(w.a)`) works.

The first three are now pinned (below). The last two were confirmed but not pinned — they
exercise no code path the pinned cases miss.

### Gaps the implementer flagged — closed

- **`skipSubqueries` was unpinned.** It is now: `07.3-group-by-extras.sqllogic` asserts
  that a grouped query whose HAVING reaches this query's ungrouped column through a
  subquery raises the *general* message, not HAVING's. Verified by mutation — flipping the
  expected message to HAVING's makes the test fail.
- **The negative message tail was unpinned.** One negative now asserts the full string
  including `HAVING may only reference GROUP BY columns or aggregate expressions`.
- **Correlation depth beyond one level was untested.** Pinned.
- **`test:store` was not run.** Deliberately still not run, and it is the right call: the
  change is build-time planning with no storage, vtab, or runtime surface — it throws or
  does not throw before any module is consulted. Nothing a store leg could disagree about.
- **Optimizer interaction was not probed.** Checked by reading rather than by a plan test:
  the check runs inside `buildHavingFilter` at build time, before any rule fires, so no
  rule can change its verdict. The end-to-end cases passing is the behavioural evidence.
  No plan-shape test added — asserting where the FilterNode lands after decorrelation
  would pin optimizer output this ticket does not own.

### Minor findings — fixed in this pass

- **Stale doc block on the `GroupByCoverage` interface.** It still described the removed
  `groupedOutputAttributes` parameter and claimed HAVING resolves through it. Rewritten to
  say what is now true: one flavour of attribute id, one caller, and a pointer to
  `isPreGroupingReference` for the clauses above the AggregateNode.
- **Boolean-blind call site.** `findUngroupedPostAggregateRef(expr, ctx, false, true)` put
  the recursion-internal accumulator (`insideSubquery`) ahead of the caller-facing knob.
  Parameters swapped so the internal accumulator is last; the HAVING call is now
  `(havingExpression, coverageContext, /* skipSubqueries */ true)`.
- **Three-line signature for a one-parameter function.** `buildGroupByCoverage` collapsed
  to one line after losing its second parameter.
- **Doc example did not match the tested query.** §3.4's illustration said `from t` where
  every tested and surrounding example uses `from wg t`. Corrected.
- **Doc over-promised.** §3.4 said a subquery's `having` may name an enclosing query's
  column, without noting that an enclosing *grouped* query still applies its own
  restriction to its own ungrouped columns — a real, now-pinned asymmetry. One clause added.

### Major findings — one ticket filed

`backlog/bug-no-group-by-aggregate-skips-subquery-coverage-check` — **pre-existing, not a
regression from this change.** The finished-plan coverage check (`assertGroupedPlanCoverage`)
is gated at `select.ts:427` on `groupedRedirectContext` existing, and that context is built
only when the query has GROUP BY keys. An aggregate query with **no** `group by` therefore
never reaches it, so a mistaken column reference hidden inside a HAVING or ORDER BY
subquery is neither caught nor evaluated correctly — it silently answers off an arbitrary
representative row:

```sql
select count(*) as c from wg having (select max(t.a) from wg t where t.b = wg.b) = 'x';
-- []                  no error; add a `group by` and the same mistake IS caught
```

Verified by running it. Filed at the *invariant* rung rather than as a point bug: the fix
is to build the context for the no-`group by` case too and drop the gate, which covers any
future clause built above the aggregate, not just the two that expose it today. The ticket
names the trap (the same value also triggers the grouping-key rewrite, which a keyless
query must not run) and notes that the local fallback this change added to
`buildHavingFilter` should disappear into that fix.

Checked first that no open ticket claims the site — `debt-group-key-match-by-attribute-identity`
and `debt-oversized-source-files` both name `select-aggregates.ts` but neither touches the
gate. No accepted-tradeoff `NOTE:` covers it; the `NOTE:` at `select.ts:418` is about
whether to reject at all for *grouped* queries, a different question.

### Tripwires — none recorded, and why

The one conditional concern is the extra `collectDefinedAttrIds` subtree walk the new
fallback does per prepare of a no-`group by` HAVING query. Not recorded as a `NOTE:`,
deliberately: its magnitude is already covered by the existing `NOTE:` on
`assertGroupedPlanCoverage` (measured: ~0.6-0.8 ms to compile a six-column grouped query
against ~0.5 ms ungrouped), and the ticket above deletes the fallback outright.

### Size debt

`select-aggregates.ts` is **1,645 lines** (`wc -l`, 2026-08-23), up from the 1,630 recorded
on 2026-08-12. Already tracked by `backlog/debt-oversized-source-files`; that ticket's
measured count was refreshed rather than a new ticket filed.

## Validation

- `yarn workspace @quereus/quereus test` — **10173 passing, 25 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsconfig.test.json` pass).
- `tsc -p tsconfig.json --noEmit` in `packages/quereus` — clean.
- `yarn docs:check` — clean.
- Single-file run of `07.3-group-by-extras.sqllogic`, plus a mutation check proving the new
  pins actually assert.

`tickets/.pre-existing-error.md` **was** written, for a failure unrelated to this diff: a
full `yarn test` run had `@quereus/sync`'s `schema-alter-replication.spec.ts` fail a
`before each` hook on Mocha's 2000ms default timeout. It does not reproduce (`yarn workspace
@quereus/sync test` alone: 736 passing, 0 failing), the diff has no sync surface, and the
likely cause is that package invoking Mocha with no `--timeout` — the same starvation
`packages/quereus/test-runner.mjs` already fixed for itself with `--timeout 10000`. No test
was skipped or loosened.

## Something found along the way — do NOT re-file

`max(t.b)` over the **text** column `b` returns the integer `3`, not the text `'3'`; the
window path (`max(b) over ()`) disagrees and returns text. Real, pre-existing, and already
tracked as `backlog/bug-text-coercion-in-arithmetic-and-aggregates`, arm B — root cause
`coerceAggregateValue` in `packages/quereus/src/util/coercion.ts`. Its only effect here was
that the original ticket's second proposed test case could never pass, so it was replaced
with two shapes exercising the same arm without depending on text/number comparison.
