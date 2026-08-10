---
description: Writing through a view could wrongly reject the statement, or change the wrong rows, when a sub-query read a table living outside the default schema; the planner's pre-write check now looks tables up the same way the query itself does.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts        # tableSourceColumnNames, fromResolutionContext, transformScopedQuery
  - packages/quereus/src/planner/mutation/cte-flatten.ts            # baseColumnsOf
  - packages/quereus/test/view-home-schema.spec.ts                  # 12 new cases across two describes
  - docs/view-updateability.md                                      # § Schema resolution during write-through
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt — the plan-time twin (unchanged)
  - packages/quereus/src/planner/building/select-context.ts         # enterStoredBodyEnv — the plan-time twin (unchanged)
---

# What shipped

Before a write through a view is lowered onto its base table, the planner runs a
static pass over every sub-query in the statement, asking per `from` source "which
columns does this source have?". That shadow set decides, per column reference
inside the sub-query, whether the reference is local to the sub-query or reaches
outward to the view's row.

That lookup used to resolve a source's name in **one fixed schema** (the
connection's current schema, normally `main`) while the plan that actually
executes resolves the same names through the session schema path — and, for a
fragment copied out of a view's own definition, through the view's home
environment. Analysis and plan disagreed, and the disagreement was not
conservative: the statement was either rejected outright or silently rewritten to
touch a different row set than the matching read returns.

Now both halves resolve identically:

- `tableSourceColumnNames` (`planner/mutation/scope-transform.ts`) resolves through
  `SchemaManager.findSchemaItem` against `ctx.schemaPath` — the same primitive
  `building/select.ts`'s FROM branch uses, with the same table/view precedence.
- `fromResolutionContext` (same file) re-enters a stamped fragment's environment
  before that lookup: `storedBodyContext` on the view's home schema → the body's
  declared `with schema` path → the fragment's own `with schema` clause. Same order
  and precedence as `enterStoredBodyEnv` + `buildSelectStmt`. That environment is
  now also **threaded into the nested / compound-leg descents** (review fix below),
  so a sub-query nested inside a `select … with schema` inherits the enclosing
  clause's path exactly as the plan does.
- `baseColumnsOf` (`planner/mutation/cte-flatten.ts`) uses `findTable` against
  `ctx.schemaPath`. That target is **ephemeral**, so no home-schema swap — the
  caller's path is the right environment.

`docs/view-updateability.md` § Schema resolution during write-through carries the
static half of the rule, including the threading and the one place the analysis
stays weaker than the plan (a fragment naming a body-local `with` block).

# Review findings

## Checked

The implement diff read first, against the plan-time twins it claims to mirror
(`buildSelectStmt` / `enterStoredBodyEnv` / `buildCompoundSelect`), against
`SchemaManager.findSchemaItem` / `findTable` / `getSchemaItem` semantics, and
against all three callers of the shared descent (`single-source.ts`,
`multi-source.ts`, `lens-enforcement.ts`). Every open question the handoff listed
was chased to an answer. Ran `yarn lint` (whole workspace), `yarn test` (whole
workspace), `yarn docs:check`, and per-case discrimination re-runs.

## Major — one real defect found, fixed in this pass

**The analysis did not thread its resolution environment down the descent.**
`transformScopedQuery` re-derived each select's environment from the descent's
entry context, so a sub-query nested inside a sub-query carrying its own
`with schema` clause resolved its `from` names on the writing statement's path
instead of the enclosing clause's. Plan time inherits (the context flows into
everything `buildSelectStmt` builds), so this is the same analysis-vs-plan
divergence the ticket set out to close, one nesting level down — and reachable
today with a hand-written statement, no view definition needed.

Reproduced before fixing: under `schema_path = 'main,temp'` with `q` in both
schemas and only `temp.q` carrying an `id`, the read through the view matched both
rows while `update … where exists (select 1 from anchor where exists (select 1
from q where id = 1) with schema "temp", main)` wrote only one — a silent row-set
divergence, no error. Fixed by deriving each select's context from the enclosing
select's (`fromCtx` threaded into `onNested` and `onLeg`); the at-home guard makes
the inherited stamp inert, matching `enterStoredBodyEnv` inside an already-swapped
fragment. Compound legs take the same context because the parser suppresses a
leg's own `with schema` clause and `buildCompoundSelect` builds every leg on the
enclosing select's context. Pinned by a new test, verified to fail without the
fix.

