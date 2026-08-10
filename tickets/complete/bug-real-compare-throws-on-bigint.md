description: Looking up a row in an in-memory table by a decimal-number column crashed with an internal JavaScript error whenever the value being searched for was a whole number too large to hold exactly as a decimal. Fixed.
files:
  - packages/quereus/src/types/builtin-types.ts       # shared compareNumericWithNaN helper; REAL + NUMERIC both use it
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # regression block at end of file
  - docs/types.md                                     # REAL / NUMERIC comparison entries
difficulty: easy
repro: verified
---

## Fix

`REAL_TYPE.compare` asserted both operands were `number` and called `isNaN()` on
them, which throws when the argument is a `BigInt`. A `REAL` column compared
against an integer literal past 2^53 (kept as `BigInt` internally to avoid
precision loss) hit this on every in-memory index/primary-key lookup.

REAL and NUMERIC now share one comparator, `compareNumericWithNaN`
(`packages/quereus/src/types/builtin-types.ts`): NULL preamble, then a
`typeof`-guarded NaN check (NaN sorts smallest, NaN = NaN), then
`compareNumericValues`, which orders via JS relational operators — those compare
`number` and `bigint` by exact mathematical value with no precision-losing
coercion.

REAL's value space is number-only per its `validate`; the bigint tolerance is
there because the shared index/PK comparators pass through raw storage-class
values.

The persistent (`quereus-store`) backend never had the bug — it encodes keys to
bytes and does not call a logical type's `compare` for key ordering.

## Regression coverage

`packages/quereus/test/logic/03.6-type-system.sqllogic`, run under both memory
and `--store` backends: secondary-index `=`, `>`, `<` (both directions across
the 2^53 boundary, so a `Number()`-rounded implementation would return the wrong
row set rather than merely throwing), negative bigint bound, `IN` mixing a
bigint with a plain number (matching and non-matching), NULL in an indexed REAL
column, and the same shapes against a `REAL PRIMARY KEY` table with no secondary
index.

## Verification

- `yarn build` — clean.
- `yarn test` — 8536 passing in `@quereus/quereus`, 0 failing across all
  workspaces (unchanged from baseline).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `node test-runner.mjs --grep "type-system"` and the same with `--store` — pass.

## Review findings

**Checked:** the implement diff read cold before its handoff summary; every
`compare` in `types/builtin-types.ts`; a sweep for other `isNaN` / `as number`
uses across `src/types/` and `src/util/comparison.ts`; the NaN and NULL orderings
against the `LogicalType.compare` / `groupKey` contracts in
`types/logical-type.ts`; test coverage strength; `docs/types.md`.

**Found and fixed in this pass (minor):**

- *DRY / stale comment.* Post-fix, `REAL_TYPE.compare` and `NUMERIC_TYPE.compare`
  were byte-identical, and NUMERIC still carried a comment claiming it "can't
  delegate to REAL_TYPE.compare: isNaN() throws on a bigint" — false as of the
  fix. Extracted `compareNumericWithNaN` and pointed both types at it; the
  bigint rationale now lives in one place.
- *Weak assertions.* Every new bigint test asserted an **empty** result except
  one, so a comparator that returned the wrong order (rather than throwing)
  would still have passed. Added `<` cases on both sides of the 2^53 boundary
  that return rows — these fail if the bigint is coerced through `Number()` —
  plus a negative-bigint bound and a NULL-in-indexed-column ordering case.
  (The NULL case needs an explicit `null` in the DDL: Quereus defaults columns
  to NOT NULL.)
- *Stale docs.* `docs/types.md` said NUMERIC keeps its own comparator "rather
  than delegating to REAL's, whose `isNaN` throws on a bigint", and the set-op
  type-merging rationale (~line 637) described the throw as current behavior.
  Both corrected; the REAL entry now states the bigint tolerance and why it
  exists.

**Found, not fixed:** none — no major finding, so no new ticket was filed.

**Tripwires:** none new. The pre-existing `NUMERIC_TYPE.physicalType = REAL`
mislabel NOTE at `types/builtin-types.ts` is untouched and still accurate.

**Adjacent-but-out-of-scope, deliberately left alone:** `compareNumericValues`
(builtin-types) and `compareNumbers` (`util/comparison.ts`) are the same two-line
body in two files. Both are module-private with different NaN contracts
documented at each site; unifying them would export a helper across a module
boundary for no behavioral gain. Not worth a ticket.

**Pre-existing failures:** none surfaced.
