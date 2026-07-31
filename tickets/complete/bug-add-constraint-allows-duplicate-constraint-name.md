---
description: Adding a constraint under a name another constraint on the same table already uses is now rejected instead of quietly accepted, so a table can no longer end up with two constraints answering to one name.
prereq:
files:
  - packages/quereus/src/schema/table.ts                      # namedConstraintExists + assertConstraintNameFree (the shared rule)
  - packages/quereus/src/runtime/emit/add-constraint.ts       # ADD CONSTRAINT guard
  - packages/quereus/src/runtime/emit/alter-table.ts          # assertInlineConstraintNamesFree, called from runAddColumn
  - packages/quereus/test/logic/41.6-alter-drop-rename-constraint.sqllogic  # § 7b — runs under memory AND store
  - packages/quereus/test/alter-add-constraint.spec.ts        # `duplicate constraint name` describe block
  - docs/sql-alter.md                                         # ADD CONSTRAINT bullet + ADD COLUMN inline-constraint paragraph
difficulty: medium
---

# Duplicate constraint names are refused on the ALTER add paths

`ALTER TABLE … ADD CONSTRAINT <name> …` and an inline **named** constraint on
`ALTER TABLE … ADD COLUMN` refuse a name that already addresses a CHECK, UNIQUE or
FOREIGN KEY constraint on that table:

```
Cannot add constraint 'ck' to table 't': a constraint with that name already exists
```

with `StatusCode.CONSTRAINT`, matched case-insensitively. Two inline constraints on one
`ADD COLUMN` naming each other identically are refused the same way (neither is on the
table yet, so the statement accumulates the names it has seen).

Both guards run **before** any module dispatch — a refused statement persists nothing on
the store backend — and before `assertUniqueConstraintIndexNameFree`, which is what makes
the two backends agree. The memory backend materializes a UNIQUE constraint's hidden
backing index into the table's index list and the store backend does not, so letting the
index guard rule first meant the UNIQUE-onto-UNIQUE case was refused on memory (naming an
index the user never created) and accepted on store.

Scoped out, deliberately: `CREATE TABLE` still accepts two same-named constraints (§ 7 of
the sqllogic file depends on it to assert the ambiguous-drop error), and engine-synthesized
names (`_uc_*` / `_check_*` / `_fk_*`) are never compared — only a name the user wrote.

## Review findings

Reviewed the implement diff (`a840b8b5`) before the handoff summary, then probed the
behavior directly on both backends with throwaway scripts (memory and an isolated LevelDB
store module) rather than trusting the write-up.

### Fixed in this pass (minor)

- **The rule was written twice.** Identical `namedConstraintExists` + `throw` + message
  text at both call sites, each carrying a ~20-line comment block that mostly restated the
  other. Collapsed into `assertConstraintNameFree(tableSchema, name, alsoTaken?)` in
  `schema/table.ts`, beside the predicate it wraps — one message string, one place stating
  why the guard precedes the module dispatch and the index-name check. `alsoTaken` carries
  the within-statement names, so the ADD COLUMN arm no longer needs its own throw.
- **The ADD COLUMN loop was inline in `runAddColumn`** (already a very long function).
  Extracted to `assertInlineConstraintNamesFree(tableSchema, columnDef)`; the call site is
  now one line plus the one thing local to it (refusal precedes materialization). Net −41
  lines across the two emitters, +32 in `table.ts`.
- **Test gaps closed** (4 added, all passing): an inline named FOREIGN KEY collision (the
  third class — only CHECK and UNIQUE were exercised on the inline arm); two inline
  constraints colliding case-insensitively with each other; two *unnamed* CHECKs on one new
  column still accepted (this is the case that broke the implementer's first cut — it was
  caught only by an unrelated file, `03.4-defaults.sqllogic`, and had no test of its own
  under this ticket); and `constraint ck not null` alongside a CHECK named `ck`, pinning
  that classes storing no name cannot collide.

