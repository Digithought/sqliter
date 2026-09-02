description: A plan-time LIMIT now reaches the storage module, so an ungrouped MIN/MAX over an indexed column is priced as the one row it reads rather than as an ordered read of the whole table. Reviewed, with three fixes applied and one follow-up filed.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts        # RowsWanted, truncationIsSafe, probeAccessPlan
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # the one caller that passes a bound
  - packages/quereus/src/vtab/best-access-plan.ts                            # the tightened `limit` contract
  - packages/quereus-store/src/common/store-module-access-plan.ts            # rowsToProduce, applied to seek arms / ordering walk / full scan
  - packages/quereus-store/test/plan-time-limit.spec.ts                      # cost-profile-parameterized, 13 cases
  - packages/quereus/test/optimizer/plan-time-limit-truncation-safety.spec.ts # new — direct pin on the safety gate
  - docs/module-authoring.md, docs/optimizer.md, docs/plugins.md
----

# Complete: plan-time LIMIT reaching the module

Implements and reviews `feat-sort-absorb-blind-to-limit`. GitHub #31 is the live report.
The engine half of GitHub #30's theme (the store's real per-row cost reaching the
planner) was deliberately out of scope and stays that way.

## What shipped

An ungrouped `min(c)` / `max(c)` is rewritten by `ruleMinMaxIndexBoundary` into an
ordered read with a `LimitOffset(1)` on top. It probes the module first, through
`trySortAbsorbViaIndexOrdering`, and that probe used to carry no limit — so the module
answered "what does an ordered read of the whole table cost?". A backend whose random row
reads are expensive answers, correctly, that scanning and sorting is cheaper, and the
boundary read is priced out.

- `trySortAbsorbViaIndexOrdering` takes an optional `RowsWanted`; the minmax rule passes
  `{ limit: 1, offset: 0 }`. `ruleGrowRetrieve`'s own Sort call site passes nothing.
- `BestAccessPlanRequest.limit` is now documented — and enforced — as a licence to stop
  early rather than a hint. It is populated only when `truncationIsSafe` shows that every
  conjunct of every Filter between the module's scan and the LIMIT is covered by a
  constraint the access plan reported handled.
- `probeAccessPlan` (added in review) is the single funnel every limit-carrying probe
  goes through: it sends the bound, validates the plan that comes back, and re-probes
  without the bound when validation fails. Probing limit-free first cannot work — that is
  exactly the probe that fails today.
- The store consumes it in `rowsToProduce`, gated on the same two conditions, applied to
  the single-window seek arms, the ordering walk and the full scan alike.

## Review findings

Read the implement diff (`47b92eff6`) before the handoff summary. Everything below was
checked at the code, not inferred from the handoff.

### Fixed in this pass (minor)

- **`truncationIsSafe` accepted a partially-claimed multi-constraint expression.** One
  expression can yield several constraints — a `BETWEEN` yields its `>=` and its `<=`
  from the same node, and `pushed-constraints-recorded.spec.ts` already pins that they
  share one `sourceExpression`. The store's `claimFirstPerRole` can claim them
  independently (`where b > 0 and b between 1 and 5` takes the earlier `b > 0` as the
  lower bound and only the BETWEEN's upper half), and `assembleResidual` then puts the
  whole BETWEEN back in the residual Filter. The safety check added the expression to its
  claimed set off the handled half alone, so it licensed a truncation the surviving
  Filter can still underproduce. Fixed by mirroring `assembleResidual` exactly: an
  expression covers a conjunct only when EVERY constraint it produced was claimed. Not
  observable in-tree — the store's own `rowsToProduce` gate declines separately — but a
  third-party module obeying the newly documented contract would have returned a wrong
  answer. Pinned by a new case that fails against the pre-fix code.
- **The handoff's reason for leaving `buildRequest`'s LimitOffset arm alone was wrong,
  and the arm is now consistent.** The claim was that the `Literal(null)` OFFSET refusal
  keeps `request.limit = limitVal` unreached. It does not: `limit 5 offset 0` supplies a
  numeric `Literal(0)` and reaches it (verified by reading `applyLimitOffset`). What
  actually keeps it rare is structural — the arm needs an already-equipped ordering and a
  LimitOffset sitting *directly* above the Retrieve, and a `select` list puts a Project in
  between; every end-to-end `order by … limit n offset 0` shape I ran answers correctly.
  Rather than document an inconsistency, that probe now goes through `probeAccessPlan`
  too, so no site can populate `limit` without the proof. The misleading comment was
  corrected.
- **Docs printed a stale contract in two more places.** `docs/optimizer.md` and
  `docs/plugins.md` both reprint `BestAccessPlanRequest` and showed a bare
  `limit?: number | null` with no `offset` — one canonical statement lives in
  `module-authoring.md`, and both now carry a one-line pointer to it plus the `offset`
  field. Separately, `module-authoring.md` described the *runtime* `FilterInfo.limit` as
  "a soft row cap" a few hundred lines below the new "a licence, not a hint" language for
  the plan-time field; the two are genuinely different and now say so.

### Verified, no change needed

- **The node-identity assumption holds.** `extractConstraintsForTable` never normalizes:
  it walks predicates and hands them to `extractConstraints`, whose AND recursion passes
  `binaryOp.left` / `binaryOp.right` through unchanged and stamps `sourceExpression: expr`
  on the same objects. `splitConjuncts` flattens on the same operator, so the leaves it
  yields are those objects. Confirmed by the safe-case test firing at all.
- **OR_RANGE fails closed, as expected.** An OR that is not extractable becomes a residual
  expression, never a constraint, so nothing claims it and the walk declines.
- **Subquery conservatism is only ever a decline.** The walk descends into every child and
  returns `false` on any Filter it cannot cover; there is no path on which descending
  further turns a decline into an accept.
- **`rows === 0` cannot be manufactured.** `rowsToProduce` floors at 1, and the engine's
  unsatisfiability fold additionally requires a non-empty, fully-claimed `handledFilters`.
  `limit: 0` yields `rows: 1`, priced as one row.
- **Nothing downstream reads the shrunk `rows` as a claim about the table.**
  `accessPlan.rows` feeds `makeFullScanFilterInfo`'s row estimate (a `LimitOffset` does
  sit above, so a small number is right) and a `maybeRows <= 10` gate that only applies
  where an equality already covers the primary key. `FilterInfo.limit`, the runtime cap,
  is populated by the limit-pushdown rules and not from the access plan, so the pricing
  cannot leak into a runtime truncation.

