---
description: The engine writes a table's full name as one lowercase string ("schema.table") in about two dozen separate places, each spelling it out by hand; there is a shared helper for reading that string back apart but none for writing it, so the two halves can drift.
files:
  - packages/quereus/src/util/qualified-name.ts                              # splitBaseKey — the existing parse half; the compose half belongs here
  - packages/quereus/src/planner/analysis/relation-key.ts                    # relationBaseName — a 23rd spelling, added by debt-one-owner-for-relation-key
  - packages/quereus/src/core/database-materialized-views-analysis.ts        # mvKey (~48)
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts   # ~311, ~1074, ~1075, ~1325
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts           # ~358, ~605, ~1191
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts # ~136, ~190, ~377
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts           # ~259, ~1956, ~2118, ~2805
  - packages/quereus/src/runtime/delta-executor.ts                           # baseKeyFor (~300)
  - packages/quereus/src/runtime/emit/scan.ts                                # ~114
  - packages/quereus/src/runtime/foreign-key-actions.ts                      # ~235, ~379
  - packages/quereus/src/vtab/memory/module.ts                               # ~262
difficulty: medium
severity: wrong-result
likelihood: unusual
tradeoffs: The expression is two lines long and has never actually drifted, so a maintainer may reasonably judge a 24-site sweep to be churn that buys only theoretical safety.
---

# One owner for the qualified base name

## What the string is

Lots of the engine's lookup tables are keyed by a table's full name written as a
single lowercase string: schema, a dot, table name — `main.orders`. The codebase
calls this the **base key** or **base name**. It is what a change-capture log is
keyed by, what materialized-view source sets are indexed by, what foreign-key
cascade bookkeeping compares on, and it is the left half of the **relation key**
(`main.orders#42`, which additionally names *which read* of the table is meant).

Every one of those maps only works if all its writers and all its readers spell the
string the same way — same order, same separator, same lowercasing.

## The problem

There is already one shared function for taking that string apart:
`splitBaseKey` in `packages/quereus/src/util/qualified-name.ts`. There is no shared
function for putting it together. Instead, `` `${schemaName}.${name}`.toLowerCase() ``
is typed out by hand in **22 places** under `packages/quereus/src` (measured with
`grep -rn "schemaName}\.\${.*name}\`\.toLowerCase()\|schema}\.\${.*table}\`\.toLowerCase()"
packages/quereus/src --include=*.ts | wc -l`; 24 across all packages). Three of those
sites have already wrapped it in a private one-line helper of their own — `mvKey`,
`baseKeyFor`, `relationBaseName` — which is three different names for one concept.

This is the same shape of problem that `debt-one-owner-for-relation-key` closed one
level up, and the argument is the same: the failure mode is silent. A site that
forgets `.toLowerCase()`, or that builds `table.schema` instead of `schema.table`,
does not throw — the lookup simply finds nothing and the feature quietly degrades.
That exact mistake has already happened once with the relation key (a missing
`.toLowerCase()` turned every single-key equality select into a whole-table scan and
nothing failed loudly).

Nothing is known to be broken today. This is prevention, and it is filed to
`backlog/` rather than `fix/` for that reason.

## What "done" looks like

- The compose half lives next to the parse half in `util/qualified-name.ts`, so the
  two are read together and stay symmetric. Naming should make the round-trip
  obvious (`buildBaseKey` / `splitBaseKey`, or rename both onto one noun).
- It accepts the two shapes callers actually hold: a `TableSchema`-like
  `{ schemaName, name }` and a `QualifiedName`-like `{ schema, table }`. Whether that
  is one overload or two functions is an implementation call.
- The 22 hand-spelled sites call it. `mvKey`, `baseKeyFor`, and `relationBaseName`
  either delegate to it or disappear.
- One test asserting the round-trip: composing from a mixed-case schema/table and
  splitting back returns the original identifiers lowercased, including a quoted
  table name that legally contains a dot (`"a.b"` — `splitBaseKey` already documents
  that case, and the composer must not break it).

## What this ticket is not

Not a change to the *format* of the string, and not a change to `splitBaseKey`'s
documented first-dot-only behaviour (the dotted-**schema**-name ambiguity is already
tracked separately by `bug-core-fq-name-split-mis-routes-dotted-table-names`). Purely
a consolidation of who writes the string.
