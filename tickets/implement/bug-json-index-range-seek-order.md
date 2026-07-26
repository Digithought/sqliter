---
description: A stored JSON array is mistaken for a multi-column key by the in-memory table's index scanner, so range and some equality queries on an indexed JSON column silently return the wrong rows.
files:
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts   # the two shape sniffs that produce the wrong answer
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts    # four more sniffs: NULL seek-key test + early termination
  - packages/quereus/src/vtab/memory/types.ts               # BTreeKey — the ambiguous type at the root of it
  - packages/quereus/src/vtab/memory/utils/primary-key.ts   # arity → scalar vs tuple key (the rule to follow)
  - packages/quereus/src/vtab/memory/index.ts               # MemoryIndex — same rule for secondary indexes
  - packages/quereus/src/vtab/memory/layer/manager.ts       # two latent sniffs (lines ~513, ~1296)
  - packages/quereus/src/util/comparison.ts                 # NOTE at ~236 states the WRONG cause; correct it
  - docs/types.md                                           # JSON "Keys" bullet (~213) states the WRONG cause
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic  # comment at ~143 states the WRONG cause
  - packages/quereus/test/logic/                            # new regression file goes here
difficulty: medium
---

# A JSON array value is misread as a composite index key

## Diagnosis — the original ticket's cause was wrong

The `fix/` ticket theorised that this was an *ordering* disagreement: comparisons ranking
JSON documents structurally while the index walked canonical-JSON-text order. **That is not
what is happening**, and no ordering or storage-format change is needed.

Both sides already agree. For a column declared `json`:

- the in-memory index's B-tree comparator is `createTypedComparator(JSON_TYPE, …)`
  (`vtab/memory/index.ts:123`, and `utils/primary-key.ts:88` for a JSON primary key),
- `<` / `>` / `between` at runtime use the *same* construction
  (`runtime/emit/binary.ts:252`, the `sharedSemanticType` branch),
- `order by` likewise (`createTypedOrderByComparator`).

Confirmed empirically: `select id from j order by v` returns the identical sequence with and
without the index, and that sequence is the structural one. The canonical-JSON-text ordering
in `compareSameType`'s OBJECT branch (`util/comparison.ts:289`) is only reached for columns
that are *not* declared `json`, and on that path the runtime comparison uses the same
function — so it is self-consistent too.

## The real cause: an ambiguous key type

`BTreeKey = SqlValue | SqlValue[]` (`vtab/memory/types.ts`). A single-column index or
primary key stores the raw value as a **scalar** key; a multi-column one stores a
**tuple** (a `SqlValue[]`). Nothing tags which is which, so six places in the scan path
recover the shape by sniffing `Array.isArray(key)`.

A JSON array value *is* a JS array. So for a single-column index over a JSON column, the
stored document `[1]` is read as the one-element tuple `(1)` — and every bound check then
compares against the number `1` instead of the document `[1]`.

The B-tree itself is fine: it is built and searched with the typed comparator, which never
sniffs. Only the *filters layered on top of the walk* are wrong, which is why the failures
look like arbitrary holes in an otherwise correct window.

### Affected sites

| File | Line | What it does | JSON-array effect |
|---|---|---|---|
| `layer/plan-filter.ts` | 141 | `keyForBoundComparison = Array.isArray(key) ? key[0] : key` | **primary defect** — bound compared against `key[0]` |
| `layer/plan-filter.ts` | 117 | prefix-range tuple view | same, on the prefix-range path |
| `layer/scan-layer.ts` | 17 | `seekKeyHasNull` — `key.some(v => v === null)` | a document containing a JSON `null` is treated as a NULL key ⇒ **equality returns nothing** |
| `layer/scan-layer.ts` | 165, 181 | primary-tree early termination | walk stops / continues at the wrong key |
| `layer/scan-layer.ts` | 274, 290 | secondary-index early termination | same |
| `layer/manager.ts` | 513 | data-change event `key` field | latent: emits `[1]` where the contract wants `[[1]]` |
| `layer/manager.ts` | 1296 | `newSourcePk` for the covering-MV UNIQUE check | latent: same mis-shaping |

`quereus-store` does **not** have this problem — it encodes JSON key members to opaque bytes
via `jsonStructuralKey`, so no shape sniffing exists there. `quereus-isolation` has none
either. This is a memory-module defect, which matches the original ticket's observation that
store mode returned the correct rows: correct **by design**, not by accident.

## Reproduction

```sql
create table j (id integer primary key, v json);
create index j_v on j (v);          -- second table without the index for comparison
insert into j values
  (1, '{"a":1}'), (2, '{"a":10}'), (3, '{"a":2}'),
  (4, '[1]'), (5, '"z"'), (6, '5'), (7, 'true'),
  (8, '[null]'), (9, '[9,9]');
```

| query | no index (correct) | with index (observed) |
|---|---|---|
| `where v > json('5')` | `1,2,3,4,5,8,9` | `1,2,3,5,9` |
| `where v > json('[1]')` | `1,2,3,9` | `1,2,3` |
| `where v = json('[null]')` | `8` | *(empty)* |
| `order by v` | `7,6,5,8,4,9,1,3,2` | same ✓ |

