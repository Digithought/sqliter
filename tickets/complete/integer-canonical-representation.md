---
description: Whole numbers used to arrive in the engine in either of two JavaScript forms depending on how they got there; now every integer value has exactly one form, converted at the points where values enter, with the rule documented and property-tested.
files:
  - packages/quereus/src/util/numeric-canonical.ts     # NEW — canonicalizeInteger / canonicalizeSqlValue / isCanonicalNumeric, R1/R2 doc comment
  - packages/quereus/src/types/builtin-types.ts        # INTEGER_TYPE.parse, NUMERIC_TYPE.parse
  - packages/quereus/src/types/temporal-types.ts       # TIMESTAMP_TYPE.parse — added in review
  - packages/quereus/src/runtime/emit/binary.ts        # mixedBigIntArithmetic — success-path narrowing, both arms
  - packages/quereus/src/runtime/emit/unary.ts         # '-' and '~' arms; bitwiseNot helper added in review
  - packages/quereus/src/func/builtins/aggregate.ts    # addWithPromotion narrows its bigint arm
  - packages/quereus/src/func/builtins/scalar.ts       # random() — R1 violation fixed in review
  - packages/quereus/src/core/statement.ts             # constructor / bind / bindAll canonicalize into boundArgs
  - packages/quereus/src/util/key-tuple-codec.ts       # NOTE rewritten in review — R1 alone is not the load-bearing premise
  - docs/types.md                                      # § Physical representation; INTEGER/NUMERIC/TIMESTAMP + param-binding bullets
  - docs/sql-select.md                                 # bitwise operator list corrected in review
  - packages/quereus/test/numeric-canonical.spec.ts    # NEW — unit tables + engine round-trips (runs against BOTH backends)
  - packages/quereus/test/property.spec.ts             # NEW fast-check property "Canonical Numeric Representation (R1)"
  - packages/quereus/test/logic/03-expressions.sqllogic # `~` value cases past 2^31 and at the safe-integer boundary
  - packages/quereus/test/parameter-types.spec.ts      # one expectation updated to the new bind contract (100n → 100)
prereq:
---

# One JavaScript form per integer value

The rule now lives in `docs/types.md` § "Physical representation":

- **R1** — a `SqlValue` is a JS `bigint` only when its magnitude exceeds the
  safe-integer range (|v| > 2^53 − 1); every integer value inside that range is a JS
  `number`. R1 constrains which values may be `bigint`, **not** which `number`s may be
  whole — `1e20` as a `number` is legal, and `-0` stays `-0`.
- **R2** — per-declared-type value spaces (table in the doc). Probe values handed to
  comparators are exempt.

Canonicalization happens where values are *born*: literals (lexer, already canonical),
type conversion (`INTEGER_TYPE.parse`, `NUMERIC_TYPE.parse`, `TIMESTAMP_TYPE.parse`),
parameter bind (all three `boundArgs` write sites), and the bigint arms of
arithmetic/aggregation. Virtual-table `query()` rows and UDF return values are held to R1
by contract, not by per-row coercion — enforcement is `implement/representation-strict-checker`.

Two intentional API-surface changes, both `typeof`-only: a safe-range bigint parameter
(`stmt.bind(1, 5n)`) round-trips as the `number` `5`, and a bigint arithmetic or `sum()`
result landing back inside the safe range is a `number`.

`INTEGER_TYPE.parse`'s number arm now widens a finite whole value past the boundary to an
exact bigint, which fixed and subsumed `backlog/bug-integer-column-rejects-large-real`
(file deleted by the implement stage; its repro is now a spec test, and
`cast(1e20 as integer)` returns the exact integer).

## Review findings

Reviewed the implement diff (`aa6449af`) before reading the handoff. Validation:
`yarn build` ✓, `yarn lint` ✓ (eslint + tsc over test files, all packages), `packages/quereus`
`yarn test` **9066 passing / 0 failing**, all other workspace tests passing, and
`numeric-canonical.spec.ts` under `QUEREUS_TEST_STORE=true` **22 passing** (LevelDB backend
parity, including the new cases). No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

### Major — regression introduced by this ticket (fixed in this pass)

- **Narrowing broke bitwise NOT.** `runtime/emit/unary.ts` implemented `~` on a `number`
  operand with JS's `~`, which coerces through ToInt32. That was already wrong above 2^31
  (`~3000000000` returned 1294967295 instead of -3000000001), but the ticket's arithmetic
  narrowing routed values onto that arm that previously arrived as bigints and took the
  exact path: `select ~(9007199254740993 - 3)` returned **-9007199254740991 before the
  change and 1 after** — a value regression, not the `typeof`-only change the handoff
  claimed. Verified by running both forms. Fixed at the root rather than at the
  interaction: a `bitwiseNot` helper computes `-x - 1` in the exact domain and
  canonicalizes, shared by the numeric-fast and generic arms, so every magnitude is
  correct regardless of which form the operand arrives in. Value cases (past 2^31, both
  sides of the safe-integer boundary, generic TEXT path) added to
  `test/logic/03-expressions.sqllogic`; representation cases added to
  `numeric-canonical.spec.ts`. The pre-existing NaN divergence between the two arms carries
  an accepted-tradeoff `NOTE:` at the site and was left alone.

### Minor — fixed in this pass

