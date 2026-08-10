description: Several kinds of query used to crash with an internal error whenever they had to build a lookup set of binary (BLOB) values — fixed by no longer freezing those in-memory sets.
files:
  - packages/quereus/src/util/value-set.ts                 # createValueSet factory
  - packages/quereus/src/runtime/emit/subquery.ts           # emitIn set probe + constant value-list
  - packages/quereus/src/runtime/emit/aggregate.ts          # stream-aggregate DISTINCT trees
  - packages/quereus/src/runtime/emit/hash-aggregate.ts     # hash-aggregate DISTINCT trees
  - packages/quereus/src/vtab/memory/layer/manager.ts       # 'replace-all' maintenance diff new-key set (found in review)
  - docs/memory-table.md                                    # invariant documented (added in review)
  - packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic
  - packages/quereus/test/logic/07.9-in-value-list.sqllogic
  - packages/quereus/test/logic/07-aggregates.sqllogic
  - packages/quereus/test/logic/92-hash-aggregate-edge-cases.sqllogic
  - packages/quereus/test/logic/51-materialized-views.sqllogic
---

# BLOB values in in-memory lookup sets — complete

## Root cause

The engine builds several in-memory "set of values" structures as a `BTree`
from the `inheritree` package. That library freezes each stored entry by
default (`BTreeOptions.freeze`, default `true`), and `Object.freeze` throws on
a non-empty `Uint8Array` — which is exactly what a BLOB scalar is. So any tree
whose *entry* is the bare value crashed the instant a non-empty BLOB was
inserted:

```
TypeError: Cannot freeze array buffer views with elements
```

Trees whose entry is a `Row` (array) or a wrapper object were never affected:
`Object.freeze` is shallow, so the row array freezes fine and the BLOB elements
inside it are untouched.

## Fix

`packages/quereus/src/util/value-set.ts` provides the single construction point:

```ts
export function createValueSet<T extends SqlValue | SqlValue[]>(
	compare: (a: T, b: T) => number,
): BTree<T, T> {
	return new BTree<T, T>(v => v, compare, { freeze: false });
}
```

`{ freeze: false }` is correct, not a workaround: these entries are transient
membership keys the engine never mutates, and freezing them was a side effect
on caller-owned data — the `Uint8Array` reference comes straight off the source
row, not a copy.

Sites routed through it:

- `subquery.ts` — the uncorrelated-IN set-probe tree and the constant
  `IN (a, b, ...)` value-list tree.
- `aggregate.ts` (stream aggregate) — the no-GROUP-BY DISTINCT tree and both
  per-group DISTINCT-tree reset sites.
- `hash-aggregate.ts` — `createDistinctTrees()`, shared by its no-GROUP-BY and
  grouped paths.
- `vtab/memory/layer/manager.ts` — the `'replace-all'` maintenance diff's
  new-row primary-key membership set (**found during review**, see below).

`compareSqlValuesFast` needed no changes — it already compared `Uint8Array`
byte-wise, with BLOB ranked above TEXT across storage classes.

## Review findings

### Checked

Read the implement diff (`75eddffd`) before its handoff summary. Enumerated
**every** `new BTree(...)` construction site in `packages/` and classified each
by entry type (bare value vs `Row` vs wrapper object) rather than trusting the
implement ticket's claim that the remaining sites were all safe. Reviewed
`createValueSet`'s type signature and doc comment, the `import type` narrowing
in the three emit files, the new sqllogic assertions, and whether any doc file
records the invariant. Ran `yarn lint` (eslint + `tsc -p tsconfig.test.json`)
and the full `yarn test` workspace suite; also inspected actual plan shapes to
verify which physical aggregate node each new test really exercises.

### Major — one missed site, same defect, fixed in this pass

`manager.ts` built the `'replace-all'` maintenance diff's new-key membership
set as `new BTree<BTreeKeyForPrimary, BTreeKeyForPrimary>(k => k, cmp)`. Its
entry *is* the key, and a single-column primary key is extracted as a bare
`SqlValue` (`createSingleColumnPrimaryKeyFunctions` returns `row[pkColIndex]`),
so a BLOB primary key hit the identical `Object.freeze` throw. Not conditional
and not dormant — reproduced from plain SQL on the memory backend:

```sql
create table bsrc (id integer primary key, b blob);
insert into bsrc values (1, x'6162'), (2, x'6164');
create materialized view bmv as select distinct b from bsrc;
insert into bsrc values (3, x'6169');   -- TypeError before the fix
```

