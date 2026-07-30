description: Dropping a column from a persistent table used to leave stale index data behind, so later lookups through those indexes could miss rows or return the same row twice; the drop now cleans up and rewrites the affected index storage.
files:
  - packages/quereus-store/src/common/store-module-alter.ts        # alterDropColumn — the diff, the rebuild, the teardown
  - packages/quereus-store/src/common/store-module-index.ts        # tearDownIndexStore (new shared helper); 3 call sites re-routed
  - packages/quereus-store/test/index-persistence.spec.ts          # 6 new specs (~line 404)
  - packages/quereus/test/logic/41.10.1-alter-drop-column-unique-index.sqllogic  # new §4 and §5
  - docs/module-authoring.md                                       # `dropColumn` per-arm mandate row (~line 877)
difficulty: medium
---

# DROP COLUMN now reshapes the physical index stores it implies

`ALTER TABLE … DROP COLUMN` on a `using store` table rewrote the schema correctly but
did nothing to the physical index stores the rewrite implied. Two defects, both fixed:

- **Removed index leaked its store.** `shiftSchemaIndicesForDrop` drops an index outright
  when the dropped column was its only column, or when it is UNIQUE and spans the column.
  Nothing tore down that index's `{schema}.{table}_idx_{name}` key-value store. Beyond
  never reclaiming space, a later `CREATE INDEX` reusing the name *adopted* the stale
  entries (`getIndexStore` returns the existing store, `buildIndexEntries` appends,
  `assertStoreNameFree` compares against registered schema objects and the dropped index
  is no longer one) — a range scan through the reused index then returned each row twice.
- **Narrowed index kept the old encoding.** A plain multi-column index that merely loses
  one column survives, but its key layout loses one value ahead of the primary-key suffix.
  Pre-existing entries kept the wide encoding while all later maintenance used the narrow
  one, so an indexed lookup silently missed pre-drop rows and `delete` orphaned their
  entries permanently.

The memory module was correct in both cases (its index structures live in the base layer
and are rebuilt from the post-drop schema); this was store-only.

## What changed

**`StoreModuleIndex.tearDownIndexStore`** — the six-line teardown (release the table's
cached handle → `provider.deleteIndexStore` when implemented, else `closeIndexStore`) was
copied in three places. It is now one `protected` helper, and `createIndex`'s
build-failure rollback, `dropIndex`, and `reconcileImplicitUniqueIndexStores` (formerly
`tearDownImplicitUniqueIndexStore`) all route through it. Each caller keeps its own
surrounding posture — the DDL-commit flush, and `createIndex`'s swallow-the-teardown-throw
guard — since those legitimately differ.

**`StoreModuleAlter.alterDropColumn`** now takes `db` (threaded from `alterTable`) and
derives both fixes from one diff of `oldSchema.indexes` against the post-shift
`shifted.indexes`, by lowercased name:

| bucket | condition | action | placed |
| --- | --- | --- | --- |
| removed | name absent from the post-shift list | `tearDownIndexStore` | after `saveTableDDL` |
| narrowed | survives with a **different column count** | `rebuildSecondaryIndexes` over `{...updatedSchema, indexes: narrowedIndexes}` | after `migrateRows` |

A survivor whose column count is unchanged is left alone: its column *indices* shifted but
it encodes the same values in the same order, so its key bytes do not move.

Ordering rationale, both encoded as comments at the site:

- Teardown after the catalog write, matching `dropIndex` — the bundle must already omit the
  index so a failed physical delete cannot resurrect it on reopen.
- No second `ddlCommitPendingOps()` before the teardown (unlike `dropIndex`, which flushes
  immediately before its own): the arm already flushed before `migrateRows`, and both
  `migrateRows` and `rebuildSecondaryIndexes` write straight to their stores outside the
  transaction coordinator, so no buffered operations accumulate against the doomed index
  handles in between.
- The rebuild runs after `migrateRows` because it reads the data store and expects the new
  column layout.

