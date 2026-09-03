description: One function in the query planner is about 570 lines long with no internal structure, which makes the code that picks how a table is read hard to follow and risky to change.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNodeFromPlan, lines 480-1048
tradeoffs: The function works and is heavily commented, so a split is pure maintainability with a real risk of introducing a behavior change in one of the most correctness-sensitive rules in the planner; a maintainer may reasonably prefer to leave it alone until the next feature forces a change there.
----

# `selectPhysicalNodeFromPlan` is one ~570-line function

## What was measured

`wc -l packages/quereus/src/planner/rules/access/rule-select-access-path.ts` → 1643 lines.
`selectPhysicalNodeFromPlan` runs from line 480 to line 1048 — about 569 lines — and contains
no nested named helpers at all; the only internal decomposition is four one-line lookup
lambdas (`isHandled`, `findPrefixEq`, `findLower`, `findUpper`, lines 516-522). Its sibling
`selectPhysicalNodeLegacy` is a further ~180 lines (1049-1231).

This conflicts with the repo's own standard in `AGENTS.md`: "Small single-purpose
funcs/methods. Decomposed sub-funcs > grouped sections."

## Why it matters

This function is the engine's decision about HOW a table is physically read — composite seek
vs. range scan vs. ordered scan vs. sequential scan, which pushed predicates the seek is
allowed to enforce, and which must be re-applied as a filter above it. Getting any of that
wrong produces silently wrong query results rather than an error. A reader currently has to
hold the whole 570 lines in their head to know whether a given branch has already consumed a
constraint, and every review of a change to it re-pays that cost.

## Natural seams (not a plan, just what a reader sees)

The body already reads as a sequence of labelled phases separated by comment blocks: build
the per-column constraint lookups; classify collation cover for each candidate constraint;
try the composite equality seek; try the leading-equality-plus-range seek; try the
ordering-only index scan; fall back. Each phase consumes constraints into the shared
`consumed` set and either returns a leaf or falls through to the next.

Any decomposition must keep the `consumed` bookkeeping exactly as it is — that set is what
`reattachUnconsumedConstraints` and `stampSeekProvenance` read afterwards to decide which
predicates still need enforcing above the leaf. A split that loses or double-counts an entry
there is exactly the wrong-results failure this ticket is trying to make less likely.

## Not in scope

No behavior change. The plan shapes chosen must be identical before and after; the existing
`test/plan/` and `test/optimizer/` suites are the check.