The same holds for a JSON **primary key** (`create table k (v json primary key, …)`), where
`where v > json('5')` drops `[1]` and `[null]`, and `where v = json('[null]')` returns
nothing.

Note this contradicts the original ticket's "equality is NOT affected" claim: equality on a
document that *contains* a JSON `null` is broken too, via `seekKeyHasNull`.

## Fix: carry the arity, never sniff the shape

The key's shape is fully determined by the scanned structure's arity, which the schema
already knows and which `scan-plan.ts` already respects when it *builds* keys
(`buildCompositeEqualityKey` returns a scalar exactly when the index has one column).
The consumers just need the same number.

`resolveScanComparators` (`plan-filter.ts:63`) already resolves the scanned index's column
list. Extend `ResolvedScanComparators` with the arity-derived flag and thread it to every
site that currently sniffs:

```ts
export interface ResolvedScanComparators {
	readonly equalityPrefix: readonly ValueComparator[];
	readonly bound: ValueComparator;
	/** True when the scanned tree stores TUPLE keys (arity !== 1). Never infer this
	 *  from `Array.isArray` — a JSON array value is a scalar key that is also a JS array. */
	readonly keyIsTuple: boolean;
}

/** The tuple view of a key whose arity is known. */
export function keyParts(key: BTreeKey, keyIsTuple: boolean): SqlValue[] {
	return keyIsTuple ? key as SqlValue[] : [key as SqlValue];
}
```

with `keyIsTuple: (indexColumns?.length ?? 1) !== 1` — `!== 1`, not `> 1`, so the
zero-column (singleton) primary key, whose extractor returns `[]`, keeps its tuple shape.
`resolveIndexColumns` already falls back to the synthesized all-columns definition exactly
as `createPrimaryKeyFunctions` does, so the two arities cannot drift.

`seekKeyHasNull` needs the same flag passed in; every call site in `scanLayerResolved`
already has `comparators` in scope.

**This exact patch was prototyped and verified during triage**: with it, all four indexed
queries above return byte-identical results to the unindexed ones, on both the secondary
index and the JSON primary key. The prototype was reverted — the tree is unchanged.

The `manager.ts` sites have no `comparators` in scope; shape them from
`schema.primaryKeyDefinition` arity instead (the same source `createPrimaryKeyFunctions`
uses).

Consider also documenting the invariant on `BTreeKey` in `types.ts`: *the scalar/tuple
choice is a function of arity alone and is never recoverable from the value* — that comment
is what stops the sniff from being reintroduced.

## Corrections to existing prose

Three places assert the wrong cause and will mislead the next reader:

- `util/comparison.ts` ~236 — the second `NOTE` on `objectCanonicalCache` claims the memory
  module diverges because the two orders disagree. Replace with the real cause (or drop the
  paragraph; the preceding paragraph about the two orders being unrelated is still true and
  worth keeping).
- `docs/types.md` ~213 — the "Caveat" at the end of the JSON *Keys* bullet says a memory
  JSON index range seek walks a different window than `<`/`>` because canonical-text order
  differs. Untrue; correct it.
- `test/logic/06.9.2-json-structural-equality.sqllogic` ~143 — the comment above the
  `between` case says the same. Correct it, and the case itself can then be read as ordinary
  coverage.

Also worth a line in `docs/memory-table.md` (near the existing NULL-bound-seek bullets in
*Current Limitations*) recording that scan-path key shape comes from arity.

## Testing

New logic file, e.g. `test/logic/06.9.3-json-index-range-seek.sqllogic`, **without**
`using memory` so it runs in store mode too:

- two tables with identical rows covering every JSON kind (`null`-containing arrays, nested
  arrays, objects, string/number/boolean scalars), one indexed and one not;
- the same range / `between` / `=` / `in` queries against both, with the expected row sets
  written out explicitly (they must be equal, and must match `order by v`);
- include the `[null]` and `[9,9]` documents specifically — those are the cases the naive
  fix (only touching the bound comparison) would leave broken.

Plus a focused unit spec for the JSON **primary key** path (a `.spec.ts` under `test/vtab/`),
since a JSON PK is awkward to express in a store-mode logic file.

## TODO

- Add `keyIsTuple` to `ResolvedScanComparators` and the `keyParts` helper in `plan-filter.ts`;
  derive the flag from the resolved index column count with `!== 1`.
- Replace both `Array.isArray` shape sniffs in `plan-filter.ts` with `keyParts`.
- Thread the flag into `seekKeyHasNull` and the four early-termination sniffs in `scan-layer.ts`.
- Fix the two latent shape sniffs in `layer/manager.ts` (data-change event key, covering-MV
  `newSourcePk`) using the primary-key definition's arity.
- Document the arity invariant on `BTreeKey` in `vtab/memory/types.ts`.
- Correct the three wrong-cause notes: `util/comparison.ts`, `docs/types.md`,
  `06.9.2-json-structural-equality.sqllogic`; add the key-shape line to `docs/memory-table.md`.
- Add `test/logic/06.9.3-json-index-range-seek.sqllogic` (no `using memory`) comparing an
  indexed and an unindexed JSON column over a mixed corpus.
- Add a JSON-primary-key unit spec under `test/vtab/`.
- Run `yarn test`, then `yarn test:store` for the new logic file, plus `yarn lint`.
