---
description: The materialized-view shortcut deliberately gives up on some grouped queries only because the normal query path used to hand back its columns in a different order; once that is fixed the shortcut can be used for those queries too.
prereq: bug-grouped-key-reorder-survives-to-output
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts  # the `group-key-pinned` forgo + clausePinsOrEquatesGroupCol
  - packages/quereus/test/query-rewrite-aggregate.spec.ts           # the test that pins the forgo (~line 306)
  - docs/optimizer-rule-families.md                                 # § Aggregate-rollup arm (~line 29) lists the guard
  - docs/materialized-views.md                                      # § "Group-key reorder" (~line 281)
difficulty: easy
---

# Retire the `group-key-pinned` forgo in the materialized-view rewrite

When a query can be answered from a materialized view instead of the base
tables, a matcher decides whether the swap is a faithful drop-in. One of its
refusal reasons — `group-key-pinned` — exists purely to mirror a base-path
defect: a query grouping on ≥2 columns whose `where` pins (`g = 1`) or equates
(`g1 = g2`) one of them made the base path return its columns in a shifted
order, and the view path returns them in select-list order, so the matcher
forwent the rewrite to keep the two paths agreeing.

`bug-grouped-key-reorder-survives-to-output` makes the base path preserve
select-list order. The two paths then agree by construction and the guard only
costs coverage: those queries fall back to a base-table scan when the view could
serve them.

Site: `packages/quereus/src/planner/analysis/query-rewrite-matcher.ts`, the
`queryGroupSet.size >= 2 && queryClauses.some(clausePinsOrEquatesGroupCol …)`
block (~line 715) and the `'group-key-pinned'` member of `RewriteFailureReason`
(~line 79). `clausePinsOrEquatesGroupCol` exists only for this guard; check for
other callers before deleting it.

## What must be shown, not assumed

Removing a soundness-flavoured guard needs positive evidence that the rewrite
now matches the base. Do not delete on the strength of the reasoning above alone
— convert the existing forgo test into an agreement test:

`test/query-rewrite-aggregate.spec.ts` (~line 306) currently asserts
`select d, r, sum(amt) from sales where d = 1 group by d, r` fails with
`group-key-pinned`. Replace it with a case that (a) asserts the match now
succeeds, and (b) runs the same query with the rewrite enabled and disabled and
compares **column names and row values positionally**. Check whether the repo's
materialized-view equivalence harness already offers that base-vs-view
comparison and reuse it rather than hand-rolling one.

If the comparison shows a divergence, the guard is protecting against something
beyond the base reorder — stop, keep the guard, and file what you found rather
than loosening the assertion.

## TODO

- Confirm `bug-grouped-key-reorder-survives-to-output` has landed and the base
  path preserves select-list order for pinned/equated multi-key group queries.
- Replace the `group-key-pinned` forgo test in
  `test/query-rewrite-aggregate.spec.ts` with a base-vs-view positional
  agreement test; confirm it passes *before* removing the guard.
- Remove the guard block, the `'group-key-pinned'` failure reason, and
  `clausePinsOrEquatesGroupCol` if it has no other caller.
- Update `docs/optimizer-rule-families.md` § Aggregate-rollup arm — it currently
  says "One forgo guard remains: `group-key-pinned`".
- Update `docs/materialized-views.md` § "Group-key reorder" to match whatever
  ticket 1 left there.
- Run `yarn test` and `yarn lint` from the repo root.
