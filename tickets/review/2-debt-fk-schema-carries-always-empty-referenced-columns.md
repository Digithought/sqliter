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
difficulty: easy

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
- `schema-shift-drop-column.spec.ts` and `alter-column-open-transaction-layer.spec.ts` had
  tests asserting `referencedColumns` stays `[]`/unchanged across a column shift — rewrote
  the drop-column one to assert `referencedColumnNames` is unchanged instead (same intent:
  parent-side info isn't touched by a child-table index shift); the add-column one just
  dropped the now-meaningless assertion since `columns` (child-side) is still checked.

## Verification

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 9328 passing, 25 pending (pre-existing
  skips), 0 failing.

## Review findings

None — this was a pure dead-field removal plus comment/test-fixture updates, mechanically
traced via `find_references`/grep to every construction, doc-comment, and comparison site
in the tree. No behavior change: `resolveReferencedColumns` was already the sole real
resolution path before this ticket.
