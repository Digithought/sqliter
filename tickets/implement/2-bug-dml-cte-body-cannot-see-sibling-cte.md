---
description: A query can define several named blocks up front and have later ones use earlier ones. That works when the later block only reads data, but fails with "table not found" as soon as the later block inserts, updates or deletes.
files:
  - packages/quereus/src/planner/building/with.ts             # buildCommonTableExpr — THE fix site (~86-130)
  - packages/quereus/src/planner/building/select-context.ts   # buildWithContext — explicit parentCTEs outrank ctx.cteNodes (why the fix takes this shape)
  - packages/quereus/src/planner/stored-body-context.ts       # storedBodyContext — clears cteNodes; why threading it is safe for view bodies
  - packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic  # new test file (13.6 is taken)
  - docs/runtime-caching.md                                   # ~164-179 "Three known gaps" — one bullet is this bug; drop it
  - docs/sql-select.md                                        # § 3.7 WITH clause — state the visibility rule
difficulty: medium
repro: verified
---

# A data-modifying `with` block cannot see its sibling blocks

A `with` clause may define several named blocks, and a later block may name an earlier
one. That holds while the later block only reads; the moment it writes, the reference
fails with `Table 'a' not found in schema path: main`.

Reproduced on a clean tree for all three writing forms (`insert`, `update`, `delete`).
The fix below was prototyped, verified against every case listed under *Behaviour to
pin*, and run against the whole `packages/quereus` suite (8647 passing, 13 pending, no
regressions) — then reverted so this ticket carries the change.

## Root cause

`buildCommonTableExpr` (`planner/building/with.ts`) hands the already-built sibling
blocks to its member body one way only: as the explicit `parentCTEs` argument of
`buildSelectStmt`. The `values` / `insert` / `update` / `delete` branches call their
builders with no such argument, and the DML builders take their inherited definitions
from `ctx.cteNodes` (via `buildWithContext`) — which `buildCommonTableExpr` never sets.
So a table reference inside a writing body falls through to ordinary schema lookup and
reports a missing table.

