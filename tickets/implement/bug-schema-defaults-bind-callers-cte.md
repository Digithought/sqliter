----
description: A column's default value (or a check rule, or a foreign-key check) written in a table's definition can accidentally read a temporary named result set that the surrounding query happened to give the same name, silently storing or accepting the wrong value.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts   # NEW — the helper to add
  - packages/quereus/src/planner/building/insert.ts                    # 4 call sites
  - packages/quereus/src/planner/building/update.ts                    # 5 call sites (incl. generated-column recompute)
  - packages/quereus/src/planner/building/delete.ts                    # 2 call sites
  - packages/quereus/src/planner/stored-body-context.ts                # sibling helper — the pattern to mirror + cross-reference
  - packages/quereus/src/planner/building/constraint-builder.ts        # consumer (no change expected)
  - packages/quereus/src/planner/building/foreign-key-builder.ts       # consumer (no change expected)
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic  # existing control case for the INSERT arm
difficulty: medium
repro: verified
----

# A table's own DDL expressions can bind an enclosing statement's common table expression

## What goes wrong

A column `default`, a generated-column expression, a `check` constraint and a foreign-key
check are all written in the **table's definition**, not in the statement doing the write.
Their unqualified relation names should always mean real schema objects. Today they are
built on a planning context that still carries a *statement's* common table expression
definitions, so a caller can shadow a real table out from under someone else's DDL.

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);

create table p (id integer primary key);
insert into p values (10);

-- t's default is written against the real table c, which has 3 rows.
create table t (id integer primary key, w integer default (select count(*) from c));

with c as (select id from p),
     b as (insert into t (id) values (1) returning id)
select count(*) as n from b;

