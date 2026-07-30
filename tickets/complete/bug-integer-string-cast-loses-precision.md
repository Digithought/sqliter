---
description: Converting a text value that holds a very large whole number into a number used to silently change the number — the last digits got rounded away — even though the same number written directly in a query kept every digit. Fixed and reviewed.
prereq:
files:
  - packages/quereus/src/types/builtin-types.ts             # INTEGER_TYPE.parse, NUMERIC_TYPE.parse — the changed sites
  - packages/quereus/src/parser/lexer.ts                    # number() — the sibling safe-integer→BigInt rule (unchanged, mirrored)
  - packages/quereus/src/util/coercion.ts                   # coerceToNumberForArithmetic — NOTE: comment only, logic unchanged
  - packages/quereus/test/logic/03.6-type-system.sqllogic   # regression block after `numeric_big`
  - docs/types.md                                           # INTEGER / NUMERIC value-space bullets
difficulty: easy
---

## What shipped

`INTEGER_TYPE.parse` and `NUMERIC_TYPE.parse` (`packages/quereus/src/types/builtin-types.ts`)
converted a numeric string through `parseInt` / inline `Number()`, which returns a JS
`number` and silently rounds past `Number.MAX_SAFE_INTEGER` (2^53 - 1). Both types already
accepted `bigint` in their value space; only the string arm failed to produce one.

One bug, three symptoms, one fix:

- `cast('9007199254740993' as integer/numeric)` returned the rounded value.
- `9007199254740993 = '9007199254740993'` was `false` — the planner inserts a CAST on the
  text operand at plan time (`planner/building/coercion.ts`), hitting the same parse.
- Inserting `'9007199254740993'` into a numeric column stored the rounded value.

The fix mirrors the rule the lexer already applies to INTEGER literals (`parser/lexer.ts`,
`number()`): parse, test `Number.isSafeInteger`, and on overflow rebuild from the **original
digit string** with `BigInt(...)` — recovering from the already-rounded number would just
reproduce the bug. `INTEGER_TYPE.parse` takes the leading integer run via
`/^[+-]?\d+/` to preserve `parseInt`'s prefix leniency (`'12abc'` → `12`), which
`BigInt()` alone cannot do.

**No 64-bit clamp, deliberately.** Quereus integer literals are already
arbitrary-precision (`select 99999999999999999999999999` is exact today), so clamping the
text path to SQLite's `INT64_MAX` would make the two paths disagree in the other
direction. Documented as an intentional SQLite divergence.

## Review findings

Reviewed the implement diff (`fe642929`) first, then the surrounding code, then the
handoff.

### Verified correct — no change needed

- **The regex rewrite the implementer flagged for a second pair of eyes.**
  `/^[+-]?\d+/.exec(trimmed)` returning `null` is exactly the input set for which
  `parseInt(trimmed, 10)` returned `NaN` — both mean "no leading sign-plus-digits run".
  Radix is pinned to 10 in both, `\d` is ASCII-only in both, and the string is already
  trimmed. Spot-checked against the running engine: `' -0012abc'` → `-12`, `'0x10'` → `0`,
  `'  +42'` → `42`, `'abc'` → `0` (via `castFallback`), `''` → `null`. The read is right.
- **No missed conversion site.** The `integer()` builtin (`func/builtins/conversion.ts`),
  which `docs/architecture.md` says is *preferred over CAST syntax*, shares
  `INTEGER_TYPE.parse` and is exact — confirmed by running it. Column writes go through
  `validateAndParse` → the same `parse`. `coerceForComparison` in `util/coercion.ts` is
  `@deprecated` and no longer called from comparison emission, so its lossy
  `tryCoerceToNumber` is not a live comparison path.
- **`INTEGER_TYPE.validate` accepts the new values.** It admits any `bigint`, so a
  bigint-producing write does not trip the column type check.
- **Doc claim in the handoff.** `docs/types.md`'s NUMERIC bullet does state the value
  space includes `bigint` past 2^53 and makes no incorrect claim about string conversion —
  the implementer's read was correct. It was silent rather than wrong, which is the gap
  addressed below.

### Fixed in this pass

- **`cast('+9007199254740993' as numeric)` still rounded.** `NUMERIC_TYPE.parse`'s
  integer arm guards on `/^-?\d+$/`, which rejects an explicit leading `+`, so that
  spelling fell through to `parseFloat` and lost precision — disagreeing with
  `INTEGER_TYPE.parse`, which the same diff had just taught to accept `+`. Widened to
  `/^[+-]?\d+$/` with the `+` stripped before `BigInt()` (which rejects the sign `Number()`
  accepts). Sub-2^53 behavior is unchanged: `'+42'` was and still is `42`.
