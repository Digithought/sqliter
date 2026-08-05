---
description: A table rule written using the "new." or "old." row prefix is invisible to both renaming and dropping a column, so either operation is allowed and afterwards the table can no longer be written to at all.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                  # `column` case of visitColumnRename (~line 1056) — the one site to change; ColumnRewriteState (~592); renameColumnInCheckExpression (~447)
  - packages/quereus/src/runtime/emit/drop-column-guards.ts         # assertNoCheckConstraintNamesColumn — its doc comment carries the KNOWN GAP paragraph to delete
  - packages/quereus/src/runtime/emit/alter-table.ts                # rewriteTableForColumnRename (~2318) — calls the seeded entry point for the renamed table's own checks
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # DROP COLUMN vs. CHECK coverage
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic                  # RENAME COLUMN propagation coverage
  - docs/sql-ddl.md                                                 # § CHECK Constraints documents the new./old. spelling
repro: verified
difficulty: medium
---

# A CHECK written with `new.` / `old.` is invisible to column rename and column drop

## What is broken

A CHECK constraint may name the row being written explicitly, with the reserved `new.`
and `old.` prefixes — `docs/sql-ddl.md` § CHECK Constraints documents this spelling.
Neither `ALTER TABLE … RENAME COLUMN` nor `ALTER TABLE … DROP COLUMN` sees a column
named that way. Both operations succeed, and the table is unwritable afterwards.

Re-verified in-process at `e4217a2f` (memory module):

```
create table NQ (id integer primary key, a integer, b integer, constraint chk_new check (new.a > 0))
   -> OK
insert into NQ values (2, -1, 6)
   -> ERR: CHECK constraint failed: chk_new (new.a > 0)        <- the rule works
alter table NQ drop column a
   -> OK                                                       <- should be refused
insert into NQ values (3, 7)
   -> ERR: new.a isn't a column                                <- table now unwritable

create table RQ (id integer primary key, a integer, constraint chk_r check (new.a > 0))
alter table RQ rename column a to z
   -> OK                                                       <- CHECK not rewritten
insert into RQ values (1, 5)
   -> ERR: new.a isn't a column

create table OQ (id integer primary key, a integer, b integer, constraint chk_old check on delete (old.a > 0))
alter table OQ drop column a
   -> OK
delete from OQ where id = 1
   -> ERR: old.a isn't a column

create table UQ (id integer primary key, a integer, constraint chk_u check (a > 0))
alter table UQ drop column a
   -> ERR: Cannot drop column 'a' from 'UQ': it is referenced by CHECK constraint 'chk_u'
```

Last case is the control: the *unqualified* spelling of the same rule is handled
correctly by both operations. Only the explicitly-qualified form is missed.

## Root cause — one site

`visitColumnRename`'s `column` case (`packages/quereus/src/schema/rename-rewriter.ts`,
~line 1056) decides whether a qualified column reference belongs to the table under
consideration:

```ts
if (col.table) {
    const qualifierLower = col.table.toLowerCase();
    const directHit = qualifierLower === state.tableName && …;
    const viaAlias = aliasResolvesToTable(state, col.table);
    if (directHit || viaAlias) { col.name = state.newCol; state.changed = true; }
}
```

Both accept paths resolve the qualifier against the FROM scopes the walk has descended —
a real table name, or an alias bound by a FROM clause. `new` and `old` are neither: they
name the row image being written, which never appears in a FROM clause. So neither path
fires and the reference is left alone.

That one decision drives both symptoms. The DROP COLUMN guard
(`assertNoCheckConstraintNamesColumn`) is *defined* as "refuse exactly what a rename would
have rewritten" — it runs the same walk through `columnReferencedInCheckExpression`, which
renames to a sentinel over a throwaway clone. Fixing the walk fixes the rename propagation
and the drop refusal together; fixing either alone would break that equivalence.

The seeded entry point is correctly scoped for this. `rewriteTableForColumnRename`
(`alter-table.ts` ~2333) calls `renameColumnInCheckExpression` **only** when
`isRenamedTable` — a CHECK on some *other* table that happens to reference the renamed
table goes through the unseeded `renameColumnInAst` instead. So a row-image accept path
added under a state flag that only `renameColumnInCheckExpression` sets can never match a
`new.` reference belonging to a different table's row image.

