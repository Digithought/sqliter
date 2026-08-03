---
description: Writing through a view can wrongly reject the statement, or change the wrong rows, when a sub-query in the statement (or in the view's own definition) reads a table that lives in a schema other than the default one.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts        # tableSourceColumnNames (~469), transformScopedQuery (~592) — the fix site
  - packages/quereus/src/planner/mutation/cte-flatten.ts            # baseColumnsOf (~423) — same lookup bug, third arm
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt (~73-86) — the resolution order this must mirror
  - packages/quereus/src/planner/building/select-context.ts         # enterStoredBodyEnv (~145) — the plan-time twin
  - packages/quereus/src/planner/stored-body-context.ts             # storedBodyContext
  - packages/quereus/src/schema/manager.ts                          # findSchemaItem (~838), findTable (~714) — the path-aware lookups
  - packages/quereus/test/view-home-schema.spec.ts                  # nearby write-through / home-schema coverage
  - packages/quereus/docs/view-updateability.md                     # § Schema resolution during write-through
repro: verified
difficulty: medium
---

# The write-through sub-query analysis looks up tables in the wrong schema

Before a write through a view can be lowered onto its base table, the planner
analyses every sub-query in the statement to decide, for each column reference
inside it, whether that reference belongs to the sub-query's own `from` sources
or is a reference reaching *outward* to the view's row. Getting that wrong
either aborts the statement or silently rewrites it to mean something else.

The analysis answers "which columns does this `from` source have?" by looking the
source's name up in **one fixed schema** — the connection's current schema,
normally `main`. It consults neither the session's schema search path nor, for a
piece of the view's own definition, the schema the view lives in. So the moment
the real source lives anywhere else, the analysis works from the wrong table's
column list (or from no table at all) while the query actually executes against
the right one.

All three arms below were reproduced on the current tree, and all three are
fixed by the validated patch further down (full `packages/quereus` suite: 8516
passing, 0 failing, with the patch applied).

## Arm 1 — a sub-query in the user's own statement is wrongly rejected

The table is perfectly resolvable; it is just reached through the session schema
path rather than sitting in `main`:

```sql
pragma schema_path = 'temp,main';
create table temp.t (id integer primary key, x integer);
create table temp.side (tag text primary key, id integer);
create view temp.v as select id, x from t;

update temp.v set x = 99 where exists (select 1 from side where side.id = id and x > 0);
```

fails with

```
cannot write through view 'v': the reference 'id' inside a subquery cannot be
proven correlated to the view because the subquery's source columns are not
statically resolvable (a 'select *' / table-valued function / unresolved
source); qualify the reference with its base table or alias, or restructure the
predicate
```

`temp.side` is not a `select *`, not a table-valued function and not unresolved —
the same statement with every object in `main` succeeds. The diagnostic tells the
user to restructure a predicate that is fine.

## Arm 2 — a sub-query inside the view's definition changes meaning

Here the analysis reaches a *different* table of the same name and concludes the
opposite of the truth, so the lowered statement is rewritten wrongly:

```sql
create table temp.gt (id integer primary key, x integer);
create table temp.gl (id integer primary key, lbl text);
create table main.gl (gid integer primary key, lbl text);   -- same name, no `id`
create table main.side (tag text primary key);
insert into temp.gt values (1, 10), (2, 20);
insert into temp.gl values (1, 'one'), (2, 'two');
insert into main.side values ('one');
create view temp.gv as select id, x, (select lbl from gl where id = 1) as lbl from gt;

select id, x, lbl from temp.gv;
-- [{id:1,x:10,lbl:'one'}, {id:2,x:20,lbl:'one'}]   — `id` reads temp.gl's `id`

update temp.gv set x = 77 where exists (select 1 from side where side.tag = lbl);
-- QuereusError: Scalar subquery returned more than one row
```

The read binds `id` to `temp.gl.id`, so the sub-query returns one row. The
lowering, having sized up `gl` as `main.gl` (which has no `id`), decides `id`
must be an outward reference to the row being updated and re-points it at the
update target — the lowered predicate becomes `(select lbl from gl where
__vm_self.id = 1)`, which is no longer single-row. With a slightly different
column layout the same mis-decision produces no error at all, only a different
row set than the matching read.

## Arm 3 — the same lookup bug in the CTE-body flattener (found during this fix)

Not in the ticket as filed; found while auditing sibling lookups. A DML target
whose body is a chain of common table expressions is flattened down to a single
base-table body, and one step of that flattening needs the base table's ordered
column list to pair it with a column-rename list. That lookup has the identical
fixed-schema shape (`schema/manager.ts`'s `getTable`, no search path), so an
off-`main` base table makes it look unresolvable:

```sql
pragma schema_path = 'temp,main';
create table temp.ml (id integer primary key, v integer);
insert into temp.ml values (1, 10);
with a (p, q) as (select * from ml), t as (select * from a) update t set q = 99 where p = 1;
```

fails with

```
cannot write through common table expression 'a': a column rename over a
'select *' body whose source columns are not statically resolvable cannot be
inlined
```

The same statement with `main.ml` succeeds. This target is *ephemeral* (part of
the caller's own statement, never a stored body), so it needs only the caller's
search path — no home-schema reasoning.

## Root cause

Two call sites, one defect: a static "what columns does this FROM source have?"
lookup in the write-through lowering that bypasses schema-path resolution and
falls back to the connection's current schema.

- `tableSourceColumnNames` in `planner/mutation/scope-transform.ts` (arms 1 & 2)
  calls `schemaManager.getTable(schemaName, name)` / `getView(schemaName, name)`.
  Both default an unqualified name to `SchemaManager.currentSchemaName`; neither
  takes a search path.
- `baseColumnsOf` in `planner/mutation/cte-flatten.ts` (arm 3) calls the same
  `getTable`.

The executing plan resolves the identical names through
`schemaManager.findSchemaItem(name, explicitSchema, ctx.schemaPath)` —
`building/select.ts`'s FROM branch — and `findTable(name, schema, ctx.schemaPath)`
via `resolveTableSchema`. The analysis and the plan therefore disagree.

Arm 2 needs one extra step beyond swapping in the path-aware lookup. The two
callers that reach the analysis (`makeBaseQualifier` and `makeViewColumnDescend`
in `mutation/single-source.ts`) both hand it the **caller's** planning context.
That is right for the user's own clauses but wrong for a fragment copied out of
the view's definition, which must resolve on the view's home schema path —
exactly as the already-landed `bug-view-write-subquery-in-body-uses-caller-schema`
made the *plan-time* resolution of those fragments do. That fix moved plan time
to the home path and left this analysis behind.

The naming environment is already on the tree and needs no new plumbing.
`buildViewMutation` (`building/view-mutation-builder.ts:123-135`) stamps every
nested sub-select of the stored body with `AST.SelectStmt.storedBodyEnv` — an
`AST.StoredBodyEnv` carrying the view's home schema, the body's declared
`with schema` path, and the body's own leading `with` clause — **before**
`propagate` runs, so the analysis walks the stamped tree. `buildSelectStmt` reads
that same field at plan time via `enterStoredBodyEnv`; the analysis has only to
mirror it.

## Expected behavior

The analysis must resolve a `from` source's identity the same way the executing
plan does:

- a source named in the user's own clauses resolves through the session schema
  path (and any statement-level `with schema`), not through one fixed schema;
- a source named inside a fragment copied out of the view's definition resolves
  through the **view's** home schema path, then the body's declared `with schema`
  path, then the fragment's own `with schema` clause — the same order, and the
  same precedence, as `buildSelectStmt`;
- a genuinely unresolvable source (`select *`, a table-valued function, an
  unknown name) keeps today's conservative treatment — that path is correct and
  must not be weakened.

Arm 1's statement updates the matching rows. Arm 2's update affects the same rows
the matching `select` returns. Arm 3's update lands on `temp.ml`.

## Validated patch

This diff was applied, verified against all three arms, and run against the full
`packages/quereus` suite (8516 passing, 0 failing), then reverted so the tree sits
at the stage boundary. It is a starting point, not finished work — it carries none
of the explanatory comments this module holds itself to, and no tests. Take the
shape, write the prose.

```diff
--- a/packages/quereus/src/planner/mutation/scope-transform.ts
+++ b/packages/quereus/src/planner/mutation/scope-transform.ts
@@ -1,5 +1,7 @@
 import type * as AST from '../../parser/ast.js';
 import type { PlanningContext } from '../planning-context.js';
+import { isViewSchema } from '../../schema/view.js';
+import { storedBodyContext } from '../stored-body-context.js';

@@ tableSourceColumnNames @@
 	const schemaName = src.table.schema;
-	const table = ctx.schemaManager.getTable(schemaName, src.table.name);
-	if (table) return new Set(table.columns.map(c => c.name.toLowerCase()));
-	const view = ctx.schemaManager.getView(schemaName ?? null, src.table.name);
-	if (view) {
-		return view.columns && view.columns.length > 0
-			? new Set(view.columns.map(c => c.toLowerCase()))
-			: projectionOutputNames(view.selectAst);
+	const item = ctx.schemaManager.findSchemaItem(src.table.name, schemaName, ctx.schemaPath);
+	if (item && !isViewSchema(item)) return new Set(item.columns.map(c => c.name.toLowerCase()));
+	if (item) {
+		return item.columns && item.columns.length > 0
+			? new Set(item.columns.map(c => c.toLowerCase()))
+			: projectionOutputNames(item.selectAst);
 	}
 	// A CTE / context-backed source … (unchanged from here down)

@@ new helper, above `--- scope-aware substitution ---` @@
+function fromResolutionContext(ctx: PlanningContext, sel: AST.SelectStmt): PlanningContext {
+	const env = sel.storedBodyEnv;
+	let out = ctx;
+	if (env && ctx.storedBodyOf !== env.homeSchema) {
+		out = storedBodyContext(ctx, env.homeSchema);
+		if (env.schemaPath) out = { ...out, schemaPath: env.schemaPath };
+	}
+	if (sel.schemaPath) out = { ...out, schemaPath: sel.schemaPath };
+	return out;
+}

@@ transformScopedQuery @@
 	const sel = query;
-	const local = collectFromColumnNames(ctx, sel.from);
+	const local = collectFromColumnNames(fromResolutionContext(ctx, sel), sel.from);

--- a/packages/quereus/src/planner/mutation/cte-flatten.ts
+++ b/packages/quereus/src/planner/mutation/cte-flatten.ts
@@ baseColumnsOf @@
-	const table = ctx.schemaManager.getTable(fc.table.schema, fc.table.name);
+	const table = ctx.schemaManager.findTable(fc.table.name, fc.table.schema, ctx.schemaPath);
 	return table ? table.columns.map(c => c.name) : null;
```

### Why this shape

- `findSchemaItem` is the primitive `building/select.ts`'s FROM branch already
  uses, so the analysis resolves a name through the same one-path-entry-at-a-time
  walk over each schema's tables **and** views together. Tables and views share
  one namespace per schema, so at most one can match per entry and the old
  table-then-view ordering is preserved by construction.
- `fromResolutionContext` reproduces `buildSelectStmt`'s entry order exactly:
  `enterStoredBodyEnv` (home context, then the body's declared path) followed by
  the fragment's own `SelectStmt.schemaPath` override. The `ctx.storedBodyOf !==
  env.homeSchema` guard is the same at-home guard `enterStoredBodyEnv` carries,
  and keeps the marker inert while the body itself is being analysed.
- It is applied per select rather than threaded, because `mapNestedSelects` stamps
  **every** nested sub-select of the body (including FROM `subquerySource`
  members), so each select re-derives its own environment from its own node.
- The multi-source (join-body) analogue needs no separate change: `multi-source.ts`
  reaches the same analysis through the shared `makeViewColumnDescend` /
  `transformScopedExpr`, both of which funnel into `collectFromColumnNames`. There
  is no second lookup there — confirmed by grep for `getTable(` / `getView(` under
  `planner/mutation/`, which returns only the two sites patched above.

### Known behavioural edge, checked

`storedBodyContext` clears `cteNodes`, so entering a stamped fragment's
environment drops the caller's CTE namespace — correct, but it means a fragment
sub-select naming a **body-local** CTE resolves to nothing and taints the scope
(and `makeBaseQualifyScope` rejects on taint rather than tainting forward). That
is not a regression: before the patch such a name missed the fixed-schema lookup
and fell through to the caller's `cteNodes`, which does not hold body-local
definitions either. Probed directly with a view whose body carries a leading
`with` clause read from a computed column's lineage sub-query — passes both with
and without the patch, because that lineage descent is not reached for this shape.
Worth a regression test either way (below) so the boundary is pinned rather than
incidental.

## TODO

- Apply the patch above to `scope-transform.ts` and `cte-flatten.ts`.
- Write the explanatory comments this module holds itself to — every other helper
  here carries a doc comment stating the rule and why the alternative is wrong:
  - on `tableSourceColumnNames`, why the lookup must be the path-aware
    `findSchemaItem` and not a fixed-schema `getTable` (name the plan-time twin
    in `building/select.ts` so the two stay tied);
  - on `fromResolutionContext`, the three-step order and its precedence, the
    at-home guard, and that it deliberately mirrors `enterStoredBodyEnv` +
    `buildSelectStmt`'s `stmt.schemaPath` override — with a pointer saying the two
    must change together;
  - on `baseColumnsOf` in `cte-flatten.ts`, that an ephemeral CTE target resolves
    on the caller's path (no home-schema swap) and why.
- Add regression coverage. `test/view-home-schema.spec.ts` is the natural home for
  arms 1 and 2 (it already covers write-through under a non-`main` home schema);
  arm 3 belongs wherever the CTE-body flattener is covered. Each case should assert
  the write's row set **equals the matching read's**, not merely that no error is
  raised — arm 2's failure mode is a silent row-set divergence that a
  does-not-throw assertion would miss:
  - arm 1 — session `schema_path` reaching a non-`main` sub-query source;
  - arm 2 — a same-named table in `main` shadowing the view's real source, with
    the `select` and the `update … where` asserted against each other;
  - arm 3 — the CTE rename-over-`select *` chain under a session path;
  - the body-local-CTE boundary from *Known behavioural edge* above, so a future
    change to the `cteNodes` clearing trips a test rather than a user;
  - a negative case pinning that a genuinely unresolvable source (`select *` /
    table-valued function) still raises `unsupported-subquery-correlation` —
    the conservative path must not be weakened by the looser lookup.
- Update `docs/view-updateability.md` § Schema resolution during write-through:
  it currently describes only the plan-time half of this rule. State that the
  static sub-query shadow analysis resolves on the same environment, by the same
  order, and that the two halves are required to agree.
- Run `yarn test` and `yarn lint` from the repo root.

### Out of scope, deliberately

- The `committed` pseudo-schema (`from committed.t`) is not intercepted by this
  analysis the way `resolveTableSchema` intercepts it at plan time. Behaviour is
  unchanged by this patch (unresolvable before, unresolvable after), so it is not
  a regression — but it is a real gap between the analysis and the plan. Leave a
  `NOTE:` at the `tableSourceColumnNames` lookup recording it rather than filing
  a ticket; it only becomes reachable if someone writes through a view with a
  `committed.`-qualified sub-query source.
- Resolving a stamped fragment's body-local CTE names off
  `StoredBodyEnv.withClause` (their columns are derivable from the CTE's declared
  column list or `projectionOutputNames`). This would close the taint described in
  *Known behavioural edge*, but nothing currently reaches it — do not add it
  speculatively.
