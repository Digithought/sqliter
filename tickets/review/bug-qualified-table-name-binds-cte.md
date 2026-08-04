---
description: Writing the database name in front of a table (for example `main.orders`) now always reads the real table, even when the query also defines a temporary named result set called `orders`. One-line planner gate plus a regression test.
files:
  - packages/quereus/src/planner/building/select.ts                 # buildFrom — the fix (line ~422)
  - packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic   # new regression file
  - packages/quereus/src/planner/mutation/scope-transform.ts        # comment corrected (~line 511)
  - packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic  # stale comment corrected (~line 144)
  - docs/vu-operators.md                                            # § Common Table Expressions — read-side sentence
repro: verified
---

# Review: a schema-qualified FROM name must not bind a CTE

## What changed

**`packages/quereus/src/planner/building/select.ts`, `buildFrom` (~line 422).** The CTE
lookup is gated on the absence of a schema qualifier:

```ts
if (!fromClause.table.schema && cteNodes.has(tableName)) {
```

A qualified name now falls through to the existing `else` arm (view → maintained table →
base table). Nothing else in the branch moved — the recursive-CTE arm, the
`cteReferenceCache`, and the alias handling are byte-identical. The comment above the gate
explains why (a CTE lives in no schema; matches `resolveCteTarget` on the write side, and
SQLite / PostgreSQL).

**`packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic`** (new). Covers every row
of the implement ticket's behaviour table plus four extra arms — see below.

**`packages/quereus/src/planner/mutation/scope-transform.ts`, `tableSourceColumnNames`
(~line 511).** The old comment claimed `buildFrom` "resolves such a name the same way", full
stop. It now claims only what is true: the two agree on the **qualifier** dimension (both
skip the CTE map for a qualified name), and explicitly records that they still disagree on
**precedence** — this function tries `findSchemaItem` first and falls back to `cteNodes`,
whereas `buildFrom` checks `cteNodes` first, so a bare name matching *both* a CTE and a real
table gets the table's columns here and the CTE's relation at plan time. Points at
`bug-cte-shadow-precedence-scope-transform` (backlog). No behaviour change.

**`packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic` (~line 144).** Its
FK-probe section asserted in prose that "`buildFrom` matches a CTE on the BARE table name and
ignores the schema qualifier" — true when written, false now. Rewritten to past tense and to
name both fixes that close it (`schemaAuthoredContext` and this gate). Comment only; the
arms below it are unchanged and still pass.

**`docs/vu-operators.md` § Common Table Expressions and the CTE-name DML target.** The
write-target paragraph already documented the qualified-target rule; a matching read-side
sentence now sits next to it, so both halves are stated together.

## Use cases / how to exercise

Direct repro from the bug report — was `n = 1`, now `n = 3`:

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);
create table p (id integer primary key);
insert into p values (10);

with c as (select id as k from p) select count(*) as n from main.c;   -- 3
with c as (select id as k from p) select count(*) as n from c;        -- 1 (unchanged)
```

Run the regression file: `yarn workspace @quereus/quereus run test` (the sqllogic runner
picks up `test/logic/*.sqllogic` automatically; no registration needed).

Arms in `13.10-cte-qualified-name.sqllogic`, all passing:

| arm | pins |
|---|---|
| `select count(*) from main.c` under `with c` | reads the real table (3) |
| `select k from main.c order by k` | the *values* come from the real table, not just the count |
| `select count(*) from c` / `select k from c` | bare name still binds the CTE (1 row, `k = 10`) |
| `from main.c as x`, and `select x.k … order by x.k` | alias + alias-qualified column on a qualified source |
| `from main.c as real_c cross join c as cte_c` | both bindings live in ONE statement — 3 × 1 rows |
| `select (select count(*) from main.c), (select count(*) from c)` | qualified/bare split inside scalar subqueries |
| `with recursive r(n) as (… from r …) select … from r` | recursion unaffected (self-reference is bare) |
| `… select count(*) from main.r` on the same recursive CTE | qualified recursive name is a schema lookup, and misses |
| `with nope as (…) select k from main.nope` | ordinary table-not-found, not a silent CTE bind |
| `with c as (…) insert into main.c values (99)` | write path unchanged — real table gains a 4th row |

**Diagnostic wording, corrected from the implement ticket.** The implement ticket predicted a
qualified miss would raise ``Table 'x' not found in schema path: …``. It does not — a
qualified miss goes through `resolveTableSchema`'s explicit-schema arm
(`planner/building/schema-resolution.ts:49`) and reads `Table not found: main.nope`. The
`not found in schema path: …` wording is the **unqualified** miss. The test asserts the
actual string and carries a comment explaining the split. Worth a reviewer's eye: two
different wordings for "no such table" is arguably its own papercut, but it long predates
this ticket and is not in scope here.

## Validation

- `yarn test` from repo root — **green, zero failures**: 8674 passing in `packages/quereus`
  (8673 before, +1 for the new file) plus 376 / 113 / 63 / 17 / 28 / 1362 / 725 / 85 / 31 /
  34 / 134 / 22 across the other workspaces.
- `yarn lint` from repo root — **green** (eslint + `tsc -p tsconfig.test.json --noEmit` in
  `packages/quereus`; no-op elsewhere).
- `yarn test:store` (LevelDB path) **not run** — no storage-layer surface is touched; this is
  a plan-time name-resolution gate that never reaches the vtab module.

## Known gaps / where to push

- **Coverage is read-path SELECT only.** The new file exercises `from`, aliases, cross join,
  and scalar subqueries. It does not cover a qualified CTE-shadowed name reached through a
  **view body**, a **lens body**, or a **trigger-like schema-authored expression** — those
  three already gate on `table.schema !== undefined` themselves (`schema/lens-compiler.ts`
  :1428/:1464/:1553, `schema/rename-rewriter.ts:559`), which is *why* they were skipped, but
  that reasoning is read-from-source, not test-verified here.
- **The precedence disagreement is untested either way.** No test pins what happens when a
  bare name matches both a CTE and a real table, in `tableSourceColumnNames` vs `buildFrom`.
  The comment now says they disagree; a reviewer may want to confirm the direction of that
  claim against the code rather than trust the comment.
- **`set` / `returning` / `order by` qualified references were not swept.** Only `from`-clause
  binding was changed, so other clauses should be unaffected by construction — but no test
  asserts that a qualified column reference (`main.c.k`) behaves consistently.
- **No negative test for `temp.` or an attached schema.** All qualified arms use `main.`.

## Review findings (implement stage)

- Ticket predicted the wrong error wording for a qualified table miss (`not found in schema
  path` vs the actual `Table not found: main.x`); corrected in the test and documented above.
  Not a defect in the fix.
- Two different "no such table" wordings depending on whether the name was qualified —
  noticed while writing the test, parked as the comment in
  `13.10-cte-qualified-name.sqllogic` next to the error assertion rather than filed, since
  nothing is currently wrong and it only becomes work if someone starts matching on the
  message.
