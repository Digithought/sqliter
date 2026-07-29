description: A single 420-line method in the in-memory table code was split into one small handler per kind of column change plus named apply steps, so future column-change types can be added without disturbing neighbouring ones.
files:
  - packages/quereus/src/vtab/memory/layer/alter-column.ts   # NEW — decide + pre-validate half (348 lines)
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn 2300+, and the 4 new private steps below it
  - docs/memory-table.md                                     # Core Components entry for the new module
difficulty: medium
----

# Review: decompose `MemoryTableManager.alterColumn`

Pure refactor of `alter table … alter column` in the memory virtual-table module. No behavior
change was intended, no SQL surface moved, no test was added or changed.

## What changed

`alterColumn` was ~420 lines (it had grown past the ~340 the ticket recorded) containing two
`if (collationChanged) … else if (valueConvert) …` ladders sited hundreds of lines apart. It is
now ~75 lines that read as the ordering contract and nothing else:

```
resolve column
  → planColumnAttributeChange()      decide + pre-validate   (alter-column.ts — mutates nothing)
  → buildAlterColumnPlan()           post-change TableSchema (alter-column.ts — pure)
  → validateAlterColumnPlan()        re-keyed UNIQUE / PK probes
  → if (validateOnly) return         the dry-run boundary
  → applyAlterColumnToBase()         FIRST write
  → this.tableSchema = …             + initializePrimaryKeyFunctions()
  → propagateAlterColumnToOpenLayers()
  → emit schema-change event
catch → unchanged rollback
```

**New module `alter-column.ts`** holds the half that is a pure function of the pre-change
`TableSchema` plus the DDL transaction's effective rows. It may throw — that is how an illegal
ALTER is rejected — but it never touches the manager, the base layer, or any open layer:

*   `planSetCollation` / `planSetNotNull` (+ `planTightenNotNull`) / `planSetDataType` /
    the inline `set default` case — one handler per attribute, each running its own
    pre-validation (NULL scan, convertibility scan, primary-key carve-outs).
*   Each returns a `ColumnAttributeChange`: the new `ColumnSchema` plus `collationChanged`,
    `comparatorChanged`, and a `rewrite: ValueRewrite | null`. The old pair of loose locals
    `valueConvert` / `convertNulls` is now that one `ValueRewrite` object, so the three
    "did a rewrite happen" tests are a single truthiness check on the same field.
*   Returning `null` means "column already in the requested state" — the no-op ALTER that the
    old code expressed as a bare `return` from inside the ladder.
*   `buildAlterColumnPlan` folds the change into the frozen post-change `TableSchema` and derives
    `structuresRekeyed` / `pkColumnRekeyed`.

**Stayed on the manager** (they need its state): `validateAlterColumnPlan`,
`applyAlterColumnToBase`, `propagateAlterColumnToOpenLayers`, `effectiveRowSource`.

The two load-bearing properties the ticket named both survive, and are now structural rather
than a matter of comment discipline:

*   **Validate before any mutation** — the whole decide half lives in a file that has no access
    to mutable state, and `applyAlterColumnToBase` is the single named first-write step.
*   **The rollback `catch`** — unchanged, but the saved primary tree moved from a local into a
    small `AlterColumnUndo` box passed into the apply step. That is deliberate: the tree must be
    recorded *before* it is replaced, so a throw from inside `rebuildPrimaryTreeStrict` /
    `rebuildPrimaryTreeFromRows` still leaves the `catch` a live tree to restore. Returning it
    from the apply step would have lost it on exactly that path.

Every explanatory comment was carried over to the step it now describes; none were dropped.

## Two things worth a reviewer's eye

**1. Sync scans deliberately stayed sync.** The obvious DRY move — one async generator wrapping
both the wrapper-supplied overlay and the manager's own layered walk — was rejected. `for await`
over a sync iterable yields a microtask per row, which would have opened a gap mid-scan for a
concurrent autocommit write on another connection to land in the base tree (the schema-change
latch serializes DDL, not DML). `scanEffectiveRows` in `alter-column.ts` branches on the source's
flavour instead, so the manager's own path stays atomic exactly as before. The reasoning is in
that function's doc comment; if it is wrong, the simplification is one small edit away.