### Filed as a ticket (major)

- **`min` / `max` over a NULLABLE column still never reaches the boundary read** —
  `tickets/backlog/feat-store-claim-is-not-null-seek-bound.md`. The rewrite adds a
  `c is not null` filter when `c` is nullable (without it the boundary row could be a
  NULL and the aggregate would answer NULL). No store seek role claims `IS NOT NULL`, so
  a residual Filter survives, `truncationIsSafe` correctly withholds the bound, the module
  prices whole-table and vetoes — and the rewrite does not fire at all. Verified by
  running both shapes at `pointRead = 3.0`: the not-null column plans an `INDEXSEEK …
  USING ix_bc` under a `LIMITOFFSET`, the nullable one plans a primary-key scan with a
  Filter. Nullable is the SQL default, so the headline fix misses the common case. Filed
  at the highest rung that applies: the fix is one capability at one site (the store's
  seek-role vocabulary), not a point bug, and it retires the class for every query that
  needs a NULL-excluding bound. Existing `NOTE:` at `buildIsNotNull` updated to say so.

### Recorded as a tripwire, not a ticket

- **Shrinking `rows` to 1 flips `AccessPlanBuilder.eqMatch`'s `isSet`** (`matchedRows <= 1`)
  on a seek that matches many rows. Inert today — nothing in the engine reads
  `BestAccessPlanResult.isSet` — and arguably correct, since a leaf under a
  truncation-safe `limit 1` really does emit at most one row. But it is a uniqueness claim
  derived from a row cap rather than a key, so it is worth knowing about before anyone
  lifts `isSet` into `RelationType.isSet`. Parked as a `NOTE:` on `rowsToProduce`.

### Checked and empty

- **Resource cleanup**: nothing here allocates. `getBestAccessPlan` is pure at plan time,
  the extra probe holds nothing, and the new spec closes its `Database` and provider in
  `afterEach` like its neighbours.
- **Error handling**: no new failure modes — every new branch is a decline that falls back
  to the pre-existing behaviour.
- **File size**: `rule-grow-retrieve.ts` is 874 lines and `store-module-access-plan.ts`
  1641 (`wc -l`); both were already on `debt-oversized-source-files`, and this change adds
  ~50 and ~10 lines respectively. Not re-filed.
- **DRY**: `orderingAlreadySatisfied` in the store duplicates the engine's
  `orderingMatches`. Left alone deliberately — the engine's copy is a module-private
  function in a different package, and its own doc comment already names the twin.

### Test coverage added

The implementer's four listed gaps, closed except where noted:

- `packages/quereus/test/optimizer/plan-time-limit-truncation-safety.spec.ts` (new, 4
  cases) is the direct pin on the safety gate the handoff asked for. The shipped memory
  module ignores `request.limit`, so the decision is invisible on a stock table; these
  cases run against a module that serves the ordering cheaply *only* under a bound, which
  turns "the engine sent the limit" into an observable plan shape. Covers: every conjunct
  claimed (sends it), a conjunct left in the residual (withholds), only part of a
  multi-constraint expression claimed (withholds — the regression pin for the fix above),
  and an unextractable predicate that never becomes a constraint at all (withholds).
- `plan-time-limit.spec.ts` grew from 10 to 13 cases: the `range` arm repriced under a
  bound (the handoff covered only `eq`), `max` over a descending index end to end, and
  the nullable-column decline pinned as a named known limitation that should be rewritten
  — not deleted — when the follow-up ticket lands.
- `prefixRange` is still uncovered under a bound. It shares `seekingArm` with the two arms
  that are now covered, so the remaining risk is in how the arm is *selected*, not in the
  repricing.

### Validation

`yarn typecheck`, `yarn lint`, `node scripts/check-docs.mjs` clean.
`yarn test` green across all workspaces (exit 0; `workspaces foreach` fails fast, so that
is every package). `yarn test:store` green against the LevelDB store module: **10280
passing, 33 pending, exit 0** — the implementer's 10276 plus the 4 new engine cases.
No pre-existing failures surfaced.

## Not fixed, by design

A limit the *user* wrote still never reaches the module — it sits above the Sort, out of
reach of a rule that walks only downward. Tracked as
`backlog/feat-sort-absorb-blind-to-limit-general`.
