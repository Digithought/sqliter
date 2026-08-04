---
description: Dropping a column is now refused when a CHECK constraint on that table, or a database-wide integrity rule, still mentions the column — instead of being accepted and leaving the table (or the whole database) unwritable.
files:
  - packages/quereus/src/runtime/emit/drop-column-guards.ts          # NEW — the two guards
  - packages/quereus/src/runtime/emit/column-source-resolver.ts      # NEW — buildColumnSourceResolver, moved out of alter-table.ts
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runDropColumn call site; buildColumnSourceResolver removed
  - packages/quereus/src/schema/rename-rewriter.ts                   # NEW columnReferencedInAst / columnReferencedInCheckExpression; extended tableReferencedInAst doc
  - packages/quereus/src/schema/schema-differ.ts                     # stale NOTE replaced (comment only, no behaviour change)
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # NEW, 11 sections
  - docs/sql-alter.md                                                # DROP COLUMN restrictions + the structural-vs-expression rule
  - docs/sql-ddl.md                                                  # CHECK Constraints bullet
difficulty: medium
---

# Review: DROP COLUMN refuses a CHECK / assertion dependent

## What changed and why

`ALTER TABLE … DROP COLUMN` validated a fixed list of dependents — primary key,
generated-column expressions, partial-index `WHERE` predicates. Two more survived the
drop verbatim and then failed while a *write statement was being planned*, before any
row was touched:

- a **CHECK constraint** on the same table naming the dropped column → that table
  becomes unwritable;
- an **assertion** whose CHECK body names it → the *whole database* becomes
  unwritable, because the assertion evaluator recompiles every live assertion on any
  commit that touched any table.

Both are now refused with `StatusCode.CONSTRAINT`, before `module.alterTable`, so a
refused statement persists nothing.

## Design points a reviewer should check

**The refuse-vs-cascade split.** DROP COLUMN dependents divide into *structural* (a
UNIQUE, the table's own FK — defined by a column set, so losing a column makes them a
different constraint; the modules remove them with the column) and *expression*
(generated column, partial index `WHERE`, CHECK, assertion body — arbitrary logic
with no narrowed form; refuse). This is now stated in `docs/sql-alter.md` and in the
`drop-column-guards.ts` module comment. Refuse also keeps
`alter table f drop column x` consistent with `drop table f`, which
`assertNoAssertionDependsOn` already refuses over the same assertion.

**Detection is scope-aware, and that is load-bearing.** The existing partial-index
guard (`predicateReferencesColumn`) is a depth-blind name match, sound only because
partial-index predicates cannot contain subqueries. CHECK expressions and assertion
bodies **can**, so the new guards use the rename rewriter instead:
`columnReferencedInCheckExpression` (seeded — a CHECK resolves unqualified names
against its own table) and `columnReferencedInAst` (unseeded — an assertion body names
its tables explicitly). Both work by running a **real rename to a sentinel name over a
`spineCloneAst` throwaway copy**, so "refers to" cannot drift from "would have been
rewritten by RENAME COLUMN". Both are passed the catalog-backed
`ResolveColumnInSource`; **without it the subquery cases false-refuse** — that is the
single most breakable thing in this change.

`tableReferencedInAst`'s doc comment (which warns against a clone-and-identity-rename
trick) was extended to say why clone+sentinel is a *different*, sound construction:
the mutated node is discarded, and the sentinel target means `newCol !== oldCol`, so
the CTE-re-exposure branch answers as it would for a real rename.

**Placement deviation from the plan.** The ticket said to put the two probes "next to
`tableReferencedInAst`". They are instead in the file's own `// Column rename` section,
directly under `renameColumnInCheckExpression`, whose entry points they delegate to —
putting them under the `// Table rename` banner would have been actively misleading.
The doc-comment cross-reference the ticket asked for is on `tableReferencedInAst` as
specified.

**`schema-differ.ts` got a comment change only.** The old NOTE predicted this ticket
would force `namesDroppedObject` to widen to columns. It won't, and it must not — the
three declaration shapes are worked through in the replacement comment. The only shape
that now fails is a self-inconsistent declaration (removes a column, leaves an
unchanged assertion body naming it), which previously applied cleanly and bricked the
database.

