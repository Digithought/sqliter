---
description: The short form of CASE now decides matches the same way the equals operator does, so it agrees on case-insensitive text columns and on duration columns instead of comparing raw bytes.
files:
  - packages/quereus/src/runtime/emit/operand-comparator.ts   # NEW — shared comparator + note formatter
  - packages/quereus/src/runtime/emit/case.ts                 # per-WHEN collation + comparator
  - packages/quereus/src/runtime/emit/between.ts              # re-pointed at the shared helper
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # unchanged; the lattice CASE now calls
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - docs/types.md                                             # § Comparison collation resolution
difficulty: medium
---

# Simple `CASE` compares values, not bytes — review handoff

## What the bug was

`runSimpleCase` decided a WHEN match with `compareSqlValues(base, when) === 0`.
That function is hard-wired to storage class under BINARY collation and consults
no logical type, so simple `CASE` disagreed with `=` and `IN` on exactly the two
axes those consult:

```sql
create table t (id integer primary key, n text collate nocase);
insert into t values (1, 'bob');
select n = 'BOB' from t;                                     -- true
select case n when 'BOB' then 'hit' else 'miss' end from t;  -- was 'miss'
```

```sql
create table a (id integer primary key, d timespan);
insert into a values (1, 'PT2H');
select d in ('PT120M') from a;                                  -- true
select case d when 'PT120M' then 'hit' else 'miss' end from a;  -- was 'miss'
```

An explicit `COLLATE` on either side did not rescue it either.

## What changed

**New shared module `runtime/emit/operand-comparator.ts`.** `between.ts`'s
private `makeBoundComparator` moved here as `makeOperandComparator`, with the
doc comment (the contract that stops BETWEEN, `=` and CASE drifting) carried
along and re-worded from "BETWEEN bound" to "one operand of a probe-against-N
construct". The one signature change: it takes the operand's `LogicalType`
directly rather than the operand's `ScalarPlanNode`, since `case.ts` and the
follow-on `nullif`/`greatest`/`least` ticket both hold types more naturally than
nodes. `between.ts` now passes `plan.lower.getType().logicalType`.

`between.ts`'s private `formatBetweenCollationNote` also moved here, generalized
from exactly-two names to N as `formatOperandCollationNote`. For two names the
output is byte-identical to before (`` for both-BINARY, ` NOCASE` when equal,
` NOCASE/BINARY` when they differ).

**`case.ts`, simple-CASE arm only.** At emit time the emitter now resolves one
collation per WHEN clause via
`effectiveComparisonCollation(plan.baseExpr, clause.when)` and builds one
comparator per clause with `makeOperandComparator`. `runSimpleCase`'s `matches`
took a clause index and consults `whenComparators[i]`. Resolution is per clause,
not once for the whole CASE — mirroring how BETWEEN resolves its two bounds
independently, not how IN merges to a single collation.

The instruction `note` gained the collation suffix, so `explain`-style program
dumps show what each clause compares under:

```
case(short-circuit, 1 when clauses) NOCASE
case(short-circuit, 2 when clauses) NOCASE/BINARY
case(short-circuit, 1 when clauses)              -- all BINARY: no suffix
```

**Searched CASE is untouched** — its WHEN is an ordinary boolean expression
whose own comparison already resolved through the lattice.

**`docs/types.md`** § Comparison collation resolution: simple `CASE` added to
the opening list of comparison forms, plus a new bullet under *Related forms*
covering per-clause resolution, the conflict rule, and the shared routing.

## Behavior changes a reviewer should weigh

**New error surface (intended, but new).** Routing through the lattice means a
genuine collation conflict now raises instead of silently comparing under
BINARY. Both forms are reachable:

```sql
select case n collate rtrim when 'A' collate nocase then 'hit' end from t;
-- error: conflicting COLLATE clauses in comparison: RTRIM vs NOCASE
select case a when b then 'hit' end from t2;   -- a nocase column vs a rtrim column
-- error: ambiguous collation for comparison: column collations NOCASE vs RTRIM differ; …
```

These are the same two errors `=` raises for the same operand pairs, and both
are asserted in `06.4.2` next to the `=` parity assertion.

**The throw happens at EMIT time, not plan time.** `=` forces
`BinaryOpNode.getType()` in `planner/building/expression.ts` so a conflict
errors while the plan is being built; `CaseExprNode.generateType` does no such
validation, so the CASE conflict surfaces when `emitCaseExpr` runs. In practice
both land inside `db.prepare` and are indistinguishable to a caller — every
assertion above passes. **This is the judgement call most worth a second
opinion:** if a future optimizer rule ever prunes a `CaseExprNode` before emit
(constant folding a CASE whose base is a constant, say), the conflict would go
unreported, whereas the `=` equivalent would still error. Moving the resolution
into `CaseExprNode.generateType` (resolve there, cache, have the emitter read
it) would close that. I did not do it because the ticket's design put resolution
at emit time and the node currently has no comparison-validation hook at all.

