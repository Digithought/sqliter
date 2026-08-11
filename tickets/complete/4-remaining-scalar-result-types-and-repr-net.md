---
description: The data type the engine reports for each result column now agrees with the kind of value the column actually produces, across literals, arithmetic, CASE, VALUES, aggregates, window defaults, parameters, JSON table functions and pragmas; the permanent egress check stayed narrow because two wrong-value bugs still block it.
files:
  - packages/quereus/src/common/type-inference.ts             # one value⇒type mapping (isSafeInteger split)
  - packages/quereus/src/planner/nodes/scalar.ts              # LiteralNode, BinaryOpNode promotion + nullability, UnaryOp, CASE merge
  - packages/quereus/src/planner/nodes/values-node.ts         # VALUES column type merged across ALL rows
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts # the shared merge; now also CASE/VALUES/coalesce/LAG-LEAD
  - packages/quereus/src/types/comparison-coercion.ts         # numeric-vs-text: INTEGER side targets NUMERIC
  - packages/quereus/src/func/builtins/aggregate.ts           # sum() → NUMERIC_RETURN
  - packages/quereus/src/func/builtins/scalar.ts              # findCommonType is the set-op fold
  - packages/quereus/src/func/builtins/builtin-window-functions.ts # LAG/LEAD fold the default arg's type
  - packages/quereus/src/func/builtins/json-tvf.ts            # json_each/json_tree key/value/atom → ANY
  - packages/quereus/src/planner/nodes/pragma.ts              # pragma `value` column → ANY
  - packages/quereus/src/planner/scopes/param.ts              # untyped ? → ANY
  - packages/quereus/src/core/statement.ts                    # egress seam still R1-only (gated); both blockers named
  - packages/quereus/src/runtime/emit/binary.ts               # review: NOTE at the unchecked number arm
  - packages/quereus/test/announced-result-types.spec.ts      # 30 pins (22 from implement, 8 added in review)
  - docs/types.md, docs/types-inference.md, docs/types-parameters.md
---

# What shipped

Every result column's announced type (`Statement.getColumnDefs()` / `getColumnType()`) now
names a value space its values actually inhabit. Implement measured this by temporarily
widening the statement-egress representation check from R1-only to full R2 and running the
whole suite under `QUEREUS_REPR_STRICT=1`: 25 violations before, 2 after (both instances of
one gated wrong-value bug). The widening was then reverted, so the committed egress check
is still R1-only; `test/announced-result-types.spec.ts` pins each reconciled shape as a
plain type assertion instead.

Reconciled: literals (one shared value⇒type mapping, split on `Number.isSafeInteger`),
arithmetic promotion (`/` over two INTEGERs and mixed INTEGER/REAL both → NUMERIC),
arithmetic nullability (nullable except `+ - *` over two INTEGERs), unary `- +` over a
non-numeric non-TIMESPAN operand → ANY, `sum()` → NUMERIC, CASE arms / VALUES rows /
`coalesce`·`iif`·`choose`·`greatest`·`least` / LAG-LEAD defaults all folded through the one
`mergeSetOpAdvertisedType`, `json_each`/`json_tree` `key`·`value`·`atom` → ANY, pragma
`value` → ANY, untyped `?` → ANY.

One behavior change rode along: numeric-vs-text comparison coercion now targets NUMERIC on
an INTEGER side, because `INTEGER_TYPE.parse` reads a leading digit prefix (`'1e3'` → 1),
which made `1000 = '1e3'` false and `int_col = '1.9'` true for `int_col = 1`.
`test/logic/03.6.1-…sqllogic` was updated in three places accordingly.

Two user-facing consequences, both deliberate: a maintained table over `sum(v)` must now
declare the column `numeric` (declaring `real` errors with a shape mismatch), and an
untyped `?` reports ANY rather than TEXT.

# Review findings

**Ran:** `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` (9508 passing, 0 failing),
`yarn workspace @quereus/quereus run test:repr-strict` (9517 passing, 0 failing, 16
pending). All green before and after the review's own edits. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written.

**Checked and clean — stated explicitly rather than left silent:**

- *The comparison-coercion blast radius*, which the handoff flagged as the highest-risk
  edit. Probed live: `int_col = '5'` still plans as `INDEX SEEK t USING ix` (the converting
  cast lands on the text side, as before), `i = '1e3'` now correctly matches 1000,
  `i in ('5','7')` and `i > '6'` return the right rows.
