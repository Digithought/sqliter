---
description: A data-definition statement that fails part-way no longer tells listeners (or syncing peer devices) about objects it created and then removed — every such statement now announces nothing when it fails, the way ALTER TABLE already did.
files:
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts             # NEW — the moved helper + the settled rule
  - packages/quereus/src/runtime/emit/alter-schema-event.ts          # wrapper removed; keeps emitAlterSchemaEvent only
  - packages/quereus/src/runtime/emit/create-table.ts                # the verified leak (maintained + plain arms)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create / refresh / drop MV
  - packages/quereus/src/runtime/emit/create-index.ts
  - packages/quereus/src/runtime/emit/drop-table.ts
  - packages/quereus/src/runtime/emit/drop-index.ts
  - packages/quereus/src/runtime/emit/create-view.ts
  - packages/quereus/src/runtime/emit/drop-view.ts
  - packages/quereus/src/runtime/emit/create-assertion.ts
  - packages/quereus/src/runtime/emit/drop-assertion.ts
  - packages/quereus/src/runtime/emit/set-object-tags.ts
  - packages/quereus/src/runtime/emit/alter-table.ts                 # import repointed only
  - packages/quereus/src/runtime/emit/add-constraint.ts              # import repointed only
  - packages/quereus/src/runtime/emit/schema-declarative.ts          # emitApplySchema — deliberately NOT wrapped, comment added
  - packages/quereus/src/core/database-events.ts                     # two stale docstring file references fixed
  - packages/quereus/test/ddl-schema-event-atomicity.spec.ts         # NEW — 28 assertions, both backends
  - docs/usage.md                                                    # new § Every DDL statement announces on its success path only
  - docs/module-events.md                                            # § retitled to cover DDL generally + apply-schema carve-out
difficulty: medium
---

# Every DDL statement announces nothing when it fails

## What shipped

`withStatementScopedSchemaEvents` moved verbatim out of `runtime/emit/alter-schema-event.ts`
into a new `runtime/emit/ddl-event-scope.ts` (sibling to `ddl-transaction-policy.ts`; same
shape — one cross-cutting DDL-statement concern, one small file every DDL emitter imports).
The exported name is unchanged and there is no re-export shim; the two ALTER importers were
repointed.

**Every** DDL statement emitter now opens the scope around its `run()` body, immediately after
`assertDdlTransactionPolicy` and `await db._ensureTransaction()`, in the identical call shape:

```ts
await rctx.db._ensureTransaction();

return withStatementScopedSchemaEvents(rctx, async () => {
    // … existing body, unchanged …
});
```

Wrapped: `create-table` (one scope around both arms), `materialized-view` ×3 (create /
refresh / drop), `create-index`, `drop-table`, `drop-index`, plus the currently-silent
`create-view`, `drop-view`, `create-assertion`, `drop-assertion`, `set-object-tags`.

**Not wrapped, deliberately:** `emitApplySchema` in `schema-declarative.ts`, now carrying a
docstring saying why. A migration whose Nth generated statement fails leaves 1..N-1 applied
with no catalog rollback, so those must stay announced; each generated sub-statement runs its
own emitter and carries its own scope.

The invariant is greppable against the DDL block of `runtime/register.ts`: every emitter
registered there except the declarative ones calls `withStatementScopedSchemaEvents`.

## Verified during implementation (not just asserted)

Every claim below was run against the built package, not read off the code.

**Non-vacuity.** Neutering only the `discardSchemaEventsSince(watermark)` line in the new
helper turns 9 of the 28 new assertions red (and everything else green). Restored afterwards;
the neutered run is the evidence that the spec measures the fix rather than the fixture.
Which 9, and it is worth knowing the asymmetry:

| case | engine fallback | emitter-backed |
|---|---|---|
| maintained create, declared CHECK violated | leaks | leaks |
| maintained create, duplicate derived keys | leaks | leaks |
| `create materialized view`, duplicate rows | leaks | leaks |
| plain `create table`, FK collation conflict | silent already | **leaks** |
| failure inside a released savepoint | leaks | leaks |
| `refresh materialized view` failing on recomputed rows | silent already | silent already |

The FK-collation row is the ticket's "probe this" item, and it confirmed: the conflict is
raised by `validateForeignKeyCollations` in `SchemaManager.createTable`, which sits **after**
`module.create` and **before** `addTable` + the auto emit. So the engine's own path is silent
for free (it emits at the tail) and only a self-emitting module leaks. Reproduce with a parent
`k text collate nocase primary key` and a child `k text collate binary references par(k)`.

`refresh materialized view` turned out **not** to be a demonstrated leak on either path, and
the reason is worth recording rather than re-deriving: its reshape arm does drive module
`alterTable` ops, but the engine marks those calls engine-internal (no `change.ddl`), and the
memory/store modules announce iff `ddl` is set. The case is in the table anyway as a
regression guard.

