---
description: Several kinds of query crash with an internal error whenever they have to build a lookup set of binary (BLOB) values — asking whether a value is one of a subquery's results, checking membership in a list of binary literals, or counting distinct binary values.
files:
  - packages/quereus/src/runtime/emit/subquery.ts          # emitIn — set probe (~line 230) and constant value-list (~line 312)
  - packages/quereus/src/runtime/emit/aggregate.ts         # DISTINCT aggregate trees (~lines 152, 375, 390)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts    # DISTINCT aggregate trees (~line 111)
  - packages/quereus/src/util/comparison.ts                # compareSqlValuesFast — already blob-correct, no change needed
  - packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic
  - packages/quereus/test/logic/07.9-in-value-list.sqllogic
  - packages/quereus/test/logic/92-hash-aggregate-edge-cases.sqllogic
  - packages/quereus/test/logic/07-aggregates.sqllogic
difficulty: easy
---

# BLOB values cannot be stored in the engine's in-memory lookup sets

## Root cause — confirmed

The engine uses `BTree` from the `inheritree` package for every in-memory set
it builds during query execution. By default that tree calls `Object.freeze`
on each entry it stores (`BTree.freezeEntry`, `inheritree/dist/b-tree.js:198`;
option documented in `BTreeOptions.freeze`, default `true`).

`Object.freeze` on a non-empty `Uint8Array` throws:

```
TypeError: Cannot freeze array buffer views with elements
```

So the crash hits exactly the trees **whose entry is a bare scalar value** —
because a BLOB scalar *is* the `Uint8Array`. Trees whose entry is a `Row`
(an array) or a wrapper object are unaffected: `Object.freeze` is shallow, so
the array freezes fine and the BLOB elements inside are never touched.

## Actual scope — wider than the original report

Reproduced against a fresh `Database` (all six sites below throw the same
`Cannot freeze array buffer views with elements`):

| Shape | Site | Before |
|---|---|---|
| `t in (select blob_col from s)` in select list | `subquery.ts:230` (set probe) | throws |
| `blob_col in (select blob_col from s)` (any non-`where` position) | `subquery.ts:230` | throws |
| `blob_col not in (select …)` | `subquery.ts:230` | throws |
| `blob_col in (x'6162', x'6164')` — constant value list | `subquery.ts:312` | **throws** (not in original report) |
| `count(distinct blob_col)` — no GROUP BY | `aggregate.ts:152`, `hash-aggregate.ts:111` | **throws** (not in original report) |
| `count(distinct blob_col) … group by …` | `aggregate.ts:375`, `aggregate.ts:390`, `hash-aggregate.ts:111` | **throws** (not in original report) |

Verified **unaffected** (Row-entry trees, shallow freeze): `select distinct
blob_col`, `union` over BLOB columns, memory-vtab primary/secondary index
trees, `distinct.ts`, `set-operation.ts`, `recursive-cte.ts`,
`async-gather.ts`. A top-level `where blob_col in (select …)` is also fine
because the optimizer rewrites it to a semi join, which never builds this set —
that is the shape/position divergence the original report called out, and it
disappears once the set-probe path stops throwing.

`compareSqlValuesFast` already handles `Uint8Array` correctly
(`util/comparison.ts:278`) — byte-wise BLOB ordering, and cross-storage-class
ordering that puts BLOB above TEXT. **No comparator change is needed.**

## The fix

Pass `{ freeze: false }` when constructing the six scalar-entry trees. The
library explicitly supports this (`BTreeOptions.freeze`), and freezing buys
nothing here: these entries are transient membership keys the engine never
mutates, and freezing them would in fact be a *harmful* side-effect on
caller-owned buffers (the `Uint8Array` reference comes straight off the source
row).

Verified working — this exact change was applied locally and every shape above
returned correct three-valued results, then reverted so the implement stage
lands it cleanly:

