---
description: Inside a transaction, a query that matches the primary key against a list of values can return a row twice — once as you just changed it and once in its old form — or bring back a row you deleted, when the list is not written in ascending key order. Root cause found and a fix validated; this ticket lands it with tests and docs.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/interface.ts, packages/quereus/src/vtab/memory/index.ts, packages/quereus-store/src/common/store-table-scan.ts, packages/quereus-isolation/src/merge-iterator.ts, packages/quereus-isolation/test/key-set-seek-merge.spec.ts, docs/module-authoring.md, docs/design-isolation-layer.md, docs/memory-table.md
difficulty: easy
---

## Reproduced

Confirmed against the in-memory backend under the isolation layer. Setup: `create table t
(id integer primary key, v text)` using an isolated module over `MemoryTableModule`, rows
`(1,'a'), (2,'b'), (3,'c')`.

```
begin; update t set v = 'new' where id = 1;
select id, v from t where id in (3, 1, 2)
  actual   → [{1,'new'}, {3,'c'}, {1,'a'}, {2,'b'}]   ← id 1 twice, second one stale
  expected → [{1,'new'}, {2,'b'}, {3,'c'}]

select id, v from t where id in (1, 2, 3)              ← already ascending
  actual = expected                                    ← which is why this went unnoticed
```

```
begin; delete from t where id = 1;
select id, v from t where id in (3, 1, 2)
  actual   → [{3,'c'}, {1,'a'}, {2,'b'}]               ← the deleted row is back
  expected → [{2,'b'}, {3,'c'}]
```

## Root cause

Two streams, one order assumption:

- `mergeStreams` (`packages/quereus-isolation/src/merge-iterator.ts`) requires both the
  staged-row (overlay) stream and the stored-row (underlying) stream to arrive in the same
  key order. Its doc comment states this. `IsolatedTable.resolveScanIndex` picks primary-key
  order for any access path whose index has `role: 'primary'` — **regardless of the plan
  kind** — so a `multiSeek` on the primary key is merged as if it were key-ordered.
- The in-memory backend visits multi-seek keys in the order the planner stamped them, which
  is the order the values appear in the SQL text. `scanLayerResolved`'s multi-seek branch
  (`packages/quereus/src/vtab/memory/layer/scan-layer.ts:61`) loops `plan.equalityKeys`
  as-is.

So `in (3, 1, 2)` makes the stored stream emit 3, 1, 2 while the staged stream emits 1. The
merge sees staged-1 < stored-3, emits staged-1, advances the staged stream to done — and then
passes stored-1 straight through as an unshadowed row.

