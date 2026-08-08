---
description: A debug-only mode was added that checks, while a query runs, that every value really is in the JavaScript form its declared type promises — so a plugin or built-in that drifts is caught by a test instead of by a wrong answer months later.
files:
  - packages/quereus/src/runtime/strict-representation.ts     # the checker (R1/R2, the error class, value rendering)
  - packages/quereus/src/runtime/strict-flags.ts              # REPR_STRICT
  - packages/quereus/src/runtime/emit/scan.ts                 # seam 1 — vtab query() rows
  - packages/quereus/src/runtime/emit/dml-executor.ts         # seam 2 — the row reaching vtab.update (3 sites)
  - packages/quereus/src/runtime/emit/scalar-function.ts      # seam 3 — UDF return value
  - packages/quereus/src/core/statement.ts                    # seam 4 — statement row egress (R1 only)
  - packages/quereus/src/core/database.ts                     # BUG FIX — db.exec(sql, params) never canonicalized its bound args
  - packages/quereus/src/index.ts                             # REVIEW — exports the canonicalize helpers the docs promise
  - packages/quereus/src/vtab/module.ts                       # module contract prose: the row representation obligation
  - packages/quereus/test/runtime/representation-strict.spec.ts  # 20 tests (11 flag-independent, 9 seam)
  - packages/quereus/test/property.spec.ts                    # fast-check property: per-declared-type round trip
  - packages/quereus/test-runner.mjs                          # --repr-strict
  - docs/types.md                                             # § Enforcement: QUEREUS_REPR_STRICT
  - docs/runtime.md                                           # § Strict physical-representation test mode
  - docs/plugins.md                                           # § Returning values in the right JavaScript form
difficulty: medium
---

# What landed

An opt-in runtime harness, `QUEREUS_REPR_STRICT=1`, that asserts the two physical-
representation rules from `docs/types.md`:

- **R1 (canonical numeric form)** — a `SqlValue` is a JS `bigint` only when its magnitude is
  outside the safe-integer range; every safe-range integer is a `number`.
- **R2 (per-declared-type value space)** — a value in a position of a declared type inhabits
  that type's JS value space. `null` is always admissible.

The checker is `runtime/strict-representation.ts`, exporting `assertCanonicalValue`,
`assertConformsToType`, `assertRowConforms` and a `RepresentationError extends QuereusError`
(`StatusCode.INTERNAL`). Run it with `yarn test:repr-strict` (from the root or from
`packages/quereus`), which is `node test-runner.mjs --repr-strict`.

## Seams wired

| seam | file | checks |
|---|---|---|
| vtab scan output | `runtime/emit/scan.ts`, inside the existing `for await` | R1 + R2 vs the table's declared column types |
| DML write | `runtime/emit/dml-executor.ts`, immediately before each of the 3 row-bearing `vtab.update` calls | R1 + R2 vs declared column types |
| UDF return | `runtime/emit/scalar-function.ts`, after the implementation's `try`/`catch` | R1 + R2 vs the schema's declared return type |
| statement row egress | `core/statement.ts` `_iterateWithSignal` | **R1 only** — see below |

Each is guarded by `if (REPR_STRICT)` read from the module-level const, and every array or
string the check needs is built inside a `REPR_STRICT ? … : undefined` ternary at emit time,
so with the flag off nothing is allocated and nothing is looked up on the checker's behalf.
The scan check is synchronous and inside the existing loop, so enabling it adds no microtask
hop.

## The statement-egress seam checks R1 only

The original ticket specified R2 there. Wiring it that way produced ~30 failures across the
existing suite, and every one was the planner's *inferred* type disagreeing with the runtime
value's storage class (`select ? as v` inferring TEXT and yielding a number; `sum(v)`
inferring REAL and yielding a `bigint` past 2^53) rather than representation drift. R2 as
documented is a rule about *declared* types; a projection's `ScalarType` is a static
inference. The seam keeps R1, which is type-independent and is what the seam is for.

Reviewed and upheld — with one correction to the reasoning, see finding **F1**.

# Real defects the harness found

1. **`db.exec(sql, params)` never canonicalized its bound arguments.**
   `Database._executeSingleStatement` builds its own `boundArgs` map — a fourth parameter
   ingress site the prereq ticket's three `Statement` sites missed, so
   `db.exec('insert … values (?)', [5n])` carried a safe-range `bigint` into the stored row.
   Fixed by routing it through `canonicalizeSqlValue`. `test/parameter-types.spec.ts`
   asserted the old (wrong) behaviour and was updated, with a companion test pinning that a
   bigint *past* the safe range still round-trips exactly.

2. **A test fixture returned non-canonical bigints from a UDF.**
   `filter-conjunct-early-exit.spec.ts` drove its truthiness matrix with `0n` and `7n`,
   states that cannot exist under R1. Replaced with `9007199254740993n`. Coverage that goes
   away: there is no canonical falsy `bigint`, so "bigint zero is falsy" is now untested —
   that branch is dead under R1.

3. **A REAL-declared column can be made to store a `bigint`** — found during review, routed
   to an existing ticket. See finding **F1**.