(The `select distinct` body is maintained by the full-rebuild floor, which is
what routes through the `'replace-all'` keyed diff. A plain projection MV is
maintained by a bounded-delta arm and never reaches it, which is why the
implement stage's manual repro list missed the shape.)

Fixed inline — one line, same factory — because it is the same defect the
ticket exists for, not new work. Regression coverage added to
`51-materialized-views.sqllogic` (initial materialization, a source insert
adding one new BLOB key plus a duplicate that must not add a row, a delete that
drops the last occurrence of a value, and an explicit `refresh`).

### Major — test claimed a code path it did not reach, fixed in this pass

The implement ticket flagged as a "known gap" that the physical aggregate node
for its `GROUP BY` tests was not pinned down. Checked it: `GROUP BY grp` on an
unindexed column costs out to **`HashAggregate`**. So the `GROUP BY` case added
to `07-aggregates.sqllogic` was a duplicate of the one in
`92-hash-aggregate-edge-cases.sqllogic`, and the stream emitter's two per-group
DISTINCT-tree reset sites — two of the four changed lines in `aggregate.ts` —
had **no** coverage. Re-keyed that test's table to `primary key (grp, id)` so
the `GROUP BY` column leads the primary key; the index scan then supplies
grouped order and the plan is `StreamAggregate` (verified on the plan tree).
The 92-file test was confirmed to genuinely reach `HashAggregate`. Both
emitters are now actually exercised, and the "known gap" is closed rather than
carried forward.

### Minor — fixed in this pass

`createValueSet`'s doc comment described its callers as "IN membership,
DISTINCT aggregates", which is what let a fourth caller class go unnoticed.
Rewritten to state the *rule* — any BTree whose entry is a bare `SqlValue` must
be built here — and to name the primary-key case.

### Documentation

`docs/memory-table.md` had no record of this constraint, and its "Scan-path key
shape comes from arity" bullet (which already explains that a one-column key is
stored as a bare `SqlValue`) is exactly where a reader would expect it. Added a
sibling bullet stating the no-freeze rule, pointing at `createValueSet`, and
noting that `Row`/wrapper-entry trees are unaffected. No other doc described
the affected structures, so nothing else needed updating.

### Tripwires (recorded, not ticketed)

The `NOTE:` in `value-set.ts` from the implement stage is correct and kept: the
set holds references to caller-owned BLOB buffers, so a vtab that recycled one
`Uint8Array` across rows instead of handing out a fresh one would silently
change membership/DISTINCT answers. No vtab in this repo does that today.

### Filed as a separate ticket

`backlog/bug-group-concat-blob-renders-byte-numbers` — verified rather than
inherited as a rumor: `group_concat(b)` over BLOBs yields `"97,98,97,99,97,98"`
(decimal byte values, comma-joined) where SQLite yields `"ab,ac,ab"`, and the
byte separator is the same comma as the value separator, so the result cannot
be split back apart. Present on the non-DISTINCT form too, so it is a
value-to-text conversion issue independent of this ticket's set-tracking fix.

### Not found / explicitly clean

- **No other missed construction site.** All remaining `new BTree` calls
  (`distinct.ts`, `set-operation.ts`, `recursive-cte.ts`, `async-gather.ts`,
  `vtab/memory/index.ts`, `layer/base.ts`, `layer/transaction.ts`, and
  `manager.ts`'s `oldByKey` and point-probe trees) store a `Row` or a wrapper
  object, so their shallow freeze cannot touch a BLOB. Checked individually, not
  assumed from the implement ticket.
- **No error-handling or resource-cleanup findings.** The change adds no
  `catch`, no swallowed error, and no new lifetime — every set is a local whose
  lifetime is its enclosing execution.
- **No type-safety findings.** `T extends SqlValue | SqlValue[]` matches
  `BTreeKeyForPrimary` exactly; no `any`, no cast introduced.
- **No source-hygiene findings.** `value-set.ts` is one small factory with a
  doc comment; the emit-file edits are net line reductions and the three
  `import type` narrowings are correct.
- **No performance concern.** Removing freeze-on-insert removes work; nothing
  was added to the hot path. Not benchmarked, and not worth benchmarking for a
  strictly-less-work change.

## Validation

- `yarn lint` (workspace-wide; quereus = eslint + `tsc -p tsconfig.test.json
  --noEmit`) — clean.
- `yarn test` (full workspace) — all suites passing, 8065 in
  `packages/quereus`, 13 pre-existing pending. No failures, nothing skipped or
  disabled.
- Manual repro of every previously-crashing shape, including the newly-found
  materialized-view one, confirmed passing after the fix.
