---
description: A debug-only mode was added that checks, while a query runs, that every value really is in the JavaScript form its declared type promises — so a plugin or built-in that drifts is caught by a test instead of by a wrong answer months later.
files:
  - packages/quereus/src/runtime/strict-representation.ts     # NEW — the checker (R1/R2, the error class, value rendering)
  - packages/quereus/src/runtime/strict-flags.ts              # REPR_STRICT
  - packages/quereus/src/runtime/emit/scan.ts                 # seam 1 — vtab query() rows
  - packages/quereus/src/runtime/emit/dml-executor.ts         # seam 2 — the row reaching vtab.update (3 sites)
  - packages/quereus/src/runtime/emit/scalar-function.ts      # seam 3 — UDF return value
  - packages/quereus/src/core/statement.ts                    # seam 4 — statement row egress (R1 only)
  - packages/quereus/src/core/database.ts                     # BUG FIX — db.exec(sql, params) never canonicalized its bound args
  - packages/quereus/src/vtab/module.ts                       # module contract prose: the row representation obligation
  - packages/quereus/test/runtime/representation-strict.spec.ts  # NEW — 18 tests (11 flag-independent, 7 seam)
  - packages/quereus/test/property.spec.ts                    # NEW fast-check property: per-declared-type round trip
  - packages/quereus/test/parameter-types.spec.ts             # updated expectation + new companion test
  - packages/quereus/test/filter-conjunct-early-exit.spec.ts  # fixture returned non-canonical bigints
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
| statement row egress | `core/statement.ts` `_iterateWithSignal` | **R1 only** — see the deviation below |

Each is guarded by `if (REPR_STRICT)` read from the module-level const, and every array or
string the check needs is built inside a `REPR_STRICT ? … : undefined` ternary at emit time,
so with the flag off nothing is allocated and nothing is looked up on the checker's behalf.
The scan check is synchronous and inside the existing loop, so enabling it adds no microtask
hop.

# Deviation from the ticket, and why — READ THIS FIRST

**The statement-egress seam checks R1 only, not R2.** The ticket specified R2 there
("checked against the plan's output attribute types"). Wiring it that way produced ~30
failures across the existing suite, and every one was the planner's *inferred* type
disagreeing with the runtime value's storage class — not representation drift:

| query | inferred type | value produced |
|---|---|---|
| `select ? as v` (untyped parameter) | TEXT | a number, or a JS array |
| `select '123' + 0` | TEXT | a number |
| `select t = 'world'` | TEXT | a boolean |
| `select sum(v)` over big integers | REAL | a `bigint` past 2^53 |
| `select 2 * timespan('PT1H')` | REAL | a TIMESPAN string |

