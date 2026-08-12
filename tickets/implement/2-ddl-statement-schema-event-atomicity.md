---
description: A data-definition statement that fails part-way still tells listeners (and syncing peer devices) about objects it created and then removed; make every such statement announce nothing when it fails, the way ALTER TABLE already does.
files:
  - packages/quereus/src/runtime/emit/alter-schema-event.ts          # holds withStatementScopedSchemaEvents today — move it out
  - packages/quereus/src/runtime/emit/create-table.ts                # the verified leak (maintained form)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create / refresh / drop MV — same core, same leak
  - packages/quereus/src/runtime/emit/create-index.ts
  - packages/quereus/src/runtime/emit/drop-table.ts
  - packages/quereus/src/runtime/emit/drop-index.ts
  - packages/quereus/src/runtime/emit/create-view.ts
  - packages/quereus/src/runtime/emit/drop-view.ts
  - packages/quereus/src/runtime/emit/create-assertion.ts
  - packages/quereus/src/runtime/emit/drop-assertion.ts
  - packages/quereus/src/runtime/emit/set-object-tags.ts
  - packages/quereus/src/runtime/emit/alter-table.ts                 # already wrapped — only the import moves
  - packages/quereus/src/runtime/emit/add-constraint.ts              # already wrapped — only the import moves
  - packages/quereus/src/runtime/emit/schema-declarative.ts          # apply schema — deliberately NOT wrapped
  - packages/quereus/src/core/database-events.ts                     # beginSchemaEventScope / discardSchemaEventsSince + a stale doc reference
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # materializeView: create-then-fill, rollback drops the table
  - packages/quereus/test/alter-table-schema-events.spec.ts          # the pattern the new spec copies
  - docs/usage.md                                                    # § What each `ALTER TABLE` arm reports — the success-path-only rule
  - docs/module-events.md                                            # § A failed ALTER announces nothing, even from a native emitter
repro: verified
difficulty: medium
---

# Every DDL statement announces nothing when it fails

## The defect

`create table mv (…) maintained as <select>` creates the backing table first and fills it
afterwards. When the fill breaks a constraint the declaration asked for, the statement fails
and the engine drops the backing table again — but the create was already announced on the
public schema channel (`db.onSchemaChange`), and the teardown announces a drop. Subscribers,
and any peer device replicating those events, are told a table was created and then dropped.
Neither happened as far as the application is concerned.

`ALTER TABLE` already has the fix shape: `withStatementScopedSchemaEvents` in
`runtime/emit/alter-schema-event.ts` takes a watermark from
`DatabaseEventEmitter.beginSchemaEventScope()` and, if the statement throws, drops every
schema event batched since (`discardSchemaEventsSince`). No object-lifecycle statement runs
under it. This ticket puts every DDL statement under it.

## Verified during planning

Both producer paths leak, not just an emitter-backed module. Run inside an explicit
transaction that then commits other work (the transaction is load-bearing — in autocommit the
failed statement rolls back and the whole batch is discarded, hiding the leak):

```sql
create table src (id integer primary key, v integer);
insert into src values (1, -5);
begin;
insert into src values (2, 7);
-- fails: the body's row violates the declared CHECK
create table mv (id integer primary key, v integer check (v > 0)) maintained as select id, v from src;
commit;
```

- Default `new Database()` (built-in `memory` module, no module emitter → the engine's own
  auto path, `SchemaManager.emitAutoSchemaEventIfNeeded` at the tail of `createBackingTable`
  and of `dropTable`): delivered `create/table/src`, **`create/table/mv`, `drop/table/mv`**.
- Emitter-backed `MemoryTableModule(new DefaultVTableEventEmitter())` registered as the
  session default: the ticket's original repro, same pair, each carrying re-executable `ddl`.

Wrapping `emitCreateTable`'s `run()` body in `withStatementScopedSchemaEvents` reduced the
delivered set to `create/table/src` on the auto path — verified by temporary patch, which was
reverted. So the mechanism works unchanged; the work is deciding where it applies and covering
the class.

## The design question, settled: per-DDL-emitter, not per-statement

The source ticket asked whether the wrapper should move up to a single statement boundary
instead of being applied family by family. It should **not** move to a blanket
statement/scheduler boundary, and the reason is `apply schema`:

`emitApplySchema` (`runtime/emit/schema-declarative.ts`) generates migration DDL and runs each
generated statement through `db._execWithinTransaction` in `runBatchedMigrationLoop`. A
failure on statement 5 leaves statements 1–4 **applied** — there is no catalog rollback, and
inside an explicit transaction the user may still commit. Those four really happened and must
stay announced. A scope around the whole `apply schema` would retract them.

The per-statement scope gives exactly the right answer there for free: each generated
sub-statement runs its own emitter, so each opens and spends its own scope — the four that
succeeded keep their events, the fifth retracts its own.

