---
description: A materialized view whose saved rows were computed with one version of a SQL function is now flagged as out of date when the application swaps that function for a different one, instead of quietly mixing old and new results in the same table.
files:
  - packages/quereus/src/planner/analysis/mv-body-functions.ts       # detectBodyFunctionDrift
  - packages/quereus/src/core/database-materialized-views.ts         # RegisterMaterializedViewOptions, registerMaterializedView, applyBodyFunctionDrift
  - packages/quereus/src/core/database.ts                            # public wrapper (returns boolean)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # refresh passes backingRecomputed
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # restoreMaterializedViewLive + tryRecompileMaterializedViewLive honour the drift flag
  - packages/quereus/test/mv-function-drift.spec.ts                  # 18 tests
  - docs/mv-schema-change.md                                         # "## Body-function drift"
  - docs/materialized-views.md                                       # § Function identity
  - docs/schema.md                                                   # bodyFunctions bullet
  - docs/invariants.md                                               # MV-022
---

# Body-function drift marks a materialized view stale

## What shipped

A materialized view's saved (backing) table is kept current by a maintenance plan compiled
**once**, at registration, against the function registrations live at that moment. Some
operations re-register the view and recompile that plan against whatever is registered
*now*. If the application replaced one of its own functions in between, maintenance used to
switch silently to the new implementation while the already-saved rows came from the old
one — one table holding two functions' answers, nothing marking which is which.

Registration now compares the previous registration's capture of the body's functions
(`TableDerivation.bodyFunctions`) against the freshly resolved one **by object identity**
(`detectBodyFunctionDrift`) and marks the view **stale** on any difference. Stale is the
engine's existing "the saved rows are behind their definition" state: the read-side rewrite
declines (queries recompute from the base tables), row-time maintenance detaches, and
`refresh materialized view` re-derives every row under the new meaning.

`registerMaterializedView` returns `true` when it staled the view that way; every caller
that clears `stale` afterwards, or that reports the view as still live, honours it.
`RegisterMaterializedViewOptions.backingRecomputed` suppresses the check for the one caller
whose rows were re-derived immediately beforehand (`REFRESH`).

Marking stale rather than rebuilding is deliberate: a rebuild inside
`registerMaterializedView` would put a full recompute — and therefore a query — inside a
DDL path that today only compiles, making `alter table … rename` unexpectedly expensive.

Detection is **within-session only** — object identity cannot cross a process boundary, so
a reopen registers against a fresh derivation with no prior capture. Stated in
`docs/mv-schema-change.md` § Body-function drift and `docs/materialized-views.md`
§ Function identity.

## Review findings

Reviewed the implement diff (`66ed3918a`) before its handoff summary. Classified all nine
`registerMaterializedView` call sites by whether they leave the stored rows alone, checked
both sites in the tree that clear `stale`, re-derived the drift-detection semantics
(union-of-keys, object identity, the variadic `-1` resolution fallback, key-set stability
across a body rewrite), and read every doc the change touched plus the ones it did not.

### Fixed in this pass

