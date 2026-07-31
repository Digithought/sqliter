----
description: If a storage backend ever says "this table has no rows" while planning a query, the planner deletes the read from the plan entirely — which returns wrong answers for a statement that writes rows and then reads them back. No backend does this today, but nothing stops one.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNode — the fold
  - packages/quereus/src/vtab/best-access-plan.ts                          # the `rows` field's documented meaning
  - docs/module-authoring.md                                              # the contract this ticket would make enforced rather than advisory
difficulty: easy
repro: verified
----

# A zero row estimate is treated as a proof that the table is empty

## What happens

When the planner asks a storage backend how it would read a table, the backend answers with,
among other things, a row count. If that count is **zero**, the planner concludes the read
can produce nothing and replaces it with a static empty result — no storage access at all.

That conclusion is only valid for the case it was written for: the backend has been handed a
filter it can prove nothing matches (the shipped in-memory backend does this for
`where <col> is null` on a column declared `not null`). It is not valid for a backend that
simply reports how many rows the table holds at the moment the plan is built, because:

- planning happens before execution, and a statement can **write rows into a table and then
  read them back** within itself — updating a view over an outer join materializes the
  missing row on the non-preserved side and then reads it — so "empty now" does not mean
  "empty when this plan runs";
- the check that is supposed to restrict the fold to the proven-impossible-filter case is
  `handledFilters.every(...)`, which is **vacuously true when there are no filters at all**.
  So the fold fires most easily in exactly the situation it was never meant for: a plain full
  scan of a table that currently has no rows.

## Why it is filed rather than fixed

No backend that ships with the project reports a live zero. The in-memory backend maps an
incoming zero estimate to "unknown" and only ever emits zero for the impossible-filter case;
the key-value store backend floors its own reported count at one specifically to stay clear
of this (`StoreModule.getBestAccessPlan`). So the defect is dormant — but it is a plain
correctness failure the moment a backend author reads the row count field as what its own
documentation calls it, "cardinality estimate", and answers honestly.

It was observed live: while wiring the key-value store's maintained row count into access
planning (`debt-store-analyze-row-count`), an emptied table reported zero and
`93.4-view-mutation.sqllogic` returned nulls for rows the same statement had just written.
Flooring the reported count at one made it pass. The floor is the backend defending itself
against the engine, which is the wrong side for the guard to live on.

## What good looks like

The fold happens only when a backend has actually claimed a filter — i.e. when there is at
least one filter and every one of them is claimed handled. A no-filter plan reporting zero
rows is then costed as a cheap scan rather than deleted, which is the correct reading of an
estimate.

Worth deciding at the same time whether the contract should be stated in the interface rather
than in prose — e.g. a distinct, explicit "this predicate is unsatisfiable" signal, so that a
backend can never express the claim by accident through a number field.

## Related

- `docs/module-authoring.md` § Index-Based Access now states the contract in prose ("never
  report zero merely because the table is empty right now"), and the fold site carries a
  `NOTE:` pointing here.
