---
description: A table rule written with the "new." or "old." row prefix used to be invisible to renaming and dropping a column, leaving the table unwritable; it is now rewritten on rename and refuses the drop, same as the plain spelling.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                  # matchesRowImage + isQualifierReboundAboveSeed; third accept path in visitColumnRename's `column` case
  - packages/quereus/src/runtime/emit/drop-column-guards.ts         # doc-comment only
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # §12, §13, §14
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic                  # §24–§28
  - docs/sql-ddl.md                                                 # § CHECK Constraints
  - docs/sql-alter.md                                               # § RENAME COLUMN, § DROP COLUMN
repro: verified
---

# `new.` / `old.` row-image qualifiers in CHECK follow RENAME COLUMN and block DROP COLUMN

## What was wrong

A CHECK constraint may name the row being written explicitly — `check (new.a > 0)`,
`check on delete (old.a > 0)`. Neither `ALTER TABLE … RENAME COLUMN` nor
`ALTER TABLE … DROP COLUMN` could see a column named that way, because both decide what
a qualifier refers to by resolving it against the FROM clauses the AST walk has
descended, and `new` / `old` name a row image that never appears in a FROM clause. Both
statements succeeded and left the table unwritable: every later INSERT (or DELETE, for
the `old.` form) failed while being planned, with `new.a isn't a column`.

## What shipped

One behavior site: the `column` case of `visitColumnRename` in
`packages/quereus/src/schema/rename-rewriter.ts` gained a third accept path beside "the
qualifier is the table's name" and "the qualifier is an alias bound to the table".

- `ColumnRewriteState.matchRowImageQualifier` is set only by the seeded entry point
  `renameColumnInCheckExpression`, which is entered for one specific table and pushes an
  implicit scope frame for it. The unseeded `renameColumnInAst` leaves it false, so a
  `new.` reference in some *other* table's CHECK is never mistaken for this table's row
  image.
- `matchesRowImage()` accepts a qualified reference when the flag is set, the reference
  has no schema part, the qualifier folds to `new` or `old`, and
  `isQualifierReboundAboveSeed()` finds no enclosing FROM/WITH frame binding that
  qualifier to a row source of its own. `new` and `old` are not reserved words in this
  parser, so that last test is load-bearing: `create table "new" (…)` is legal and a
  CHECK subquery may read from it.
- The new path is tried last, so a table genuinely named `new` or `old` that is itself
  the renamed table keeps resolving through the existing direct-hit path.

The DROP COLUMN guard (`assertNoCheckConstraintNamesColumn`) is defined as "refuse
exactly what a rename would have rewritten" — it runs the same walk against a throwaway
clone — so fixing the walk fixed the refusal and the rewrite together.

Documentation: `docs/sql-ddl.md` § CHECK Constraints, and `docs/sql-alter.md` under both
RENAME COLUMN and DROP COLUMN.

## Review findings

**Diff read first, from the implement commit `3bd01d40`, before the handoff summary.**
Behavior was probed directly against a live in-process `Database` (memory module) across
roughly twenty SQL shapes, not only through the committed sqllogic files.

### Correctness — the one behavior site holds up

Every claim the implementer made about scoping was re-derived independently and checked
by running it:

- **The index-1 seed assumption in `isQualifierReboundAboveSeed` is sound.** Frame 0 is
  the implicit seed; every other frame is pushed by a `select` the walk has descended
  into (`visitColumnRename` pushes a with-frame *and* a FROM frame per select,
  unconditionally), so a frame above index 0 genuinely encloses the reference being
  visited. The "any enclosing frame wins" scan is therefore equivalent to
  innermost-first here, as the comment argues.
- **All four rebind branches behave correctly** — unaliased source (`from "new"`), alias
  (`from U as "new"`), CTE in scope (`with "new" as (…)`), and shadowing-but-not-exposing
  CTE. Each was run for both the rename and the drop direction; each correctly declines
  to treat the qualifier as a row image.
- **Row images under `with context`.** A CHECK mixing `new.<col>` with `context.<var>`
  rewrites the column and leaves the context variable alone, including when the context
  variable *shares the column's name*. The handoff listed this as untested; it is now
  tested by hand and correct.
- **A subquery aliasing the owning table** (`(select count(*) from T x where x.a =
  new.a)`) rewrites both refs correctly.
- **`old.` under UPDATE**, not only DELETE, follows the rename.
- **Case folding, schema-qualified exclusion, and the DELETE/INSERT refusal shapes** all
  behave as the handoff claims.

No correctness defect was found in the shipped change.

### Fixed in this pass (minor)

- **Two of the four rebind branches had zero test coverage.** §13 / §27 exercised only
  the unaliased-source shape; the alias and CTE branches were correct but untested.
  Added §28 to `41.3-alter-rename-propagation.sqllogic` (rename must not rewrite through
  a source aliased `"new"`, nor through a `with "new" as (…)` clause) and §14 to
  `41.10.2-alter-drop-column-check-and-assertion.sqllogic` (both drops must be allowed).
  Each new block was proven to execute by temporarily corrupting its expectation and
  confirming the runner reported *that* block.
- **`docs/sql-alter.md` was not updated.** Only `docs/sql-ddl.md` was, but `sql-alter.md`
  is where the engine documents what RENAME COLUMN propagates into and what DROP COLUMN
  refuses over — both lists were left describing the old behavior. Added a paragraph to
  each section. `yarn docs:check` passes.

### Filed as tickets (major)

