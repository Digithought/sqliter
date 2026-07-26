---
description: A write's values are now converted to their declared column types once, at the top of the write pipeline, so updating one column no longer silently rewrites or errors on a JSON column the statement never touched.
files:
  - packages/quereus/src/types/validation.ts                 # buildRowCoercion — the static-type mask
  - packages/quereus/src/runtime/emit/insert.ts              # converts the NEW section by source-attribute types
  - packages/quereus/src/runtime/emit/update.ts              # two-phase conversion around generated columns
  - packages/quereus/src/runtime/emit/constraint-check.ts    # coerceNewSection deleted; OR REPLACE DEFAULT substitution converts its one cell
  - packages/quereus/src/runtime/emit/dml-executor.ts        # preCoerced on all 4 vtab.update sites; DO UPDATE assignment conversion
  - packages/quereus/src/runtime/foreign-key-actions.ts      # anyReferencedColumnChanged is plain identity (+ caller-contract NOTE)
  - packages/quereus/src/planner/nodes/dml-executor-node.ts  # conflictTargetTypes plan field removed
  - packages/quereus/src/planner/building/insert.ts          # ...and no longer populated
  - packages/quereus/src/vtab/table.ts                       # UpdateArgs.preCoerced contract
  - packages/quereus/src/vtab/memory/layer/manager.ts        # honors preCoerced
  - packages/quereus-store/src/common/store-table.ts         # honors preCoerced (pre-existing)
  - packages/quereus-isolation/src/isolated-table.ts         # honors preCoerced, forwards it to overlay writes
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic   # memory + store coverage
  - packages/quereus-store/test/json-semantic-key-order.spec.ts    # UPDATE section; six-kinds test reworked
  - docs/types.md                                            # § "Where coercion happens"
  - docs/runtime.md                                          # deferred-constraint row description
difficulty: hard
---

# Convert a write's values once, where their type is known

## What shipped

A DML write's cells are converted to the declared column logical types **once, in
the DML emitters**, and a cell converts **iff the producing expression's static
`LogicalType` is not — by object identity — the column's type**. The type registry
hands out one shared instance per type, so identity comparison is sound: a
reference to a same-typed column (an unassigned UPDATE column, `insert into b
select j from a`) matches exactly and skips conversion. That skip is the fix.
JSON conversion is not repeatable — the stored text `9` re-parses to the number 9,
and `abc` throws — so re-converting a value that came out of storage either
damages it or fails a statement that never mentioned the column.

- `buildRowCoercion` (`types/validation.ts`) precomputes the per-statement mask and
  returns `undefined` when nothing converts, so unaffected statements pay nothing
  per row.
- `emitInsert` masks by the source relation's attribute types (the builder projects
  the source into table-column order).
- `emitUpdate` masks assigned columns by their assignment expression's type and
  unassigned columns by the source attribute's type — never by an
  "unassigned ⇒ converted" assumption.
- Two late-injection paths convert their single cell by the same rule: the
  `OR REPLACE` NOT NULL DEFAULT substitution and `ON CONFLICT … DO UPDATE`
  assignments.
- The executor passes `preCoerced: true` on all four `vtab.update` sites. The
  memory manager, `StoreTable`, and `IsolatedTable` all honor it; `IsolatedTable`
  also forwards it to every overlay data write.
- Downstream re-conversions were deleted: `coerceNewSection`, the per-row affinity
  coercion in `conflictTargetValuesMatch`, and the coerce-and-recompare fallback in
  `anyReferencedColumnChanged`. The now-unused `conflictTargetTypes` plan field went
  with them.

Writes that do not come through the DML executor — direct `vtab.update` API use,
external-change apply, materialized-view maintenance — leave `preCoerced` unset and
the storage layer converts for them as before. The public vtab contract is unchanged.

## Behavior changes

1. **NOT NULL now sees the converted value.** JSON text `'null'` converts to SQL
   NULL, so inserting it into a NOT NULL (or PRIMARY KEY) JSON column now fails NOT
   NULL. Previously the check inspected the raw text, passed, and the storage layer
   silently stored a NULL key in a NOT NULL PK column. Pinned in both the sqllogic
   file and the store spec; the store spec's "six JSON kinds" scan test was reworked
   because its `'null'` PK row is now rejected (the null *rank* is pinned via
   ORDER BY on a nullable column instead).
2. **Identity-matched cells skip validation, not just parsing** — the rule trusts
   declared static types. See finding 1 below.
3. **Conversion errors surface earlier** (emitter rather than storage layer), before
   constraint checking. Message text is unchanged.

## Review findings

Reviewed the implement diff (`c4749ca0`) first, then the handoff. Ran `yarn build`,
`yarn lint`, `yarn typecheck`, `yarn test` (all workspaces), and `yarn test:store` —
all green before and after the review's own edits (quereus 7189 passing / 13 pending;
store mode 7183 passing / 19 pending; store package 1017; isolation, sync, plugin
packages all passing). No pre-existing failures surfaced, so no
`tickets/.pre-existing-error.md` was written.

### Fixed in this pass (minor)

- **`update.ts`: a generated column derived from the pre-conversion value of a
  sibling assignment.** The handoff called this "unchanged from HEAD"; it is not — it
  is a regression. Before the change the storage layer converted every cell including
  the generated one, so the generated column and its source agreed. Afterwards
  `emitUpdate` evaluated generated expressions against the raw assignment and then
  skipped converting the result (the generated expression is a column reference, so
  its static type matches the column and identity-matches out of the mask). Repro:
  with `g json generated always as (j)`, `update t set j = '{"k":1}'` stored `j` as
  the object but `g` as the JSON *string* `{"k":1}`. Fixed by splitting the mask
  across the two assignment phases — regular assignments convert before the
  generated expressions read them, generated cells convert after. Pinned in
  `06.9.1-json-coerce-once.sqllogic`.
