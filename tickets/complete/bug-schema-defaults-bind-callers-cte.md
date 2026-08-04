---
description: A column's default value (or a check rule, or a foreign-key check) written in a table's definition could accidentally read a temporary named result set that the surrounding query happened to give the same name; now it always reads the real table.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts   # the helper
  - packages/quereus/src/planner/building/insert.ts                    # 4 call sites
  - packages/quereus/src/planner/building/update.ts                    # 5 call sites
  - packages/quereus/src/planner/building/delete.ts                    # 2 call sites
  - packages/quereus/src/planner/building/view-mutation-builder.ts     # buildKeyDefault
  - packages/quereus/src/planner/building/alter-table.ts               # review: tripwire NOTE at the ADD COLUMN backfill build
  - packages/quereus/src/planner/stored-body-context.ts                # cross-reference
  - packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic  # 18 arms (16 + 2 added in review)
  - docs/schema.md                                                     # the rule, plus the schema-path known gap
---

# Schema-authored expressions no longer bind a statement's CTEs

## What was wrong

A column `default`, a generated-column expression, a `check` constraint and a
foreign-key existence check are written in the **table's** definition, not in the
statement doing the write. They were built on a planning context that still carried the
statement's common-table-expression definitions, so a caller could shadow a real table
out from under someone else's DDL:

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);
create table t (id integer primary key, w integer default (select count(*) from c));

with c as (select id from p),                      -- p has 1 row
     b as (insert into t (id) values (1) returning id)
select count(*) as n from b;

