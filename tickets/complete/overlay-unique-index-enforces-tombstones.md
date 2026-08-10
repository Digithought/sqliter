---
description: Deleting a row and inserting a different one in the same transaction could be wrongly rejected as a duplicate; fixed, tested, reviewed.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # createOverlaySchema / liveRowPredicate / andPredicate (the fix)
  - packages/quereus-isolation/src/isolated-table.ts           # mergedSecondaryIndexQuery; insertTombstoneForPK; findMergedUniqueConflict
  - packages/quereus-isolation/test/isolation-layer.spec.ts    # describe: "overlay indexes and UNIQUE constraints scoped to live rows" (12 tests)
  - docs/design-isolation-layer.md                             # "Overlay Table Schema" + "Read Operations"
---

# Scope overlay indexes and UNIQUE constraints to live rows

## What was wrong

The isolation layer stages a connection's uncommitted writes in a private per-connection
*overlay* table. A deleted row is staged as a **tombstone**: the row's primary key, `NULL` in
every other column, plus a flag column marking it deleted.

`IsolationModule.createOverlaySchema` copied the underlying table's secondary indexes and
`UNIQUE` constraints onto the overlay wholesale, so the overlay enforced uniqueness across
tombstones too. Invisible for a `UNIQUE` structure over an ordinary column (a tombstone's
value there is `NULL`, and SQL treats `NULL`s as distinct) but broken the moment every column
of the `UNIQUE` structure sat inside the primary key — tombstones carry real PK values, so
two tombstones (or a tombstone and a live row) collided.

Two reproductions, both fixed:

```sql
create table t (a integer, b integer, primary key (a, b));
create unique index t_a_ux on t (a);
insert into t values (1, 1);
begin;
  delete from t where a = 1 and b = 1;
  insert into t values (1, 2);   -- was: "UNIQUE constraint failed: _overlay_t_2 (a)"

create table t (a integer, b integer, primary key (a, b));
insert into t values (1, 1);
insert into t values (1, 2);
begin;
  delete from t;
  create unique index t_a_ux on t (a);   -- was: INTERNAL
```

## The fix

`createOverlaySchema` narrows each copied index and each copied `UNIQUE` constraint into a
partial structure over live rows only, AND-ing `<tombstone column> = 0` onto whatever partial
predicate it already carried:

```ts
indexes: baseSchema.indexes?.map(idx => ({ ...idx, predicate: andPredicate(idx.predicate, liveOnly) })),
uniqueConstraints: baseSchema.uniqueConstraints?.map(uc => ({ ...uc, predicate: andPredicate(uc.predicate, liveOnly) })),
```

