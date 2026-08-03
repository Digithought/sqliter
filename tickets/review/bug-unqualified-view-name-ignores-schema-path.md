---
description: Views stored outside the default schema can now be used without spelling out their schema every time, as long as the schema is on the search path — the same rule tables already followed.
files:
  - packages/quereus/src/schema/manager.ts                    # new findSchemaItem (~825), beside getSchemaItem
  - packages/quereus/src/schema/view.ts                       # new isViewSchema narrowing guard (~31)
  - packages/quereus/src/planner/building/select.ts           # ~433 FROM-clause dispatch now path-aware
  - packages/quereus/src/planner/building/insert.ts           # ~550 DML target dispatch
  - packages/quereus/src/planner/building/update.ts           # ~101 DML target dispatch
  - packages/quereus/src/planner/building/delete.ts           # ~101 DML target dispatch
  - packages/quereus/src/planner/mutation/single-source.ts    # ~499 nested-view / MV write-through guards
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic  # tests 20-26 (new)
  - packages/quereus/test/view-home-schema.spec.ts            # 2 new nested-object write-through rejects
  - docs/sql-select.md                                        # § 2.1.1 Schema Search Path
repro: verified
---

# Unqualified view names resolve through the schema search path

## What changed

Before: an unqualified relation name in a `FROM` clause or as a DML target was
checked for a **view** in exactly one schema — the explicit qualifier if given,
else the *current* schema (an embedder-only setting, normally `main`). Only
tables walked the session/statement search path. So a view living in `temp` (or
any non-`main` schema) was unreachable without writing `temp.rv` every time,
even when `pragma schema_path = 'temp,main'` explicitly named its schema. The
error message read `Table 'rv' not found in schema path: temp, main` — naming
the very schema the view sits in.

After: one new resolver, `SchemaManager.findSchemaItem(itemName, dbName?,
schemaPath?)`, walks the path **one schema at a time**, checking that schema's
tables *and* views together before moving on. All five dispatch sites route
through it. A qualified name still searches only the named schema.

Tables and views share one namespace inside a schema (`create table` rejects a
name a view holds and vice versa), so at most one can match per path entry —
which settles ordering: **a table in an earlier path entry beats a view in a
later one.**

Supporting pieces:

- `isViewSchema(item)` in `schema/view.ts` — narrowing guard splitting the
  `TableSchema | ViewSchema` result. Keys on the top-level `selectAst`, which a
  `TableSchema` never has (a materialized view's body hangs off
  `derivation.selectAst`).
- `single-source.ts` nested-object write-through guards now resolve the body's
  source name on the **body's own home path** (`bodyPlanningContext(ctx,
  view).schemaPath`), not the writing statement's. This closes the hole the
  change would otherwise open: now that a non-`main` view's body *can* name
  another view unqualified, the write-through analyzer must recognise it as a
  nested view and reject cleanly rather than mis-rewriting against the inlined
  base table. The stale `NOTE:` block that pointed at this ticket is gone.
- `building/select.ts` lost its `findTable` maintained-table fallback — the new
  resolver covers that case directly.

## Deliberate behaviour changes (intended, both wanted by the bug report)

- `select … from v with schema myapp` now finds `myapp.v`. It previously looked
  in the current schema and failed.
- An embedder that sets a non-`main` current schema via
  `SchemaManager.setCurrentSchema` **without** also setting `schema_path` loses
  unqualified *view* resolution — which is already exactly what happens to its
  tables. `docs/sql-select.md` § 2.1.1 documents that asymmetry ("DDL landing vs.
  read resolution"); views now obey the documented rule instead of opting out.
  No test in the tree depended on the old behaviour.

## Use cases to exercise when reviewing

Reading (session path):

```sql
create table temp.rt (id integer primary key, x integer);
insert into temp.rt values (1, 10);
create view temp.rv as select id, x from rt;

pragma schema_path = 'main';
select * from rv;            -- still "not found" — temp is OFF the path (correct;
                             -- an unqualified TABLE in temp fails identically)
