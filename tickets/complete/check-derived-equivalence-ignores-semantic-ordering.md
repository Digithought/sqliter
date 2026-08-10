---
description: A table rule saying "these two columns must be equal" no longer makes the query planner assume the two columns hold identical text when one of them is a duration or JSON column, where the same value can be written several ways. Rows that used to silently vanish from query results now come back.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts   # the fix — columnPairSemanticsAgree + 6 gate sites
  - packages/quereus/src/planner/nodes/plan-node.ts             # ConstantBinding comment restored (~line 227)
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts   # § "extractCheckConstraints semantic-ordering gate"
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic # § "CHECK-derived cross-column equality facts"
  - docs/invariants.md                                          # OPT-051
  - docs/optimizer-fd.md                                        # § Semantic-ordering gate on cross-column facts
  - docs/types.md                                               # § Semantic ordering
---

# Gate CHECK-derived cross-column equality facts on semantic ordering

## What shipped

Some column types compare by *meaning* rather than by the exact text stored: a `timespan`
column holding `'PT1H'` compares equal to one holding `'PT60M'`, and a `json` column holding
`'{"x":1}'` compares equal to `'{ "x" : 1 }'`. Plain `text` columns do not.

When a table declared `check (d = s)` with `d` a meaning-compared type and `s` plain text,
`check-extraction.ts` recorded "columns `d` and `s` always hold the same value" onto the table
reference. That is false — a row may legitimately store `d = 'PT1H'`, `s = 'PT60M'`, and the
CHECK still passes because `=` compares them by elapsed time. `rule-predicate-inference-
equivalence` then read that equivalence class off the Filter's source and rewrote
`where d = 'PT1H'` into `… and s = 'PT1H'`, dropping the row.

The three sibling extractors that mint the same kind of fact already declined mixed pairs
(invariant OPT-051). A new local helper `columnPairSemanticsAgree` adds the same gate to the
fourth, at all six cross-*column* sites in the file:

- `handleEquality`'s col=col branch (mirror FDs + `equivPairs` entry) and its two single-column
  `col = expr` one-way determinations.
- `recognizeGuardedBody`'s col=col branch (the `valueEquality: true` mirror pair) and its two
  single-column one-way determinations.

Constant pins stay ungated, unconditional and guarded alike — `check (d = 'PT60M')` claims only
that the column *compares equal to* that value under its own comparison, which is true, and
gating it would decline every pin on a `timespan`/`json` column. Guard scopes
(`recognizeNegatedGuard`) stay ungated: a guard clause is the same comparison re-evaluated
under the same declared types at enforcement time.

The gate is deliberately symmetric on the one-way arms even though the `{text} → {timespan}`
direction is sound — over-declining is the safe direction and one predicate beats two.

## Review findings

### Checked

- **Gate completeness in `check-extraction.ts`.** Enumerated every fact the file can mint and
  classified each as cross-column or not. Six cross-column sites — all gated. The only other
  cross-column producer is `recognizeNegatedGuard`'s `col1 <> col2` → `eq-column` guard clause,
  which is deliberately ungated and sound (its consumer `buildPredicateFacts`' `columnEqs`
  discharges it against the *same* comparison, so filter rows and guard-scope rows coincide).
- **The ungated arms, re-derived from scratch** rather than taken from the handoff: both
  constant-pin arms are sound under the `ConstantBinding` contract in `plan-node.ts`, and the
  binding closure over a same-type equivalence class (`{d, e}` both `timespan`, `d` pinned to
  `'PT1H'` ⇒ `e = 'PT1H'`) stays true because `e` compares under its own comparison.
- **Domain constraints — the arm the ticket does *not* gate.** `handleInequality`, BETWEEN and
  IN mint single-column facts against literals (`check (d >= 'PT1H')`, `check (d in (…))`).
  These would be wrong if a consumer compared bounds as text. Traced to `analysis/sat-checker.ts`:
  `collectSemanticColumnTypes` + `createTypedComparator` already reason about semantic-ordering
  columns under the type's own compare (`sat-checker.ts:115-133`). No hole; nothing to file.