Both arrays are narrowed because the memory module enforces uniqueness from
`TableSchema.uniqueConstraints`, and `CREATE UNIQUE INDEX` synthesizes a matching
`derivedFromIndex` unique constraint alongside the index; a table-level `UNIQUE (…)` declared
at `CREATE TABLE` time produces a constraint with no index of its own, and the manager
auto-builds a covering index for it that inherits the constraint's (now narrowed) predicate.
The overlay's **primary-key** uniqueness is deliberately left uncovered — it must keep judging
tombstones so a re-insert at a tombstoned PK is detected and converted into an overwrite
rather than a fresh insert (`IsolatedTable.update`'s tombstone-revival branch).

`docs/design-isolation-layer.md` § "Overlay Table Schema" documents the narrowing and why
primary-key uniqueness is excluded.

## Review findings

### Checked (traced end-to-end, not just skimmed)

- **The narrowed predicate actually reaches enforcement.** `compilePredicate`
  (`packages/quereus/src/vtab/memory/utils/predicate.ts`) supports exactly the AST shapes the
  fix emits (`binary` `=` / `AND`, `column`, `literal`), and case-folds operators, so the
  hand-built `{type:'binary', operator:'AND'}` node compiles. `MemoryIndex` compiles it against
  the overlay's full column list, which includes the tombstone column.
- **Insert-side and candidate-side both honor it.** `checkSingleUniqueConstraint` (memory
  `layer/manager.ts`) skips a new row whose partial predicate is not TRUE — so a tombstone
  write is never judged — and `checkUniqueViaIndex` skips a stored candidate that fails
  `index.rowMatchesPredicate`, so a tombstone is never a conflict *target* either.
- **PK uniqueness is a separate code path** (`checkMergedPKConflict` / the overlay's primary
  index), untouched by the `uniqueConstraints` narrowing, so tombstone revival still works.
  Pinned by the existing test #8 and re-verified by reading `writeRelocatedRow` /
  `insertTombstoneForPK`.
- **`mergedSecondaryIndexQuery` is still correct.** Its step 1 (which PKs the overlay
  modified) uses a full **primary-key** scan, so tombstones are still discovered and still
  shadow the underlying rows. Its step 2 (overlay's live rows, in index order) scans the
  now-partial index by name via `scan-plan.ts`, which resolves indexes by name and does not
  filter partial ones, so the index is still used and rows still arrive in index order. The
  `row[tombstoneIndex] !== 1` filter there is now redundant but is correct defense-in-depth for
  a host-injected overlay module — left in place.
- **`IsolatedTable`'s own merged-view UNIQUE detection is unaffected.** `compileFor(uc)`
  compiles against `this.tableSchema.columns` (the user-facing schema, no tombstone column)
  from the *underlying* schema's un-narrowed constraints. `createOverlaySchema` returns a fresh
  object and its three call sites only feed `overlayModule.create`, so the narrowing cannot
  leak into the user-facing schema. Confirmed by grepping every call site.
- **Real production overlay is the memory module.** `packages/quereus-store/src/common/isolated-store.ts`
  injects `MemoryTableModule` as the overlay, so the honors-partial-predicates requirement is
  met on the store path too.
- **Docs**: read `docs/design-isolation-layer.md` and `packages/quereus-isolation/README.md`
  against the new reality.

### Found and fixed in this pass (minor)

- **Test gap — the live-row → tombstone transition was never exercised.** Every new test
  tombstoned a row that existed only in the *underlying* table. A row inserted **and** deleted
  inside the same transaction is a live overlay row rewritten into a tombstone, which requires
  the narrowed index to *drop* the row's entry as it leaves the predicate's scope. If it
  didn't, the UNIQUE value would stay claimed for the rest of the transaction. Added three
  tests; all pass (the behavior was already correct, but it was untested):
  - a live overlay row deleted in the same transaction releases its UNIQUE value;
  - a tombstone and a live row simultaneously carrying the same PK-covered UNIQUE column
    value, while a genuine live/live duplicate is still rejected with `StatusCode.CONSTRAINT`;
  - an update that vacates a UNIQUE value inside a transaction frees it for a new row.
- **Doc drift.** `docs/design-isolation-layer.md` § "Read Operations" said index scans consult
  the overlay's secondary index "to find additional/removed keys". Removed keys (tombstones)
  are no longer in that index at all — they are found via the overlay's primary-key scan.
  Rewritten to describe what `mergedSecondaryIndexQuery` actually does.
- **Validation gap closed.** The implement pass did not run `yarn test:store`. Run here:
  6797 passing, zero failures.

### Major findings (new tickets): none

Nothing in the diff warranted a new ticket. The narrowing is minimal, its blast radius is one
function whose output feeds only `overlayModule.create`, and the two enforcement paths it
touches were verified against the memory module's source.

### Tripwires (recorded, not ticketed)

- **A host-injected `config.overlay` module that ignores `IndexSchema.predicate` /
  `UniqueConstraintSchema.predicate` would re-enforce uniqueness over tombstones.** Parked as
  a `NOTE:` on `IsolationModule.liveRowPredicate`'s doc comment (already written by the
  implementer). Conditional: the only overlay in the tree today is `MemoryTableModule`, which
  honors both.
- **Pre-existing, untouched by this change:** `IsolationModule.effectiveRowsFor`'s doc comment
  already flags that `alter column … set collate` re-materializes the overlay's PK map once per
  UNIQUE constraint covering the altered column. Still accurate; still conditional; no action.

### Noticed, out of scope

`IsolatedTable.writeRelocatedRow`'s doc comment calls the overlay "itself a StoreTable"; the
overlay is a `MemoryTable`. Stale wording predating this ticket, in a line the diff never
touched — left alone rather than widening the diff.

## Validation

| command | result |
| --- | --- |
| `yarn workspace @quereus/isolation run typecheck` | clean |
| `yarn workspace @quereus/isolation run test` | 203 passing (200 + 3 added this pass) |
| `yarn workspace @quereus/quereus run lint` | clean (eslint + `tsc -p tsconfig.test.json --noEmit`) |
| `yarn test` (all workspaces) | quereus 6802, isolation 203, store 901, sync 450, sync-client 65, sync-coordinator 31, plugin-loader 30/17/28, UI 86/34/128 — all green, zero failures |
| `yarn test:store` (store-backed logic tests) | 6797 passing, zero failures |
