---
description: Changing a table's primary key part-way through a transaction throws away everything that transaction had written to the table, and the commit still reports success — the writes are simply gone afterwards.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn (~2275) is the template; scanAllRows (~1563), insertRow (~1575), effectiveDdlRows (~3199), ensureSchemaChangeSafety (~3029)
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # rekeyPrimaryKey (~298), installNetOwnWrites, OwnWrite (~36), adoptSchema (~225)
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict (~210), rebuildPrimaryTreeFromRows
  - packages/quereus/src/vtab/memory/layer/connection.ts     # hasOpenWork (~274)
  - packages/quereus/src/vtab/memory/module.ts               # alterTable's alterPrimaryKey arm (~973) — currently throws UNSUPPORTED
  - packages/quereus/src/runtime/emit/alter-table.ts         # runAlterPrimaryKey (~1421), rebuildTableWithNewShape (~1530), rebuildMemoryTable (~1563)
  - packages/quereus/test/alter-table-events.spec.ts         # the ALTER PRIMARY KEY arms + the NOTE at ~368 that defers to this ticket
  - packages/quereus/test/alter-table-conformance.spec.ts    # the `alter primary key` arm (~183)
  - docs/memory-table.md                                     # line 95 claims "fails cleanly without data loss" — false in a transaction
  - docs/sql-ddl.md                                          # ~624, the rebuild-fallback paragraph
  - docs/module-authoring.md                                 # ~893, the alterPrimaryKey change variant
difficulty: hard
---

# What happens

On the default in-memory table module (a plain `new Database()`), a primary-key change
issued inside an open transaction discards **everything that transaction had written to
that table**, and the `commit` still succeeds.

```sql
create table t (a integer not null, b integer not null, v text, primary key (a));
insert into t values (5, 5, 'pre');   -- committed before the transaction
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
commit;
-- select * from t  →  only (5, 5, 'pre'). The row inserted in the transaction is gone.
```

Confirmed by direct reproduction on `main` (every case below was run; each is a candidate
regression test):

| what the transaction did before the `alter primary key` | what survives the commit today |
| --- | --- |
| `insert` a new row | row lost; an `insert` event for it is still delivered |
| `update` a previously committed row | update lost — the row reads back with its old value |
| `delete` a previously committed row | delete lost — the row is still there |
| `insert` inside a savepoint that is then `release`d | row lost |
| nothing (a clean transaction) | correct — rows survive |
| the same statement in autocommit (no `begin`) | correct — rows survive |

With the module constructed as `new MemoryTableModule(emitter)` — its own change-event
emitter rather than the engine's — the writes are lost *and* no events are delivered at all
for them.

So the damage is not limited to inserts: **any** write the transaction made to that table is
silently rolled back by a statement that reports success, while a listener is told (on the
engine event path) that the write happened. A consumer's copy of the table and the database
disagree from that moment on.

# Why

The memory module refuses an in-place primary-key change (`module.ts` `alterTable`, the
`alterPrimaryKey` arm, throws `UNSUPPORTED`), so the engine falls back to rebuilding the
table — `rebuildMemoryTable` in `runtime/emit/alter-table.ts`. That rebuild:

- reads rows out of the old table with `scanAllRows()`, which walks the **committed** layer
  only, so the transaction's own pending layer is never read;
- writes them into a fresh table with `insertRow()`, which writes straight to the base layer;
- then discards the old table manager — and with it the transaction's pending rows, its
  pending deletions, and (on the module-emitter path) its pending change-event log.

The transaction's connection is deliberately dropped too (`removeConnectionsForTable`), so
nothing downstream notices the pending layer went missing.

# The fix: make the memory table re-key in place

Give `MemoryTableManager` a real `alterPrimaryKey` and have `module.alterTable` honor it, so
the engine's native arm is taken and `rebuildMemoryTable` can be **deleted**. This is the
only outcome that satisfies both halves of what the statement promises — the transaction's
rows are still there after the commit, *and* their change events are still delivered — and
it is the outcome that keeps every existing test passing.

Most of the machinery already exists, built for `alter column … set collate` on a primary-key
column, which is the same problem with the key's *comparator* moving instead of its *columns*:

- `MemoryTableManager.alterColumn` (manager.ts ~2275) is the ordering template, and its
  doc comment states the contract: resolve → pre-validate (mutating nothing) → probe the
  re-keyed structures → rebuild the base → swap the manager's schema → propagate to the open
  transaction's layers → emit. It also already supports a `validateOnly` dry run, which the
  isolation layer depends on.
- `validateRekeyedPrimaryKey` is the pre-pass that proves no layer in the chain — base
  included — holds a collision under the new key, which is what lets every later step
  succeed unconditionally.
- `BaseLayer.rebuildPrimaryTreeStrict` rebuilds the committed tree under the new key.
- `TransactionLayer.rekeyPrimaryKey` (transaction.ts ~298) rebuilds one open layer: it swaps
  in the new schema, rebuilds the key functions from it, collapses the layer's own writes to
  their net per-key effect, and replays that effect into a fresh tree over the parent's.
  `propagateAlterColumnToOpenLayers` drives it oldest-first over the whole chain.

Two things in that machinery were written for a comparator-only change and need real work
for a change of key *columns*:

- **Deletions.** A layer's own-write log records a deletion by its key only (`OwnWrite` has
  no row image for a delete — transaction.ts ~36). Under a new key definition an old-shaped
  key is meaningless, so each net deletion's new key has to be re-derived from the row image
  the parent layer still holds at the old key.