R2 as documented is a rule about *declared* types (a column's DDL type). A projection's
`ScalarType` is a static inference and the engine never coerces a projection's output to it,
so asserting R2 there reports inference imprecision, not a representation defect. The seam
keeps R1 — which is exactly what the ticket says the seam is *for* ("catches an expression
producing a non-canonical value"), and R1 is type-independent so it is unaffected. The code
comment at the seam and the docs both state this and point at the new backlog ticket.

**Reviewer: this is the judgement call most worth a second opinion.** If you disagree, the
alternative is to fix the planner's scalar-type inference first
(`backlog/bug-inferred-scalar-type-disagrees-with-runtime-value`, filed with the table
above) and then flip `assertCanonicalValue` → `assertRowConforms` at
`core/statement.ts:_iterateWithSignal`. That one-line flip plus `yarn test:repr-strict` is
the whole regression net for it.

# Real defects the harness found (fixed here)

1. **`db.exec(sql, params)` never canonicalized its bound arguments.**
   `Database._executeSingleStatement` builds its own `boundArgs` map — the fourth parameter
   ingress site, which the prereq ticket's three `Statement` sites missed. `db.exec('insert
   … values (?)', [5n])` carried a safe-range `bigint` all the way into the stored row.
   Fixed by routing it through `canonicalizeSqlValue`, matching `Statement.bindAll`.
   `test/parameter-types.spec.ts` asserted the old (wrong) behaviour — a bound
   `9007199254740991n` returning as a `bigint` — which directly contradicts the shipped
   contract in `docs/types.md` § API surface. Updated, and a companion test added pinning
   that a bigint *past* the safe range still round-trips exactly.

2. **A test fixture returned non-canonical bigints from a UDF.**
   `filter-conjunct-early-exit.spec.ts` drove its truthiness matrix with `0n` and `7n`.
   Under R1 neither form can exist in the engine, so those rows tested unreachable states.
   Replaced with `9007199254740993n` — and note the coverage that *goes away*: there is no
   canonical falsy `bigint` (every out-of-range bigint is non-zero), so "bigint zero is
   falsy" is now untested. That branch is dead under R1; if you want it pinned, pin it as a
   unit test of the truthiness helper, not through a UDF.

# Known failure under the flag — 1 root cause, ticketed

`yarn test:repr-strict` is **not green**. Three tests in
`test/maintained-table-refresh-revalidation.spec.ts` fail (the runner `--bail`s after the
first). One cause: a maintained-table reshape rebuilds the backing contents from the
re-typed source, validates them, and only *then* applies the `retype` op — so between the
rebuild and the retype the table's stored values disagree with its declared column type, and
the validation scan reads it in that state. Filed as
`tickets/fix/bug-mv-reshape-validates-contents-before-retype` (repro: verified, with the
full stack). This is the representation face of a limitation the spec and
`docs/materialized-views.md` already document (a type-sensitive CHECK evaluated under the
pre-retype affinity).

Consequence: `test:repr-strict` is deliberately **not** in the root `yarn check` chain yet.
A `//check-repr` note in the root `package.json` says why and what to do once the fix lands.

# Pre-existing failure, unrelated to this work

`yarn docs:check` fails: `docs/types.md` and `docs/runtime.md` are both over the 12000-word
cap. Both were already over at HEAD (12896 and 12007 words by the script's own `wc -w`
formula, no ratchet entries). This ticket's mandated doc additions (~560 words to types.md,
~180 to runtime.md) made it worse but are not the cause. Recorded in
`tickets/.pre-existing-error.md`; the remedy (split, or `--update-ratchet --force`) is an
editorial call this ticket should not make.

# How to exercise it

```bash
yarn test:repr-strict                      # whole suite under the flag (1 known failure, above)
yarn workspace @quereus/quereus run test    # normal suite — 9078 passing
```

Point it at a plugin:

```bash
QUEREUS_REPR_STRICT=1 <your test command>
```

A violation looks like:

```
repr-strict: representation mismatch at module 'mymod' query() row for main.t column 1 (v):
declared type INTEGER admits a safe-integer number, or a bigint outside the safe-integer
range, but the value is a JS string (5) (rule R2). See docs/types.md § Physical representation.
```

# Test coverage — and where it is thin

`test/runtime/representation-strict.spec.ts` — 18 tests, two halves:

- **11 flag-independent** tests calling the checker directly (so they run on every suite
  pass): R1 at and across the ±2^53 boundary; `null` admissible for every type; INTEGER
  rejecting `1.5` / `'5'` / `true` / `1e20`; REAL number-only vs NUMERIC admitting `bigint`
  (they share a `physicalType`, so the checker special-cases the NUMERIC *name*); JSON
  accepting a document or a bare scalar but not a blob; DATE as `string` while TIMESTAMP
  takes INTEGER's rule; `ANY` constrained by R1 only; `types[i] === undefined` treated as
  normal; the message naming the column and rendering a `bigint` without `JSON.stringify`.
- **7 seam** tests, skipped unless the env var is set (mirroring `fork-contract.spec.ts`): a
  deliberately non-conforming `BigintishModule` in both an R1 (`5n`) and an R2 (`'5'`)
  flavour, asserting the message names the module, table, column, type and rule; that the
  scan's enclosing `catch` rethrows the violation verbatim instead of re-wrapping it as
  "Error during query on table"; a non-conforming UDF caught without being re-reported as
  "Function … failed"; a conforming UDF untouched; the write seam; and a clean round trip
  across all 12 builtin types.

`test/property.spec.ts` — new fast-check property "every builtin type round-trips with its
value AND its JavaScript form intact": one column per builtin type, values spanning the
numeric boundary, insert → select, each returned cell held to its declared type through
`assertConformsToType` plus a value-equality check that tolerates the storage-class
narrowing R1 mandates. Stressed at 400 runs before being committed at 30.

**Gaps I did not close** (also listed in `docs/types.md` § Enforcement):

- A scalar function with a `customEmitter` bypasses the UDF seam entirely — it builds its
  own `run`. Several builtins are in that category, so the UDF seam's real coverage is
  narrower than "all scalar functions".
- Aggregate and window results have no seam of their own; they reach egress, where only R1
  applies. `sum()` returning a `bigint` under a REAL-declared return type is unchecked.
- The checker inspects only the top-level `SqlValue`; it does not walk inside a JSON
  document, so a nested `bigint` is invisible to it (and would make `valueToText` throw —
  the renderer folds that into the message rather than replacing the violation with a
  serializer error, but nothing *detects* it).
- The scan seam assumes a module's `query()` rows are full-width and positionally aligned
  with the declared columns. A module returning a narrower or shifted row would produce
  misleading column attributions rather than a clean "wrong width" error.
- Only the memory backend was exercised under the flag. `yarn test:store` was run and is
  green, but *not* under `QUEREUS_REPR_STRICT` — the store path's read/write seams are
  therefore unverified against R1/R2. That is the single most valuable thing a reviewer
  could add: `QUEREUS_TEST_STORE=true QUEREUS_REPR_STRICT=1 node test-runner.mjs`.

# Validation run

- `yarn build` — clean
- `yarn lint` — clean (all workspaces)
- `yarn typecheck` — clean
- `yarn test` — all workspaces green (9078 in `@quereus/quereus`)
- `yarn test:store` — 9070 passing
- `yarn test:fork-strict` — 9067 passing; `yarn test:context-strict` — 9081 passing
- `yarn test:repr-strict` — 3207 passing, 1 failing (the ticketed maintained-table cause)
- `yarn docs:check` — 2 failures, both pre-existing (see above)

# Rejected alternative, recorded

A `representationFidelity` capability flag on `VirtualTableModule` was considered and
rejected: nothing would behave differently based on it, since the engine tolerates both
numeric forms everywhere and will continue to — a declaring module and a silent one take the
identical code path. The obligation lives in `vtab/module.ts`'s contract prose and
`docs/plugins.md`, and the checker enforces it in tests. Recorded in `docs/types.md`
§ Enforcement so it is not re-litigated.

# Review findings

(To be filled by the review stage.)
