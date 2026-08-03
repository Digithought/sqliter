---
description: A query can silently return wrong answers from a view: if the query defines a temporary named result set (a `with` clause) that happens to share a name with something the view reads, the view quietly reads that instead. The code fix is already applied and verified; what remains is regression tests and doc updates.
files:
  - packages/quereus/src/planner/mutation/body-context.ts    # new `storedBodyContext` helper — the single isolation seam
  - packages/quereus/src/planner/building/select.ts          # ~452 view expansion, ~542 stale-MV re-validation — now use the helper
  - packages/quereus/src/planner/building/select-context.ts  # ~31 the `ctx.cteNodes` fallback that made the explicit arg insufficient
  - packages/quereus/src/planner/building/create-view.ts     # ~24 create-time body plan — same swap, not yet using the helper
  - packages/quereus/src/planner/building/create-assertion.ts # ~59 assertion body plan — same swap, not yet using the helper
  - packages/quereus/test/view-home-schema.spec.ts           # where stored-body isolation is pinned today; new cases go here
  - docs/schema.md                                           # ~335 "Stored bodies resolve against their home schema"
  - docs/sql-views.md                                        # ~21 "Home-schema resolution"
repro: verified
difficulty: easy
---

# A caller's `with` clause leaks into a stored view body

## Status: code fix applied and verified in the working tree

The investigation reproduced both reported symptoms, found a **third** leak
channel the original ticket did not describe, and applied a fix that closes all
three. `yarn test` (full workspace) and `yarn workspace @quereus/quereus run
lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) both pass with the fix in
place. **No regression tests were added and no docs were updated** — that is the
remaining work, plus two optional symmetry cleanups. See the TODO list.

## What was wrong

A view's stored body is supposed to bind the same objects on every reference.
The engine already isolates the body's *schema search path* from the reading
statement (`docs/schema.md` § "Stored bodies resolve against their home
schema"). The common-table-expression namespace is the other half of the same
naming environment and was never isolated, so a caller `with` clause whose name
matched a body source silently replaced it.

Three independent channels carried the leak into the body plan. All three had
to be closed; closing any subset leaves a reproducible wrong answer.

1. **The explicit argument.** `building/select.ts`'s view branch passed the
   caller's `cteNodes` map straight into `buildSelectStmt` for the body.
2. **The context fallback.** `select-context.ts:31` reads
   `parentCTEs.size > 0 ? parentCTEs : (ctx.cteNodes ?? new Map())` — so passing
   an empty map as the argument is *not* enough on its own; the body still
   picks the caller's CTEs back up off `ctx.cteNodes`. This is why the write
   path leaked even though `analyzeView` never passed a `cteNodes` argument at
   all.
3. **The shared `cteReferenceCache`** (`PlanningContext.cteReferenceCache`,
   consumed at `select.ts` ~412-426). It is keyed by bare `cteName:alias` and is
   mutated in place on a context object that body contexts inherit by
   reference. When the caller and the view body each define a CTE named `c`, the
   body's `from c` gets a cache hit on the *caller's* `CTEReferenceNode` and
   reads the caller's rows — even after channels 1 and 2 are closed, and even
   though the body's own `with` clause correctly overrode the name in the
   `cteNodes` map.

Channel 3 was verified in isolation: with only `cteNodes` cleared, the query
below still returned the caller's `777` for the view column.

## Reproductions (all run against `main` at `4afccc77`)

Before the fix / after the fix:

```sql
create table main.lt (id integer primary key, x integer);
insert into main.lt values (1, 10);
create view main.lv as select id, x from lt;

with lt as (select 1 as id, 999 as x) select * from lv;
-- before: [{"id":1,"x":999}]   after: [{"id":1,"x":10}]

with lt as (select 1 as id, 999 as x) update lv set x = 5 where id = 1;
-- before: error "cannot write through view 'lv': view body operator
--         'CTEReference' is not updateable in phase 1"
-- after:  succeeds, main.lt becomes (1, 5)

with lt as (select 1 as id, 999 as x) delete from lv where id = 1;
-- before: same 'CTEReference' error       after: succeeds, row deleted

with lt as (select 1 as id, 999 as x), q as (select * from lv) select * from q;
-- before: [{"id":1,"x":999}]   after: [{"id":1,"x":10}]
```

Channel 3, which needs a body-local CTE *and* a caller reference to a
same-named caller CTE in the caller's own `from`:

```sql
create table main.ct (id integer primary key, x integer);
insert into main.ct values (1, 10);
create view main.cv as with c as (select id, x from ct) select id, x from c;

