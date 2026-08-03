---
description: Two query optimisations that look rows up through an index currently give up whenever the two columns being matched are declared with different number types — whole numbers on one side, decimals on the other. They can safely handle that case, so let them.
prereq: bug-real-compare-throws-on-bigint
files:
  - packages/quereus/src/types/builtin-types.ts                      # new sharesSeekKeySpace predicate, beside isNumericOrUnknownType (~line 351)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts   # resolveSeekColumns (~line 200) — gate site 1, plus the header docstring
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts     # resolvePairs (~line 131) — gate site 2, the literal twin
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # literal-IN arm (~line 558) — NOTE only, no behaviour change
  - packages/quereus/src/util/key-serializer.ts                      # canonicalNumeric — the probe-side key canonicalization the seek must agree with
  - packages/quereus-store/src/common/encoding.ts                    # encodeNumeric — the store-side key encoding
  - packages/quereus/test/optimizer/key-set-seek.spec.ts             # existing decline test at ~line 182, to be inverted
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts        # existing decline test at ~line 197, to be inverted
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic      # row-level cases (runs under memory and yarn test:store)
  - packages/quereus-store/test/key-set-seek-store.spec.ts
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts
difficulty: medium
---

## Background

Two optimizer rules turn a join into an index lookup on the inner table:

- `ruleKeySetSeek` — rewrites a hash **semi** join (`where col in (select …)`) into a
  `KeySetSemiJoinNode` that materializes the key set once and hands it to the target's
  storage module as a multi-key index seek.
- `ruleIndexNestedLoop` — rewrites a join into a per-outer-row index seek on the inner.

Both are safe against *over*-fetching: a check above the seek re-verifies every row, so
extra rows are trimmed. Both are fatally exposed to *under*-fetching: a row the seek never
returns cannot be recovered. Every gate in either rule exists to make an under-fetch
impossible.

One of those gates is a flat refusal of any pair whose two columns declare different
logical types:

```ts
	if (targetType.logicalType.name !== keyType.logicalType.name) {
		log('decline: logical types differ (%s vs %s)', …);
		return null;
	}
```

Both rules carry a byte-identical copy (`index-nested-loop.ts` even says "same two gates
as rule-key-set-seek's `resolveSeekColumns`"). So `a.i in (select b.r from b)` —
`INTEGER` against `REAL` — falls back to the slower plan even though the comparison
`a.i = b.r` matches `1` against `1.0` perfectly well.

## What the investigation found

The gate is stricter than it needs to be for numbers. Across every layer, a numeric key's
identity is decided by its **value**, not by which of JavaScript's two numeric
representations happens to hold it:

1. **The membership check** (`buildJoinKeyExtractor` → `serializeRowKey` → `canonicalNumeric`
   in `util/key-serializer.ts`) puts `number`, `bigint` and `boolean` under one `n:` tag,
   and routes integer-valued numbers through `BigInt(n)`. `5`, `5.0` and `5n` all serialize
   to `n:5`. The check that decides which rows are emitted *already* treats the cross-type
   pair as matching — the gate is the only thing keeping the faster plan away.

2. **The in-memory backend** orders its index and primary-key BTrees with
   `createTypedComparator(column.logicalType, …)` (`util/comparison.ts`). `INTEGER_TYPE.compare`
   and `NUMERIC_TYPE.compare` both delegate to `compareNumericValues`, which handles a mixed
   `number`/`bigint` pair by true magnitude. `REAL_TYPE.compare` does **not** — it throws
   outright on a `bigint` operand. That is this ticket's `prereq`,
   `bug-real-compare-throws-on-bigint`; it is a live crash today, independent of these rules.
   With it fixed, all three order identically to `canonicalNumeric`.

3. **The persistent store backend** never consults a logical type's `compare` for key order —
   it encodes keys to bytes. `encodeNumeric` (`quereus-store/src/common/encoding.ts`) uses a
   single numeric tag for both representations, deliberately, so integers and reals interleave
   by magnitude. Calling `encodeValue` directly confirms it: `5n` / `5.0` → identical bytes;
   `0n` / `-0` → identical; `1n` / `true` → identical; `9007199254740992n` /
   `9007199254740992` → identical; `9007199254740993n` / `9007199254740992` → **different**,
   which is exactly right.

4. **The isolation overlay's residual matcher** (`quereus-isolation`'s
   `buildConstraintMatcher`) re-checks rows with `compareSqlValuesFast`, which is
   storage-class based and unifies the two representations too — so it will not drop a row
   the byte window returned and the membership check would have kept.

