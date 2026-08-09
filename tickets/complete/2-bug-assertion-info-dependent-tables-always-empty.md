description: The built-in listing of integrity rules always showed an empty list of the tables each rule depends on. It now shows the real list, derived by the same code path that decides which rules to enforce. Fixed, reviewed, and covered by tests.
files:
  - packages/quereus/src/planner/analysis/assertion-plan.ts          # NEW — the shared "plan an assertion body for analysis" recipe
  - packages/quereus/src/planner/analysis/binding-extractor.ts       # collectTableReferences exported; extractBindings built on it
  - packages/quereus/src/runtime/emit/create-assertion.ts            # discovery rewritten, extracted to discoverDependentTables(), moved after the reject checks
  - packages/quereus/src/core/database-assertions.ts                 # compileUnderSuppression calls the shared helper (~line 331)
  - packages/quereus/src/func/builtins/explain.ts                    # explain_assertion() was a third copy of the recipe; now calls the helper
  - packages/quereus/src/schema/assertion.ts                         # relationKey + dependentTables doc comments (staleness NOTE)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts    # ~1606 comment referenced the renamed collector
  - packages/quereus/test/emit-create-assertion.spec.ts              # discovery describe block, 8 cases
  - packages/quereus/test/assertion-rename-propagation.spec.ts       # ~line 89 test de-vacuumed
  - packages/quereus/test/logic/06.3.3-introspection-tags.sqllogic   # asserts parsed contents, not just json_valid
  - docs/functions.md                                                # dependent_tables column description
  - docs/optimizer-assertions.md                                     # §Commit-time Evaluation Engine + §Dependency Discovery & Invalidation
---

# `assertion_info().dependent_tables` was always empty

## What was wrong

`create assertion` recorded an empty `dependentTables` for essentially every assertion.
The discovery walk descended `getRelations()`, which does not enumerate the scalar-subquery
child that `not exists (select … from t)` — the shape almost every assertion body has —
hangs its table reference off of.

## Fix

The walk was not patched; it was deleted and replaced by the definition the enforcement
path already used, so the two cannot drift again.

- **New** `planner/analysis/assertion-plan.ts` exports `planAssertionBodyForAnalysis(db,
  body, schemaName)`: parse (if given text), build under `_homeSchemaPath(schemaName)`,
  `optimizeForAnalysis`, all inside `withSuppressedAssertionHoist`. Three hand-rolled
  copies of that recipe existed (create-assertion, the commit-time evaluator,
  `explain_assertion()`); all three call the helper now.
- **Exported** `collectTableReferences(plan)` from `binding-extractor.ts`, returning
  `Map<relationKey, {node, base}>`. `extractBindings` is built on it and create-assertion's
  discovery uses it — one walk, one key.

Stopping at the analysis stage rather than at a fully physical plan is what makes the entry
*count* right: a physical plan carries several `TableReferenceNode` instances per table, so
a naive walk over one lists every table twice under two different keys.

Discovery stays non-fatal and warn-only. `dependentTables` remains informational —
enforcement derives its own base set when it compiles the body.

## Review findings

Reviewed the implement diff (`ad67a124`) fresh before reading the handoff, then the
surrounding files and every doc the change touches or should have touched.

### Verified (no defect found)

- **The `explain_assertion()` refactor is equivalent.** The handoff flagged it as
  out-of-scope and unverified. It is byte-equivalent by construction: the hand-built
  `PlanningContext` it deleted matches `_buildProbeContext(undefined, homePath)` field for
  field — `getParameterTypes(undefined)` returns `undefined` (`core/param.ts:21`), and
  `ParameterScope`'s constructor defaults an absent `parameterTypes` to an empty Map
  (`planner/scopes/param.ts:25`), so `new ParameterScope(globalScope)` and the
  probe-context form are the same object; `parameters` is `{}` either way; the schema path
  is the same `_homeSchemaPath` call; and `_buildPlan` makes the identical
  `buildBlock(ctx, [ast])` call. The only call the new path skips is `getPlan`'s
  `checkOpen()`, and both call sites run against an already-open database.
- **The handoff's claim of thin coverage for `explain_assertion()` was wrong** — it is
  exercised by `test/assertion-home-schema.spec.ts:156`,
  `test/dotted-table-name.spec.ts:97-105`, `test/optimizer/row-specific-fd.spec.ts:187`,
  and `test/logic/95-assertions.sqllogic` (lines 295, 305, 571). A cross-check test was
  added anyway (below), which now covers it end to end.
- **Suppression nesting is safe.** `SchemaManager.assertionHoistSuppressed` is a counter
  (`schema/manager.ts:231, 551-556`), so the helper's region nested inside
  `getOrCompilePlan`'s wider region does not un-suppress on exit.
- **The corrected doc claim at `optimizer-assertions.md:96` is accurate.** `compileUnderSuppression`
  builds `baseTablesInPlan` from `bindings.relationToBase` (`database-assertions.ts:337-348`);
  the only readers of the schema field are `assertion_info()` (`func/builtins/schema.ts:606`)
  and the rename remap.
- **Populating the field cannot disturb anything else.** `dependentTables` is not in the
  schema hash and not persisted by any store module, so going from `[]` to a real list
  shifts no hash and no stored catalog.
- **The rename remap survives the now-populated list**, including the self-join case: the
  node-id suffix is carried over verbatim, so two entries for one table stay distinguishable
  after re-keying.
