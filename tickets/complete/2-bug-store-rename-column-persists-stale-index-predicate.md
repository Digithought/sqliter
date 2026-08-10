---
description: Renaming a table or column on a persistent store briefly wrote a wrong table definition to disk before correcting it a moment later; a crash in that gap left a broken definition. It now writes the correct definition the first time.
prereq:
files:
  - packages/quereus/src/schema/rename-rewriter.ts                # + renameTableInIndexPredicates, rename{Column,Table}InCheckConstraints, rewriteEach
  - packages/quereus/src/runtime/emit/alter-table.ts              # runRenameTable rewrites the renamed table before the notify
  - packages/quereus/src/index.ts                                 # exports the four rewriters + ResolveColumnInSource + ForeignKeyConstraintSchema
  - packages/quereus-store/src/common/store-module.ts             # alterTable 'renameColumn'; renameTable; self-FK helpers
  - packages/quereus-store/test/index-persistence.spec.ts         # traceCatalogWrites + 3 partial-index tests (implement stage)
  - packages/quereus-store/test/rename-catalog-durability.spec.ts # 3 CHECK / self-FK tests (review stage)
  - docs/schema.md                                                # catalog-bundle rewrite ordering
difficulty: medium
---

# Complete: a rename never durably writes a stale table definition

## What the bug was

Every persistent table stores its own `CREATE TABLE …` text under its own catalog key.
Parts of that text name the table itself or its own columns: a partial index's `WHERE`
predicate, a `CHECK` expression, a self-referencing foreign key's target.

The engine rewrites those names *after* the storage module's rename hook returns. The
store module persists from *inside* that hook. So a rename wrote the pre-rename text to
disk, and only a follow-up change event rewrote it correctly a moment later. The final
state was always right, which is why the existing tests — all of which read the last
catalog entry — never noticed. But the first write is durable: a crash, a kill, or a
failed second write (the listener only logs a warning when its write fails) strands a
definition that names a column or table that no longer exists.

## What shipped

**Implement stage** — partial-index predicates:

- `renameTableInIndexPredicates` in `schema/rename-rewriter.ts`, mirroring the prereq
  ticket's `renameColumnInIndexPredicates`.
- The store rewrites index predicates in place before `saveTableDDL`, in both the
  `alterTable` `'renameColumn'` arm and `renameTable`, reversing on throw.
- The predicate `Expression` is shared by reference with the catalog `TableSchema` and
  with a unique partial index's derived `UNIQUE` constraint, so one in-place rewrite
  covers every holder and makes the engine's later propagation pass a no-op.

**Review stage** — the same defect on the two remaining self-naming fields, plus its
engine-side root cause (see *Review findings*):

- `renameColumnInCheckConstraints` / `renameTableInCheckConstraints`, alongside the
  index-predicate pair; all four now route through one `rewriteEach` walker.
- The store rewrites `CHECK` expressions in place, and retargets a self-referencing
  foreign key (`referencedTable` on a table rename, `referencedColumnNames` on a column
  rename) by copy — a name field, not a shared AST, so no rollback is needed.
- `runRenameTable` now rewrites the renamed table's own definition *before* the catalog
  swap and the `table_modified` notify, instead of only in the propagation pass
  afterwards.

Net effect: `RENAME TABLE` and `RENAME COLUMN` each perform exactly **one** durable
catalog write, and its content is final.

## Review findings

### Read first, then the handoff

I read the implement diff (`git show 8cb80322`) before the handoff summary, then read
`rename-rewriter.ts`, both store hooks, `alter-table.ts`'s two propagation passes, and
the memory module's `renameColumn`, and re-derived the invariant from scratch. The
handoff's central claim — that the on-disk *end* state was already correct before the
implement diff, and the real defect is a durable *intermediate* write — held up. Its
correction of the original ticket's premise was right.

### Major — found, and fixed in this pass

The implement diff fixed the invariant for **one** of the three self-naming fields.
`CHECK` expressions and self-referencing foreign keys were still durably written stale.
Confirmed by tracing every catalog write, not by reasoning:

- `create table t (id integer primary key, b integer check (b > 0)) using store` +
  `alter table t rename column b to c` durably wrote `check (b > 0)` — naming a column
  the table no longer has — before overwriting it with `check (c > 0)`.
- A table rename with a qualified `check (t.b > 0)` and a self-FK wrote **three**
  bundles: the first naming `t.b` and `references t(id)`, the second still naming
  `references t(id)`, only the third correct.

I fixed this inline rather than filing a follow-up. It is the same defect, at the same
two call sites, with the same mechanism; shipping a fix that closes one third of the
window and filing a ticket for the rest would leave the codebase in a state no reader
could reason about, and the ticket's own premise unmet.

Fixing it surfaced a **second, engine-side cause** the module could not work around: that
middle write came from the store's catalog listener firing on `runRenameTable`'s
`table_modified` notify, which carried a schema whose self-FK still named the old table.
No amount of rewriting inside the module's hook prevents it, because the hook has already
returned. So `runRenameTable` now calls the existing `rewriteTableForTableRename` on the
renamed table before the catalog swap and the notify. The pass is idempotent, so the
propagation loop afterwards finds nothing to do for that table.

### Major — found, filed, not fixed