Conclusion: for the three builtin numeric types the seek key space *is* one key space. No
conversion of the key value is needed, and the gate can admit the pair as-is.

## Design decision: do NOT coerce the key value

The originating plan ticket guessed the answer would be "apply the same conversion the
engine uses when it writes a value into that column". **That is the wrong answer and must
not be implemented.** `INTEGER_TYPE.parse(1.5)` truncates to `1`. Coercing seek keys that
way would mint a key for a value the comparison does not consider equal:

- In the semi-join path it would be a silent over-fetch — harmless but pointless work.
- In the plan-time literal path (`where i in (1.5)` on an `INTEGER` column) there is **no**
  residual filter left above the seek, because the `IN` is reported to the planner as fully
  handled. Truncation there would return the `i = 1` row for a query that must return
  nothing. Coercion would introduce a correctness bug where none exists.

Leaving the raw value alone is both simpler and exact. The shared rule the originating
ticket asked for is therefore not a coercion at all — it is a **compatibility predicate**:
"do these two declared types share one seek key space?"

## The change

### A shared predicate

Add to `packages/quereus/src/types/builtin-types.ts`, immediately after
`isNumericOrUnknownType` (same file, same idiom — a plan-time type-set gate tested by
identity against the registry singletons):

```ts
/**
 * True when two declared logical types share ONE seek key space: any two values
 * of those types that `=` calls equal produce the same index key under every
 * backend, so an index seek keyed by a value of one type may be issued against a
 * column declared the other without missing a row.
 *
 * … (rationale: canonicalNumeric on the probe side, compareNumericValues in the
 * memory BTree comparators, encodeNumeric's single numeric tag in the store) …
 *
 * Identity against the three registry singletons, NOT `type.isNumeric`: a
 * plugin-registered numeric type supplies its own `compare`, which is what a
 * memory BTree over such a column is ordered by, while the probe side keys by
 * storage class. The two need not agree, and a seek has no residual able to
 * repair an under-fetch, so plugin types stay out.
 *
 * This answers only the CROSS-type question. Whether byte equality equals value
 * equality WITHIN one type is a separate question, answered by
 * `hasSemanticOrdering` — callers must keep applying both.
 */
export function sharesSeekKeySpace(a: LogicalType, b: LogicalType): boolean
```

