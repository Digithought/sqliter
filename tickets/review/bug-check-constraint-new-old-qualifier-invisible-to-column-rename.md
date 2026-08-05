---
description: A table rule written with the "new." or "old." row prefix used to be invisible to renaming and dropping a column, leaving the table unwritable; it is now rewritten on rename and refuses the drop, same as the plain spelling.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                  # the one behavior change: `matchesRowImage` + `isQualifierReboundAboveSeed` (~789), third accept path in visitColumnRename's `column` case (~1145), `matchRowImageQualifier` on ColumnRewriteState (~622)
  - packages/quereus/src/runtime/emit/drop-column-guards.ts         # doc-comment only: KNOWN GAP paragraph replaced
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # new §12, §13
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic                  # new §24–§27
  - docs/sql-ddl.md                                                 # § CHECK Constraints bullet extended
repro: verified
difficulty: medium
---

# Review: `new.` / `old.` row-image qualifiers in CHECK now follow RENAME COLUMN and block DROP COLUMN

## What was wrong, in one paragraph

A CHECK constraint may name the row being written explicitly — `check (new.a > 0)`,
`check on delete (old.a > 0)` — a spelling `docs/sql-ddl.md` § CHECK Constraints
documents. Neither `ALTER TABLE … RENAME COLUMN` nor `ALTER TABLE … DROP COLUMN` could
see a column named that way, because both decide what a qualifier refers to by resolving
it against the FROM clauses the AST walk has descended, and `new` / `old` name a row
image that never appears in a FROM clause. Both statements succeeded and left the table
unwritable: every later INSERT (or DELETE, for the `old.` form) failed while being
planned, with `new.a isn't a column`.

## What changed

**One behavior site**, exactly as the ticket predicted: the `column` case of
`visitColumnRename` in `packages/quereus/src/schema/rename-rewriter.ts` gained a third
accept path beside the existing "the qualifier is the table's name" and "the qualifier is
an alias bound to the table" paths.

