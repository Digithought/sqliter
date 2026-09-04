description: The query planner used to compare an index seek's price against a whole-table read priced from a different guess at the table's size, so on tables nobody had measured the index lost and the same condition got checked twice on every row; both prices now come from the storage backend itself.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts        # `baselineScanCost` (~730) + the reworked veto (~556)
  - packages/quereus/test/optimizer/seek-vs-scan-baseline.spec.ts            # 11 cases
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # corrected NOTE on the rebuild redundancy (~275)
  - docs/optimizer-costing.md                                               # "Where a module's own size fits"
  - docs/optimizer-retrieve.md                                              # "Key properties"
  - docs/module-authoring.md                                                # `getBestAccessPlan` purity/cheapness contract
----

# Complete: seek-versus-scan baseline is quoted by the module

## What landed

`rule-grow-retrieve`'s index-style fallback (`fallbackIndexSupports`) decides whether to push
a predicate into a storage backend's index by comparing the backend's quoted seek cost against
a whole-table baseline. The two numbers came from different places, and therefore from
different table sizes: the seek was priced by the module (which may keep a live row count),
the baseline by the engine's `seqScanCost(request.estimatedRows ?? 1000)` over the *catalog's*
number — `undefined` when nobody ran `ANALYZE`, a stale `0` when `ANALYZE` ran before the table
was filled. Where they disagreed the honest seek lost to a fabricated scan, the push-down was
declined, and the predicate was re-enforced in a `Filter` above the seek that had already
bounded the rows.

The baseline is now a second probe of the **same module**: same request with `filters`,
`requiredOrdering`, `limit` and `offset` stripped (`baselineScanCost`). Symmetric by
construction, no new module interface, and nothing re-fabricates 1000 onto the request.
`seqScanCost` survives only as the fallback for a module answering a non-finite cost. The
probe sits inside the `!providesOrdering` branch — the only branch that reads it.

Landed across three commits: `822a17a94` (implement), `f6a57a24f` (the interrupted review
pass's edits, swept into the runner's resume commit), and this one.

## Review findings

**Checked:** the implement diff read before the handoff summary; the interrupted prior review
run's log and its committed edits; the current text of every touched source and doc file; the
three in-repo `getBestAccessPlan` implementors (memory, store, isolation) for purity and cost
symmetry; every other `seqScanCost` caller for the same asymmetry; request-object aliasing
across the two probes; `tickets/backlog/debt-oversized-source-files.md` for a size claim on the
touched file; full validation (`docs:check`, `lint`, `build`, `typecheck`, `bench:gate`,
`test`).