- **`bug-table-rename-rewrites-cte-references`** (existing backlog ticket — arm appended,
  not a new file, because it resolves at the same code site: `visitTableRename` is
  scope-blind). Verified mirror defect: because a table may legally be named `new`,
  `alter table "new" rename to "renamed"` rewrites the row-image qualifier in *every
  other* table's CHECK and leaves those tables unwritable —

  ```sql
  create table "new" (a integer primary key);
  create table T (id integer primary key, a integer, constraint ck check (new.a > 0));
  alter table "new" rename to "renamed";
  insert into T values (2, 7);      -- ERROR: renamed.a isn't a column
  ```

  This is the table walker's version of exactly the bug this ticket fixed in the column
  walker. Left out of this pass deliberately: it needs the table walker to know whose
  CHECK it is walking, which means giving it the seeded entry point and `ScopeFrame`
  machinery the ticket it was appended to already calls for.

- **`bug-context-variable-sharing-a-column-name-breaks-all-writes`** (new backlog ticket).
  Found while probing `context.` qualifiers alongside row images; pre-existing and
  unrelated to this diff. A table whose mutation-context variable shares a column name is
  accepted at CREATE, and then every write fails with `Symbol 'a' already exists in the
  same scope.` — an internal message naming nothing the user wrote. Root-caused to
  `packages/quereus/src/planner/building/constraint-builder.ts`, which registers the bare
  context-variable name and the bare column name into one scope.

### Tripwire (recorded, not ticketed)

- `rename-rewriter.ts` is ~1640 lines holding three independent walkers. Under the bar
  the repo's own size-debt tickets were filed at (`schema-differ.ts` at 2725), so not
  worth splitting today. Parked as a `NOTE:` at the top of the file naming the three
  seams to split along, conditional on the table walker growing its own `ScopeFrame`.

### Checked and clean — with reasons, not by assumption

- **Comment density.** The diff adds a high ratio of comment to code, which read as a
  smell until the surrounding file was checked: `rename-rewriter.ts` comments every
  scope helper at the same length and in the same register. The new comments match house
  style, and each of the three the implementer flagged as "worth challenging" earns its
  place. Not changed.
- **Type safety / API shape.** `matchesRowImage` takes the whole `ColumnExpr` to read one
  field; mildly loose, but consistent with the neighbouring helpers' signatures. No
  `any`, no unchecked casts introduced.
- **Performance.** `isQualifierReboundAboveSeed` runs only for a qualifier that already
  folds to `new`/`old` on a column whose name already matches, and is O(scope depth) with
  no allocation. Immaterial, and it only runs during DDL.
- **Resource cleanup / error handling.** The new code allocates nothing and throws
  nothing; the seeded entry point's existing `try/finally` scope-stack discipline is
  untouched.
- **Other consumers of the shared walk.** `renameColumnInIndexPredicates` (inert — a
  partial-index predicate has no written-row context) and `schema-differ.ts`'s inverse
  reconcile (which calls the same seeded entry point, so forward and inverse stay in
  parity) were both checked rather than taken on trust.
- **`packages/quereus/test/schema/clone-expr-isolation.spec.ts`** calls
  `renameColumnInCheckExpression` directly and passes unchanged; it needs no row-image
  case, since it asserts clone isolation rather than match semantics.

### Observed but deliberately not filed

- `main.new.a` — any three-part column reference of the form `schema.table.column` inside
  a CHECK — fails to plan (`main.new.a isn't a column`) **with no ALTER involved at all**.
  Pre-existing, in the planner rather than anywhere this diff touches, and it does not
  change the verdict on the row-image exclusion of schema-qualified refs (which is right
  either way). Recorded here rather than filed because the reproduction sits outside this
  ticket's subsystem and the failing surface was not investigated far enough to name a
  root-cause site — the bar this board sets for filing.

## Validation

| Command | Result |
| --- | --- |
| `yarn build` | clean |
| `yarn lint` (all packages) | clean |
| `yarn docs:check` | `Docs OK` (pre-existing size warnings on unrelated docs unchanged) |
| `yarn test` (memory leg, `packages/quereus`) | 8695 passing, 0 failing, 13 pending |
| `yarn test:store` (LevelDB leg) | 8687 passing, 0 failing, 21 pending |

New assertions proven to bite: corrupting §28's and §14's expected rows made the runner
fail on exactly those blocks; restored, both pass.

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.
`docs/errors.md` shows as modified in the working tree from another ticket in flight and
was left untouched.

## Known gaps carried forward

- **Column DEFAULT expressions using `new.<col>`** have the same user-visible symptom
  from a different code site (`rewriteTableForColumnRename` has no defaults loop, and
  there is no drop-column guard for defaults). Tracked by
  `bug-column-default-new-qualifier-invisible-to-column-rename`, which named this ticket
  as its prerequisite — that prerequisite has now landed.
- **`bug-drop-column-skips-check-on-another-table`** and
  **`bug-rename-not-propagated-across-schemas`** are separate arms with their own
  tickets, untouched here.
- **Residual ambiguity**, parked as a `NOTE:` at `isQualifierReboundAboveSeed`: a
  *correlated* `new.<col>` written inside a subquery that itself selects from a real
  table named `new` is left alone by both the rewrite and the refusal. Reviewed and
  agreed with — the qualifier is genuinely ambiguous there and SQL offers no spelling
  that distinguishes the two, so the conservative skip is the right call.
- **Not exercised:** `new.` in a CHECK on a table reached through a lens, and
  `alter table … add constraint` re-adding a row-image CHECK after a rename. The latter
  was run by hand during review and behaved correctly (the re-added CHECK follows a
  subsequent rename); neither has a committed sqllogic case.