```
select-list  t in (select b from s)        → false        (text vs blob: no match, matches SQLite)
blob in (select b from s)                  → true / false (byte equality)
blob not in (select b from s)              → false / true
blob in (select b from sn) w/ NULL inner   → true on hit, NULL on miss
blob not in (…) w/ NULL inner              → NULL on miss
case when blob in (select …)               → 'y' / 'n'
correlated  blob in (select … where …)     → true / NULL / true
blob in (x'6162', x'6164')                 → true / false
x'' in (x'6162', NULL)                     → NULL
count(distinct blob)                       → 2
count(distinct blob) group by id           → 1, 1
where blob in (select …)  (semi join)      → unchanged, still correct
```

### Prefer a shared factory over six inline literals

Six call sites all want "a BTree used as a set of SQL scalar values". Rather
than repeating `{ freeze: false }` (and the reason for it) six times, add a
small factory — suggested `packages/quereus/src/util/value-set.ts`:

```ts
/**
 * BTree used as a set of SQL scalar values (IN membership, DISTINCT aggregates).
 *
 * `freeze: false` is required, not an optimization: inheritree freezes each
 * stored entry by default, and `Object.freeze` throws on a non-empty
 * `Uint8Array` — so a BLOB value could not be stored at all. Freezing would
 * also be wrong here regardless: the entry is a reference to a value owned by
 * the source row, not a copy.
 *
 * NOTE: consequently the set holds references to caller-owned BLOB buffers. If
 * a vtab ever recycles a `Uint8Array` across rows instead of handing out a
 * fresh one, membership/DISTINCT answers would silently change under it.
 */
export function createValueSet<T extends SqlValue | SqlValue[]>(
	compare: (a: T, b: T) => number,
): BTree<T, T> {
	return new BTree<T, T>(v => v, compare, { freeze: false });
}
```

The aggregate sites are typed `BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]>`
(composite DISTINCT keys are arrays), the `emitIn` sites `BTree<SqlValue, SqlValue>`
— the generic above covers both. Keep the existing per-site comparators as they
are; only the construction moves.

Leave the Row-entry trees alone — they are out of scope and currently correct.

## Test coverage

Assertions must not select a BLOB column directly: the sqllogic runner
deep-equals against JSON-parsed expected values, and a `Uint8Array` will not
compare cleanly. Assert on membership booleans, ids, counts, or `hex(...)`.

`07.7-in-subquery-caching.sqllogic` (set-probe corpus) — a BLOB block:
blob-vs-blob match and non-match; blob against a NULL-bearing inner (hit → true,
miss → NULL); text-vs-blob non-match; `not in`; the same cases in select-list
position; and the `where` position too, so the set-probe and semi-join paths are
pinned to agree.

`07.9-in-value-list.sqllogic` — constant BLOB value list, including a NULL list
element (`x'' in (x'6162', NULL)` → NULL) and the empty blob `x''`.

`07-aggregates.sqllogic` (or `06.6-aggregate-extended.sqllogic`) and
`92-hash-aggregate-edge-cases.sqllogic` — `count(distinct blob_col)` with and
without `GROUP BY`, so both the stream-aggregate and hash-aggregate trees are
covered.

Note for setup SQL: columns in Quereus are NOT NULL by default — a nullable
BLOB column must be declared `b blob null`.

## Observed, deliberately out of scope

`select group_concat(distinct b) from bt` over BLOBs returns the decimal byte
list as text (`"97,98,97,99"`). That is the BLOB→TEXT conversion, not this
bug, and it is unverified against SQLite. Do not chase it here; if the review
stage thinks it is a real divergence, it deserves its own ticket.

## TODO

- Add `createValueSet` (or equivalent shared factory) with the rationale comment
  and the caller-owned-buffer `NOTE:` tripwire.
- Route `subquery.ts` set-probe tree (~line 230) and constant value-list tree
  (~line 312) through it.
- Route `aggregate.ts` DISTINCT trees (~lines 152, 375, 390) through it.
- Route `hash-aggregate.ts` DISTINCT trees (~line 111) through it.
- Add the BLOB blocks to `07.7-in-subquery-caching.sqllogic` and
  `07.9-in-value-list.sqllogic`.
- Add `count(distinct blob)` coverage to the stream- and hash-aggregate corpora.
- Run `yarn test` and `yarn lint` from the repo root.
