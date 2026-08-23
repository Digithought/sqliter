---
description: A materialized view whose saved rows were computed with one version of a SQL function is now flagged as out of date when the application swaps that function for a different one, instead of quietly mixing old and new results in the same table.
files:
  - packages/quereus/src/planner/analysis/mv-body-functions.ts       # detectBodyFunctionDrift (new, tail of file)
  - packages/quereus/src/core/database-materialized-views.ts         # RegisterMaterializedViewOptions, registerMaterializedView, applyBodyFunctionDrift
  - packages/quereus/src/core/database.ts                            # ~2798 the public wrapper (now returns boolean)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # ~238 refresh passes backingRecomputed
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # ~3219 restoreMaterializedViewLive honours the drift flag
  - packages/quereus/test/mv-function-drift.spec.ts                  # new spec, 14 tests
  - packages/quereus/test/mv-rename-propagation.spec.ts              # ~257 stub updated for the new return type
  - docs/mv-schema-change.md                                         # new "## Body-function drift" section
  - docs/materialized-views.md                                       # § Function identity — maintenance-side paragraph rewritten
  - docs/schema.md                                                   # ~85 bodyFunctions bullet
difficulty: medium
---

# Body-function drift now marks a materialized view stale

## What shipped

A materialized view's saved (backing) table is kept current by a maintenance plan compiled
**once**, at registration, against the function registrations live at that moment. Some
operations re-register the view and recompile that plan against whatever is registered
*now*. If the application replaced one of its own functions in between, maintenance used
to switch silently to the new implementation while the already-saved rows came from the
old one — one table holding two functions' answers, nothing marking which is which.

Registration now compares the previous registration's capture of the body's functions
(`TableDerivation.bodyFunctions`, added by the prereq ticket) against the freshly resolved
one **by object identity**, and marks the view **stale** on any difference. Stale is the
engine's existing "the saved rows are behind their definition" state: the read-side rewrite
declines (queries recompute from the base tables), row-time maintenance detaches (the
saved table stops changing rather than changing inconsistently), and
`refresh materialized view` re-derives every row under the new meaning.

## Shape of the change

- **`detectBodyFunctionDrift(prior, current)`** (`mv-body-functions.ts`) — returns the
  sorted `(name/argc)` keys whose resolution changed, comparing by object identity over
  the **union** of both key sets. Three cases count as drift: a key resolving to a
  different registration, one that resolved before and no longer does, one that resolves
  now and did not before.

- **`registerMaterializedView(mv, options?)` now returns `boolean`** — `true` when drift
  was found and the view marked stale. The stale transition is
  `markMaterializedViewStale`'s, unchanged: flag + row-time plan release + synthetic
  backing invalidation so cached statement plans recompile. The drifted keys are logged
  explicitly.

- **`RegisterMaterializedViewOptions.backingRecomputed`** suppresses the check. Exactly one
  caller passes it: `refreshMaintainedTable` (`materialized-view.ts` ~238), whose
  rebuild/reshape just re-derived every row from the body against the live registry — the
  differing capture there is the *resolution*, not the hazard. Without this, REFRESH would
  mark the view stale and then clear the flag while its plan had been released, leaving a
  live-flagged view with no maintenance plan.

- **`restoreMaterializedViewLive`** (`materialized-view-helpers.ts` ~3219) — the other site
  that clears `stale` right after registering — now honours the returned flag. That pass
  restores views a *rename* provably did not affect; it says nothing about whether the
  saved rows are still faithful, so drift outranks it.

- The check runs **after** the plan is built, so the create-time eligibility gate inside
  `buildMaintenancePlan` still runs on every registration (callers roll the MV back on its
  throw). The just-built plan is then discarded on drift — see the tripwire below.

## Why stale rather than rebuild

Rebuilding inside `registerMaterializedView` would put a full recompute — and therefore a
query — inside a DDL path that today only compiles, making `alter table … rename`
unexpectedly expensive. Staleness already means "the saved rows are behind their
definition" and `REFRESH` already clears it; drift is the same claim reached differently.

## Testing / validation

`packages/quereus/test/mv-function-drift.spec.ts`, 14 tests, all passing. The fixture is a
base table `t(id, k, x)` with rows `(1,1,10),(2,1,20),(3,2,30)` and
`create materialized view mv as select k, sum(x) as s from t group by k`, plus a
deterministic replacement `sum/1` that **counts rows** rather than summing them — so a row
produced by the built-in (`30`) and one produced by the replacement (`2`) are
distinguishable by value.

Behavioural cases:

- rename-after-replacement marks the view stale;
- a covered query is then computed from the base table (row counts `2` / `1`), not served
  from the saved sums;
- after the rename an insert leaves the saved table at `k=1→30, k=2→30` — behind, but every
  row still the built-in's. This is the exact failure the ticket reproduced: without the
  fix it becomes `k=1→30, k=2→2`;