### Verified, no change needed

- **The raw-declaration seam** the handoff asked to poke hardest (reading user-written
  names off `columnDef.constraints` instead of the extracted constraints). Correct, and now
  covered by the two-unnamed-CHECKs test above. The class filter is the same three classes
  `namedConstraintExists` searches; `notNull` / `default` / `primaryKey` / `collate` /
  `generated` names are stored nowhere, so skipping them is right, not merely convenient.
- **Plan-cache staleness.** Executing the identical `add constraint ck …` text twice
  refuses the second — the guard reads `plan.table.tableSchema`, and re-planning after the
  first ALTER is what makes that current.
- **The declarative differ path**, flagged as untested in the handoff. Probed directly:
  `apply schema` is still idempotent for a named constraint (no ADD churn on re-apply), and
  a declaration carrying an engine-shaped `_`-prefixed name — excluded from the catalog's
  user-addressable constraints, so the differ could in principle re-emit its ADD forever —
  does **not** re-add on a second apply. No convergence regression; `generateMigrationDDL`
  emits RENAME → DROP → ADD, so a name freed in the same migration is free by the time the
  ADD runs.
- **Refusal inside an explicit transaction.** Refuses identically; the surrounding
  `rollback` does not undo ALTERs applied earlier in that transaction, which is this
  engine's pre-existing DDL behavior and not something this diff touches.
- **The `derivedFromIndex` UNIQUE case** (a UNIQUE synthesized from `CREATE UNIQUE INDEX`)
  is refused with the generic message, as documented.
- **Docs.** Read both edited passages in `docs/sql-alter.md` against the measured behavior;
  they match, including the unnamed-constraint carve-out. No other doc claimed the old
  behavior.
- `yarn build` clean · `yarn lint` exit 0 · `yarn test` 8162 passing / 13 pending / 0
  failing · `yarn test:store` 8154 passing / 21 pending / 0 failing. No pre-existing
  failures surfaced; nothing skipped or loosened.

### Filed elsewhere (major)

- **Two unnamed UNIQUE constraints over one column behave differently per backend.**
  `alter table t add unique (c)` twice is refused on memory (by the index-name guard,
  naming a structure the user never created) and **accepted** on store, leaving two
  identical constraints that `drop constraint _uc_c` cannot address. Measured on both
  backends. Not a regression — this diff scoped synthesized names out — but it is the same
  divergence this ticket set out to remove, one step down. Root cause is the derived
  `_uc_<columns>` name plus a guard that can only see a materialized structure, which is
  exactly the site `tickets/fix/bug-rename-column-shifts-unnamed-unique-index-name` already
  owns, so it was appended there as a second arm rather than filed fresh.

### Recorded as a tripwire, not filed

- **A user who types an engine-shaped name forfeits the guard.** With a CHECK the user
  named `_check_b`, `alter table t add column b integer null check (b > 0)` auto-names its
  unnamed CHECK `_check_b` and the duplicate lands — after which `drop constraint _check_b`
  removes both. Verified on both backends; they agree. Reaching it requires typing the
  engine's own `_`-prefixed convention, which `isAutoConstraintName` in `schema/catalog.ts`
  already documents as forfeiting declarative lifecycle management. Parked in
  `assertConstraintNameFree`'s doc comment in `schema/table.ts`, where the next reader of
  the rule meets it.

### Checked, nothing found

- **Resource cleanup / error paths**: nothing acquired before either guard, so a refusal
  releases nothing; the ADD COLUMN refusal precedes materialization, so `revertAddColumn` is
  never entered (asserted by the existing "table unchanged" test).
- **Type safety**: no `any`, no widened types; `ReadonlySet` on the new parameter.
- **File size**: `alter-table.ts` measured at 2291 lines before this pass (`wc -l`), now
  2282. Already claimed by `tickets/backlog/debt-emit-source-files-too-large`; no new
  ticket.