- **The pending change-event log.** `rekeyPrimaryKey` deliberately does *not* rewrite it,
  and says why: a collation change leaves every stored value and every key value untouched,
  so the recorded images stay accurate. A change of key columns does not — the log's
  recorded keys must be re-derived, the same way `installReshapedColumns` rewrites the log
  for `add`/`drop column`. This is what makes the `new MemoryTableModule(emitter)` path
  deliver its events again.

Also note: `Date.now()` is used to name the shadow table in the rebuild path being deleted;
nothing in the in-place path needs it.

## What this does *not* change

Schema changes on the memory backend are not undone by `rollback` — the settled
`'non-transactional'` tier from `feat-ddl-transaction-capability`, with
`pragma ddl_transaction_policy = 'strict'` as the opt-in refusal. Reproduced again here:
after `begin; insert; alter primary key; rollback`, the new key is still in force. Leave
that as-is; it is out of scope, and `backlog/bug-rolled-back-rows-violate-surviving-ddl`
owns the family.

## If the in-place re-key proves infeasible

The fallback is to **reject** the statement — the stance the isolation layer already takes
in words ("Cannot alter the primary key of '…' while this transaction has uncommitted
changes staged for it; commit or roll back first."). It is much smaller: the memory manager
can answer "does the DDL-issuing connection hold uncommitted writes?" from
`ddlConnection()` plus `MemoryTableConnection.hasOpenWork()` (connection.ts ~274), and the
`alterPrimaryKey` arm refuses when it does while still throwing `UNSUPPORTED` when the
transaction is clean, so the existing rebuild keeps serving the cases that work today.

Two traps if you go this way:

- The refusal **must not** use `StatusCode.UNSUPPORTED`. `runAlterPrimaryKey` catches
  `UNSUPPORTED` from `module.alterTable` and falls through to the rebuild, so an `UNSUPPORTED`
  refusal is swallowed and the caller sees success. (That is exactly why the isolation
  layer's refusal never reaches anyone — see `fix/bug-alter-primary-key-shadow-rebuild-destroys-rows`.)
  `BUSY` reads correctly and matches what `ensureSchemaChangeSafety` already raises for
  "another connection has uncommitted changes".
- Rejecting deletes real coverage. Every `ALTER PRIMARY KEY` arm in
  `alter-table-events.spec.ts` is shaped `begin; write; alter primary key; commit` — they
  would all start failing and would have to move to a natively-re-keying leg (the store) or
  be dropped, and the rebuild-arm `rekeyBatchedDataEvents` call in `runAlterPrimaryKey`
  (~1517) becomes unreachable. Say so explicitly in the handoff if you take this route.

# TODO

## Phase 1 — pin the current behavior

- Add a regression spec (suggested: `packages/quereus/test/alter-primary-key-in-transaction.spec.ts`)
  covering each row of the table above on a default `new Database()`: pending insert, pending
  update, pending delete, released-savepoint insert, clean transaction, autocommit control.
  Assert rows read back *and* the delivered change events.
- Add the `new MemoryTableModule(emitter)` leg: the transaction's writes must produce
  delivered events with keys of the new arity.
- Drop the deferral NOTE at `alter-table-events.spec.ts` ~368-376 once row survival is
  actually asserted, and let those arms assert rows as well as keys.

## Phase 2 — in-place re-key in the memory manager

- Add `MemoryTableManager.alterPrimaryKey(newPkDef, rows?, validateOnly?)`, following
  `alterColumn`'s ordering contract exactly (latch → `ensureSchemaChangeSafety` → validate
  over effective rows → probe re-keyed structures → rebuild base → swap schema → propagate
  to open layers → emit), including the `validateOnly` dry run the isolation layer needs.
- Reject a re-key whose new key collides over the transaction's *effective* rows
  (`effectiveDdlRows`) with a sited `CONSTRAINT`, before anything mutates — mirroring the
  existing `validateRekeyedPrimaryKey` / `validateRekeyedUniqueStructures` passes.
- Extend `TransactionLayer.rekeyPrimaryKey` (or add a sibling) to handle a change of key
  *columns*: re-derive each net deletion's new key from the parent layer's row image, and
  rewrite the pending change-event log's keys.
- Rebuild every secondary index under the new key (each index's key encoding embeds the
  primary key), on the base and on each open layer.
- Honor `alterPrimaryKey` in `MemoryTableModule.alterTable` (module.ts ~973) instead of
  throwing `UNSUPPORTED`.

## Phase 3 — retire the rebuild

- Delete `rebuildMemoryTable` and the `module instanceof MemoryTableModule` branch in
  `rebuildTableWithNewShape`; keep the rebuild-arm `rekeyBatchedDataEvents` call correct for
  whatever paths remain.
- Confirm the isolation layer still behaves: it forwards `alterTable` to memory as its
  underlying module and dry-runs the overlay's own `alterSchema` first
  (`quereus-isolation/src/isolation-module.ts` ~1369), so memory gaining a real
  `alterPrimaryKey` changes which branch it takes. Run the isolation package's tests.

## Phase 4 — docs and validation

- `docs/memory-table.md` line 95 currently claims the rebuild "fails cleanly without data
  loss (the original table is unchanged)" — replace with the in-place re-key.
- `docs/sql-ddl.md` ~624 describes the rebuild fallback for "the built-in MemoryTable";
  correct it.
- `docs/module-authoring.md` ~893 (the `alterPrimaryKey` variant) and its capability table —
  memory now honors it.
- `docs/design-isolation-layer.md` ~877 states "The bundled `MemoryTableModule` rejects
  `alter primary key` outright (`UNSUPPORTED`), so this path is only reachable with a
  store-backed underlying" — no longer true.
- `yarn build`, `yarn test`, `yarn lint`, and the isolation package's own tests.
