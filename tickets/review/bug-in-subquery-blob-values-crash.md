description: Several kinds of query used to crash with an internal error whenever they had to build a lookup set of binary (BLOB) values — fixed by no longer freezing those in-memory sets.
files:
  - packages/quereus/src/util/value-set.ts                 # new — createValueSet factory
  - packages/quereus/src/runtime/emit/subquery.ts           # emitIn set probe + constant value-list, now via createValueSet
  - packages/quereus/src/runtime/emit/aggregate.ts          # stream-aggregate DISTINCT trees, now via createValueSet
  - packages/quereus/src/runtime/emit/hash-aggregate.ts     # hash-aggregate DISTINCT trees, now via createValueSet
  - packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic
  - packages/quereus/test/logic/07.9-in-value-list.sqllogic
  - packages/quereus/test/logic/92-hash-aggregate-edge-cases.sqllogic
  - packages/quereus/test/logic/07-aggregates.sqllogic
difficulty: easy
---

# BLOB values in in-memory lookup sets — fixed

## Root cause (confirmed in the fix ticket, unchanged)

The engine builds every in-memory "set of scalar values" (IN-subquery
membership, constant `IN (...)` value lists, `DISTINCT` aggregate tracking)
as a `BTree` from the `inheritree` package. That library freezes each stored
entry by default (`BTreeOptions.freeze`, default `true`). `Object.freeze`
throws on a non-empty `Uint8Array` — and a BLOB scalar *is* a `Uint8Array` —
so any of these trees crashed the instant a non-empty BLOB value was
inserted, with:

```
TypeError: Cannot freeze array buffer views with elements
```

Trees whose entry is a `Row` (array) or wrapper object were never affected —
`Object.freeze` is shallow, so the row array freezes fine and the BLOB
elements inside are untouched. Those (memory-vtab index trees, `distinct.ts`,
`set-operation.ts`, `recursive-cte.ts`, `async-gather.ts`) were out of scope
and are unchanged.

## Fix applied

Added `packages/quereus/src/util/value-set.ts`:

```ts
export function createValueSet<T extends SqlValue | SqlValue[]>(
	compare: (a: T, b: T) => number,
): BTree<T, T> {
	return new BTree<T, T>(v => v, compare, { freeze: false });
}
```

Routed all six scalar-entry `BTree` construction sites through it:

- `subquery.ts` — the uncorrelated-IN set-probe tree (`emitIn`, one per
  execution, memoized on `RuntimeContext.inSetProbes`) and the constant
  `IN (a, b, ...)` value-list tree (built once at emit time).
- `aggregate.ts` (the stream-aggregate emitter) — the no-GROUP-BY DISTINCT
  tree and the two GROUP BY DISTINCT-tree-reset sites (new group / first
  group).
- `hash-aggregate.ts` — `createDistinctTrees()`, shared by both its
  no-GROUP-BY and grouped code paths.

`{ freeze: false }` is correct here, not just a workaround: these entries are
transient membership keys the engine never mutates, and freezing was already
a *side effect on caller-owned data* — the `Uint8Array` reference comes
straight off the source row, not a copy. `createValueSet`'s doc comment
carries a `NOTE:` tripwire: if a vtab ever recycled a `Uint8Array` buffer
across rows instead of handing out a fresh one per row, membership/DISTINCT
answers could silently change out from under the set. No vtab in this repo
does that today — nothing to act on now, just something a future reader
should know if a membership/DISTINCT result ever looks stale.

`compareSqlValuesFast` (`util/comparison.ts`) needed no changes — it already
compared `Uint8Array` correctly (byte-wise ordering, BLOB ranked above TEXT
for cross-storage-class comparisons).

Where the `BTree` symbol was left only as a type annotation after the
construction sites moved to `createValueSet`, the import was changed to
`import type` (`subquery.ts`, `aggregate.ts`, `hash-aggregate.ts`) to keep
lint clean — `aggregate.ts` and `hash-aggregate.ts` still construct `BTree`
directly nowhere now; only the type is referenced for the `distinctTrees`
array element type.

## What to test / how to validate

All three of the following were run clean from repo root:
- `yarn test` — full workspace suite, 1202 passing in `packages/quereus` (no
  failures, no skips introduced).
- `yarn lint` — clean (quereus's real lint is eslint + a `tsc --noEmit` pass
  over the changed emit/util files; both silent/zero-diagnostic).
- Manual repro of all six previously-crashing shapes from the fix ticket
  (`t in (select blob_col from s)`, `blob_col in (select ...)` in any
  non-WHERE position, `blob_col not in (select ...)`, `blob_col in (x'..',
  x'..')` constant list, `count(distinct blob_col)` with and without
  `GROUP BY`) — all now return correct three-valued results instead of
  throwing.

New/expanded sqllogic coverage (test names to look at if something regresses):

- `07.7-in-subquery-caching.sqllogic` — new BLOB block: select-list-position
  IN and NOT IN (byte-equality hit / miss / condition-NULL), the same
  through a `CASE WHEN`, the `WHERE`-position semi-join path (confirms it
  still agrees with the set-probe path), a NULL-bearing inner result set
  (miss → NULL instead of false), a cross-storage-class TEXT-vs-BLOB
  no-match assertion, and a correlated-inner case (streaming path, never
  built a BTree, kept for regression parity).
- `07.9-in-value-list.sqllogic` — new BLOB block: constant value list
  membership, a NULL list element turning a miss into NULL, and the
  zero-length BLOB literal `x''` (a distinct valid value, not NULL — matches
  itself, doesn't match a NULL-bearing list).
- `07-aggregates.sqllogic` — `count(distinct blob_col)` with no `GROUP BY`
  (guaranteed by the optimizer's aggregate-physical-selection rule to route
  through `StreamAggregateNode`, since "no GROUP BY → always
  StreamAggregate") and the same with `GROUP BY`.
- `92-hash-aggregate-edge-cases.sqllogic` — `count(distinct blob_col)` with
  `GROUP BY`, mirroring the existing non-BLOB DISTINCT tests in that file
  (`ha_dist_grp`).

None of the new assertions select a BLOB column directly (the sqllogic
runner deep-equals against JSON-parsed expected values, and a raw
`Uint8Array` won't compare cleanly) — every assertion is on a membership
boolean, an id, or a count, per the fix ticket's guidance.

## Known gap / not independently re-verified by this pass

- **Which physical aggregate node actually runs for the `GROUP BY` BLOB
  tests is cost-model-dependent, not forced.** The optimizer's
  `ruleAggregatePhysical` (`planner/rules/aggregate/rule-aggregate-streaming.ts`)
  only *guarantees* `StreamAggregateNode` for the no-`GROUP BY` case; for a
  `GROUP BY` on an unindexed column it picks between "sort + stream" and
  "hash" by estimated cost, and that choice wasn't pinned down (e.g. via a
  plan-shape assertion) for the new tests. The tests pass either way — both
  code paths were fixed — but if a reviewer wants to confirm each new
  `GROUP BY` test actually exercises the *specific* emitter its file name
  suggests, that would need a `EXPLAIN`/plan-node-type check, which this pass
  didn't add.
- **`group_concat(distinct b) from bt` over BLOBs returning the decimal byte
  list as text** (e.g. `"97,98,97,99"`) — flagged as out of scope by the fix
  ticket and left untouched here too. Unverified against SQLite; if this
  matters, it deserves its own ticket, not a fold-in here.
- No performance/benchmark check on the `{ freeze: false }` change — freezing
  was pure overhead for these transient sets to begin with, so this isn't
  expected to be a regression risk, but it wasn't specifically measured.
