description: Converting a text value that holds a very large whole number into a number used to silently change the number — the last digits got rounded away — even though the same number written directly in a query kept every digit. That is now fixed.
prereq:
files:
  - packages/quereus/src/types/builtin-types.ts   # INTEGER_TYPE.parse, NUMERIC_TYPE.parse — the two sites changed
  - packages/quereus/src/parser/lexer.ts          # number() — the sibling safe-integer→BigInt rule (unchanged, referenced in comments)
  - packages/quereus/src/util/coercion.ts         # coerceToNumberForArithmetic — NOTE: comment added, logic unchanged (out-of-scope tripwire)
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # regression block appended after `numeric_big`
difficulty: easy
---

## Summary

`INTEGER_TYPE.parse` and `NUMERIC_TYPE.parse` (both in
`packages/quereus/src/types/builtin-types.ts`) converted a string past
`Number.MAX_SAFE_INTEGER` through `parseInt`/inline `Number()`, which returns
a JS `number` and silently rounds once the value exceeds 2^53. Both types
already accepted `bigint` in their value space — the only bug was that the
string arm never produced one. This single bug surfaced as three symptoms,
all fixed by the same change:

- `cast('9007199254740993' as integer/numeric)` returned the rounded `number`
  instead of the exact `bigint`.
- `9007199254740993 = '9007199254740993'` returned `false`, because the
  planner CASTs the text operand to match the numeric side at plan time
  (`planner/building/coercion.ts`), hitting the same bug.
