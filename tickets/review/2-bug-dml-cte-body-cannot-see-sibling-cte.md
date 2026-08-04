---
description: Fixed a query bug where a named query block that inserts, updates or deletes could not refer to a block defined before it, and reported the earlier block as a missing table.
files:
  - packages/quereus/src/planner/building/with.ts                     # the fix (buildCommonTableExpr, ~84-127)
  - packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic  # new coverage
  - docs/runtime-caching.md                                           # gap list: sibling bullet removed, base-table bullet added
  - docs/sql-select.md                                                # § 3.7 "Visibility between CTEs"
difficulty: medium
---

# Review: a data-modifying `with` block can now see its sibling blocks

## What changed

`buildCommonTableExpr` (`planner/building/with.ts`) previously handed this clause's
already-built members to its member body **one way only**: as the explicit `parentCTEs`
argument of `buildSelectStmt`. The `values` / `insert` / `update` / `delete` branches
called their builders with no such argument, and the DML builders take their inherited
definitions from `ctx.cteNodes` (via `buildWithContext`) — which `buildCommonTableExpr`
never set. A relation reference inside a writing body fell through to ordinary schema
lookup and failed with `Table 'a' not found in schema path: main`.

The fix computes one merged map — the enclosing statement's definitions with this
clause's earlier members layered on top — puts it on the context, and passes it where
`existingCTEs` was passed explicitly:

```ts
const visibleCTEs: Map<string, CTEScopeNode> = ctx.cteNodes && ctx.cteNodes.size > 0
	? new Map([...ctx.cteNodes, ...existingCTEs])
	: new Map(existingCTEs);

const cteContext = { ...ctx, cteNodes: visibleCTEs };
```

That merged map also closes a second, adjacent defect the fix ticket identified: because
the explicit argument carried **this clause's** members only, and `buildWithContext`
prefers a non-empty explicit `parentCTEs` argument over `ctx.cteNodes` wholesale, a
nested `with` clause's second and later members previously lost the *enclosing*
statement's blocks (`with o as (…) select n from (with z as (…), a as (select … from o) …)`
failed with `Table 'o' not found`).

Docs: the "A data-modifying CTE body cannot see its **sibling** CTEs" bullet was deleted
from the gap list in `docs/runtime-caching.md`, replaced by a bullet describing the
still-undecided base-table cross-visibility case (below). `docs/sql-select.md` § 3.7
gained a "Visibility between CTEs" block stating the rule.

## Two deviations from the fix ticket's prototype — check these first

1. **The merged map is copied, not aliased.** The prototype wrote
   `: existingCTEs` for the no-enclosing-definitions branch; this lands `: new Map(existingCTEs)`.
   `buildWithClause` keeps `set`-ing later members into that same map after each member is
   built, so aliasing would leave a member's context holding a map that grows behind it.
   No current reader consults `ctx.cteNodes` lazily (building is eager, and every reader —
   `select-context.ts:32`, `dml-target.ts:197`, `multi-source.ts:2162`,
   `view-mutation-builder.ts:435` — copies before use), so this is defensive, not a
   behaviour change. Cost: one `Map` copy per clause member.
2. **`cteContext.cteNodes` is now always a `Map`**, where it previously inherited whatever
   `ctx` had — including `undefined`. Every read site was checked and tolerates an empty
   map (`dml-target.ts:188` uses `!ctx.cteNodes?.size`; `scope-transform.ts:513` guards on
   truthiness then `.get()`s; `select-context.ts:32` falls back on `.size > 0`;
   `expression.ts:39` passes it straight through as `parentCTEs`, which
   `buildWithContext` again gates on `.size > 0`). Worth a second pair of eyes — an
   `undefined`-vs-empty-Map distinction anywhere would be a silent behaviour change.

The scope-registration loop just below (`cteScope.registerSymbol` for `cteName.column`)
was deliberately **left** iterating `existingCTEs`, not `visibleCTEs`. Those symbols bind
to the CTE **body's** attribute ids, which `select-context.ts`'s own header comment flags
as the shape that fails at runtime with "No row context found for column …"; a qualified
reference to an enclosing clause's block resolves through `buildFrom`'s CTE branch
instead. Widening that loop would be new risk with nothing demanding it.

