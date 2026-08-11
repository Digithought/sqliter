description: A foreign key's stored list of parent column positions was always empty and nothing read it, but its name suggested it held real data — that trap already caused one crash. The dead field is now removed.
files:
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/schema/constraint-builder.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/planner/util/ind-utils.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/test/util/schema-equivalence.ts
  - packages/quereus/test/optimizer/inclusion-dependencies.spec.ts
  - packages/quereus/test/optimizer/statistics.spec.ts
  - packages/quereus/test/planner/stats/catalog-stats.spec.ts
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts
  - packages/quereus/test/schema-shift-drop-column.spec.ts
  - docs/optimizer-rule-families.md

# Foreign key schema no longer carries a dead `referencedColumns` field

`ForeignKeyConstraintSchema.referencedColumns: ReadonlyArray<number>` is removed. It was
always frozen-empty at construction (`constraint-builder.ts`, `schema/manager.ts`) and
nothing read it in production code — the real resolution path is
`resolveReferencedColumns(fk, parentSchema)` (`schema/table.ts`), which works from
`referencedColumnNames` or falls back to the parent's primary key.

## What changed

- Removed the field from the `ForeignKeyConstraintSchema` interface (`schema/table.ts`).
- Removed the two `referencedColumns: Object.freeze([])` writes in
  `constraint-builder.ts::buildForeignKeyConstraintSchema` and
  `manager.ts::extractForeignKeys`.
- Restated the doc comments in `planner/util/ind-utils.ts`, `planner/util/key-utils.ts`,
  `schema/table.ts` (`shiftSchemaIndicesForDrop`), and
  `vtab/memory/layer/manager.ts` (`shiftSchemaIndicesForInsert`) that described the
  positional-alignment invariant in terms of `fk.referencedColumns[i]` — they now point at
  the *resolved* parent column (via `resolveReferencedColumns`) instead of a stored index.
- Updated test fixtures that constructed `ForeignKeyConstraintSchema` literals with a
  `referencedColumns` property (`inclusion-dependencies.spec.ts`, `statistics.spec.ts`,
  `catalog-stats.spec.ts`, `schema-shift-drop-column.spec.ts`) to drop it.
- `schema-equivalence.ts::assertFkListEqual` no longer compares `referencedColumns`
  (nothing stores it now); the `referencedColumnNames` comparison right below it already
  covers the same information.
- `schema-shift-drop-column.spec.ts` asserts `referencedColumnNames` is unchanged across a
  child-side column shift (same intent as the old `referencedColumns` assertion).
- Review pass: `docs/optimizer-rule-families.md` § FK-derived rules now describes the
  positional pairing as `fk.columns[i] → resolveReferencedColumns(fk, parent)[i]`.
- Review pass: `alter-column-open-transaction-layer.spec.ts` (ADD COLUMN arm) re-asserts
  parent-side info survives a child index shift, via `referencedColumnNames`.

## Verification

- `yarn typecheck` (all workspaces) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 9328 passing, 25 pending (pre-existing
  skips), 0 failing.

## Review findings

**Checked.** Read the implement diff (commit `85b80ab4`) before the handoff summary. Swept
the whole repo — not just `packages/quereus` — for `referencedColumns` across `.ts`,
`.tsx`, `.md`, `.json`, and separately for `referencedTable` / `referencedColumnNames`, to
confirm no reader, serializer, schema-differ path, store/plugin package, or UI touched the
removed field. The only surviving `referencedColumns` identifiers are the unrelated
memory-vtab predicate compiler (`vtab/memory/utils/predicate.ts` and its two consumers) —
a `Set<number>` of columns a compiled predicate reads, no relation to foreign keys.
Verified `resolveReferencedColumns` / `resolveReferencedColumnsForEnforcement` are the sole
resolution path and are unaffected. Ran lint, full quereus test suite, and a root-wide
typecheck (which covers `quereus-store`, the only other package that manipulates FK
schemas).

**Minor — fixed in this pass (2).**

- `docs/optimizer-rule-families.md:186` still documented the `lookupCoveringFK` alignment
  rule as `fk.columns[i] → referencedColumns[i]`, naming a field that no longer exists.
  The implement pass updated the four in-source doc comments saying this and missed the
  one doc file. Rewritten to name the resolution call.
- `alter-column-open-transaction-layer.spec.ts` (`shifts foreign-key child columns and
  generated-column bookkeeping`) deleted its parent-side assertion outright rather than
  restating it, so the ADD COLUMN arm no longer checked that a child-table index shift
  leaves parent-side FK information alone — the drop-column sibling test kept exactly that
  coverage by switching to `referencedColumnNames`. Restored the assertion in the same
  form, so both arms of the shift pair assert the same invariant.

**Major — none.** No behavior change is possible from this diff: the field was write-only
(two frozen-empty writes, zero reads), and every construction, comparison, and doc site was
accounted for. Nothing to climb the architecture ladder for — the ticket *is* the
representation fix (removing a field whose presence invited reading garbage).

**Tripwires — none recorded.** The one candidate considered was that
`resolveReferencedColumns` does a name→index map lookup per parent column at every
enforcement call rather than caching. That behavior predates this ticket and is unchanged
by it, and `schema/table.ts:1010-1016` already documents *why* resolution is deferred
(the parent may not exist at CREATE TABLE time, and its column list can change later), so
there is nothing new for a future reader to be warned about here.

**Accepted tradeoffs — none encountered.** No `NOTE:` markers at any touched site.