**2. `manager.ts` splitting further — checked, recommend not now.** It is 3697 lines (down from
3868). The remaining ALTER methods (`addColumn`, `dropColumn`, `renameColumn`) and `alterColumn`'s
own apply half depend on roughly fifteen manager privates — `baseLayer`, `tableSchema`,
`ensureSchemaChangeSafety`, `initializePrimaryKeyFunctions`, `adoptSchemaOnOpenLayers`,
`convertColumnOnOpenLayers`, `installReshapeOnOpenLayers`, `openTransactionLayersOldestFirst`,
`validateRekeyedUniqueStructures`, `validateRekeyedPrimaryKey`, `convertBaseRows`,
`effectiveDdlRows`, `registeredConnections`, the event emitter, the latch. Moving them out means
widening all of those to public or threading the manager instance through — trading real
encapsulation for a line count. The seam that *does* work is the one taken here: the pure
decide/validate half of each ALTER extracts cleanly; the mutate half does not. If `manager.ts`
keeps growing, apply the same seam to `addColumn` / `dropColumn` / `renameColumn` rather than
attempting a wholesale ALTER module.

## Validation

*   `yarn test` (all workspaces) — green. 7701 passing in `packages/quereus`; no failures anywhere.
*   `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`).
*   `yarn build` — clean.

Relevant existing coverage, all passing unchanged (this is the behavior contract for the refactor):
`test/logic/41.2-alter-column.sqllogic`, `41.2.1-alter-column-retype-deleted-row-memory`,
`41.5-alter-misc`, `41.7-alter-column-collate`, `41.7.1-alter-column-collate-unique`,
`41.7.2-alter-column-collate-unique-store`, `41.7.3-alter-column-retype-unique`,
`41.7.3.1-alter-column-retype-staged-rows-memory`, `41.7.4-alter-column-retype-semantic-memory`,
`41.7.5-alter-column-collate-pk-staged-delete-memory`, `41.8-alter-savepoint-staged-rows`,
`90.2-alter-table-errors`, `90.2.1-alter-extra-errors`.

### Known gaps — treat the above as a floor

*   **No new tests.** A behavior-preserving refactor validated entirely by the existing suite. If
    the reviewer wants a regression net specifically around the decomposition, the highest-value
    additions are unit tests over `alter-column.ts` directly (it is now testable in isolation —
    pure functions over a `TableSchema` + a row iterable): the no-op returns (`set collate` to the
    collation already explicitly held; `set not null` on an already-NOT-NULL column), and the
    handler dispatch order.
*   **`yarn test:store` was not run.** The store leg has its own ALTER implementation
    (`packages/quereus-store/src/common/store-table.ts`) and does not call
    `MemoryTableManager.alterColumn` — only references it in comments. Judged out of the blast
    radius; re-run it if that judgement looks wrong.
*   **Untested-by-the-suite path:** the rollback `catch` is only reachable via an unexpected throw
    from `applyAlterColumnToBase`. The `AlterColumnUndo` box change is argued above but is not
    exercised by any test, because the pre-passes are supposed to make that throw unreachable.
    Worth a careful read rather than a trusted green run.
*   **Error-message fidelity** was preserved by hand, not by a test that asserts each string. The
    messages that moved into `alter-column.ts` now interpolate `ctx.columnName` (the spelling the
    statement used) and `ctx.tableName`, matching the originals — `90.2*` covers some of these.

## Review findings

*   Recorded as a code comment, not a ticket — `scanEffectiveRows` in `alter-column.ts` documents
    why the manager's own effective-row scan must stay synchronous (a `for await` wrapper would
    open a microtask gap for a concurrent autocommit write).
*   Recorded as a code comment, not a ticket — `MemoryTableManager.effectiveRowSource` notes the
    same constraint from the manager's side.
*   Pre-existing `NOTE:` tripwires carried over verbatim to their new homes: the unconditional
    value rewrite on any non-alias retype (`planSetDataType`), the rebuild-every-secondary-index
    cost (`applyAlterColumnToBase`), the O(rows) rebuild on a *rejected* ALTER (the `catch`), and
    the "if PK members ever become nullable" backfill gap (`validateAlterColumnPlan`).
*   The `manager.ts` split assessment above is the ticket's second question, answered in place —
    no follow-up ticket filed, because the recommendation is to not do it.
