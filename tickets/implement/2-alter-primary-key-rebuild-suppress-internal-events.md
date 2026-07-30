---
description: When the engine has to rebuild a table behind the scenes to change its primary key, applications watching for changes are told every existing row was just inserted, and applications watching for structural changes are told the table was dropped and a differently-named one created — none of which happened.
prereq: alter-primary-key-rebuild-refuse-unsafe
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # rebuildViaShadowTable (~1687) — the four internal statements; runAlterPrimaryKey (~1420)
  - packages/quereus/src/core/database-events.ts            # DatabaseEventEmitter: needsDataEvents (~449), needsSchemaEvents (~459), handleModuleDataEvent (~579), handleModuleSchemaEvent (~593), emitAutoDataEvent (~609), emitAutoSchemaEvent (~625)
  - packages/quereus/src/core/database.ts                   # _needsDataEvents (~931), _needsSchemaEvents (~938) — the pass-throughs the gates read
  - packages/quereus/src/schema/manager.ts                  # emitAutoSchemaEventIfNeeded (~2581) — the schema-event gate
  - packages/quereus/src/runtime/emit/dml-executor.ts        # ~756, ~1000, ~1191 — the three data-event gates
  - packages/quereus/test/alter-table-conformance.spec.ts   # makeNoAlterModule (~543) — the stub backend both reproductions use
  - docs/usage.md                                           # § Subscribing to Schema Changes / data-change subscriptions
  - docs/sql-ddl.md                                         # ~624 — the ALTER PRIMARY KEY rebuild-fallback paragraph
difficulty: medium
---

# Background

`alter table … alter primary key` normally asks the table's backend to re-key itself. A backend
that cannot do that gets the engine's generic fallback, `rebuildViaShadowTable`
(`alter-table.ts` ~1687), which runs four ordinary SQL statements through
`db._execWithinTransaction`:

```
create table <table>__rekey_<timestamp> (… same columns, new primary key …)
insert into <shadow> (cols) select cols from <table>
drop table <table>
alter table <shadow> rename to <table>
```

Because those are ordinary statements, they raise ordinary change notifications — and the
notifications describe the engine's internal scaffolding rather than what the user asked for.
Both reproductions below use the conformance suite's stub backend
(`makeNoAlterModule({ withRenameTable: true })` in
`packages/quereus/test/alter-table-conformance.spec.ts` ~543): it delegates storage to an
inner in-memory module and omits the `alterTable` hook, so it takes the rebuild. Plain
autocommit, verified on current `main`.

Sibling ticket `alter-primary-key-rebuild-refuse-unsafe` restricts *when* the rebuild runs
(it now requires a `renameTable` hook, and refuses inside an explicit transaction). It is a
prereq only because it edits the same decision point in `runAlterPrimaryKey`; the two defects
below survive it unchanged in the autocommit case, which is the case that remains.

# Defect 1 — every copied row is announced as a brand-new insert

Seed one row, subscribe, re-key:

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using noalter;
insert into t values (5, 5, 'pre');
-- subscribe with db.onDataChange(...)
alter table t alter primary key (a, b);
```

The listener receives:

```json
[{ "type": "insert", "tableName": "t", "key": [5, 5], "newRow": [5, 5, "pre"] }]
```

An `insert` for a row nobody touched. The `tableName` reads `t`, not the shadow name, because
the copy's events are batched inside the statement's implicit transaction and the trailing
rename relabels them onto the real table before they are flushed. A re-key changes no row —
the table's contents are identical before and after — so a listener replicating or caching
these rows now believes a row was created.

# Defect 2 — the structural notification says "table dropped, other table created"

Same sequence, subscribing with `db.onSchemaChange(...)` instead:

```json
[{ "type": "create", "objectName": "t__rekey_1785373438922" },
 { "type": "drop",   "objectName": "t" }]
