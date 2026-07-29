---
description: Changing a table's primary key part-way through a transaction used to throw away everything that transaction had written to the table while the commit still reported success; the in-memory table now re-keys itself in place, so those writes (and their change notifications) survive.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # NEW alterPrimaryKey (+ buildRekeyedPrimaryKeySchema); generalized pre-pass messages
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # NEW prepareRekeyedPrimaryKeyColumns / installRekeyedPrimaryKeyColumns + PreparedPrimaryKeyRekey
  - packages/quereus/src/vtab/memory/module.ts               # alterPrimaryKey arm now delegates to the manager
  - packages/quereus/src/vtab/memory/table.ts                # alterSchema arm delegates; validate-only now allowed for alterPrimaryKey
  - packages/quereus/src/runtime/emit/alter-table.ts         # rebuildMemoryTable DELETED; rebuild fallback is shadow-SQL only
  - packages/quereus/test/alter-primary-key-in-transaction.spec.ts  # NEW regression matrix (19 tests, two producer legs)
  - packages/quereus/test/alter-table-events.spec.ts         # deferral NOTE dropped; ALTER PK arms now assert row survival too
  - packages/quereus/test/alter-table-conformance.spec.ts    # label/comment updated (native re-key)
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts     # 3 BUSY-message regexes follow the generalized wording
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic  # expected-error text follows the wording
  - packages/quereus-isolation/src/isolation-module.ts       # comment-only: refusal rationale no longer cites memory's rejection
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # UNSUPPORTED-propagation test now uses a refusing stub; NEW end-to-end native test
  - docs/memory-table.md                                     # in-place re-key described (feature bullet + layer-machinery section)
  - docs/sql-ddl.md, docs/module-authoring.md, docs/design-isolation-layer.md
difficulty: hard
---

# What was done

The in-place re-key (the ticket's primary path), all four phases. The engine's
memory-table rebuild fallback for `ALTER PRIMARY KEY` — which copied committed
rows only and discarded the open transaction's pending layer, deleting its
writes while the commit reported success — is gone; the memory module now
handles the change natively.

## The mechanism

`MemoryTableManager.alterPrimaryKey(newPkColumns, rows?, validateOnly?)`
follows `alterColumn`'s ordering contract exactly:

1. latch → `ensureSchemaChangeSafety()`;
2. resolve + reject a bad definition (`buildRekeyedPrimaryKeySchema`: bounds,
   duplicates, NOT NULL members; each member carries its column's collation, as
   `create table` records it);
3. `validateRekeyedPrimaryKey(newSchema, rows)` — the SAME two-question pre-pass
   the `set collate` PK re-key runs (effective-row collision → sited
   `CONSTRAINT`; collision restorable only by rollback → retryable `BUSY`);
4. `validateOnly` returns here (dry run — `MemoryTable.alterSchema` now accepts
   validate-only for `alterPrimaryKey` too);
5. prepare phase over every open layer, BEFORE any mutation;
6. base rebuild (secondary indexes, then strict primary tree, undo recorded);
7. manager schema swap; install phase oldest-first; schema-change event.

The open-layer adoption is a two-phase prepare/install pair
(`TransactionLayer.prepareRekeyedPrimaryKeyColumns` /
`installRekeyedPrimaryKeyColumns`), modeled on the ADD/DROP COLUMN reshape
pair, because two things must be re-derived from row images only the intact
pre-rebuild chain can resolve:

- **Deletions** — an own-write log records a delete by key only; the new key
  comes from the parent's row image at the old key. The replay carries the old
  key alongside as an identity check (the analogue of `rekeyPrimaryKey`'s
  old-comparator check).
- **Shadowed images** — an upsert that replaced a parent row at the same OLD
  key can land at a DIFFERENT new key (a pending `update t set b = 7` before
  `alter primary key (a, b)`), so the parent's pre-update image must also be
  deleted or the row duplicates. This case was found during implementation,
  not named in the ticket; disabling the guard makes 3 of the new tests fail.
- **The pending change-event log** — recorded keys are re-derived from each
  event's own image (update tie-break mirrors the engine emitter's
  `rekeyBatchedDataEvents`), so the `new MemoryTableModule(emitter)` path
  delivers events again, at the new arity. A collation-only re-key still skips
  this (values unchanged), preserving the pinned SET COLLATE behavior.

