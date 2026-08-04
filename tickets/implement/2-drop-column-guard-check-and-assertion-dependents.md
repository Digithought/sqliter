---
description: Dropping a column is currently allowed even when a rule the user wrote still mentions that column, and afterwards the table (or, for a database-wide rule, every table) can no longer be written to. Refuse the drop instead, with a message naming the rule that is in the way.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runDropColumn (line ~1103) — the fixed dependent list; also holds buildColumnSourceResolver (line ~2226), which moves out
  - packages/quereus/src/runtime/emit/drop-column-guards.ts          # NEW — the guards
  - packages/quereus/src/runtime/emit/column-source-resolver.ts      # NEW — buildColumnSourceResolver, moved so both callers share it
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts        # the precedent this mirrors (DROP TABLE vs. an assertion)
  - packages/quereus/src/schema/rename-rewriter.ts                   # add columnReferencedInAst / columnReferencedInCheckExpression next to tableReferencedInAst (line ~106)
  - packages/quereus/src/util/ast-spine-clone.ts                     # spineCloneAst — the clone the probe rewrites
  - packages/quereus/src/schema/schema-differ.ts                     # line ~872 — a NOTE that predicts this change and is wrong about the fix; correct it
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # NEW test file
  - docs/sql-alter.md                                                # DROP COLUMN restriction list (~line 66)
  - docs/sql-ddl.md                                                  # DROP COLUMN restriction bullet (~line 347)
difficulty: medium
---

# DROP COLUMN must refuse when a CHECK constraint or an assertion still names the column

## What is broken

`runDropColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`) validates a **fixed,
incomplete** list of dependents before letting a column go: the primary key, generated-column
expressions, and partial-index `WHERE` predicates. Two other kinds of dependent survive the
drop verbatim and then fail much later, while a write statement is being planned — before any
row is touched — so the affected table becomes unwritable.

Both re-verified in-process at commit `8658cfdd` (scratch script, since deleted):

```sql
-- Arm A: a CHECK on the same table
create table T (id integer primary key, a integer, b integer, check (b > a));
insert into T values (1, 1, 2);
alter table T drop column a;    -- accepted, no error
insert into T values (2, 5);    -- Column not found: a

-- Arm C: an assertion whose body names the column
create table f (id integer primary key, x integer);
create table other (id integer primary key);
create assertion ff check (not exists (select 1 from f where x < 0));
alter table f drop column x;    -- accepted, no error
insert into other values (1);   -- Column not found: x   ← a DIFFERENT table
```

Arm C's blast radius is the whole database, not one table: the assertion evaluator recompiles
**every** live assertion on any commit that touched any table, so one unresolvable assertion
body blocks every write.

## The rule this ticket settles

DROP COLUMN's dependents split cleanly in two, and this is the rule to state in the docs:

- **Structural** dependents — a UNIQUE constraint over the dropped column, the table's own
  foreign key over it as a child column — are defined by a *column set*. Losing a column makes
  them a different constraint, not a narrower one, so the engine **removes them with the
  column**. (Already implemented by both virtual-table modules; documented today.)
- **Expression** dependents — a generated column's expression, a partial index's `WHERE`, and
  now a CHECK expression and an assertion body — are arbitrary user-authored logic with no
  "narrowed" form at all. The only choices are delete-it-silently or refuse, and the engine
  **refuses**, `StatusCode.CONSTRAINT`.

Refuse is the right half for the two new arms specifically because:

- it is what the two existing expression guards in this same function already do, so the
  function gains no second policy;
- it is what SQLite does for the whole family;
- `assertNoAssertionDependsOn` (`runtime/emit/assertion-drop-guard.ts`) already chose refuse
  for the *table* verb of Arm C, with the blast-radius reasoning quoted above. The column verb
  choosing cascade would make `drop table f` and `alter table f drop column x` disagree about
  the same assertion.

**Known cost, accepted:** an *unnamed* table-level CHECK cannot be dropped (`DROP CONSTRAINT`
resolves by name only), so refusing makes such a column undroppable short of rebuilding the
table. This is exactly SQLite's position, and the refusal message quotes the constraint's
expression text so the user can see what is in the way. Do not add a name-free
`DROP CONSTRAINT` spelling under this ticket.

## How to detect a reference — do not hand-roll a walk

