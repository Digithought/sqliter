---
description: When a column's default value is written as a query, the engine looks up the tables it names using whatever database the writing statement is pointed at, instead of the one the table itself lives in — so the same table definition can read different data depending on who inserts into it. Rule checks written beside it already resolve the correct way, so one table definition can disagree with itself.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts   # the shared helper — add the schema-path narrowing here
  - packages/quereus/src/planner/building/insert.ts                    # two schema-authored contexts collapse into one
  - packages/quereus/src/planner/building/update.ts                    # pass the owning schema name
  - packages/quereus/src/planner/building/delete.ts                    # pass the owning schema name
  - packages/quereus/src/planner/building/constraint-builder.ts        # drop the now-redundant internal narrowing
  - packages/quereus/src/planner/building/foreign-key-builder.ts       # drop the now-redundant internal narrowing (two sites)
  - packages/quereus/src/core/derived-row-validator.ts                 # builds those two on a fresh context — must wrap it
  - packages/quereus/src/planner/building/view-mutation-builder.ts     # buildKeyDefault — the anchor key column's own default
  - packages/quereus/src/planner/mutation/multi-source.ts              # carry the anchor's schema name alongside keyDefault
  - packages/quereus/src/planner/mutation/decomposition.ts             # same
  - packages/quereus/src/planner/building/alter-table.ts               # ADD COLUMN backfill — same rule, currently unobservable
  - packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic  # the sibling test file to model the new one on
  - docs/schema.md                                                     # §§ around lines 335/339 — state one rule, drop the "Known gap"
repro: verified
---

# A column default resolves relation names on the writer's schema path, not the table's own

## What happens

A table in the `temp` schema whose column default and check constraint each read the same
unqualified name `c`, with a `c` in both schemas:

```sql
create table main.c (k integer primary key);
insert into main.c values (1);                      -- 1 row
create table temp.c (k integer primary key);
insert into temp.c values (1), (2), (3);            -- 3 rows

create table temp.t (
  id integer primary key,
  w  integer default (select count(*) from c),
  check ((select count(*) from c) = 3)
);

pragma schema_path = 'main';
insert into temp.t (id) values (1);
select id, w from temp.t;    -- [{"id":1,"w":1}]
```

The insert succeeds — so the `check` read `temp.c` (3 rows), the table's own schema. The
default stored `w = 1` — so it read `main.c`, the writer's path. Two expressions written
side by side in one table definition, resolving the same name to two different tables.

Re-verified at `faf2d501` against a fresh in-memory `Database`. Three arms observed wrong:

| arm | before | expected |
| --- | --- | --- |
| column `default` (session `pragma schema_path`) | `w = 1` | `w = 3` |
| generated column (`generated always as ((select count(*) from c))`) | `g = 1` | `g = 3` |
| per-statement `insert … with schema main` | `w = 1` | `w = 3` |

A fourth arm — the anchor key column's declared `default` on a multi-source /
decomposition view insert (`buildKeyDefault` in `building/view-mutation-builder.ts`) — is
also wrong, and is *not* fixed by narrowing the three DML builders, because that one build
is done by the lowering itself. Verified: with `temp.kd_core` (high-water mark 100), a
`main.kd_core` decoy (500), a view `temp.kd_v` over the temp tables and session path
`main`, an insert through the view minted `rid = 501` — the decoy's mark — instead of
`101`.

## Root cause

`schemaAuthoredContext` (`building/schema-authored-context.ts`) is the one wrapper every
schema-authored expression build passes through. It clears the common-table-expression
namespace but leaves `schemaPath` alone; its header comment records that omission
deliberately. Narrowing to the owning table's schema is instead done *inside* two of the
four builders — `buildConstraintChecks` and both foreign-key builders each set
`schemaPath: [tableSchema.schemaName]` on their own local context. Column defaults,
generated columns and the anchor key default have no equivalent, so they ride whatever
path the writing statement carries.

## The fix

Move the narrowing into `schemaAuthoredContext` and make the owning schema name a
**required** parameter, so no future call site can silently omit it:

