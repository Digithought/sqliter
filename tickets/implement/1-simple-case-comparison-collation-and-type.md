---
description: The short form of CASE decides whether two values match by comparing raw bytes, so it disagrees with the equals operator on case-insensitive text columns and on duration columns.
files:
  - packages/quereus/src/runtime/emit/case.ts            # runSimpleCase — matches() calls compareSqlValues with no type/collation
  - packages/quereus/src/runtime/emit/between.ts         # makeBoundComparator — the routing rule to extract and share
  - packages/quereus/src/runtime/emit/binary.ts          # emitComparisonOp — the behavior CASE must match
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # effectiveComparisonCollation — the shared lattice
  - packages/quereus/src/util/comparison.ts              # compareSqlValues / compareSqlValuesFast / createTypedComparator / hasSemanticOrdering
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts       # tryTemporalCompare
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
difficulty: medium
---

# Simple `CASE` compares raw bytes instead of values

## Reproduced at HEAD (2026-07-27)

Ran against a fresh in-memory `Database`; every line below is actual output, not
expectation.

Case-insensitive column:

```sql
create table t (id integer primary key, n text collate nocase);
insert into t values (1, 'bob');

select n = 'BOB' from t;                                       -- true
select n in ('BOB') from t;                                    -- true
select case n when 'BOB' then 'hit' else 'miss' end from t;    -- 'miss'   WRONG
```

An explicit `COLLATE` does not rescue it either — neither on the base expression
nor on the WHEN operand:

```sql
create table t (id integer primary key, n text collate nocase);
insert into t values (1, 'a');

select case n collate nocase when 'A' then 'hit' else 'miss' end from t;  -- 'miss'  WRONG
select case n when 'A' collate nocase then 'hit' else 'miss' end from t;  -- 'miss'  WRONG
```

Duration column (`docs/types.md` § "Semantic ordering": `'PT2H'` and `'PT120M'`
are one elapsed time, and the engine treats them as equal everywhere else):

```sql
create table a (id integer primary key, d timespan);
insert into a values (1, 'PT2H');

select d in ('PT120M') from a;                                    -- true
select case d when 'PT120M' then 'hit' else 'miss' end from a;    -- 'miss'   WRONG
```

JSON is already covered: the plan-time `cast(… as json)` that
`coerceObjectPhysicalSet` inserts on the simple-`CASE` WHEN operands makes
`case doc when '{ "a" : 1 }' …` return `'hit'`. Leave that path alone.

## Why

`runSimpleCase` in `runtime/emit/case.ts` decides a match with

```ts
compareSqlValues(baseValue, whenValue) === 0
```

`compareSqlValues` is hard-wired to storage class under `BINARY` collation and
consults no logical type, so it cannot see either the column's declared
collation or a logical type that carries its own ordering.

