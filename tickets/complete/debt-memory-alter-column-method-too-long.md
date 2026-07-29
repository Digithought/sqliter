description: A single very long method in the in-memory table code was split into one small handler per kind of column change; the review confirmed the split changed no behavior and added the unit tests it was missing.
files:
  - packages/quereus/src/vtab/memory/layer/alter-column.ts        # the extracted decide + pre-validate half (348 lines)
  - packages/quereus/src/vtab/memory/layer/manager.ts             # alterColumn ~2300, plus the 4 private apply steps below it
  - packages/quereus/test/vtab/alter-column-plan.spec.ts          # NEW — 28 unit tests over alter-column.ts
  - docs/memory-table.md                                          # Core Components entry + § DDL and transactions
----

# Complete: decompose `MemoryTableManager.alterColumn`

Behavior-preserving refactor of `alter table … alter column` in the memory virtual-table
module, plus the review pass over it.

## What shipped

`alterColumn` went from ~420 lines to ~75 that read as the ordering contract and nothing else:

```
resolve column
  → planColumnAttributeChange()      decide + pre-validate   (alter-column.ts — mutates nothing)
  → buildAlterColumnPlan()           post-change TableSchema (alter-column.ts — pure)
  → validateAlterColumnPlan()        re-keyed UNIQUE / primary-key probes
  → if (validateOnly) return         the dry-run boundary
  → applyAlterColumnToBase()         FIRST write
  → this.tableSchema = …             + initializePrimaryKeyFunctions()
  → propagateAlterColumnToOpenLayers()
  → emit schema-change event
catch → unchanged rollback
```

The new module `alter-column.ts` holds everything that is a pure function of the pre-change
`TableSchema` plus the DDL transaction's effective rows: one handler per attribute
(`set collate`, `set` / `drop not null`, `set data type`, `set` / `drop default`), each running
its own pre-validation. It may throw — that is how an illegal ALTER is rejected — but it has no
access to the manager, the base layer, or any open layer. The two loose locals `valueConvert` /
`convertNulls` became one `ValueRewrite` object, so "did a rewrite happen" is a single truthiness
check instead of three parallel tests. Returning `null` means "column already in the requested
state". The apply half (base rebuild, open-layer propagation, rollback) stayed on the manager,
which owns that state.

Review added: the unit-test net over `alter-column.ts`, and the docs corrections below.

## Validation

*   `yarn test` (all workspaces) — green, exit 0. `packages/quereus`: **7729 passing**, 13
    pending (7701 before; the 28 new tests are the delta). No failures in any workspace.
*   `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`,
    which type-checks the new spec).
*   `tickets/.pre-existing-error.md` not written — nothing failed.

## Review findings

### Correctness — checked line by line, nothing found

Read the implement diff before the handoff summary and compared the old ladder against each new
handler. Specifically confirmed:

*   **Dispatch order** unchanged (`setCollation` → `setNotNull` → `setDataType` → `setDefault` →
    throw `INTERNAL`), so a direct module call with more than one attribute populated still
    resolves the same one.
*   **The no-op returns.** The old code expressed "already in the requested state" as a bare
    `return` from inside the ladder; the new code returns `null` and the caller returns. Same
    three triggers, same skipped event emission.
*   **The one place a naive extraction would have broken.** An alias retype (`text` →
    `varchar(50)`) is *not* a no-op — the old code fell through the identity gate and still
    swapped in a fresh schema object, which the open layers must adopt or a `rollback to
    savepoint` taken across the ALTER silently drops staged rows at COMMIT.
    `planSetDataType` correctly returns a change (`metadataOnly`), not `null`. Now covered by a
    test.
*   **Scan semantics.** `hasNullValue` stops at the first NULL (the old `break`);
    `assertEveryValueConverts` never stops early (the old full loop) and still skips NULLs.
*   **Error strings** — each moved message interpolates the statement's spelling of the column
    name and the table name, matching the originals.
*   **`buildAlterColumnPlan`** — the `structuresRekeyed && schema.indexes` ternary, the
    collation propagation into PK-definition entries and index columns, `pkColumnRekeyed` being
    `set collate`-only, and the `Object.freeze` set all match the old inline code.
*   **The `AlterColumnUndo` box** is the right call, not over-engineering: the primary tree must
    be recorded *before* it is replaced, so a throw from inside `rebuildPrimaryTreeStrict` /
    `rebuildPrimaryTreeFromRows` still leaves the `catch` a live tree. Returning it from the
    apply step would lose it on exactly that path.
*   **The sync-scan atomicity argument holds.** `scanEffectiveRows` is `async`, but its sync
    branch contains no `await`, so the whole walk completes before the returned promise is
    handed back — there is no microtask gap for a concurrent autocommit write to land in. This
    is now asserted by a test rather than only argued in a comment.