**The memory backend is the outlier here, not the merge.** The persistent store backend
already sorts its multi-seek windows into index-key order and documents this exact reason
(`packages/quereus-store/src/common/store-table-scan.ts:586-609`: *"Window order is not
cosmetic … the isolation overlay merges an index scan with its pending rows by (indexKey, PK)
— an out-of-order underlying stream misplaces overlay rows in the output"*), on both its
secondary-index arm (`:649`) and its primary-key arm (`scanMultiSeekPrimary`, `:715`). The
same file that holds the memory bug already treats emission order as an observable contract
for the *other* order-sensitive case: `scan-layer.ts:214-224` sorts each secondary-index
entry's primary keys precisely because the isolation merge depends on it.

A second, quieter symptom of the same root cause: the memory module advertises
`providesOrdering: <PK ascending>` for any `_primary_` plan when the query carries no
`ORDER BY` (`packages/quereus/src/vtab/memory/module.ts:362-378`). For an unsorted multi-seek
that advertisement is simply false. Nothing was found to *act* on the false claim today
(`adjustPlanForOrdering`'s `usesMultiInOnOrderedCol` check refuses to absorb a `SortNode` over
a multi-value IN, and an `order by` on the repro above is correctly *not* elided), but the fix
below makes the claim true rather than leaving it merely unexploited.

## Fix

Make the in-memory multi-seek visit its seek keys in the scanned structure's own key order,
matching what the store backend already does. In `scanLayerResolved`'s multi-seek branch, sort
`plan.equalityKeys` before the loop, under:

- `primaryKeyComparator` (already returned by
  `layer.getPkExtractorsAndComparators(seekSchema)`, alongside the extractor and encoder the
  branch already destructures) when `plan.indexName === 'primary'`;
- `layer.getSecondaryIndex(plan.indexName).compareKeys` (`MemoryIndex.compareKeys`,
  `packages/quereus/src/vtab/memory/index.ts:30`) otherwise.

Both comparators are the ones the corresponding BTree is keyed by, so they already fold each
column's logical type, declared collation, and `DESC` direction — the same construction
`plan-filter.ts` mirrors for bound checks. Negate the comparison when `plan.descending` (a
reverse walk emits the whole structure backwards, so the seek keys must descend with it).

`Layer.getSecondaryIndex` is declared optional in `layer/interface.ts:67`, though both
implementations (`base.ts:322`, `transaction.ts:900`) provide it. Follow the precedent set a
few lines below at `scan-layer.ts:220-224`: keep the optional call and note the fallback, or
tighten the interface — either is fine, but do not silently leave keys unsorted, because
unsorted is the bug.

The existing dedup-by-encoded-primary-key in that branch is order-independent and stays
correct as-is.

### Rejected alternatives (do not re-litigate)

- **Sort the literal list in the planner** (`rule-select-access-path.ts`, the `hasMultiValueIn`
  arms). Cannot cover the dynamic/mixed-binding forms — a parameter or an OR-collapse
  `valueExpr` has no plan-time value — so the backend would still need the runtime sort.
- **Make the isolation merge tolerate an unordered stream for `multiSeek`** (route it through
  the primary-key-exclusion strategy `mergedSecondaryIndexQuery` uses). Leaves the store
  backend's already-correct sort as dead weight, leaves the false ordering advertisement in
  place, and costs a full overlay scan per read. The contract that an index access path emits
  in index-key order is already written down and already honored by one of the two backends;
  the cheaper fix is to make the second backend honor it too.

### Validation already done

The fix above was prototyped and `yarn test` ran green: **8065 passing** in
`packages/quereus`, zero failures across every workspace. No test asserts IN-list emission
order, so there is no churn to absorb. The prototype was reverted — the tree is clean and the
work below is still to do.

## Regression tests

The isolation package's mocha run resolves `@quereus/quereus` to its built `dist`, not `src`.
Run `yarn build` before `yarn workspace @quereus/isolation test`, or the engine-side change is
not under test at all (this trap is already called out at
`packages/quereus-isolation/test/key-set-seek-merge.spec.ts:273-275`).

Isolation-side, over a literal out-of-order list — the shapes the ticket was filed on:

- staged `update` + `where pk in (3, 1, 2)`: the row appears once, in its new form;
- staged `delete` + the same list: the row does not come back;
- a `primary key (pk desc)` table, so the sort must descend;
- a composite primary key (cross-product multi-seek, `seekWidth > 1`);
- a secondary-index multi-seek with staged rows — currently tolerant of disorder, so this one
  pins that the sort does not *break* the path it was not needed on.

Engine-side, pin the contract at its source rather than only through the isolation layer: a
test in `packages/quereus/test/` asserting that a plain `MemoryTableModule` serves
`where pk in (3, 1, 2)` in ascending key order (and descending for a `DESC` primary key).
Without this, the only thing holding the contract is an isolation test in another package.

## Docs to update

- `docs/module-authoring.md` — state the contract a module owes: a `multiSeek` access path
  must emit in the scanned index's key order, not seek-argument order. Cite that the isolation
  merge depends on it and that both shipped backends honor it.
- `docs/design-isolation-layer.md` — the merge-order table under *"Which index is being
  scanned"* (§ Key Ordering, ~line 559) says `index`/`role: 'primary'` merges by primary key
  "regardless of the index's name". Add that this holds regardless of the *plan kind* too, and
  that a `multiSeek` therefore owes index-key emission order.
- `docs/memory-table.md` — note the multi-seek sort alongside whatever it already says about
  scan order, if it covers that ground.

## Stale references to retire

- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts` describes this bug as live and
  deliberately unpinned in two places (lines 18-21 and 255-275), and names it as
  `backlog/bug-isolation-multiseek-merge-order` — it has since moved through `fix/` to here.
  Once the fix lands, rewrite both comments to say the literal-list form is covered, and point
  at the new tests.
- The same file explains that the key-set semi join path is immune because
  `emitKeySetSemiJoin` sorts its seek keys (`packages/quereus/src/runtime/emit/key-set-semi-join.ts:100-105`).
  That sort becomes redundant for the memory backend once this lands, but it is **not** dead —
  keep it. Add a `NOTE:` at that site recording that the backends now sort too, so a future
  reader does not mistake the redundancy for a bug in either direction.
- `tickets/backlog/feat-store-pk-in-list-multiseek` is unblocked by this fix (see the *Scope
  notes* in the original fix ticket). Do not touch that ticket; just do not leave a comment
  claiming it is still blocked.

## TODO

- [ ] Sort `plan.equalityKeys` in `scanLayerResolved`'s multi-seek branch under the scanned
      structure's key comparator (primary: `primaryKeyComparator`; secondary:
      `MemoryIndex.compareKeys`), negated when `plan.descending`.
- [ ] Decide and document the `Layer.getSecondaryIndex` optionality handling — mirror the
      existing fallback at `scan-layer.ts:220-224` or tighten the interface.
- [ ] Add the isolation regression tests (staged update, staged delete, DESC primary key,
      composite primary key, secondary index) against a deliberately unsorted literal list.
- [ ] Add the engine-side test pinning ascending (and DESC) multi-seek emission order for a
      bare `MemoryTableModule`.
- [ ] Update `docs/module-authoring.md`, `docs/design-isolation-layer.md`, and
      `docs/memory-table.md` per above.
- [ ] Retire the stale comments in `key-set-seek-merge.spec.ts`; add the `NOTE:` in
      `key-set-semi-join.ts`.
- [ ] `yarn build` then `yarn test` (and `yarn lint`) green.
