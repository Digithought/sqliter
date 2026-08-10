---
description: Dropping a column is now refused when a foreign key in another table still points at it — previously the drop was accepted and left that other table impossible to write to.
files:
  - packages/quereus/src/runtime/emit/drop-column-guards.ts          # assertNoForeignKeyReferencesColumn + two helpers; module doc rewritten
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runDropColumn call site (~line 1154)
  - packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic  # 12 sections
  - docs/sql-alter.md                                                # DROP COLUMN restriction bullet + the structural/expression/other-table rule
  - docs/sql-ddl.md                                                  # §7.6 FOREIGN KEY paragraph; generated-column bullet cross-ref
difficulty: medium
---

# Complete: DROP COLUMN refuses when another table's foreign key points at the column

## What shipped

A foreign key stores its **parent** columns as names and re-resolves them against the
parent's current shape on every write. Nothing checked, at drop time, that another table
still needed the name, so the drop was accepted and the *referencing* table became
unwritable — failing with an error about a column the user had deliberately removed
somewhere else.

`runDropColumn` now calls `assertNoForeignKeyReferencesColumn` between the CHECK guard and
the assertion guard, before `requireVtabModule` / `module.alterTable`, so the three guards
report in order of widening blast radius (this table → another table → the whole database)
and a refused statement persists nothing:

```
Cannot drop column 'refd' from 'RefP': it is referenced by foreign key '_fk_refc_c' on table 'RefC'
```

Refusal is not gated on `pragma foreign_keys` — with the pragma off the damage is merely
latent, and switching enforcement on later would brick the child table.

Two skips are load-bearing and both are pinned by test: a key with no declared parent
column list (its target is the primary key, which is already undroppable), and a
self-referencing key on the altered table whose *child* columns include the dropped column
(the module removes that key as part of the same drop).

## Review findings

### Checked and clean

- **Guard placement and transactional safety.** All three guards run before any module
  call; a refusal leaves the table untouched rather than reverted. Confirmed by reading
  `runDropColumn`.
- **`ADD COLUMN` revert path unaffected.** `revertAddColumn` calls
  `module.alterTable({type:'dropColumn'})` directly, never `runDropColumn`, so a revert
  cannot throw mid-way on a key naming a not-yet-existing parent column. Confirmed by
  reading the call site.
- **Self-referencing multi-column cases.** Walked by hand for
  `foreign key (a) references t(b)`, `foreign key (b) references t(b)`, and
  `foreign key (a,b) references t(b,c)` under each column's drop — the skip fires exactly
  when the drop removes the whole key.
- **Auto-name fallback.** `fk.name ?? _fk_<table>` matches the convention already used at
  `planner/building/foreign-key-builder.ts:241` and `core/derived-row-validator.ts:270`.
  In practice `fk.name` is always populated by both build paths.
- **Docs.** `docs/sql-alter.md` and `docs/sql-ddl.md` were re-read end-to-end against the
  shipped behavior; every claim in the new prose is pinned by a test section. No further
  doc drift found — the pages the change *should* have touched are the two it did.
- **Lint / typecheck / tests.** All green; see *Validation* below.

### Fixed in this pass (minor)

- **The guard's doc comment described a hazard that cannot occur.** It claimed
  `findTable(fk.referencedTable, fk.referencedSchema)` inherits a dependence on the session
  search path, so "a key can bind to a different parent than its spelling suggests".
  `referencedSchema` is always populated at build time (`constraint-builder.ts:96`,
  `manager.ts:1803`, both `?? childSchemaName`), so `_findTable` always takes its
  qualified-lookup branch and the search path is never consulted. An unqualified reference
  binds to the **child's own schema**. Verified in-process. The paragraph was rewritten to
  say what actually happens.

- **The scan was hand-rolled over the whole catalog when a cached index for exactly this
  question already exists.** `SchemaManager.getReferencingForeignKeys(parentSchema,
  parentTable)` is the reverse FK index `DROP TABLE`'s parent-side guard
  (`assertNoReferencingChildrenForDrop`) already uses; it buckets each key under
  `fk.referencedSchema ?? childTable.schemaName` + `fk.referencedTable`, which — given the
  finding above — is the same parent enforcement resolves. The triple-nested
  `_getAllSchemas` → `getAllTables` → `foreignKeys` walk, the `findTable` call, the parent
  identity comparison and the `NOTE:` performance tripwire were all replaced by one loop
  over that index. The body was also split into two named predicates
  (`namesParentColumn`, `dropRemovesKeyOutright`) rather than four inline `continue`s.

