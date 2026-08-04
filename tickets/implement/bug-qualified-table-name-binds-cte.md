---
description: Writing the database name in front of a table (for example `main.orders`) should always mean the real table, but today a query that also defines a temporary named result set called `orders` reads that instead and silently returns the wrong rows. Make the qualified name reach the real table.
files:
  - packages/quereus/src/planner/building/select.ts             # buildFrom — the one site to change (line ~422)
  - packages/quereus/src/planner/mutation/scope-transform.ts    # tableSourceColumnNames — comment becomes true; see note below
  - packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic  # new regression file (create)
  - docs/vu-operators.md                                        # § Common Table Expressions — read-side sentence to add
repro: verified
---

# A schema-qualified FROM name must not bind a common table expression

## Problem

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);
create table p (id integer primary key);
insert into p values (10);

with c as (select id as k from p) select count(*) as n from main.c;
```

Returns `n = 1` (the `with` block) instead of `n = 3` (the real table `main.c`). No error.

Re-verified on the current tree by running the statements above through the sqllogic
runner: `Actual: {"n":1} / Expected: {"n":3}`.

## Root cause — one site

`buildFrom` in `packages/quereus/src/planner/building/select.ts` (~line 414-460), the
`fromClause.type === 'table'` branch:

```ts
const tableName = fromClause.table.name.toLowerCase();

// Check if this is a CTE reference
if (cteNodes.has(tableName)) {
```

The lookup uses the bare name and never inspects `fromClause.table.schema`, so
`main.c` matches an unqualified `with c as (…)`. This is the **only** read-side CTE
name lookup in the engine — `grep` for `cteNodes.has` / `cteNodes.get` /
`withClause.ctes.find` returns exactly three other sites, and all three already gate on
the qualifier or are unrelated:

- `resolveCteTarget` (`planner/building/dml-target.ts:49`) — returns `undefined` when
  `table.schema` is set. The write path is already correct.
- `contextForCteTarget` (`dml-target.ts:194`) — matches by the already-resolved target
  name, no FROM parsing.
- `tableSourceColumnNames` (`planner/mutation/scope-transform.ts:513`) — gated on
  `!schemaName`.

The lens compiler (`schema/lens-compiler.ts:1428`, `:1464`, `:1553`) and the rename
rewriter (`schema/rename-rewriter.ts:559`) also test `table.schema === undefined`
before consulting their CTE-name sets, so the whole rest of the engine already holds
the position this fix adopts. SQLite and PostgreSQL agree: a qualified name resolves
against schema objects only.

## Fix

Gate the CTE branch on the absence of a qualifier:

```ts
if (!fromClause.table.schema && cteNodes.has(tableName)) {
```

Everything else in that branch (the recursive-CTE arm, the `cteReferenceCache`, the
alias handling) is untouched — a qualified name simply falls through to the existing
`else` arm, which does the ordinary view / maintained-table / base-table resolution and
raises the normal `Table 'x' not found in schema path: …` when nothing matches.

**This exact edit was trial-applied and the whole suite run.** `yarn test` was green:
8673 passing in `packages/quereus` plus every other workspace, zero failures. No
existing test, view body, or lens body relies on a qualified name reaching a `with`
definition. The trial edit has been reverted — the tree is clean and the change still
needs to be made.

## Behaviour to pin

Confirmed working under the trial patch; make these the regression test:

| statement | expected |
|---|---|
| `with c as (…) select count(*) from main.c` | reads the real table (3 rows) |
| `with c as (…) select count(*) from c` | unchanged — reads the CTE (1 row) |
| `with c as (…) select count(*) from main.c as x` | reads the real table; alias works |
| `with recursive r(n) as (…) select … from r` | unchanged — recursion still resolves |
| `with nope as (…) select z from main.nope` | ordinary table-not-found error |
| `with c as (…) insert into main.c values (99)` | unchanged — writes the real table |

## Notes for the implementer

- **`scope-transform.ts` comment.** `tableSourceColumnNames` carries the assertion
  "`buildFrom` resolves such a name the same way (its own `cteNodes` lookup), so the
  static shadow set matches the plan-time binding." Today that is false for a qualified
  name; after this fix it is true *for the qualifier dimension*. It is still not true
  for **precedence**: that function calls `findSchemaItem` **first** and only falls back
  to `cteNodes`, whereas `buildFrom` checks `cteNodes` first — so for an unqualified
  name that matches *both* a CTE and a real table they disagree about which relation's
  columns to use. That is a separate defect, filed as
  `tickets/backlog/bug-cte-shadow-precedence-scope-transform.md`; do **not** chase it
  here. When updating the comment, say precisely what this fix guarantees (qualifier
  agreement) and leave the precedence gap to that ticket rather than restating a claim
  that is still partly wrong.
- **`docs/lens.md` § body checks needs no change.** Its "flat CTE shadow set" paragraph
  is written entirely about *bare* names, and `lens-compiler.ts` already returns early
  on `table.schema !== undefined` before consulting `cteNames` at every one of its three
  sites. The description stays accurate.
- **`docs/vu-operators.md` § Common Table Expressions** already states the rule for
  writes ("A **schema-qualified** target (`update main.t`) is never a bare CTE
  reference, so it dispatches to the schema object even when a same-named CTE is in
  scope"). Add the matching read-side sentence there so the two halves are documented
  together.
- Different site from the backlog ticket `bug-unreferenced-dml-cte-never-runs`, which
  also names `buildFrom`: that one is about a `with` block never being planned at all.
- Regression file naming: `13.x-…` is the CTE family; `13.9` is taken, so
  `13.10-cte-qualified-name.sqllogic` is free.

## TODO

- Gate the `cteNodes` lookup in `buildFrom` (`planner/building/select.ts` ~line 422) on
  `!fromClause.table.schema`; keep the comment above it honest about why.
- Add `packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic` covering all six
  rows of the table above, with a header comment explaining the rule.
- Correct the `buildFrom`-agreement sentence in `tableSourceColumnNames`
  (`planner/mutation/scope-transform.ts`, ~line 505-515) — claim only qualifier
  agreement, and point at the precedence ticket for the rest.
- Add the read-side sentence to `docs/vu-operators.md` § Common Table Expressions,
  next to the existing write-target paragraph.
- Run `yarn test` and `yarn lint` from the repo root; both must be green.