## Use cases to exercise

The behavior is entirely observable from SQL; no internal API changed except the
two moved helpers.

- **Case-insensitive column.** `n text collate nocase` holding `'bob'`:
  `case n when 'BOB'` hits; `case n when 'bill'` misses. Compare against
  `n = 'BOB'` and `n in ('BOB')` — all three must agree.
- **Explicit `COLLATE` on either side of a BINARY-defaulted column.**
  `case n collate nocase when 'A'` and `case n when 'A' collate nocase` both hit;
  bare `case n when 'A'` misses.
- **Per-clause independence.** One CASE whose clause 1 resolves NOCASE (from the
  column), clause 2 RTRIM (explicit on the WHEN) and clause 3 BINARY (explicit
  `collate binary` beating the column's declared NOCASE) — each clause decides
  under its own collation.
- **Semantic-ordering type.** `d timespan` holding `'PT1H'`/`'PT60M'`:
  `case d when 'PT60M'` hits both rows, agreeing with `d = 'PT60M'` and
  `d in ('PT60M')`.
- **Negative control that must NOT change.** A plain `text` column holding
  duration-shaped text (`'PT30M'`) stays text-compared:
  `case v when 'PT0.5H'` misses, exactly as `v = 'PT0.5H'` is false. Only a
  *declared* semantic-ordering type changes identity.
- **JSON unchanged.** `case doc when '{ "a" : 2 }'` still hits structurally —
  that path is carried by the plan-time `cast(… as json)` the expression builder
  inserts on simple-CASE WHEN operands, which this change deliberately left
  alone.
- **Short-circuit and sync fast path preserved.** `runSimpleCase` is still not
  `async`, still evaluates only the matched THEN, and still evaluates the base
  exactly once per row. `test/case-short-circuit.spec.ts` (19 assertions) is the
  guard and passes unchanged.
- **NULL rule unchanged.** A NULL base or a NULL WHEN value never matches.

## Coverage added

`test/logic/06.4.2-collation-extras.sqllogic` — new section *Simple CASE
resolves its collation exactly as `=` / IN do*: NOCASE column (with the sibling
`=` and `in` assertions immediately above it), a NOCASE-distinct miss, explicit
`COLLATE` on base, explicit `COLLATE` on WHEN, a desugared `=` parity line, the
plain-BINARY negative, a three-clause mixed-collation CASE, both conflict errors
plus the `=` parity error, and a searched-CASE-unaffected pin.

`test/logic/15.1-semantic-ordering.sqllogic` — `case d when 'PT60M'` beside the
existing `in ('PT60M')` assertions, a per-clause miss-then-hit
(`when 'PT59M' … when 'PT3600S'`), the plain-TEXT negative control beside its
`=` result, and a JSON structural pin.

## Known gaps — please treat as a floor, not a finish line

- **No test pins the `note` collation suffix.** I verified all three forms by
  hand through `Statement.getDebugProgram()` (output quoted above) but wrote no
  automated assertion. There is no existing convention in the repo for asserting
  instruction notes from a spec, and inventing one felt out of scope; if the
  reviewer disagrees this is a cheap one to add.
- **`nullif` / `greatest` / `least` are still BINARY-blind.** Untouched here;
  tracked by `nullif-greatest-least-comparison-seam` (sits in `implement/` and
  declares this ticket as its prereq, and expects exactly the
  `makeOperandComparator` / `operand-comparator.ts` shape that landed).
- **The numeric ↔ textual coercion arm is still not applied to simple CASE.**
  `case int_col when '1'` remains a miss, matching `int_col in ('1')`. That is
  pre-existing and deliberately out of scope (the plan-time
  `coerceObjectPhysicalSet` covers only the object-physical arm) — but it means
  simple CASE and `=` still disagree on *that* axis, since `=` does get the
  numeric↔textual cast from `insertCrossTypeCoercion`. Worth confirming the
  reviewer agrees that is the right scope line.
- **`yarn test:store` was not run.** The change is entirely emit-side and
  backend-agnostic, and the added assertions are in files the store suite also
  runs; a reviewer wanting belt-and-braces could run it.
- **Untested interaction:** a simple CASE whose base is a bound parameter with
  an unhinted type, compared against a collated column operand. The lattice
  handles it (the parameter contributes nothing, so the column's collation
  wins), but there is no assertion for it.

## Validation run

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json --noEmit`).
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn test` — all workspaces green, 0 failing (quereus: 7416 passing).
  Targeted re-runs of `06.4.2`, `15.1-semantic-ordering`,
  `case-short-circuit.spec.ts` and `documentation.spec.ts` all pass.
- No pre-existing failures encountered, so `tickets/.pre-existing-error.md` was
  not written.
