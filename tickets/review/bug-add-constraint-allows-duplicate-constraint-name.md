---
description: Adding a constraint under a name another constraint on the same table already uses is now rejected instead of quietly accepted, so a table can no longer end up with two constraints answering to one name.
prereq:
files:
  - packages/quereus/src/schema/table.ts                      # namedConstraintExists — moved here, exported, beside resolveNamedConstraintClass
  - packages/quereus/src/runtime/emit/add-constraint.ts       # emitAddConstraint's run — the ADD CONSTRAINT guard
  - packages/quereus/src/runtime/emit/alter-table.ts          # runAddColumn ~535-565 (inline-constraint guard); private copy of the helper deleted ~1193
  - packages/quereus/test/logic/41.6-alter-drop-rename-constraint.sqllogic  # new § 7b — runs under memory AND store
  - packages/quereus/test/alter-add-constraint.spec.ts        # new `duplicate constraint name` describe block
  - docs/sql-alter.md                                         # ADD CONSTRAINT bullet + ADD COLUMN inline-constraint paragraph
difficulty: medium
---

# Duplicate constraint names are refused on the ALTER add paths

## What changed

`ALTER TABLE … ADD CONSTRAINT <name> …` and an inline **named** constraint on
`ALTER TABLE … ADD COLUMN` now refuse a name that already addresses a CHECK,
UNIQUE or FOREIGN KEY constraint on that table:

```
Cannot add constraint 'ck' to table 't': a constraint with that name already exists
```

with `StatusCode.CONSTRAINT`. Matching is case-insensitive.

Three edits:

- **`schema/table.ts`** — `namedConstraintExists(tableSchema, name)` moved here from
  its private home in `runtime/emit/alter-table.ts`, exported, and documented beside
  `resolveNamedConstraintClass` (whose matching rule it mirrors). One copy, three
  callers: ADD CONSTRAINT, ADD COLUMN's inline arm, and RENAME CONSTRAINT's existing
  collision check.
- **`runtime/emit/add-constraint.ts`** — the guard sits at the top of
  `emitAddConstraint`'s `run`, *above* the engine-side-CHECK / module-routed branch (so
  one guard covers both arms) and above every module dispatch (so a refused statement
  persists nothing on the store backend). It also runs *ahead of*
  `assertUniqueConstraintIndexNameFree`, which is what makes the two backends agree —
  see "Why the ordering matters" below.
- **`runtime/emit/alter-table.ts`** — `runAddColumn` gained a pre-dispatch loop over
  the column's **raw** `columnDef.constraints`, ahead of the existing index-name loop.
  A `Set` of names seen within the statement catches two inline constraints on one
  ADD COLUMN colliding with *each other* (neither is on the table yet).

## Why the ordering matters (the part most worth re-checking)

The UNIQUE-onto-UNIQUE case used to be refused on the memory backend — but by the
*wrong* guard. That backend materializes a UNIQUE constraint's hidden backing index
into the table's index list, so `assertUniqueConstraintIndexNameFree` tripped over the
first constraint's own structure and reported a collision with an index the user never
created. The store backend keeps that structure internal, saw nothing, and accepted the
duplicate. Same statement, two outcomes.

With the name check first, both backends refuse identically, and the index guard keeps
owning the case it was written for — a name held by a *real* user index and by no
constraint. `test/alter-drop-rename-constraint.spec.ts`'s "a refused UNIQUE declaration
never leaves two indexes sharing a name" pins that message (its `foo` is a plain
non-unique index) and still passes.

## Bug found and fixed mid-implementation — worth a second look

The first cut compared names off the **extracted** `inlineConstraints`, not the raw
declaration. `extractColumnLevelCheckConstraints` auto-names an unnamed column CHECK
`_check_<column>`, so *two unnamed CHECKs on one new column* both got `_check_c` and the
guard refused a legal statement. Caught by `test/logic/03.4-defaults.sqllogic`
(`ac_chk_multi_ok`), not by anything written for this ticket.

The fix reads user-written names off `columnDef.constraints` directly and filters to the
three classes that occupy a named-constraint array. **This is the seam a reviewer should
poke hardest** — the distinction between a name the user typed and a name the engine
synthesized is the whole correctness argument, and it is now enforced by *where the loop
reads from* rather than by an explicit predicate.

