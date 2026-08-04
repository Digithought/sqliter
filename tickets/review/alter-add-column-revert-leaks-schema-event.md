---
description: A failed ALTER TABLE used to still tell listeners (and synced peer devices) that the change happened. It now announces nothing, on every storage backend.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                   # seq stamp + beginSchemaEventScope/discardSchemaEventsSince
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # withStatementScopedSchemaEvents (new)
  - packages/quereus/src/runtime/emit/alter-table.ts               # emitAlterTable.run() wraps the arm dispatch
  - packages/quereus/src/runtime/emit/add-constraint.ts            # runAddConstraintViaModule wraps its body
  - packages/quereus/test/alter-table-schema-events.spec.ts        # 6 new cases (3 per describe)
  - packages/quereus-store/test/alter-events.spec.ts               # 3 new cases
  - docs/usage.md                                                  # § What each ALTER TABLE arm reports
difficulty: medium
---

# A failed `ALTER TABLE` announces nothing, on every backend

## What was wrong

`alter table p add column c integer default 5 unique` on a table whose rows all backfill to
the same value fails: the inline `UNIQUE` cannot be installed, and the engine unwinds the
whole statement, leaving the table without column `c`.

A storage backend that raises its own change events still told listeners the column was
added, and the announcement carried the statement's SQL. On a syncing database another
device executed that SQL and really did add the column — the two devices diverged.

Root cause: a self-emitting module emits from **inside** `module.alterTable`, marked by the
`ddl` the engine passes on the call that IS the statement's action. But that call is not the
end of the statement — the engine then installs each inline constraint through further module
calls, and a failure there runs `revertAddColumn`, by which point the announcement already
sits in the transaction's batched-event list. The emit boundary was **call-scoped** where it
had to be **statement-scoped**.

Backends without their own emitter were already correct: the engine emits at each arm's tail,
past any throw.

## What changed

**Retraction, not a moved marker.** `DatabaseEventEmitter` now stamps every batched schema
event with a lifetime-monotonic sequence number and exposes a mark/discard pair over it:

```ts
/** Watermark identifying "everything batched from here on". */
beginSchemaEventScope(): number;

/** Drop every batched schema event stamped at or after `watermark`. Returns how many. */
discardSchemaEventsSince(watermark: number): number;
```

Both schema-event push sites (`handleModuleSchemaEvent` for module emitters,
`emitAutoSchemaEvent` for the engine's own) route through one private `pushSchemaEvent` that
does the stamping, so no event can enter the batch unstamped. The discard walks the base
batch **and** every open savepoint layer. The counter is never reset, so a watermark can
never match a later transaction's events.

**One shared wrapper**, in `runtime/emit/alter-schema-event.ts` next to `emitAlterSchemaEvent`
so both halves of the "one event per statement, success path only" rule live together:

```ts
export async function withStatementScopedSchemaEvents<T>(
	rctx: RuntimeContext,
	fn: () => Promise<T>,
): Promise<T>;
```

Wired at both ALTER statement boundaries: the whole `switch (action.type)` dispatch in
`emitAlterTable`'s `run()` (after the DDL-policy gate and `_ensureTransaction()`, so the mark
is taken with batching already on), and `runAddConstraintViaModule`'s body. Placed at the
statement boundary rather than inside `revertAddColumn` so the other arms' post-module-call
work (`propagateTableRename`, `module.finalizeRename`, `propagateColumnRename`, the
materialized-view re-registration) cannot open the same hole later.

Comments in `runAddColumn` / `revertAddColumn` that credited the no-`ddl` module calls with
keeping a failed statement silent now say that is the second line of defence, not the only
one. `docs/usage.md` lost its "one known exception" clause.

## Validation performed

**The three reproductions were driven both ways.** With the discard call temporarily
neutered, all three leak on the emitter-backed memory module and all three leak on the store
module, each carrying its own statement text — e.g.

```json
{ "type": "alter", "objectType": "table", "moduleName": "store", "schemaName": "main",
  "objectName": "p", "ddl": "alter table p add column c integer default 5 unique",
  "remote": false }
```

With the fix in place all nine new cases pass. That negative check is the reason to trust the
tests are not vacuous — the reviewer should not have to take it on faith, and re-running it is
a two-line edit to `withStatementScopedSchemaEvents`.

Suites:

- `yarn build` — clean
- `yarn test` — 8621 + 376 + 113 + 63 + 17 + 28 + 1362 + 719 + 85 + 31 + 34 + 134 + 22 passing,
  **0 failing**, 13 pending (pre-existing)
- `yarn test:store` — 8613 passing, 0 failing, 21 pending
- `yarn lint` — clean (only `packages/quereus` has a real lint; it type-checks the spec call
  sites too)

## Use cases a reviewer should exercise

Each of the three below, run inside `begin` … `commit` with a sibling INSERT so the batch is
actually flushed. The transaction wrapper is load-bearing: in autocommit the statement rolls
back and `discardBatch` throws the whole batch away, which is exactly why the bug hid for so
long. A test written without the explicit transaction passes on a broken engine.

```sql
create table parent (pid integer primary key);
insert into parent values (1);
create table p (id integer primary key);
insert into p values (1), (2);
begin;
insert into p values (3);
-- each of these must fail and announce NOTHING:
alter table p add column c integer default 5 unique;                  -- duplicate values
alter table p add column c integer default 5 check (c > 10);          -- backfill violates CHECK
alter table p add column c integer default 42 references parent(pid); -- FK orphan
commit;                                                               -- batch delivered
```

Expected on both an emitter-backed `MemoryTableModule` and the store module: zero schema
events, `p` still holds exactly rows 1/2/3, and `select * from p` shows no `c` column.

Success-path shapes must be **unchanged** — that is the acceptance criterion this change
could most plausibly break. The existing suites pin it: `add column w text null unique` is
still exactly one `alter/column/t/w` event on the memory path, and the store's per-arm `ddl`
assertions are untouched.

## Known gaps — please probe these

- **Savepoint layers mid-statement are designed for but not directly tested.** The per-event
  stamp (rather than a remembered array length) exists precisely because a savepoint layer can
  be pushed, popped, or released between the mark and the discard, and `releaseSavepointLayer`
  moves entries between arrays. No new test drives a savepoint push/release *inside* a failing
  ALTER statement — I could not construct one from SQL, since a statement is atomic from the
  caller's side. If the reviewer can reach it (a module that opens a savepoint from inside
  `alterTable`?), that path deserves a case. The existing savepoint tests cover ALTERs
  *inside* a savepoint, which is a different thing and still green.

- **Only ADD COLUMN has a demonstrated leak.** The wrapper covers every arm, but no test
  drives a non-ADD-COLUMN arm failing *after* its module call. I did not find a constructible
  one — the rename arms' post-module-call failures (`assertRenameDependentsPersistable`) are
  pre-flighted *before* the module call — so the other arms' coverage is by placement and
  reasoning, not by a red-then-green test. If a reviewer can construct such a case, it is
  worth pinning.

- **`runAddCheckEngineSide` is deliberately unscoped.** It exists for backends with no
  `alterTable` hook at all, which ship no emitter, and its own emit is already at the tail.
  Reasoning is in the code comment; challenge it if the premise is wrong.

- **Data events are deliberately untouched by the retraction**, and this is a trap worth
  re-reading in `discardSchemaEventsSince`'s doc comment. The store's `ddlCommitPendingOps()`
  flushes the transaction's *earlier* buffered writes into the engine batch during an ALTER,
  so those data events fall inside the failing statement's window while belonging to previous,
  successful statements. Retracting them would silently swallow committed work. If a reviewer
  thinks the data channel should also be scoped, the argument has to address that.

- **Out of scope, already filed:** the store module announces `objectType: 'table'` with no
  `columnName` for *every* ALTER arm, where the memory module and the `docs/usage.md` table say
  `objectType: 'column'` with the column named. Tracked as
  `bug-store-schema-event-shape-diverges`. Success-path shapes come out of this ticket
  unchanged by design, so the two stay independently reviewable. The new store tests assert
  *zero* events, so they are indifferent to which shape is right.

## Tripwires parked in code

- `discardSchemaEventsSince` splices per matching event, so a scope covering N events costs
  O(N × batch size). One ALTER batches at most a handful. `NOTE:` at the site says to
  partition into a kept array if a scope ever spans many schema events.
- Nested scopes: nothing nests them today (the one arm running nested SQL — the ALTER PRIMARY
  KEY shadow rebuild — does it under `withPublicEventsSuppressed`, batching nothing). `NOTE:`
  on `withStatementScopedSchemaEvents` records that an outer failure retracting an inner
  statement's events would be the *wanted* reading anyway.