Every other "one probe against N operands" surface already resolves this
properly: `emitIn` and `emitBetween` both pre-resolve a collation (and, in
BETWEEN's case, a per-bound comparator) at emit time via the shared provenance
lattice in `planner/analysis/comparison-collation.ts`. Simple `CASE` was never
wired in. `emitBetween`'s `makeBoundComparator` is the exact shape needed — one
base expression compared against N independently-typed operands.

## Expected behavior

`case x when v1 … when vN` must decide each match exactly as `x = v1` … `x = vN`
would, resolved independently per WHEN clause:

- collation from the shared provenance lattice (explicit `COLLATE` > declared
  column collation > defaults > `BINARY`), symmetric between the base expression
  and that clause's WHEN operand;
- the declared logical type's own `compare` when both sides declare the *same*
  type and that type carries semantic ordering (`TIMESPAN`, `JSON`);
- otherwise the same same-category / runtime-temporal-check routing
  `emitComparisonOp` and `makeBoundComparator` already perform.

NULL handling stays as it is: a NULL base or a NULL WHEN value never matches.

Resolution is **per clause**, not once for the whole CASE — `case n when 'A'
when 'B' collate rtrim …` resolves clause 1 and clause 2 separately, mirroring
how BETWEEN resolves its two bounds.

### Collation conflicts

Routing through `effectiveComparisonCollation` means a genuine conflict
(explicit `COLLATE` on the base *and* a different explicit `COLLATE` on a WHEN
operand) now raises `collationConflictError` instead of silently comparing under
BINARY. That is the same error `=` raises for the same operand pair, and is the
intended outcome — but it is a new error surface, so state it in the review
handoff and cover it with an assertion.

## Design

Extract `makeBoundComparator` out of `runtime/emit/between.ts` into a shared
emit-time helper (suggested home: `runtime/emit/operand-comparator.ts`) so the
routing rule — "same semantic-ordering type ⇒ the type's compare; neither
temporal and same category ⇒ storage class + collation; otherwise runtime
temporal check first" — has exactly one copy. `between.ts` then calls the shared
helper, and `case.ts` calls it once per WHEN clause. Keep the existing doc
comment with the helper; it is the contract that stops BETWEEN, `=`, and CASE
from drifting.

`emitCaseExpr` already receives the `CaseExprNode`, whose `baseExpr` and
`whenThenClauses[i].when` are `ScalarPlanNode`s — the same handles `emitBetween`
uses — so everything resolves at emit time and nothing new happens per row.

Sketch:

```ts
// emit time, simple-CASE arm only
const whenComparators = plan.baseExpr
  ? plan.whenThenClauses.map(clause => {
      const collationName = effectiveComparisonCollation(plan.baseExpr!, clause.when);
      return makeOperandComparator(
        plan.baseExpr!.getType().logicalType,
        clause.when.getType().logicalType,
        ctx.resolveCollation(collationName),
      );
    })
  : [];
```

`runSimpleCase`'s `matches` then takes the clause index and uses
`whenComparators[i]`.

Preserve the two existing invariants in `emitCaseExpr`, both of which have
dedicated coverage (`test/case-short-circuit.spec.ts`):

- **Short-circuit.** Only the matched THEN runs; later WHEN operands are never
  evaluated once a clause matches.
- **Synchronous fast path.** The run must stay synchronous whenever every
  invoked branch resolves synchronously. Do not make `runSimpleCase` `async`.

Include the resolved collation in the instruction `note` when it is not
`BINARY`, the way `emitBetween` and `emitComparisonOp` do, so `explain` output
shows what a CASE actually compares under.

## Coverage

- `test/logic/06.4.2-collation-extras.sqllogic` — the `collate nocase` column
  case, plus the explicit-`COLLATE`-on-base and explicit-`COLLATE`-on-WHEN
  forms, plus a mixed CASE whose clauses resolve to different collations, plus
  the collation-conflict error.
- `test/logic/15.1-semantic-ordering.sqllogic` — the `timespan` column case
  (`case d when 'PT120M'`), and a pin that the existing JSON behavior is
  unchanged.
- Each assertion should sit next to the corresponding `=` / `in` assertion so a
  future divergence is visible in one place.

## TODO

- Move `makeBoundComparator` from `runtime/emit/between.ts` into a shared
  emit-time helper module; re-point `between.ts` at it. No behavior change in
  this step.
- Resolve a per-WHEN collation in `emitCaseExpr` via
  `effectiveComparisonCollation(plan.baseExpr, clause.when)` and build a
  per-clause comparator with the shared helper.
- Rewrite `runSimpleCase`'s `matches` to use the clause's comparator; keep the
  NULL-never-matches rule, the short-circuit, and the synchronous fast path.
- Extend the instruction `note` with the resolved collation(s) when non-BINARY.
- Add the sqllogic assertions listed under **Coverage**.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test`; confirm
  `test/case-short-circuit.spec.ts` and `test/logic/06.9.*`/`15.*` still pass.
- Note in the review handoff: the new collation-conflict error is a behavior
  change, and `nullif` / `greatest` / `least` remain broken (tracked by
  `nullif-greatest-least-comparison-seam`).
