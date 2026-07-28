---
description: The nullif, greatest, and least functions compare values byte-for-byte, so they disagree with the rest of the engine on case-insensitive text columns, on duration columns, and on JSON documents.
prereq: simple-case-comparison-collation-and-type
files:
  - packages/quereus/src/func/builtins/scalar.ts          # nullifFunc, greatestFunc, leastFunc — all three call bare compareSqlValues
  - packages/quereus/src/schema/function.ts               # BaseFunctionSchema / CustomEmitterHook — where the comparison seam goes
  - packages/quereus/src/runtime/emit/scalar-function.ts  # emitScalarFunctionCall — dispatches to customEmitter
  - packages/quereus/src/planner/building/function-call.ts # single ScalarFunctionCallNode build site (line ~107-128)
  - packages/quereus/src/planner/building/expression.ts   # insertCrossTypeCoercion / coerceObjectPhysicalSet / wrapInCast — currently private
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # effectiveCollationOfTypes, resolveComparisonCollation
  - packages/quereus/src/runtime/emit/operand-comparator.ts        # shared comparator helper landed by the prereq ticket
  - packages/quereus/src/func/builtins/mutation.ts        # mutationOrdinalFunc — existing customEmitter precedent
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
  - packages/quereus/test/logic/06.5.2-scalar-minmax.sqllogic
difficulty: hard
---

# `nullif`, `greatest`, and `least` compare raw bytes instead of values

## Reproduced at HEAD (2026-07-27)

Actual output from a fresh in-memory `Database`.

Case-insensitive columns:

```sql
create table t (id integer primary key, n text collate nocase, m text collate nocase);
insert into t values (1, 'a', 'B');

select n = 'A' from t;               -- true
select nullif(n, 'A') from t;        -- 'a'   WRONG — should be NULL
select nullif(n collate nocase, 'A') from t;  -- 'a'   WRONG — explicit COLLATE ignored too
select greatest(n, m) from t;        -- 'a'   WRONG — under NOCASE 'B' > 'a'
select least(n, m) from t;           -- 'B'   WRONG — under NOCASE 'a' < 'B'
```

Duration columns (`docs/types.md` § "Semantic ordering": `'PT2H'` is 120 minutes
and `'PT90M'` is 90, and the engine orders them that way everywhere else):

```sql
create table a (id integer primary key, d timespan, e timespan);
insert into a values (1, 'PT2H', 'PT90M');

select d in ('PT120M') from a;       -- true
select nullif(d, 'PT120M') from a;   -- 'PT2H'   WRONG — should be NULL
select greatest(d, e) from a;        -- 'PT90M'  WRONG — should be 'PT2H'
select least(d, e) from a;           -- 'PT2H'   WRONG — should be 'PT90M'
```

JSON, where the other side is a text literal:

```sql
create table j (id integer primary key, doc json, doc2 json);
insert into j values (1, '{"a":1}', '{ "a" : 1 }');

select doc = '{ "a" : 1 }' from j;        -- true
select nullif(doc, doc2) from j;          -- NULL   (correct — both sides are JSON columns)
select nullif(doc, '{ "a" : 1 }') from j; -- {"a":1} WRONG — should be NULL
```

The last pair is the tell: `nullif` is only wrong on JSON when one side is
*textual*, because nothing coerces the literal to JSON at plan time.

## Why

All three implementations in `func/builtins/scalar.ts` compare with bare
`compareSqlValues`, which is hard-wired to storage class under `BINARY` and
consults no logical type:

- `nullifFunc` — `compareSqlValues(argX, argY) === 0`
- `greatestFunc` — `compareSqlValues(current, max) > 0`
- `leastFunc` — `compareSqlValues(current, min) < 0`

A plain scalar function gets **no type or collation context**: `implementation`
receives only runtime values. Two separate gaps follow from that, and both must
be closed:

1. **No comparison context.** Nothing tells the implementation what collation or
   logical type the call site's arguments declare. The aggregate and window
   registries already solved this with a `bindArgs` hook called once at emit time
   (`schema/function.ts` `AggregateFunctionSchema.bindArgs`,
   `schema/window-function.ts` `WindowFunctionSchema.bindArgs`,
   both applied from `runtime/emit/aggregate-setup.ts` via
   `argComparisonContext`). See `tickets/complete/1-minmax-semantic-ordering.md`.
   The scalar contract has no equivalent.

2. **No cross-type coercion.** `=` compares a JSON column against a text literal
   correctly only because `insertCrossTypeCoercion` (private in
   `planner/building/expression.ts`) wraps the text side in a synthetic
   `cast(… as json)` at plan-build time. `in` and simple `CASE` get the same
   treatment via `coerceObjectPhysicalSet`. Scalar function arguments get
   neither, so `nullif(doc, '<text>')` compares an object against a string and
   never matches.

