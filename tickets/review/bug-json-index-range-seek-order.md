---
description: An indexed JSON column silently returned the wrong rows for range and some equality queries, because a stored JSON array was mistaken for a multi-column key; fixed and now needs a review pass.
files:
  - packages/quereus/src/vtab/memory/types.ts                              # BTreeKey invariant + keyParts / leadingKeyPart helpers (new)
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts                  # keyIsTuple on ResolvedScanComparators; 2 sniffs replaced
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                   # seekKeyHasNull + 4 early-termination sniffs replaced
  - packages/quereus/src/vtab/memory/layer/manager.ts                      # 2 latent sniffs replaced (event key, covering-MV source PK)
  - packages/quereus/src/vtab/memory/utils/primary-key.ts                  # primaryKeyArity() (new)
  - packages/quereus/src/util/comparison.ts                                # wrong-cause NOTE corrected
  - docs/types.md                                                          # wrong-cause caveat corrected
  - docs/memory-table.md                                                   # new "scan-path key shape comes from arity" limitation bullet
  - packages/quereus/test/logic/06.9.3-json-index-range-seek.sqllogic      # new regression file (runs memory + store)
  - packages/quereus/test/vtab/json-primary-key-seek.spec.ts               # new JSON-primary-key + event-key spec
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic   # wrong-cause comment corrected
difficulty: medium
---

# A JSON array value was misread as a composite index key

## What was wrong

The in-memory table module stores a one-column primary key or index key as a bare
value, and a multi-column one as an array of values. Nothing on the stored key says
which it is, so six places in the scan path recovered the shape by asking
`Array.isArray(key)`.

A JSON array value *is* a JavaScript array. So for an index over a JSON column, the
stored document `[1]` was read as the one-element key tuple `(1)`, and every bound
check then compared against the number `1` instead of against the document `[1]`.
Result: an indexed JSON column returned a different — smaller, arbitrarily
holed — row set than the identical unindexed query.

Confirmed before the fix (memory module, table `j` indexed on `v`, table `n` not):

| query | unindexed (correct) | indexed (observed) |
|---|---|---|
| `where v > json('5')` | `1,2,3,4,5,8,9` | `1,2,3,5,9` |
| `where v > json('[1]')` | `1,2,3,9` | `1,2,3` |
| `where v = json('[null]')` | `8` | *(empty)* |
| `where v between json('[1]') and json('[9,9]')` | `4,9` | *(empty)* |
| `where v in (json('[null]'), json('[1]'))` | `4,8` | `4` |

Note two things the original `fix/` ticket got wrong and the implement ticket had
already corrected:

- **It is not an ordering disagreement.** The index tree's comparator, `<`/`>`/BETWEEN
  at runtime, and ORDER BY all rank JSON documents by the same structural compare.
  `order by v` returned the identical sequence with and without the index, before the
  fix. No ordering or storage-format change was needed.
- **Equality was affected too.** A document containing a JSON `null` (`[null]`) was
  read as a key tuple containing SQL NULL, so the seek short-circuited to "no rows".

The persistent store module (`quereus-store`) never had the defect — it encodes JSON
key members to opaque bytes, so no shape test exists there. Same for
`quereus-isolation`. This was a memory-module-only defect.

## What changed

The key's shape is fully determined by the scanned structure's **arity**, which the
schema already knows. That number is now threaded to every consumer instead of being
guessed from the value.

- `vtab/memory/types.ts` — documents the invariant on `BTreeKey` (*the scalar-vs-tuple
  choice is a function of arity alone and is never recoverable from the value*) and
  exports two helpers, `keyParts(key, keyIsTuple)` and `leadingKeyPart(key, keyIsTuple)`.
  The invariant comment is what stops the shape test from being reintroduced.
- `layer/plan-filter.ts` — `ResolvedScanComparators` gains `keyIsTuple`, derived as
  `(indexColumns?.length ?? 1) !== 1`. `!== 1`, not `> 1`: the zero-column singleton
  primary key's extractor returns `[]`, so it stores a tuple too. Both shape tests in
  `planAppliesToKey` now use the helpers.
- `layer/scan-layer.ts` — `seekKeyHasNull` takes the flag; the four early-termination
  shape tests (two on the primary tree, two on the secondary index) use the helpers.
