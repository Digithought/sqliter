---
description: Dropping a column is now refused when a foreign key in another table still points at it — previously the drop was accepted and left that other table impossible to write to.
files:
  - packages/quereus/src/runtime/emit/drop-column-guards.ts          # NEW assertNoForeignKeyReferencesColumn + module doc rewritten
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runDropColumn call site (~line 1154) + import
  - packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic  # NEW, 9 sections
  - docs/sql-alter.md                                                # the factually-wrong sentence replaced; restriction bullet; structural-vs-expression rule widened
  - docs/sql-ddl.md                                                  # §7.6 FOREIGN KEY paragraph; generated-column bullet cross-ref
  - packages/quereus/src/func/builtins/schema.ts                     # NOT changed — pre-existing bug found here, filed (see below)
difficulty: medium
---

# Review: DROP COLUMN refuses when another table's foreign key points at the column

## What changed and why

A foreign key stores its **parent** columns as *names* and re-resolves them against the
parent's current shape on every write. Nothing checked, at drop time, that some other table
still needed the name, so:

```sql
create table Parent (pid integer primary key, refd integer unique);
create table Child  (id integer primary key, c integer references Parent(refd));
alter table Parent drop column refd;   -- was accepted
insert into Child values (2, 100);     -- Referenced column 'refd' not found in table 'Parent'
```

The table left unwritable is a **different** table from the one altered, and the error names
a column the user deliberately removed elsewhere. Now the drop is refused with
`StatusCode.CONSTRAINT`, naming the referencing table and key:

```
Cannot drop column 'refd' from 'RefP': it is referenced by foreign key '_fk_refc_c' on table 'RefC'
```

The guard runs from `runDropColumn` **between** the CHECK guard and the assertion guard, and
before `requireVtabModule` / `module.alterTable` — so the three guards report in order of
widening blast radius (this table → another table → the whole database) and a refused
statement persists nothing.

## Design points a reviewer should check

**The refuse-vs-cascade split gained a third axis.** The prereq ticket settled
*structural* (removed with the column) vs *expression* (refuse). A foreign key pointing at
the column is structural but lives in **another table**, so it refuses — removing it would
silently weaken a constraint on a table the statement never named. That third axis is now
written into the `drop-column-guards.ts` module comment and `docs/sql-alter.md`.

**The parent is resolved exactly the way enforcement resolves it** —
`db.schemaManager.findTable(fk.referencedTable, fk.referencedSchema)`, the identical call
`planner/building/foreign-key-builder.ts:211` makes. Comparing `fk.referencedTable` to the
altered table's name by hand would have been wrong: an unqualified reference resolves through
the *session search path*, not through the child's own schema. That search-path dependence is
inherited deliberately and is noted in the guard's doc comment — whatever parent enforcement
would pick is the one this refuses over. **If a reviewer changes only one of these two call
sites, the guard silently stops matching enforcement.**

**Two skips, both load-bearing:**

- A key with **no `referencedColumnNames`** (`references Parent`) targets the parent's primary
  key, which the pre-existing PRIMARY KEY guard already refuses to drop. Skipping is not an
  oversight; the comment says so.
- A **self-referencing key this same drop removes** — on the altered table, with the dropped
  column among its *child* columns (`x integer references t(x)`). The module removes the whole
  key as part of the drop, so nothing is left pointing at the missing name. Without this skip
  the guard turns away a legal drop; §4 of the test file pins it.

**Not gated on `pragma foreign_keys`,** as the ticket specified. With the pragma off the
damage is merely latent — the schema is still wrong and switching enforcement on later bricks
the child table. This *is* a behaviour change for pragma-off users; §5 pins it.

**ADD COLUMN's revert path is unaffected** — verified: `revertAddColumn`
(`alter-table.ts:945-958`) calls `module.alterTable({type:'dropColumn'})` directly rather than
`runDropColumn`, so it never reaches this guard. Worth a reviewer's confirmation, because a
foreign key may name a not-yet-existing parent column (name resolution is deferred), so a
guarded revert *could* have thrown mid-revert and left a half-altered table.

