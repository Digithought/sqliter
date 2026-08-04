---
description: A column's default value (or a check rule, or a foreign-key check) written in a table's definition could accidentally read a temporary named result set that the surrounding query happened to give the same name; now it always reads the real table.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts   # NEW — the helper
  - packages/quereus/src/planner/building/insert.ts                    # 4 call sites
  - packages/quereus/src/planner/building/update.ts                    # 5 call sites
  - packages/quereus/src/planner/building/delete.ts                    # 2 call sites
  - packages/quereus/src/planner/building/view-mutation-builder.ts     # 1 EXTRA site found during implement (buildKeyDefault)
  - packages/quereus/src/planner/stored-body-context.ts                # cross-reference added
  - packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic  # NEW test
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic  # existing control case, unchanged
  - docs/schema.md                                                     # new paragraph on the rule
difficulty: medium
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
`schemaPath` and `storedBodyOf` alone (each reason is documented in the file's header
comment). It is the inline sibling of `storedBodyContext`, which does the same job for
view / materialized-view bodies; a cross-reference was added in both directions.

Applied at 12 call sites:

| file | sites |
|---|---|
| `building/insert.ts` | `createRowExpansionProjection` (defaults + generated columns), `buildConstraintChecks`, `buildChildSideFKChecks`, `buildNotNullDefaults` |
| `building/update.ts` | generated-column recompute, `buildConstraintChecks`, `buildNotNullDefaults`, `buildChildSideFKChecks`, `buildParentSideFKChecks` |
| `building/delete.ts` | `buildConstraintChecks`, `buildParentSideFKChecks` |
| `building/view-mutation-builder.ts` | `buildKeyDefault` — **not in the ticket's list of 11**; see below |

