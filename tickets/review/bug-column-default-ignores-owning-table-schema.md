---
description: A column's default value written as a query used to look up the tables it names using whatever database the writing statement was pointed at, instead of the one the table itself lives in. All four kinds of expression a table can carry in its own definition now resolve names the same way.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts   # the fix — required schemaName param, narrows schemaPath
  - packages/quereus/src/planner/building/insert.ts                    # two contexts collapsed to one
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/building/delete.ts
  - packages/quereus/src/planner/building/constraint-builder.ts        # internal narrowing removed
  - packages/quereus/src/planner/building/foreign-key-builder.ts       # internal narrowing removed (2 sites)
  - packages/quereus/src/core/derived-row-validator.ts                 # fresh context now wrapped
  - packages/quereus/src/planner/building/view-mutation-builder.ts     # buildKeyDefault takes the anchor's schema
  - packages/quereus/src/planner/mutation/multi-source.ts              # carries keyDefaultSchemaName
  - packages/quereus/src/planner/mutation/decomposition.ts             # carries keyDefaultSchemaName
  - packages/quereus/src/planner/building/alter-table.ts               # ADD COLUMN backfill now wrapped
  - packages/quereus/src/planner/stored-body-context.ts                # sibling doc comment updated
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic  # new
  - docs/schema.md
repro: verified
---

# Schema-authored expressions resolve names against the owning table's schema

## What changed

Four kinds of expression can be written inside a table's own definition: a column
`default`, a generated-column expression, a `check` constraint, and the existence probe
the engine synthesizes for a foreign key. All four are authored by whoever wrote the
table, not by whoever writes a row, so an unqualified relation name in any of them must
mean the same table every time.

It did not. `check` and foreign-key bodies each narrowed the schema search path to the
table's own schema *inside their own builder*; column defaults and generated columns had
no equivalent, so they resolved names on whatever path the writing statement carried (the
session `pragma schema_path`, or a per-statement `insert … with schema …`). One table
definition could therefore disagree with itself about a bare name.

The narrowing now happens in exactly one place — `schemaAuthoredContext`
(`planner/building/schema-authored-context.ts`) — and the owning schema name is a
**required** parameter, so no future call site can silently omit it:

```ts
schemaAuthoredContext(ctx, schemaName)
// → { ...ctx, cteNodes: undefined, cteReferenceCache: undefined, schemaPath: [schemaName] }
```

`[schemaName]` exactly: the owning schema only, no fallback to the session default path.
That is deliberately stricter than a stored view body (home schema, then the default
path), and matches what `check` / foreign-key bodies already did.

The two internal narrowings in `buildConstraintChecks` and both foreign-key builders were
removed so one place decides. `core/derived-row-validator.ts` builds those same two
builders on its own `freshPlanningContext(db)`, which never went through the helper — it
is now wrapped with the maintained table's schema, otherwise removing the internal
narrowing would have silently dropped it there.

For a multi-source / decomposition view insert, the anchor key column's declared `default`
is the one schema-authored expression the lowering compiles itself (`buildKeyDefault`).
Its owner is the **anchor base table's** schema, which can differ from the view's, so
`MsInsertAnalysis` / `DecompInsertAnalysis` now carry `keyDefaultSchemaName` alongside
`keyDefault` and thread it through.

## Behaviour change to be aware of

A column `default` or generated-column expression that names a relation in **another**
schema without qualifying it no longer resolves — it becomes a plan-time "table not
found". This is the rule `check` and foreign-key bodies always had, and is now documented
as one rule for all four in `docs/schema.md`. The whole workspace suite is green, so no
existing test depended on the loose behaviour.

## How to validate

New file: `packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic`,
modelled on its sibling `13.9-schema-authored-cte-isolation.sqllogic` (the
common-table-expression half of the same leak). Same discipline: every arm places a
**decoy** relation in the schema the writer is pointed at, the real one beside the table,
the two disagree, and the assertion pins the owning schema's answer.

Arms, all with the real tables in `temp` (3-row `temp.c`) and the decoy in `main`
(1-row `main.c`), session path `main`:

- column `default` under the session `pragma schema_path`
- generated column on the INSERT path
- `not null` column default via `insert or replace … values (…, null)`
- the UPDATE-path build (`building/update.ts`), pinned by a `check` and by a
  `check on update` in both directions
