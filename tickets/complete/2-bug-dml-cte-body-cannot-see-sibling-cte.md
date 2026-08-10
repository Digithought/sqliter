---
description: Fixed a query bug where a named query block that inserts, updates or deletes could not refer to a block defined before it, and reported the earlier block as a missing table.
files:
  - packages/quereus/src/planner/building/with.ts                     # the fix (buildCommonTableExpr)
  - packages/quereus/src/planner/building/select-context.ts           # review: tripwire NOTE
  - packages/quereus/src/planner/building/dml-target.ts               # review: tripwire NOTE
  - packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic  # coverage (extended in review)
  - docs/runtime-caching.md                                           # gap list: sibling bullet removed, base-table bullet added
  - docs/sql-select.md                                                # § 3.7 "Visibility between CTEs"
---

# A data-modifying `with` block can now see its sibling blocks

## What shipped

`buildCommonTableExpr` (`planner/building/with.ts`) used to hand this clause's
already-built members to its member body one way only: as the explicit `parentCTEs`
argument of `buildSelectStmt`. The `values` / `insert` / `update` / `delete` branches
called their builders with no such argument, and the DML builders take their inherited
definitions from `ctx.cteNodes` (via `buildWithContext`) — which `buildCommonTableExpr`
never set. A relation reference inside a writing body fell through to ordinary schema
lookup and failed with `Table 'a' not found in schema path: main`.

The fix computes one merged map — the enclosing statement's definitions with this clause's
earlier members layered on top — puts it on the context, and passes it where `existingCTEs`
was passed explicitly:

```ts
const visibleCTEs = new Map<string, CTEScopeNode>([...(ctx.cteNodes ?? []), ...existingCTEs]);
const cteContext = { ...ctx, cteNodes: visibleCTEs };
```

That merged map also closes a second, adjacent defect: because the explicit argument
carried **this clause's** members only, and `buildWithContext` prefers a non-empty explicit
`parentCTEs` argument over `ctx.cteNodes` wholesale, a nested `with` clause's second and
later members previously lost the *enclosing* statement's blocks
(`with o as (…) select n from (with z as (…), a as (select … from o) …)` failed with
`Table 'o' not found`).

The map is copied rather than aliased: `buildWithClause` keeps `set`-ing later members into
`existingCTEs` after each member is built, so an alias would leave a member's context
holding a map that grows behind it.

The scope-registration loop just below (`cteScope.registerSymbol` for `cteName.column`) was
deliberately left iterating `existingCTEs`, not `visibleCTEs`. Those symbols bind to the CTE
**body's** attribute ids, which `select-context.ts`'s own header comment flags as the shape
that fails at runtime with "No row context found for column …"; a qualified reference to an
enclosing clause's block resolves through `buildFrom`'s CTE branch instead.

Docs: the "a data-modifying CTE body cannot see its sibling CTEs" bullet was removed from
the gap list in `docs/runtime-caching.md` and replaced with the still-undecided base-table
cross-visibility case (below). `docs/sql-select.md` § 3.7 gained a "Visibility between CTEs"
block stating the rule.

## Review findings

Read the implement diff first (`git show e558a356`), then the handoff. Lint and the full
suite were run twice — before and after the review's own edits. Final state:
`yarn lint` clean; `yarn test` **8648 passing, 13 pending, 0 failing**.

### Verified, no defect found

- **The `undefined`-vs-empty-`Map` question the handoff flagged.** Every read site of
  `ctx.cteNodes` in `packages/quereus/src` was enumerated and each tolerates an empty map:
  `dml-target.ts:188` (`!ctx.cteNodes?.size`), `select-context.ts:32` (`?? new Map()` then
  `.size > 0`), `expression.ts:39` (passes it straight through as `parentCTEs`, re-gated on
  `.size > 0`), `view-mutation-builder.ts:435` (`?? []`), and three construction sites that
  already pass `new Map()`. No site distinguishes the two.
  *(The handoff cited `multi-source.ts:2162` and `scope-transform.ts:513` as read sites —
  neither file contains a `cteNodes` reference; those two citations are wrong. The
  conclusion they supported still holds on the real set above.)*
- **Sibling CTEs do not become writable DML targets.** `resolveCteTarget` gates on the DML
  statement's OWN `withClause`, not on `ctx.cteNodes`, so widening the context does not
  turn `with a as (select …), b as (insert into a …)` into a write-through. Confirmed by
  probe: it still reports `Table 'a' not found`.
- **Stored-body (view write-through) isolation is intact.** `storedBodyContext` sets
  `cteNodes: undefined`, so a body's members compute `visibleCTEs` from `existingCTEs`
  alone — byte-identical to pre-fix. Probed directly: a caller `with p as (…) update vp …`
  where `p` is also the view's base table still writes through to the real `p`.
- **Docs claims were executed, not read.** Both statements in the new
  `docs/runtime-caching.md` gap bullet reproduce exactly as written (`n = 0` then `n = 1`),
  and the second `docs/sql-select.md` example returns `n = 1` with rows 300/301 present
  once each.

### Fixed in this pass (minor)

- **Redundant branch in the merge** (`with.ts`). The landed
  `ctx.cteNodes && ctx.cteNodes.size > 0 ? new Map([...ctx.cteNodes, ...existingCTEs]) : new Map(existingCTEs)`
  buys nothing — spreading an empty map contributes nothing. Collapsed to the single
  expression shown above. Behaviour-identical; suite re-run green.
- **Coverage gaps the handoff itself listed as unguarded** — added to
  `13.7-cte-sibling-visibility.sqllogic`, all passing:
  - a member naming a **later** sibling still errors, from a DML body and from a SELECT body;
  - a non-recursive DML body naming **itself** still errors;
  - a sibling **shadows a same-named real base table** inside a writing body (the CTE wins);
  - **three** clause levels deep (previous coverage stopped at two).

### Recorded as tripwires (conditional; not tickets)

- `building/dml-target.ts` — `contextForCteTarget` deletes shadowed names **by name** from
  the now-merged map, so a same-named definition inherited from an *enclosing* clause is
  dropped along with the target's own. Needs a CTE-name DML target nested inside another
  clause that reuses the name, which does not occur today. `NOTE:` at the site.
- `building/select-context.ts` — `buildWithContext` seeds the statement body from the
  explicit `parentCTEs` when non-empty, but builds the clause's own members against
  `ctx.cteNodes`. The two agree everywhere that matters today; the divergence only becomes
  visible if a stored-body fragment's own `with` clause ever needs the body's carried
  definitions. `NOTE:` at the site.

### Filed as a new ticket (major, pre-existing)

- `backlog/bug-recursive-leg-nested-with-freezes-working-table` — a `with recursive` query
  whose recursive leg reads the recursion from inside a **nested `with` block** never
  advances: it replays round one forever and dies on "exceeded maximum iteration limit".
  The same query with a plain sub-select instead of the nested block works. Root cause
  narrowed to `driveRecursion` (`runtime/emit/recursive-cte.ts`) re-running the recursive
  leg per round while the statement-lifetime result buffers (`rctx.cteMaterializations`,
  `rctx.cacheStates`) are never scoped to a round. `repro: verified`, and verified
  **pre-existing** — reproduced identically with this ticket's change reverted, so it is
  not a regression from it.

### Not run

- `yarn test:store`. The change is planner-side name resolution and should be
  backend-independent, and the store suite is the slow leg; it was not run for this ticket
  in either stage.

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
not see it"; Quereus's isolation layer is read-your-own-writes). Recorded as a bullet in
the gap list in `docs/runtime-caching.md` with this repro — deliberately not filed as a
ticket and not settled here.