Whitelist: `INTEGER_TYPE`, `REAL_TYPE`, `NUMERIC_TYPE`. Identical types return true
regardless (preserving today's behaviour for every other type). Match the parameter type
convention already used in that file (`isNumericOrUnknownType` takes `DeepReadonly<LogicalType>`).

### Both gate sites

Replace the `logicalType.name !==` comparison with `!sharesSeekKeySpace(...)` in:

- `rule-key-set-seek.ts` → `resolveSeekColumns`
- `index-nested-loop.ts` → `resolvePairs` (per equi-pair; one non-conforming pair declines
  the whole candidate, as today)

Leave the `hasSemanticOrdering` check that follows each one exactly where it is and exactly
as it is — the two gates answer different questions. Update the decline log message so it
names the new rule rather than "logical types differ".

Update the header docstring bullet in `rule-key-set-seek.ts` (currently
"target/key logical types that differ (a cross-type seek key can miss rows `=` considers
equal — backlog/feat-key-set-seek-cross-type-keys)") and the equivalent prose in
`index-nested-loop.ts`; drop the now-stale backlog cross-reference.

### The plan-time literal path — comment only, no behaviour change

`rule-select-access-path.ts`'s literal-`IN` arm types its seek literals from the target
column (`literalFromValue(scope, v, colType)`) while keeping each literal's own value. That
is sound for the same reason, and it is already correct today: `where i in (1.0, 2.0)`
against an `INTEGER` column was run and returns both rows. Add a `NOTE:` at that site
recording the invariant and pointing at `sharesSeekKeySpace`, so a future author does not
"fix" it by adding a conversion. **Do not add a gate here** — see the truncation argument
above.

## Explicitly out of scope

- **Text against numbers.** It cannot reach either gate: `insertCrossTypeCoercion` wraps the
  textual operand in a `CastNode`, and both the equi-pair extractor and the constraint
  extractor refuse a converting cast. Already settled by the completed
  `bug-numeric-text-coercion-skips-in-and-case`.
- **Temporal types against text** (`d = '2024-01-01T00:00:00Z'` on a `DATE` column). A real
  and separate concern, already filed as `backlog/bug-datetime-literal-with-timezone-never-matches`.
  Do not widen into it.
- **Blob against numeric, and any other pairing.** These fall outside the whitelist and
  keep declining, which is what we want: their storage classes differ, so nothing matches
  anyway and the slower plan returns the same (empty) answer.

## Edge cases & interactions

Each of these should exist as a test, not just as a considered thought.

- **Both directions.** `INTEGER` target with `REAL` keys, and `REAL` target with `INTEGER`
  keys. The second is the one the `prereq` unblocks.
- **`NUMERIC` on either side.** Reachable from ordinary SQL: set-operation column-type
  merging turns `select 1 union all select 2.5` into `NUMERIC`, so
  `where i in (select … union all select …)` produces a `NUMERIC` key column against an
  `INTEGER` target.
- **Past 2^53.** A `bigint` key against a `REAL` target must match a stored value of equal
  magnitude and, critically, must **not** match a near neighbour: seeking `9007199254740993`
  must not return a row storing `9007199254740992.0`. Assert both halves.
- **Non-integral key against a whole-number target.** `where i in (select 1.5 …)` on an
  `INTEGER` column: the seek must return no row, and the membership check must agree. Also
  assert the plan-time literal twin, `where i in (1.5)` → no rows. This is the case a
  coercion-based implementation would get wrong.
- **Signed zero.** A `-0.0` key against a stored `0`: the membership check keys both to
  `n:0` and the store encodes both identically, so the row must be returned.
- **NaN as a key.** `canonicalNumeric` gives `"NaN"`, so the membership check matches only a
  stored NaN — but the in-memory comparator sorts NaN first while the store encodes it above
  every finite double, and `compareNumbers` treats NaN as equal to everything. Determine
  whether a NaN seek key can *under*-fetch on either backend. If it can, skip NaN keys at
  runtime the way NULL keys already are (`extractKey` returns null and the key is dropped);
  if it cannot, record why in a `NOTE:` at the decision site. Do not leave this unexamined.
- **NULL keys** are unchanged — still dropped before the seek.
- **Boolean-typed columns.** Check whether a distinct `BOOLEAN` builtin logical type exists.
  Only add it to the whitelist if it does *and* its `compare` is consistent with
  `compareNumericValues`; `canonicalNumeric` and `encodeValue` both already fold booleans
  into the numeric key space, so a mismatch would be in the comparator, not the encoding.
- **Composite equi-pairs** (`index-nested-loop` only). The predicate is applied per pair;
  the store's composite key is a concatenation of per-column encodings, so per-column key
  identity gives composite key identity. Cover a two-pair join with one numeric cross-type
  pair and one same-type pair.
- **Semantic ordering still declines.** `TIMESPAN` against `TIMESPAN` is a same-type pair
  and must keep declining. The existing test asserting this must still pass unchanged.
- **Collation cover still runs.** Numeric types are not collation-aware, so
  `effectiveCollationOfTypes` resolves BINARY and the cover classifies as a match. The
  existing text-collation decline tests must still pass unchanged.
- **Plugin-registered numeric type declines.** Register a custom logical type with
  `isNumeric: true` and confirm the pair is still refused — this is what pins the
  identity-based whitelist against being "simplified" into an `isNumeric` check.
- **Isolation overlay.** A cross-type key set must merge correctly against uncommitted
  rows: the byte window comes from the store while the residual re-check runs in memory
  over a different numeric representation.
- **Store caps unchanged.** `MAX_MULTI_SEEK_KEYS` (1000), the primary-key `IN` decline, and
  the break-even interpolation all keep behaving as they do today; a cross-type set is
  nothing special to them.

## TODO

### Phase 1 — the predicate

- Add `sharesSeekKeySpace` to `types/builtin-types.ts` with the rationale docstring above;
  export it the same way `isNumericOrUnknownType` is exported.
- Unit-test it directly: all nine ordered pairs over the three numeric singletons return
  true; every numeric-vs-`TEXT`/`BLOB`/`JSON`/`ANY`/temporal pair returns false; identical
  non-numeric types return true; a plugin-registered `isNumeric` type returns false against
  each builtin.

### Phase 2 — the two gate sites

- Swap the gate in `rule-key-set-seek.ts` `resolveSeekColumns`; keep the semantic-ordering
  check untouched; update the decline log message and the file's header docstring bullet.
- Swap the gate in `index-nested-loop.ts` `resolvePairs`; same treatment.
- Invert the existing decline tests: `test/optimizer/key-set-seek.spec.ts` ~line 182
  ("declines a cross-type pair (INTEGER column, REAL keys)") and
  `test/optimizer/index-nested-loop.spec.ts` ~line 197 ("on cross-type join keys") now
  assert the rewrite **is** applied and the rows are unchanged from the hash/nested-loop
  answer they previously pinned.
- Add the reverse direction (`REAL` target, `INTEGER` keys) and the `NUMERIC` pairing to
  both spec files, plus the plugin-numeric-type decline.

### Phase 3 — the plan-time literal path

- Add the `NOTE:` at the `literalFromValue` site in `rule-select-access-path.ts`. No
  behaviour change.
- Pin the literal path's cross-type row behaviour where the numeric coercion assertions
  already live (`test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic`, or
  `test/plan/cast-seek-blocking.spec.ts`'s IN-list block): `i in (1.0, 2.0)` → both rows,
  `i in (1.5)` → no rows, over an indexed `INTEGER` column.

### Phase 4 — cross-backend and row-level coverage

- Extend `test/logic/08.4-key-set-semi-join.sqllogic` with the cross-type scenarios (both
  directions, `NUMERIC`, the 2^53 boundary, the non-integral key, signed zero). This file
  runs under the memory backend in `yarn test` and under the store backend in
  `yarn test:store`, which is what makes it the right home for the row-level contract.
- Add a store-side push assertion to `packages/quereus-store/test/key-set-seek-store.spec.ts`.
- Add the overlay case to `packages/quereus-isolation/test/key-set-seek-merge.spec.ts`.
- Resolve the NaN question and land whatever it implies (a runtime skip, or a `NOTE:`).

### Phase 5 — docs and validation

- `docs/optimizer-rules.md` (~line 39): the `ruleKeySetSeek` gate list says "identical
  logical types" — restate as the key-space rule.
- `docs/optimizer.md` (~line 118): "cross-type or semantic-ordering keys" in the decline
  list — same correction.
- `docs/optimizer-joins.md` (~line 122): "cross-logical-type or semantic-ordering join keys"
  in the index-nested-loop decline list — same correction.
- `docs/types.md`: add a bullet naming the seek-key-space invariant — that a numeric index
  key's identity is its value, not its JavaScript representation, and that the membership
  check, the memory comparator and the store encoder are the three places that must agree.
  It is an architectural property with no single code site, which is why it belongs here
  rather than as a comment.
- Run `yarn build`, `yarn lint`, `yarn test`, then `yarn test:store` (the store run is what
  exercises the byte-encoding half of the argument — do not skip it), streaming each with
  `tee` so the runner sees output.