So the rule is: **every DDL statement emitter opens the scope around its `run()` body; the
declarative statements (`apply schema` and friends) deliberately do not.** That is one
greppable invariant a reviewer can check against `runtime/register.ts`'s DDL block, rather
than a per-arm audit.

Emitters that raise no schema event today (views, assertions, the tag arms) are wrapped too.
The point is that the invariant holds by construction: if one of those ever starts announcing
— `backlog/feat-alter-table-tags-emit-no-schema-event` proposes exactly that for the tag arms
— it cannot reintroduce this class.

## Home for the helper

`withStatementScopedSchemaEvents` moves out of the ALTER-specific file into a new
`packages/quereus/src/runtime/emit/ddl-event-scope.ts`, sibling to the existing
`ddl-transaction-policy.ts` (same shape: one cross-cutting DDL-statement concern, one small
file every DDL emitter imports). Keep the exported name — docs and comments already use it.
`alter-schema-event.ts` keeps `emitAlterSchemaEvent` and `AlterSchemaEventShape` only. No
re-export shim; update the two ALTER importers.

The moved docstring must lose its "ALTER is the only statement family scoped this way … the
design question worth settling first" paragraph and state the settled rule above, including
the `apply schema` exclusion and why.

## Call shape

Same discipline the ALTER arms already use — inside `run()`, after `assertDdlTransactionPolicy`
and `await db._ensureTransaction()`, wrapping everything that follows:

```ts
await rctx.db._ensureTransaction();

return withStatementScopedSchemaEvents(rctx, async () => {
    // … the emitter's existing body, unchanged …
});
```

Placement is not load-bearing for correctness (the watermark is a lifetime-monotonic counter
and retraction is a no-op when not batching), but keeping it identical everywhere makes the
invariant readable.

## Edge cases & interactions

- **Autocommit.** The same failing statement outside an explicit transaction rolls back and
  the batch is discarded anyway. Must still deliver nothing, and must not throw a second error
  out of the retraction path (`discardSchemaEventsSince` returns 0 when not batching).
- **Explicit transaction that commits other work.** The load-bearing case: a sibling `insert`
  before the failing DDL must still commit and still deliver its **data** events. Only the
  schema channel is retracted — never touch the data or maintenance-collision channels (see
  the trap documented on `discardSchemaEventsSince`: the store module flushes earlier buffered
  writes into the batch during a DDL call, so previous statements' data events sit inside the
  failing statement's window).
- **Savepoints.** A failing DDL inside `savepoint s` … `release s` must still announce nothing:
  retraction matches on the per-event stamp and walks every open layer, so a release that
  merges a layer into its parent cannot resurrect a retracted event. Cover both `release` and
  `rollback to`.
- **Nesting.** Nothing nests these scopes after this change (`apply schema` is unwrapped; the
  ALTER PRIMARY KEY shadow rebuild runs under `withPublicEventsSuppressed`, batching nothing).
  If a future arm does nest one, an outer failure retracting the inner statement's events is
  the wanted reading — say so in the docstring rather than guarding against it.
- **`apply schema` partial failure.** A migration whose 2nd generated statement fails must
  keep the 1st statement's `create`/`drop` events (verify with a diff that generates ≥2
  statements where the later one fails). This is the case that forbids the blanket boundary —
  it deserves an explicit test, not just a comment.
- **Success paths byte-identical.** Exactly one event per successful `create table`,
  `create index`, `drop table`, `drop index`; the existing ALTER per-arm shapes unchanged; and
  a successful `create table … maintained as` still announces its single `create/table/<name>`
  (the *shape* of that event — a maintained table announcing as a plain table — is wrong for a
  different reason, tracked as `bug-sync-materialized-views-replicate-as-plain-tables`; do not
  change it here).
- **Both producer paths.** Every new assertion runs twice: default `Database` (engine auto
  path) and `MemoryTableModule(new DefaultVTableEventEmitter())` registered via
  `db.registerModule('memory_events', …)` + `db.setDefaultVtabName('memory_events')` — the
  pairing `test/alter-table-schema-events.spec.ts` already uses. Emitter-backed must stay at
  **one** event per successful statement (no double emit).
- **Maintained-create failure modes, all of which fail after the backing table is created and
  announced.** Constraint violation on fill (the repro); a body producing duplicate keys (the
  "must be a set" reject); a body rejected by the row-time eligibility gate inside
  `registerMaterializedView`. Failures that land *before* the create — declared-shape mismatch,
  self-reference, duplicate table name — already announce nothing; keep one as a regression
  guard so a future reordering cannot silently start announcing.
- **`create materialized view`** shares `materializeView`, so it leaks identically. Same cases.
- **`refresh materialized view`** reshapes the backing through module `alterTable` calls before
  it can fail on the recomputed rows; a failing refresh must announce nothing on either path.