No other major finding: no new ticket was filed for this ticket's subject matter.

## Minor — fixed in this pass

- **Coverage: multi-source (join) spine had no test.** The handoff flagged it as
  unpinned. Added one — a join-bodied view in `temp` under a session path with a
  user sub-query over a path-reached source. Confirmed it fails against the
  pre-fix lookup, so it discriminates rather than merely passing.
- **Coverage: the declared-path case was isolated only by a same-name shadow.**
  The handoff noted a reviewer with a third schema could pin it directly. There is
  one — `declare schema aux { … }` + `apply schema aux`. Added a case whose
  sub-query source lives *only* in `aux`, unreachable from the view's home path, so
  a missed step 2 is a total miss rather than a mis-sizing. Verified it fails with
  the declared-path step removed.
- **Wrong `{@link}` target** in `cte-flatten.ts`'s `baseColumnsOf` doc: it pointed
  at `collectFromColumnNames` when the fixed lookup lives in `tableSourceColumnNames`.
  Repointed.
- **Comment volume.** Two of the new doc blocks restated `docs/view-updateability.md`
  at length. Trimmed ~16 lines across `tableSourceColumnNames` and
  `fromResolutionContext` with no fact dropped — the ordered steps, the
  "both halves must change together" invariant, and both `NOTE:` tripwires stay.

## Checked and found correct (no change)

- **The table-vs-view precedence flip is safe and now matches the plan.**
  `findSchemaItem` prefers a view within a schema; the replaced code preferred a
  table. Verified empirically that the two cannot collide — `Schema.addView`
  rejects `create view x` when table `x` exists, and `create table x` rejects the
  converse — and that `building/select.ts`'s FROM branch calls the identical
  primitive, so the analysis now matches plan-time precedence by construction
  rather than by luck.
- **The handoff's open question about the top-level predicate spelling
  (`update v set … where <computed col> = 'literal'`) is a non-issue.** That form
  has no sub-query, so there is no second scope and no shadow question to answer:
  the reference is substituted directly against the view's column map with an
  empty shadow set. The analysis is not silently skipping work there.
- `scope-transform.ts` at 843 lines is mid-pack for `planner/mutation/` (siblings
  run 960–3311); no size finding.

## Tripwires (recorded, not filed)

- The `committed.` pseudo-schema is not intercepted by this analysis the way
  `resolveTableSchema` intercepts it at plan time, so such a source taints rather
  than resolving. Unchanged by this work and unreachable unless someone writes
  through a view whose sub-query names a `committed.`-qualified source. Already
  parked as a `NOTE:` on `tableSourceColumnNames` — reviewed and left there.
- A stamped fragment naming a **body-local** `with` block resolves to nothing,
  because `storedBodyContext` clears the CTE namespace and this pass has no plan
  nodes to rebuild one from. Not a regression, nothing reaches it today, pinned by
  a test and documented at `fromResolutionContext` and in
  `docs/view-updateability.md`. Reviewed and left as a tripwire.

## Validation

- `yarn lint` (workspace-wide): clean.
- `yarn test` (workspace-wide): all packages green. `packages/quereus` **8528
  passing / 0 failing** (8525 at the implement commit, +3 review tests).
- `yarn docs:check`: one failure, `docs/schema.md` word-count ratchet — untouched
  by this work and already recorded in `tickets/.pre-existing-known.md` against
  `debt-doc-size-ratchet-red-at-head`. Not re-reported.
- Every new test verified **discriminating**, not merely passing: each was re-run
  against a temporarily reverted fix (fixed-schema lookup / dropped declared-path
  step) and observed to fail.

# Filed separately (by the implement stage, still open)

`tickets/fix/bug-correlated-subquery-cannot-read-outer-computed-column.md` — an
unrelated pre-existing runtime defect found while building this ticket's test
oracle: a correlated sub-query referencing an outer **computed** projection column
fails with `No row context found for column …`. Two tests here spell their oracle
against base tables because of it, with a comment pointing at that ticket.
