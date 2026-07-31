----
description: A storage backend tells the planner how many rows a query will read, and answering "zero" makes the planner delete the read from the plan entirely. That is meant to say "nothing can possibly match", but it is spelled as an ordinary number, so a backend can make the claim by accident and get wrong answers.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNode — the fold
  - packages/quereus/src/vtab/best-access-plan.ts                          # the `rows` field's documented meaning
  - packages/quereus/src/vtab/memory/module.ts                             # the one shipped module that makes the claim
  - docs/module-authoring.md                                              # the contract, currently stated in prose only
difficulty: easy
repro: static
----

# "No rows" should be said out loud, not spelled as the number zero

## What happens

When the planner asks a storage backend how it would read a table, the backend answers with,
among other things, a row count. If that count is **zero**, the planner concludes the read can
produce nothing and replaces it with a static empty result — no storage access at all, ever.

That conclusion is a *proof*, but the field it is read out of is documented as an *estimate*.
Nothing in the interface distinguishes "I have been handed a filter that provably matches
nothing" from "I estimate this will read approximately no rows". A backend that rounds a very
selective estimate down to zero, or that simply reports how big the table is right now, makes
the strong claim without meaning to — and the planner acts on it by deleting a read that has
to happen.

## What has already been fixed

The worst arm of this is closed. The fold used to fire on a plan with **no filters at all**,
because the guard restricting it to the proven-impossible case (`handledFilters.every(...)`)
is vacuously true over an empty list. So a backend reporting an honest live size of zero for a
plain full scan had its table read deleted — and planning precedes execution, so "empty now"
is not "empty when this runs". That was observed live: while wiring the key-value store's
maintained row count into access planning (`debt-store-analyze-row-count`), an emptied table
reported zero and `93.4-view-mutation.sqllogic` returned nulls for rows the same statement had
just written.

The fold now additionally requires at least one claimed filter, pinned by
`packages/quereus/test/optimizer/empty-relation.spec.ts` § "A no-filter `rows: 0` is an
estimate, not a proof".

## What is left

With filters present, the fold still reads a number as a proof. A backend that claims a filter
handled and reports `rows: 0` as a *selectivity estimate* — rather than as a contradiction it
proved — still gets its read deleted and still returns wrong rows. No shipped backend does
this (the in-memory one emits zero only for `is null` on a `not null` column; the key-value
one floors every count it reports at one), which is why this is filed rather than urgent.

## What good looks like

A distinct, explicit signal on the access-plan result meaning "this predicate is
unsatisfiable" — something a backend has to opt into deliberately and cannot express by
accident through a number field. The row count then goes back to being purely an estimate, and
the prose contract in `docs/module-authoring.md` § Index-Based Access ("never report 0 merely
because the table is empty right now") becomes a statement about a field that no longer
carries a second meaning.

Worth deciding at the same time whether the existing `rows: 0` reading stays supported for
compatibility or is removed outright — the only in-tree caller is the memory module's
`is null` on `not null` arm, which is a one-line change either way.