The existing partial-index guard uses `predicateReferencesColumn` (alter-table.ts ~line 1079),
a **depth-blind** walk that matches any `column`/`identifier` node by bare name. That is sound
only because partial-index predicates cannot contain subqueries. CHECK expressions and
assertion bodies **can**, so a depth-blind walk false-refuses a legal drop. Verified at
`8658cfdd` that this case works today and must keep working:

```sql
create table U  (uid integer primary key, v integer);
create table T2 (id integer primary key, v integer, w integer, check ((select min(v) from U) >= 0));
alter table T2 drop column v;   -- must stay ACCEPTED: the `v` in the CHECK is U.v
```

Use the scope-aware rewriter instead. `schema/rename-rewriter.ts` already owns a walk that
resolves a column reference against the FROM scopes it descends, and `ALTER TABLE … RENAME
COLUMN` uses it to rewrite exactly these two dependents. Detect by asking that walk what a
rename *would* have rewritten — the same equivalence `tableReferencedInAst` establishes for
the table verb.

The table verb gets that by running its walker with a `dryRun` flag. The column walker has ~8
mutation points and a CTE-re-exposure branch that reads the new name, so bolting `dryRun` onto
it is the riskier option. Instead, rewrite a **throwaway spine clone** to a sentinel name:

```ts
// packages/quereus/src/schema/rename-rewriter.ts — next to tableReferencedInAst

/** Name no user column can hold; the probe rewrites TO it, so nothing can match it. */
const PROBE_COLUMN_NAME = '__quereus_column_probe__';

export function columnReferencedInAst(
	node: AST.AstNode | undefined,
	tableName: string,
	columnName: string,
	defaultSchemaName: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!node) return false;
	return renameColumnInAst(
		spineCloneAst(node), tableName, columnName, PROBE_COLUMN_NAME,
		defaultSchemaName, resolveColumnInSource);
}

/** Same, with the implicit unaliased binding a CHECK / partial-index predicate resolves against. */
export function columnReferencedInCheckExpression(/* same params */): boolean { /* … renameColumnInCheckExpression on a clone … */ }
```

Why this is safe, and why the "don't clone-and-rename" warning at `rename-rewriter.ts:96-101`
does not apply: that warning is about running an *identity* rename over the *live* AST, whose
flaws are silent re-casing of the real node and a `newCol === oldCol` comparison that changes
the CTE-re-exposure branch's answer. Neither applies here — the node is a discarded clone, and
the target is a fresh sentinel, so the walk behaves exactly as a real rename to an unused name
would. Extend that doc comment to say so, rather than leaving a reader to rediscover it.

`spineCloneAst` (`util/ast-spine-clone.ts`) exists for precisely this — it deep-copies the
plain-object spine the rewriters write into and shares every other leaf, and tolerates a frozen
input. Do not reach for `structuredClone` (a `LiteralExpr.value` may be a Promise).

**The resolver is not optional.** Both probes must be passed a `ResolveColumnInSource`, or the
subquery case above false-refuses. Verified in-process at `8658cfdd`: without the resolver the
`T2` probe answers `true` (wrong); with it, `false` (right). `buildColumnSourceResolver` is
currently a private function in alter-table.ts (~line 2226) that `runRenameColumn` uses — move
it verbatim to a new `packages/quereus/src/runtime/emit/column-source-resolver.ts` and import
it from both alter-table.ts and the new guard module. (Do not export it *from* alter-table.ts:
the guard module is imported *by* alter-table.ts.)

## The guards

New file `packages/quereus/src/runtime/emit/drop-column-guards.ts`, sibling in spirit to
`assertion-drop-guard.ts`. Keeping them out of alter-table.ts is deliberate: that file is
2,427 lines and already carries a size ticket (`debt-emit-source-files-too-large`).

```ts
export function assertNoCheckConstraintNamesColumn(
	db: Database, tableSchema: TableSchema, columnName: string): void;

export function assertNoAssertionNamesColumn(
	db: Database, tableSchema: TableSchema, columnName: string): void;
```

Called from `runDropColumn` immediately after the partial-index loop and **before**
`requireVtabModule` / `module.alterTable`, so a refused statement never reaches a persisting
module. Order: CHECK first (table-local), assertion second (database-wide) — widening blast
radius, so the most locally-explainable violation is reported first.