- **Untested new branch: the `OR REPLACE` NOT NULL DEFAULT substitution.** The
  `coerceColumn` path and its post-conversion NULL re-check had no coverage. Added
  three sqllogic cases (a TEXT DEFAULT that converts, a DEFAULT that converts to SQL
  NULL and must still fail NOT NULL, and a `json()`-typed DEFAULT that is substituted
  untouched). All three already behaved correctly.
- **`docs/types.md` understated the caveat.** It named only third-party functions
  that declare a return type. Rewrote it as an explicit list of nodes that can
  advertise a logical type they do not produce, with the two concrete cases found
  below and their ticket slugs.

### Filed as new tickets (major)

Both are the same shape as behavior change 2: an expression node advertises a
logical type it does not actually produce, and the write path now takes that
declaration at its word.

- `fix/union-branch-value-not-converted-on-write` — `SetOperationNode` reports its
  LEFT arm's logical type for every output column, so `insert into t select j from a
  union all select '"9"'` stores the right branch's TEXT literal raw into a JSON
  column, and the same statement with the branches swapped fails outright with
  `Cannot convert 'abc' to JSON`. Verified against `c4749ca0`.
- `fix/failed-cast-stores-unconverted-value` — when a target type's `parse` throws
  and the type has no numeric/text fallback, `emitCast` returns the operand unchanged
  while still advertising the target type. `insert into d values (1, cast('junk' as
  date))` therefore succeeds and stores `'junk'` in a DATE column, while the same
  value written directly is correctly rejected. Verified against `c4749ca0`. The
  ticket also notes that `CastNode.generateType` (`getTypeOrDefault`) and `emitCast`
  (`inferType`) resolve the target type differently for parameterized spellings.

Both were filed rather than fixed here because the fix is a semantic decision about
`UNION` type merging and `CAST` failure results respectively, not a local correction —
and neither is confined to the write path.

### Tripwires (recorded, not ticketed)

- **`anyReferencedColumnChanged` now trusts its callers to pass declared-form rows.**
  All present callers do — I traced the materialized-view path specifically: it passes
  the changes `host.applyMaintenance` reports, i.e. what the backing actually stored,
  not the proposed row. A future caller handing in a raw NEW row would get a spurious
  "changed", which is harmless on the cascade path but a spurious RESTRICT error on
  the assert path. Parked as a `NOTE:` on the function in
  `runtime/foreign-key-actions.ts`.
- **The `coerceRowToSchema` "too many values" width guard no longer runs for engine
  writes.** Structural on those paths today (the builders project the source into
  table shape). The implementer's existing `NOTE:` in `vtab/memory/layer/manager.ts`
  already says to hoist the guard if that stops holding; verified it is accurate and
  left it as the home for this.

### Checked and found clean

- **`preCoerced` plumbing.** All four `vtab.update` sites; both storage backends
  (`MemoryTableManager.performInsert`/`performUpdate`, `StoreTable`) honor the flag;
  `IsolatedTable` forwards it on every overlay data write including
  `writeRelocatedRow` and the tombstone-revive update, and still converts for its own
  PK-extraction/conflict-detection when a direct API caller leaves it unset while
  handing the overlay the raw row. Exercised a PK-relocating UPDATE on a JSON
  string-scalar key inside a transaction — correct.
- **Every DML executor entry point converts.** Only three builders construct a
  `DmlExecutorNode` (insert, update, delete), and the insert/update ones always place
  their emitter node beneath it, so no write reaches `preCoerced: true` without having
  passed through a mask. `DELETE` sets the flag but only vouches for `oldKeyValues`,
  which come from the scan.
- **Deferred-constraint row aliasing.** The queued row used to be a private
  `coerceNewSection` copy and is now the same object that flows downstream. Nothing
  mutates it in place — `withStoredNewSection` copies when the stored row differs, and
  both emitters allocate a fresh flat row per iteration — so there is no aliasing bug.
- **Other candidate "lying" expressions**, probed against the built engine: `CASE`
  with mixed branch types (collapses to TEXT, so it converts), `coalesce`, bound
  parameters, scalar subqueries, and INSERT-side generated columns all behave
  correctly.
- **Docs.** `docs/types.md` § "Where coercion happens" and `docs/runtime.md`'s
  deferred-constraint row description both match the new reality; the stale
  `bug-dml-downstream-uses-uncoerced-row` reference was correctly dropped (that
  ticket is no longer on the board and the change resolves its symptom). The
  in-test explanatory comments in `15.1.1-json-check-coercion.sqllogic` and
  `type-system.spec.ts` were updated too.
- **Source hygiene.** No new file-size or decomposition problems: `buildRowCoercion`
  is a single small helper, the emitter changes are precompute-at-emit plus one call
  per row, and the diff is net-deleting in `constraint-check.ts`,
  `foreign-key-actions.ts`, and the `conflictTargetTypes` plan plumbing. Comment
  density is high but each block explains a non-obvious invariant.

### Not touched

- `backlog/bug-json-typed-comparison-reparses-text-literal` — filed by the
  implementer while writing tests, out of scope here.
- `backlog/bug-json-text-scalar-reparsed-on-write` — describes exactly the defect this
  work fixed and reads as superseded. Left in place for a human to retire rather than
  deleting someone else's backlog entry.