# Known failure under the flag — 1 root cause, ticketed

`yarn test:repr-strict` is not green: **3 failing, all in
`test/maintained-table-refresh-revalidation.spec.ts`, all one cause.** A maintained-table
reshape rebuilds the backing contents from the re-typed source, validates them, and only
*then* applies the `retype` op, so the validation scan reads the table while its stored
values disagree with its declared column type. Filed as
`tickets/fix/bug-mv-reshape-validates-contents-before-retype` (repro: verified). This is the
representation face of a limitation the spec and `docs/materialized-views.md` already
document.

Consequence: `test:repr-strict` is deliberately **not** in the root `yarn check` chain yet.
A `//check-repr` note in the root `package.json` says why and what to do once the fix lands.

# How to exercise it

```bash
yarn test:repr-strict                       # whole suite under the flag (3 known failures, above)
yarn workspace @quereus/quereus run test     # normal suite
QUEREUS_REPR_STRICT=1 <your plugin's test command>
```

A violation looks like:

```
repr-strict: representation mismatch at module 'mymod' query() row for main.t column 1 (v):
declared type INTEGER admits a safe-integer number, or a bigint outside the safe-integer
range, but the value is a JS string (5) (rule R2). See docs/types.md § Physical representation.
```

# Remaining coverage gaps (also listed in `docs/types.md` § Enforcement)

- A scalar function with a `customEmitter` bypasses the UDF seam entirely — it builds its
  own `run`. Several builtins are in that category.
- Aggregate and window results have no seam of their own; they reach egress, where only R1
  applies.
- The checker inspects only the top-level `SqlValue`; a `bigint` nested inside a JSON
  document is invisible to it.
- The scan seam assumes a module's `query()` rows are full-width and positionally aligned
  with the declared columns. A narrower or shifted row produces misleading column
  attributions rather than a clean "wrong width" error.

# Review findings

## What was checked

Read the implement diff (`a268fbd0`) before the handoff prose, then the current state of
every file it touched. Re-derived the R1/R2 rules from `docs/types.md` and
`util/numeric-canonical.ts` and re-read each of the four seams against them. Probed the
checker's behaviour at the seams with a throwaway spec (deleted) covering: a huge integer
literal into a REAL column, the same via UPDATE, an aggregate through a scalar subquery, a
UDF with an explicitly declared REAL / TEXT return type in both sync and async form, a JSON
document with a nested out-of-range integer, and boolean-into-ANY. Verified every
cross-reference the diff added (ticket slugs, doc anchors, claimed exports). Ran the whole
validation chain plus two runs the handoff had not done.

**Validation run (after the fixes below):** `yarn build`, `yarn lint`, `yarn typecheck`,
`yarn docs:check` all clean; `yarn test` green across all workspaces (9078 in
`@quereus/quereus`); `node test-runner.mjs --store` 9070 passing.

Two runs the handoff did not do:

- **`node test-runner.mjs --store --repr-strict`** — the handoff nominated this as "the
  single most valuable thing a reviewer could add", since only the memory backend had been
  exercised under the flag. Result: **clean**. No store-path R1/R2 violation; the only
  failure is the ticketed maintained-table one. The store read/write seams conform.
- **`node test-runner.mjs --repr-strict -- --no-bail`** — the runner hardcodes `--bail`, so
  the handoff's "3207 passing, 1 failing" is where the run *stopped*, not what it covered.
  The real figure is **9084 passing, 16 pending, 3 failing**, the 3 being the one ticketed
  cause. The flag's true coverage is the whole suite, which is materially better news than
  the handoff reported.

## Major — routed to an existing ticket

**F1. The inferred scalar type is not embedder-only metadata: the engine consumes it, and a
wrong announcement stores a wrongly-shaped value.** `emitInsert` builds its declared-type
coercion with `buildRowCoercion(sourceAttrs…, tableSchema.columns)` — driven by each source
expression's *announced* type — and deliberately skips a cell whose announced type already
equals the column's declared type. When the announcement is wrong, that skip lets a
non-conforming value into storage. Repro (verified, with the flag **off**):

```sql
create table s (id integer primary key, v integer);
insert into s values (1, 9007199254740993), (2, 9007199254740993);
create table t (id integer primary key, r real);
insert into t values (1, (select sum(v) from s));
select r from t;   -- JS bigint 18014398509481986n out of a REAL column
```

`sum()` announces REAL, the value is a `bigint`, REAL-into-REAL skips the coercion. With the
flag on, the DML write seam catches it — the harness works; the defect is upstream.

Disposition: this is the same root cause as the already-filed
`backlog/bug-inferred-scalar-type-disagrees-with-runtime-value`, so per the "Nth instance is
evidence, not a new ticket" rule it was appended there as **arm 2** rather than filed fresh.
That ticket's `tradeoffs:` line asserted "nothing inside the engine consumes the announced
type at runtime — it is metadata for embedders only", which this refutes; the header and the
body's impact paragraph were corrected, `runtime/emit/insert.ts` and `types/validation.ts`
added to its `files:`, and a matching use case added. Its severity was already
`wrong-result`; likelihood stays `unusual` (it needs an aggregate past 2^53 landing in a
REAL column).