## Deliberate behavior notes (review against these, not against silence)

- **Wording change**: the shared pre-pass messages were generalized —
  `"…collides under the new key definition"` (CONSTRAINT) and `"Cannot re-key
  the primary key of table …"` (BUSY) — since they now serve both `set collate`
  and `alter primary key`. Three spec regexes and one sqllogic expected-error
  updated to match. The isolation layer's own copy of the CONSTRAINT message
  (alter-migration.ts ~544, collate-only path) intentionally kept its wording;
  nothing matches on message text at runtime.
- **Schema-change event shape changed** on this path: previously the rebuild
  emitted `create table` events for a shadow table; now one
  `{type:'alter', objectType:'table'}` event is emitted, matching the store's
  native arm. No test pinned the old shape.
- **Secondary indexes now survive** `alter primary key` on memory tables (the
  deleted rebuild silently dropped them all — it built the new table with
  `indexes: []`). Strictly better; covered by a new test.
- **Rollback still does not undo the DDL** — the settled `'non-transactional'`
  tier. Out of scope per the ticket; `backlog/bug-rolled-back-rows-violate-surviving-ddl`
  owns the family.
- **Per-column `primaryKey`/`pkOrder` flags stay stale** after the swap — same
  as the store's native arm and the deleted rebuild. This turned out to hide a
  real pre-existing defect (see below).

## Isolation layer

Unchanged in behavior; its `alterPrimaryKey` three-way handling still refuses
an issuer with staged rows (that refusal is about the overlay's tombstone
representation, and its UNSUPPORTED still gets swallowed into the shadow
rebuild — that is `fix/bug-alter-primary-key-shadow-rebuild-destroys-rows`,
not this ticket). With a CLEAN issuer overlay the wrapper now forwards to
memory's native re-key end-to-end — a new isolation test pins that; the test
that asserted "memory throws UNSUPPORTED" now uses a refusing stub module so
the wrapper's don't-swallow contract stays pinned independent of memory's
capability.

# How to validate

- `yarn workspace @quereus/quereus run test` — 7899 passing, 13 pending
  (pre-existing pending), 0 failing.
- `cd packages/quereus-isolation && yarn test` — 349 passing.
- Root `yarn test`, `yarn build`, `yarn lint`, `yarn typecheck` — all clean.
- The dedicated matrix: `packages/quereus/test/alter-primary-key-in-transaction.spec.ts`
  (pending insert/update/delete, released savepoint, clean-transaction and
  autocommit controls, post-ALTER writes, CONSTRAINT rejection leaves the
  transaction intact, key-moving updates incl. a savepoint stack, secondary
  index continuity; module-emitter leg asserts delivered events and shapes).
- NOT run: `yarn test:store` (memory-only change; the store's native arm is
  untouched, and the one message-pinning sqllogic is in MEMORY_ONLY_FILES).

# Known gaps / where to push

- **Rebase-after-sibling-commit across a re-key** (`commitTransaction` case B)
  is not directly tested. The rewritten own-write log carries new-arity keys,
  and `rebaseLayerOntoHead` replays keys against the new head, so it should
  compose — but constructing the multi-connection interleaving was out of
  budget. A reviewer wanting more confidence could adapt the sibling-commit
  tests in `memory-collation-per-database.spec.ts`-style harnesses.
- **`alter primary key ()` (empty key) inside a transaction with pending
  rows** is untested (arity-0 singleton semantics: any second row collides —
  the pre-pass should reject; only the autocommit/empty-table path is covered
  by `test/logic/41.1-alter-pk.sqllogic`).
- The prepare/install pair is a third variant of the "collapse own-writes to
  net effect" loop (alongside `rekeyPrimaryKey` and `prepareReshapedColumns`).
  Deliberately not unified — the collate path's single-pass shape and its doc
  contract are pinned by delicate tests — but a reviewer may judge the
  duplication worth a follow-up debt ticket.

# New tickets filed from this work

- `fix/bug-alter-primary-key-generated-ddl-keeps-old-key` — pre-existing on
  every producer, discovered while checking the stale per-column flags:
  generated DDL after a single-column PK move still declares the OLD column as
  the key (store reopen silently reverts the key; sync replicates it wrong).
  Reproduced on this branch; details and candidate tests in the ticket.
