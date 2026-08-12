----
description: A data-definition statement that fails part-way no longer tells listeners (or syncing peer devices) about objects it created and then removed — every such statement now announces nothing when it fails, the way ALTER TABLE already did.
files:
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts             # NEW — the moved helper + the settled rule
  - packages/quereus/src/runtime/emit/alter-schema-event.ts          # wrapper removed; keeps emitAlterSchemaEvent only
  - packages/quereus/src/runtime/emit/create-table.ts
  - packages/quereus/src/runtime/emit/materialized-view.ts
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
  - packages/quereus/src/runtime/emit/schema-declarative.ts          # emitApplySchema — deliberately NOT wrapped
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/test/ddl-schema-event-atomicity.spec.ts         # NEW — 28 assertions, both backends
  - packages/quereus/test/database-events.spec.ts                    # review: stale file pointer fixed
  - docs/usage.md
  - docs/module-events.md
difficulty: medium
----

# Every DDL statement announces nothing when it fails

## What shipped

`withStatementScopedSchemaEvents` moved out of `runtime/emit/alter-schema-event.ts` into a new
`runtime/emit/ddl-event-scope.ts`, and **every** DDL statement emitter now opens the scope
around its `run()` body, immediately after `assertDdlTransactionPolicy` and
`await db._ensureTransaction()`:

```ts
await rctx.db._ensureTransaction();

return withStatementScopedSchemaEvents(rctx, async () => {
    // … existing body, unchanged …
});
```

Wrapped: `create-table` (both arms), `materialized-view` ×3 (create / refresh / drop),
`create-index`, `drop-table`, `drop-index`, plus the currently-silent `create-view`,
`drop-view`, `create-assertion`, `drop-assertion`, `set-object-tags` — on top of the ALTER
sites that already had it. 14 call sites across 12 files.

**Not wrapped, deliberately:** `emitApplySchema` in `schema-declarative.ts`. A migration whose
Nth generated statement fails leaves 1..N-1 applied with no catalog rollback, so those must
stay announced; each generated sub-statement runs its own emitter and carries its own scope.

Docs state the rule once in `docs/usage.md` § *Every DDL statement announces on its success
path only*, with the ALTER paragraph pointing at it; `docs/module-events.md`'s module-author
section covers DDL generally and states the `apply schema` carve-out.

## Review findings

Reviewed the implement diff (`ae1214bf`) before the handoff summary. Ran the neutering
experiment, the coverage audit, and the docs pass independently rather than taking the
handoff's word.

### Verified independently — the implementer's central claims hold

- **Non-vacuity reproduced exactly.** Replaced the `discardSchemaEventsSince(watermark)` call
  in `ddl-event-scope.ts` with a no-op and ran the new spec alone: **9 of 28 failing**, split
  across both backends, matching the handoff's claim and its per-case table. Restored from a
  file copy (not `git checkout`); `git diff` on the file is empty. The spec measures the fix,
  not the fixture.
- **Coverage is complete, not just claimed.** Every entry in `runtime/register.ts`'s DDL block
  reaches a `withStatementScopedSchemaEvents` call — checked emitter by emitter, including the
  two ALTER sites and `SetObjectTags`. `DeclareSchema` / `DeclareLens` need no scope: both are
  synchronous `(rctx) => Row` emitters that mutate no catalog and raise no event.
- **Every engine auto-emit sits at the tail of its catalog mutation**, so the engine path is
  silent-on-failure for free. Confirmed at all five `emitAutoSchemaEventIfNeeded` call sites in
  `schema/manager.ts` — `dropTable`, `createIndex`, `dropIndex`, `createTable`,
  `createBackingTable` — each followed only by a `log()` or a `return`.
- **The nesting story checks out.** The only sites running nested SQL inside a scoped statement
  are the ALTER PRIMARY KEY shadow rebuild (under `withPublicEventsSuppressed`, so it batches
  nothing) and `schema-declarative.ts` (unwrapped by design). No scope nests another today.
- **`create view` / `drop view` / the assertion verbs / the tag arms do not call
  `assertDdlTransactionPolicy`** while every other wrapped emitter does. Checked, and it is
  correct: that gate exists for DDL that dispatches to a module surface, and these are
  catalog-only statements with no module call to escape the transaction.

### Fixed in this pass (minor)

- **`packages/quereus/src/runtime/emit/materialized-view.ts` — a comment asserting a leak the
  implementer's own probe disproved.** `emitRefreshMaterializedView`'s comment said the reshape
  arm's module `alterTable` ops are "announced by an emitter-backed module from inside the
  call". They are not: `reshapeOpToChange` never sets `ddl`
  (`materialized-view-helpers.ts:2375`), so modules stay silent for them — which is exactly why
  the handoff's own table records refresh as *not* a demonstrated leak on either path. Rewrote
  the comment to say what is true and why the scope is still there.
