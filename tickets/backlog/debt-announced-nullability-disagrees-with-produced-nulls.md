---
description: The engine tells embedders which result columns can never be null, but for several kinds of computed columns that promise is false — the column can produce a null anyway. Fix the derivations and add a permanent check so the promise stays true.
files:
  - packages/quereus/src/core/statement.ts                  # _iterateWithSignal — the egress seam the assertion belongs at
  - packages/quereus/src/func/builtins/scalar.ts            # abs/instr/floor/ceil/round/substr… inferReturnType claims nullable: false
  - packages/quereus/src/func/builtins/string.ts            # same pattern (length, substr, replace inference objects)
  - packages/quereus/src/planner/nodes/join.ts              # outer-join column nullability (locate the actual node file)
  - packages/quereus/src/planner/nodes/scalar.ts            # BinaryOpNode arithmetic nullability — the one arm already fixed
  - packages/quereus/test/announced-result-types.spec.ts    # the three arithmetic nullability pins that exist today
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: No wrong query result follows from the flag — only an embedder reading `getColumnDefs()[i].type.nullable` is misled — so a maintainer may reasonably rank this below wrong-value work.
---

# Announced `nullable: false` result columns can produce null

`Statement.getColumnDefs()[i].type.nullable === false` is a promise to embedders (a UI
grid deciding whether to reserve a null rendering, a codegen layer emitting a
non-optional field) that the column never yields null. Measured on the tree at the end
of ticket `4-remaining-scalar-result-types-and-repr-net` (2026-08-11) by temporarily
asserting "announced non-nullable ⇒ no null cell" at statement egress
(`Statement._iterateWithSignal`) under `QUEREUS_REPR_STRICT=1`: **28 violations across
~26 distinct suite sites**. The strict-mode R2 widening planned at that seam will NOT
catch these — R2 admits null in every position — so this axis needs its own assertion.

The violations fall into classes (each resolves at a different site):

- **Builtins whose `inferReturnType` hard-codes `nullable: false` while the
  implementation returns null for a null argument.** `abs(v)` over a nullable column,
  `instr(null, 'x')`, and the same object-literal pattern on floor/ceil/round/substr/
  replace/length in `func/builtins/scalar.ts` and `string.ts`. The fix shape: these
  inferences receive only argument LOGICAL types today — either thread argument
  nullability into `inferReturnType` or default these to nullable.
- **Outer-join columns.** Inner-side columns of a LEFT JOIN kept `nullable: false`
  from their table declaration (suite sites named columns like `city`, `tier`,
  `extra`, `required` in lens and join tests). The join node must widen the
  null-extended side's column nullability.
- **Scalar subqueries.** `(select val from e)` over an empty relation yields null;
  announced non-nullable when `val` is declared NOT NULL.
- **Arithmetic** — already fixed in ticket 4: `BinaryOpNode` announces nullable except
  for `+`/`-`/`*` over two INTEGERs (the only shape with no non-finite→null path).
  That carve-out exists because the lens prover uses expression nullability to prove a
  computed `v + 1` column NOT NULL (`test/logic/55-lens-prover.sqllogic`) — whatever
  fix lands here must keep that proof working.

Requirements:

- Fix the derivations class by class until the egress assertion passes suite-wide.
- Then install the assertion permanently at the same seam, gated on
  `QUEREUS_REPR_STRICT` like the R1/R2 checks, so the axis cannot drift again.
- `docs/types.md` § Enforcement notes this axis is unchecked and points here — update
  it when the assertion lands.

To re-measure: add to `_iterateWithSignal`'s row loop a check of each null cell against
`this.columnDefCache.value[i].type.nullable === false` and run
`QUEREUS_REPR_STRICT=1 … mocha … --no-bail` (exact command in the measurement section
of `tickets/complete/4-remaining-scalar-result-types-and-repr-net*.md`).