**The `apply schema` carve-out has a real generated-DDL repro,** not just a comment. Declaring
`main` with a new table `n1` plus a `w INTEGER NOT NULL` column on an existing populated table
`t` generates exactly `["create table n1 (id INTEGER primary key)", "ALTER TABLE t ADD COLUMN
w INTEGER not null"]`; the ALTER fails over t's existing row, and `create/table/n1` is still
delivered on commit. That is the case that forbids a blanket statement boundary.

## Test coverage — and where the floor is

`packages/quereus/test/ddl-schema-event-atomicity.spec.ts`, 28 passing. Table-driven over
`FAILING_DDL` (6 rows) × 2 backends, plus per-backend savepoint/autocommit cases, a
success-path describe, and the `apply schema` case.

The harness (`assertFailedDdlAnnouncesNothing`) mirrors
`assertFailedAddColumnAnnouncesNothing` in `test/alter-table-schema-events.spec.ts`: explicit
`begin`, a sibling `insert into witness`, `assert.rejects(failing)`, `commit`, then compare
delivered shapes against the setup's. It asserts the witness row **is present afterwards**, so
a test that passes because the whole transaction rolled back is caught, and asserts the named
object is absent so a half-built table is caught.

**Gaps a reviewer should treat as open, not covered:**

- **`drop table` of a maintained table failing after the module call is untested.**
  `dropMaintainedTable` does post-drop work (`materialized_view_removed` and its listeners),
  but `SchemaChangeNotifier.notifyChange` swallows listener errors, so I could not construct a
  failure in that window from SQL. The scope is there; the assertion is not.
- **Store backend is untested here.** Everything runs on memory (default `yarn test`).
  `packages/quereus-store/test/alter-events.spec.ts` still passes, but no new store-path
  assertion was added. `yarn test:store` was not run (it is the slow path; ticket scope was
  `yarn test`).
- **The success-path describe pins 4 statements, not the full DDL surface.** `create table` /
  `create index` / `drop index` / `drop table`, a maintained create, a maintained drop, and
  the silent set. The per-arm ALTER shapes stay covered by the existing spec, unchanged.
- **`set-object-tags`, the assertion verbs, and the view verbs are wrapped but assert only
  "still silent".** There is nothing to retract on those today; the scope is there so a future
  arm that starts announcing (see `backlog/feat-alter-table-tags-emit-no-schema-event`) cannot
  reintroduce the class. That is an argument about future code, and the test cannot check it.

Existing suites re-run green, unchanged: `test/alter-table-schema-events.spec.ts`,
`test/alter-table-events.spec.ts`, `test/database-events.spec.ts`,
`test/vtab/memory-schema-ddl.spec.ts`, `packages/quereus-store/test/alter-events.spec.ts`.

## Validation run

All from repo root, all green:

- `yarn build` — clean.
- `yarn test` — every workspace passing (quereus 9541, quereus-store 1710, quereus-sync 725,
  isolation 387, the rest as usual). No new failures, no pre-existing failures surfaced;
  `tickets/.pre-existing-error.md` was not written.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit` on `packages/quereus`).

`yarn test:store` was **not** run (slow path, out of ticket scope).

## Out of scope — confirmed, deliberately not chased

A `create table` that fails **after** `module.create` strands the module-side table with no
catalog entry, and the name is then unusable: re-running `create table chi (id integer primary
key, z integer)` after the FK-collation failure raises `Module 'memory' create failed for
table 'chi': Memory table 'chi' already exists in schema 'main'`. That is a catalog/storage
drift bug, not an event bug — retracting the event is right regardless — and the ticket
explicitly said not to widen into it. **Not filed**; a reviewer who wants it tracked should
file it as its own `bug-` ticket with that repro.

## Review checklist

- The invariant: every emitter in `runtime/register.ts`'s DDL block calls
  `withStatementScopedSchemaEvents`, except the declarative ones. Grep and confirm.
- Placement uniformity: after the policy gate and `_ensureTransaction()`, wrapping everything
  after. Deviations are readability bugs, not correctness bugs (the watermark is
  lifetime-monotonic), but they erode the greppability the rule depends on.
- Only the schema channel is retracted. The trap is documented on `discardSchemaEventsSince`:
  the store module flushes earlier buffered writes into the batch during a DDL call, so
  previous statements' data events sit inside the failing statement's window.
- The docs now state the rule once, in `docs/usage.md` § *Every DDL statement announces on its
  success path only* (in the schema-event section, above the ALTER arm table), with the ALTER
  paragraph pointing at it. `docs/module-events.md`'s module-author section was retitled to
  cover DDL generally and gained the `apply schema` carve-out.