```

There is no third event for the rename (`ALTER TABLE` raises no schema event on the engine's
own path at all — that is the separately tracked
`fix/bug-alter-table-emits-no-schema-event-without-native-module-emitter`). So a subscriber that
mirrors the catalog — a persisted-catalog writer, a schema replicator, a UI table list — ends up
recording a table under a machine-generated timestamped name and forgetting the real one. That
is worse than defect 1: the timestamped name is not even stable across runs.

# Design

Both defects have one cause — the rebuild's internal statements are indistinguishable from user
statements — so they get one fix: **run the whole four-statement rebuild with the two public
notification channels suppressed.**

## What "suppressed" means, and what it must NOT touch

Quereus has two separate change channels, and only one of them is being suppressed:

- **The public event channels** — `db.onDataChange` / `db.onSchemaChange` /
  `db.onTransactionCommit`, served by `DatabaseEventEmitter`. These are for *applications*.
  Suppress these.
- **The internal catalog change notifier** — `db.schemaManager.getChangeNotifier().notifyChange`,
  which invalidates the optimizer's and the write-path's cached schemas. This is engine
  plumbing, and the shadow table's create / drop / rename **must keep firing it** or those
  caches go stale mid-statement. Leave it completely alone.

## The seam

Every producer already routes through one of two gates before it does any event work:

- data: `db._needsDataEvents()` → `DatabaseEventEmitter.needsDataEvents()`, read at
  `dml-executor.ts` ~756 / ~1000 / ~1191;
- schema: `db._needsSchemaEvents()` → `DatabaseEventEmitter.needsSchemaEvents()`, read at
  `schema/manager.ts` ~2581 (`emitAutoSchemaEventIfNeeded`).

So a suppression counter on `DatabaseEventEmitter` that makes **both gates report `false`** stops
the events from ever being constructed — cheaper than building and discarding them, and it takes
the `onTransactionCommit` grouping down with it (which is right: the copy is not part of any
batch the application should see).

The gates are not the only entry points, though: a backend with its own emitter delivers through
`handleModuleDataEvent` / `handleModuleSchemaEvent`, which never consult a gate. So the counter
must **also drop events arriving at all four record chokepoints** while it is non-zero:
`handleModuleDataEvent` (~579), `handleModuleSchemaEvent` (~593), `emitAutoDataEvent` (~609),
`emitAutoSchemaEvent` (~625). Drop at `log()` level, not silently — a discarded event should be
traceable.

Shape it as a counter with a scope helper rather than a boolean, so nesting cannot leave it
stuck on, and use `try`/`finally` so a failing rebuild (whose `catch` already drops the shadow
table) restores it:

```ts
/** on DatabaseEventEmitter */
async withPublicEventsSuppressed<T>(fn: () => Promise<T>): Promise<T>
```

Wrap the whole body of `rebuildViaShadowTable` — all four statements, not just the copy. The
create and the drop are the source of defect 2, and the rename is what relabels the copy's
events, so suppressing only the copy would still leak the create/drop pair.

## Known residue — record as a code comment, do not file a ticket

A backend whose *own* emitter defers delivery to its own commit (rather than emitting during the
write) can still leak the copy's inserts: its events arrive after the suppression scope has
closed. No such backend reaches this path today — the in-memory module and the store both re-key
in place and never enter the rebuild — so this is conditional, not a live defect. Leave a
`NOTE:` comment at the suppression site saying so, and what would be needed if a backend ever
did (name-keyed suppression covering the shadow name, or dropping the events out of the batch
after the fact).

## Consequence to state in the docs, not to fix here

With the internal events suppressed and no `alter`-type event to replace them, a subscriber gets
**no** notification that the primary key changed on this path. That is a smaller wrong answer
than the current one (a garbage-named table created and the real one dropped), and the positive
event is exactly the scope of
`fix/bug-alter-table-emits-no-schema-event-without-native-module-emitter`, which is about every
`ALTER TABLE` arm, not just this one. Do not synthesize a one-off event here; say plainly in
`docs/sql-ddl.md` that the rebuild is notification-silent and cross-reference.

## Check while you are in there

Once the copy emits nothing, the batch can hold no events for this table at the point
`runAlterPrimaryKey` calls `rekeyBatchedDataEvents` after the rebuild (`alter-table.ts` ~1516):
the ALTER statement writes no rows of its own before the rebuild, and the sibling ticket has
already refused the explicit-transaction case that could supply earlier ones. Verify that, then
**keep the call** — it is cheap, it is correct if the transaction guard is ever loosened, and
removing it would silently couple two tickets' guarantees. Replace its current comment (which
claims it re-keys "events this transaction already recorded") with one that says it is now a
defensive no-op on this path and why.

# TODO

- Add the suppression counter and `withPublicEventsSuppressed` scope helper to
  `DatabaseEventEmitter` (`core/database-events.ts`), documenting on it that it covers the public
  `onDataChange` / `onSchemaChange` / `onTransactionCommit` channels only and explicitly **not**
  the internal catalog change notifier.
- Make `needsDataEvents()` and `needsSchemaEvents()` return `false` while suppression is active.
- Drop (with a `log()` line) any event arriving at `handleModuleDataEvent`,
  `handleModuleSchemaEvent`, `emitAutoDataEvent`, and `emitAutoSchemaEvent` while suppression is
  active.
- Wrap the whole body of `rebuildViaShadowTable` in the scope, `try`/`finally` so the existing
  shadow-cleanup `catch` still runs with the counter restored.
- Add the `NOTE:` comment for the deferred-module-emitter residue at the suppression site.
- Re-comment the `rekeyBatchedDataEvents` call at `alter-table.ts` ~1516 per *Check while you are
  in there*; keep the call.
- Tests, in `packages/quereus/test/alter-table-events.spec.ts` (whose header already frames the
  mid-ALTER event-correctness families) — a new `describe` for the shadow-rebuild backend, using
  the conformance suite's stub shape (`makeNoAlterModule({ withRenameTable: true })`; it is
  currently private to `alter-table-conformance.spec.ts`, so either export it from there or
  build the same three-line stub locally):
  - a committed row plus a re-key delivers **zero** data-change events;
  - the same delivers **zero** schema-change events (in particular nothing naming
    `%__rekey_%`);
  - a `db.onTransactionCommit` subscriber sees no data events for the statement either;
  - the table is still readable and re-keyed afterwards, and its rows are unchanged — the
    suppression must not have suppressed the work.
- Add a suppression-scope unit test in `packages/quereus/test/` covering nesting and restoration
  after a throw (`needsDataEvents()` / `needsSchemaEvents()` back to `true` once the scope exits).
- Assert the internal notifier is untouched: the simplest proof is that a query issued after the
  re-key plans against the new key (a point lookup on the new primary key returns the row) —
  a stale cached schema would break that. If `alter-table-conformance.spec.ts`'s existing
  rebuild test already covers it, reference it rather than duplicating.
- Update `docs/sql-ddl.md` ~624 (the rebuild is notification-silent; cross-reference the missing
  `alter` event) and `docs/usage.md`'s subscription sections (a re-key on a rebuild backend
  raises no events).
- Run `yarn build`, then `yarn test` (streamed, `2>&1 | tee /tmp/t.log`), then `yarn lint`.
  `yarn test` covers the isolation package's ALTER suites too. The store re-keys natively and
  never reaches the rebuild, so `yarn test:store` is not needed — but note that
  `packages/quereus-store/test/alter-events.spec.ts` is the primary home for ALTER PRIMARY KEY
  event coverage, so read its header before choosing assertions here, to stay consistent with it.
