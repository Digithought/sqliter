---
description: The data type the engine reports for a query's result column is often not the kind of value that column actually produces — a column announced as text can come back holding a number, a boolean, or a list. A caller that trusts the announcement gets it wrong, and in one case the engine trusts it too and stores a wrongly-shaped value.
files:
  - packages/quereus/src/core/statement.ts                     # getColumnType / getColumnDefs — where the announced type reaches embedders
  - packages/quereus/src/common/type-inference.ts              # parameter type inference — the untyped-`?` case
  - packages/quereus/src/planner/nodes/function.ts             # ScalarFunctionCallNode.getType — aggregate/window return types
  - packages/quereus/src/runtime/emit/binary.ts                # arithmetic/comparison results whose runtime class differs from the inferred type
  - packages/quereus/src/runtime/emit/insert.ts                # ARM 2 — builds the declared-type coercion from the SOURCE's announced type
  - packages/quereus/src/types/validation.ts                   # ARM 2 — buildRowCoercion, which skips a cell whose announced type already matches
  - docs/types.md                                              # § Physical representation — states what IS promised (R1/R2 over DECLARED types)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: most of the damage is embedder-facing metadata that no in-tree code reads, so tightening inference is churn across the planner for a benefit only arm 2 can demonstrate concretely — and some of the gaps (an untyped `?`) have no correct answer at plan time by construction; a maintainer could reasonably fix arm 2 alone by making the INSERT coercion representation-driven and leave the announcements as they are.
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

No operator reads the announced type while evaluating — values carry their own JavaScript
form and every operator dispatches on that. So for the table above the cost lands on
embedders: a driver, UI grid, or serializer that switches on the announced type to decide
how to render or marshal a value handles these columns under the wrong branch.

# Arm 2 — one place the engine DOES consume the announcement, and stores a bad value

Found during the review of `representation-strict-checker`; this arm is why the ticket is
not purely cosmetic.

`emitInsert` (`runtime/emit/insert.ts`) builds its declared-type coercion with
`buildRowCoercion(sourceAttrs.map(a => a.type.logicalType), tableSchema.columns)` — driven
by the **announced** type of each source expression — and `buildRowCoercion` deliberately
leaves a cell alone when its announced type already equals the column's declared type
(the comment names `insert into b select j from a` for a JSON column, where re-converting
would be wrong). When the announcement is wrong, that skip lets a non-conforming value
through to storage.

Verified, with the strict checker **off**:

```sql
create table s (id integer primary key, v integer);
insert into s values (1, 9007199254740993), (2, 9007199254740993);
create table t (id integer primary key, r real);
insert into t values (1, (select sum(v) from s));
select r from t;   -- comes back as the JS bigint 18014398509481986n
```

`sum()` announces REAL, so `buildRowCoercion` sees REAL-into-REAL and skips; the runtime
value is a `bigint` past 2^53. A REAL-declared column now holds a `bigint`, which is an R2
violation of *stored* data — the storage-level rule, not an announcement. With
`QUEREUS_REPR_STRICT=1` the DML write seam reports it:

```
repr-strict: representation mismatch at write to main.t column 1 (r): declared type REAL
admits a number, but the value is a JS bigint (18014398509481986) (rule R2).
```

Fixing the announcement (`sum()` over integers announcing NUMERIC rather than REAL) fixes
this arm too, since the coercion would then see NUMERIC≠REAL and run. The alternative
local fix is to make the INSERT coercion decide from the value's representation rather than
from a static type it cannot trust.

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
- Arm 2: the `insert into t values (1, (select sum(v) from s))` case above stores a JS
  `number` in the REAL column, and `QUEREUS_REPR_STRICT=1` stays quiet on it.
- Once fixed, widening the statement-egress seam in `core/statement.ts` from R1-only
  (`NO_DECLARED_TYPES`) to the plan's real output types and running `yarn test:repr-strict`
  is the regression net.
