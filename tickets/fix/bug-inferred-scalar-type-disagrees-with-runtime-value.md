---
description: The data type the engine reports for a query's result column is often not the kind of value that column actually produces — a column announced as text can come back holding a number, a boolean, or a list. A caller that trusts the announcement gets it wrong, and in one case the engine trusts it too and stores a wrongly-shaped value.
files:
  - packages/quereus/src/core/statement.ts                     # getColumnType / getColumnDefs — where the announced type reaches embedders
  - packages/quereus/src/common/type-inference.ts              # parameter type inference — the untyped-`?` case
  - packages/quereus/src/planner/nodes/function.ts             # ScalarFunctionCallNode.getType — aggregate/window return types
  - packages/quereus/src/runtime/emit/binary.ts                # arithmetic/comparison results whose runtime class differs from the inferred type
  - packages/quereus/src/runtime/emit/insert.ts                # ARM 2 — builds the declared-type coercion from the SOURCE's announced type
  - packages/quereus/src/types/validation.ts                   # ARM 2 + ARM 4 — buildRowCoercion, which skips a cell whose announced type already matches
  - packages/quereus/src/core/param.ts                         # ARM 4 — getParameterTypes keys positional hints by STRING when inferred from boundArgs
  - packages/quereus/src/planner/scopes/param.ts               # ARM 4 — DEFAULT_PARAMETER_TYPE (TEXT), and the NUMERIC-keyed hint lookup that misses
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

# Arm 3 — the temporal-arithmetic row has landed (no longer this ticket's work)

The `select 2 * timespan('PT1H')` row of the table above (and its siblings — `date - date`
announced DATE while producing a TIMESPAN, `timespan / timespan` announced TIMESPAN while
producing a number) is handled by the `temporal-op-table` ticket, which gives
`BinaryOpNode.generateType` a real result-type table for temporal operand pairs instead of
falling back to the left operand's type. That ticket also demonstrates a concrete wrong
answer from the inaccuracy — `select (2 * timespan('PT1H')) + 3` returns null, because the
outer `+` trusts the INTEGER announcement and takes the numeric-fast path with a duration
string in hand.

Scope note: that ticket covers **only** the arithmetic-operator rows. The untyped-`?`,
aggregate-return-type, comparison-returns-boolean, and integer-literal-announced-REAL rows
are untouched and remain this ticket's subject.

**Status: `temporal-op-table` has landed.** `select 2 * timespan('PT1H')` now announces
TIMESPAN, `date - date` announces TIMESPAN, and `timespan / timespan` announces REAL, so
the three temporal rows of the table above no longer reproduce. Two side effects worth
knowing when this ticket is eventually worked: `select (2 * timespan('PT1H')) + 3` now
raises `Unsupported temporal operation` instead of returning null, and ordering sites over
a difference expression (`order by (a - b)`, `min`/`max`, `distinct`, materialized views)
switched from text order to semantic elapsed-time order. Everything else in this ticket
still reproduces.

# Arm 4 — an untyped positional `?` bound after prepare stores the raw JS value (from lamina board)