- *The merge's NULL rule replacing the deleted `extremumReturnType`.* Verified the two
  cases that function existed for: `greatest(int_col, text_col)` → ANY,
  `least(int_col, null)` → INTEGER. The fold reproduces both; the deletion is sound.
- *`ValuesNode.mergedColumnType` cost.* It is linear in cell count (one `getType()` per
  cell, twice — once for the relation type, once for attributes, each behind a `Cached`),
  not quadratic, and planning already walks every cell. Not a concern; no ticket.
- *The `?.`/`continue` guard for a ragged VALUES row.* Not dead code — a ragged row does
  reach plan-time typing, and `emitValues` is what reports it with a location. Kept, with
  a one-line comment saying so.
- *Unary `-`'s identity compare against `TIMESPAN_TYPE`*, which looked inconsistent with
  the name-based compares the same diff introduced elsewhere. It is correct as written:
  `runtime/emit/unary.ts` selects its TIMESPAN arm off the *same* identity check, so
  planner and evaluator cannot diverge. Left alone.

**Major — one, filed:**
`backlog/bug-integer-arithmetic-silently-leaves-the-exact-integer-range`. Binary arithmetic
over two safe-integer operands returns the raw double without checking whether the exact
answer escaped the safe-integer range: `select 9007199254740991 * 3` returns
27021597764222972, off by one (verified live), and `9007199254740991 + 9007199254740991`
returns a plain `number` that the announced INTEGER does not admit. The announcement is
right and the runtime value is wrong, so the fix belongs in
`buildCoercingArithmeticRun`'s non-bigint arm, not the planner. The ticket asks for a
generated boundary test as the preferred shape, since the same guard would also catch the
two sibling tickets in this theme (`bug-text-coercion-in-arithmetic-and-aggregates` arm A,
`bug-window-sum-loses-exactness-vs-grouped-sum`); their sites were checked first and are
genuinely distinct, which is why this is a new ticket rather than an arm on either. A
`NOTE:` at the site points to it.

This also corrects the handoff's claim that the min/max text-coercion bug was the *last*
blocker to widening the egress check to R2 — it is the last one the **suite** trips, but
not the last one that exists. `statement.ts` and `docs/types.md` § Enforcement now name
both.

**Minor — fixed in this pass:**

- *Stale docs the implement pass did not reach.* `docs/types-inference.md` still documented
  the old promotion rule (`any REAL operand → REAL`), the deleted `greatest`/`least`
  fallback, and a return-type constant list missing `NUMERIC_RETURN`; it had no coverage of
  unary operators or arithmetic nullability at all. Rewritten with a promotion table, a
  unary table, a nullability paragraph, and the LAG/LEAD rule. `docs/types.md` contrasted
  the set-op merge against "CASE's arms differ ⇒ TEXT" and "the promotion `findCommonType`
  uses" — both rules the diff deleted, so the contrast was actively misleading; it now
  states instead that every unconverted multi-branch position folds through the one merge,
  and lists them. The same stale contrast in `set-op-type-merge.ts`'s header was rewritten.
  `docs/types.md`'s write-path section still cited "`sum()` announces REAL" and "`?`
  announces TEXT" as live examples — reframed as history, with the reason the value guard
  survives the fix. `docs/types-parameters.md`'s inference table said "`number` (integer) →
  INTEGER" (now the safe-integer split) and never mentioned the new ANY default.
- *Test gaps in the new spec.* Eight assertions added (22 → 30): the `isSafeInteger` split
  itself (`select 1e308` → REAL, previously unpinned despite being a stated refinement),
  unary `-` over TIMESPAN, `greatest` over mixed categories, the NULL-argument rule,
  all three LAG/LEAD arms (differing default, agreeing default, offset ignored), and the
  pragma `value` column.

**Tripwires — none.** Nothing found was of the "fine now, only matters if X later" shape;
the one conditional-looking item (`mergedColumnType` cost) resolved as a non-issue on
measurement rather than as a deferred concern, and the non-singleton `LogicalType`
observation already carries a `NOTE:` at `set-op-type-merge.ts` from the implement pass.

**Considered-and-declined — none encountered.** No accepted-tradeoff `NOTE:` sat at any
finding's site.

**Deliberately not revisited:** the two "say-so" items the handoff was honest about — arm H
(the R2 net) and arm I's nullability assertion — are correctly gated and correctly
ticketed (`backlog/debt-announced-nullability-disagrees-with-produced-nulls` carries the
~28-violation class breakdown and a re-measurement recipe). Nothing to add.