## Correction to the originating ticket

The source ticket said scalar `min`/`max` also need this. They do not exist:
`test/logic/06.5.2-scalar-minmax.sqllogic` pins `min(10, 20)` and `max(10, 20)`
as `Function not found: min/2`, and this ticket does not change that. The
multi-argument scalar extrema Quereus actually ships are named **`greatest`** and
**`least`**, and those are what is in scope here. The example
`max('PT2H', 'PT90M')` from that ticket would in any case be correct as written
under the current rules — two bare text literals declare `TEXT`, not `TIMESPAN`,
so text ordering is the right answer for them. The wrong answers need a *column*
whose declared type is `timespan`, as in the repro above.

Also note `clamp` compares with `Number()` coercion, not `compareSqlValues`. It
is numeric-only and out of scope.

## Expected behavior

- `nullif(x, y)` returns NULL exactly when `x = y` returns true for the same
  operand pair — same collation from the shared provenance lattice, same
  logical-type routing, same cross-type coercion. Otherwise it returns `x`.
- `greatest(a, b, …)` / `least(a, b, …)` rank their arguments the same way
  `order by` would rank a column of that declared type and collation:
  `TIMESPAN` by elapsed time, `JSON` structurally, collated text by the declared
  collation.
- Ties under a non-BINARY comparator (`'a'` vs `'A'` under NOCASE, `'PT1H'` vs
  `'PT60M'` for TIMESPAN) leave which raw value `greatest`/`least` return
  **unspecified** — the same latitude the min/max aggregate, DISTINCT, and
  GROUP BY already take. Do not write a test that pins a tie's representative.
- NULL handling is unchanged from today's behavior in each function. Do not
  quietly change it as part of this work; if you find the current handling
  itself is wrong, note it in the review handoff rather than folding it in.

## Design

Two pieces, in dependency order.

### A. Declare which arguments a scalar function compares

Add an optional declaration to `BaseFunctionSchema` naming the argument
positions that are compared *against each other*, e.g.

```ts
/** Argument positions this function compares against one another. `'all'` for a
 *  variadic function that ranks every argument. Drives (a) plan-time cross-type
 *  coercion across the group and (b) the emit-time comparator binding, so a
 *  comparison-based builtin agrees with the `=` operator on the same operands. */
readonly comparesArgs?: 'all' | readonly number[];
```

`nullif` declares `[0, 1]`; `greatest` and `least` declare `'all'`.

Prefer this over a scalar clone of `bindArgs`: the declaration is what the
plan-build coercion step needs too, and one declaration driving both steps keeps
them from disagreeing about which operands form a comparison group. If while
implementing you find a `bindArgs`-shaped hook genuinely fits better, take it —
but then it needs a *separate* plan-time signal for the coercion, so say so in
the handoff.

### B. Plan-time coercion across the group

`insertCrossTypeCoercion`, `coerceObjectPhysicalSet`, and `wrapInCast` are
currently private to `planner/building/expression.ts`. Move them into a shared
module (suggested: `planner/building/coercion.ts`) and re-point the existing
`=`, `in`, and simple-`CASE` call sites at it — no behavior change in that step.
Then, in `planner/building/function-call.ts` at the single scalar build site
(~line 107-128, just before `new ScalarFunctionCallNode(...)`), apply
`coerceObjectPhysicalSet` across the declared comparison group.

Scope this to the **object-physical arm only**, exactly as `in` and simple
`CASE` do. The numeric ↔ textual arm has never applied to those sites either
(`int_col in ('1')` is false today for the same reason) and switching it on here
would change unrelated behavior. Keep the existing note about that.

Note the ordering constraint: coercion inserts `CastNode`s, which changes the
argument types `inferReturnType` sees. Coerce **before** inferring the return
type, or `nullif(doc, '<text>')` will report a different declared type than it
does today.

### C. Emit-time comparator binding

Give `nullif`, `greatest`, and `least` a `customEmitter`
(`BaseFunctionSchema.customEmitter`, dispatched from
`runtime/emit/scalar-function.ts`; `mutationOrdinalFunc` in
`func/builtins/mutation.ts` and `jsonSchemaFunc` in `func/builtins/json.ts` are
working precedents). The emitter has `plan.operands` — the argument
`ScalarPlanNode`s — so it can read each declared logical type and collation and
resolve one comparator for the group at emit time, never per row.

