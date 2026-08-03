---
description: Two query optimisations that look rows up through an index used to give up whenever the two columns being matched were declared with different number types — whole numbers on one side, decimals on the other. They now handle that case, so those queries get the faster plan.
files:
  - packages/quereus/src/types/builtin-types.ts                          # new sharesSeekKeySpace + isSeekKeySpaceNumeric (~line 355)
  - packages/quereus/src/types/index.ts                                  # re-export
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts       # gate site 1 (resolveSeekColumns) + header docstring + NaN NOTE
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts         # gate site 2 (resolvePairs) + docstring
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # NOTE only, no behaviour change (~line 559)
  - packages/quereus/test/type-system.spec.ts                            # predicate unit tests
  - packages/quereus/test/optimizer/key-set-seek.spec.ts                 # plan-shape: cross-type numeric seek keys
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts            # plan-shape: cross-type numeric join keys
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts                # plan-time literal IN rows
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic          # row-level, runs under memory AND store
  - packages/quereus-store/test/key-set-seek-store.spec.ts               # store byte-encoding half
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts           # overlay merge half
  - docs/types.md, docs/optimizer.md, docs/optimizer-rules.md, docs/optimizer-joins.md
difficulty: medium
---

## What changed

Two optimizer rules rewrite a join into an index lookup on the inner table:

- `ruleKeySetSeek` — turns `where col in (select …)` into a `KeySetSemiJoinNode` that
  materializes the key set once and hands it to the target's storage module as a
  multi-key index seek.
- the index-nested-loop candidate builder (`rules/join/index-nested-loop.ts`) — turns a
  join into a per-outer-row index seek on the inner side.

Both carried a byte-identical gate refusing any pair whose two columns declared different
logical types. That gate has been replaced, in both rules, by a shared predicate.

### The predicate

`sharesSeekKeySpace(a, b)` in `src/types/builtin-types.ts` (exported from
`src/types/index.ts`), sitting beside `isNumericOrUnknownType`:

- **identical types** (compared by `name`, exactly as the old gate did) → true;
- **any pair drawn from `INTEGER` / `REAL` / `NUMERIC`** → true;
- everything else → false.

The numeric whitelist is identity against the three registry singletons, deliberately
**not** `type.isNumeric`. A plugin-registered numeric type supplies its own `compare`,
which is what a memory-table BTree over such a column is ordered by, while the probe side
keys by storage class; the two need not agree and a seek has no residual able to repair
an under-fetch. `BOOLEAN` is excluded for the same reason — `BOOLEAN_TYPE.compare` ranks
by `a === b`, so it disagrees with a `1`/`0` operand even though the key serializer and
the store's byte encoding both fold booleans into the numeric space.

### What is NOT done, on purpose

**No coercion of the key value.** The originating plan ticket guessed the answer would be
"apply the column's own conversion". It is not, and must not become one:
`INTEGER_TYPE.parse(1.5)` truncates to `1`, minting a key for a value the comparison
calls unequal. On the plan-time literal path (`where i in (1.5)`) the `IN` is reported
fully handled, so no residual survives to reject the resulting `i = 1` row — coercion
would introduce a wrong answer where none exists. A `NOTE:` now sits at that site
(`rule-select-access-path.ts`, the `literalFromValue` call in the literal-IN arm) so a
future author does not "fix" it. That file's behaviour is unchanged.

### The NaN question, resolved

The plan ticket asked whether a NaN seek key can *under*-fetch, and required a definite
answer. **It cannot**, and the reasoning is recorded as a `NOTE:` in `resolveSeekColumns`:

- a NaN key's probe string is `n:NaN`, which matches only a stored NaN;
- memory backend — `REAL` / `NUMERIC` rank NaN first and NaN = NaN in the very comparator
  their BTrees are built with, so the seek lands on the NaN entries; an `INTEGER`-declared
  column cannot hold NaN at all (`INTEGER_TYPE.validate` rejects it), so there is no row
  to miss, and its comparator ranking NaN equal to everything can only over-fetch — which
  the unconditional probe trims;
- store backend — `encodeNumeric` maps every NaN to one byte string, so the window is
  exactly the NaN rows.

Dropping NaN keys the way NULL keys are dropped would have been **wrong**: it would
under-fetch a genuinely NaN-valued row in a `REAL` / `NUMERIC` column, a shape that works
today. No runtime change was made.

## Use cases to exercise

Everything below is expected to now take the faster plan and return the same rows it
returned before through the hash / nested-loop fallback.

- `select pk from big where v in (select r from rsrc)` — `INTEGER` column, `REAL` keys.
- `select pk from rt where r in (select k from isrc)` — `REAL` column, `INTEGER` keys
  (the direction the `bug-real-compare-throws-on-bigint` prereq unblocked).