## Validation performed

- `packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic` — new, passes.
- Fix reverted by hand, 13.7 re-run: fails inside `buildInsertStmt` ← `buildCommonTableExpr`,
  confirming the file bites rather than passing vacuously. Fix restored, re-run green.
- `yarn workspace @quereus/quereus run test` — **8648 passing, 13 pending, 0 failing**
  (8647 before, +1 for the new file). No regressions.
- `yarn lint` — clean (`Done in 41s`).

## Cases pinned by 13.7 (use these to poke at it)

Every one of these failed or was unverified before; each is a row-and-table-contents
assertion, not only a count, so a double write fails the file.

- `insert` body reads a sibling → 2 rows returned, ids 11 and 12 land in the target.
- `update` body reads a sibling through a scalar subquery in `set` → 1 row, `w` = 2 on the
  updated row only.
- `delete` body reads a sibling via `where id in (select … from a)` → 2 rows, 1 survivor.
- A writing body's **own** `with` clause shadows a same-named enclosing sibling → the
  local `select 77 as id` wins; the target gets 77, not 1 and 2.
- A writing body's own `with` clause **reads** an enclosing sibling → 2 rows.
- `values`-bodied member alongside a sibling (control — a `values` body cannot name a
  relation; pinned only so the context threading did not perturb it).
- Nested clause, **second** member sees the enclosing statement's block → 2.
- Nested clause, a sibling **shadows** a same-named enclosing block → 7, not 99.
- Recursive clause unaffected: `with recursive base as (…), r as (… union all …)` → 1,2,3.
- Reading a **writing** sibling: `a` inserts id 300, `b` reads `a` and inserts 301 → both
  rows present exactly once (a second drive of either would trip the primary key).
- A writing sibling named **twice** in one body (`select id, (select count(*) from a) from a`)
  → still one write.
- Read-only sibling chain a → b → c (control).

## Known gaps — the tests are a floor, not a ceiling

- **Store backend not exercised.** Only `yarn test` (memory vtab) was run. The change is
  purely planner-side name resolution and should be backend-independent, but
  `yarn test:store` was not run for it.
- **View write-through was reasoned, not directly targeted.** The claim is that a stored
  body is unaffected because `storedBodyContext` clears `cteNodes`, so a caller's blocks
  cannot reach into a body. The existing view/write-through suite passes, but 13.7 adds no
  case that puts a data-modifying CTE body inside a lowered view mutation. If you want one
  more probe, that is where I would aim it.
- **Correlated-subquery interaction untested.** A data-modifying CTE nested in a
  correlated subquery already has undecided semantics (its own bullet in the
  `docs/runtime-caching.md` gap list); 13.7 does not combine that with sibling visibility.
- **No negative test for forward references.** Nothing pins that a member naming a *later*
  sibling still errors. That behaviour is unchanged (the map only ever holds earlier
  members), but it is unguarded.
- **Deep nesting untested.** Coverage goes two clause levels deep (a clause inside a
  member body, and a clause inside a `from` subquery). Three or more is unexercised.

## Base-table cross-visibility — documented, deliberately not fixed

Separately from this change (it involves no block-to-block reference), a CTE reading the
**base table** another CTE writes gives an answer that depends on projection order:

```sql
with a as (insert into q values (1,1) returning id), b as (select count(*) as n from q)
  select (select n from b) as n, (select count(*) from a) as m;   -- n = 0
with a as (insert into q values (1,1) returning id), b as (select count(*) as n from q)
  select (select count(*) from a) as m, (select n from b) as n;   -- n = 1
```

Pre-existing, untouched by this change, and picking the right semantics is a real design
decision (PostgreSQL gives every sub-statement one snapshot so the answer is always "does
not see it"; Quereus's isolation layer is read-your-own-writes). Per the fix ticket this
was recorded as a bullet in the existing gap list in `docs/runtime-caching.md` with the
two-statement repro — **not** filed as a ticket, and not to be settled during review.
