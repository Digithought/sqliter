description: Converting a text value that holds a very large whole number into a number silently changes the number — the last digits get rounded away — even though the same number written directly in a query keeps every digit.
files:
  - packages/quereus/src/types/builtin-types.ts   # INTEGER_TYPE.parse, NUMERIC_TYPE.parse — the two sites to change
  - packages/quereus/src/parser/lexer.ts          # number() — the existing safe-integer→BigInt rule to mirror (~line 716)
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # home for the regression test (append near the `numeric_big` block)
difficulty: easy
----

# Text → INTEGER / NUMERIC conversion rounds whole numbers past 2^53

## Confirmed reproduction

Run against the current build (memory module, `Database` + `db.get`), before any change:

```
select cast(9007199254740993 as numeric)     => 9007199254740993n  (bigint, exact)
select cast('9007199254740993' as numeric)   => 9007199254740992   (number, WRONG)
select cast('9007199254740993' as integer)   => 9007199254740992   (number, WRONG)
select cast('-9007199254740993' as integer)  => -9007199254740992  (WRONG)
select cast('9223372036854775807' as integer)=> 9223372036854776000 (WRONG)
select 9007199254740993 = '9007199254740993' => false              (WRONG — should be true)
insert into t(v numeric) values ('9007199254740993'); select v from t
                                             => 9007199254740992   (WRONG — stored rounded)
```

All three user-visible symptoms (explicit `CAST`, cross-category comparison, insert
into a numeric column) funnel through the same two `parse` implementations, so one
change fixes all three. The comparison path gets there because
`packages/quereus/src/planner/building/coercion.ts` wraps the text operand in a
`CastNode` at plan time, and the insert path because a stored value is coerced to
its column's declared type on write.

## The cause

`packages/quereus/src/types/builtin-types.ts`:

- `INTEGER_TYPE.parse`, string arm — `parseInt(trimmed, 10)` returns a `number`;
  digits past 2^53 are gone before anything can preserve them.
- `NUMERIC_TYPE.parse`, string arm — same, inside the all-digit
  (`/^-?\d+$/`) fast path.

Both types already accept `bigint` in their value space (`validate` returns true for
it, `compare` orders `number | bigint` exactly), so the only missing piece is
producing the bigint from the text path.

## The rule to adopt

The lexer already solves exactly this problem for SQL literals
(`packages/quereus/src/parser/lexer.ts`, `number()`): parse, test
`Number.isSafeInteger`, and on overflow re-read the *original digit string* with
`BigInt(lexeme)`. Mirror that. Note deliberately **no 64-bit clamp** — Quereus
literals already carry arbitrary-precision bigints (`select 99999999999999999999999999`
yields an exact bigint today), so the text path clamping to SQLite's
`9223372036854775807` would make the two paths disagree again in the other direction.
This is a conscious divergence from SQLite; keep it consistent with the literal path.

`Number.isSafeInteger` on the *parsed* value is the boundary test, but the bigint
must be rebuilt from the string — recovering it from the already-rounded number
reproduces the bug.

### INTEGER

`parseInt` accepts a numeric *prefix* (`'12abc'` → 12, `'3.14'` → 3, `'9e18'` → 9) and
that leniency is load-bearing — `cast('3.7' as integer)` and the existing
`cast_order` test in `03.6-type-system.sqllogic` depend on it. `BigInt('12abc')`
throws, so the overflow branch cannot hand it the whole trimmed string. Take the
leading integer run explicitly:

```ts
const m = /^[+-]?\d+/.exec(trimmed);
if (!m) {
    throw new TypeError(`Cannot convert '${v}' to INTEGER`);
}
const digits = m[0];
const parsed = Number(digits);
if (Number.isSafeInteger(parsed)) return parsed;
return BigInt(digits[0] === '+' ? digits.slice(1) : digits);
```

Two traps this dodges: `BigInt('+5')` throws (unlike `Number('+5')`), hence the
sign strip; and the regex must be a *prefix* match (no `$`) to keep `'12abc'`
working. The `!m` arm replaces the old `isNaN(parsed)` throw and is equivalent — a
string with no leading integer run is exactly the one `parseInt` returned NaN for.