Same site as arm 2 (`buildRowCoercion`'s identity skip), reached by a different and much
more ordinary route: the everyday `prepare(sql)` → `run([value])` write. Verified against
`16ff5ab9` with `QUEREUS_REPR_STRICT` **off**, using only `MemoryTable`:

```js
await db.exec(`create table t (id integer primary key, v text)`);
const s = db.prepare(`insert into t values (1, ?)`);
await s.run([9]);
// stored: the JS number 9, in a TEXT-declared column
```

Bind a `Uint8Array` instead and a TEXT column holds a `Uint8Array`. Both are R2 violations
of *stored* data, in the engine's own storage module — `MemoryTable` never gets a chance to
correct them, because `dml-executor` tells it `preCoerced`.

Which write shapes are affected, all verified in one script:

| write | stored in a `text` column |
|---|---|
| `values (1, ?)` + `run([9])` | **number 9** — skipped |
| `values (1, ?)` + `run([Uint8Array])` | **Uint8Array** — skipped |
| `values (1, :v)` + `run({v: 9})` | `'9'` — coerced |
| `values (1, 9)` (literal) | `'9'` — coerced |
| `prepare(sql, [9])` then `run()` | `'9'` — coerced |

So it is exactly: **an untyped positional `?`, into a column whose declared type is TEXT.**

## Root cause — two independent links, both needed

1. **The hint is dropped by a key-type mismatch.** Compilation happens *after* `bindAll`
   (`_iterateRowsRawInternal` binds, then `compile()`), so the engine does know the bound
   value's type at plan time and infers a hint from it — but `getParameterTypes`
   (`core/param.ts`) walks `boundArgs`, a plain object, with `Object.entries`, so a
   positional parameter's hint is keyed by the **string** `"1"`. `ParameterScope`
   (`planner/scopes/param.ts`) looks that hint up by the parser's **numeric** index `1`,
   misses, and falls back to `DEFAULT_PARAMETER_TYPE`. Confirmed directly:

   ```
   getParameterTypes([9])      -> key 1   (number) INTEGER   // prepare(sql, params): array path
   getParameterTypes({1: 9})   -> key "1" (string) INTEGER   // boundArgs path: same type, unusable key
   ```

   The array path is why `prepare(sql, [9])` coerces and `prepare(sql)` + `run([9])` does
   not. Named parameters are unaffected — both sides key by the same string.

2. **The fallback is a concrete type, and it collides.** `DEFAULT_PARAMETER_TYPE` is TEXT.
   Into a TEXT column that is an identity match, so `buildRowCoercion` skips the cell and
   the raw JS value reaches the vtab. Into any other column type the fallback is wrong but
   harmless — the types differ, the coercion runs, the value is converted.

Fixing link 1 alone closes the reported cases but leaves the class open: a `?` that carries
no hint at all still defaults to TEXT and still skips against a TEXT column. That is the
same "no correct answer at plan time by construction" this ticket's `tradeoffs:` line
already names.

## Recommended fix

The representation-driven option this ticket's `tradeoffs:` line contemplates, narrowed to
something cheap: treat a cell sourced from a `ParameterReferenceNode` as **unknown
provenance** for `buildRowCoercion` (pass `undefined` rather than the announced type), so a
parameter-sourced cell always converts. Safe against the re-conversion hazard the identity
skip exists for: TEXT's `parse` is `valueToText`, which is identity on a string, and every
non-TEXT column already converts parameter cells today — this changes only the case that is
currently wrong. Announcing `ANY` for an untyped `?` (this ticket's "Expected behavior")
reaches the same place from the other side, since `ANY` ≠ any column type.

Either way, fix link 1 too — a hint that exists and is silently unusable will bite
something else.

## Use cases to add

- `prepare('insert into t values (1, ?)')` + `run([9])` into a `text` column stores `'9'`.
- Same with a `Uint8Array`, a boolean, and a `bigint` past 2^53.
- The four already-correct rows of the table above keep their current results.
- `insert into b select j from a` for a JSON column still skips (the identity guard's
  original purpose) — a parameter-provenance rule must not widen into column references.
- With `QUEREUS_REPR_STRICT=1`, the DML-write seam stays quiet across the whole suite.

## Downstream

lamina excludes `packages/lamina-quereus-test/src/retype-insert-equivalence.test.ts` from
its `QUEREUS_REPR_STRICT=1` lane over exactly this — thirteen grid cells bind a stored
non-string into a `text` column as a positional parameter. That exclusion lifts when this
arm lands. lamina's own plugin-side coercion
(`packages/lamina-quereus/src/affinity-coercion.ts`) masks the defect for lamina-backed
tables today, which is why it surfaced as a strict-mode failure rather than a wrong stored
value there; `MemoryTable` has no such backstop.