This also refines the handoff's egress-seam justification, which is otherwise upheld: the
seam is right to stay R1-only, but the *reason* is narrower than "the engine never coerces a
projection's output to its inferred type" — it coerces on the INSERT path, and that is
exactly where the announcement's imprecision does damage. The comment at
`core/statement.ts:_iterateWithSignal` was rewritten to say so.

## Minor — fixed in this pass

**F2. The docs promised two exports that did not exist.** `docs/plugins.md` ("`canonicalizeInteger`
and `canonicalizeSqlValue` (exported from the package)") and the new `vtab/module.ts`
contract prose ("are exported to get it right") both direct plugin authors at helpers that
were not in `src/index.ts` — and the package's `exports` map is `.` / `./parser` / `./emit`
only, so there is no deep-import escape either. A plugin author following the new
documentation got a resolution failure at the exact moment the docs told them to comply.
Fixed by exporting `canonicalizeInteger`, `canonicalizeSqlValue` and `isCanonicalNumeric`
from `src/index.ts`.

**F3. The UDF seam's R2 half had no test.** All the UDF seam tests register through
`Database.createScalarFunction`, which never passes a `returnType` — every function it
registers is ANY, so only R1 was reachable and the entire declared-return-type branch was
unexercised. So was the `result instanceof Promise` arm: no async implementation was tested
at all. Both verified working by hand, then pinned: two new seam tests register through
`registerFunction` with an explicit REAL / TEXT scalar return type and assert the R2 message
for a sync implementation, for an async one, and that a conforming async function still
returns its value. Seam tests 7 → 9, spec total 18 → 20.

**F4. `_iterateWithSignal` had grown three near-duplicate loops** (strict, signal-only,
neither) with the R1 check open-coded as a nested `for` inside the first. Collapsed to the
`yield* source` fast path plus one loop, with the check delegating to the existing
`assertRowConforms` under a named `NO_DECLARED_TYPES` constant — the helper's
`types[i] === undefined` arm already *is* "R1 only, named columns", so the open-coded loop
was duplicating it. Message text is unchanged. Verified identical behaviour with the flag
both on and off.

## Tripwires — recorded at the site, not filed

**F5. `NUMERIC` is discriminated by `type.name === 'NUMERIC'`** in `conformsToType` /
`admissibleForms`, while the codebase's established idiom for exactly this discrimination
(`isSeekKeySpaceNumeric` in `types/builtin-types.ts`) compares by identity against the
registry singleton and documents why. Name-matching means a plugin-registered
REAL-physical type *named* `NUMERIC` would silently inherit bigint admission. No such type
exists in tree and the surrounding switch is keyed on `physicalType` on purpose, so this is
correct today. `NOTE:` at the site in `runtime/strict-representation.ts` naming the exit
(an explicit "admits bigint" property on `LogicalType`) if one is ever registered.

## Checked and found nothing

- **Zero-cost-when-off claim.** Every seam is behind the module-level const, every support
  array is inside a `REPR_STRICT ? … : undefined` ternary at emit time, and the scan check is
  synchronous inside the existing loop. Verified per site; the claim holds.
- **Error-handling placement.** The three deliberate choices — rethrowing `RepresentationError`
  verbatim past the scan's re-wrapping `catch`, checking the UDF result outside the
  implementation's `try` so a violation is not re-reported as "Function … failed", and placing
  the DML checks outside the constraint `catch` — are each correct and each covered by a test.
- **Row/type alignment at the DML seam.** `newRow` comes from
  `extractNewRowFromFlat(flatRow, tableSchema.columns.length)`, so it is full-width and
  positionally aligned with `tableSchema.columns`; the seam's arrays cannot mis-attribute.
- **`renderValue` totality.** Routes through `valueToText` (total over `SqlValue`, and
  explicitly not `JSON.stringify`, whose BigInt arm throws on exactly the values this checker
  catches), truncates at 80 chars, and folds a nested-bigint serializer failure into the
  message rather than replacing the violation with it. Tested.
- **Docs.** Every file the change touched was re-read against the new reality, plus
  `docs/architecture.md` and the two files the intervening docs split moved content into
  (`docs/types-ordering.md`, `docs/runtime-parallel.md`) to confirm the new § Enforcement and
  § Strict physical-representation test mode sections survived it. Anchors and ticket slugs
  in the new prose all resolve. `yarn docs:check` passes — the word-cap failure the handoff
  recorded as pre-existing was resolved by the intervening triage commit `a781541f`, and
  `tickets/.pre-existing-error.md` is correctly gone.
- **No new pre-existing failures.** Nothing surfaced outside this diff's blast radius.

## Deliberately not filed

The four remaining coverage gaps listed above are each a *stated* limit of a net that is
explicitly not a proof, and each is already written into `docs/types.md` § Enforcement where
the next reader meets them. Filing four tickets to widen a debug-only harness would grow the
board without making the codebase harder to break. The one that would change that calculus —
the store path being unverified — was closed by running it here.