### NUMERIC

The all-digit branch's regex already guarantees `BigInt(trimmed)` succeeds, so it is
a two-line change inside the existing `if`:

```ts
if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) return parsed;
    return BigInt(trimmed);
}
```

Everything that fails that regex keeps falling through to `parseFloat` untouched.

## Decisions on the edge cases the source ticket asked to pin down

Verified with the patch applied; encode each in the regression test so a future
change has to argue with a test rather than guess:

| input | result | why |
| --- | --- | --- |
| `cast('9007199254740993' as integer/numeric)` | `9007199254740993` bigint | the fix |
| `cast('-9007199254740993' as integer)` | `-9007199254740993` bigint | sign preserved |
| `cast('9223372036854775807' as integer)` | exact bigint | no 64-bit clamp |
| `cast('99999999999999999999999999' as integer)` | exact bigint | arbitrary precision, same as the literal path |
| `cast('9007199254740993.0' as numeric)` | `9007199254740992` number (REAL) | not all-digit → `parseFloat`; a fractional form is a double by definition, and this matches SQLite |
| `cast('9e18' as integer)` | `9` | prefix semantics, unchanged, matches SQLite |
| `cast('9007199254740993abc' as integer)` | `9007199254740993` bigint | prefix semantics *plus* the fix |
| `cast('12abc' as integer)`, `cast('3.14' as numeric)`, `cast('  42  ' as integer)` | `12`, `3.14`, `42` number | unchanged |
| `cast('abc' as integer)` | `0` | `parse` throws → `castFallback` — unchanged |
| `cast('' as integer)` | `null` | empty-string arm — unchanged |

## Out of scope (do not chase here)

`select '9007199254740993' + 0` still yields the rounded `9007199254740992`. That is
a different path — SQL arithmetic affinity in
`packages/quereus/src/util/coercion.ts` (`coerceToNumberForArithmetic`, which returns
`number` by signature) feeding `mixedBigIntArithmetic` in
`packages/quereus/src/runtime/emit/binary.ts`. Fixing it means widening that
function's return type and is a separate ticket's worth of blast radius. If you touch
nothing else, leave a `NOTE:` at `coerceToNumberForArithmetic` pointing at this
asymmetry so the next reader meets it. Likewise `min('5','10')`-style aggregate
coercion (`coerceForAggregate`) is already tracked as backlog
`bug-text-minmax-numeric-coercion`.

## Validation performed at fix stage

The patch above was applied, the full `yarn test` suite run (all packages, ~3m20s)
with **zero failures**, and then reverted — the working tree is clean at handoff.
So the change is known not to regress the existing suite; what remains is landing it
plus the regression test.

## TODO

- Change `INTEGER_TYPE.parse`'s string arm in
  `packages/quereus/src/types/builtin-types.ts` to the prefix-regex + safe-integer +
  `BigInt` form above.
- Change `NUMERIC_TYPE.parse`'s all-digit branch in the same file to the
  `Number` + `Number.isSafeInteger` + `BigInt` form.
- Add a short comment at each site naming the safe-integer boundary and pointing at
  `lexer.ts`'s `number()` as the sibling rule, so the two stay in step.
- Append a regression block to
  `packages/quereus/test/logic/03.6-type-system.sqllogic` (next to the existing
  `numeric_big` block) covering every row of the decision table above. Use
  `cast(... as text)` on bigint results so the expected JSON is a plain string, the
  way `numeric_big` already does.
- Add a case asserting `select 9007199254740993 = '9007199254740993'` is `true` and
  `= '9007199254740992'` is `false` — the cross-category comparison symptom, which is
  what actually silently matched the wrong row.
- Add an insert-side case: a text value past 2^53 written into a `numeric` column
  reads back exact.
- Consider whether `docs/types.md` states the text→numeric conversion rule; if it
  does, update it to mention the bigint boundary. Do not add a new doc.
- Run `yarn test` and `yarn lint` from the repo root.
