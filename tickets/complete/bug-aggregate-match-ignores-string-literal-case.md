description: When a query summarized data two ways that differed only in the capitalization of a quoted text value, and then filtered or sorted by one of them, the engine silently used the wrong summary and returned wrong rows, with no error. Fixed so quoted values keep their capitalization when the engine decides whether two summaries are the same.
files:
  - packages/quereus/src/emit/ast-stringify.ts                     # expressionToIdentityString (~line 531)
  - packages/quereus/src/planner/building/function-call.ts         # findMatchingAggregate
  - packages/quereus/src/planner/building/select-aggregates.ts     # dedupeNewAggregates; tripwire NOTE in createAggregateOutputScope
  - packages/quereus/src/planner/building/select-projections.ts    # collectInnerAggregates
  - packages/quereus/test/emit/ast-stringify.spec.ts               # new unit block (review)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic      # `wgl` block
  - packages/quereus/test/logic/07.5-window.sqllogic               # `wgc` block
  - docs/sql-select.md                                             # § 3.4 HAVING — aggregate-reuse rule (review)
  - docs/window-functions.md                                       # grouped-queries — window-spec aggregate rule (review)
difficulty: easy
repro: verified
---

# What shipped

Three planner sites decided "is this aggregate the same one the SELECT list already
computed?" by rendering both sides to SQL text and comparing them after a blanket
`.toLowerCase()`. That folded quoted string-literal contents along with identifier
case, so `count(nullif(b,'A'))` and `count(nullif(b,'a'))` collapsed into one
aggregate identity — a HAVING / ORDER BY / window clause could silently bind to the
wrong computed column and return wrong rows with no error.

`expressionToIdentityString(expr)` in `emit/ast-stringify.ts` renders through the
existing `lowerExprIdentifiers` fold instead: identifier (`column` / `identifier`
node) case is folded, every literal stays byte-exact. All three sites —
`findMatchingAggregate`, `dedupeNewAggregates`, `collectInnerAggregates` — now use
it, and the two alias-based self-dedupe checks (which re-folded literals via
`alias.toLowerCase()` and would have undone the fix) were replaced with identity-key
comparisons.

GROUP BY coverage fingerprints were deliberately left alone — already fully
case-sensitive, and a divergence there is a missed match / plan-time error, never a
wrong answer.

# Review findings

**Implement-stage diff read first, before the handoff summary.** Lint clean; full
`yarn test` in `packages/quereus` green (8686 → 8693 passing, 13 pending, 0 failing).

## Verified correct

- **Regression value of the new tests — confirmed empirically, not assumed.**
  Temporarily reverted `expressionToIdentityString` to the old
  `expressionToString(expr).toLowerCase()` behaviour and re-ran: the `07.3` `wgl`
  block fails (`Row count mismatch. Expected 1, got 0`) and the `07.5` `wgc` block
  fails (expected error not raised). Both fixtures genuinely pin the fix. Helper
  restored immediately after.
- **Sweep for missed call sites.** No `…ToString(…).toLowerCase()` comparison
  remains anywhere in `src/` — the fix covers every site of this pattern, not only
  the three the ticket named.
- **Fold correctness.** `distinct` is rendered by `expressionToString` and preserved
  by the fold, so DISTINCT still participates in identity; blob literals render as
  lowercase hex on both sides (hex case is not semantic), so they are unaffected.

## Fixed in this pass (minor)

- **Unnecessary casts / dead imports.** All three sites cast the guarded node with
  `as AggregateFunctionCallNode` to read `.expression`. `CapabilityDetectors.isAggregateFunction`
  is a type predicate narrowing to `AggregateFunctionCapable`, which extends
  `ScalarPlanNode` and so already carries `expression`. Casts dropped at the three
  sites; the now-unused `AggregateFunctionCallNode` imports removed from
  `select-aggregates.ts` and `select-projections.ts` (`function-call.ts` still
  constructs the node, so its import stays).
- **The unit-test gap the implementer flagged is closed.** A `test/emit/ast-stringify.spec.ts`
  already existed, so the "no isolated test for the helper" gap cost nothing to
  fill: 7 new cases pin identifier-case folding, qualifier-case folding,
  string-literal-case preservation (flat and nested through `case` / `cast`),
  whitespace/redundant-paren insensitivity, DISTINCT participation, and — the
  property the fold's `{ ...node }` rebuild exists to guarantee — that the input AST
  is not mutated.
- **Docs were out of date, in both directions.** The aggregate-reuse rule was
  undocumented anywhere, and so was the window-spec rejection error users actually
  hit. Added the structural sameness rule (identifier case folded; literals and
  qualifiers exact; `distinct` participates) to `docs/sql-select.md` § 3.4 HAVING,
  and a grouped-queries paragraph in `docs/window-functions.md` pointing at it and
  quoting the real error text — with all three of its sites
  (`PARTITION BY` / `ORDER BY` / `arguments`), which the source produces but the
  ticket's summary implied was ORDER BY only.

## Tripwires recorded (not tickets)

- **Aggregate output scope registers aggregates under `alias.toLowerCase()`** —
  the same literal-folding shape this ticket fixed, one layer up
  (`select-aggregates.ts`, `createAggregateOutputScope`). Harmless today: nothing
  resolves an aggregate through that scope by its rendered text (HAVING / ORDER BY /
  window specs all go through `findMatchingAggregate`, which is literal-exact), and
  only a quoted identifier spelled exactly like the rendering could reach it — and
  it lands on an *ambiguity error*, not a wrong answer. `NOTE:` comment parked at the
  registration site with the condition and the fix to apply if a lookup path is
  added.

## Considered and deliberately not done

- **DRY-ing the "guard, then fingerprint" two-liner into one shared helper.** It
  appears at three sites, but the only sensible home (`function-call.ts`, which owns
  `CollectedAggregate`) would make `select-projections.ts` import it, creating a new
  import cycle through `function-call → expression → select → select-projections`.
  Two lines × three sites is not worth a new cycle; left as is.
- **File size.** `emit/ast-stringify.ts` is 1924 lines and
  `planner/building/select-aggregates.ts` is 993 (`wc -l`). Both are pre-existing and
  this ticket's net contribution to them is ~30 lines; splitting either is outside
  this change's blast radius, so no ticket filed. Recorded here as a measurement, not
  a claim that they need splitting.
- **`yarn test:store` not run** — planner-only change, no storage-layer touch;
  matches the implement stage's reasoning.
- **Out-of-scope arms left untouched, per the original ticket:** qualifier narrowing
  (`sum(w.b)` vs `sum(b)`), case-insensitive GROUP BY coverage fingerprints, and the
  `lowerExprIdentifiers` subquery-passthrough limitation (documented on the export;
  degrades to a missed match, never a wrong answer). Window-specification grouping
  keys off `JSON.stringify` of raw AST (`select-window.ts`) are likewise
  case-sensitive — that produces a redundant window node, not a wrong answer.

## Categories with nothing to report

- **New tickets filed: none.** Every finding above was minor enough to fix in this
  pass or conditional enough to park as a tripwire; nothing needed its own root-cause
  site. Two open tickets already touch these files
  (`fix/bug-window-spec-reads-base-table-column`,
  `backlog/bug-ungrouped-aggregate-order-by-cannot-see-its-own-columns`) and neither
  overlaps this fix's site.
- **Pre-existing test failures: none observed.** The suite was green before and after;
  `tickets/.pre-existing-error.md` was not written.
- **Error handling / resource cleanup: nothing to report** — the change adds one pure
  string-returning function and three comparison-site swaps; no I/O, no allocation
  beyond the AST clone the fold already made, no new failure path.
