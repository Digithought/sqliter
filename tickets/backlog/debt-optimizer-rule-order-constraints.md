description: Optimizer rules must run in a specific order for correctness, but that order lives only in code comments and array position — add machine-checked "run me after rule X" declarations so a future edit that reorders them wrong fails loudly at startup instead of silently producing bad query plans.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/framework/pass.ts
----

## Context

Since `planner-remove-priority-manifest` landed, the optimizer's rule ordering contract is "the array order in the rule manifest is the order rules run." That order matters for correctness — many rules only work if another rule already ran (e.g. a folding rule must run *after* predicate-pushdown has consolidated the predicate). Today that dependency is recorded only as English prose in comments ("runs after predicate-pushdown", "before join-elimination") and as the physical position of the entry in the array.

Nothing checks that the array order actually satisfies those stated dependencies. Someone inserting a new rule, or moving one, can silently violate an ordering requirement — and the only symptom is a wrong or suboptimal query plan, caught (if at all) by a golden-plan test far from the cause.

## What to build

Let each manifest entry optionally declare its ordering dependencies as data — e.g. `after: ['predicate-pushdown']`, `before: ['join-elimination']` — naming other rule ids. At optimizer startup, run a check that the manifest's array order is consistent with all declared edges (a topological-consistency assertion: for every `after` edge, the named rule appears earlier in the same pass; for every `before` edge, later). Violations throw at construction with a clear message naming both rules.

This turns the ordering rationale that currently lives in prose comments into a verified invariant, and makes future rule insertions self-checking: declare the dependency, and the assertion catches a wrong insertion point.

## Why backlog, not now

The parent ticket (`planner-remove-priority-manifest`, now complete) removed the misleading `priority` field and landed the data manifest plus a structural (dup-id / unknown-pass) assertion — that was the bounded, must-do change. Populating real `after`/`before` edges means re-deriving each rule's true ordering dependencies from ~40 existing comments and encoding them, which is a larger, more judgment-heavy pass better done on its own. Cross-pass edges (a rule depending on one in an earlier pass) also need a design decision on whether to model them or keep the check pass-local.

## Open questions for whoever picks this up

- Pass-local only, or model cross-pass dependencies too? (Cross-pass is where the subtle bugs hide, but the check is more complex.)
- Should a rule with *no* declared edges be allowed (order fixed purely by array position), or should every rule be forced to declare, to prevent silent reliance on position? Forcing declaration is stricter but higher upfront cost.
