---
description: Teach the in-memory table storage to add a new column at a chosen position in the column list instead of always putting it last, so a wrapper that keeps a private bookkeeping column at the end can stay intact across an ADD COLUMN.
files:
  - packages/quereus/src/vtab/module.ts                     # SchemaChangeInfo addColumn variant (~line 541)
  - packages/quereus/src/vtab/memory/layer/manager.ts       # addColumn (~1756); dropColumn (~1862) is the index-shift template
  - packages/quereus/src/vtab/memory/layer/base.ts          # addColumnToBase / recreatePrimaryTreeWithNewColumn (~339-397)
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # prepareReshapedColumns (~466) / installReshapedColumns (~498) doc claims
  - packages/quereus/src/vtab/memory/module.ts              # alterTable dispatch (~934)
  - packages/quereus/src/vtab/memory/table.ts               # alterSchema dispatch (~345)
  - packages/quereus-store/src/common/store-module.ts       # alterAddColumn (~1600) — sibling backend, appends
difficulty: medium
---

# ADD COLUMN at a caller-chosen position (memory module)

## Why this exists

The transaction isolation layer stages each connection's uncommitted rows in a private
"overlay" table whose columns are the real table's columns **plus one extra flag column that
marks deleted rows**, and that flag column must be the **last** one — roughly twenty places in
`packages/quereus-isolation` strip it with `row.slice(0, flagIndex)` or append it with
`[...values, 0]`.

