---
description: When adding a column fails partway and is undone, the database still tells listeners — and other synced devices — that the column was added, so a peer can end up with a column the original device does not have. Make a failed ALTER TABLE announce nothing.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                   # DatabaseEventEmitter — add the statement-scoped schema-event mark/discard
  - packages/quereus/src/runtime/emit/alter-schema-event.ts         # home for the new shared wrapper
  - packages/quereus/src/runtime/emit/alter-table.ts                # emitAlterTable.run() — wrap the arm dispatch
  - packages/quereus/src/runtime/emit/add-constraint.ts             # runAddConstraintViaModule — same wrapper
  - packages/quereus/src/vtab/memory/module.ts                      # MemoryTableModule.alterTable — emit site (read only; no change expected)
  - packages/quereus-store/src/common/store-module-alter.ts         # StoreModuleAlter.alterTable — emit site (read only; no change expected)
  - packages/quereus-store/test/alter-events.spec.ts                # § "a failed ADD COLUMN announces nothing" — extend
  - packages/quereus/test/alter-table-schema-events.spec.ts         # emitter-backed + engine-fallback describes — extend
  - docs/usage.md                                                   # § What each ALTER TABLE arm reports — remove the documented exception
difficulty: medium
repro: verified
---

# A failed `ALTER TABLE` must announce nothing, on every backend

## What happens today

`alter table p add column c integer default 5 unique` on a table whose existing rows would
all get the same value fails: the inline `UNIQUE` cannot be installed. The engine unwinds
the whole statement and the table is left exactly as it was — no `c` column.

But a storage backend that raises its own change events still tells listeners the column
was added, and the announcement carries the statement's SQL text. If the database is
syncing, another device executes that SQL and really does add the column, so the two
devices diverge — precisely the outcome the DDL-carrying event was added to prevent.