- **Plain `create table` failing after the module call.** Probe
  `validateForeignKeyCollations` (`schema/constraint-builder.ts`, called from
  `SchemaManager.createTable` after `module.create` and before `addTable`): e.g. a parent
  `text collate nocase` key and a child `text collate binary` FK column. If that raises, it is
  a second confirmed leak on the plain form and belongs in the table; if the diagnostic turns
  out to fire earlier, say so in the handoff and drop the case.
- **`drop table` of a maintained table** does post-module-call work (`dropMaintainedTable`:
  detach maintenance, unlink covering links, fire `materialized_view_removed`). A failure
  there must not leave the drop announced.
- **Out of scope, do not chase:** when `create table` fails *after* `module.create`, the
  module-side table can be left stranded with no catalog entry. That is a catalog/storage drift
  question, not an event question; retracting the event is right regardless. Do not widen this
  ticket into it — mention it in the handoff if you confirm it.

## Tests

Add `packages/quereus/test/ddl-schema-event-atomicity.spec.ts` — a **table-driven** spec, not
a per-bug case, so the class stays covered as new DDL lands: a list of
`{ what, setup, failingStatement }` rows, each run under both backends, each asserting the
delivered schema events are exactly the ones the *successful* setup produced. Model the
harness on `assertFailedAddColumnAnnouncesNothing` in
`test/alter-table-schema-events.spec.ts`: explicit `begin`, a sibling `insert`,
`assert.rejects(failing statement)`, `commit`, then compare event shapes — and assert the
sibling insert's row is present afterwards, so a test that passes because the whole
transaction rolled back is caught.

Rows to include (each also asserting the catalog is unchanged — no leftover `mv` table):

- `create table … maintained as` whose body violates a declared CHECK (the repro)
- `create table … maintained as` whose body produces duplicate keys ("must be a set")
- `create materialized view` with the same duplicate-key body
- `refresh materialized view` that fails on recomputed rows
- the plain-`create table` FK-collation case, if the probe above confirms it
- one already-silent control (duplicate table name) that must stay silent

Separately, an `apply schema` case (its own `it`, in the same spec) where the generated
migration's later statement fails and the earlier statement's events are still delivered.

Existing suites that must stay green unchanged: `test/alter-table-schema-events.spec.ts`,
`test/alter-table-events.spec.ts`, `test/database-events.spec.ts`,
`test/vtab/memory-schema-ddl.spec.ts`, and `packages/quereus-store/test/alter-events.spec.ts`
(covered by `yarn test`).

## Docs

- `docs/usage.md` § *What each `ALTER TABLE` arm reports*: the "raised on the statement's
  success path only" paragraph is now a rule about **every** DDL statement, not just ALTER.
  State it once where a reader looking at schema events will meet it (the schema-event field
  table above that section is the natural home), and leave the ALTER paragraph pointing at it.
  Name the maintained-create case explicitly — it is the one users will have seen.
- `docs/module-events.md` § *A failed ALTER announces nothing, even from a native emitter*:
  retitle to cover DDL generally, keep the module-author contract intact (emit as usual; the
  engine retracts; a module that queues its own schema events until commit is past the scope
  and must drop them itself), and add the `apply schema` carve-out — a partially-applied
  migration keeps the events of the statements that landed.
- `docs/module-events.md` § *DDL coverage of the auto path* already lists which statements the
  fallback announces; add that the list is success-path-only.

## TODO

- Create `packages/quereus/src/runtime/emit/ddl-event-scope.ts`; move
  `withStatementScopedSchemaEvents` there verbatim, rewrite the docstring to state the settled
  rule (every DDL emitter; `apply schema` excluded and why; nesting reading).
- Strip the wrapper (and its now-stale "ALTER is the only statement family scoped this way"
  paragraph) from `runtime/emit/alter-schema-event.ts`; repoint the imports in
  `alter-table.ts` and `add-constraint.ts`.
- Fix the stale `runtime/emit/alter-schema-event.ts` reference in the `schemaEventSeq` /
  `discardSchemaEventsSince` docstrings in `core/database-events.ts` (it names the old file and
  calls the wrapper "the only caller" — still true of the wrapper, no longer of ALTER).
- Wrap `run()` in `create-table.ts` (both the maintained and the plain arm — one scope around
  the whole body).
- Wrap the three `materialized-view.ts` emitters: create, refresh, drop.
- Wrap `create-index.ts`, `drop-table.ts`, `drop-index.ts`.
- Wrap the currently-silent DDL emitters for uniformity: `create-view.ts`, `drop-view.ts`,
  `create-assertion.ts`, `drop-assertion.ts`, `set-object-tags.ts`.
- Leave `schema-declarative.ts` unwrapped; add a short comment at `emitApplySchema` saying why
  (its sub-statements each carry their own scope; a partial apply must keep what landed).
- Add `test/ddl-schema-event-atomicity.spec.ts` per the Tests section, both backends.
- Update `docs/usage.md` and `docs/module-events.md` per the Docs section.
- Run `yarn build`, `yarn test`, `yarn lint` (streaming output — `2>&1 | tee`), all green
  before handing off.