- **Both entry points carry real column metadata.** `getCheckExtraction` passes
  `tableSchema.columns`; `assertion-hoist-cache.ts:149` passes `table.columns`. Neither can
  reach the extractor with metadata the gate cannot read.
- **Directionality of the one-way arms.** Confirmed the unsound direction is
  determinant-semantic → dependent-plain, and that the symmetric gate over-declines the
  converse. Safe direction, documented at the helper.
- **Hygiene.** `check-extraction.ts` is 659 lines (`wc -l`), unchanged in structure; the new
  helper is 7 lines, single-purpose, named for what it decides. No duplication with the three
  `ScalarPlanNode`-side call sites — that split mirrors the existing collation-gate split.
- **Validation.** `yarn workspace @quereus/quereus run lint` clean. `yarn test` from repo root:
  8277 passing in `packages/quereus`, no failures in any workspace. `yarn docs:check` reports
  only the three word-count ratchet failures already listed in `tickets/.pre-existing-known.md`
  (`debt-doc-size-ratchet-red-at-head`) — nothing new.

### Found and fixed in this pass

- **No end-to-end test for the hoisted-assertion route** (a gap the handoff named). Added a case
  to `test/logic/15.1-semantic-ordering.sqllogic`: `create assertion … check (not exists (select
  1 from cka where d <> s))` over a `timespan`/`text` pair, which `negateAst` turns into a
  synthetic per-row `d = s` check whose facts merge onto the same TableReferenceNode. Verified it
  *discriminates* — with `columnPairSemanticsAgree` short-circuited to `true` the query returns
  zero rows; with the gate in place it returns the row. The route was gated by construction, but
  nothing asserted it end to end until now.
- **Stale count in `docs/optimizer-fd.md`** (line 124): "shared by all three gated sites" — the
  same paragraph the change had just rewritten to say *four*. Corrected.

### Investigated, no finding

- **Arm 2 (the implication form) has no query-row test** — only an extractor-output test, because
  `FilterNode.computePhysical` writes the activated equivalence class onto the Filter *itself*
  while `rule-predicate-inference-equivalence` reads `source.physical.equivClasses`. The handoff
  invited a reviewer to find a surfacing shape. Probed two the handoff had not tried, both with
  the gate short-circuited so a wrong answer would show: (a) a partial-UNIQUE guard-discharge
  analog of case R5 with the guard column in the filter
  (`check (st <> 1 or d = s)` + `unique index … where s = 'PT60M'`, query `where st = 1 and
  d = 'PT60M' and v = 7`), and (b) projection / nested sub-select / `distinct` consumers of the
  activated class. All returned correct rows ungated. Corroborates the handoff — the extractor
  output is the right place for the assertion. Not a ticket: the fact minted was still false and
  is now gated; only its observability is missing.
- **`docs/invariants.md` allows exactly one `guard:` line per invariant.** Verified against
  `scripts/check-docs.mjs:451`. Keeping OPT-051's existing guard pointer at
  `test/planner/collation-soundness.spec.ts` and recording the new spec as a `code:` pointer plus
  a named reference in `docs/optimizer-fd.md` is the correct resolution; nothing to change.
- **Handoff inaccuracy, no code impact.** It states the pre-existing unit tests'
  `DeclaredColumnInfo` literals "carry no `logicalType`" — they carry `TEXT_TYPE`
  (`check-derived-fds.spec.ts`, `colMeta`). The conclusion is unaffected (TEXT is non-semantic),
  so the tests pass untouched for the reason claimed even though the premise is off.

### Tripwires

- **None newly recorded.** The two conditional concerns in this area were already parked at their
  sites by the implementer and re-verified here: `semanticOrderingsAgree`'s object-identity
  comparison of logical types (over-declines if the engine ever mints per-column type instances)
  is stated in `docs/optimizer-fd.md` § Semantic-ordering gate, and the sqllogic case R5's
  dependence on *not* carrying an `order by` has a comment at the query. Nothing further needed.

### Tickets filed

- **None.** No unsound arm remains in the file, no gate site is missing, both entry points are
  covered, and the two findings above were small enough to fix in this pass.