- **Two-operand group (`nullif`).** Resolve with
  `effectiveCollationOfTypes(leftType, rightType, plan.expression)` (or
  `effectiveComparisonCollation` on the nodes) and build the comparator with the
  shared `makeOperandComparator` helper that the prereq ticket lands in
  `runtime/emit/operand-comparator.ts`. That gives `nullif` byte-identical
  routing to `=`.
- **Variadic group (`greatest` / `least`).** The lattice's public two-operand
  entry points do not cover N operands. `resolveComparisonCollation` /
  `mergeContributions` inside `comparison-collation.ts` already do an N-way
  merge for `in` (`resolveInCollation` folds a condition against a list of RHS
  types) — add an N-ary entry point there rather than folding pairwise in the
  emitter, so the resolution stays in its one home and a conflict is reported
  once with all contributors in view. Then pick the comparator from the group's
  declared types: if every argument declares the same semantic-ordering type,
  use that type's compare under the resolved collation
  (`createSemanticValueComparator` in `util/comparison.ts` is the existing
  routing rule); otherwise fall back to storage class + resolved collation.

Keep the existing `implementation` on each function as a correct BINARY default
for any caller that reaches it without emitting (mirrors how the min/max
aggregate keeps a BINARY default alongside `bindArgs`) — do not replace it with
a throw.

### Collation conflicts

Routing through the lattice means an explicit-`COLLATE` conflict inside one of
these calls (`nullif(a collate nocase, b collate rtrim)`) now raises
`collationConflictError` instead of silently comparing under BINARY, matching
what `a collate nocase = b collate rtrim` already does. Intended, but it is a new
error surface — assert it and call it out in the review handoff.

## Coverage

- `test/logic/06.4.2-collation-extras.sqllogic` — `nullif` / `greatest` /
  `least` over `collate nocase` columns, including the explicit-`COLLATE`
  operand forms and the conflict error. Place each next to the corresponding
  `=` assertion.
- `test/logic/15.1-semantic-ordering.sqllogic` — the `timespan` column cases
  (`nullif(d, 'PT120M')`, `greatest(d, e)`, `least(d, e)`) and the JSON
  text-literal case `nullif(doc, '{ "a" : 1 }')`. Use semantically *distinct*
  durations for `greatest`/`least` so no assertion depends on which
  representative survives a tie.
- `test/logic/06.5.2-scalar-minmax.sqllogic` — unchanged; re-confirm the
  `min/2` / `max/2` "function not found" pins still hold.
- A unit spec for the N-ary collation resolution added in
  `comparison-collation.ts` (conflict at equal rank errors; a single explicit
  contributor wins over defaulted ones), alongside the existing collation specs
  in `test/collation-resolver.spec.ts`.

## TODO

### Phase 1 — shared plan-build coercion

- Move `insertCrossTypeCoercion`, `coerceObjectPhysicalSet`, and `wrapInCast`
  out of `planner/building/expression.ts` into `planner/building/coercion.ts`;
  re-point the `=`, `in`, and simple-`CASE` call sites. No behavior change.
- Run `yarn test` here to confirm the move is inert before layering on it.

### Phase 2 — comparison-group declaration and coercion

- Add `comparesArgs` to `BaseFunctionSchema` with the doc comment above.
- Declare it on `nullifFunc` (`[0, 1]`), `greatestFunc` and `leastFunc`
  (`'all'`).
- In `planner/building/function-call.ts`, apply `coerceObjectPhysicalSet` across
  the declared group before `inferReturnType` runs.

### Phase 3 — N-ary collation resolution

- Add an N-ary entry point to `planner/analysis/comparison-collation.ts` that
  merges contributions across a whole operand group and reports a conflict once.
- Unit-test it.

### Phase 4 — emitters

- Add a `customEmitter` to `nullifFunc` that resolves the pair's collation, binds
  a comparator via the shared `makeOperandComparator`, and returns NULL on a
  match / `argX` otherwise.
- Add `customEmitter`s to `greatestFunc` / `leastFunc` that resolve the group's
  collation and comparator and fold over the operands. Keep one comparator
  shared by both directions.
- Leave each `implementation` in place as the unemitted BINARY default.
- Extend each instruction `note` with the resolved collation when non-BINARY.

### Phase 5 — coverage and validation

- Add the sqllogic assertions listed under **Coverage**.
- `yarn workspace @quereus/quereus run lint` and `yarn test`.
- Review handoff must state: the new collation-conflict error surface; that
  tie representatives are deliberately unpinned; whether the `comparesArgs`
  declaration or a scalar `bindArgs` hook was chosen and why; and that the
  numeric ↔ textual coercion arm is still not applied at any of these sites.
