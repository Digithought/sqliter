description: The persistent storage backend can now answer "this account, all months before June" by reading only the matching rows instead of every row for that account.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts         # indexRangeAtPositionIsOrderSafe + leading-column wrapper
  - packages/quereus-store/src/common/store-module-access-plan.ts  # tryIndexAccessPlan: the prefixRange arm, ARM_SELECTIVITY
  - packages/quereus-store/src/common/store-table-scan.ts          # analyzeIndexAccess / buildPrefixRangeWindow / buildIndexRangeBounds
  - packages/quereus-store/test/pushdown.spec.ts                   # "prefix-equality + trailing-range seek" describe
  - packages/quereus-store/README.md                               # "Which predicate shapes become a seek" table
  - docs/optimizer.md                                              # multi-value-IN sentence corrected during review
----

# Store prefix-equality + trailing-range index seeks

## What shipped

A store-backed table with an index on `(a, b)` and a predicate `a = ? and b <op> ?` used to
seek only the `a` prefix and re-filter every index entry under it. It now seeks the byte
window `prefix || bound`. Answers were already correct before the change (the residual
`Filter` was retained), so this is speed only.

The engine half (`rule-select-access-path`'s `plan=7` / `prefixRangeSeek`) and the in-memory
vtab's advertisement already existed and are unchanged. Three store-side pieces now agree:

- **Soundness gate** (`pk-key-resolution.ts`) — `indexLeadingRangeIsOrderSafe` became a thin
  wrapper over the generalized `indexRangeAtPositionIsOrderSafe(…, position)`; both decision
  sites ask it at the position they are actually bounding. No behavioral change at position 0.
- **Plan half** (`tryIndexAccessPlan`) — a three-way `IndexArm` (`eq | range | prefixRange`).
  `prefixRange` fires when the contiguous equality prefix is a strict, non-empty prefix of the
  index columns, the next index column carries a bound, and the prefix is single-valued. It
  advertises `setSeekColumns([...eqCols, trailingCol])` and claims the prefix equality roles
  plus the first lower and first upper bound on the trailing column.
- **Scan half** (`analyzeIndexAccess`) — reads `prefixLen` off the `plan=7` idxStr (never
  re-inferred) and builds one composite window. `buildIndexRangeBounds` now takes a fixed
  `prefixValues` ahead of the bounded column plus the index's per-column direction, collation
  and transform arrays; the empty-prefix call reproduces the old leading-column behavior.

## Review findings

### Verification run

`yarn build`, `yarn lint`, `yarn test` (9314 + 725 + 386 + 1625 + … passing, **0 failing**)
and `yarn test:store` (9306 passing, 0 failing) all pass. The last two are the runs the
implement stage deferred on budget; both are clean, so the "unmeasured risk" the handoff
flagged is now measured.

`yarn docs:check` reports one failure — `docs/module-authoring.md` at 12001 words against a
12000-word cap. It is red at `main` independent of this change and is already tracked by
backlog `debt-store-and-module-authoring-docs-at-word-cap`, so it is not re-reported here.

### Soundness — the part the ticket asked to prove

The controlling invariant is that `matchesFilters` ANDs **every** pushed constraint on both
the index-scan path and the full-scan path. So any window that comes out too WIDE — including
`analyzeIndexAccess` returning null entirely — still returns the right rows; only a window
that comes out too NARROW can move a row. Three things can narrow a window, and each is
gated:

- **Prefix bytes addressing the wrong columns.** `prefixLen` is read from the idxStr and
  throws `INTERNAL` outside `1 … index.columns.length - 1`; the caller additionally requires
  `prefixLen <= eqValues.length`, so a semantic probe that cut the prefix short drops the
  trailing bound instead of pairing it with the wrong column.
- **Trailing bound whose bytes do not order as the residual compares.** Gated by
  `indexRangeAtPositionIsOrderSafe`. Re-derived both predicates: at a given position that
  gate is strictly stronger than `indexPrefixSeekIsCollationExact` (same semantic and
  collation-agreement checks, plus `orderPreserving`), so the arm's combined gate — exactness
  over the pinned prefix, order-safety at the bound — is sufficient. The prefix columns need
  no order guarantee because they are pinned to one value each.
- **A bound value with no faithful byte position** under a semantic type. Skipped, which
  widens.

The MAX-lower / MIN-upper clamping starts from the prefix's own `[P, incr(P))` window, so
every skip lands back on the prefix window and never wider. Checked the all-`0xff` overflow
cases on both sides: an `undefined` endpoint is skipped, leaving that side at the prefix's own
bound. Confirmed the plan and scan degrade in the same direction at the same position.

**Over-claiming** — `claimFirstPerRole` gives the `prefixRange` arm the prefix equalities plus
the FIRST lower and FIRST upper on the trailing column; a second same-side bound stays
unclaimed. Verified the engine's `reattachUnconsumedConstraints` is a second net under all of
this: any filter a module claims that the rule does not turn into a seek key comes back as a
residual `Filter`. That covers the case where the store advertises the composite seek columns
and the rule then picks a different arm.

**DESC** — re-derived the swap table. Only `directions[position]` (the bounded column) drives
the lower/upper swap; a DESC prefix column inverts bytes inside a prefix that stays fixed, so
it cannot reach the swap. Both cases have tests.

**Interactions** — `quereus-isolation`'s `buildConstraintMatcher` already names
`prefixRangeSeek` and handles it through its generic EQ-plus-ranges branch, so an overlaid
table re-applies the same window to its staged rows. Nothing downstream branches on the
`IndexAccessPattern` tag, so returning `'range'` for the composite window is descriptive only.

### Minor findings — fixed in this pass

- **The arm firing was untested.** Every row assertion in the new describe passes just as well
  if the arm silently stops firing and falls back to the plain prefix seek. Added a
  `planProperties` helper (reads `query_plan()`'s `properties`, which carries
  `filterInfo.usableIndex`) and four assertions: `plan=7;prefixLen=1` for the two-column
  index, `prefixLen=2` for the three-column one, the arm surviving a redundant same-side
  bound, and NO `plan=7` for a multi-value `IN` prefix.
- **A bound on a column past the prefix successor was untested.** Added a case over
  `(a, b, c)` with `a = 1 and c >= 30`: rows correct, no `plan=7`.
- **The unfaithful-semantic-probe path on the trailing column was untested** (the handoff
  named this gap). Added a TIMESPAN trailing column compared against a numeric probe, checked
  against the memory module as an oracle across three predicates.
- **`docs/optimizer.md` stated a counterfactual as an observed plan.** It said `a in (1, 2)
  and b > 15` over `(a, b)` "declines to a sequential scan with both predicates as residuals";
  what actually happens is an `IN` multi-seek with `b` residual, because both built-in modules
  decline the prefix-range arm for a multi-value prefix. Rewritten to say that the sequential
  scan is what a module advertising the bad shape would get. (+12 words; the doc is now 11977
  of 12000, so this was as much as it could take.)
- **The implementer's open question — should a missing trailing bound be fail-loud?** Judged
  no, and recorded the reasoning as a `NOTE:` at the site: it is as structurally impossible as
  a bad `prefixLen`, but the two fail differently. A wrong `prefixLen` addresses the wrong
  columns and under-fetches; a missing bound only fails to narrow. Loud for the first, soft
  for the second, is the right split.

### Tripwires — recorded, not ticketed

- **Missing trailing bound stays soft** — `NOTE:` in `store-table-scan.ts`
  (`buildPrefixRangeWindow`). Revisit if that silence ever hides a real plan/scan disagreement.
- **Cost mis-ranking across two indexes** — the pre-existing `NOTE:` at `ARM_SELECTIVITY`
  (`store-module-access-plan.ts`). Verified the arithmetic: `prefixRange` prices at
  `0.2 + 0.075N`, `eq` at `0.3 + 0.03N`, so a schema carrying BOTH `(a)` and `(a, b)` picks
  the `(a)`-only seek for `a = ? and b > ?` past roughly 2 rows. Answers unaffected; the
  ticket's guidance was explicitly to place `prefixRange` between the two existing factors.
  The NOTE's stated revisit condition ("if one shows up as a slow plan") has not tripped, so
  it stays declined.

### Findings routed to existing tickets rather than new ones

- `store-table-scan.ts` grew 1023 → **1251 lines** (`wc -l`). Already an arm of backlog
  `debt-oversized-source-files`; updated its measured line count rather than filing again.
- `docs/module-authoring.md` documents the `plan=5` multi-seek runtime shape a module gets
  back but has no equivalent for `plan=7`'s `prefixLen`. The paragraph cannot be written today
  because the doc is over its word cap — appended as an arm to backlog
  `debt-store-and-module-authoring-docs-at-word-cap`, along with `docs/optimizer.md` now
  sitting 23 words from the same cap.

### Major findings

**None.** No wrong-answer path was found; the widen-only degradation argument holds at every
branch, and the two deferred test suites are green.

### Known gap left open, deliberately

The fail-loud `prefixLen` throw is still untested — reaching it needs a hand-built
`FilterInfo` and the spec has no harness for constructing one. Building that harness is more
machinery than the three-line guard warrants, and every path that would produce a bad
`prefixLen` is engine-side and covered by `packages/quereus/test/vtab/idx-str.spec.ts`.
Ordering remains deliberately unadvertised for this arm (matching the existing index arms), so
`order by b` keeps its `Sort` — out of scope per the plan ticket.
`bug-store-pk-range-preempts-cheaper-index` was left untouched as instructed; every new test
uses a table whose primary key is absent from the predicate.