Messages follow the local style of the guards already in `runDropColumn` (`Cannot drop column
'<c>' from '<t>': it is referenced by …`), all `StatusCode.CONSTRAINT`:

- named CHECK — `Cannot drop column 'a' from 'T': it is referenced by CHECK constraint 'chk_ab'`
- unnamed CHECK — `Cannot drop column 'a' from 'T': it is referenced by the CHECK constraint (b > a)`
  (`expressionToString` from `emit/ast-stringify.js`; a table-level unnamed CHECK genuinely has
  `name: undefined` — `manager.ts` only synthesizes `_check_<table>` for error text, it does
  not store it)
- assertion — `Cannot drop column 'x' from 'f': it is referenced by assertion 'ff' — drop or redefine the assertion first`

Detection details:

- **CHECK** — iterate `tableSchema.checkConstraints`, probe each `expr` with
  `columnReferencedInCheckExpression` (seeded entry point: a CHECK resolves unqualified refs
  against its owning table). Note `checkConstraints` also carries FK-synthesized entries in
  some paths — probe only what is on `tableSchema.checkConstraints` at drop time, which is the
  user's declared set.
- **Assertion** — iterate `schema.getAllAssertions()` for the altered table's **own** schema
  only, skip an assertion with no `checkExpression`, probe with `columnReferencedInAst`
  (unseeded: an assertion body names its tables explicitly). Mirror
  `assertNoAssertionDependsOn`'s scope decision *and* its documented cross-schema gap (an
  assertion in schema A naming `B.t` explicitly is not caught —
  `bug-rename-not-propagated-across-schemas`).

## The declarative path needs a comment fix, not a code change

`schema-differ.ts` (~line 872) carries a NOTE predicting this ticket:

> dropped COLUMNS have no equivalent here … when it does (`bug-drop-column-skips-dependent-checks`
> arm C), this predicate has to widen to columns or such a migration will abort.

**That prediction is wrong — do not widen `namesDroppedObject`.** Work the cases through:

| declaration | today | after this ticket |
|---|---|---|
| removes column *and* removes the assertion | assertion drop is emitted first (`generateMigrationDDL` puts `DROP ASSERTION` at the top, `DROP COLUMN` in the table-alter block) → works | unchanged, works |
| removes column *and* edits the assertion body off it | body drift already forces drop-old + recreate-last → works (verified at `4e66323f`) | unchanged, works |
| removes column, leaves an unchanged assertion body naming it | applies cleanly and bricks the database | refused at `DROP COLUMN`, naming the assertion; nothing applied |

The third row is a self-inconsistent declaration and must fail. Widening the predicate would
not rescue it — it would drop the assertion, drop the column, then fail on the recreate
(`CREATE ASSERTION` plans its body at build time), i.e. a later failure with a worse message
after the assertion is already gone. Replace the NOTE with the resolved statement: a
declaration that removes a column an assertion body still names is refused at the column drop,
and that is the intended outcome.

## Edge cases & interactions

Name each of these in the test file.

- **Subquery inside a CHECK naming a like-named column of another table** — the `T2`/`U` case
  above. Must stay accepted, and the table must stay writable afterwards.
- **Subquery inside an assertion body naming a like-named column of another table** — same
  shape, unseeded walk. Must stay accepted.
- **A CHECK / assertion that names the table but not the dropped column** — accepted. Verified
  the probe answers `false` for `f.y` and `f.id` on `not exists (select 1 from f where x < 0)`.
- **`select *` in an assertion body** — names no column; the drop is accepted and the assertion
  still compiles. Do not refuse on table-reference alone.
- **Qualified reference** (`check (T.b > T.a)`, `where f.x < 0`) — refused, same as unqualified.
- **Case-insensitivity** — `check (B > A)` blocks dropping `a`.
- **Dropping a column no CHECK names, on a table that has CHECKs** — accepted; the surviving
  CHECK still enforces after the drop (this is the existing §7a coverage in
  `41.4-alter-add-column-constraints.sqllogic`; add the equivalent here so the file is
  self-contained).
- **Refusal leaves the table completely untouched** — the guard runs before `module.alterTable`,
  so assert after a refused drop that the column is still present, still queryable, and the
  CHECK still rejects a violating insert. Store mode matters here: a guard placed after the
  module call would already have persisted.
