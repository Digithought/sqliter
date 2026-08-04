description: When a query summarizes data two ways that differ only in the capitalization of a quoted text value, and then filters or sorts by one of them, the engine silently used the wrong summary and returned wrong rows, with no error. Fixed so quoted values keep their capitalization when matching aggregates.
files:
  - packages/quereus/src/emit/ast-stringify.ts                    # new export expressionToIdentityString (~line 505)
  - packages/quereus/src/planner/building/function-call.ts        # findMatchingAggregate — now uses the new helper
  - packages/quereus/src/planner/building/select-aggregates.ts    # dedupeNewAggregates — now uses the new helper + identity-key Set
  - packages/quereus/src/planner/building/select-projections.ts   # collectInnerAggregates — now uses the new helper + guarded cast
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # new `wgl` block at tail
  - packages/quereus/test/logic/07.5-window.sqllogic              # new `wgc` block (window-spec loud-error assertion)
difficulty: easy
repro: verified
---

# Fix applied

Three planner sites answered "is this aggregate the same one the SELECT list
already computed?" by rendering both sides to SQL text with
`expressionToString` and comparing the two strings after a blanket
`.toLowerCase()`. That folded quoted string-literal contents along with
identifier case, so `count(nullif(b,'A'))` and `count(nullif(b,'a'))` collapsed
into the same "aggregate identity" — a HAVING/ORDER BY/window clause could
silently bind to the wrong computed column and return wrong rows, no error.

Fix: added `expressionToIdentityString(expr)` in
`packages/quereus/src/emit/ast-stringify.ts` (right after the existing
`lowerExprIdentifiers` helper it wraps) —
`expressionToString(lowerExprIdentifiers(expr))`. This folds `column` /
`identifier` node case only; every literal (string/blob/number/JSON/NULL) stays
byte-exact. Documented on the export: NOT round-trip SQL, identity-comparison
only, and the pre-existing subquery-passthrough limitation inherited from
`lowerExprIdentifiers` (does not descend into subquery bodies — a missed match,
never a wrong answer).

All three call sites switched to the new helper:

- `findMatchingAggregate` (function-call.ts) — both sides of the comparison.
  Also corrected its doc comment, which claimed `buildGroupByCoverage` shared
  this "case-insensitive" convention; it doesn't (GROUP BY coverage
  fingerprints are fully case-sensitive `expressionToString`, untouched by this
  ticket). The comment now names only the two sites that actually share the
  identity convention.
- `dedupeNewAggregates` (select-aggregates.ts) — switched both the
  existing-aggregate comparison and the self-dedupe-within-new-batch check.
  The self-dedupe used to compare against `alias.toLowerCase()` (works only
  because the alias *is* the un-lowercased rendering); replaced with an
  explicit `Set<string>` of identity keys built alongside `newAggregates`, so
  the fix isn't undone by the alias-based check re-folding literals.
- `collectInnerAggregates` (select-projections.ts) — same alias-based-dedupe
  problem, same fix shape: compare identity keys, not `alias.toLowerCase()`.
  Per the ticket's ask, the dedupe-comparison now guards each existing entry
  with `CapabilityDetectors.isAggregateFunction` before reading `.expression`,
  rather than casting blind — the array is shared with other collectors even
  though every entry reaching this function today happens to be an aggregate.

GROUP BY coverage fingerprints (select-aggregates.ts ~261/337/877/919) were
**not** touched — already fully case-sensitive, out of scope per the ticket
(a case divergence there is a missed match / plan-time error, not a wrong
answer).

## New test coverage

`test/logic/07.3-group-by-extras.sqllogic` — new `wgl` fixture at the tail:
- HAVING spells a literal-case-distinct aggregate not in the SELECT list →
  binds to its own aggregate.
- Same shape with both aggregates present in the SELECT list → HAVING binds to
  the right one (`d`, not `c`) — the exact repro from the ticket.
- Same divergence in a top-level ORDER BY, using **two groups** so a wrong
  bind changes *row order*, not just a displayed value (verifies the fix isn't
  accidentally masked by both binds producing the same visible number).

`test/logic/07.5-window.sqllogic` — new `wgc` fixture, appended next to the
existing qualifier-divergence case it mirrors: a window ORDER BY naming a
literal-case-distinct aggregate not in the SELECT list now hits the existing
loud `rejectUncollectedAggregates` error (was: silently ordered by the wrong
aggregate).

Existing controls already covered (not duplicated): identifier case,
whitespace/redundant-parens, DISTINCT participation, alias-only resolution,
qualifier narrowing (`wg` fixture block right above the new `wgl` block).

## Validation

- `yarn test` (packages/quereus, memory-backed vtab): **8686 passing, 0
  failing, 13 pending** — matches the ticket's stated baseline exactly (test
  *count* is unaffected by the new assertions since each `.sqllogic` file is
  one Mocha test regardless of how many queries it contains internally).
- `yarn lint` (packages/quereus: eslint + test-file typecheck): clean, no
  output, exit 0.
- `yarn test:store` (LevelDB-backed path) was **not** run — not requested by
  the ticket and this change is planner-only (no storage-layer touch); the
  ticket's own validation note only cites `yarn test`.

## Known gaps / things the reviewer should know

- No unit test directly exercises `expressionToIdentityString` in isolation
  (e.g. a `.spec.ts` asserting literal-case preservation vs identifier-case
  folding side by side) — coverage is entirely through the three planner call
  sites via `.sqllogic` integration tests. If the reviewer wants a tighter
  regression net independent of planner wiring, that's the gap to fill.
- Per the ticket, qualifier narrowing (`sum(w.b)` vs `sum(b)`) and making
  GROUP BY coverage fingerprints case-insensitive are explicitly out of scope
  and left untouched.
- The subquery-passthrough limitation of `lowerExprIdentifiers` (not descended
  into by `expressionToIdentityString` either) is documented on the new
  export per the ticket's ask, not tested — ticket marks it acceptable
  (degrades to a missed match, never a wrong answer).