- **Discovery doing less work than before is the right reading**: it was warn-only before
  and after, and nothing is gated on it.
- **`relationKey` comparability**: grepped — nothing compares a recorded key against an
  evaluator-computed one, so the new doc warning is preventive, as intended.

### Minor — fixed in this pass

- **`runtime/emit/create-assertion.ts`: discovery ran before the rejection checks.** A
  `create assertion` on an existing name, or into a missing schema, paid for a full
  plan-and-walk it then threw away — and logged a discovery warning for a statement that
  created nothing. Moved discovery after both checks, and extracted the 25-line inline
  `try`/`catch` into `discoverDependentTables()` (the `run` body was carrying it inline,
  against the house preference for small single-purpose functions). Behavior on the success
  path is unchanged.
- **`planner/analysis/constraint-extractor.ts` (~1606): stale comment.** It cited
  `binding-extractor.ts collectTableRefs` — the function this diff renamed. Now cites
  `collectTableReferences`.
- **`docs/optimizer-assertions.md` §Dependency Discovery & Invalidation was left
  contradicting §Commit-time Evaluation Engine.** The implement pass corrected line 96 but
  left lines 118-119 describing the original design: "store as `dependentTables` with
  preliminary classification (updated at COMMIT time)" — no classification is stored and
  nothing updates it at commit — and "on schema change … mark assertion stale; re-prepare",
  which describes the evaluator's plan-cache invalidation, not the recorded field (that is
  never re-derived). Rewritten to match the code and to point at the staleness `NOTE:`.

### Test coverage — one gap closed

The bug was two derivations of "what does this body read" drifting apart, and nothing
asserted they agree. Added `records the same references the analysis path derives for
enforcement` to `test/emit-create-assertion.spec.ts`: it creates a self-join assertion and a
two-table assertion and asserts the recorded `dependent_tables` bases equal the bases
`explain_assertion()` reports — that TVF re-derives from the stored body through the same
helper the commit-time evaluator uses. Re-pointing one call site now fails a test instead of
silently reopening the gap.

The implement pass's seven shape cases (subquery, scalar aggregate, two-table, self-join,
view, no-table, non-main schema) were checked and are sound; the count assertions are the
part that actually guards against a regression to physical planning.

### Major — ticket filed

- `tickets/backlog/debt-relation-key-spelled-by-hand-in-ten-places.md`. The handoff claims
  "one walk, one `relationKey` spelling" — true between the two assertion paths, not
  repo-wide. Measured with `grep -rn '#\${' packages/quereus/src --include=*.ts` (discarding
  hits that are debug/log text): the `<schema>.<table>#<nodeId>` key is hand-built in **10**
  places across 6 files, and `core/database-materialized-views-analysis.ts:273` is a second,
  character-equivalent copy of the very walk this diff exported. Not a defect — all copies
  agree today — but it is the same drift mechanism that produced this bug, and
  `constraint-extractor.ts:1603` records a prior incident of exactly that drift (one site not
  lowercasing, silently widening every keyed lookup to a full scan). Filed rather than fixed
  inline: consolidation reaches into materialized-view maintenance, and three of the walks
  return different shapes and carry their own cycle guards, so it is a design call, not a
  mechanical edit. Site-claim grep over `tickets/{backlog,fix,plan,implement,review}` found
  nothing claiming those sites (`debt-mv-shape-analysis-blind-to-pushed-predicates` touches
  the same file, different concern).

### Tripwires

No new ones. The two the implement pass recorded were checked and are at the right sites and
still accurate: the staleness `NOTE:` on `IntegrityAssertionSchema.dependentTables`
(`schema/assertion.ts`) and the analysis-stage precondition on `collectTableReferences`
(`binding-extractor.ts`).

### Noticed and deliberately not actioned

Recorded here so the next reader does not re-derive them:

- `collectTableReferences`'s walk has no visited-set, so a plan sharing a subtree between two
  parents is walked more than once (`change-scope.ts:341` guards against this). Pre-existing,
  the result is unaffected (the Map dedups), and assertion bodies are small — not worth a
  comment on a traversal this ticket did not change.
- The discovery `catch` arm (warn + empty list) is untested. Reaching it needs a body that
  builds but fails analysis-stage optimization, which the builder's pre-validation makes
  near-unreachable. Left uncovered rather than reached for with a mock.
- `docs/todo.md:131` describes exactly the behavior now shipped and is still unticked. Left
  alone: that file is a roadmap where essentially every box is unticked regardless of state
  (`explain_assertion` ships and its box is unticked too), so ticking one line would
  misrepresent the rest.
- `constraint-extractor.ts:1631` has an unused parameter not prefixed `_` (house rule).
  Pre-existing, outside this diff, and renaming an exported function's parameter is churn.

## Validation

- `yarn test` — **9213 passing, 0 failing**, 25 pending across all workspaces (9213 in
  `packages/quereus`, up one from the added test). No pre-existing failures surfaced.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`; every other package is
  the intentional no-op).
- `npx tsc -p tsconfig.json --noEmit` in `packages/quereus` — clean.

## Behavior

```sql
create table t (x integer primary key);
create assertion a1 check (not exists (select 1 from t where x < 0));
select name, dependent_tables from assertion_info();
-- => a1, [{"relationKey":"main.t#<n>","base":"main.t"}]
```

One entry per table *reference*: a self-join over `t` records two entries, both with
`base` `main.t`, under distinct `relationKey`s. A body over a view records the view's
underlying base tables, since views expand at build time.
