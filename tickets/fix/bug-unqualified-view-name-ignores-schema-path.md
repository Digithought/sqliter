---
description: A view stored in a schema other than the default one can only be used if you spell out its schema every time; leaving the schema off fails with "not found", even when the search path explicitly includes that schema.
files:
  - packages/quereus/src/planner/building/select.ts   # ~433 — the FROM-clause view lookup that consults only the current schema
  - packages/quereus/src/schema/manager.ts            # getView (~756) resolves one schema; findTable (~ nearby) is the path-aware sibling
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic  # where path-resolution behavior is pinned
repro: verified
---

# An unqualified view name never resolves through the schema search path

Tables resolve through the schema search path; **views do not**. A view is found
only if it lives in the current schema, or if the caller spells the schema out.

Reproduced against a clean tree:

```
create table temp.rt (id integer primary key);
insert into temp.rt values (1);
create view temp.rv as select id from temp.rt;

select * from temp.rv;              -- OK: [{id:1}]
select * from rv;                   -- Table 'rv' not found in schema path: main
pragma schema_path = 'temp,main';
select * from rv;                   -- Table 'rv' not found in schema path: temp, main   <-- but it IS in temp
select * from rt;                   -- OK: [{id:1}] — the TABLE resolves through the same path
```

The error text names the very path the view sits in, which makes the behavior
read as a bug rather than a restriction.

The lookup is `planner/building/select.ts` ~433:

```ts
const schemaName = fromClause.table.schema || parentContext.db.schemaManager.getCurrentSchemaName();
const viewSchema = parentContext.db.schemaManager.getView(schemaName, fromClause.table.name);
```

`getView(schemaName, …)` resolves in exactly one schema. Two lines below, the
maintained-table (materialized view) arm already compensates by falling back to
`schemaManager.findTable(name, undefined, parentContext.schemaPath)` when the
name is unqualified — the plain-view arm has no equivalent.

## Why it matters beyond the direct symptom

A view cannot be composed over another view in a non-`main` schema at all:

```
create table temp.nt (id integer primary key, x integer);
create view temp.nv1 as select id, x from nt;
create view temp.nv2 as select id, x from nv1;   -- Table 'nv1' not found in schema path: temp, main
```

The `create view` body already plans on the owning schema's home path (the
message shows `temp, main`), so the only thing standing in the way is this
lookup.

That same gap currently masks a latent hole in the view-write-through substrate:
`planner/mutation/single-source.ts` `analyzeView` (~497) rejects a body that
sources another view using `getView(fromTable.table.schema ?? null, …)` — also
current-schema-only. That guard silently stops matching for a non-`main` view's
unqualified body the moment view names start path-resolving. Fixing this ticket
should re-point that guard (and the sibling `getMaintainedTable` call at ~513,
which today is saved by a plan-resolved `isMaintainedTable` fallback beside it) at
the body's home path. A `NOTE:` at that site is being added by
`implement/bug-view-write-through-ignores-home-schema`.

## Expected behavior

- An unqualified view name resolves through the same schema search path an
  unqualified table name does — session `schema_path` and statement-level
  `with schema` alike.
- Ordering is the path's: the first schema in the path holding an object of that
  name wins, whether it is a table or a view. A name collision between a table in
  an earlier path entry and a view in a later one resolves to the earlier.
- The view's own body keeps resolving on its home-schema path, unchanged.
- Qualified references (`temp.rv`) are unaffected.

## Worth settling while scoping

Views and tables live in separate catalog maps but share a namespace within a
schema (`create table` already rejects a name held by a view). The fix therefore
has to decide the lookup order *within* one path entry — check that schema's
tables and views together before moving to the next path entry, rather than
sweeping all tables across the path and then all views. Pin whichever it is with
a test.