select id, w from t;   -- was [{"id":1,"w":1}], now [{"id":1,"w":3}]
```

No error, no warning — just a wrong stored value (or, in the constraint/FK arms, a
spurious `CHECK constraint failed`).

## What changed

New helper `schemaAuthoredContext(ctx)` in
`packages/quereus/src/planner/building/schema-authored-context.ts`. It clears
`cteNodes` and `cteReferenceCache` and nothing else — deliberately leaving `scope`,
`schemaPath` and `storedBodyOf` alone (each reason documented in the file's header
comment). It is the inline sibling of `storedBodyContext`, which does the same job for
view / materialized-view bodies; a cross-reference was added in both directions.

Applied at 12 call sites:

| file | sites |
|---|---|
| `building/insert.ts` | `createRowExpansionProjection` (defaults + generated columns), `buildConstraintChecks`, `buildChildSideFKChecks`, `buildNotNullDefaults` |
| `building/update.ts` | generated-column recompute, `buildConstraintChecks`, `buildNotNullDefaults`, `buildChildSideFKChecks`, `buildParentSideFKChecks` |
| `building/delete.ts` | `buildConstraintChecks`, `buildParentSideFKChecks` |
| `building/view-mutation-builder.ts` | `buildKeyDefault` — the one schema-authored expression the view-write lowering compiles itself instead of delegating to `buildInsertStmt` |

Each builder derives **two** contexts rather than one, because its existing call sites
already rode two different schema paths (the statement's `with schema` path for
defaults / generated columns, the bare `ctx` for the constraint and FK builders, which
narrow the path to the table's own schema themselves). Preserving that split kept the
change behaviour-neutral on `schemaPath`.

## Testing / validation

`packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic`, 18 arms.
Every arm was verified to be discriminating by stubbing the helper out to a
pass-through and re-running: insert/update/delete `check`, insert `default`, generated
column, `not null` default via `insert or replace`, child-side FK on insert and update,
parent-side RESTRICT FK on delete and update, view target, multi-source view anchor key
default. One arm (`insert` child-side FK with the statement's own leading `with`) passed
before the fix too and is labelled as pinning the contract rather than a closed leak.

`yarn test` green — **8663 passing** in `packages/quereus`, 0 failing, every other
workspace package green. `yarn lint` exit 0 with no diagnostics.

## Review findings

Reviewed the implement diff first, then swept for sites it should have touched. Two
majors, both filed; several minors fixed inline; one tripwire parked.

### Major — filed as new tickets

- **`tickets/fix/bug-qualified-table-name-binds-cte`** — `buildFrom`
  (`planner/building/select.ts`) matches a `with` definition by bare name and ignores the
  schema qualifier, so `with c as (…) select count(*) from main.c` reads the `with` block
  (returns 1) instead of the real table (3). Verified by running it. The implement handoff
  listed this as a known gap it left unticketed; it is a reachable silently-wrong answer,
  and the *write* path (`resolveCteTarget`) plus the view-write scope analysis
  (`scope-transform.ts`) already decline on a qualifier — so the read path is the odd one
  out, and a comment in `scope-transform.ts` asserting the two agree is currently false.
  Judged a separate site from the existing backlog ticket `bug-unreferenced-dml-cte-never-runs`,
  which names the same function but is about a block never entering the plan at all.

- **`tickets/fix/bug-column-default-ignores-owning-table-schema`** — the handoff called
  the `schemaPath` asymmetry "out of scope, no observed wrong answer". There is one:
  a `temp` table whose column `default` and `check` both read an unqualified `c` binds
  `main.c` in the default and `temp.c` in the check, under `pragma schema_path = 'main'`.
  Verified against a fresh `Database`. Root cause is a single decision site — the helper
  clears CTEs but leaves the path, and only the constraint/FK builders narrow it
  themselves. The two in-code comments claiming no observed wrong answer were corrected
  to point at the ticket, and `docs/schema.md` now states the gap.

### Minor — fixed in this pass

- **Two test arms added** to `13.9`, both verified discriminating by stubbing the helper:
  (a) a control that the clearing reaches *only* schema-authored SQL — one statement whose
  source and scalar subquery read the CTE (`v = 1`) while the column default reads the real
  table (`w = 3`); (b) a schema-authored default carrying its **own** `with` clause, proving
  the namespace is cleared on the way in rather than disabled, and that a relation the
  default's own CTE reads is still the real table. Both were first written with the
  INSERT's own leading `with` and passed under the stub — rewritten to the inherited form,
  where they fail without the fix.
- **`docs/schema.md`** gained the known-gap sentence described above; the implementer's new
  paragraph was otherwise accurate and left as written.
- Stale comments in `building/insert.ts` and `schema-authored-context.ts` corrected.

### Tripwire — parked, not ticketed

- `buildAddColumnBackfill` (`planner/building/alter-table.ts`) compiles an ADD COLUMN's
  `default` / `generated always as` on the caller's context without the helper. Not a
  defect: `AST.QueryExpr` is `select | values | insert | update | delete`, so an ALTER can
  never be a CTE body and has no `with` clause of its own — the context can never carry CTE
  definitions. A `NOTE:` at the build site records the condition under which that stops
  being true.

### Checked, nothing found

- **Sweep for other schema-authored build sites.** `core/derived-row-validator.ts` builds
  checks and child-side FKs on `freshPlanningContext(db)` (empty CTE maps) — confirmed by
  reading, not assumed. Foreign-key `set default` actions re-issue a fresh `UPDATE`
  statement through the statement cache, so they carry no caller CTEs. Partial-index
  predicates are compiled by the memory module from AST with no planning context.
  Assertions are re-parsed from stored SQL at commit; the optimizer's assertion hoist
  synthesizes column-only predicates with no relation names. A view body's
  `with defaults (col = expr)` clause *is* copied into the lowered statement, but
  `mapNestedSelects` stamps its subqueries with the stored-body marker, so
  `enterStoredBodyEnv` → `storedBodyContext` clears the caller's CTEs there already —
  checked because it is the same class of leak and the only remaining schema-authored SQL
  that travels into a caller's statement.
- **Over-clearing.** `expression.ts` passes `ctx.cteNodes` to `buildSelectStmt` as an
  explicit `parentCTEs`; `undefined` falls through to that parameter's `new Map()` default,
  so nothing throws and a schema-authored subquery's own `with` clause still binds (arm (b)
  above pins it).
- **The implementer's own "poke at this" list.** The claim that the parent-side RESTRICT
  delete arm needs a second inbound non-RESTRICT FK to be discriminating holds — removing
  `pkc2` makes the arm pass under the stub. The two-derived-contexts-per-builder shape is
  the right call while the `schemaPath` question is open (now its own ticket). The
  `stmt.schemaPath ? … : …` ternary in `building/insert.ts` is redundant in effect
  (`contextWithSchemaPath` *is* `ctx` when the statement declares no path) but avoids a
  second object allocation on the INSERT hot path — left as written.
- **Diagnostic text.** The delete arm's rejection now reads
  `CHECK constraint failed: _fk_pkc_pid (not exists …)` rather than the runtime RESTRICT
  wording, because the plan-time probe finally binds the real child table. The message
  still names the offending foreign key, so it is a defensible diagnostic; rewording it to
  say RESTRICT would be cosmetic and would churn the pinned test text. No action.
- **Hygiene / performance / resource cleanup.** No findings. The helper is 3 lines under a
  long header comment — heavy, but consistent with the surrounding planner files and the
  reasoning is load-bearing. It returns the context unchanged when there are no CTEs, so
  the common statement allocates nothing.

## Known gaps carried forward

- **No store-backend run.** `yarn test:store` was not run in either stage (not
  agent-runnable inside the ticket budget). The change is purely plan-time name
  resolution and touches no storage path.
- **No `.sqllogic` arm for a `with schema`-bearing statement.** Tracked with the
  schema-path ticket, which needs that coverage anyway.
- **`bug-update-generated-column-subquery-not-awaited`** (tracked separately) is why
  there is no UPDATE arm for the *generated-column* leak: the value is already wrong
  before name resolution matters.