- `ColumnRewriteState` carries a new `matchRowImageQualifier` flag. Only the *seeded*
  entry point `renameColumnInCheckExpression` sets it (that walk is entered for one
  specific table and pushes an implicit scope frame for it, so it is the walk that owns
  that table's row-image namespace). The unseeded `renameColumnInAst` leaves it false, so
  a `new.` reference sitting in some *other* table's CHECK is never mistaken for this
  table's row image.
- `matchesRowImage()` accepts a qualified reference when the flag is set, the reference
  has no schema part (`main.new.a` is a genuine three-part table reference, not a row
  image), the qualifier folds to `new` or `old`, and — the load-bearing part —
  `isQualifierReboundAboveSeed()` finds no enclosing FROM/WITH frame that binds that
  qualifier to a row source of its own.
- The new path is tried **last**, only when neither existing path fired, so behavior for
  a table genuinely named `new` or `old` that is itself the renamed table is unchanged.

Both reported symptoms are driven from that one site. The DROP COLUMN guard
(`assertNoCheckConstraintNamesColumn`) is *defined* as "refuse exactly what a rename would
have rewritten" — it runs the same walk against a throwaway clone, renaming to a sentinel
— so fixing the walk fixed the refusal and the rewrite together, and the equivalence
between them is preserved rather than patched around.

Everything else in the diff is documentation: the `KNOWN GAP` paragraph in
`drop-column-guards.ts` (which named this ticket slug) is replaced by a statement of the
new behavior, `docs/sql-ddl.md` says the two spellings behave identically under ALTER, and
comments were added at three places that a reader would otherwise trip over — see
*Comments worth reading* below.

## Why the scope-awareness is not over-engineering

`new` and `old` are **not** reserved words in this parser. Verified in-process:

```
create table "new" (a integer primary key)                                     -> OK
create table T2 (id integer primary key, a integer,
                 check ((select max("new".a) from "new") >= 0))                 -> OK
```

A depth-blind `qualifier === 'new'` match — the shape `renameNewQualifiedRefs` uses for
view `with inverse` expressions — would have rewritten `"new".a` → `"new".z` inside that
subquery when renaming `T2.a` (breaking the CHECK, since the `"new"` table has no `z`),
and would have false-refused `alter table T2 drop column a`. Both are covered by tests
(§13 of the drop file, §27 of the rename file) and both fail loudly without the scan.

## Use cases to exercise

Every one of these is now covered by a sqllogic assertion, listed here so a reviewer can
re-derive them by hand rather than trusting the file.

**Refusals (DROP COLUMN):**

| SQL | Expected |
| --- | --- |
| `check (new.a > 0)` then `alter table T drop column a` | refused, `StatusCode.CONSTRAINT`, message names the constraint |
| `check on delete (old.a > 0)` then same drop | refused the same way |
| `check (NEW.A > 0)` then same drop | refused (case folds like every other identifier) |
| after any refusal | column still present, still holding its value, CHECK still enforcing — nothing half-applied |

**Rewrites (RENAME COLUMN):**

| SQL | Expected |
| --- | --- |
| `check (new.a > 0)`, `rename column a to z` | violating insert still rejected; conforming insert accepted |
| `check on delete (old.a > 0)`, `rename column a to z` | deleting the violating row still refused; deleting the conforming row succeeds |
| `check (NEW.A > 0)`, `rename column a to z` | same as the lowercase form |

**Must NOT fire:**

| SQL | Expected |
| --- | --- |
| `check ((select max("new".a) from "new") >= 0)` — a real table named `"new"` | dropping the owning table's own `a` is **allowed**; renaming it leaves `"new".a` alone and the CHECK still evaluates |
| `main.new.a` (schema-qualified) | not a row image, unaffected — excluded by the `col.schema === undefined` test |
| a `new.` reference in a CHECK on a *different* table | not this table's row image; falls out of the entry-point scoping, no extra code |

**Control (regression guard):** the unqualified `check (a > 0)` spelling must still refuse
the drop and still follow the rename. Covered by pre-existing §1 and §10b.

## Validation actually run

| Command | Result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` (memory leg, all workspaces) | **8695 passing, 0 failing** in `packages/quereus`; every other package green |
| `yarn test:store` (full LevelDB leg) | **8687 passing, 0 failing** |
| `yarn lint` | clean |

Both touched sqllogic files were also run individually under **both** legs. The store leg
matters here because it persists table DDL — a CHECK broken by an unguarded drop would
survive a reopen — and the store's own DDL rewrite (`store-module-alter.ts` ~419) routes
through `renameColumnInCheckConstraints`, i.e. the same seeded entry point, so it picked
the fix up with no store-side change.

**The new assertions were proven to bite.** With `matchRowImageQualifier` temporarily
forced to `false`, both files fail with the exact ticket symptom —

```
[41.3-alter-rename-propagation.sqllogic:872] Expected error containing:
  "CHECK constraint failed: chk_rinew"
Actual error: "new.a isn't a column"
```

```
[41.10.2-…:360] Expected error matching "CHECK constraint 'chk_new'"
  but SQL block executed successfully.
Block: alter table DcNew drop column a;
```

— and pass again once restored. The flag is back to `true`; `grep -n "matchRowImageQualifier: "
packages/quereus/src/schema/rename-rewriter.ts` should show `false` at the
`renameColumnInAst` site and `true` at the `renameColumnInCheckExpression` site.

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.

## Comments worth reading (and worth challenging)

Three places got a comment specifically because they look wrong at a glance:

- **`renameNewQualifiedRefs`** is still depth-blind on `new`, and that is now explicitly
  marked deliberate. It rewrites by view *output* name inside a `with inverse` expression,
  whose grammar has no FROM clause to rebind `new` — a different question from a CHECK
  body, which can contain a subquery. A reviewer who reads only the new scope-aware helper
  will be tempted to "fix" this one for consistency; don't.
- **`renameColumnInIndexPredicates`** shares the seeded entry point and therefore inherits
  the row-image match. It is inert there — a partial-index predicate describes rows already
  stored, has no written-row context, and a predicate naming one would not plan. Noted so
  the shared entry point does not read as an oversight; deliberately **not** given a second
  entry point.
- **`isQualifierReboundAboveSeed`** scans "any enclosing frame binds it" rather than
  innermost-first. The reasoning is in the comment: a frame only sits above index 0 while
  the walk is inside the subquery that pushed it, so every such frame genuinely encloses
  the reference. Worth a reviewer checking that argument independently — it is the one
  place where a wrong call silently changes which drops are refused.

## Known gaps — please treat as review targets, not as settled

- **Column DEFAULT expressions using `new.<col>`** (`default (new.a + 1)`) have the same
  user-visible symptom from a **different** code site: `rewriteTableForColumnRename` has no
  defaults loop at all, and there is no drop-column guard for defaults. Deliberately out of
  scope; tracked by `bug-column-default-new-qualifier-invisible-to-column-rename`, which
  named this ticket as its prerequisite. **This fix is that prerequisite and has now
  landed** — the walk change it depends on is in place.
- **`bug-drop-column-skips-check-on-another-table`** (a CHECK on some other table naming
  this one) and **`bug-rename-not-propagated-across-schemas`** (cross-schema propagation)
  are separate arms with their own tickets, untouched here.
- **Residual ambiguity, parked as a `NOTE:` at `isQualifierReboundAboveSeed`:** a
  *correlated* `new.<col>` written inside a subquery that itself selects from a real table
  named `new` is left alone by both the rewrite and the refusal. The qualifier is genuinely
  ambiguous there and the SQL standard offers no spelling that distinguishes the two, so
  the conservative skip looks right — but it is an assumption, not a proof, and it is the
  one input a reviewer might reasonably disagree with.
- **Test floor, not ceiling.** The sqllogic coverage exercises the shapes the ticket
  enumerated. Not exercised: `new.` inside a CHECK that also has a `with context (…)`
  clause, `new.` in a CHECK on a table reached through a lens, and any interaction with
  `alter table … add constraint` re-adding a row-image CHECK after a rename. None of those
  looked reachable-and-broken on inspection, but none was run either.
- `packages/quereus/test/schema/clone-expr-isolation.spec.ts` calls
  `renameColumnInCheckExpression` directly and still passes unchanged (it is inside the
  8695). It was not extended with a row-image case.
