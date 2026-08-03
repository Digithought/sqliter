---
description: A view stored in a schema other than the default one can only be used if you spell out its schema every time; leaving the schema off fails with "not found", even when the search path explicitly includes that schema.
files:
  - packages/quereus/src/schema/manager.ts                    # add findSchemaItem (path-aware) next to getSchemaItem (~814) / findTable (~714)
  - packages/quereus/src/schema/view.ts                       # add the isViewSchema narrowing guard
  - packages/quereus/src/planner/building/select.ts           # ~433 FROM-clause view/MV dispatch
  - packages/quereus/src/planner/building/insert.ts           # ~549 DML target dispatch
  - packages/quereus/src/planner/building/update.ts           # ~100 DML target dispatch
  - packages/quereus/src/planner/building/delete.ts           # ~100 DML target dispatch
  - packages/quereus/src/planner/mutation/single-source.ts    # ~499 nested-view write-through guard (carries a NOTE pointing at this ticket)
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic  # where path-resolution behavior is pinned
  - docs/sql-select.md                                        # § 2.1.1 Schema Search Path
repro: verified
---

# An unqualified view name must resolve through the schema search path

Tables resolve through the schema search path; **views do not**. A view is found
only if it lives in the current schema, or if the caller spells the schema out.

Reproduced on a clean tree (`main` @ 1fe67043):

```
create table temp.rt (id integer primary key);
insert into temp.rt values (1);
create view temp.rv as select id from temp.rt;

select * from temp.rv;              -- OK: [{id:1}]
pragma schema_path = 'temp,main';
select * from rv;                   -- Table 'rv' not found in schema path: temp, main   <-- but it IS in temp
select * from rt;                   -- OK: [{id:1}] — the TABLE resolves through the same path
delete from rv where id = 99;       -- Table 'rv' not found in schema path: temp, main
create view temp.nv2 as select id from rv;   -- same failure: no view can be composed over a non-main view
```

The error text names the very path the view sits in, which makes the behavior
read as a bug rather than a restriction.

## Root cause

One decision repeated at five sites: *resolve the name in exactly one schema*
(explicit, else the current schema) instead of walking the search path.

| site | today |
| --- | --- |
| `planner/building/select.ts` ~433 | `getView(schema ?? currentSchema, name)`, plus a `findTable` fallback that path-resolves only *maintained* tables |
| `planner/building/insert.ts` ~549 | `getMaintainedTable(schema ?? null, …)` + `getView(schema ?? null, …)` |
| `planner/building/update.ts` ~100 | same pair |
| `planner/building/delete.ts` ~100 | same pair |
| `planner/mutation/single-source.ts` ~499 | same pair, guarding nested-view write-through — already carries a `NOTE:` naming this ticket |

`getView(schemaName, …)` and `getMaintainedTable(schemaName, …)` resolve in one
schema. `SchemaManager` has no path-aware sibling that covers views —
`findTable` covers only tables.

## The fix (prototyped and validated, then reverted — see § Evidence)

Add one path-aware resolver to `SchemaManager` and route all five sites through
it. Tables and views share a single namespace inside a schema (`create table`
rejects a name a view holds, and vice versa — pinned in
`test/schema-manager.spec.ts`), so per path entry at most one can match. That
settles the ordering question the fix ticket raised: **walk the path one schema
at a time, checking that schema's tables and views together**, rather than
sweeping all tables across the path first. A table in an earlier path entry
therefore beats a view in a later one.

`schema/manager.ts`, next to `getSchemaItem`:

```ts
	/**
	 * Resolves a table-or-view name the way an unqualified name resolves: one
	 * search-path entry at a time, checking that schema's tables AND views
	 * together before moving to the next entry. Tables and views share one
	 * namespace within a schema, so at most one of the two can match per entry.
	 *
	 * @param itemName Name of the table or view
	 * @param dbName Optional explicit schema (a qualified name searches only it)
	 * @param schemaPath Optional ordered search path (default: main, then temp)
	 */
	findSchemaItem(itemName: string, dbName?: string, schemaPath?: string[]): TableSchema | ViewSchema | undefined {
		if (dbName) return this.getSchemaItem(dbName, itemName);
		const path = schemaPath && schemaPath.length > 0 ? schemaPath : ['main', 'temp'];
		for (const schemaName of path) {
			const item = this.getSchemaItem(schemaName, itemName);
			if (item) return item;
		}
		return undefined;
	}
```

The `['main', 'temp']` default mirrors `_findTable`'s no-path branch, so both
resolvers agree when a context carries no path. (In practice the session option
`schema_path` defaults to `'main'`, so the context path is almost always set.)

`schema/view.ts` needs a narrowing guard so callers can split the result — a
view carries a top-level `selectAst`; a `TableSchema` (including a maintained
table, whose body hangs off `derivation.selectAst`) does not:

```ts
/** Narrowing guard: true iff `item` is a view (not a table / maintained table). */
export function isViewSchema(item: TableSchema | ViewSchema | undefined): item is ViewSchema {
	return item !== undefined && 'selectAst' in item;
}
```

`building/select.ts` — the whole `schemaName` / `getView` / `getMaintainedTable`
/ `findTable`-fallback block collapses to:

```ts
			const resolvedItem = parentContext.db.schemaManager.findSchemaItem(
				fromClause.table.name,
				fromClause.table.schema,
				parentContext.schemaPath,
			);
			const viewSchema = isViewSchema(resolvedItem) ? resolvedItem : undefined;
			const maintainedTable = !isViewSchema(resolvedItem) && isMaintainedTable(resolvedItem) ? resolvedItem : undefined;
```

The three DML builders take the same shape (note the path comes from
`contextWithSchemaPath`, so a statement-level `with schema` is honoured):

```ts
	const insertTarget = ctx.schemaManager.findSchemaItem(stmt.table.name, stmt.table.schema, contextWithSchemaPath.schemaPath);
	const insertView = isViewSchema(insertTarget) ? insertTarget
		: (isMaintainedTable(insertTarget) ? maintainedTableViewLike(insertTarget) : undefined);
```

`mutation/single-source.ts` — resolve the body's source name on the **body's own
home path** (the path `bodyPlanningContext` already plans it under), replacing
the `NOTE:` block, and reuse the result for the materialized-view arm below it:

```ts
	const bodySource = ctx.schemaManager.findSchemaItem(
		fromTable.table.name,
		fromTable.table.schema,
		bodyPlanningContext(ctx, view).schemaPath,
	);
	if (isViewSchema(bodySource)) { /* nested-view reject, unchanged */ }
	…
	if ((!isViewSchema(bodySource) && isMaintainedTable(bodySource)) || isMaintainedTable(baseTable)) { /* MV reject, unchanged */ }
```

This guard is what stops `bug-unqualified-view-name-ignores-schema-path` from
opening a hole: once a non-`main` view's body can name another view unqualified,
the write-through analyzer must still recognise it as a nested view and reject
cleanly rather than mis-rewriting.

### Deliberate precedence change

Today an unqualified name checks the **current schema** for a view. After the
fix it checks the **path**, exactly as a table does. Two consequences, both
intended and both wanted by the ticket's expected behavior:

- `select … from v with schema myapp` now finds `myapp.v` (today it looks in
  `main` and fails).
- An embedder that sets a non-`main` current schema via
  `SchemaManager.setCurrentSchema` *without* also setting `schema_path` loses
  unqualified view resolution — which is already exactly what happens to its
  tables. `docs/sql-select.md` § 2.1.1 already documents that asymmetry ("DDL
  landing vs. read resolution"); this change makes views obey the documented
  rule instead of quietly opting out. No test in the tree depends on the old
  behavior.

## Evidence

The patch above was applied end-to-end and validated, then reverted so this
stage hands off a clean tree:

- the repro script above goes fully green (`select * from rv`,
  `delete from rv`, and `create view temp.nv2 as select id from rv` all
  succeed); `select * from rv` under the default path `'main'` still fails,
  correctly — `temp` is not on that path, and an unqualified *table* in `temp`
  fails identically.
- `yarn workspace @quereus/quereus run typecheck` clean.
- `yarn workspace @quereus/quereus run test` → **8439 passing, 0 failing,
  13 pending** (3m). No regressions.

So the remaining work is genuinely the tests and docs, not the mechanism.

## Expected behavior (unchanged from the fix ticket)

- An unqualified view name resolves through the same schema search path an
  unqualified table name does — session `schema_path` and statement-level
  `with schema` alike.
- Ordering is the path's: the first schema in the path holding an object of that
  name wins, whether it is a table or a view.
- The view's own body keeps resolving on its home-schema path, unchanged.
- Qualified references (`temp.rv`) are unaffected.

## Related, not blocking

`fix/bug-view-write-subquery-in-body-uses-caller-schema` also lists
`single-source.ts` in its `files:`, but at different sites (the copied
`filterPredicate` / writable-site expressions), for a different root cause. The
two land independently; neither needs the other.

## TODO

- Add `findSchemaItem` to `SchemaManager` (beside `getSchemaItem`) and
  `isViewSchema` to `schema/view.ts`, with the doc comments above.
- Route `building/select.ts` FROM-clause dispatch through `findSchemaItem`,
  deleting the now-redundant `findTable` maintained-table fallback.
- Route the `insert.ts` / `update.ts` / `delete.ts` target dispatch through it,
  taking the path from each builder's `contextWithSchemaPath`.
- Re-point the `single-source.ts` nested-view guard (and the maintained-table
  arm beside it) at `bodyPlanningContext(ctx, view).schemaPath`, replacing the
  `NOTE:` block that names this ticket.
- Extend `test/logic/06.4-schema-search-path.sqllogic`: an unqualified view read
  resolving via `pragma schema_path`; via statement-level `with schema`; a view
  composed over another view in the same non-`main` schema; unqualified
  INSERT / UPDATE / DELETE through a non-`main` view; and a qualified reference
  still winning over the path.
- Pin the within-path ordering: a **table** named `x` in an earlier path entry
  and a **view** named `x` in a later one — the table wins. (A same-schema
  table/view collision is impossible; `create table` / `create view` reject it.)
- Pin the nested-view write-through guard: a non-`main` view whose body names
  another view in that schema unqualified must reject with the existing
  "references another view; nested-view mutation is not yet supported"
  diagnostic, not mis-rewrite. Suitable home:
  `test/view-home-schema.spec.ts`.
- Update `docs/sql-select.md` § 2.1.1: unqualified resolution covers views as
  well as tables, and the path is walked one schema at a time with that schema's
  tables and views checked together.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`.