## The shadowing edge is real — do not make this depth-blind

`new` and `old` are **not** reserved words in this parser. Verified at `e4217a2f`:

```
create table "new" (a integer primary key)                                          -> OK
create table T2 (id integer primary key, a integer,
                 check ((select max("new".a) from "new") >= 0))                      -> OK
insert into T2 values (1, 1)                                                         -> OK
```

So a depth-blind `qualifier === 'new'` match — the shape `renameNewQualifiedRefs` uses for
view `with inverse` exprs, and the shape `containsOldRowImageRef`
(`planner/analysis/check-extraction.ts`) uses — would false-rewrite `"new".a` inside that
subquery when renaming `T2.a`, and would false-refuse `alter table T2 drop column a`.

The walk already carries the scope stack needed to avoid that: match the row-image
qualifier only when **no enclosing FROM frame above the seed frame binds it**. Frame index
0 is the implicit seed that `renameColumnInCheckExpression` pushes; frames 1..top are real
FROM / WITH frames, so the scan starts at 1.

## Expected behavior

- `alter table T drop column a` is **refused** with `StatusCode.CONSTRAINT`, naming the
  constraint, when any CHECK on `T` names `a` as `new.a` or `old.a` — identically to the
  unqualified `check (a > 0)` refusal today.
- `alter table T rename column a to z` **rewrites** `new.a` → `new.z` and `old.a` →
  `old.z` inside `T`'s own CHECK expressions, so the constraint keeps enforcing.
- Both spellings fold case (`NEW.A`), like every other identifier in the engine.
- A schema-qualified `main.new.a` is a real three-part table reference, not a row image,
  and is unaffected.
- A `new.` / `old.` qualifier **rebound by an inner FROM** (a real table literally named
  `new`) is left alone, in both the rewrite and the refusal.
- A `new.` / `old.` reference inside a CHECK on a *different* table is not this table's
  row image and is not matched — falls out of the entry-point scoping above, no extra code.

## Design

Additive accept path; nothing existing changes shape.

```ts
interface ColumnRewriteState {
    …
    /** Match `new.` / `old.` as this table's row image (seeded CHECK-expression walks only). */
    matchRowImageQualifier: boolean;
}
```

- `renameColumnInAst` sets it `false`; `renameColumnInCheckExpression` sets it `true`.
- In the `column` case, after `directHit` / `viaAlias` are computed, add a third disjunct
  that only applies when neither of them fired:

```ts
const rowImageHit = !directHit && !viaAlias && matchesRowImage(state, col, qualifierLower);
if (directHit || viaAlias || rowImageHit) { … }
```

- `matchesRowImage(state, col, q)` is true when `state.matchRowImageQualifier`,
  `col.schema === undefined`, `q === 'new' || q === 'old'`, and no frame at index ≥ 1 of
  `state.scopeStack` binds `q` (checking `unaliased`, `aliasMap` keys, `ctesInScope`, and
  `ctesShadowingSource` — the four ways a qualifier gets bound by a FROM/WITH frame).

Ordering the row-image test *after* the existing two keeps today's behavior byte-identical
for a table genuinely named `new` or `old` that is itself the renamed table.

## What comes along for free

Every one of these routes through `renameColumnInCheckExpression`, so none needs its own
change — but each is a place to sanity-check the result:

- `columnReferencedInCheckExpression` → the DROP COLUMN guard (the sentinel-probe form).
- `renameColumnInCheckConstraints` → the store module's own DDL rewrite
  (`packages/quereus-store/src/common/store-module-alter.ts` ~419), which persists the
  rewritten CHECK, so the store leg picks the fix up too.
- `schema-differ.ts` (~1374, ~1535, ~1749) → the differ's inverse reconcile, keeping the
  forward rewrite and the declared-side round-trip in parity.
- `renameColumnInIndexPredicates` shares the same seeded entry point. A partial-index
  predicate describes stored rows and has no row image, so the new path is a no-op there;
  say so in a comment rather than adding a second entry point.