One deliberate nuance, judged not a defect and recorded here rather than changed: the column's
`DEFAULT` is now folded (`tryFoldLiteral`) only when a NULL is actually seen, where the old code
folded it unconditionally before the scan. `tryFoldLiteral` is total for the literal forms it
accepts, so there is no observable difference; the new order is strictly the more forgiving one.

### Minor — fixed in this pass

*   **No unit tests existed for the extracted module.** Added
    `packages/quereus/test/vtab/alter-column-plan.spec.ts` — 28 tests, no database required,
    covering: every no-op return; the explicit-flag-only `set collate` (matching name, not yet
    explicit) versus a real name move; `drop not null` on a primary-key column; the NULL-scan
    reject and the DEFAULT backfill (including that the rewrite maps `null` and passes other
    values through); the alias retype; the primary-key retype reject; an unconvertible value;
    the comparator move; NULL rows surviving the convertibility scan; dispatch order and the
    `drop default` (explicit `null`) case; and `buildAlterColumnPlan`'s freezing, column-index
    map rebuild, untouched-column identity, collation propagation, fresh `IndexSchema` objects,
    and `pkColumnRekeyed` triggers. Two of them pin the scan-atomicity property directly: a sync
    row source is walked to completion before the call returns, an async one is not.
*   **The `docs/memory-table.md` Core Components entry was an eight-line paragraph in a list of
    one-liners.** Trimmed to a one-liner matching its siblings; the architectural prose moved
    into § *DDL and transactions*, next to the "validate before anything is mutated" rule it is
    actually about — including the sync-scan constraint, which previously lived only in a code
    comment. Re-read the rest of that section against the new code: `convertBaseRows`,
    `convertColumn`, and the `convertNulls` flag are all still real names, so nothing else went
    stale.
*   Dropped a redundant `as SqlValue` cast in `assertEveryValueConverts` (`Row` is
    `SqlValue[]`, so the element is already `SqlValue`).

### Major — none

No finding warranted a new ticket. The three handler functions are exported for testability,
which the new spec now actually exercises, so that surface is used rather than speculative.

### Tripwires — recorded, deliberately not ticketed

*   `scanEffectiveRows` in `alter-column.ts` documents why the manager's own effective-row scan
    must stay synchronous; the same constraint is noted from the manager's side on
    `effectiveRowSource`, and now also in `docs/memory-table.md` § DDL and transactions.
*   Pre-existing `NOTE:` tripwires were carried over verbatim to their new homes and re-checked:
    the unconditional value rewrite on any non-alias retype (`planSetDataType`), the
    rebuild-every-secondary-index cost (`applyAlterColumnToBase`), the O(rows) rebuild on a
    *rejected* ALTER (the `catch`), and the "if primary-key members ever become nullable"
    backfill gap (`validateAlterColumnPlan`).

### Deferred / not run — with reasons

*   **`yarn test:store` was not run.** Verified independently rather than taken on trust: no
    source file under `packages/quereus-store` references `alterColumn` at all — the store leg
    has its own ALTER implementation in `common/store-table.ts`. The diff touches only the
    memory module, so the store leg is outside the blast radius.
*   **Splitting `manager.ts` further — assessed, recommend not now.** It is 3697 lines (down
    from 3868). The remaining ALTER methods and `alterColumn`'s own apply half depend on roughly
    fifteen manager privates (`baseLayer`, `tableSchema`, `ensureSchemaChangeSafety`,
    `initializePrimaryKeyFunctions`, `adoptSchemaOnOpenLayers`, `convertColumnOnOpenLayers`,
    `installReshapeOnOpenLayers`, `openTransactionLayersOldestFirst`,
    `validateRekeyedUniqueStructures`, `validateRekeyedPrimaryKey`, `convertBaseRows`,
    `effectiveDdlRows`, `registeredConnections`, the event emitter, the schema-change latch).
    Moving them out means widening all of those to public or threading the manager instance
    through — trading real encapsulation for a line count. The seam that works is the one taken
    here: the pure decide/validate half of each ALTER extracts cleanly, the mutate half does
    not. If `manager.ts` keeps growing, apply this same seam to `addColumn` / `dropColumn` /
    `renameColumn` rather than attempting a wholesale ALTER module.
*   **The rollback `catch` is still not exercised by any test.** It is reachable only via an
    unexpected throw from `applyAlterColumnToBase`, which the pre-passes are designed to make
    unreachable. Reviewed by reading rather than by a green run; the `AlterColumnUndo` ordering
    is the load-bearing part and is argued above.
