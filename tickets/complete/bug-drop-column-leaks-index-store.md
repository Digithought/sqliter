description: Dropping a column from a persistent table used to leave stale index data behind, so later lookups through those indexes could miss rows or return the same row twice; the drop now cleans up and rewrites the affected index storage.
files:
  - packages/quereus-store/src/common/store-module-alter.ts        # alterDropColumn + `partitionIndexesByDropFate`
  - packages/quereus-store/src/common/store-module-index.ts        # tearDownIndexStore (shared helper); 3 call sites re-routed
  - packages/quereus-store/test/index-persistence.spec.ts          # 9 specs (6 from implement, 3 added in review)
  - packages/quereus/test/logic/41.10.1-alter-drop-column-unique-index.sqllogic  # §4 and §5
  - docs/module-authoring.md                                       # `dropColumn` per-arm mandate row
  - docs/store.md                                                  # "DDL that implicitly commits" — DROP COLUMN bullet
difficulty: medium
---

# DROP COLUMN now reshapes the physical index stores it implies

`ALTER TABLE … DROP COLUMN` on a `using store` table rewrote the schema correctly but did
nothing to the physical index stores the rewrite implied. Two defects, both fixed:

- **Removed index leaked its store.** `shiftSchemaIndicesForDrop` drops an index outright
  when the dropped column was its only column, or when it is UNIQUE and spans the column.
  Nothing tore down that index's `{schema}.{table}_idx_{name}` key-value store. Beyond never
  reclaiming space, a later `CREATE INDEX` reusing the name *adopted* the stale entries
  (`getIndexStore` returns the existing store, `buildIndexEntries` appends,
  `assertStoreNameFree` compares against registered schema objects and the dropped index is
  no longer one) — a range scan through the reused index then returned each row twice.
- **Narrowed index kept the old encoding.** A plain multi-column index that merely loses one
  column survives, but its key layout loses one value ahead of the primary-key suffix.
  Pre-existing entries kept the wide encoding while all later maintenance used the narrow
  one, so an indexed lookup silently missed pre-drop rows and `delete` orphaned their entries
  permanently.

The memory module was correct in both cases (its index structures live in the base layer and
are rebuilt from the post-drop schema); this was store-only.

## Final shape

**`StoreModuleIndex.tearDownIndexStore`** — the teardown (release the table's cached handle →
`provider.deleteIndexStore` when implemented, else `closeIndexStore`) was copied in three
places. It is now one `protected` helper, and `createIndex`'s build-failure rollback,
`dropIndex`, and `reconcileImplicitUniqueIndexStores` all route through it. Each caller keeps
its own surrounding posture — the DDL-commit flush, and `createIndex`'s
swallow-the-teardown-throw guard — since those legitimately differ.

**`StoreModuleAlter.alterDropColumn`** takes `db` (threaded from `alterTable`) and derives
both fixes from one diff of the pre-drop index list against the post-shift list, by
lowercased name — `partitionIndexesByDropFate`, a file-local free function:

| bucket | condition | action | placed |
| --- | --- | --- | --- |
| removed | name absent from the post-shift list | `tearDownIndexStore` | after `saveTableDDL` |
| narrowed | survives with a **different column count** | `rebuildSecondaryIndexes` over `{...updatedSchema, indexes: narrowedIndexes}` | after `migrateRows` |

A survivor whose column count is unchanged is left alone: its column *indices* shifted but it
encodes the same values in the same order, so its key bytes do not move.

Ordering rationale, both encoded as comments at the site: teardown after the catalog write
(matching `dropIndex` — the bundle must already omit the index so a failed physical delete
cannot resurrect it on reopen); rebuild after `migrateRows` (it reads the data store and
expects the new column layout); and no second `ddlCommitPendingOps()` before the teardown,
because the arm already flushed before `migrateRows` and both the migration and the rebuild
write straight to their stores outside the transaction coordinator.