select id, w from t;
-- actual:   [{"id":1,"w":1}]   <- bound the caller's `c` (1 row from p)
-- expected: [{"id":1,"w":3}]   <- the real table c
```

No error, no warning — just a wrong stored value.

## Reproduction (verified)

Every arm below was run against `HEAD` (memory backend) via a scratch script and observed
to misbehave; each was then observed to behave correctly under the prototype fix described
in *The fix*. Two flavours appear:

- **inherited** — the definitions come from an *enclosing* statement, reaching the builder
  through `ctx.cteNodes`;
- **own** — the definitions come from the write statement's *own* leading `with` clause.

| # | shape | leak | symptom at HEAD |
|---|---|---|---|
| 1 | `insert` — column `default (select count(*) from c)` | inherited | stored `1` instead of `3` |
| 2 | `insert` — generated column `generated always as ((select count(*) from c))` | inherited | stored `1` instead of `3` |
| 3 | `insert` — `check ((select count(*) from c) = 3)` | inherited | `CHECK constraint failed: _check_0` |
| 4 | `update` — same `check` | own `with` | `CHECK constraint failed: _check_0` |
| 5 | `delete` — `check on delete ((select count(*) from c) = 3)` | own `with` | `CHECK constraint failed: _check_0` |
| 6 | `insert` — child-side foreign key `references fkp(id)` | inherited (`with fkp as …`) | `CHECK constraint failed: _fk_fkc_pid` |
| 7 | `update` — same `check` as 4 | inherited | `CHECK constraint failed: _check_0` |
| 8 | `delete` — parent-side `restrict` foreign key | inherited (`with pkc as …`) | *masked* — see below |

Arm 8 is worth a note: the delete is still rejected at HEAD, but only because the runtime
`restrict` pre-walk catches it. The plan-time `not exists` probe built by
`buildParentSideFKChecks` silently bound the caller's `pkc` and passed. Under the fix the
rejection comes from the plan-time check instead (the error text changes from
`FOREIGN KEY constraint failed: DELETE on 'pkp' violates RESTRICT from 'pkc'` to
`CHECK constraint failed: _fk_qkc_pid …` in the shape where the batched-restrict gate
declines). So arm 8 is a **latent** defect today rather than an observable wrong answer —
but it is a real one, and a second backstop is not a reason to leave the probe blind.

Note the arms differ in *which* flavour reaches them, because the two DML builders differ:

- `buildInsertStmt` passes `contextWithSchemaPath` / the bare `ctx` to its schema-authored
  builds, so only **inherited** definitions leak. (Its own `with` clause is already kept
  out — landed by `bug-insert-stmt-context-not-threaded`, pinned by the control case at
  `test/logic/13.8-insert-with-clause-visibility.sqllogic` § "schema-authored DEFAULT
  expressions do NOT bind a caller's CTE".)
- `buildUpdateStmt` / `buildDeleteStmt` pass their CTE-aware `updateCtx` / `deleteCtx` to
  `buildConstraintChecks` (and `updateCtx` to the generated-column recompute and to
  `buildNotNullDefaults`), so **both** flavours leak there.

## Where it comes from

Quereus already has the right idea for view and materialized-view bodies:
`storedBodyContext` (`planner/stored-body-context.ts`) deliberately clears the caller's
common-table-expression namespace when re-entering a stored body, precisely so a caller
cannot shadow names inside DDL-authored SQL. Column defaults, generated columns, `check`
constraints and foreign-key checks are the same *kind* of thing — stored, schema-authored
SQL — but do not go through that clearing.

The path became reachable when data-modifying common table expressions started inheriting
their siblings' definitions through the planning context
(`bug-dml-cte-body-cannot-see-sibling-cte`, completed).

Two details that make the leak land even on a *schema-qualified* synthesized relation:

- `buildFrom` (`planner/building/select.ts`, the `fromClause.type === 'table'` branch)
  matches a common-table-expression name on the **bare** table name and ignores
  `fromClause.table.schema`. The foreign-key probes synthesize `from main.<parent>`, and a
  caller `with parent as (…)` still wins. Fixing that asymmetry is NOT this ticket (see
  *Out of scope*); clearing the namespace makes it moot for schema-authored SQL.
- `buildWithContext` seeds its map from `ctx.cteNodes` and prefers a non-empty explicit
  `parentCTEs` argument over it — so passing an empty map downstream is not sufficient.
  The namespace has to be cleared on the context itself, exactly as `storedBodyContext`
  does.

## Expected behavior

Schema-authored expressions resolve their unqualified names exactly as they do on the read
path — against the schema, never against any statement's temporary named result sets,
whether declared by this statement or inherited from an enclosing one. A caller naming a
temporary result set `c` must not change what `default (select count(*) from c)` means.

## The fix

A small helper alongside `storedBodyContext`, clearing the two CTE-related fields:

```ts
// packages/quereus/src/planner/building/schema-authored-context.ts
export function schemaAuthoredContext(ctx: PlanningContext): PlanningContext {
	if (!ctx.cteNodes && !ctx.cteReferenceCache) return ctx;
	return { ...ctx, cteNodes: undefined, cteReferenceCache: undefined };
}
```

`cteReferenceCache` is cleared for the same reason `storedBodyContext` clears it: the cache
is keyed on bare `cteName:alias`, so a caller definition and a definition declared inside a
`check` subquery's own `with` clause would collide on one entry and the schema-authored SQL
would read the caller's relation.

It deliberately does **not** touch `scope`, `schemaPath`, or `storedBodyOf`:

- `scope` — `buildWithContext` contributes definitions only, never scope symbols, so the
  scope is not a leak channel. `update.ts` / `delete.ts` must keep their table scope
  (`updateCtx.scope` / `deleteCtx.scope`) for `new.`/`old.` resolution, so the helper has to
  be applied *on top of* those contexts, not instead of them.
- `schemaPath` — `buildConstraintChecks` and both foreign-key builders already narrow to
  `[tableSchema.schemaName]` themselves. Column defaults and generated columns do not (they
  ride the statement's path); that asymmetry is real but is a **separate** question — see
  *Out of scope*.
- `storedBodyOf` — these expressions are built inline in the caller's statement, not as a
  re-entered stored body; setting it would wrongly make a `StoredBodyEnv` marker inert.

### Call sites

`insert.ts` — derive once after `contextWithSchemaPath`/`ctx` are settled, then:

- `createRowExpansionProjection(...)` — currently passed `contextWithSchemaPath`; covers
  both column defaults and the generated-column projection chain.
- `buildConstraintChecks(ctx, …)`
- `buildChildSideFKChecks(ctx, …)`
- `buildNotNullDefaults(ctx, …)`

`update.ts` — derive from `updateCtx` (keeping its table scope), then:

- the generated-column recompute `buildExpression(updateCtx, col.generatedExpr)` in the
  `genTopoOrder` loop
- `buildConstraintChecks(updateCtx, …)`
- `buildNotNullDefaults(updateCtx, …)`
- `buildChildSideFKChecks(ctx, …)` and `buildParentSideFKChecks(ctx, …)` — these take the
  bare `ctx`, which still carries the *inherited* definitions

`delete.ts` — derive from `deleteCtx`, then:

- `buildConstraintChecks(deleteCtx, …)`
- `buildParentSideFKChecks(ctx, …)`

That is 11 call sites across 3 files.

### Validation already done

The prototype above was applied to all 11 sites and then reverted. With it in place all
eight repro arms behaved correctly and `yarn test` was fully green — 8662 passing in
`packages/quereus`, 0 failing, and every other workspace package green too. In particular
nothing in the view-mutation / lens decomposition machinery regressed, even though it
injects synthetic capture relations (`__vmupd_keys`, the multi-source envelope) into
`cteNodes`: those are consumed by the user-authored source and predicate builds, not by the
schema-authored ones.

## Out of scope

- **`buildFrom` ignoring the schema qualifier when matching a common-table-expression
  name.** `select * from main.c` binds a `with c as (…)` today. That is its own defect at
  its own site (`planner/building/select.ts`) with its own compatibility question — file
  separately if it is worth chasing; do not fold it in here.
- **Column defaults / generated columns riding the statement's `with schema` path rather
  than the table's home schema path.** Same family of concern, different mechanism
  (`schemaPath`, not `cteNodes`), and no observed wrong answer yet. Leave alone; if the
  implementation makes it trivially adjacent, record it as a `NOTE:` comment at the site
  rather than changing behaviour.
- **`UPDATE` recomputing a generated column whose expression contains a scalar subquery
  storing a non-scalar value.** Found while probing this ticket; tracked separately as
  `bug-update-generated-column-subquery-not-awaited`. It is why an UPDATE arm for the
  *generated-column* leak is not in the table above — the value is already wrong before
  name resolution matters.

## TODO

- Add `packages/quereus/src/planner/building/schema-authored-context.ts` with
  `schemaAuthoredContext`, documented in the register of `stored-body-context.ts` — state
  what it clears and why, what it deliberately does not clear (`scope`, `schemaPath`,
  `storedBodyOf`) and why, and cross-reference `storedBodyContext` as the sibling that does
  the same job for view bodies.
- Add a matching cross-reference from `stored-body-context.ts` back to the new helper, so a
  future reader meeting one finds the other.
- Apply it at the 4 `insert.ts` sites, the 5 `update.ts` sites, and the 2 `delete.ts` sites
  listed above. Derive the context once per builder rather than per call site.
- Update the comment block in `buildInsertStmt` that currently says schema-authored
  expressions "stay on `contextWithSchemaPath` / `ctx`" — that sentence describes the old
  arrangement and will be wrong.
- Add a `.sqllogic` file covering the inherited-definition arms for every schema-authored
  surface: column default, generated column, `check` on insert/update/delete, child-side
  foreign key, parent-side `restrict` foreign key. Cover the `own with clause` arms for
  `update` and `delete` too (they are the ones `13.8` does not reach). Keep the existing
  `13.8` control case as-is.
- Check the view-mutation lowering (`planner/building/view-mutation-builder.ts`,
  `planner/mutation/`) for the same pattern — a re-planned base op re-enters these same
  builders, so it should inherit the fix for free, but confirm rather than assume, and add
  a view-target arm to the new test file if one is reachable.
- Run `yarn test` and `yarn lint` in `packages/quereus`.
- If `docs/sql.md` or `docs/schema.md` states name-resolution rules for defaults / checks,
  add a sentence there stating that schema-authored expressions never see a statement's
  common table expressions.
