---
description: The data type the engine reports for a query's result column is often not the kind of value that column actually produces — a column announced as text can come back holding a number, a boolean, or a list — so a caller that trusts the announcement to decide how to handle the value can get it wrong.
files:
  - packages/quereus/src/core/statement.ts                     # getColumnType / getColumnDefs — where the announced type reaches embedders
  - packages/quereus/src/common/type-inference.ts              # parameter type inference — the untyped-`?` case
  - packages/quereus/src/planner/nodes/function.ts             # ScalarFunctionCallNode.getType — aggregate/window return types
  - packages/quereus/src/runtime/emit/binary.ts                # arithmetic/comparison results whose runtime class differs from the inferred type
  - docs/types.md                                              # § Physical representation — states what IS promised (R1/R2 over DECLARED types)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: nothing inside the engine consumes the announced type at runtime — it is metadata for embedders only — so tightening inference is churn across the planner for a benefit no in-tree code can demonstrate, and some of the gaps (an untyped `?`) have no correct answer at plan time by construction.
---

# What is wrong

Every result column of a prepared statement carries an announced data type, reachable by
an embedder through `Statement.getColumnType()` / `getColumnDefs()`. That type is computed
at planning time, before any value exists. For a plain column reference it is the column's
declared type and it is right. For a computed column it is an *inference*, and the
inference is frequently a different type from what the column actually yields at runtime.

The engine's physical-representation checker (`QUEREUS_REPR_STRICT`,
`runtime/strict-representation.ts`) was pointed at this seam during its implementation and
found roughly 30 disagreements across the existing test suite before the seam was narrowed
to stop reporting them. Representative cases, each verified:

| query | announced type | value actually produced |
|---|---|---|
| `select ? as v` (untyped parameter) | TEXT | whatever was bound — a number, or a JS array |
| `select '123' + 0 as v` | TEXT | a number |
| `select t = 'world' as v` | TEXT | a boolean |
| `select sum(v)` over large integers | REAL | a `bigint` past 2^53 |
| `select 2 * timespan('PT1H')` | REAL | a TIMESPAN string (`'PT7200S'`) |
| `select lag(x, 1, 0) over (…)` | TEXT | a number |
| `select 1 as v` | REAL | a number (an integer literal announced as REAL) |

Nothing inside the engine reads the announced type at runtime — values carry their own
JavaScript form and every operator dispatches on that — so none of these is a wrong ANSWER
today. The cost lands entirely on embedders: a driver, UI grid, or serializer that switches
on the announced type to decide how to render or marshal a value will handle these columns
under the wrong branch.

# Expected behavior

The announced type of a result column should be a type the column's values actually inhabit
— i.e. the same relationship a declared column type has to its stored values (rule R2 in
`docs/types.md` § Physical representation). Where planning genuinely cannot know (an untyped
`?`), the honest announcement is `ANY`, not an arbitrary concrete type.

# Why it is filed rather than fixed

The representation checker deliberately does **not** enforce R2 at statement output for
exactly this reason: R2 is a rule about *declared* types, and a projection's inferred
`ScalarType` is not one. Making the checker assert it would report inference imprecision as
a representation defect. The seam carries a comment saying so and pointing here; if this
ticket lands, that seam can be upgraded from R1-only to full R2 and would then guard the
invariant permanently.

# Use cases to cover

- `select ? as v` with a bound number: announced type must not claim TEXT.
- `select '123' + 0`, `select a = b`, `select 2 * timespan('PT1H')`: announced type matches
  the storage class each actually returns.
- `sum()` over integers past 2^53: announced type must admit `bigint` (NUMERIC, not REAL).
- A plain `select col from t`: unchanged — this already agrees and must keep agreeing.
- Once fixed, flipping the statement-egress seam in `core/statement.ts` from
  `assertCanonicalValue` (R1) to `assertRowConforms` (R2) and running
  `yarn test:repr-strict` is the regression net.