- **Three test gaps.** The `+`-stripping branch of `INTEGER_TYPE.parse` — the subtlest
  line in the diff, and one that fails *silently* to `0` via `castFallback` if it
  regresses — had no coverage at all. Neither did the `integer()` function twin, nor the
  insert path into a declared `INTEGER` column (only `NUMERIC` was covered, and the two
  run different `parse` implementations with different `validate` strictness). Added,
  plus the new `+`-on-NUMERIC cases.
- **Doc gap.** `docs/types.md` described the INTEGER and NUMERIC value spaces but said
  nothing about how *text* converts into them — the one place a reader would look to
  learn that there is no `INT64_MAX` clamp, that the leading-run prefix rule applies, and
  that a fractional spelling (`'9007199254740993.0'`) still goes to REAL and rounds. Added
  to both bullets.

### Filed as new tickets (major, out of scope here)

- `backlog/bug-text-arithmetic-loses-precision` — `'9007199254740993' + 0` and
  `sum('9007199254740993')` both still round. The implementer parked this as a `NOTE:` at
  `coerceToNumberForArithmetic` per the fix-stage instruction; it warrants a ticket
  because it produces wrong answers today. Note the aggregate case is worse than the
  arithmetic one: the rounded value is promoted back to an exact bigint on the way out, so
  it *looks* exact. The NOTE comment stays as the in-code signpost.
- `backlog/debt-sqllogic-bigint-assertions-lossy` — the harness weakness the implementer
  flagged is real and broader than this ticket. `test/logic.spec.ts` `normalizeBigInts`
  converts an actual bigint through `Number()`, and the JSON-parsed expected side rounds
  identically, so **any** `.sqllogic` expectation above 2^53 currently cannot fail. The
  `cast(… as text)` convention this ticket's tests follow is a working sidestep, not a
  fix; the fix needs a big-integer-preserving reader on the expected side.
- `backlog/bug-integer-column-rejects-large-real` — pre-existing, found while reviewing:
  `insert into t(v integer) values (1e20)` errors `Type mismatch`, while the identical
  value as `'100000000000000000000'` or as a digit literal is accepted. `INTEGER_TYPE.parse`'s
  *number* arm never got the bigint treatment its string arm now has, and
  `INTEGER_TYPE.validate` then rejects the unsafe number it passes through.

### Tripwires (conditional — deliberately not ticketed)

None new. The pre-existing `NOTE:` at `NUMERIC_TYPE.physicalType` (labelled `REAL` though
the value space includes `bigint`) is the one that governs this area, and this change makes
bigint-holding NUMERIC values reachable from one more direction (text input) without
altering the condition it describes — a storage path switching on `physicalType` — so it
needed no update.

### Explicitly checked, nothing found

- **Source hygiene** — both changed arms are 5-8 lines inside existing functions; no
  function grew past a screen, no new file, no duplication between the two arms worth
  extracting (they differ in prefix leniency, which is the whole point).
- **Error handling / type safety** — no `any`, no swallowed exception; the `throw` paths
  are unchanged and still funnel through `emitCast`'s `castFallback`. `yarn lint`
  (eslint + `tsc -p tsconfig.test.json --noEmit`) exit 0.
- **Resource cleanup / performance** — no allocation, iteration, or lifecycle change; one
  regex exec replaces one `parseInt` on a path that already ran per-cast.
- **Other docs** — `docs/architecture.md` ("Design Differences from SQLite"),
  `docs/usage.md` ("Working with Large Integers"), and `docs/types.md`'s "Type Coercion in
  Comparisons" section were each read against the new behavior. All remain accurate;
  none claimed anything about text conversion precision that the fix invalidates.

## Verification

- `yarn workspace @quereus/quereus run build` — clean.
- `node test-runner.mjs` (packages/quereus) — 8065 passing, 13 pending, 0 failing.
- `yarn test` from repo root (all workspaces) — green, `Done in 3m 24s`.
- `yarn workspace @quereus/quereus run lint` — exit 0, no output.
- `git diff --stat` for the review pass: 3 files, +40/-4 (`builtin-types.ts`,
  `03.6-type-system.sqllogic`, `docs/types.md`).
- Behavior spot-checks run against the built engine directly (not only through the
  sqllogic harness), specifically to sidestep the bigint-comparison weakness noted above.

Not run: `yarn test:store` (LevelDB-backed logic tests). The change is confined to
in-memory JS value parsing (`parse()` on `LogicalType`), not storage encoding. Unchanged
from the implement stage's assessment; noted rather than claimed.