When a transaction runs `alter table … add column`, the isolation layer wants to apply that
column change to the overlay **in place** (rewriting the overlay from scratch is what loses the
transaction's staged rows — see `isolation-alter-forward-column-shape`). Applying it in place
today appends the new column *after* the flag column, which silently breaks that layout: probed
against the current code, the overlay's columns became `id, v, _tombstone, w` and every value
written to `w` afterwards was dropped on read.

The alternative — moving the flag column to the front of the overlay so appends stay correct —
was investigated and rejected: it turns ~44 currently-invisible "overlay column index equals base
column index" identities across the isolation package into explicit `+1` conversions, none of
which the type checker can police, and it invalidates 22 existing tests that hardcode the
trailing-flag layout. Letting the module insert at a position is the small change.

## Scope

**Module API only — no SQL surface.** `add column … first | after <col>` syntax is explicitly out
of scope (it drags in the parser, the AST, canonical-DDL emission and the declarative differ, and
raises a real question about whether the differ should reconcile column *order*). The new
capability is reachable only by an in-process module wrapper.

Add an optional field to the `addColumn` variant of `SchemaChangeInfo`
(`packages/quereus/src/vtab/module.ts:541`), e.g.:

```ts
| {
    type: 'addColumn';
    columnDef: ColumnDef;
    backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
    /**
     * Insert the new column at this index instead of appending. Undefined (the normal
     * case, and what SQL `alter table … add column` always produces) means append.
     * A module that cannot honour a position must reject it rather than silently append.
     */
    insertAtIndex?: number;
  }
```

`undefined` must keep today's behaviour byte-for-byte, so no existing caller or third-party
module changes.

## What has to shift

`MemoryTableManager.dropColumn` (manager.ts:1876-1925) already contains the whole index-shift
pattern for *removing* a slot. Inserting at `p` is the mirror image (`idx >= p ? idx + 1 : idx`),
and `addColumn` currently does none of it — it relies on `...this.tableSchema` (manager.ts:1805)
carrying every index-bearing field through unchanged, which is only correct for an append:

- `columns` — splice at `p` instead of `[...columns, new]` (manager.ts:1804)
- `primaryKeyDefinition[].index` — spread the existing def (`{...def, index}`) so `desc` /
  collation survive, exactly as dropColumn does at manager.ts:1877-1879
- `primaryKey` (the name array derived from the PK definition) — keep in sync
- `uniqueConstraints[].columns`
- `indexes[].columns[].index` — shift only; an insert can never empty an index, so dropColumn's
  prune/filter has no counterpart here
- `foreignKeys[].columns` / `.referencedColumns` — **note:** these are not shifted by `dropColumn`
  either (they are omitted from its rebuilt schema at manager.ts:1915-1925). That is a
  pre-existing gap that an insert makes reachable. Shift them here and record what you found
  about the drop side (a `NOTE:` at the site is enough if you do not fix it in this ticket).
- `columnIndexMap` is already rebuilt from the column list; `checkConstraints` and
  `implicitCoveringStructures` are name/AST-keyed and need nothing.

Derived structures rebuild themselves from the new schema and need no extra work: `BaseLayer`
primary-key functions (base.ts:142-144), memory index column specs
(`rebuildAllSecondaryIndexes`), `TransactionLayer.pkFunctions` (transaction.ts:511) and its
secondary indexes.

Two row-rewrite sites take the position:

- `BaseLayer.recreatePrimaryTreeWithNewColumn` (base.ts:393) — `newTree.insert([...oldRow, value])`
  becomes a splice. Nothing else in `addColumnToBase` is position-sensitive: primary-key functions
  are re-initialised before the rebuild, and the key extraction runs on the already-spliced row.
- The open-transaction-layer reshape callback (manager.ts:1822-1831) — `[...row, value]` becomes a
  splice. The reshape machinery itself
  (`prepareReshapeOnOpenLayers` / `TransactionLayer.prepareReshapedColumns`) is already
  position-agnostic: the caller supplies the row transform, and the install side rebuilds
  `pkFunctions` and every secondary index unconditionally.

Keep the splice **inside** the prepare callback: `installReshapeOnOpenLayers` is post-mutation and
has no undo, and the existing contract is that everything fallible runs before the first mutation.

Two doc comments become factually wrong and must be corrected, not left: `transaction.ts:462` and
`transaction.ts:498` both assert that ADD COLUMN "appends past every key index". The invariant they
actually depend on — primary-key *values* are unchanged, so tree ordering and the keys recorded in
the own-write log stay valid — still holds; only the "indices unchanged" clause fails, and
`pkFunctions` is already rebuilt for the DROP case.

## Store backend

`packages/quereus-store/src/common/store-module.ts:1600` (`alterAddColumn`) appends. The store is
never used as an isolation *overlay* today (the overlay module defaults to the memory module), so
it does not need the capability — but it must not silently ignore a position it was handed. Reject
`insertAtIndex` with `UNSUPPORTED` unless it equals the append position.

## Tripwire to record at the site, not as a ticket

Appending never invalidated an existing column index; inserting does. Anything that caches a
column index across the schema swap (planner caches, prepared statements, a wrapper's own schema
snapshot) is newly exposed, and the schema-change event emitted at manager.ts:1842-1848 carries no
position. Since the only caller today is the isolation overlay — which rebuilds its own view from
the post-change schema — this is fine now; leave a `NOTE:` at the emit site saying what would have
to change if the capability ever became SQL-reachable.

## TODO

- [ ] Add `insertAtIndex?: number` to the `addColumn` variant of `SchemaChangeInfo` with the doc
      wording above; thread it through `MemoryTableModule.alterTable` (module.ts:944) and
      `MemoryTable.alterSchema` (table.ts:350).
- [ ] Rewrite `MemoryTableManager.addColumn` to splice at the position and shift every index-bearing
      schema field, mirroring `dropColumn`'s block.
- [ ] Thread the position into `BaseLayer.addColumnToBase` / `recreatePrimaryTreeWithNewColumn` and
      splice the committed rows.
- [ ] Splice inside the open-layer reshape callback; keep it in the prepare (fallible, pre-mutation)
      phase.
- [ ] Fix the two stale "ADD appends past every key index" comments in `transaction.ts`.
- [ ] Shift `foreignKeys` indices; note (or fix) the same gap on the `dropColumn` side.
- [ ] Reject a non-append `insertAtIndex` in the store module with `UNSUPPORTED`.
- [ ] Tests in `packages/quereus/test/alter-column-open-transaction-layer.spec.ts` (the spec the
      open-layer reshape already lives in): insert at index 0, at a middle slot, and at the end;
      each with a multi-column primary key whose indices shift, a secondary index over a column
      after the insert point, a UNIQUE constraint over such a column, and pending rows in an open
      transaction (so both the base rewrite and the layer reshape are exercised). Assert
      `insertAtIndex: undefined` still appends.
- [ ] `yarn build && yarn test`, `yarn lint`.