- **`packages/quereus/test/database-events.spec.ts` — stale file pointer.** The
  `beginSchemaEventScope` / `discardSchemaEventsSince` describe still pointed at
  `runtime/emit/alter-schema-event.ts` for a helper that no longer lives there, and framed the
  pair as ALTER-only. Repointed at `ddl-event-scope.ts` and widened to DDL, naming both
  end-to-end specs.

### Tripwire (recorded at the site, not filed)

- **Retraction is only right while a failed statement's catalog change does not outlive the
  failure** — the same condition the `apply schema` carve-out turns on. It holds today by
  placement (auto emits at the mutation tail; the one piece of post-emit work any DDL emitter
  still does, `dropMaintainedTable`'s `materialized_view_removed` notify, cannot throw because
  `SchemaChangeNotifier.notifyChange` swallows listener errors). A future emitter that gains
  throwing work *after* a catalog change landed would un-announce a change the catalog kept.
  Parked as a `NOTE:` in `ddl-event-scope.ts`'s docstring, next to the existing nesting NOTE.
  This is the same window the handoff flagged as "untested"; it is untestable today because
  nothing in it can fail, which is why it is a tripwire and not a ticket.

### Filed (major)

- **`tickets/backlog/debt-ddl-event-scope-kept-by-convention.md`** — the rule is enforced by 14
  hand-copied wrappers and a docstring telling the reader to grep `register.ts`. Nothing
  catches a fifteenth statement that forgets. This is not speculative: the class already
  shipped once (ALTER had the wrapper, the object-lifecycle statements did not), and this
  ticket fixed the instances while leaving the enforcement model unchanged. Filed at the
  boundary-invariant rung — apply the scope at the one registration seam, or assert at the
  event-recording seam — with the `apply schema` carve-out named as a constraint on any
  solution. Site-claim grep found no other open ticket touching these files.

### Checked and found nothing

- **Docs.** Read every touched doc section plus the surrounding ones. `docs/usage.md` and
  `docs/module-events.md` both describe the shipped behavior accurately, including the
  carve-out; the ALTER section correctly defers to the general rule instead of restating it.
  Repo-wide grep for stale `alter-schema-event.ts` references found only the one test docstring
  fixed above (the remaining `manager.ts` reference is about `emitAlterSchemaEvent`, which did
  not move).
- **DRY between the two specs.** `assertFailedDdlAnnouncesNothing` and
  `assertFailedAddColumnAnnouncesNothing` look alike but take different fixtures and assert
  different things (per-case setup and absent-object check vs. a fixed parent/child fixture).
  Sharing them would mean parameterizing away the difference for no gain. Left as-is.
- **Source hygiene.** `ddl-event-scope.ts` 73 lines, `create-table.ts` 52,
  `materialized-view.ts` 330, the new spec 336 — nothing near a split. The five near-identical
  "scope is a no-op here" comments on the silent verbs are repetitive but each states a
  different reason its statement is silent; not worth collapsing.
- **Error handling / type safety.** The helper rethrows the original error after discarding,
  adds no swallow, and is generic over the body's return type. `discardSchemaEventsSince`
  matches on per-event stamps across every savepoint layer, and the spec covers both the
  released and rolled-back savepoint cases.

### Gaps left open (deliberately, with reasons)

- **Store backend not exercised for the new cases.** Everything here ran on the memory backend
  (`yarn test`). `yarn test:store` was not run — it is the slow path and routinely exceeds the
  runner's practical wall-clock budget. `packages/quereus-store/test/alter-events.spec.ts`
  passes unchanged, which covers the store's emitter contract for ALTER but not for the
  object-lifecycle statements.
- **`drop table` of a maintained table failing after the module call stays untested**, for the
  reason recorded in the tripwire above: no failure can be constructed in that window today.
- **The silent verbs assert only "still silent".** `set-object-tags`, the assertion verbs and
  the view verbs are wrapped so a future announcing arm cannot reintroduce the class; that is
  an argument about code that does not exist yet and no test can check it.

## Validation

All from repo root, all green, re-run after this pass's edits:

- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` — every workspace passing (quereus 9541, quereus-store 1710, quereus-sync 725,
  isolation 387, the rest as usual). No failures, none pre-existing;
  `tickets/.pre-existing-error.md` was not written.
- `packages/quereus/test/ddl-schema-event-atomicity.spec.ts` alone — 28 passing; 19 passing /
  9 failing with retraction neutered.

## Out of scope — confirmed, deliberately not chased

A `create table` that fails **after** `module.create` strands the module-side table with no
catalog entry, and the name is then unusable: re-running `create table chi (id integer primary
key, z integer)` after the FK-collation failure raises `Module 'memory' create failed for table
'chi': Memory table 'chi' already exists in schema 'main'`. That is a catalog/storage drift
bug, not an event bug — retracting the event is right regardless — and the ticket explicitly
said not to widen into it. Still not filed; a reviewer or maintainer who wants it tracked has
the repro here.