- **`tryRecompileMaterializedViewLive` reported a staled view as live.**
  (`materialized-view-helpers.ts`.) On the in-place recompile path, registration detects
  drift, marks the MV stale, and releases the plan it just built — but the function still
  returned `true` and logged "Recompiled … in place". `true` is what the schema-change
  listener reads as "kept live, skip the stale path", and two comments (the function's own
  gate list, the listener's call site) asserted the then-false "on success `stale` is
  untouched and no backing invalidation fires". The outcome happened to be correct, because
  the stale transition had already been applied; the *contract* was not. Now declines on
  drift, so `true` ⇔ the MV is live afterwards. Cost is one duplicate, idempotent backing
  invalidation on a rare path, noted at the site. Both comments corrected; gate 6 added to
  the function's documented gate list.

- **The `backingRecomputed` suppression had no regression test.** The handoff's REFRESH test
  runs *after* a rename, which has already advanced the capture — so no drift would have
  fired there with or without the flag. Added a test where REFRESH is the **first**
  re-registration after the replacement. Verified load-bearing: dropping the flag makes it
  fail with the exact hazard the flag prevents — registration releases the plan it just
  built, `stale = false` immediately after leaves a live-flagged view with no maintenance,
  and the next insert silently does not propagate.

- **The in-place recompile path had no test, and the obvious repro would not have reached
  it.** Replacing the aggregate `sum/1` also shifts the backing's declared column type
  (NUMERIC → INTEGER), so `alter table t add column` declines at the earlier *shape* gate
  and stales the view for an unrelated reason — a test written that way passes with drift
  detection entirely disabled. Rebuilt on the scalar `bump/1` fixture, whose declared result
  type does not move; verified load-bearing (fails with the drift check short-circuited).

- **`docs/invariants.md` MV-022 did not mention drift.** It read as "a source schema change
  a body cannot observe recompiles in place; anything else marks it stale" — now false in
  both halves. Amended, within `docs:check`'s one-`guard:`/120-word limits, and
  `docs/mv-schema-change.md`'s recompile section now links drift as a fallback cause.

- **Test DRY.** The scalar `bump/1` fixture was inline in one test and needed by a second;
  extracted to `registerBump(db, delta)` / `buildScalarFixture`.

### Parked as a tripwire

- `database-materialized-views.ts`, at the `bodyFunctions` capture — a `NOTE:` recording
  that advancing the capture unconditionally means that on the drift path it describes the
  *newly resolved* functions rather than the ones that produced the stored rows, so the
  read-side identity gate stops independently vouching for those rows and `stale` becomes
  their only guard. Sound today (the only two sites that clear `stale` are REFRESH, which
  re-derives first, and the rename-restore tail, which honours the flag). Revisit condition
  stated: a third `stale = false` site, or the read-side gate ever being asked to stand
  alone. Not a defect — no path reaches the bad state — so not a ticket.

### Examined and left alone

- **The attach-rollback path** (`restorePrior`, after a failed `set maintained as`) ignores
  the returned boolean, as the handoff flagged. Read it: drift there re-registers the prior
  derivation, marks it stale, releases its plan, and nothing downstream clears the flag —
  fail-safe and correct. Reaching it needs a `set maintained as` failure interleaved with a
  function replacement; not worth a fixture, and there is no wrong behaviour to guard.

- **Union-of-keys conservatism.** The handoff invited an attempt to construct a legitimate
  asymmetry between the two key sets. I could not: both captures walk the same body AST, and
  a rename rewrites column references without moving any function name or arity. Left as is.

- **The reopen limit.** Not re-litigated and not filed. It is inherent to object identity,
  documented in two places, and a persisted weaker witness ("this body function was the
  built-in") is a *should we do this at all* design question — that belongs in `blocked/`
  with a human, not in `backlog/`, and nothing here established it is wanted.

### No findings

- **Resource cleanup / error handling.** The drift path adds no resource. Every throw site
  in registration leaves the capture advanced with the prior one lost — checked each
  throwing caller, and all of them end with the view stale, so the lost capture never
  affects a decision.
- **Type safety.** No `any`, no non-null assertion, the new option is `readonly` and
  compared with `=== true`.
- **Source hygiene.** No file crossed a size gate (`docs:check` reports sizes within
  ratchet); the new function is 12 lines and single-purpose; comment density matches the
  surrounding files, which are heavily commented by house style.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn typecheck` — clean across all workspaces.
- `yarn workspace @quereus/quereus run test` — 10231 passing, 25 pending, 0 failing (4m).
- All other workspaces (`yarn workspaces foreach … run test`, excluding quereus) — passing,
  0 failing (6m 3s).
- `yarn docs:check` — "Docs OK: links resolve, invariants well-formed, sizes within ratchet,
  doc and package tiers declared."
- `mv-function-drift.spec.ts` — 18 tests (13 behavioural + 5 unit), all passing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Known limits carried forward

- Drift detection is **within-session**: a reopen has no prior capture, so a function
  replaced before catalog import is not detected. Documented, deliberate.
- `docs/materialized-views.md` sits **291 words** from the 12000-word cap `docs:check`
  enforces with no grace band. `docs:check` prints the warning on every run, so the next
  person to add a section there will be told.