Both diff inputs come from the engine-facing schemas, which carry no hidden `_uc_*` index (the
store's internal structure backing a plain UNIQUE constraint), so those stores stay owned by
`reconcileImplicitUniqueIndexStores`, which still runs after the arm returns.

`docs/module-authoring.md`'s `dropColumn` per-arm mandate row states the physical obligation;
`docs/store.md`'s implicit-commit list now names the index reshape alongside the row re-encode.

## Review findings

### Checked and sound — no change

- **The three fates are exhaustive and correctly assigned.** Re-derived every case against
  `shiftSchemaIndicesForDrop` (`packages/quereus/src/schema/table.ts:563`): an index is
  filtered out when UNIQUE and spanning the column, and again when no columns survive;
  otherwise it keeps its remaining columns in order. So *narrowed ⇒ non-UNIQUE*, which is what
  lets the rebuild run without the in-pass duplicate check. Same-count survivors really are
  byte-stable.
- **The premise behind skipping `withImplicitUniqueIndexes` in the rebuild holds.** Sibling
  arms (`alterPrimaryKeyChange`, the collation / retype arms) pass the materialized schema so
  each `_uc_*` gets its primary-key suffix re-encoded. This arm does not, and does not need
  to: the engine rejects dropping a primary-key member outright
  (`runDropColumn`, `packages/quereus/src/runtime/emit/alter-table.ts:946`), so no data-store
  key moves, and a surviving UNIQUE constraint keeps its whole column set, so its values and
  their order are unchanged.
- **The `_uc_*` interplay has no hole.** `findReusableIndexForUnique` reuses *any* full index
  — plain or UNIQUE — whose columns exactly equal the constraint's, so a constraint's physical
  structure can be a user index. Worked both directions: a reuse-index that is removed or
  narrowed necessarily spanned the dropped column, so the constraint it realized did too and
  is removed with it; and a constraint that *newly gains* a reusable index because a wider
  index narrowed onto its columns has its now-redundant `_uc_*` store torn down by
  `reconcileImplicitUniqueIndexStores` after the arm returns, from the rebuilt survivor. The
  implement handoff called this reasoning "argued, not asserted" — it is now argued from the
  reuse helper too, and the sqllogic §1–§3 cover the UNIQUE-removal half.
- **A partial UNIQUE over the dropped column cannot slip past the engine's guard.** The
  engine's partial-index rejection walks `tableSchema.indexes`, which for a store table
  carries no `_uc_*` — but a partial UNIQUE only ever arises from `create unique index … where
  …`, whose predicate lives on the index itself, so the guard sees it.
- **The isolation wrapper cannot diverge here.** A wrapper's staged rows are not in this
  module's store, so neither the migration nor the rebuild can see them; they are indexed at
  commit by write-time maintenance against the post-drop materialized schema — the narrow
  encoding. No test added, because there is nothing module-specific left to disagree about.
- **Teardown is not best-effort, and that stays.** A `deleteIndexStore` throw propagates out
  of the arm with the catalog write already durable. Identical to `dropIndex`; an unnoticed
  teardown failure is what produced this bug in the first place. Deliberate, not an oversight.

### Fixed in this pass — minor

- **Source hygiene.** The removed/narrowed diff was a 38-line comment block wrapped around a
  10-line loop inside an already-long arm. Extracted to `partitionIndexesByDropFate` at file
  scope, with the REMOVED / NARROWED explanation as its doc comment; the arm keeps only the
  two lines about why the *engine-facing* schemas are the right inputs.
- **Stale doc.** `docs/store.md`'s "DDL that implicitly commits" list described DROP COLUMN as
  re-encoding rows only, while the adjacent ALTER PRIMARY KEY bullet already names its index
  re-encode. It now names the narrowed-index key re-encode and the removed-index store
  deletion.
- **Test coverage**, three specs from the handoff's own "test floor, not ceiling" list
  (`packages/quereus-store/test/index-persistence.spec.ts`): all three fates in one statement
  (a collapsed index, a narrowed one, an untouched one — so a rebuild handed the wrong list
  shows up as either a missed re-encode or a clobbered bystander); a narrowed index whose
  surviving column is `DESC` over a `NOCASE` column, matched case-insensitively and ordered
  descending on pre-drop rows; and a DROP COLUMN inside a `begin`-opened transaction with a
  pending write against the doomed index, which is what would expose a stranded buffered op
  replaying into a closed store at commit. All three fail against the pre-fix behavior for the
  same reasons the implement specs do.

Untried combinations remain: two indexes narrowing onto the *same* column set, and a narrowed
index over a column whose key collation is not the table key collation (the store validates
that at `updateSchema`, so it is close to unreachable).

### Major — none filed

No finding warranted a new ticket. The one candidate, the non-atomic physical rewrite, is
pre-existing in shape (`alterPrimaryKeyChange` is identical: re-key → rebuild → persist) and a
real fix is one durable marker over the whole rewrite, not anything this arm can do locally.

### Tripwires

One, unchanged from implement: the `NOTE:` at the rebuild call site in
`store-module-alter.ts` recording that the arm's physical rewrite runs outside the coordinator
while the catalog still describes the old schema, so an IO error in that window leaves the two
diverged until the statement is re-run — and that the narrowed rebuild adds another failure
point inside it. Left where a reader editing that ordering will meet it.

## Validation

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn lint` | clean |
| `yarn typecheck` | clean |
| `yarn test` | green (quereus-store 1202 passing — 1199 + the 3 review specs; 0 failing anywhere) |
| `yarn test:store` (`node test-runner.mjs --store`) | 8030 passing, 22 pending, 0 failing |

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