with c as (select 1 as id, 777 as x)
select c.id, c.x, (select x from cv) as vx from c;
-- before: vx = 777 (wrong; the view's own `c` reads main.ct, so vx must be 10)
-- after:  vx = 10
```

Cases that were already correct and must **stay** correct (all verified after
the fix):

- a body-local `with` clause still resolves (`create view bv as with c as
  (select id, x from bt) select id, x from c`);
- an ephemeral write target keeps the caller's CTEs — `with c as (select id, x
  from et) update c set x = 99 where id = 1` still writes `main.et`;
- the caller's own `where` subquery still sees the caller's CTEs — `with k as
  (select 1 as id) select * from lv where id in (select id from k)`;
- `insert … returning` through a view under a caller `with`;
- a materialized-view read is unaffected (it reads the backing table).

## The fix as applied

One new helper in `packages/quereus/src/planner/mutation/body-context.ts`,
alongside the existing `bodyPlanningContext`:

```ts
export function bodyPlanningContext(ctx: PlanningContext, view: MutableViewLike): PlanningContext {
	if (view.ephemeral) return ctx;
	return storedBodyContext(ctx, view.schemaName);
}

export function storedBodyContext(ctx: PlanningContext, schemaName: string): PlanningContext {
	return {
		...ctx,
		schemaPath: ctx.db._homeSchemaPath(schemaName),
		cteNodes: undefined,
		cteReferenceCache: undefined,
	};
}
```

`building/select.ts` now calls `storedBodyContext(parentContext, …)` at both
sites that previously inlined the schema-path swap (the view-expansion branch
~452 and the stale-materialized-view re-validation ~542) and no longer forwards
`cteNodes` into either body plan. That module gained one import:
`import { storedBodyContext } from '../mutation/body-context.js';`.

Because every write-side stored-body plan already routes through
`bodyPlanningContext` (`mutation/single-source.ts` ~462 and ~665,
`mutation/backward-body.ts` ~171, `mutation/set-op.ts` ~508, ~1721, ~1809), the
write path is covered by the helper change alone.

### Why clearing `cteNodes` on the body context is safe

Two kinds of *internal* entries are injected into `cteNodes` during write
lowering — the multi-source identity capture under `__vmupd_keys`
(`mutation/multi-source.ts`, `building/view-mutation-builder.ts`
`withKeyCapture`) and the self-read capture under the target's own CTE name
(`withCteCapture`). Neither is affected:

- every `bodyPlanningContext` call site plans a **stored** AST — `view.selectAst`
  or a set-op leg of it — and a stored body can never name `__vmupd_keys`;
- the self-read capture only applies to a CTE-name DML target, which is
  `view.ephemeral`, and `bodyPlanningContext` returns the caller's context
  verbatim for those.

The rewritten base-op queries, which *do* resolve `__vmupd_keys`, are planned
from the op context, not through `bodyPlanningContext`.

## Remaining work

### TODO

- Add regression cases to `packages/quereus/test/view-home-schema.spec.ts` (or a
  sibling spec if that file's "non-main schema" framing is too narrow — the
  reviewer's call). Pin, at minimum, one case per channel and one per
  must-not-break direction:
  - caller CTE shadowing a view's base table on **read** returns the base
    table's rows;
  - same on **update** and on **delete** — both write `main.lt` and neither
    raises the `'CTEReference' is not updateable in phase 1` error;
  - a caller CTE whose body reads the view (the `with lt …, q as (select * from
    lv)` nesting) is isolated too;
  - the channel-3 case: caller CTE `c` referenced in the caller's own `from`,
    plus a view with a body-local CTE `c`, yields the view's own rows;
  - a body-local `with` clause still resolves;
  - an ephemeral CTE target (`with c as (…) update c …`) still sees the caller's
    CTEs;
  - the caller's `where` subquery still sees the caller's CTEs.
- Update `docs/schema.md` § "Stored bodies resolve against their home schema"
  (~335) so the rule covers the CTE namespace, not only the search path: a
  stored body binds only its own `with` clause plus schema objects on its home
  path; a caller CTE of any name is invisible to it; ephemeral targets are
  explicitly excluded.
- Update `docs/sql-views.md` § "Home-schema resolution" (~21) with the same
  one-line addition, in that section's voice.
- Judgement call on layering: `storedBodyContext` currently lives under
  `planner/mutation/` but is imported by `planner/building/select.ts`. It
  type-imports only, so there is no runtime cycle and the build and lint are
  clean — but if the building→mutation direction is unwanted, move the helper to
  a neutral module (e.g. `planner/stored-body-context.ts`) and have
  `mutation/body-context.ts` re-export or call it. Purely cosmetic; do not
  change behaviour while moving it.
- Optional symmetry (a no-op today, defensive): `building/create-view.ts` ~24
  (`planViewBody`) and `building/create-assertion.ts` ~59 both inline the same
  schema-path swap without clearing CTE state. Neither is reachable with a
  non-empty caller CTE map today — SQL has no `with … create view …` form — so
  this is consistency, not a bug fix. If you route them through
  `storedBodyContext`, verify no create-time test regresses.

### Validation

- `yarn test` from the repo root (full workspace) — was green with the fix
  applied and no new tests; must stay green with the new cases.
- `yarn workspace @quereus/quereus run lint` — eslint plus the test-file type
  pass; was clean.