- `layer/manager.ts` — the two latent sites (the data-change event's `key` field, and
  `newSourcePk` for the covering materialized-view UNIQUE check) shape from
  `primaryKeyArity(schema)` instead.
- `utils/primary-key.ts` — new `primaryKeyArity(schema)`, applying the *same* fallback
  `createPrimaryKeyFunctions` uses (no PK definition ⇒ all columns), so the two
  arities cannot drift.

Three prose sites asserted the wrong cause and were corrected: the second `NOTE` on
`objectCanonicalCache` in `util/comparison.ts`, the JSON *Keys* caveat in
`docs/types.md`, and the comment above the `between` case in
`06.9.2-json-structural-equality.sqllogic`. `docs/memory-table.md` gains a
*Current Limitations* bullet recording that scan-path key shape comes from arity.

## How to exercise it

Everything below is green as of this handoff.

- `yarn test` — full workspace suite, 7254 passing in `packages/quereus`, no failures.
- `yarn test:store` — 7246 passing, 21 pending, no failures.
- `yarn lint` — clean (`packages/quereus` runs eslint plus a `tsconfig.test.json` type
  pass; every other package is a documented no-op).
- `yarn build` — clean.

New coverage:

- `test/logic/06.9.3-json-index-range-seek.sqllogic` — deliberately **without**
  `using memory`, so it runs in store mode too and pins that the two modules agree.
  Three tables over the same 20-row corpus spanning every JSON kind: `jrs_n`
  (unindexed reference), `jrs_i` (single-column index on the JSON column), `jrs_c`
  (composite index on `(g, v)`). Each range / `between` / `=` / `in` query is asserted
  against both the indexed and the unindexed table with the same explicit row list,
  and the lists agree with the `order by v` sequence at the top of the file.
  The documents that specifically broke are all present: `[]`, `[1]`, `[null]`,
  `[9,9]`, `[[1,2],[3]]`.
- `test/vtab/json-primary-key-seek.spec.ts` — the JSON **primary key** half (awkward
  to express in a store-mode logic file), 16 cases. Also asserts the data-change
  event's `key` shape both ways: a scalar JSON PK holding `[7]` must emit `[[7]]`,
  and a two-column PK must emit `[1, 2]`.

Manual check to reproduce the old behaviour if you want to see it fail: revert
`plan-filter.ts` and `scan-layer.ts` to `Array.isArray` and re-run either new test —
both fail immediately.

## Known gaps — please look here

- **The covering-materialized-view site in `manager.ts` (~line 1300, `newSourcePk`) is
  untested.** Reaching it needs a row-time covering MV over a table whose primary key
  is a single JSON column *and* which carries a UNIQUE constraint routed through that
  MV. I could not construct that setup cheaply and did not add coverage; the change is
  a mechanical shape correction of the same kind as the event-key one (which *is*
  tested), but it is unverified. If a reviewer can build that fixture, it is the one
  remaining blind spot.
- **The composite-index path is covered only through the logic file's `(g, v)` index**,
  where the leading column is an integer. There is no test with a JSON column in a
  *leading* composite position.
- **`isComposite` in `scan-layer.ts`'s seek-key construction still uses `> 1`**, while
  the new `keyIsTuple` uses `!== 1`. They differ only for the zero-column singleton
  primary key. I left it and added a `NOTE:` at the site explaining why neither branch
  can reach a zero-arity plan today, and what to change if one ever does. Judge whether
  that reasoning holds.
- **Allocation on the prefix path.** `keyParts` allocates a one-element array on the
  scalar path, exactly as the old `[key]` expression did — no regression, and
  `leadingKeyPart` avoids it entirely on the hot single-column bound path.
  `test/performance-sentinels.spec.ts` passes.
- **The new logic file's expected row lists were generated by running the queries** and
  then cross-checked against the `order by v` sequence and against the unindexed table.
  They are not hand-derived from first principles. If a reviewer disagrees with any
  single expectation, check it against the structural rank order
  (null < boolean < number < string < array < object, then element/key-wise recursion).

## Tripwires recorded in code

- `scan-layer.ts` (~line 123) — `NOTE:` on the `isComposite` / `keyIsTuple` `> 1` vs
  `!== 1` divergence and the condition under which it would start to matter.
