---
description: Writing the database name in front of a table (for example `main.orders`) used to read a temporary named result set called `orders` instead of the real table. Fixed with a one-line planner gate, plus regression tests and docs.
files:
  - packages/quereus/src/planner/building/select.ts                 # buildFrom — the fix (~line 426)
  - packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic   # regression file
  - packages/quereus/src/planner/mutation/scope-transform.ts        # comment corrected (~line 511)
  - packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic  # stale comment corrected (~line 144)
  - docs/sql-select.md                                              # § 3.7 WITH clause — visibility bullet
  - docs/vu-operators.md                                            # § Common Table Expressions — read-side sentence
repro: verified
---

# Complete: a schema-qualified FROM name must not bind a CTE

## What shipped

**`packages/quereus/src/planner/building/select.ts`, `buildFrom`.** The CTE lookup is gated
on the absence of a schema qualifier:

```ts
if (!fromClause.table.schema && cteNodes.has(tableName)) {
```

A qualified name falls through to the pre-existing `else` arm (view → maintained table →
base table). The recursive-CTE arm, the `cteReferenceCache`, and alias handling are
unchanged.

```sql
create table c (k integer primary key); insert into c values (1), (2), (3);
create table p (id integer primary key); insert into p values (10);

with c as (select id as k from p) select count(*) as n from main.c;   -- was 1, now 3
with c as (select id as k from p) select count(*) as n from c;        -- 1 (unchanged)
```

**Regression file `packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic`.** Covers
qualified vs bare binding, values (not just counts), aliases and alias-qualified columns,
both bindings in one statement via cross join, scalar subqueries, recursive CTEs (bare
self-reference unaffected; qualified self-reference is a schema lookup that misses),
qualified miss error wording, view resolution through the fall-through arm, and the
unchanged write path.

**Comment corrections.** `scope-transform.ts` no longer claims `buildFrom` resolves a name
"the same way" — it now states the two agree on the *qualifier* dimension and disagree on
*precedence* (tracked as backlog `bug-cte-shadow-precedence-scope-transform`).
`13.9-schema-authored-cte-isolation.sqllogic`'s FK-probe prose is past-tense and names both
fixes that close the leak.

**Docs.** `docs/vu-operators.md` § Common Table Expressions gained a read-side sentence next
to the existing qualified-write-target rule; `docs/sql-select.md` § 3.7 (the user-facing WITH
reference) gained a "Visibility inside the declaring statement" bullet stating the rule for
both read and write, and that it matches SQLite and PostgreSQL.

## Validation

- `yarn test` (repo root) — **green, zero failures**: 8674 passing in `packages/quereus`
  plus all other workspaces (85 / 31 / 59 / 68 / 34 / 134 / 22 / …). 4m24s.
- `yarn lint` (repo root) — **green** (eslint + `tsc -p tsconfig.test.json --noEmit` in
  `packages/quereus`; no-ops elsewhere).
- `yarn test:store` not run — this is a plan-time name-resolution gate that never reaches a
  vtab module, so no storage-layer surface is touched.

## Review findings

**Correctness of the gate — checked, no defect.**
Grepped every `cteNodes.has(` / `cteNodes.get(` in `packages/quereus/src`: exactly two
lookup sites exist (`select.ts:426`, `scope-transform.ts:519`) and both now skip a qualified
name. The write path (`dml-target.ts:49`) was already gated. `fromClause.table.schema` is
`undefined` for a bare name, so the gate is a pure add-on with no coercion hazard.

**Internal pseudo-CTE injections — checked, unaffected.**
`withKeyCapture` (`mutation/multi-source.ts:2173`) and `withCteCapture`
(`building/view-mutation-builder.ts:435`) inject relations into `cteNodes` under
`__vmupd_keys` / a CTE name, and every synthesized predicate reads them with a *bare*
`from <name> k`. None is schema-qualified, so none regresses through the new gate.

**Recursive-CTE classification — checked, no defect.**
`isRecursiveCte` (`building/with.ts:60`) is structural (`recursive` keyword + compound body),
not a name scan over FROM sources, so the gate cannot change which member is treated as
recursive. What *does* change is a qualified self-reference inside the body: it is now a
schema lookup that misses. That is the correct reading and matches SQLite, but the
implement stage left it untested — **fixed in this pass**, new arm in
`13.10-cte-qualified-name.sqllogic`.

**View / lens / schema-authored paths — checked, no ticket needed.**
The implement handoff listed these as read-from-source rather than test-verified. Confirmed:
`schemaAuthoredContext` (`building/schema-authored-context.ts:69-75`) clears `cteNodes`
outright, and a view body plans under `storedBodyContext`, which does the same — so a caller
CTE is not merely out-ranked in those contexts, it is absent. No qualified-name arm can
distinguish them, so no arm was added there.

**Coverage gap: the view arm of the fall-through — fixed in this pass.**
Every qualified arm the implement stage wrote resolved to a *base table*. The `else` branch
also resolves views and maintained tables, and the old bug shadowed all three equally. Added
arms creating a real view `cv`, then reading `main.cv` (3 rows, the view) and `cv` (1 row,
the CTE) under a same-named CTE.

**Doc gap — fixed in this pass.**
`docs/vu-operators.md` is a write-path internals doc; the user-facing CTE reference is
`docs/sql-select.md` § 3.7, whose "Visibility inside the declaring statement" list is exactly
where a reader looks for shadowing rules. It said nothing about qualified names. Added a
bullet covering read and write together.

**Precedence disagreement between `tableSourceColumnNames` and `buildFrom` — verified, not
re-filed.** The implement handoff flagged that its new comment asserts a disagreement no test
pins. Confirmed against the code: `scope-transform.ts:496` calls `findSchemaItem` before the
`cteNodes` fallback, while `select.ts:426` checks `cteNodes` first — so for a bare name
matching *both*, the analysis reads the table's columns and the plan binds the CTE. The
comment's direction is correct. Already tracked by backlog
`bug-cte-shadow-precedence-scope-transform`; not duplicated.

**`temp.` / attached-schema arms — deliberately not added.**
The gate tests only for the *presence* of a qualifier and never inspects the schema name, and
resolution of the qualifier itself is untouched pre-existing code. An arm using `temp.`
instead of `main.` would exercise no distinct branch.

**Two "no such table" wordings** (`Table not found: main.x` for a qualified miss vs
`Table 'x' not found in schema path: …` for an unqualified one) — the implement stage parked
this as a tripwire comment in `13.10-cte-qualified-name.sqllogic` next to the error
assertion. Agreed disposition: it predates this ticket, nothing is currently wrong, and it
only becomes work if something starts matching on the message. Left where it is.

**Not-swept clauses.** `set` / `returning` / qualified *column* references (`main.c.k`) were
not changed and are resolved by different machinery than `buildFrom`'s FROM binding, so they
are unaffected by construction. No arms added and no ticket filed — there is no code site
that could have regressed.