**Resumed work (the prior run's findings, verified rather than re-derived).** The interrupted
run had already found the substantive defect — declining the push-down does *not* produce the
sequential scan the veto assumes, because `rule-predicate-pushdown` then absorbs the predicate
and `ruleSelectAccessPath` rebuilds the identical seek with the Filter re-stacked above it — and
had filed it as `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter`, corrected the
too-narrow reachability claim in `rule-select-access-path`'s NOTE, added the code NOTE at the
veto, pinned the wrong shape in a test, and documented the `getBestAccessPlan` purity contract
in `docs/module-authoring.md`. I read all of it against the current tree and confirm it is
accurate and correctly filed; I did not re-file or re-litigate it.

**Minor — fixed in this pass:**

- *Test gap: the fix's load-bearing property was only asserted indirectly.* Every existing case
  proved the veto reaches the right **verdict**, none proved **how** — a refactor that left
  `filters` or `requiredOrdering` on the baseline probe, or fetched a baseline on the branch
  that never reads one, would have passed the whole spec. Added two cases in a new
  `the baseline is a second probe of the same module` block: one asserting exactly one
  filter-free/ordering-free/limit-free probe reaches the module carrying the same
  `estimatedRows` as the seek probe, one asserting an ordering-providing plan fetches no
  baseline at all. Both were mutation-checked: un-stripping `filters` from `baselineScanCost`
  fails 7 cases (the new one included), and hoisting the probe out of the `!providesOrdering`
  branch fails the second. Spec now 11 cases. This closes the implementer's own "the
  `!providesOrdering` restructure is mine, not the ticket's" and "ordering-providing plans no
  longer fetch a baseline at all — no test guards that" gaps.
- *Source hygiene: a comment orphaned from its statement.* The prior pass's `ask` binding was
  inserted between the "Get access plan from module…" comment and the `probeAccessPlan` call it
  describes. Moved the comment back onto its statement.
- *Doc nit:* a ragged line wrap in the `docs/optimizer-retrieve.md` bullet, from an edit that
  spliced a sentence mid-line.

**Major — none found, and the one candidate was already filed.** The seek-versus-scan veto
being wrong to decline at all is the real architectural finding here, and it is exactly what
`bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter` says, with both remedies
(make the decline stick, or drop the check) laid out. Nothing new rises to that bar. The class
this fix belongs to — "an engine-modelled number compared against a module-quoted one" — is
closed, not merely patched at one site: `ruleSelectAccessPath` passes `accessPlan.cost` into
both its index and its sequential branch, so it never mixes the two, and the remaining
`seqScanCost` callers (`rule-materialized-view-rewrite`,
`database-materialized-views-plan-builders`) compare engine-modelled against engine-modelled.

**Considered and declined — left alone, correctly:** `createSeqScan`'s `tableRef.estimatedRows
|| 1000` in `rule-select-access-path.ts:1246` carries a NOTE saying it feeds the engine's own
model rather than a comparison with a module number, and is tracked as
`bug-measured-empty-table-costed-as-thousand-rows`. Its revisit condition has not tripped.

**Tripwires — one pre-existing, none added.** The `NOTE:` in `baselineScanCost`'s doc comment
(one extra `getBestAccessPlan` call per grow attempt that reaches the veto; memoize per table
per optimizer pass if it ever shows up in a profile) was placed by the implementer and is
confirmed accurate — both real implementors are cheap: the store module's is a map lookup plus
a pure computation, and the isolation module delegates.

**Not filed, deliberately:** `rule-grow-retrieve.ts` is 961 lines (`wc -l`), grown 92 by this
theme. `debt-oversized-source-files.md` uses a ~1,000-line threshold and does not list this
file; it is under, so no arm was appended — but it is close, and the next feature in this rule
should split it. Separately, `yarn docs:check` warns that `docs/module-authoring.md` is 367
words from its 12,000-word cap (this theme added ~120). That warning *is* the tripwire — the
tool re-emits it on every run — so it gets no ticket.

## Validation

All from a clean tree at the reviewed state:

- `yarn docs:check` — "Docs OK: links resolve, invariants well-formed, sizes within ratchet"
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json` over the spec)
- `yarn build` — clean
- `yarn typecheck` — clean
- `yarn bench:gate` — **gate passed**; every gated counter matches the reference, all four
  ratio guards hold (`filtered-scan-index-10k / full-scan-10k = 0.01×`, max 0.1× — the guard
  that would catch index access collapsing to a full scan). `bench:accept` was **not** run and
  was not needed: `bench/reference/store.json` was already the pre-regression truth, so the
  gate's 12 differs at HEAD went green on their own.
- `yarn test` — green. `@quereus/quereus`: **10 393 passing, 0 failing, 25 pending**. All other
  workspaces green (`Done in 3m 2s`, 0 failing).

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps carried forward

Honest, and none of them blocking:

- **The spec's module is a stand-in.** `SelfSizingMemoryModule` reproduces `quereus-store`'s
  `sizeRequestFromLiveCount` behavior (including its stale-`0` override) but is not the store.
  The real store path is covered by the bench gate only. A durable store-side assertion in
  `packages/quereus-store/test/` would close this; judged not worth the duplication.
- **The non-finite-cost fallback is untested.** `BestAccessPlanResult.cost` is a required
  `number`, so the branch should be unreachable; it exists so a module answering `NaN` degrades
  to the old behavior rather than vetoing on a `NaN` comparison.
- **The break-even is measured, not derived.** The spec straddles it (1000 below, 8000/10000/50000
  above) rather than asserting the cost constants themselves, so a constant change that slides
  the flip cannot leave the suite green for the wrong reason.
- **The decline branch is still pathological**, by design of this ticket's scope — tracked as
  `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter`, whose expected-behavior
  section names the two acceptable fixes. The spec pins today's wrong shape with a comment
  saying which assertion flips when that lands.

## Follow-on ticket filed

`tickets/backlog/bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter.md` — filed by
the prior review pass, reviewed and left as written.

## Note for `feat-memory-backend-sizes-itself`

That backlog ticket would make the default in-memory backend report its real size the way the
store does, which would have landed this exact bug on the backend the whole suite runs on. This
fix pre-empts it — the asymmetry is closed — and `SelfSizingMemoryModule` is a working preview
of what that change makes the real module do.