Both diff inputs come from the engine-facing schemas, which carry no hidden `_uc_*` index
(the store's internal structure backing a plain UNIQUE constraint), so those stores stay
owned by `reconcileImplicitUniqueIndexStores`, which still runs after the arm returns. A
`_uc_*` can never land in the narrowed bucket anyway: a UNIQUE constraint spanning the
dropped column is removed outright, and a survivor keeps its whole column set.

`docs/module-authoring.md`'s `dropColumn` per-arm mandate row now states the physical
obligation — diff the index list, tear down what was removed, re-encode what was narrowed,
leave same-count survivors alone — with the ordering constraints.

## How to exercise it

Store-module unit specs (`packages/quereus-store/test/index-persistence.spec.ts`, all
asserting on the observable provider's `stores` map and `indexStoreSize`):

- single-column index collapse → `main.t_idx_ix_b` absent from the store map
- UNIQUE index spanning the dropped column → its store absent
- same-named `CREATE INDEX` after the drop → entry count equals row count, and
  `where c > 0` returns each row exactly once
- narrowed multi-column index over rows inserted **before** the drop → plan is an index
  seek, `where c = 100` finds the row, `delete from t` drains the store to 0
- narrowed **partial** index → only in-scope rows re-encoded; write-time maintenance agrees
  in both scope directions
- close → reopen after a drop → index absent from `index_info` and its store still absent

Module-agnostic SQL logic (`41.10.1-alter-drop-column-unique-index.sqllogic`, new §4 and
§5) covering the same two answers — short and doubled — under both `yarn test` (memory) and
`yarn test:store` (LevelDB). The pre-existing §3 passed throughout because it inserts only
*after* the drop.

Manual smoke, if you want to see it by hand:

```sql
create table t (id integer primary key, b integer, c integer) using store;
create index ix_bc on t (b, c);
insert into t values (1, 10, 100), (2, 20, 200);
alter table t drop column b;
select id from t where c = 100;   -- was [] (row missed); now [{"id":1}]
```

## Validation run

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` | all green (8039 + 1199 + others passing, 0 failing) |
| `yarn workspace @quereus/store test` | 1199 passing |
| `yarn test:store` | 8030 passing, 22 pending, 0 failing |
| `yarn typecheck` | clean |
| `yarn lint` | clean |

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

Each new spec was confirmed to have teeth: with the rebuild and the teardown temporarily
short-circuited (and `packages/quereus-store` rebuilt, since the SQL-logic runner loads
`@quereus/store` from `dist`, not source), all six unit specs fail, sqllogic §4 fails with
`Row count mismatch. Expected 1, got 0`, and §5 with `Expected 2, got 4`. The short-circuits
were removed and the tree is clean of them.

## Known gaps — reviewer, start here

- **Not atomic on IO failure, and this widens an existing window.** `migrateRows` re-encodes
  the rows outside the coordinator while the catalog still describes the old schema, so an
  IO error anywhere between there and `saveTableDDL` leaves the two diverged until the
  statement is re-run. The narrowed rebuild adds another failure point inside that same
  window. Pre-existing in shape — `alterPrimaryKeyChange` is identical (rekey → rebuild →
  persist) — and parked as a `NOTE:` at the rebuild call site rather than reordered, since
  a real fix is one durable marker over the whole physical rewrite, not a shuffle. Not
  filed as a ticket; judge whether it deserves one.
- **The isolation wrapper's rows are not consulted by this arm.** The rebuild reads *this*
  module's committed rows after the DDL flush, never a wrapper-supplied
  `EffectiveRowSource`. That matches `alterPrimaryKeyChange` and the arm never took `rows`
  to begin with, but no test exercises `DROP COLUMN` + a narrowed index under
  `quereus-isolation`. If you think that combination can diverge, it is untested.
- **Teardown is not best-effort.** A `deleteIndexStore` throw propagates out of the arm
  after the catalog write has already landed, so the statement fails with the schema change
  durable and one orphan store left. `dropIndex` behaves identically, and `createIndex`'s
  rollback is the only guarded call site. Deliberate (an unnoticed teardown failure is what
  produced this bug), but it is an inconsistency worth a decision.
- **Removed-index teardown assumes one store per index name.** The diff is by lowercased
  name against the pre-drop list. Two indexes differing only in case cannot coexist, so this
  should be safe, but it was reasoned about rather than tested.
- **The `_uc_*` reasoning is argued, not asserted.** The claim that an implicit UNIQUE index
  can never be narrowed rests on `shiftSchemaIndicesForDrop` removing any UNIQUE constraint
  that spans the dropped column. That is read off the helper's source, not pinned by a test
  in this change.
- **Test floor, not ceiling.** The new specs cover the shapes the original investigation
  reproduced. Untried combinations include: dropping a column from a table with several
  narrowed indexes at once; a narrowed index over a NOCASE/collated column; a drop inside an
  open transaction with pending writes against the doomed index; and a `DESC` index column
  surviving a narrow.
