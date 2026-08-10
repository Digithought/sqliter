---
description: The short form of CASE now decides matches the same way the equals operator does, so it agrees on case-insensitive text columns and on duration columns instead of comparing raw bytes.
files:
  - packages/quereus/src/runtime/emit/operand-comparator.ts   # shared comparator + note formatter
  - packages/quereus/src/runtime/emit/case.ts                 # per-WHEN collation + comparator
  - packages/quereus/src/runtime/emit/between.ts              # re-pointed at the shared helper
  - packages/quereus/src/planner/analysis/comparison-collation.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/test/runtime/case-comparison-collation.spec.ts
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - docs/types.md
---

# Simple `CASE` compares values, not bytes — complete

## What shipped

`case x when v` previously decided its match with a storage-class comparison
under BINARY, consulting neither the operands' collations nor their declared
logical types. So on a `text collate nocase` column, `n = 'BOB'` was true while
`case n when 'BOB'` missed; on a `timespan` column, `d in ('PT120M')` matched
while `case d when 'PT120M'` missed. An explicit `COLLATE` on either side did
not help.

Now the emitter resolves one effective collation **per WHEN clause** through the
shared provenance lattice (`planner/analysis/comparison-collation.ts`) and builds
one comparator per clause through a new shared module,
`runtime/emit/operand-comparator.ts` — which is `between.ts`'s former private
`makeBoundComparator`/`formatBetweenCollationNote` pair, moved out and
generalized so BETWEEN, `=` and simple `CASE` cannot drift apart. Per-clause
(not one collation for the whole CASE) mirrors how BETWEEN resolves its two
bounds independently.

A genuine collation conflict now raises the same two errors `=` raises for the
same operand pair, instead of silently comparing under BINARY. Searched `CASE`
is untouched — its WHEN is an ordinary boolean expression that already resolved
through the lattice.

The instruction `note` gained a collation suffix, so a program dump shows what
each clause compares under (`case(short-circuit, 2 when clauses) NOCASE/BINARY`).

## Review findings

### Checked

The implement diff was read in full (source, docs, tests) before the handoff
summary. Behavior was then probed directly against a live `Database` rather than
taken from the handoff: constant-only conflicting CASE, bound parameters on
either side, numeric-vs-textual, boolean and blob bases, JSON structural match,
and all four `note` forms. `docs/types.md` § Comparison collation resolution was
re-read against observed behavior and every claim in it holds; docs were grepped
for references to the moved helper's old name — none exist.

`yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json
--noEmit`) is clean. `yarn test` is green across all workspaces: 0 failing,
quereus 7424 passing (7416 before, plus the 8 added here), 13 pending. No
pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not
written. `yarn test:store` was **not** run — as in the implement stage. The
change is emit-side and backend-agnostic and the added spec asserts on an
in-memory program dump, so the store path is not exercised differently; a
release-prep run will cover it.

### Minor — fixed in this pass

- **The new conflict error carried no source location.** `=` reports
  `conflicting COLLATE clauses in comparison: RTRIM vs NOCASE (at line 1,
  column 9)`; the CASE form reported the same message with no position, because
  `effectiveComparisonCollation` had no way to accept the offending expression.
  It now takes an optional AST expression (the same one
  `effectiveCollationOfTypes` already threaded), and `case.ts` passes
  `plan.expression`.
- **The `note` suffix had no automated assertion**, which the handoff excused as
  "no existing convention in the repo for asserting instruction notes". There
  are two: `test/and-or-short-circuit.spec.ts` prepares a statement and asserts
  on `getDebugProgram()`, and `test/runtime/fanout-lookup-join.spec.ts` matches
  `inst.note` directly. New spec `test/runtime/case-comparison-collation.spec.ts`
  follows the first and pins all four forms (single collation, no suffix when
  all-BINARY, slash-joined when clauses differ, no suffix for a searched CASE)
  plus BETWEEN's two-bound note — the latter is the regression pin the
  two-names-to-N generalization of the note formatter otherwise lacked.
- **The untested parameter interaction the handoff listed as a gap** is now
  covered in the same spec: an untyped bound parameter contributes no collation,
  so the column's NOCASE wins whether the parameter is the base or the WHEN
  operand, and a BINARY column stays case-sensitive against a parameter.
- **`emitCaseExpr` had grown a second concern.** Twenty lines of emit-time
  collation analysis sat inline in a function that already carried a long
  short-circuit rationale, with two `plan.baseExpr!` non-null assertions and a
  `plan.baseExpr ? … : []` ternary repeated twice. Extracted to
  `resolveWhenComparison(plan, ctx)`, which narrows `baseExpr` once and returns
  both arrays; the assertions are gone and the rationale now documents the
  helper.

### Major — new ticket filed

- **`backlog/bug-numeric-text-coercion-skips-in-and-case.md`** — a numeric
  column compared against a numeric-looking string still disagrees across
  comparison forms: `i = '1'` is true, `i between '0' and '2'` is true, but
  `i in ('1')` is false and `case i when '1'` misses (same for
  `r = '2.5'` vs `case r when '2.5'`). The handoff flagged this as out of scope
  on the grounds that simple CASE matches IN — but BETWEEN, the construct simple
  CASE was explicitly modeled on, applies **both** arms of the plan-time
  cross-type coercion at build time, so the "consistent with its siblings"
  defense does not hold. The scope line for *this* ticket is still right (it
  aligned the collation and declared-type axes, and this axis was already
  broken for IN long before), but the gap needed tracking, and it was not
  tracked: the `coerceObjectPhysicalSet` doc comment in
  `planner/building/expression.ts` claimed the case was "tracked separately"
  when no such ticket existed. That comment now names the new slug and states
  the `=`/BETWEEN divergence.

### Tripwire — recorded, not ticketed

- **The conflict throw happens at emit time, where `=` and BETWEEN validate at
  plan time.** The handoff asked for a second opinion on whether a future
  optimizer rule that prunes a `CaseExprNode` before emit would swallow the
  error. The specific worry was tested: a fully-constant conflicting CASE
  (`select case 'a' collate rtrim when 'A' collate nocase then 1 end`) still
  throws, because constant folding evaluates its border nodes by emitting them.
  So the concern is genuinely conditional, not a latent defect — parked as a
  `NOTE:` in the `resolveWhenComparison` doc comment in
  `runtime/emit/case.ts`, with the migration to
  `CaseExprNode.generateType` spelled out for whoever trips it.

### Noticed, deliberately not acted on

- `effectiveBetweenBoundCollation` is now a pure alias of
  `effectiveComparisonCollation` — both are
  `effectiveCollationOfTypes(a.getType(), b.getType())`. Pre-existing, not
  introduced by this change, and the distinct name is what documents "each bound
  resolves independently" at the BETWEEN call site. Left alone; collapsing it
  would cost more in call-site clarity than it saves.
- The three-clause `NOCASE/NOCASE/BINARY` note form is verbose for a wide CASE.
  Not worth compressing: the note is a debug surface and clause order is exactly
  what a reader needs from it.

## Follow-on work already queued

`implement/nullif-greatest-least-comparison-seam` routes `nullif`, `greatest`
and `least` through the same `makeOperandComparator` shape this ticket landed.