## Known gaps (deliberate, not oversights)

- **`CREATE TABLE` is untouched.** It still accepts two constraints under one name. That
  is depended on by § 7 of the sqllogic file, which builds table `e_amb` exactly that way
  to assert the ambiguous-drop error. Tightening it is separate work.
- **Engine-synthesized names are not compared**, per the ticket's settled design. One
  consequence is reachable but pathological: a table whose CHECK is *user-named*
  `_check_b` will still accept `alter table t add column b integer null check (b > 0)`,
  whose unnamed CHECK auto-names to `_check_b` — landing the duplicate the guard exists to
  prevent. Same shape for `_uc_<cols>` on an unnamed `add unique`. Reaching it requires a
  user typing the engine's own auto-name convention. Not filed; flagged here so a reviewer
  can disagree.
- **A `derivedFromIndex` UNIQUE** (synthesized from `CREATE UNIQUE INDEX`) produces the
  generic "a constraint with that name already exists" rather than naming the index. That
  is what the rename path already reports for the same shape; a code comment in
  `add-constraint.ts` says so.
- **Module-API callers bypass this**, as they bypass every other pre-dispatch check at
  these sites. No new exposure.

## Testing

**Behavioral / cross-backend** — `test/logic/41.6-alter-drop-rename-constraint.sqllogic`
§ 7b (new). This file runs under both `yarn test` and `yarn test:store`, which is how
backend parity gets pinned — that is the point of putting these here rather than in a
spec. Covers:

| case | expectation |
| --- | --- |
| CHECK onto CHECK | refused; `check_constraint_info` still shows exactly one |
| same, differing only in case (`CK` vs `ck`) | refused |
| a *different* name on the same table | accepted |
| UNIQUE onto UNIQUE | refused; `unique_constraint_info` still shows one |
| unnamed `add unique (b)` alongside a named UNIQUE | **accepted**, and enforces (negative control) |
| FK onto FK | refused; `foreign_key_info` still shows one |
| cross-class CHECK-name → UNIQUE | refused, and `drop constraint dup` still works afterwards |
| ADD COLUMN with inline `constraint ck check (…)` where `ck` exists | refused; no column added, no constraint installed |
| ADD COLUMN with two inline `constraint x` on one statement | refused; no column added |
| ADD COLUMN with a non-colliding inline name | accepted |

**Unit** — `test/alter-add-constraint.spec.ts`, new `duplicate constraint name` describe.
Pins the exact message text and `StatusCode.CONSTRAINT`, and asserts the ADD COLUMN
refusal leaves the table byte-identical (column list unchanged, constraint arrays
unchanged, existing rows still readable). The "table untouched" claim is *asserted*, not
assumed — `runAddColumn`'s guard runs before the column is materialized, so
`revertAddColumn` is never involved.

**Runs performed, all green:**

- `yarn build` — clean
- `yarn test` — 8158 passing, 13 pending
- `yarn test:store` — 8150 passing, 21 pending
- `yarn lint` — exit 0, no output

Nothing skipped, nothing loosened. No pre-existing failures surfaced.

### Where the coverage is thinnest

- Only the *first* colliding constraint in an ADD COLUMN is reported; there is no test
  that a statement with three inline constraints reports the right one. Low value.
- The declarative differ path (`apply schema` → `TableAlterDiff.constraintsToAdd`) was
  reasoned about in the source ticket (`generateMigrationDDL` emits every DROP before
  every ADD, so the old side is gone before the add runs) and is covered only indirectly,
  by `test/declarative-equivalence.spec.ts` continuing to pass. No test was added that
  deliberately drives a differ-generated ADD CONSTRAINT into an occupied name — if a
  reviewer wants belt-and-braces on convergence, that is the gap.
- No test asserts the refusal inside an explicit transaction that is then rolled back.

## Docs

`docs/sql-alter.md` — a sub-bullet under **ADD CONSTRAINT** (the rule, why it exists,
what it does *not* cover) and a paragraph under the ADD COLUMN inline-constraint section
(named vs unnamed, pre-materialization placement). No other doc claimed the old behavior.