The same line is the site of a second, adjacent defect. Because the `select` branch
passes `existingCTEs` (this clause's earlier members *only*), and `buildWithContext`
prefers a non-empty explicit `parentCTEs` argument over `ctx.cteNodes` wholesale, a
nested `with` clause's **second and later** members lose the *enclosing* statement's
blocks:

```sql
-- fails today with "Table 'o' not found"; the first member alone would have seen `o`
with o as (select id from p)
select n from (with z as (select 1 as k),
                    a as (select count(*) as n from o)
               select n from a) x;
```

One merged map fixes both arms.

## The change

In `buildCommonTableExpr`, compute the definitions visible to the member being built —
the enclosing statement's, with this clause's earlier members layered on top so a
same-named sibling shadows an outer one — put it on the context (which is what reaches
the DML builders), and pass it where `existingCTEs` was passed explicitly:

```ts
	// Definitions visible to THIS member: the enclosing statement's (ctx.cteNodes) with
	// the earlier members of this clause layered on top (a same-named sibling shadows an
	// outer one). Threaded onto the context so a member body that does NOT take an
	// explicit parent-CTE argument — every DML body — still resolves them.
	const visibleCTEs = ctx.cteNodes && ctx.cteNodes.size > 0
		? new Map([...ctx.cteNodes, ...existingCTEs])
		: existingCTEs;

	const cteContext = { ...ctx, cteNodes: visibleCTEs };
	...
	if (isRecursiveCte(isRecursive, cte)) {
		return buildRecursiveCTE(cteContext, cte, visibleCTEs, options);
	}
	...
		case 'select':
			query = buildSelectStmt(cteContext, cte.query, visibleCTEs) as RelationalPlanNode;
```

Three notes on why this is safe rather than a wider leak:

- The DML builders already do the right thing with an inherited namespace —
  `buildUpdateStmt` / `buildDeleteStmt` call `buildWithContext(ctx, stmt)` at the top,
  which starts from `ctx.cteNodes` and merges the statement's own `with` clause on top.
  `buildInsertStmt` reaches it through the source build's empty `parentCtes` argument.
  Nothing new has to be threaded through their signatures.
- A member's own nested `with` clause keeps shadowing an enclosing block of the same
  name, because that clause is merged on top of the inherited map, not beside it.
- A stored body (view / materialized-view derivation) is unaffected: `storedBodyContext`
  clears `cteNodes`, so a caller's blocks still cannot reach into a body.

## Behaviour to pin

Each of these was run against the prototype and produced the stated result. They are the
test cases; `p` is `(id integer primary key, v text)` holding ids 1 and 2, `q` is
`(id integer primary key, w integer)`.

- `insert` body reads a sibling —
  `with a as (select id from p), b as (insert into q select id + 10, 1 from a returning id) select count(*) as n from b` → 2, rows 11 and 12 in `q`.
- `update` body reads a sibling —
  `with a as (select id from p), b as (update q set w = (select count(*) from a) where id = 1 returning id) select count(*) as n from b` → 1.
- `delete` body reads a sibling —
  `with a as (select id from p), b as (delete from q where id in (select id from a) returning id) select count(*) as n from b` → 2.
- A writing body's OWN `with` clause still shadows an enclosing block of the same name —
  `with a as (select id from p), b as (with a as (select 77 as id) insert into q select id, 5 from a returning id) select count(*) as n from b` → 1, and `q` gets id 77, not 1 and 2.
- A writing body's own `with` clause can itself read an enclosing sibling —
  `with a as (select id from p), b as (with c as (select id from a) insert into q select id + 10, 1 from c returning id) select count(*) as n from b` → 2.
- Nested clause, second member sees the enclosing block (the second arm above) → 2.
- Nested clause, a sibling shadows a same-named enclosing block —
  `with o as (select 99 as id) select n from (with o as (select 7 as id), a as (select id as n from o) select n from a) x` → 7.
- Recursive clause unaffected —
  `with recursive base as (select 1 as k), r as (select k from base union all select k + 1 from r where k < 3) select k from r` → 1, 2, 3.

## The ordering question, answered

The source ticket asked: if block `b` reads block `a`, and `a` also writes, does `b`
observe `a`'s write? **Yes, and exactly once.** Reading `a` is what drives `a`'s write,
and a data-modifying block is always materialized (see docs/runtime-caching.md
§ Shared CTE materialization), so `b` consumes precisely `a`'s buffered `RETURNING`
rows however many times `b` names it. Verified:
`with a as (insert into q values (300, 1) returning id), b as (insert into q select id + 1, 2 from a returning id) select count(*) as n from b`
→ 1, with both id 300 and id 301 landing in `q` exactly once. Pin this as a test case
and state it in `docs/sql-select.md` § 3.7.

A neighbouring question is NOT answered by this work and must not be presented as if it
were: a block that reads the **base table** another block writes sees a result that
depends on where the outer query mentions each block.

```sql
-- the same statement, differing only in projection order: n is 0 in the first, 1 in the second
with a as (insert into q values (1,1) returning id), b as (select count(*) as n from q)
  select (select n from b) as n, (select count(*) from a) as m;   -- n = 0
with a as (insert into q values (1,1) returning id), b as (select count(*) as n from q)
  select (select count(*) from a) as m, (select n from b) as n;   -- n = 1
```

That is pre-existing (it involves no block-to-block reference and this change does not
touch it), and picking the right semantics is a real decision — PostgreSQL gives every
sub-statement one snapshot so the answer is always "does not see it", while Quereus's
isolation layer is read-your-own-writes. Record it as a fourth bullet in the existing
gap list in `docs/runtime-caching.md` alongside the two already-undecided items, with
the two-statement repro above. Do not file it as a ticket and do not try to settle it
here.

## TODO

- Apply the `visibleCTEs` change in `packages/quereus/src/planner/building/with.ts` as
  written above, keeping the comment.
- Add `packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic` covering every
  case under *Behaviour to pin* plus the write-once assertion from *The ordering
  question, answered* (assert the resulting table contents, not only the counts, so a
  double write would fail).
- Update `docs/runtime-caching.md`: delete the "A data-modifying CTE body cannot see its
  **sibling** CTEs" bullet from the "Three known gaps" list (and fix the list's lead-in
  count), then add the base-table cross-visibility bullet described above.
- Update `docs/sql-select.md` § 3.7: state that every block in a `with` clause sees the
  blocks defined before it whatever its body does, that an inner clause's block shadows
  a same-named outer one, and that reading a writing block yields that block's
  `RETURNING` rows, its write happening once.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`; the suite was clean
  under the prototype, so any failure is new.