Backends with no emitter of their own get this right: the engine announces only after the
whole statement succeeded (`emitAlterSchemaEvent`, called at each arm's tail).

## Root cause

`runAddColumn` marks the module's `addColumn` call with the statement's canonical SQL
(`SchemaChangeInfo.ddl`). Both built-in modules read that marker as "this call IS the
statement — announce it", and emit from inside the call. But the statement is not over: the
engine then installs each inline constraint through further module calls, and a failure
there runs `revertAddColumn`. By then the announcement is already sitting in the
transaction's batched-event list, and nothing retracts it.

The emit boundary is **call-scoped** where it must be **statement-scoped**.

## Verified reproductions

All three run inside an explicit transaction that then COMMITS other work — an autocommit
statement rolls back and `discardBatch` throws the event away, which is why this hid. Each
was observed leaking exactly one schema event on **both** an emitter-backed
`MemoryTableModule` and the store module.

```sql
create table p (id integer primary key);
insert into p values (1), (2);
begin;
insert into p values (3);
-- each of these fails, and each leaks one event carrying its own SQL:
alter table p add column c integer default 5 unique;                  -- duplicate values
alter table p add column c integer default 5 check (c > 10);          -- backfill violates CHECK
alter table p add column c integer default 42 references parent(pid); -- FK orphan
commit;                                                               -- event delivered
```

Observed on the store module (`alter table p add column c integer default 5 unique`):

```json
{ "type": "alter", "objectType": "table", "moduleName": "store",
  "schemaName": "main", "objectName": "p",
  "ddl": "alter table p add column c integer default 5 unique", "remote": false }
```

and on the emitter-backed memory module, the same leak in that module's shape
(`objectType: "column"`, `columnName: "c"`). After the commit, `select * from p` returns
only `id` on both.

Two near misses, checked and **not** leaking, so the tests below do not need them:
`alter table … add column g integer generated always as (nosuchcol * 2)` is rejected at
plan-build, before any module call; and the pre-existing test case
`add column c integer default (new.n) check (c > 0)` fails inside the module's own backfill,
so the module never reaches its emit. That is why the existing regression test passes while
the bug is live — it only covers the earlier failure mode.

## Design

Give the engine a way to **retract** the schema events a failing statement produced, rather
than moving the marker onto a different module call.

Why not "move the marker to the last module call of the statement" (the cheaper option the
fix ticket floated): for `add column c … unique` the last call is `addConstraint`, whose
`SchemaChangeInfo` carries no column name — so the module physically cannot render the
`alter` / `column` / `<column>` shape the memory module announces today and
`docs/usage.md` tabulates. Preserving the shape would mean threading the whole event shape
down to the modules alongside `ddl`, which is strictly more plumbing than retraction, and
it still leaves every other arm's post-module-call window open.

### 1. Statement-scoped schema-event marks — `core/database-events.ts`

`DatabaseEventEmitter` grows a monotonically-increasing sequence stamped onto every batched
schema event, plus a mark/discard pair over it:

```ts
interface PendingSchemaEvent {
	moduleName: string;
	event: VTableSchemaChangeEvent;
	/** Position in the emitter's lifetime-monotonic schema-event stream. */
	seq: number;
}

/** Watermark identifying "everything batched from here on". */
beginSchemaEventScope(): number;

/** Drop every batched schema event stamped after `watermark`. Returns how many. */
discardSchemaEventsSince(watermark: number): number;
```

Notes that matter:

- **Stamp, don't snapshot lengths.** Between the mark and the discard a savepoint layer can
  be pushed, popped, or released, and `releaseSavepointLayer` moves entries between arrays.
  A per-event stamp travels with the event; a remembered array length does not.
- The discard walks the base batch **and** every open savepoint layer, same as
  `remapBatchedDataEvents` / `renameBatchedEvents` do.
- The counter is **never reset** (not in `startBatch`, not in `flushBatch`) so a watermark
  is unique for the emitter's whole lifetime and a stale one can never match a later
  transaction's events.
- Stamp in ONE place: both push sites (`handleModuleSchemaEvent` for module emitters,
  `emitAutoSchemaEvent` for the engine's own) should route through a small private
  `pushSchemaEvent(moduleName, event)`.
- No-op when not batching — the events were already delivered synchronously and there is
  nothing to retract. (Unreachable for ALTER in practice: `run()` calls
  `db._ensureTransaction()` before dispatching, so batching is always on by then.)
- **Data events are deliberately out of scope.** The store's `ddlCommitPendingOps()` flushes
  the transaction's EARLIER buffered writes into the engine batch during the ALTER, so those
  events fall inside the statement's window but belong to previous statements. Retracting
  them would silently swallow committed work. Say so in the doc comment — it is a trap.

### 2. One shared wrapper — `runtime/emit/alter-schema-event.ts`

```ts
export async function withStatementScopedSchemaEvents<T>(
	rctx: RuntimeContext,
	fn: () => Promise<T>,
): Promise<T>;
```

Marks, runs `fn`, and on a throw discards everything stamped since the mark before
rethrowing. Lives next to `emitAlterSchemaEvent` so the two halves of the "one event per
statement, on the success path only" rule are documented together.

### 3. Wire it — the two ALTER statement emitters

- `runtime/emit/alter-table.ts`: in `emitAlterTable`'s `run()`, wrap the whole
  `switch (action.type)` dispatch — after `assertDdlTransactionPolicy` and
  `await rctx.db._ensureTransaction()`, so the mark is taken with batching already on. This
  covers every arm, not just ADD COLUMN, and does not care which module call carried `ddl`.
- `runtime/emit/add-constraint.ts`: wrap `runAddConstraintViaModule`'s body the same way.
  Its window is narrow today (the module call is the last real work), but leaving one
  ALTER statement path unscoped is how this comes back.

ADD COLUMN is the only arm with a **demonstrated** leak; the wrapper is placed at the
statement boundary rather than in `revertAddColumn` so the other arms' post-module-call
work (`propagateTableRename`, `module.finalizeRename`, `propagateColumnRename`, the MV
re-registration) cannot open the same hole later.

### 4. Docs

`docs/usage.md` § *What each `ALTER TABLE` arm reports* currently reads:

> The event is raised on the statement's **success** path only — an ALTER that throws
> announces nothing at all — with one known exception on backends that emit for themselves:
> an `add column` that gets past its own module call and then fails while installing an
> inline constraint leaves its event behind (tracked as
> `alter-add-column-revert-leaks-schema-event`). …

Drop the exception clause; the sentence becomes unconditional on every backend.

## Out of scope

While verifying the success-path shapes, the store module was found to announce
`objectType: 'table'` with no `columnName` for **every** ALTER arm — including
`add column` / `rename column` / `drop column`, where the memory module and the
`docs/usage.md` table say `objectType: 'column'` with the column named, and where
`drop column` is documented as `type: 'drop'`. That contradicts the doc's claim that a
subscriber sees the same facts either way. Separate root cause (the store's own emit
block), filed as `bug-store-schema-event-shape-diverges`. Do not fold it in here: the
success-path shapes must come out of this ticket **unchanged**, so the two changes stay
independently reviewable.

## Acceptance

- The three reproductions above deliver **zero** schema events, on the store module and on
  an emitter-backed memory module, with the enclosing transaction still committing its
  other work and the table left without the new column.
- Success cases unchanged: one event per statement, carrying the whole statement's canonical
  text, in each backend's current shape. The existing suites pin this — `add column w text
  null unique` must still be exactly one `alter/column/t/w` event on the memory path.

# TODO

## Phase 1 — the retraction mechanism

- Add `seq` to `PendingSchemaEvent` and a lifetime-monotonic `schemaEventSeq` counter to
  `DatabaseEventEmitter`.
- Route both schema-event push sites (`handleModuleSchemaEvent`, `emitAutoSchemaEvent`)
  through one private `pushSchemaEvent` that stamps the seq.
- Add `beginSchemaEventScope()` and `discardSchemaEventsSince(watermark)`, the latter
  walking the base batch plus every savepoint layer and logging the discarded count.
- Doc-comment both: why a stamp and not a length snapshot, why the counter never resets,
  why data events are deliberately untouched.

## Phase 2 — wire the ALTER statement paths

- Add `withStatementScopedSchemaEvents(rctx, fn)` to
  `runtime/emit/alter-schema-event.ts`, documented alongside `emitAlterSchemaEvent`.
- Wrap the arm dispatch in `emitAlterTable`'s `run()` (after the DDL-policy gate and
  `_ensureTransaction()`).
- Wrap `runAddConstraintViaModule`'s body in `runtime/emit/add-constraint.ts`.
- Update the `revertAddColumn` and `runAddColumn` comments that currently claim the
  no-`ddl` module calls are what keep a failed statement silent — that is now the second
  line of defence, not the only one.

## Phase 3 — tests

- `packages/quereus-store/test/alter-events.spec.ts`: alongside the existing
  *"a failed ADD COLUMN announces nothing — not even its revert"*, add the three
  post-module-call failure modes (inline UNIQUE duplicate, inline CHECK violated by the
  literal-default backfill, inline FK orphan). Each: inside `begin` … `commit`, assert zero
  alter-shaped events, assert the other work committed, assert `select * from …` still has
  the pre-ALTER columns only.
- `packages/quereus/test/alter-table-schema-events.spec.ts`: the same three cases under the
  emitter-backed `MemoryTableModule` describe, and under the engine-fallback describe, so
  both paths are pinned to agree.
- Keep the existing success-shape assertions untouched and green.

## Phase 4 — docs and validation

- `docs/usage.md`: remove the "one known exception" clause and the slug reference.
- `yarn build`, then `yarn test`, then `yarn lint` (type-checks the spec call sites too).
- `yarn test:store` for the store-path ALTER coverage this touches.