- Inserting `'9007199254740993'` into a `numeric` column stored the rounded
  value (write-time coercion to the column's declared type).

## Fix

Mirrors the rule the lexer already uses for INTEGER literals
(`parser/lexer.ts`, `number()`, ~line 716): parse, test
`Number.isSafeInteger`, and on overflow rebuild the value from the *original
digit string* with `BigInt(...)` — recovering it from the already-rounded
`number` would just reproduce the bug.

**`INTEGER_TYPE.parse`** (string arm): `parseInt`'s prefix leniency
(`'12abc'` → `12`, `'3.14'` → `3`, `'9e18'` → `9`) is relied on elsewhere
(existing `cast_order` test), and `BigInt()` throws on a non-integer string,
so the fix takes the leading integer run explicitly via
`/^[+-]?\d+/.exec(trimmed)` before deciding `number` vs `BigInt`. `BigInt('+5')`
also throws (unlike `Number('+5')`), so a leading `+` is stripped before the
`BigInt()` call.

**`NUMERIC_TYPE.parse`** (all-digit branch): the existing `/^-?\d+$/` guard
already guarantees `BigInt(trimmed)` succeeds, so it's a straight
`Number.isSafeInteger` check inline.

**Deliberately no 64-bit clamp.** Quereus literals are already
arbitrary-precision (`select 99999999999999999999999999` returns an exact
bigint today) — clamping the text path to SQLite's `INT64_MAX`
(`9223372036854775807`) would make the two paths disagree in the *other*
direction. `cast('99999999999999999999999999' as integer)` returns the exact
value, not a clamp, and that's intentional divergence from SQLite documented
inline.

Diff is exactly the two `parse` string arms — nothing else in `src/` changed.

## Test coverage added

`packages/quereus/test/logic/03.6-type-system.sqllogic`, new block appended
after the existing `numeric_big` section, covering:

- `cast('9007199254740993' as integer/numeric)`, `cast('-9007199254740993' as integer)`,
  `cast('9223372036854775807' as integer)`, `cast('99999999999999999999999999' as integer)`,
  `cast('9007199254740993abc' as integer)` — all exact bigints.
- `cast('9007199254740993.0' as numeric)` — fractional form is not all-digit,
  stays REAL, still rounds (matches SQLite, unaffected by the fix — pinned so
  a future "fix everything" pass doesn't accidentally change this).
- `cast('9e18' as integer)` — prefix semantics preserved.
- Unaffected-behavior pins: `'12abc'` → `12`, `'3.14'` → `3.14`,
  `'  42  '` → `42`, `'abc'` → `0` (via `castFallback`), `''` → `null`.
- `9007199254740993 = '9007199254740993'` → `true`,
  `9007199254740993 = '9007199254740992'` → `false` — the cross-category
  comparison symptom.
- Insert path: `insert into (v numeric) values ('9007199254740993')` reads
  back exact.

**Important test-harness detail, worth a second look in review:** the sqllogic
runner (`test/logic.spec.ts`, `normalizeBigInts`) converts an actual `bigint`
result through `Number()` before comparing to the JSON-parsed expected value.
That means a raw numeric assertion like `→ [{"v":9007199254740993}]` would
have **passed even with the bug still present** — both the correct bigint and
the wrong rounded number collapse to the same double on the way through
`Number()`. Every bigint-producing assertion in the new block routes through
`cast(v as text)` instead (matching the pre-existing `numeric_big` block's
convention) specifically to avoid this false-negative. The two `number`-typed
assertions (`9e18`, the fractional-form REAL) are compared directly since
that failure mode doesn't apply to them.

## Verification performed

- `yarn workspace @quereus/quereus run build` — clean.
- `node test-runner.mjs --grep "03.6-type-system"` — 1 passing (file-level test).
- Full `node test-runner.mjs` (packages/quereus only) — 8065 passing, 13 pending, 0 failing.
- Full `yarn test` from repo root (every workspace) — all green (quereus 8065,
  quereus-store/isolation/sync/sync-client/sync-coordinator/plugin-loader/
  quoomb-cli/quoomb-web/quereus-vscode suites all passing, shared-ui has no
  test files by design).
- `yarn lint` from repo root — every package's `lint` script ran (16×
  "No lint configured" no-ops plus quereus's real `eslint` + `tsc -p
  tsconfig.test.json --noEmit`); quereus's lint re-run standalone,
  exit 0, no output.
- `git diff --stat` inspected directly to confirm scope: 2 files, +88/-6,
  matches the description above.

Not re-run: `yarn test:store` (LevelDB-backed logic tests) — the ticket's
change is confined to in-memory JS value parsing (`parse()` on `LogicalType`),
not storage encoding, so there's no reason to expect the store backend to
behave differently, but this wasn't independently confirmed this pass.

## What to check in review

- Confirm the `INTEGER_TYPE.parse` prefix-regex change
  (`/^[+-]?\d+/.exec(trimmed)`) doesn't change behavior for any string that
  used to reach `parseInt`'s NaN branch — the `!m` throw is intended to be
  exactly equivalent to the old `isNaN(parsed)` throw (a string with no
  leading integer run is exactly the one `parseInt` returned `NaN` for), but
  worth a second pair of eyes given it's a regex rewrite of built-in parsing
  behavior used on every INTEGER cast in the system.
- `docs/types.md` already states the NUMERIC value space includes `bigint`
  past 2^53 (lines ~140-147) — checked this pass, and it doesn't make any
  incorrect claim about *string* conversion specifically, so it was left
  unchanged per the ticket's "don't add a new doc" instruction. Worth
  confirming that read is right rather than a doc gap.

## Out of scope (documented, not chased)

`select '9007199254740993' + 0` still rounds — a different path (SQL
arithmetic affinity, `packages/quereus/src/util/coercion.ts`
`coerceToNumberForArithmetic`, whose signature returns `number`, feeding
`mixedBigIntArithmetic` in `runtime/emit/binary.ts`). Fixing it means
widening that function's return type — separate ticket-worth of blast
radius. Per the fix-stage ticket's instruction, a `NOTE:` comment was added
at `coerceToNumberForArithmetic` pointing at this asymmetry (landed this
pass, `packages/quereus/src/util/coercion.ts`). `min('5','10')`-style
aggregate coercion is already tracked separately as backlog
`bug-text-minmax-numeric-coercion` — out of scope here.

## TODO

- Adversarial review pass per stage rules (minor → fix inline; major → new
  ticket; speculative → tripwire comment, not a ticket).
- Promote to `tickets/complete/` with a `## Review findings` section.