## Test / validation surface

New file `packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic`,
no capability directive, so it runs under **both** the memory and store modules.
Sections:

1. Named CHECK → refused; table verified **completely untouched** afterwards (column
   present, value intact, CHECK still enforcing) — this is what proves the guard runs
   before the module.
2. Unnamed table-level CHECK → refused, message quotes the expression `(b > a)`.
3. CHECK not naming the dropped column → accepted, and still enforces afterwards.
4. CHECK whose only `v` is inside `(select min(v) from DcSrc)` → **accepted**; table
   still writable. Breaking the resolver breaks exactly this.
5. `drop constraint` → drop succeeds (escape hatch).
6. Assertion → refused, **and an unrelated table still commits writes** (the arm's real
   damage).
7. Assertion naming the table but not the column; `select *` body; assertion body whose
   `z` is another table's → all accepted.
8. `drop assertion` → drop succeeds (escape hatch).
9. Case-only (`check (B > A)`) and qualified (`check (DcQual.b > DcQual.a)`, and the
   assertion equivalent) → refused.
10. CHECK *and* assertion both naming the column → CHECK message wins (stated order).
11. Generated-column guard still fires and still wins over the CHECK guard; a table
    with no CHECKs drops cleanly.

Commands run, all green:

- `yarn build` — pass
- `yarn lint` — pass (exit 0, silent)
- `yarn typecheck` — pass
- `yarn test` — 8694 passing, 13 pending, 0 failing
- `yarn workspace @quereus/quereus run test:store --grep "41.10.2"` — 1 passing
- `yarn docs:check` — exit 0 (the five near-cap word-count warnings are pre-existing on
  files this ticket never touched)

## Known gaps — please treat these as the starting point, not the finish line

- **A CHECK on a DIFFERENT table is not guarded.** Verified in-process:
  `create table X (…, check (n < (select max(v) from T)))` then
  `alter table T drop column v` is accepted, and `X` is then unwritable with
  `Column not found: v`. Deliberately out of scope (the plan scoped arm A to the
  altered table's own CHECKs), now filed as
  `tickets/backlog/bug-drop-column-skips-check-on-another-table.md` with the repro.
- **Cross-schema references are not caught** — an assertion in schema A naming `B.t`
  explicitly. Inherited verbatim from `assertNoAssertionDependsOn`'s documented gap,
  tracked by `bug-rename-not-propagated-across-schemas`. Documented in the guard.
- **The partial-index DROP COLUMN guard has no sqllogic coverage anywhere**, and could
  not be added here: `create index … where` would force
  `requires-capability: standalone-index-ddl` and drop this file out of the store leg,
  which is the leg that matters for a persisted CHECK. §11 covers the generated-column
  guard's ordering only. Not filed — flagging for the reviewer to decide.
- **Full `yarn test:store` was NOT run** (slow); only the targeted `--grep "41.10.2"`.
- **`ResolveColumnInSource` is optional in both new probes' signatures**, mirroring the
  rename entry points, but omitting it silently produces wrong answers on the subquery
  cases. The doc comment says so; a reviewer may prefer it required.
- **`planner/building/constraint-builder.ts:69-70` hand-rolls the same resolver**
  `column-source-resolver.ts` now owns. Not unified: the new module lives under
  `runtime/emit/` (where the ticket placed it) and a `planner/` → `runtime/emit/`
  import would be the wrong layering direction. If a reviewer wants them shared, the
  module probably belongs in `schema/` next to `rename-rewriter.ts`.
- **Unnamed table-level CHECKs make a column permanently undroppable** (no name for
  `DROP CONSTRAINT` to address). Accepted by the plan, matches SQLite, documented in
  `docs/sql-alter.md`; the refusal quotes the expression so the user can see what is in
  the way. A name-free `DROP CONSTRAINT` spelling was explicitly out of scope.
- **Column-level unnamed CHECKs are auto-named and stored** (`_check_a`), so they
  report as a named constraint and *are* droppable — only the table-level unnamed form
  hits the case above. Worth confirming that asymmetry is intended.
