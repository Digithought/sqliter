description: When a transaction changes the sorting rule of a primary-key column on a persistent table and the change is refused, the error message named an internal bookkeeping table instead of the table the user actually wrote — now fixed and covered by a regression test.
files:
  - packages/quereus-isolation/src/isolation-module.ts    # new private renameOverlayInError() helper; called from the PK re-key pre-flight catch in alterTable()
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # new regression test in the "SET COLLATE on a PRIMARY KEY column judges the transaction's effective rows" describe block
difficulty: easy
----

# Re-key refusal named the internal staging table — root cause and fix

## Root cause

`IsolationModule.alterTable` (packages/quereus-isolation/src/isolation-module.ts) pre-flights a
primary-key-rekeying `ALTER COLUMN … SET COLLATE` against the issuing connection's own overlay
before touching the shared underlying table:

```ts
await ownOverlayState.overlayTable.alterSchema!(change, true);
```

The overlay is itself a `MemoryTable` backed by `MemoryTableManager`, named internally
`_overlay_<table>_<id>` (see `IsolationModule.createOverlaySchema`). When the collision this
transaction's own INSERT-then-DELETE created is confined entirely to the overlay's own layer
chain (never reaching the shared underlying table at all), `MemoryTableManager`'s representability
check (`assertNoPrimaryKeyCollisionInLayer`, packages/quereus/src/vtab/memory/layer/manager.ts)
raises `BUSY` naming `this._tableName` — the overlay's own internal name — and that error
propagated to the caller unchanged.

Every OTHER overlay-sourced error in this module is already caught and re-described with the
real schema-qualified table name (see `issuerOverlayDriftError`, `buildAlterPoisonMessage`,
`buildInPlaceAdoptPoisonMessage`, `buildDropPoisonMessage`). This one pre-flight call was the
one spot where the overlay module's raw error text reached the caller verbatim.

## Fix applied

Added `IsolationModule.renameOverlayInError(e, overlaySchema, tableName)` (isolation-module.ts,
next to `issuerOverlayDriftError`): if `e` is a `QuereusError` whose message contains the
overlay's internal schema name, returns a new `QuereusError` with that substring replaced by the
real table name (same code/cause/line/column). No-op otherwise. Wired into the PK re-key
pre-flight's catch block:

```ts
} catch (e) {
    await reinsertPkRekeyMarkers(ownOverlayState, droppedMarkerRows);
    throw this.renameOverlayInError(e, ownOverlayState.overlayTable.tableSchema, tableName);
}
```

The substring-replace approach keeps the rest of the message — including "still collide under
the new key definition", which `41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic`
matches on — untouched.

## Verification already done

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run lint` — no-op (package has no real lint config).
- `yarn workspace @quereus/isolation run test` — 387 passing, including the new regression test
  `'names the user's table, not the internal overlay staging table, when the collision is
  confined to rows this transaction both inserted and deleted'` in
  `isolation-layer.spec.ts` (inside the `SET COLLATE on a PRIMARY KEY column judges the
  transaction's effective rows` describe block).
- `yarn workspace @quereus/quereus run test` (memory mode) — 9396 passing, 25 pending, 0
  failing — no regressions in the sqllogic suite (including
  `41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic`, whose `-- error:` assertions
  are substring-based and were unaffected either way).
- Manual repro (isolated `IsolationModule` wrapping a plain `MemoryTableModule`, matching the
  ticket's `using store` shape without requiring LevelDB): confirmed pre-fix output
  `Cannot re-key the primary key of table _overlay_t_3: ...` and post-fix output
  `Cannot re-key the primary key of table t: ...`.

## Gaps / what review should double-check

- `yarn test:store` (LevelDB-backed store logic tests) was **not** run in this stage — only the
  default memory-mode `yarn test`. The ticket's original repro used `using store`; the
  regression test added here instead reproduces the identical overlay-layer-chain condition
  through a plain `IsolationModule` + `MemoryTableModule` pair (no LevelDB dependency), which
  exercises the exact code path the fix touches. Review should consider running
  `yarn test:store` once if it wants end-to-end confirmation through the real store module, but
  the code path is store-agnostic (the overlay module and its pre-flight call are identical
  regardless of which module the isolation layer wraps).
- No other call site was found that leaks an overlay's internal name into a user-facing error
  (see the root-cause section above) — this appears to be the only unguarded one — but that was
  established by reading call sites, not by an exhaustive search tool run.

## TODO

- Skim the diff in `packages/quereus-isolation/src/isolation-module.ts` and confirm
  `renameOverlayInError`'s placement/behavior reads clearly.
- Optionally run `yarn test:store` for extra confidence on the real store-backed path.
- Write the `review/` handoff with a `## Review findings` section per the ticket workflow.