```ts
export function schemaAuthoredContext(ctx: PlanningContext, schemaName: string): PlanningContext
// → { ...ctx, cteNodes: undefined, cteReferenceCache: undefined, schemaPath: [schemaName] }
```

`[schemaName]` exactly — the owning schema only, no default-path fallback. That is the
rule `docs/schema.md` already states for check and foreign-key bodies, and the whole point
here is that all four kinds of schema-authored expression agree. It is deliberately
stricter than a stored view body's `Database._homeSchemaPath()` (home schema first, then
the session default path).

**Behaviour change this implies.** A column default or generated-column expression that
names a relation in *another* schema without qualifying it stops resolving — it becomes a
plan-time "table not found". That is the intended, already-documented rule for the two
sibling expression kinds. A prototype of exactly this change was run against the whole
workspace suite (`yarn test`, 4m54s, 8663 quereus tests plus every other package) and it
was **fully green** — no existing test depends on the loose behaviour.

The prototype covered only `schemaAuthoredContext` plus the three DML builder call sites;
it turned all three table rows above from wrong to expected. The remaining call sites
below were researched but not prototyped.

### Redundancy collapse, and the one trap in it

Once the helper narrows, the `schemaPath: [tableSchema.schemaName]` lines inside
`buildConstraintChecks` (`constraint-builder.ts`) and both foreign-key builders
(`foreign-key-builder.ts`, two sites) are redundant *for the DML paths* — every one of
those reaches the builder through a `schemaAuthoredContext`-derived context. Collapse them
so exactly one place decides.

The trap: `core/derived-row-validator.ts` calls `buildConstraintChecks` and
`buildChildSideFKChecks` on its own `freshPlanningContext(db)`, which never goes through
the helper and sets no `schemaPath` at all. Removing the builders' internal narrowing
without wrapping that context would silently drop narrowing for a maintained table's
CHECK / FK bodies. Wrap it: `schemaAuthoredContext(freshPlanningContext(db), mv.schemaName)`.

Leave the `schemaManager.setCurrentSchema(...)` save/restore dance in both builders alone —
it is a separate (global, mutable) concern and out of scope here.

### The anchor key default

`buildKeyDefault` (`building/view-mutation-builder.ts`) builds the anchor key column's own
`default` and currently calls `schemaAuthoredContext(ctx)` with no owner. The correct owner
is the **anchor base table's** schema, not the view's — they can differ. Both analyses that
produce the default already hold that table schema at the point they pick it up
(`sides[anchorIndex].schema` in `analyzeMultiSourceInsert`, `anchorRef.tableSchema` in
`resolveInsertSharedKey`), so carry its `schemaName` out alongside `keyDefault` on
`MsInsertAnalysis` / `DecompInsertAnalysis` and thread it into `buildKeyDefault`.

### ALTER TABLE ADD COLUMN

`building/alter-table.ts` builds the backfill DEFAULT / GENERATED expression on the bare
caller context (its comment explains it skips the helper because ALTER can never carry
CTEs — true, but the schema path is a second reason to wrap). Apply the same narrowing for
consistency.

Note this arm is **not observable today and cannot be pinned by a test yet**: any
relation-reading backfill expression fails to emit at all on the ALTER path — separately
filed as `bug-alter-add-column-relation-default-fails-to-emit`. Make the change anyway so
that ticket does not ship a fresh instance of this bug; say so plainly in the review
handoff rather than claiming test coverage.

## Test coverage

There is no `.sqllogic` arm today for a schema-path-sensitive schema-authored expression,
so the split is pinned by nothing. Add one, modelled closely on
`test/logic/13.9-schema-authored-cte-isolation.sqllogic` (the CTE half of the same leak) —
same "write it so the WRONG binding is observable" discipline: the decoy relation and the
real one disagree, and the assertion pins the owning schema's answer.