Each builder derives **two** contexts rather than one, because its existing call sites
already rode two different schema paths (the statement's `with schema` path for
defaults / generated columns, the bare `ctx` for the constraint and FK builders, which
narrow the path to the table's own schema themselves). Preserving that split keeps the
change behaviour-neutral on `schemaPath`, which the ticket put out of scope.

### The extra call site

The ticket asked to *confirm rather than assume* that the view-mutation lowering
inherits the fix. It mostly does — every base op is re-planned through
`buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt` — but there is one
schema-authored expression the lowering builds **itself**: `buildKeyDefault` in
`planner/building/view-mutation-builder.ts` compiles the anchor key column's declared
`default` for the shared-surrogate envelope of a multi-source view insert. It had the
same leak, and is fixed the same way. Verified discriminating (see the table below).

## Testing / validation

New file `packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic`,
16 arms. **Every arm was individually verified to be discriminating**: the helper was
temporarily stubbed to a pass-through, each arm was run standalone against a fresh
`Database` via a scratch script (since deleted), and the wrong-vs-right answers were
recorded. Results:

| arm | value/behaviour with helper stubbed out | with the fix |
|---|---|---|
| insert column `default` (inherited) | `w = 1` | `w = 3` |
| insert generated column (inherited) | `g = 1` | `g = 3` |
| insert `check` (inherited) | spurious `CHECK constraint failed: _check_0` | inserts |
| insert `check`, reverse direction (inherited) | wrongly **accepts** a row the real table's check rejects | rejected |
| update `check` (own `with`) | spurious failure | updates |
| update `check` (inherited) | spurious failure | updates |
| `check on delete` (own `with`) | spurious failure | deletes |
| `check on delete` (inherited) | spurious failure | deletes |
| `not null` default via `insert or replace … values (…, null)` (inherited) | `w = 1` | `w = 3` |
| insert child-side FK (inherited) | spurious `_fk_fkc_pid` | inserts |
| insert child-side FK (own `with`) | *already passed* — contract guard only, see below | passes |
| update child-side FK (inherited) | spurious `_fk_fkc2_pid` | updates |
| delete parent-side `restrict` FK (inherited) | legal delete spuriously rejected | deletes |
| update parent-side `restrict` FK (inherited) | legal update spuriously rejected | updates |
| view target — base-table default (own `with`) | `w = 1` | `w = 3` |
| multi-source view — anchor key `default` (own `with`) | allocated `rid = 1` | allocated `rid = 101` |

Plus one negative arm that pins the RESTRICT FK is still genuinely enforced (a real
child row present ⇒ the delete is rejected).

`yarn test` green: **8663 passing** in `packages/quereus` (8662 before + this file), 0
failing, every other workspace package green. `yarn lint` (eslint + the test-file `tsc`
pass) exit 0. `yarn build` exit 0.

## Things a reviewer should poke at

- **The extra call site is the interesting one.** `buildKeyDefault` was found by
  grepping for schema-authored AST built outside the three DML builders. Is there
  another? The sweep covered `defaultValue` / `generatedExpr` / `checkConstraints`
  under `planner/mutation/` and every caller of the four builders. `core/derived-row-validator.ts`
  also calls `buildConstraintChecks` / `buildChildSideFKChecks`, but on a
  `freshPlanningContext(db)` that never has `cteNodes`, so it needed no change — that
  was checked, not assumed. Lens enforcement threads its extra constraints *through*
  `buildConstraintChecks`, so it rides the cleared context for free.
- **Two derived contexts per builder, not one.** The ticket's TODO said "derive once
  per builder". Two are needed to preserve the pre-existing `schemaPath` split without
  changing behaviour. A reviewer may reasonably prefer unifying them — but that is the
  out-of-scope `schemaPath` question, not this ticket.
- **Arm coverage honesty.** One arm (`insert child-side FK` with the INSERT's own
  leading `with`) passed before the fix too and is labelled as such in the test file: it
  pins the contract rather than a closed leak. `buildInsertStmt` hands the FK builder
  the bare `ctx`, which never carried the statement's own clause. Three other own-`with`
  arms that were originally written the same way were rewritten to the inherited form so
  they actually discriminate; the two that remain in own-`with` form (`update`/`delete`
  `check`) genuinely do discriminate, because those builders pass their CTE-aware
  context to `buildConstraintChecks`.
- **The parent-side RESTRICT delete arm needs a second inbound non-RESTRICT FK.**
  Without it, `getBatchableRestrictFks` admits the statement and no plan-time `not
  exists` probe is built at all, so the leak is unreachable. The test file says this;
  worth confirming the reasoning holds.
- **Error-text change.** The delete arm's rejection now comes from the plan-time probe
  (`CHECK constraint failed: _fk_pkc_pid (not exists …)`) rather than the runtime
  RESTRICT pre-walk wording. That is a consequence of the probe finally binding the real
  child table; the ticket predicted it. It is a diagnostic-text change on a path that
  was previously masked, not a behaviour regression — but a reviewer may want an opinion
  on whether the plan-time diagnostic should be reworded to mention RESTRICT.

## Known gaps / deliberately not done

- **`buildFrom` ignores the schema qualifier when matching a CTE name.**
  `select * from main.c` still binds a `with c as (…)`. Out of scope per the ticket;
  clearing the namespace makes it moot for schema-authored SQL but the read-path
  asymmetry is untouched and unticketed.
- **Column defaults / generated columns still ride the statement's `with schema` path**
  rather than the table's home schema path. Out of scope per the ticket; recorded as a
  `NOTE:` at the row-expansion call site in `building/insert.ts` and in the helper's
  header comment. No observed wrong answer.
- **No `.sqllogic` arm for a `with schema`-bearing statement.** The tests all run on the
  default `main` path. If the reviewer wants the `schemaPath` split pinned before anyone
  unifies it, that arm does not exist yet.
- **No store-backend run.** `yarn test:store` was not run (not agent-runnable inside the
  ticket budget). The change is purely plan-time name resolution and touches no storage
  path, so a divergence is unlikely, but it is unverified.
- **`bug-update-generated-column-subquery-not-awaited`** (tracked separately) is why
  there is no UPDATE arm for the *generated-column* leak: the value is already wrong
  before name resolution matters.