- **`random()` violated R1 on every call.** `func/builtins/scalar.ts` drew a safe integer
  and wrapped it in `BigInt()`, minting an in-range bigint — exactly the class this ticket
  set out to close. The handoff's builtin audit missed it. Now returns the `number`
  directly; `typeof(random())` is unchanged (`'integer'`). Regression test asserts canonical
  form over repeated draws.
- **`TIMESTAMP_TYPE.parse` was the third integer-domain conversion and was skipped.**
  TIMESTAMP is `physicalType: INTEGER` with value space `number | bigint`, but the ticket
  only canonicalized INTEGER and NUMERIC, and the R2 table in `docs/types.md` omitted
  TIMESTAMP entirely (lumping it with the string temporals). Both arms now canonicalize on
  INTEGER's rule, the R2 table has a TIMESTAMP row, the "where canonicalization happens"
  bullet names all three parses, and a unit table covers it.
- **`key-tuple-codec.ts`'s new NOTE rested on a false premise.** It claimed R1 gives "one
  integer value has exactly one JS form engine-wide", which R1 explicitly does not: `1e20`
  (number) and `100000000000000000000n` are both canonical spellings of one value. The
  original comment's real argument — a table's PK storage type is stable per row — had been
  replaced rather than joined. Rewritten to state both premises and to say which one is
  load-bearing outside the safe range. This is also where the "two legal spellings past
  2^53" tripwire is parked.
- **`docs/sql-select.md` listed bitwise operators that do not exist.** `&`, `|`, `<<`, `>>`
  are documented as supported; all four fail at the parser (`emitBinaryOp` still has a
  `// TODO: emitBitwise`). Verified by running them. The list now documents `~`'s actual
  arbitrary-precision semantics and says the other four are not implemented.
- Cross-ticket bookkeeping: `backlog/bug-text-coercion-in-arithmetic-and-aggregates`
  referenced this ticket by its old `implement/` path and described it as unlanded — updated
  to name the shipped rule its arm A now builds on. `implement/representation-strict-checker`
  gained two corrections it would otherwise have gotten wrong: TIMESTAMP is not a
  physically-TEXT temporal, and `random()` was one of the "builtin returns the wrong form"
  violations it predicts (already fixed, so expect others of that shape).

### Major — filed, not fixed here

- **`tickets/fix/sum-drops-values-when-mixing-huge-integers-and-decimals`** —
  `addWithPromotion` promotes both sides to bigint whenever either side is one, and
  `BigInt(0.5)` throws; the SUM step catches that and returns the accumulator unchanged, so
  the value is **silently discarded**. Verified: `sum` over `{0.5, 9007199254740993}`
  returns `0.5` in one fold order and `9007199254740993` in the other. The handoff flagged
  the throw honestly but understated it as a throw — it is a silent order-dependent wrong
  answer, and `algebra.merge` takes the same path uncaught for maintained views. Pre-existing
  and not widened by this ticket, but it sits in the function this ticket edited and the
  engine already has the correct rule for the same operand pair in `mixedBigIntArithmetic`,
  so the ticket is framed as "make sum's promotion follow the arithmetic rule", not as a
  point patch.

### Checked and clean

- **Every bigint-minting site in `packages/quereus/src`** (`BigInt(` and
  `typeof === 'bigint'` sweeps): lexer boundary, `key-serializer` (already unifies `5`,
  `5.0` and `5n`, so widening cannot skew index/PK keys), `prepareJsonValue`,
  `jsonStringify`, `abs` (magnitude-preserving), `generate_series` (iterates via `Number()`),
  `hrtime`/`filter-info`/`index-info` (not `SqlValue`s). `util/affinity.ts` mints
  non-canonical bigints but is dead code carrying its own explanatory `NOTE:` — left alone.
- **`mixedBigIntArithmetic`** — narrowing is on success paths only; the catch arms still
  return null / fall through to float, and `canonicalizeInteger` cannot throw. The mixed
  arm's float path yields `number`s, which R1 permits at any magnitude.
- **`addWithPromotion`'s number-overflow arm** — the handoff's claim that it needs no
  narrowing is sound: two safe integers whose float sum leaves the range have an exact sum
  outside it.
- **`Statement` bind seams** — all three write sites canonicalize; `bindAll`'s object arm
  keeps its validate-then-assign atomicity; type inference runs on raw values but maps a
  safe-range bigint and its number form to the same physical type, so no drift.
- **NUMERIC's deliberately un-widened number arm** — `insert into <numeric pk> values (1e20)`
  then `(100000000000000000000)` raises a UNIQUE violation rather than creating two rows,
  because `key-serializer` unifies the two spellings. Verified. Consistent with the plan's
  stated decision; the residual "same value, two returned spellings" is parked as the
  key-tuple-codec tripwire above.
- **Accepted-tradeoff `NOTE:`s** on `compareSqlValuesFast` (`util/comparison.ts`) and the
  `numeric-fast`/`compare-fast` branches (`runtime/emit/binary.ts`) — revisit conditions
  have not tripped; left in place, as the ticket intended.

### Known gaps carried forward (unchanged, and accurate as stated)

- Vtab `query()` rows and UDF return values are still uncoerced — contract only, enforced by
  `implement/representation-strict-checker`.
- No end-to-end materialized-view retraction test asserts the stored partial's
  representation; coverage is via the shared `addWithPromotion` SUM-step test only.
- The promote-then-retract SUM test depends on PK scan order for promotion to occur
  mid-fold. Deterministic on both backends; any-order folds still agree on value and form.