pragma schema_path = 'temp,main';
select * from rv;            -- [{id:1,x:10}]
```

Statement-level path, writes, and composition:

```sql
select id, x from rv with schema "temp";        -- `temp` is a keyword here, quote it
update rv set x = 12 where id = 1 with schema "temp";
insert into rv (id, x) values (2, 20);          -- under schema_path='temp,main'
delete from rv where id = 2;
create view temp.rv2 as select id, x from rv;   -- view over a non-main view
select * from rv2;
```

Ordering across path entries (table beats view when it comes first):

```sql
create table main.dual_name (...); create view temp.dual_name as ...;
pragma schema_path = 'main,temp';  select tag from dual_name;  -- the TABLE
pragma schema_path = 'temp,main';  select tag from dual_name;  -- the VIEW
select tag from main.dual_name;                                -- qualified, path-independent
```

Nested-object write-through must still reject (not mis-rewrite):

```sql
create view temp.nnv as select id, x from nv;   -- nv is itself a temp view
update temp.nnv set x = 11 where id = 1;
-- → "…references another view; nested-view mutation is not yet supported"
-- and the same for an unqualified materialized view in the body:
-- → "…its body reads a materialized view…"
```

## Validation performed

- `packages/quereus/test/logic/06.4-schema-search-path.sqllogic` — tests 20-26
  added (~107 lines): qualified baseline; off-path miss for view *and* table
  side by side; on-path hit for both; view-over-view in the same non-`main`
  schema; unqualified INSERT / UPDATE / DELETE through a non-`main` view;
  statement-level `with schema` for both read and write; within-path ordering
  both directions plus qualified-wins.
- `packages/quereus/test/view-home-schema.spec.ts` — two new specs pinning the
  nested-view and nested-materialized-view write-through rejects, including that
  the base table is untouched after the rejected write.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run test` — **8441 passing, 0 failing,
  13 pending** (3m). Pre-change baseline recorded in the implement ticket was
  8439 passing; the delta is exactly the two new specs. No regressions.
- `yarn lint` (all workspaces) — clean.

## Known gaps / things worth an adversarial look

- **Test schemas used are `main` and `temp` only.** The sqllogic file has a
  `declare schema myapp { … }` section earlier that I did not extend; a
  user-declared (non-`temp`) schema exercises the same code path but is not
  independently pinned for the *unqualified view* case. Worth adding if the
  reviewer wants that coverage — the mechanism is identical, so I judged it
  redundant rather than missing.
- **No test for a `schemaPath`-less context.** `findSchemaItem` falls back to
  `['main', 'temp']` when handed no path, mirroring `_findTable`'s no-path
  branch. In practice the session option `schema_path` defaults to `'main'`, so
  a context path is essentially always set and that branch is not covered by a
  test. Reviewer may want to confirm the two resolvers cannot diverge here.
- **Precedence within a single schema.** `findSchemaItem` delegates per entry to
  the existing `getSchemaItem`, which checks views before tables. That
  intra-schema order is unobservable today because DDL forbids the collision —
  but it is an assumption inherited, not re-proved, by this change.
- **`scope-transform.ts:409 tableSourceColumnNames` still resolves an unqualified
  table/view against the current schema, not the path.** Now newly reachable
  (a non-`main` view body can name another view unqualified), but the failure
  mode is `null` → "scope tainted" → the conservative reject/carry branch, not a
  wrong rewrite. The site is already claimed by the open
  `fix/bug-view-write-subquery-in-body-uses-caller-schema` ticket, so I did not
  file a new one and did not touch it.
- **`bodyPlanningContext(ctx, view)` is called once more per single-source view
  analysis** (it allocates a small context object and re-parses `schema_path` via
  `Database._homeSchemaPath`). Same call the body plan a few lines above already
  makes; `_homeSchemaPath` already carries its own memoize-if-hot `NOTE:`.