Suggested new file `test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic`. Both
`main` and `temp` exist in a bare `Database`, which is enough for every collision; a
user-declared schema (`declare schema … / apply schema …`, as
`test/logic/06.4-schema-search-path.sqllogic` does) is worth one arm too so the coverage is
not reading a `temp`-only special case.

Arms to cover, each with the decoy in the schema the *writer* is pointed at:

- column `default` under session `pragma schema_path`
- generated column, insert path
- generated column, **update** recompute (`building/update.ts` — a distinct build site)
- `not null` column default via `insert or replace … values (…, null)` (`buildNotNullDefaults`)
- per-statement `insert … with schema <name>` (distinct from the session pragma)
- a `check` and a child-side FK on the same table, as controls — they were already correct
  and must stay correct after the internal narrowing is collapsed out of the builders
- write-through a view whose base table lives in the non-default schema
- the multi-source anchor key default (model on 13.9's `kd_core` / `kd_contact` / `kd_v`
  arm, with the tables in `temp` and a higher-water-mark decoy in `main`)
- a control that a *qualified* reference inside a default is unaffected

## Docs

`docs/schema.md` needs two edits, both in the run of paragraphs around lines 335–339:

- the "Schema-authored expressions never see a statement's CTEs" paragraph ends with a
  parenthetical saying the path narrowing "is applied by the constraint and foreign-key
  builders themselves", followed by a **Known gap** sentence naming this ticket. Both go
  away: state that all four kinds — column `default`, generated column, `check`,
  foreign-key probe — resolve unqualified relation names against the owning table's schema
  only, with no default-path fallback, whatever path the writing statement runs on.
- the "Stored bodies resolve against their home schema" paragraph already states the strict
  rule for CHECK and FK bodies; extend its wording to cover defaults and generated columns
  so there is one sentence, not two rules.

Also rewrite the `schemaAuthoredContext` header comment — its "deliberately does NOT touch
`schemaPath`" bullet is exactly what this ticket inverts — and drop the `NOTE:` at the
row-expansion call site in `building/insert.ts` that documents the asymmetry.

## Neighbours

`tickets/fix/bug-update-generated-column-subquery-not-awaited` also lists
`planner/building/update.ts`. Different root cause (an un-awaited evaluator in
`runtime/emit/update.ts`) and different lines; no ordering dependency, but expect to see
its edits nearby.

## TODO

- Add a required `schemaName` parameter to `schemaAuthoredContext` and narrow `schemaPath`
  to `[schemaName]`; keep an identity fast-path only when nothing actually changes (the
  current early-return short-circuits on the CTE fields alone and would now be wrong).
- Rewrite that file's header comment: the `schemaPath` bullet moves from "deliberately not
  touched" to "narrowed here, for all four expression kinds".
- Pass the owning table's schema name at the `schemaAuthoredContext` call sites in
  `building/insert.ts`, `building/update.ts`, `building/delete.ts`.
- Collapse `schemaAuthoredPathCtx` into `schemaAuthoredCtx` in `building/insert.ts` — with
  the helper narrowing, the statement's `with schema` path is no longer relevant to any
  schema-authored build — and delete the `NOTE:` at the row-expansion call describing the
  asymmetry.
- Remove the internal `schemaPath: [tableSchema.schemaName]` narrowing from
  `buildConstraintChecks` and from both builders in `foreign-key-builder.ts`; leave the
  `setCurrentSchema` save/restore in place.
- Wrap `core/derived-row-validator.ts`'s `freshPlanningContext(db)` in
  `schemaAuthoredContext(..., mv.schemaName)` so the maintained-table CHECK / FK builds keep
  their narrowing.
- Carry the anchor base table's schema name out of `analyzeMultiSourceInsert` and
  `resolveInsertSharedKey` alongside `keyDefault`, and thread it into `buildKeyDefault`.
- Narrow the ADD COLUMN backfill build in `building/alter-table.ts` through the helper too;
  update the comment there that explains why it skipped the wrapper.
- Add `test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic` covering the arms
  listed above.
- Update `docs/schema.md` as described.
- Run `yarn test` and `yarn lint` from the repo root; both must pass.