- **Three test gaps, all now covered** (§ 10–12 of the sqllogic file, passing under both
  the memory and store modules):
  - § 10 — two parents both owning a `refd`, only one referenced: dropping the *unreferenced*
    one's `refd` is accepted. This is the guard's identity half; without it a regression to
    naive parent-column-name matching passes the whole suite.
  - § 11 — a key whose parent table does not exist. The implement handoff called this
    unreachable through sqllogic; it is not (`references NoSuchParent(refd)` is accepted at
    create time), so it is now pinned rather than assumed.
  - § 12 — a key created *after* an earlier drop already warmed the reverse-FK cache, via
    both `ALTER TABLE … ADD CONSTRAINT` and a late `CREATE TABLE`. This is a regression
    guard for the index reuse above: the previous full scan could not go stale, and the
    index can. § 9 already covered the removal direction.

### Filed as new tickets (major, out of scope here)

- `tickets/backlog/bug-foreign-key-to-missing-parent-fails-writes-with-opaque-message.md`
  — a foreign key naming a table that does not exist is accepted silently, and every later
  non-NULL insert fails with `CHECK constraint failed: _fk_x_c (NEW.c is null or 0)`, a
  synthesized expression that mentions neither the missing table nor that one is missing.
  Reached by a second and much less obvious route as well: an **unqualified** parent
  reference binds to the child's own schema, so a child in an attached schema referencing a
  `main` table compiles to the same permanently-failing constraint. Pre-existing, one code
  site (`foreign-key-builder.ts`'s `!parentSchema` fallback), `repro: verified`. Found while
  confirming the guard resolves parents the way enforcement does; the guard's behavior is
  consistent with it (an unresolvable parent constrains nothing, so it blocks no drop —
  § 11).

- `tickets/backlog/bug-foreign-key-info-throws-on-implicit-parent-columns.md` — filed by
  the implement stage, confirmed still open and still correct. `foreign_key_info()` throws
  for any key declared without a parent column list. This is why § 7 asserts enforcement
  rather than introspection; that section can be tightened once it is fixed.

### Corrections to the implement handoff

- The handoff listed *"the refusal message names `childTable.name` as stored, which for the
  auto-name path is already lowercased by the create path"* as a possible polish item.
  Casing is in fact **preserved** — `create table BC (… references BP(refd2))` yields
  `_fk_BC_c` and the message says `on table 'BC'`. Verified in-process. Nothing to fix; the
  sqllogic `-- error:` matcher is case-insensitive, which is why the lowercase expectations
  in the test file pass either way.
- The handoff called the dangling-parent case unreachable through sqllogic. It is
  reachable; see § 11 above.

### Recorded as tripwires, not tickets

- **Discovery now depends on reverse-FK-index freshness.** Noted in the guard's doc
  comment, and pinned by § 12 rather than left to trust. Conditional: it only becomes work
  if an invalidation site is ever missed, and § 12 fails loudly if one is.
- **A lens logical foreign key is not seen by this guard.** Logical FKs live on a lens
  slot's `enforced-fk` obligation, not in any table's `foreignKeys`, so dropping a basis
  column a logical FK points at is not refused. Deliberately not filed: `ALTER TABLE`
  against a lens basis table is *entirely* ungoverned today (`alter-table.ts` never mentions
  lens slots), so the FK arm is not specially broken and a narrow FK-only ticket would name
  the wrong root cause. Recorded here as the index entry; the wider surface belongs to
  whoever takes on lens-vs-DDL.

### Deliberately not covered

- **A parent that is a materialized view.** `getAllTables()` returns maintained tables, and
  they can carry foreign keys, so such a key would block a drop on its parent. Plausibly
  correct, still asserted nowhere. Left alone rather than guessed at — a materialized view
  as an FK *parent* has no other coverage in the suite to build on.
- **Repairing already-damaged schemas.** A database whose column was dropped before this
  guard existed stays broken; the values are gone, so nothing can be repaired
  automatically. Out of scope per the original ticket, and unchanged by this review.
- **Full `yarn test:store`.** Not run — wall-clock exceeds the agent idle budget. The
  targeted store leg for `41.10*` was run and passes; the guard is read-only schema
  inspection with no module interaction.

## Validation

All run from the repo root after the review's changes:

- `yarn build` — pass
- `yarn lint` — pass
- `yarn typecheck` — pass
- `yarn test` — **8695 passing, 13 pending, 0 failing** (whole monorepo)
- `yarn workspace @quereus/quereus run test --grep "41.10"` — 4 passing
- `yarn workspace @quereus/quereus run test:store --grep "41.10"` — 4 passing
- `yarn docs:check` — pass (five near-cap word-count warnings are pre-existing, on files
  this ticket never touched)
