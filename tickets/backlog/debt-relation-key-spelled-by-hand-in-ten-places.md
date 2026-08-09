---
description: The engine identifies each place a query reads a table by a short text label, and ten different spots build that label by hand with the same string recipe. When one spot spelled it slightly differently in the past, features silently stopped matching each other; give the label one owner so that cannot happen again.
files:
  - packages/quereus/src/planner/analysis/binding-extractor.ts               # collectTableReferences (~line 165) — the walk + key that should become the owner
  - packages/quereus/src/core/database-materialized-views-analysis.ts        # collectTableRefs (~line 273) — a second copy of the same walk and key
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts   # ~610, ~1114, ~1123, ~1540 — four hand-spelled keys
  - packages/quereus/src/planner/analysis/change-scope.ts                    # relKeyFor (~335) — third spelling of the key
  - packages/quereus/src/planner/analysis/constraint-extractor.ts            # ~1367, ~1612 — two more; ~1603 comment records the last drift incident
  - packages/quereus/src/planner/analysis/key-filter.ts                      # ~73
difficulty: medium
tradeoffs: Nothing is broken today — every copy currently agrees — so this buys prevention only, and it moves a shared helper across the planner/core boundary, which a maintainer may prefer to leave alone until a second drift actually bites.
---

# One owner for the table-reference key

## What the label is

When the engine plans a query it builds a tree, and a table the query reads shows up
in that tree as a node. Several features need to talk about *one particular
reference* to a table rather than the table itself — a self-join reads the same table
twice, and they must be told apart. They do that with a short text label of the form
`<schema>.<table>#<node id>`, lowercased, e.g. `main.orders#42`.

The label is built with the same one-line string recipe in **ten** places across six
files (list in `files:` above; measured with
`grep -rn '#\${' packages/quereus/src --include=*.ts`, discarding the hits that are
debug/logging text rather than this key). Two of those places are near-identical
tree walks that collect *every* such label in a plan:
`binding-extractor.ts`'s `collectTableReferences` and
`database-materialized-views-analysis.ts`'s `collectTableRefs`.

## Why it is worth owning

Nothing is broken today — all ten agree. But the recipe has drifted before, and when
it does the failure is silent rather than loud: two features compute labels for the
same reference, the strings do not match, and each simply finds nothing. There is a
comment at `constraint-extractor.ts` (~line 1603) recording exactly that incident —
one site was not lowercasing, so any table whose name was not already lowercase
(`Entity`) produced a label no other site matched, and every single-key lookup
silently widened to a whole-table scan.

The assertion bug this ticket came out of
(`bug-assertion-info-dependent-tables-always-empty`) was the same shape one level up:
two copies of "find the tables this query reads", one of which walked the tree
differently and therefore found nothing. That one was fixed by deleting a copy. The
remaining copies are the same exposure.

## What "done" looks like

One module owns both:

- the label itself — a single function that, given a table-reference node, returns its
  label; nothing else builds the string;
- the walk — a single function that, given a plan, returns every table reference in it
  keyed by that label, with the base table name already resolved.

Every site listed above calls those instead of re-spelling. The
materialized-view copy of the walk goes away.

Worth considering while doing it: making the label a distinct type rather than a bare
`string`, so a plain string cannot be passed where a label is expected. That is the
step that makes the drift unrepresentable instead of merely centralised — but it is a
wider change, and shipping the single owner first is already most of the value.

Deliberately out of scope: `change-scope.ts`'s walk and `mutation/backward-body.ts`'s
walk return different shapes and carry their own cycle guards. They should adopt the
shared *label*, but whether they can share the *walk* is a judgement call for whoever
does the work — do not force it.