- per-statement `insert … with schema main` while the session path is `temp` — distinct
  from the session pragma, and the only arm that separates the two
- `check` and child-side foreign key as controls (already correct before; they must stay
  correct now that the builders no longer narrow themselves)
- write-through a view whose base table lives in the non-default schema
- the multi-source anchor key default, twice: once with view and bases both in `temp`
  (`kd_*`), once with the **view in `main` and the anchor in `temp`** (`ks_*`) — that
  second one is what pins `keyDefaultSchemaName` rather than the view's own schema
- a control that a *qualified* reference inside a default is unaffected
- the strict rule: a default naming a `main`-only relation from a `temp` table errors
- a user-declared schema (`declare schema spapp { … } / apply schema spapp`), so the
  coverage is not reading a `temp`-only special case

**Each arm was verified to fail without the fix**, not just to pass with it: the narrowing
was temporarily disabled behind a scratch env flag and the arms were bisected into a
throwaway file one at a time (the runner bails a file on first mismatch). Observed wrong
answers matched the ticket's repro — `w = 1` instead of `3`, and `rid = 501` instead of
`101` on the multi-source anchor. The scratch file and flag are gone.

Manual smoke, if you want it by hand:

```sql
create table main.c (k integer primary key);
insert into main.c values (1);
create table temp.c (k integer primary key);
insert into temp.c values (1), (2), (3);
create table temp.t (id integer primary key,
                     w integer default (select count(*) from c),
                     check ((select count(*) from c) = 3));
pragma schema_path = 'main';
insert into temp.t (id) values (1);
select id, w from temp.t;   -- w = 3 (was 1)
```

## Known gaps — please treat these as the floor, not the finish line

- **ALTER TABLE ADD COLUMN is changed but untested.** The backfill DEFAULT / GENERATED
  build in `building/alter-table.ts` now goes through the helper, but the arm cannot be
  pinned: any relation-reading backfill expression fails to emit at all on the ALTER path,
  tracked separately as `bug-alter-add-column-relation-default-fails-to-emit`. The change
  was made anyway so that ticket does not ship a fresh instance of this bug. No test
  covers it; do not read the green suite as coverage there.
- **Generated column recomputed on UPDATE has no arm.** A subquery-bearing generated
  column recomputed by an UPDATE currently stores the unresolved promise itself
  (`{}` in the result) — that is `bug-update-generated-column-subquery-not-awaited` in
  `tickets/fix/`, an un-awaited evaluator in `runtime/emit/update.ts`, unrelated to schema
  paths. The UPDATE-path narrowing is instead pinned by a `check` built on the *same*
  context object (`schemaAuthoredUpdateCtx`), so the code path is covered but that
  specific expression kind is not. The test file says so at the site; add the arm when
  that fix lands.
- **`core/derived-row-validator.ts` has no new arm.** The wrap is the trap the ticket
  called out — removing the builders' internal narrowing without it would silently drop
  narrowing for a maintained table's CHECK / FK bodies. It is reasoned, not demonstrated:
  no test places a maintained table and a colliding relation name in a non-default schema.
  A reviewer wanting to close this would need a `create table … maintained as` in `temp`
  with a subquery CHECK naming a relation present in both schemas.
- **Parent-side foreign-key probe** has no new arm here either; `13.9` covers its
  common-table-expression sibling, and the existing suite is green.
- **Store mode not run.** `yarn test:store` (LevelDB backend) was not executed — this is a
  planner-level change with no storage surface, but it is a real omission.
- One tripwire recorded in code, not filed: `buildKeyDefault` falls back to the view's
  schema when `keyDefaultSchemaName` is absent. Both analyses always set it, so the
  fallback is unreachable today; a `NOTE:` at the site says to make the field required on
  the analysis types rather than widen the fallback if a third analysis ever appears.

## Validation run

- `yarn test` — green. 8664 quereus tests (8663 before; +1 for the new logic file) plus
  every other workspace package. No failures.
- `yarn lint` — clean.
- `npx tsc -b tsconfig.build.json` — clean.
- `docs/schema.md` net −27 words (13184 → 13157), so the pre-existing documentation
  size ratchet (`debt-docs-size-ratchet-red-again`) is not made worse.