- `… where v in (select … union all select …)` — set-operation type merging produces a
  `NUMERIC` key column against an `INTEGER` target. Also `NUMERIC` column vs `INTEGER`
  keys.
- `select sr.id from sr join big on big.v = sr.k` — the same pairing through
  index-nested-loop, both directions, plus a two-pair composite ON with one cross-type
  pair and one same-type pair.
- `where i in (1.0, 2.0)` on an indexed `INTEGER` column → both rows;
  `where i in (1.5)` → **no** rows. This is the pair a coercion-based implementation
  would get wrong.

Boundaries that must still hold:

- past 2^53 — a `REAL` key of `9007199254740992.0` matches the integer of equal magnitude
  and must **not** reach `9007199254740993`;
- signed zero — a `-0.0` key returns the row storing `0`;
- `TIMESPAN` vs `TIMESPAN` still declines (semantic ordering — a separate gate, untouched);
- text-collation declines unchanged;
- `TEXT` vs `INTEGER`, `BLOB`, temporal pairs, and plugin-registered numeric types all
  still decline.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean (includes eslint + `tsc -p tsconfig.test.json --noEmit` for
  `packages/quereus`).
- `yarn typecheck` — clean.
- `yarn test` — 8551 passing in `packages/quereus`, all other workspaces green,
  0 failing.
- `yarn test:store` — 8543 passing, 21 pending, 0 failing. Confirmed separately that
  `08.4-key-set-semi-join.sqllogic` (which carries the new cross-type row-level block)
  actually executes under store mode rather than being skipped.

New tests:

| where | what |
| --- | --- |
| `test/type-system.spec.ts` § `sharesSeekKeySpace` | the predicate directly: all nine numeric ordered pairs, every numeric-vs-non-numeric pair both directions, identical non-numeric types, `BOOLEAN`, a plugin `isNumeric` type |
| `test/optimizer/key-set-seek.spec.ts` § cross-type numeric seek keys | 4 push cases + 1 plugin-type decline, each also pinning rows |
| `test/optimizer/index-nested-loop.spec.ts` | 3 fire cases (incl. composite ON) + `TEXT` and plugin-type declines |
| `test/plan/cast-seek-blocking.spec.ts` § IN value list | plan-time literal path rows, incl. the non-integral no-match |
| `test/logic/08.4-key-set-semi-join.sqllogic` | row-level under **both** backends: both directions, `NUMERIC` two ways, 2^53, non-integral key, signed zero, NULL keys unchanged |
| `quereus-store/test/key-set-seek-store.spec.ts` | store really receives a `plan=5` multi-seek with `REAL` keys; the 2^53 window excludes the neighbour |
| `quereus-isolation/test/key-set-seek-merge.spec.ts` | secondary-index overlay merge with a cross-type key set |

The two decline tests the plan ticket asked to invert were inverted rather than deleted:
`key-set-seek.spec.ts` ~line 182 and `index-nested-loop.spec.ts` ~line 197.

## Known gaps — please probe these

- **Same-type arm compares `name`, not object identity.** This preserves the replaced
  gate exactly, but it means two *distinct* type objects sharing a name (possible only by
  a plugin overwriting a builtin name in the global registry, which `registerType` merely
  warns about) still pass. Pre-existing behaviour, carried forward deliberately; say so
  if you would rather tighten it.
- **NaN + seek-key ordering is unexamined beyond under-fetch.** With a NaN key against an
  `INTEGER`-declared column, `INTEGER_TYPE.compare` ranks NaN equal to everything, so both
  the engine's seek-key sort and the backend's own re-sort are operating with an
  inconsistent comparator. I concluded this is an over-fetch (probe-trimmed) and NOT new
  — a `select cast(… as integer)` key source can already carry NaN past the old same-type
  gate — but I did not build a test that reaches it, and the isolation *primary-key*
  merge is the path where an out-of-order underlying stream has historically mis-paired
  staged rows. Worth a second opinion; if you agree it is reachable, it is a `bug-`, not
  a tripwire.
- **Cross-type over the isolation PRIMARY-KEY merge is not pinned.** Only the
  secondary-index merge got a cross-type case. The memory backend does serve a runtime
  key set on the primary key as a `_primary_` multi-seek, so a cross-type variant of that
  path exists and is uncovered.
- **The plugin-type tests mutate the global type registry.** `db.registerType('KSSNUM'…)`
  and `'INLNUM'` land in the process-wide `typeRegistry` with no unregister (following the
  existing precedent in `type-system.spec.ts`). Names were picked to avoid collisions, but
  it does leak for the run.
- **No test asserts the new decline log wording**, only that the rules decline.
- `where i in (1.5)` (single element) takes the plain equality-seek arm, not the
  multi-seek arm, so that assertion pins rows only, not plan shape.

## Review findings

<!-- reviewer fills this in -->