- **Escape hatch works** — `alter table T drop constraint <name>` then the drop succeeds
  (named CHECK); `drop assertion ff` then the drop succeeds.
- **Generated column and partial-index guards still fire** — do not regress the existing two by
  reordering.
- **`checkConstraints` on a table with zero CHECKs** — no crash on the empty/undefined array.
- **Multiple dependents at once** (a CHECK *and* an assertion naming the column) — the CHECK
  message wins, per the stated order.

## Documentation

- `docs/sql-alter.md`, DROP COLUMN restriction bullet list (~line 66): add the CHECK and
  assertion restrictions, and state the structural-vs-expression rule from above in one
  sentence so the existing "UNIQUE is dropped with the column" paragraph stops reading as an
  arbitrary exception. Leave the wrong sentence about another table's foreign key alone —
  `drop-column-guard-referencing-foreign-keys` owns that line.
- `docs/sql-ddl.md` (~line 347): a bullet next to the existing generated-column DROP COLUMN
  restriction, same wording.
- Run `yarn docs:check` — both files are far from the word ratchet, but the check is part of
  `yarn check`.

## Tests

New file `packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic`,
alongside `41.10` (drop column vs. the table's own FKs) and `41.10.1` (vs. a unique index). No
`-- requires-capability:` directive is needed — the file uses no standalone index DDL, so it
runs in **both** memory (`yarn test`) and store (`yarn test:store`) modes, which is required:
the store persists table DDL, so a broken CHECK would survive a reopen.

Expected-error lines use the `-- error: <substring>` form (see `41.10` for the convention);
match on the constraint / assertion name so the assertion proves *which* dependent blocked.

Sketch of the sections:

- 1. Named CHECK naming the dropped column → refused; column still there; CHECK still enforces.
- 2. Unnamed table-level CHECK → refused, message quotes the expression.
- 3. CHECK not naming the dropped column → accepted; CHECK still enforces afterwards.
- 4. CHECK whose only match is inside a subquery over another table → accepted; table writable.
- 5. `drop constraint` then drop the column → accepted (escape hatch).
- 6. Assertion naming the dropped column → refused; writes to an **unrelated** table still work
  (this is the arm's real damage).
- 7. Assertion naming the table but not the column, and a `select *` body → accepted.
- 8. `drop assertion` then drop the column → accepted (escape hatch).
- 9. Case-only and qualified spellings → refused.

## TODO

Phase 1 — detection primitives

- Add `columnReferencedInAst` and `columnReferencedInCheckExpression` to
  `packages/quereus/src/schema/rename-rewriter.ts`, next to `tableReferencedInAst`, using
  `spineCloneAst` + a sentinel target name.
- Extend the `tableReferencedInAst` doc comment (lines ~96-101) to say why the clone+sentinel
  form is sound where the identity-rename-on-live-AST form is not.
- Move `buildColumnSourceResolver` out of `alter-table.ts` into
  `packages/quereus/src/runtime/emit/column-source-resolver.ts`; update `runRenameColumn`'s
  import.

Phase 2 — the guards

- Add `packages/quereus/src/runtime/emit/drop-column-guards.ts` with
  `assertNoCheckConstraintNamesColumn` and `assertNoAssertionNamesColumn`, documented in the
  style of `assertion-drop-guard.ts` (why refuse, what the scope is, what gap remains).
- Call both from `runDropColumn` after the partial-index loop, before `requireVtabModule`.

Phase 3 — differ comment

- Replace the stale `namesDroppedObject` NOTE in `schema/schema-differ.ts` (~line 872) with the
  resolved statement. No behavioural change there.

Phase 4 — docs and tests

- `docs/sql-alter.md` and `docs/sql-ddl.md` per the section above.
- Write `41.10.2-alter-drop-column-check-and-assertion.sqllogic`.
- Validate, streaming output (never silent redirection):
  `yarn lint 2>&1 | tee /tmp/lint.log`, `yarn build 2>&1 | tee /tmp/build.log`,
  `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`, then the store leg for the
  new file only:
  `yarn workspace @quereus/quereus run test:store --grep "File: 41.10.2" 2>&1 | tee /tmp/store.log`.
  A full `yarn test:store` is slow — run the targeted grep, and say in the handoff that the
  full store suite was not run.
- `yarn docs:check`.
