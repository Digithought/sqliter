description: A column declared with the loose "numeric" type may hold whole numbers too large for a JavaScript number, and the code that ordered and compared those columns used to crash on them — now fixed, reviewed, and covered by tests.
files:
  - packages/quereus/src/types/builtin-types.ts             # NUMERIC_TYPE.compare + shared compareNumericValues helper
  - packages/quereus/test/type-system.spec.ts               # NUMERIC_TYPE compare unit tests
  - packages/quereus/test/logic/03.6-type-system.sqllogic   # NUMERIC bigint ordering regression section
  - docs/types.md                                           # NUMERIC now documented under Built-in Types
----

# `NUMERIC`'s comparator no longer throws on bigint — implemented and reviewed

## What was done (implement stage)

`NUMERIC_TYPE.compare` used to delegate to `REAL_TYPE.compare`, whose bare `isNaN(a)`
throws `TypeError: Cannot convert a BigInt value to a number` on a bigint operand —
even though `NUMERIC`'s `validate`/`parse` legitimately accept `bigint`, so a
`numeric` column can hold a whole number past 2^53. A second insert into such a
table crashed on the first key comparison.

It now has its own body: `compareNulls` → NaN handling matching REAL's (typeof-guarded,
NaN sorts smallest, NaN = NaN) → plain `<`/`>` on the `number | bigint` pair, which JS
evaluates by exact mathematical value. `REAL_TYPE.compare` was deliberately left
throwing on bigint: bigint is outside REAL's value space, so reaching it is an upstream
defect.

## Changes made during review

- **DRY** — the `a < b ? -1 : a > b ? 1 : 0` line with its doubled
  `as number | bigint` casts was duplicated verbatim in `INTEGER_TYPE.compare` and
  `NUMERIC_TYPE.compare`. Extracted as a documented module-local
  `compareNumericValues(a, b)`; both types now call it. The comment states the
  precondition (callers handle NULL and NaN first) that the NaN-unsafe `<`/`>` relies on.
- **Docs** — `docs/types.md` § Built-in Types listed INTEGER, REAL, BOOLEAN but had no
  **NUMERIC** entry at all. Added one covering its `number | bigint` value space, its
  NaN handling, and why it does not share REAL's comparator.
- **Tests widened** — the implementer's three unit tests covered the mixed
  bigint/number precision case and NaN-vs-number. Added: NaN vs bigint (the operand
  order the typeof guard exists for), bigint-vs-bigint including equality and
  negatives, bigint vs a fractional double, and NULL placement.
- **SQL-level coverage widened** — the sqllogic regression was a two-row insert.
  Extended to five keys spanning adjacent bigints past 2^53 (`…993`/`…994`), a
  negative bigint, and a fractional double interleaved, plus a `where v >`
  range predicate and a row count, so key placement is exercised over a
  multi-key B-tree rather than a single comparison.

## Review findings

### Verified correct

- The engine really does produce a `bigint` for a large SQL integer literal
  (`typeof` checked through `Database.eval`), so the sqllogic test exercises the fixed
  path rather than a pure-`number` one — the fix is not tested only at the unit level.
- Aggregates and range predicates inherit the fix: `min`/`max`, `between`,
  `count(distinct …)`, and `order by` over a mixed bigint/number/negative/fractional
  `numeric` column all return exact values. This closes the implementer's stated gap
  about `MIN`/`MAX` and `BETWEEN` being unverified.
- `REAL_TYPE.compare` left untouched: correct — `REAL_TYPE.validate` accepts `number`
  only, and `set-op-numeric-promotion-skips-conversion` (which depends on this ticket,
  not the reverse) owns the upstream path that was routing a bigint into it.

### Major — filed as new tickets (both pre-existing, outside this diff)

- `backlog/bug-integer-string-cast-loses-precision` — `cast('9007199254740993' as
  numeric)` (and `as integer`) returns `9007199254740992`. Both types' `parse` convert
  all-digit strings with `parseInt`, which returns a rounded `number`, while the same
  value written as a literal stays an exact `bigint`. Reachable from an explicit CAST,
  a text insert into a numeric column, and the planner's cross-category comparison
  conversions.
- `backlog/bug-order-by-group-key-not-in-select-list` — `select cast(v as text) from t
  group by v order by v` fails with "No row context found for column v". Needs GROUP BY
  + ORDER BY on the key + a select list exposing the key only inside an expression with
  no aggregate; reproduces on plain `integer` and `text` columns, so it is type-agnostic
  and unrelated to this fix. Sorting by the output alias works.

### Tripwire (recorded, not ticketed)

- `NUMERIC_TYPE.physicalType` is `PhysicalType.REAL` even though the value space
  includes `bigint`. Harmless today — nothing encodes or rounds by `physicalType`
  (`packages/quereus-store/src` never reads it; the store keys off the JS value type).
  Parked as a `NOTE:` comment at the field in `builtin-types.ts`.

### Checked, nothing found

- Other delegations to a sibling type's comparator: grepped `*_TYPE.compare` across
  `packages/` — after this change none remain in `src`, so no other type inherits a
  comparator narrower than its own value space.
- Source hygiene: `builtin-types.ts` is 307 lines, one type per const, no long
  functions; no split warranted.
- No unrelated production code was swept into the implement commit. It did also add
  `tickets/fix/equi-join-ignores-join-key-index.md`, a ticket file only — left in place
  per the never-sanitize rule.

## Validation

- `yarn build` — passed.
- `yarn test` (full workspace) — passed, all green; quereus package 7458 passing,
  13 pending. Re-run after the review edits: still 7458 passing.
- `yarn lint` — passed (eslint + `tsc -p tsconfig.test.json --noEmit`).
- No pre-existing test failures; `tickets/.pre-existing-error.md` not written. The two
  defects found during review are not test failures — no test covers either shape —
  so they were filed as tickets rather than reported through that channel.