## Out of scope

- **Column DEFAULT expressions** using `new.<col>` (`default (new.a + 1)`) have the same
  symptom from a *different* site — `rewriteTableForColumnRename` has no defaults loop at
  all, and there is no drop-column guard for them. Tracked separately as
  `bug-column-default-new-qualifier-invisible-to-column-rename`, which depends on this
  walk change landing first.
- `bug-drop-column-skips-check-on-another-table` (CHECK on another table) and
  `bug-rename-not-propagated-across-schemas` (cross-schema) are separate arms with their
  own tickets.
- Generated-column expressions cannot use `new.` / `old.`, and that guard resolves
  dependencies by column index rather than by walking the AST, so it already catches every
  spelling.
- Assertion bodies are ordinary SELECTs with no row image; the assertion arm of the
  DROP COLUMN guard is unaffected.

## TODO

### Phase 1 — the walk

- Add `matchRowImageQualifier: boolean` to `ColumnRewriteState`; set `false` in
  `renameColumnInAst`, `true` in `renameColumnInCheckExpression`.
- Add the `matchesRowImage` helper plus its rebound-qualifier scan (frames index ≥ 1),
  next to `aliasResolvesToTable` / `isQualifierShadowedInScope`.
- Wire the third accept path into the `column` case of `visitColumnRename`.
- Update the doc comment on `renameColumnInCheckExpression` to state that the seeded walk
  also owns the `new.` / `old.` row-image namespace, and why the match is scope-aware
  rather than depth-blind (a table can be named `new`).
- Note on `renameNewQualifiedRefs` that it stays depth-blind on purpose — it rewrites by
  *view output name* in `with inverse` exprs, a different context from a CHECK's row image.
- Note on `renameColumnInIndexPredicates` that the row-image path is inert for predicates.

### Phase 2 — dependents' documentation

- Delete the `KNOWN GAP:` paragraph from `assertNoCheckConstraintNamesColumn`'s doc comment
  in `drop-column-guards.ts` (it names this ticket slug) and replace it with a sentence
  saying row-image qualifiers are covered by the same walk, shadowing edge included.
- `docs/sql-ddl.md`: alongside the `new.<col>` / `old.<col>` CHECK spelling, state that
  RENAME COLUMN rewrites those references and DROP COLUMN refuses over them, same as the
  unqualified spelling.

### Phase 3 — tests

Both files below run under the store leg (`yarn test:store`) as well — do not add
standalone `create index … where` DDL to either, which would force a
`requires-capability: standalone-index-ddl` directive and take them out of it.

- `41.10.2-alter-drop-column-check-and-assertion.sqllogic` — new section:
  - `check (new.a > 0)` refuses `drop column a`, naming the constraint; table untouched
    afterwards (column still there, CHECK still enforcing) as the existing §1 asserts.
  - `check on delete (old.a > 0)` refuses likewise.
  - `check (NEW.A > 0)` (case-folded) refuses.
  - Negative: a CHECK whose subquery reads a table literally named `"new"`
    (`check ((select max("new".a) from "new") >= 0)`) must **not** block dropping the
    owning table's own like-named column.
- `41.3-alter-rename-propagation.sqllogic` — new sections:
  - `rename column a to z` rewrites `new.a` → `new.z`; a write that violates the rule
    still fails, and a conforming write still succeeds (proves it enforces, not just that
    it parses).
  - Same for `old.` in a `check on delete`, verified by an actual DELETE.
  - Case-folded `NEW.A` follows the rename.
  - Negative: the `"new"`-named-table shadowing case is not rewritten — the check still
    evaluates after the rename.
- Confirm the existing `packages/quereus/test/schema/clone-expr-isolation.spec.ts`
  expectations still hold (it calls `renameColumnInCheckExpression` directly).

### Phase 4 — validation

- `yarn build`
- `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- `yarn lint`
- The store leg (`yarn test:store`) exercises the persisted-DDL path for these files. Run
  it if it fits the time budget; if it does not, say so in the review handoff — the store
  arm of the fix is `renameColumnInCheckConstraints`, which is the same entry point the
  memory leg covers.
