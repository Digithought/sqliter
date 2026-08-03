description: A view can name the schemas its tables should be looked up in. When such a view combines two queries with `union` (or `intersect`/`except`), updating through it now works whether the sub-select needing that schema list lives in the first query or the second — previously only the first worked.
files:
  - packages/quereus/src/planner/mutation/set-op.ts               # `withDeclaredPath` (beside `unwrapBranchSelect`, ~line 628); `buildBranch` (~line 674), `analyzeSetOpView`/`analyzeSetOpBranches` (~line 562/597), `flaglessShape` (~line 1614)
  - packages/quereus/test/view-home-schema.spec.ts                 # 3 new cases appended to the `with schema`/set-op describe block (~line 840 onward), plus an updated comment on the pre-existing LEFT-leg test (~line 816)
  - docs/view-updateability.md                                     # § Schema resolution during write-through — closing paragraphs rewritten (~line 123)
repro: verified
difficulty: easy
---

# Implementation summary

Root cause (per the ticket): a set-operation view's trailing `with schema a, b` clause binds
to the WHOLE compound but the parser attaches it only to the leading leg's `SelectStmt` node.
On write, each leg is lowered through its own synthetic branch view-like built from that leg's
own AST — the leading leg's happens to keep the path (it's a spread of the compound root), every
other leg's doesn't (spread of an operand that never carried it), so an unqualified name that
only the declared path reaches fails with a misleading "add 'temp' to your WITH SCHEMA clause"
hint on any leg after the first.

Fix, exactly as prototyped in the ticket: a new `withDeclaredPath(sel, declaredPath)` helper
beside `unwrapBranchSelect` in `packages/quereus/src/planner/mutation/set-op.ts` stamps the
compound's declared path onto a leg body that has none of its own (identity when there's no
clause, or the leg already carries its own). Threaded through both write routes:

- **membership route** — `buildBranch` gained a 6th `declaredPath?: string[]` parameter, applied
  right after `unwrapBranchSelect`. Both call sites (`analyzeSetOpView` for the top-level body,
  `analyzeSetOpBranches` for a nested subtree operand's recursion) now pass `sel.schemaPath`.
  Nesting falls out for free: `buildBranch` stamps the path onto the operand's body, and the
  recursion reads it back off `branchView.selectAst.schemaPath` — no outer-path re-threading, so
  a nested compound's own clause still wins for its own legs.
- **flag-less (literal-discriminator) route** — `flaglessShape`'s per-leg walk now carries a
  `declared` local seeded from `sel.schemaPath`, applied to both the left leg and the
  `stripLegModifiers(right)` operand each iteration, and updated to the right leg's own path
  (`rightEff.schemaPath ?? declared`) before descending — so a parenthesized sub-compound's own
  declared path wins for ITS legs, same precedence rule as the membership route.

Doc comments on `buildBranch` and `flaglessShape` now say why the stamp happens; the module-level
doc in `docs/view-updateability.md` § Schema resolution during write-through gained a paragraph
describing this carry and had this ticket's slug removed from the "remaining open defects" list
(2 remain: `fix/bug-view-write-lineage-subquery-base-table-qualifier` and
`fix/bug-view-write-subquery-shadow-analysis-wrong-schema` — unrelated code sites, untouched here).

## What to check in review

- The precedence rule: a leg's OWN `with schema` clause (or a nested sub-compound's own clause)
  must still outrank the carried/declared one. Covered by the pre-existing
  `lets a fragment sub-select's OWN 'with schema' outrank the carried path` test (unaffected by
  this change — different code path) and structurally by `withDeclaredPath`'s `sel.schemaPath`
  guard (no-op when the leg already has its own path).
- No over-application when the definition declares NO `with schema` clause at all — new guard
  test `leaves a set-op definition with no 'with schema' clause on the home path (right leg)`.
- Both failure routes named in the ticket are covered: membership (`exists … as <flag>`) via the
  new RIGHT-leg test (`update` AND `delete`), and flag-less literal-discriminator via the new
  `wfv`-style test (`update` only — the ticket's flag-less repro was update-only too; DELETE
  through the flag-less route isn't separately exercised here, though it shares the same
  `flaglessShape` leg-building code path as the tested `update`).
- Nesting (a subtree/nested compound operand at depth ≥ 2) is NOT covered by a new test — the
  ticket's diff comment says it "falls out for free" from the recursion reading the stamped
  `branchView.selectAst.schemaPath` back, and that reasoning holds on inspection, but there is no
  regression test pinning a 3-branch (nested) set-op write with a declared path reaching a
  non-leading leaf. Flag as a gap if that matters for this area's risk profile.

## Test results

- `yarn workspace @quereus/quereus run test` — 8514 passing, 13 pending (0 failing). Baseline
  before this change was 8511 passing per the ticket's own prototype note; the 3 new cases in
  `view-home-schema.spec.ts` account for the delta.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0, no output; this package's lint also
  type-checks test files via `tsc -p tsconfig.test.json --noEmit`, so the new spec cases are
  covered).
- No pre-existing failures encountered; nothing added to `tickets/.pre-existing-error.md`.
