---
description: Dropping a column from a table with a foreign key used to break the table — the next insert either crashed or started checking the wrong column against the parent. Now the surviving keys renumber and any key that lost a column is removed.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                        # dropColumn — FK partition/shift (~2040)
  - packages/quereus-store/src/common/store-module.ts                        # alterDropColumn — same partition/shift (~1750)
  - packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic # 10 cases, runs under both modules
  - packages/quereus-store/test/drop-column-foreign-key-reopen.spec.ts       # persist→reopen round-trip (2 cases)
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic   # §7c comment corrected (defect no longer open)
  - docs/sql-ddl.md                                                          # DROP COLUMN section (~583)
difficulty: medium
---

# DROP COLUMN now renumbers (and prunes) the table's own foreign keys

## What was wrong

A foreign key records which of **its own** table's columns it constrains by *position*
(`foreignKeys[].columns` holds indices into that table's column list). `DROP COLUMN`
already renumbered the primary key, the secondary indexes and the UNIQUE constraints when
a column disappeared from before them — but never the foreign keys. Two failure modes:

- Drop a column *before* an FK child column → the recorded index dangled past the end of
  the column array → next enforced write threw a raw `TypeError: Cannot read properties of
  undefined (reading 'name')`.
- Drop the FK's *own* child column → the key stayed put and its index silently slid onto
  whatever column took that slot, so the table began enforcing a foreign key against a
  column never declared to have one. No error at `alter` time — the worse of the two.

## What changed

Both storage backends now partition the table's own `foreignKeys` on the dropped column:

- A key that uses the dropped column as **any** of its child columns is **removed
  outright** — single-column and multi-column alike. Same call the UNIQUE path already
  made: a key missing one of its child columns is a *different* constraint against the
  parent's key, not a narrowed one.
- Every other key **survives with its child positions shifted** down over the removed slot.
- When no key survives, the field goes back to `undefined` — the shape `dropConstraint`
  already produces.

`referencedColumns` is untouched in both: enforcement resolves parent indices by name from
`referencedColumnNames` at write time.

A deliberate divergence from SQLite (which refuses the drop). It matches what the engine
already does for UNIQUE and keeps the `ADD COLUMN` revert path — which drops the
just-added column unconditionally — working.

On the store backend an unshifted index was worse than a live-schema bug: `generateTableDDL`
serializes an FK child column by resolving the recorded **index back to a name**, so the
wrong column name got **persisted**, and a reopen faithfully restored the corruption. The
reopen spec pins that; the sqllogic harness has no reconnect primitive.

## Review findings

### Checked

Read the implement diff (`9807aed1`) before the handoff summary: both module arms, the new
sqllogic file, the new store spec, the `docs/sql-ddl.md` paragraph.

- **The fix itself** — partition semantics, the frozen-array shape, `undefined`-when-empty
  (matches `dropConstraint`), and that `oldSchema`/`this.tableSchema` are the right sources
  in each arm. Correct in both.
- **Whether any drop path was missed.** `runDropColumn` requires a module `alterTable` hook
  (`StatusCode.UNSUPPORTED` otherwise) — there is no engine-side fallback that builds the
  narrowed schema itself, so the two modules are the whole surface. Confirmed the store
  rejects a non-append positioned `ADD COLUMN` (`store-module.ts:1613`), so the insert-side
  mirror has no third copy to fix. Isolation module does no index arithmetic.
- **Docs.** `docs/sql-ddl.md` is the only file stating the `DROP COLUMN` rules and its new
  paragraph matches the implemented behavior. Checked the other four docs that mention
  `DROP COLUMN` (`schema.md`, `memory-table.md`, `store.md`, `sqlite-test-crosscheck.md`) —
  none describes constraint renumbering, so none went stale.
- **Validation.** `yarn build` clean; `yarn test` 0 failing; `yarn test:store` 7323 passing /
  19 pending / 0 failing; `yarn lint` clean. All re-run after this pass's edits.

### Fixed in this pass (minor)

- **A stale comment pointed at this ticket as an open defect.**
  `41.4-alter-add-column-constraints.sqllogic` §7c explained that it deliberately avoids
  dropping a column *before* an FK child column because that is "a separate, still-open
  defect". Rewritten to say what the case actually tests and to point at the file that now
  covers the renumbering.
- **The six admitted test gaps, closed.** Every one was probed against the built engine
  first; all six already behave correctly, so they went in as regression cases (41.10 §§7–10,
  green under both `yarn test` and `yarn test:store`): an explicitly **named** key;
  a **multi-column** key whose columns all shift (the prior multi-column case only covered
  removal); **`on update cascade`** firing through a shifted position; a **deferred** key
  resolving at COMMIT; a **self-referential** key; and a key created by
  **`add column … references …`** then removed by dropping that same column — the shape the
  engine's own ADD COLUMN revert path takes.
- **A header claim that was not true.** 41.10 said keys added via `alter table add column …
  references …` were "covered separately"; no drop-after-add case existed anywhere. The new
  §10 makes the claim true and the header now points at it.

### Filed as new tickets (major)

Two reachable defects in the same statement, both pre-existing, both outside this ticket's
scope, both reproduced against the current build:

- `backlog/bug-drop-column-breaks-other-tables-foreign-key` — dropping a column that
  *another* table's foreign key points at is accepted, after which that other table cannot
  be inserted into or updated at all (`Referenced column 'refd' not found in table
  'Parent'`, raised at plan build). The original ticket scoped the parent side out; it is a
  real defect, not a theoretical one, and it lives in the engine's `runDropColumn`
  validation rather than in either module.
- `backlog/bug-drop-column-breaks-check-constraint` — the same failure for a CHECK
  constraint that names the dropped column. `runDropColumn` already refuses to drop a
  column a generated column or a partial-index predicate depends on; CHECK is the missing
  member of that family.

And one duplication ticket:

- `backlog/debt-share-drop-column-renumbering` — the two backends carry six near-identical
  copies of the "prune the ones using the removed column, shift the rest" pass. That
  duplication is *why* the FK arm was missing from both and had to be fixed twice. Not
  fixed inline: extracting the shared helper touches two packages and a public export, and
  is worth its own change with its own review rather than riding along here.

### Tripwires

One recorded, none carried over:

- The `-- error:` expectations in 41.10 match the auto-generated constraint name
  (`_fk_<table>_<cols>`), which the implementer flagged as a tradeoff worth a second
  opinion. **Verdict: keep.** The name is what proves *which* column is being enforced —
  a generic `foreign key` match would pass even if the key slid onto the wrong column,
  i.e. it would not catch the bug this file exists to catch. A `NOTE:` in the file header
  now says so and points at `41.4 §7e`, which pins the naming convention itself and would
  fail first and more legibly if it ever changed.
- The pre-existing `NOTE:` in the memory module's `dropColumn` about unshifted
  generated-column bookkeeping was left in place (the engine recomputes that graph from
  column names immediately after the call), as the implementer described. Verified.

### Not filed, deliberately

A child-side foreign key violation surfaces as `CHECK constraint failed: _fk_…` rather than
as foreign-key-worded error text. Pre-existing, cosmetic, untouched by this diff, and no
functional consequence — the right constraint is enforced and its name is in the message.
Recording it here rather than opening a ticket for error wording alone.