## Test / validation surface

New file `packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic`,
no capability directive → runs under **both** memory (`yarn test`) and store
(`yarn test:store`). Sections:

1. Base case — single-column key in another table → refused; parent column still present;
   referencing table still writable *and* still rejecting orphans; `foreign_key_info` intact.
2. Multi-column key over `RefP2(a, b)` → dropping **either** `a` or `b` refused; pair still
   enforced afterwards.
3. Self-referencing, parent column ≠ child column → dropping the parent column refused;
   dropping the child column accepted and the key goes with it; then the parent column drops
   cleanly.
4. Self-referencing where parent column **is** the child column → accepted (the skip above).
5. `pragma foreign_keys = false` → refusal still fires; enforcement switched back on finds a
   coherent schema.
6. Cross-schema — `s2.xc` referencing `main.XP(refd)` explicitly → refused.
7. No parent column list (`references PkP`) → dropping a non-PK parent column accepted and
   still enforced; dropping the PK column refused by the **PRIMARY KEY** guard with its own
   message.
8. Control — dropping a different column of the same parent accepted, referencing table still
   writable and still enforcing under `pragma foreign_keys = true`.
9. Escape hatch — `alter table EscC drop constraint _fk_escc_c` then the parent drop succeeds;
   orphans then insert cleanly.

`-- error:` lines match the **referencing constraint's** auto-name, so each assertion proves
*which* key blocked the drop (same convention as `41.10`).

Commands run, all green:

- `yarn build` — pass
- `yarn lint` — pass
- `yarn typecheck` — pass
- `yarn test` — 8695 passing, 13 pending, **0 failing** (whole monorepo green)
- `yarn workspace @quereus/quereus run test:store --grep "File: 41.10.3"` — 1 passing
- `yarn docs:check` — pass (the five near-cap word-count warnings are pre-existing, on files
  this ticket never touched)

## Known gaps — treat this as the starting point, not the finish line

- **A pre-existing, unrelated bug was found and filed, not fixed:** `foreign_key_info()`
  **throws** for any foreign key declared without a parent column list (`references p`) —
  `Cannot read properties of undefined (reading 'name')`. Root cause is its own copy of the
  parent-column fallback reading `fk.referencedColumns[seq]`, which is always empty because
  resolution is deferred. Verified in-process; filed as
  `tickets/backlog/bug-foreign-key-info-throws-on-implicit-parent-columns.md`. **This is why
  §7 of the new test file asserts enforcement instead of introspection** — that section can be
  tightened once the bug is fixed.
- **Already-damaged schemas are not repaired.** A database whose column was dropped before
  this guard existed stays broken (store-backed, so it survives a reopen). Out of scope per
  the ticket — the values are gone, so there is nothing to repair automatically. No detection
  or diagnostic was added; a reviewer may want one.
- **The scan is O(all foreign keys in all schemas) per DROP COLUMN.** Recorded as a `NOTE:`
  at the scan site in `drop-column-guards.ts`, not as a ticket — trivial at today's schema
  sizes.
- **Full `yarn test:store` was NOT run** (slow); only the targeted `--grep "File: 41.10.3"`.
  The rest of the store leg is unverified against this change, though the guard is pure
  read-only schema inspection with no module interaction.
- **Not tested: a foreign key whose parent is a materialized view or lens-backed table.**
  `getAllTables()` returns those too, so such a key *would* block a drop on its parent. That
  is plausibly correct but is asserted nowhere.
- **Not tested: a dangling parent** (`references NoSuchTable(col)`), which the guard skips via
  the `!parent` branch. Reachable only through a declaration order the sqllogic files do not
  currently exercise.
- **The refusal message names `childTable.name` as stored**, which for the auto-name path is
  already lowercased by the create path. A reviewer may want the display to preserve the
  user's original casing.
