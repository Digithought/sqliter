---
description: The built-in listing of integrity rules used to always show an empty list of the tables each rule depends on; it now shows the real list, derived the same way the enforcement path derives its own.
files:
  - packages/quereus/src/planner/analysis/assertion-plan.ts          # NEW — the shared "plan an assertion body for analysis" recipe
  - packages/quereus/src/planner/analysis/binding-extractor.ts       # collectTableReferences now exported; extractBindings built on it
  - packages/quereus/src/runtime/emit/create-assertion.ts            # discovery block rewritten (lines 47-72)
  - packages/quereus/src/core/database-assertions.ts                 # compileUnderSuppression now calls the shared helper (line ~325)
  - packages/quereus/src/func/builtins/explain.ts                    # explain_assertion() was a third copy of the recipe; now calls the helper
  - packages/quereus/src/schema/assertion.ts                         # relationKey + dependentTables doc comments
  - packages/quereus/test/emit-create-assertion.spec.ts              # NEW describe block, 7 discovery cases
  - packages/quereus/test/assertion-rename-propagation.spec.ts       # line ~89 test de-vacuumed
  - packages/quereus/test/logic/06.3.3-introspection-tags.sqllogic   # asserts parsed contents, not just json_valid
  - docs/functions.md                                                # dependent_tables column description
  - docs/optimizer-assertions.md                                     # corrected who reads dependentTables
repro: verified
difficulty: medium
---

# Review: `dependentTables` is derived from the analyzed plan

## What changed

`create assertion` recorded an empty `dependentTables` for essentially every
assertion, so `assertion_info().dependent_tables` was always `[]`. The discovery
walk descended `getRelations()`, which does not enumerate the scalar-subquery
child that `not exists (select … from t)` hangs the table reference off of.

The fix does not patch the walk — it deletes it and shares one definition with the
enforcement path, so the two cannot drift again.

**New:** `planner/analysis/assertion-plan.ts` exports
`planAssertionBodyForAnalysis(db, body, schemaName)` — parse (if given text), build
under `_homeSchemaPath(schemaName)`, `optimizeForAnalysis`, all inside
`withSuppressedAssertionHoist`. There were **three** hand-rolled copies of that
recipe (create-assertion, the commit-time evaluator, `explain_assertion()`); all
three now call the helper. The evaluator's own wider suppression region still
wraps residual compilation — the suppression counter is re-entrant, so nesting is
fine.

**Exported:** `collectTableReferences(plan)` from `binding-extractor.ts`, returning
`Map<relationKey, {node, base}>`. `extractBindings` is built on it, and
create-assertion's discovery now uses it. One walk, one `relationKey` spelling.

Stopping at the analysis stage (not `db.getPlan`, which is fully physical) is the
part that makes the entry **count** right: a physical plan carries several
`TableReferenceNode` instances per table, so a naive walk over one lists every
table twice with two different `relationKey`s.

Discovery stays non-fatal — same `try` / `warnLog` shape, same "never fatal"
reasoning in the comment.

## Use cases to exercise

```sql
create table t (x integer primary key);
create assertion a1 check (not exists (select 1 from t where x < 0));
select name, dependent_tables from assertion_info();
-- => a1, [{"relationKey":"main.t#<n>","base":"main.t"}]
```

Shapes now pinned by tests (all in `test/emit-create-assertion.spec.ts`, new
`describe('Emit: CREATE ASSERTION dependency discovery')`):

| body | recorded |
|---|---|
| `not exists (select 1 from t where x < 0)` | one entry, `main.t` |
| `(select count(*) from t where x < 0) = 0` | one entry, `main.t` |
| `not exists (select 1 from t join u …)` | `main.t`, `main.u` |
| self-join `t as p join t as q` | **two** entries, both `main.t`, distinct relationKeys |
| body over a view `v` on `t` | one entry, `main.t` (views expand at build time) |
| `1 = 1` | `[]` |
| `create assertion temp.qa check (… from qt …)` with `main.qt` also present | `temp.qt` |

`test/assertion-rename-propagation.spec.ts:89` was vacuous (both sides empty, with
a comment naming this bug). It now asserts `main.t` before the rename, `main.t2`
after, and that only the base portion of the `relationKey` is re-keyed — the node
id is carried over verbatim by `remapDependentTables`.

`test/logic/06.3.3-introspection-tags.sqllogic` now asserts
`json_array_length(dependent_tables)` and `json_extract(…, '$[0].base')` rather
than only `json_valid`.

## Validation run

- `yarn test` — 9212 + 386 + 137 + 73 + 63 + 74 + 1575 + 725 + 85 + 31 + 34 + 134 + 22 passing, **0 failing**, 25 pending. No pre-existing failures surfaced.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `npx tsc -p tsconfig.json --noEmit` in `packages/quereus` — clean.

## Known gaps / where to push

- **`explain_assertion()` was refactored too** — it was the third copy of the same
  recipe and its hand-built `PlanningContext` was byte-equivalent to
  `_buildProbeContext(undefined, homePath)` (`new ParameterScope(globalScope)` ==
  `getParameterTypes(undefined)` → `undefined`). Believed behavior-preserving and
  the suite is green, but this file was outside the ticket's stated scope and
  deserves a second pair of eyes. It dropped five now-unused imports
  (`GlobalScope`, `ParameterScope`, `PlanningContext`, `BuildTimeDependencyTracker`,
  `buildBlock`).
- **No test asserts `explain_assertion()` still behaves identically** — I relied on
  the existing suite. If there is thin coverage there, that is a real gap.
- **The recorded list is a snapshot, not a live view.** It is derived once at
  CREATE and after that only string-re-keyed by the `ALTER TABLE … RENAME`
  propagation. A view inside an assertion body redefined over different tables
  leaves the recorded list stale. Parked as a `NOTE:` on
  `IntegrityAssertionSchema.dependentTables` (`schema/assertion.ts`) — harmless
  while only introspection reads it, and the field is documented as informational.
  Not filed as a ticket; see *Tripwires* below.
- **Discovery now does less work than before** (analysis stage, not full physical
  optimization). Any create-time failure that only a physical pass would raise is
  no longer even attempted — but discovery was already non-fatal and warn-only, so
  nothing user-visible changed. Worth confirming that reading is right.
- **`relationKey` comparability** is now documented (`AssertionDependentTable`):
  the embedded node id comes from a process-wide counter, so a recorded key never
  equals the key the evaluator computes for the same table at commit time. Nothing
  in the tree compares them today; the doc is there to stop someone starting.
- Did **not** touch `fix/bug-assertion-body-can-name-missing-table`'s territory (a
  body naming a table that does not exist).

## Tripwires recorded

- `packages/quereus/src/schema/assertion.ts` — `NOTE:` on `dependentTables`: the
  list is recorded at CREATE and only re-keyed on rename, so it can go stale (a
  redefined view in the body is the reachable case); if a consumer ever needs it
  live, re-derive on the schema-change events the evaluator already invalidates its
  plan cache on rather than adding a second remap path.
- `packages/quereus/src/planner/analysis/binding-extractor.ts` — the doc on
  `collectTableReferences` states the analysis-stage precondition: callers that
  care about reference identity must not hand it a physically optimized plan.

## Docs touched

- `docs/functions.md` — `dependent_tables` now described as one entry per table
  *reference* (self-join yields two), `base` lowercased `schema.table`.
- `docs/optimizer-assertions.md` — line 96 claimed commit-time impact collection
  reads `dependentTables`. It does not; it uses the base set derived when the body
  is compiled. Corrected, and now says both come from the same
  `planAssertionBodyForAnalysis` + `collectTableReferences` pair.
