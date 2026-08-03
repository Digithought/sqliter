description: Looking up a row in an in-memory table by a decimal-number column crashed with an internal JavaScript error whenever the value being searched for was a whole number too large to hold exactly as a decimal. Fixed.
files:
  - packages/quereus/src/types/builtin-types.ts       # REAL_TYPE.compare (~line 110) — fixed
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # new regression block at end of file
difficulty: easy
repro: verified
---

## Fix

`REAL_TYPE.compare` in `packages/quereus/src/types/builtin-types.ts` asserted both
operands were `number` and called `isNaN()` on them, which throws when the
argument is a `BigInt`. A `REAL` column compared against an integer literal past
2^53 (kept as `BigInt` internally to avoid precision loss) hit this on every
in-memory index/primary-key lookup.

Changed `REAL_TYPE.compare` to match the pattern already used by
`NUMERIC_TYPE.compare` a few lines down: guard the NaN check with
`typeof a === 'number' && isNaN(a)`, then delegate ordering to the existing
`compareNumericValues(a as number | bigint, b as number | bigint)` helper, which
compares via JS relational operators (`<`/`>`) — those compare `number` and
`bigint` by exact mathematical value without any precision-losing coercion.

```ts
compare: (a, b) => {
	const nullCmp = compareNulls(a, b);
	if (nullCmp !== undefined) return nullCmp;

	const aIsNaN = typeof a === 'number' && isNaN(a);
	const bIsNaN = typeof b === 'number' && isNaN(b);
	if (aIsNaN) return bIsNaN ? 0 : -1;
	if (bIsNaN) return 1;

	return compareNumericValues(a as number | bigint, b as number | bigint);
},
```

Checked all other builtin logical types' `compare` functions in the same file —
`REAL` was the only one with the unguarded `as number` + `isNaN()` pattern.
`NUMERIC` already had the fix; `INTEGER`, `TEXT`, `BLOB`, `BOOLEAN`, `NULL`
don't call `isNaN` at all.

Per the ticket's note, checked whether the persistent (`quereus-store`) backend
shares the bug: it doesn't call a logical type's `compare` for key ordering at
all (it encodes keys to bytes), so it was never exposed to this. Ran the new
regression test under `--store` mode to confirm — passes.

## Regression coverage

Added a block to `packages/quereus/test/logic/03.6-type-system.sqllogic`
covering the ticket's repro cases: secondary-index `=`, secondary-index `>`,
secondary-index `IN` (both the case where the bigint doesn't match any stored
row and the case where it does, at the exact boundary value), and the same `=`
and `IN` shapes against a `REAL PRIMARY KEY` table with no secondary index.
Runs under both the default (memory) and `--store` (LevelDB) backends via the
existing `.sqllogic` harness — no test-file split needed since it's a plain
data-file addition, not a `.spec.ts` change.

## Verification

- `yarn build` — clean.
- `yarn test` — 8536 passing, 13 pending (unchanged from baseline), 0 failing.
- `yarn workspace @quereus/quereus run lint` — clean.
- `node test-runner.mjs --grep "type-system" --verbose` — new REAL/bigint
  blocks all show `Results match!`.
- `node test-runner.mjs --store --grep "type-system"` — passes against the
  LevelDB-backed store module too.

## Review findings

(none yet — first pass)