`backlog/bug-rename-table-leaves-other-tables-catalog-stale` — the multi-table sibling.
When `parent` is renamed, `child`'s persisted definition keeps saying
`references parent (id)` until the engine's propagation pass fires an event and the store
re-saves `child`. Same crash window, but a module hook cannot fix it: it is handed one
table and cannot know which others name it. Out of this diff's blast radius; the accepted
resolution may be a narrower ordering guarantee rather than full atomicity, which is a
call for the fix ticket to make. Filed rather than fixed, and `docs/schema.md`'s
"best-effort durability" wording is what makes it a defensible deferral.

### Minor — fixed in this pass

- The four `rename*In{IndexPredicates,CheckConstraints}` entry points were four copies of
  the same loop. They now share a private `rewriteEach` walker.
- `ForeignKeyConstraintSchema` was not exported from `@quereus/quereus`; the store needed
  it to type its two new FK helpers. Exported alongside the other table-schema types.
- Comments in `alter-table.ts` and `docs/schema.md` claimed the store rewrites only
  predicates. Both now describe all three fields and the engine-side pre-notify rewrite.

### Checked, nothing found

- **Rollback.** Forward-rewrite followed by reverse-rewrite is exactly the identity on
  every input the engine admits (both walkers are idempotent, and the engine rejects a
  rename onto an existing name before the hook runs), so a throw restores the pre-hook
  AST. The `catch` arms remain the least-exercised lines in the diff — see *Not covered*.
- **Other `saveTableDDL` call sites.** `propagateTableRename` and `propagateColumnRename`
  are the only post-hook AST rewrites in `alter-table.ts`. `RENAME CONSTRAINT` changes a
  name field on a schema the hook already returned; `addColumn` / `dropColumn` /
  structural ALTERs have no post-hook rewrite. No other arm has this shape.
- **The engine's pre-notify rewrite and materialized views.** `rewriteTableForTableRename`
  preserves `derivation`, so `isMaintainedTable` still holds on the rewritten schema and
  the MV re-key path is unaffected. `mv-rehydrate-adopt`, `mv-store-backing`, and
  `view-mv-persistence` all pass.
- **Memory module divergence.** The `alter-table.ts` comment asserting that the memory
  module rewrites via the same `renameColumnInIndexPredicates` is accurate
  (`vtab/memory/layer/manager.ts:1956`).
- **Sharing.** The store's `updatedIndexes` / `renamedSchema` are shallow spreads, so the
  predicate and CHECK `Expression`s are the very objects the catalog holds. Verified by
  the tests: the propagation pass compare-skips and no second write occurs.

### Not covered — deliberately

- **The `catch` arms.** Nothing between the rewrite and `saveTableDDL` can fail on any
  input the engine admits, so there is no natural fault to inject; reaching one requires
  monkeypatching a private field. Left uncovered, as the implement stage did.
- **`table.updateSchema(updatedSchema)` is still not reversed** in the `renameColumn`
  catch. No other `alterTable` arm reverses it either, and the AST reverse alone restores
  the pre-hook expression state, so the asymmetry is pre-existing and not widened here.
- **A foreign-qualified predicate** (`where zzz.b > 0`, accepted today) still persists
  stale, because the rewriter correctly declines to rewrite a qualifier naming another
  table. Tracked by `backlog/bug-partial-index-predicate-ignores-table-qualifier`.

### Tripwires (recorded, not ticketed)

- `store-module.ts`, `renameTable` — the existing `NOTE:` at the reverse rewrite, widened
  from predicates to all expressions: the reverse assumes no expression legitimately
  named the *new* table before the rename. True for a real table, but `compilePredicate`
  currently accepts a qualifier naming a nonexistent table, so `where t2.b > 0` on a
  `t`→`t2` rename would be mis-reversed on failure. Harmless until that acceptance is
  tightened.

## Tests

Six tests total pin the invariant, all asserting on the **whole sequence** of durable
catalog writes rather than the final entry — the final entry has always been correct,
which is precisely why this survived the existing suite.

- `test/index-persistence.spec.ts` (implement stage) — partial-index predicate under
  `RENAME COLUMN` and `RENAME TABLE`, plus a `UNIQUE` partial index whose derived
  constraint must survive the rewrite and still reject an in-scope duplicate after reopen.
  The new `traceCatalogWrites()` helper lives here.
- `test/rename-catalog-durability.spec.ts` (review stage) — `CHECK` expression under
  `RENAME COLUMN`; self-FK `referencedColumnNames` under `RENAME COLUMN`; qualified
  `CHECK` plus self-FK `referencedTable` under `RENAME TABLE`. Each also reopens the
  database and asserts the constraint still enforces.

All three review-stage tests fail against the pre-fix code and pass after — verified by
neutralizing the new rewrites and re-running (0 passing, 3 failing, each on the
stale-write assertion), then restoring.

## Validation

- `yarn lint` from repo root: clean.
- `yarn test` from repo root: green — quereus 6776 passing / 9 pending / 0 failing
  (unchanged), store 811 passing (up 3 from the implement stage's 808), every other
  package unchanged.
- `yarn test:store`: green — 6770 passing, 15 pending, 0 failing.
- `tsc -p tsconfig.test.json --noEmit` in `packages/quereus-store`: clean. (The root
  `yarn lint` only type-checks `packages/quereus`'s test files, so the new spec's types
  are not covered by it — run directly.)
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