- `refresh materialized view` clears the flag, re-derives every row under the new function
  (`2` / `2`), and maintenance resumes consistently (`3` / `2` after a further insert);
- renaming the **source** table after a replacement also leaves the view stale — the
  rename-propagation restore pass honours drift;
- a **scalar** body function replaced before a rename drifts the same way (`bump(v)`
  moving from `+1` to `+1000`), with the same no-mixing and refresh assertions.

Regression guards (renaming a maintained table is otherwise routine):

- a rename with no function change does **not** stale the view, and maintenance stays live
  (`k=2` goes `30 → 35`);
- registering an **unrelated** function does not stale it;
- re-registering the **same function object** is not drift.

Plus five unit tests on `detectBodyFunctionDrift` covering each drift case, the sorted
multi-key result, and unchanged keys.

**These are real guards, verified negatively.** Temporarily short-circuiting
`applyBodyFunctionDrift` to `return false` makes 5 of the 9 behavioural tests fail
(`mv-function-drift.spec.ts` lines 96, 112, 131, 171, 198); the reverting edit is not in
the diff.

Validation run:

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn typecheck` — clean across all workspaces.
- `yarn test` (full monorepo fan-out, `foreach` bails on first failure) — exit 0, 10m12s.
- `yarn docs:check` — "Docs OK: links resolve, invariants well-formed, sizes within
  ratchet, doc and package tiers declared."
- MV-adjacent specs re-run after the final comment edit: `mv-function-drift`,
  `mv-rename-propagation`, `query-rewrite-aggregate`, `mv-structural-alter-restore` — 55
  passing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Known gaps — please probe these

- **The in-place recompile path is covered by reasoning, not by a test.**
  `tryRecompileMaterializedViewLive` (`materialized-view-helpers.ts` ~2351) re-registers
  after a *source schema* change without recomputing the saved rows, so it now carries the
  drift check too. That is the intended behaviour (rows unchanged ⇒ drift is real), and its
  caller in the manager's listener `continue`s afterwards without touching `stale`, so a
  drifted view correctly ends stale with no plan. But no test exercises "replace a function,
  then `alter table t add column` (a structural change the body does not read)". Worth
  adding, or worth confirming the outcome is what a reader would expect — the log line will
  say "Recompiled … in place" *and* "Marking … stale", which reads oddly together.

- **The attach-rollback path is likewise untested.** `restorePrior`
  (`materialized-view-helpers.ts` ~1343) re-registers the *prior* maintained record after a
  failed `set maintained as`, ignoring the returned boolean. If drift fires there the view
  ends stale with its plan released, which is fail-safe — but unverified.

- **The reopen case was confirmed static, not run.** `SchemaManager.importMaterializedView`
  routes through `materializeView` / `adoptMaterializedView`, both of which call
  `attachDerivation(..., buildTableDerivation(def, shape))` — and `buildTableDerivation`
  (`materialized-view-helpers.ts` ~601) constructs a **fresh** `TableDerivation` with no
  `bodyFunctions`. So a reopen registers against the live registry with no prior capture
  and reports no drift. That is the inherent within-session limit (object identity cannot
  cross a process boundary) and is now stated in `docs/mv-schema-change.md` § Body-function
  drift and `docs/materialized-views.md` § Function identity. It was **not** reproduced
  against a persistent backing — confirming it would mean a `quereus-store`-backed test
  that reopens a database and registers a replacement function before rehydration. The
  ticket's scope boundary says a persisted weaker witness (e.g. "this body function was the
  built-in") is separate work; I did not file it, since nothing here established it is
  wanted.

- **Union-of-keys detection is deliberately conservative.** A key present in one capture and
  not the other counts as drift. In practice both captures walk the same body AST, so the
  key sets should be identical; the asymmetric cases would need a function to have not
  resolved at one of the two registrations. Cheap and safe, but if a reviewer can construct
  a legitimate asymmetry it would be a false stale.

- **No sqllogic coverage.** All of this is catalog/runtime state (`derivation.stale`,
  object identity of function schemas) that a `.sqllogic` file cannot observe, so the
  coverage is a `.spec.ts`. The value assertions (`30/30` vs `2/2`) *could* live in
  sqllogic, but only the spec can register the replacement function.

## Tripwires parked

- `database-materialized-views.ts` ~ the `applyBodyFunctionDrift` call site — a `NOTE:`
  recording that the drift check runs after `buildMaintenancePlan` and discards the
  just-built plan, why it cannot move earlier (the eligibility gate must run on every
  registration), and what to do if a workload ever re-registers drifted views in bulk.

- `docs/materialized-views.md` is **291 words** from the 12000-word cap that
  `yarn docs:check` enforces with no grace band (this change added roughly 120 of them).
  Not parked as a code `NOTE:` because `docs:check` prints the warning on every run — the
  next person to add a section there will be told. Flagged here so it is not a surprise.
