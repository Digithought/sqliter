---
description: A view whose definition uses a named sub-query block (a "with" clause) reads correctly, but updating or deleting through it either fails with a confusing "table not found" error or silently changes nothing — carry the definition's own named blocks into the write so it behaves like the read.
files:
  - packages/quereus/src/parser/ast.ts                              # SelectStmt.storedHomeSchema (~211) — the new sibling field goes here
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation (~48) — the single funnel; stamps the body clone
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt (~60-104) — where the marker is consumed
  - packages/quereus/src/planner/planning-context.ts                # PlanningContext (~120-203) — where the per-lowering memo field goes
  - packages/quereus/src/planner/building/with.ts                   # buildWithClause — builds a WITH clause into CTE plan nodes
  - packages/quereus/src/planner/stored-body-context.ts             # storedBodyContext — the body's naming environment
  - packages/quereus/src/planner/mutation/scope-transform.ts        # mapNestedSelects (~212), rebuildSelect (~249)
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts    # MutationDiagnosticReason union — one new reason code
  - packages/quereus/src/func/builtins/schema.ts                    # deriveViewInfo (~835) — the view_info honesty gate
  - packages/quereus/test/view-cte-isolation.spec.ts                # the CTE-namespace spec these cases belong in
  - docs/view-updateability.md                                      # § Schema resolution during write-through (lines 97-107)
repro: verified
difficulty: medium
---

# Carry a stored body's own `with` clause into the fragments copied out of it

## What is wrong

A write through a view is **lowered** into an ordinary INSERT / UPDATE / DELETE
against the base table. Pieces of the view's definition are copied into that
lowered statement — the definition's own `where`, each view column's defining
expression, an authored `with inverse` put expression, a `with defaults` value.
Those pieces are copied **without** the definition's own `with` clause, so a
sub-select inside one of them that reads a definition-local named block has
nothing to bind to.

The sibling ticket `bug-view-write-subquery-in-body-uses-caller-schema` (landed,
in `complete/`) made each copied sub-select re-enter the view's own naming
environment — home schema path, caller CTE namespace cleared. That closed the
mis-bind half. It did not carry the body's own definitions along, which is this
ticket.

## Reproduced on the current tree

Every case below was run against `main` at `d3e7e3b1`. Two distinct failure
modes; the second is the serious one.

### Arm 1 — a confusing error on a view the tooling calls writable

```sql
create table main.a (id integer primary key, x integer);
create table main.b (id integer primary key);
insert into main.a values (1, 10);
insert into main.b values (1);
create view main.vc as with c as (select id from b) select id, x from a where id in (select id from c);

select * from main.vc;                  -- [{id:1, x:10}]     works
update main.vc set x = 99 where id = 1; -- QuereusError: Table 'c' not found in schema path: main
delete from main.vc where id = 1;       -- same error
```

`select name, is_insertable_into, is_updatable, is_deletable from view_info()`
reports `vc | YES | YES | YES`.

The same error was reproduced on every channel that copies a fragment:

| shape | statement that fails |
| --- | --- |
| definition `where` | `update` / `delete` (above) |
| a view column's defining expression, pulled in by a user `where` on that column | `create view main.vn as with c as (select id from b) select id, x, (select count(*) from c) as n from a;` → `update main.vn set x = 55 where n = 1` |
| an authored `with inverse` put expression | `create view main.vi as with c as (select 5 as k from b) select id, x + (select max(k) from c) as y with inverse (x = new.y - (select max(k) from c)) from a;` → `update main.vi set y = 20 where id = 1` |
| a `with defaults` value (the INSERT path) | `create view main.vdf as with c as (select 7 as k from b) select id, x from a with defaults (x = (select max(k) from c));` → `insert into main.vdf (id) values (3)` |
| a materialized view | `create materialized view main.mv as with c as (select id from b) select id, x from a where id in (select id from c);` → `update main.mv set x = 88 where id = 1` |
| a recursive definition-local block | `create view main.vr as with recursive r(n) as (select 1 union all select n+1 from r where n < 3) select id, x from a where id in (select n from r);` → `update main.vr set x = 33 where id = 1` |

### Arm 2 — a silent no-op write (the severe one)

When the definition-local name also exists as a **real table**, nothing errors —
the lowered statement binds the real table, so the write quietly affects zero
rows while the read of the same view returns the row:

```sql
create table main.a (id integer primary key, x integer);
create table main.b (id integer primary key);
create table main.c (id integer primary key);            -- real table c
insert into main.a values (1, 10);
insert into main.b values (1);
insert into main.c values (2);                           -- ... holding a DIFFERENT id
create view main.vs as with c as (select id from b) select id, x from a where id in (select id from c);

select * from main.vs;                    -- [{id:1, x:10}]   the definition's own c wins, correctly
update main.vs set x = 42 where id = 1;   -- reports success
select * from main.a;                     -- [{id:1, x:10}]   NOT updated
delete from main.vs where id = 1;         -- reports success
select * from main.a;                     -- [{id:1, x:10}]   NOT deleted
```

Arm 2 is why the ticket's fallback option — reject the shape with a clear
diagnostic — is not sufficient on its own: a rejection would be an improvement
for arm 1 but the read/write disagreement in arm 2 is a wrong-data bug that only
carrying the definitions actually fixes. Carry them.

### Already rejected, correctly — leave alone

A definition whose **FROM source** is a definition-local block is a different
shape and already rejects cleanly:
`create view main.vf as with c as (select id, 1 as x from b) select id, x from c;`
→ `ViewMutationError: cannot write through view 'vf': view body operator 'CTEReference' is not updateable in phase 1`.
A definition-local block that no copied fragment references (`... with c as (…)
select id, x from a where x > 0`) already writes fine — the fix must keep both
behaviours.

## The fix

Extend the marker mechanism the sibling ticket introduced rather than adding a
second channel. Three moving parts, plus two guards.

**1. Carry the definitions on the marker.** A new write-through-lowering-only AST
field beside `storedHomeSchema`, never set by the parser, inert everywhere else:

```ts
// parser/ast.ts, in SelectStmt
/** The stored body's own WITH clause, carried with a copied fragment … */
storedBodyCTEs?: WithClause;
```

`buildViewMutation` stamps it alongside the home-schema marker, on the same
clone, in the same `mapNestedSelects` call:

```ts
selectAst: mapNestedSelects(viewIn.selectAst, sel => ({
    ...sel,
    storedHomeSchema: viewIn.schemaName,
    ...(viewIn.selectAst.type === 'select' && viewIn.selectAst.withClause
        ? { storedBodyCTEs: viewIn.selectAst.withClause }
        : {}),
})),
```

`rebuildSelect` clones a `withClause` without descending into it, so the
definitions themselves are never stamped — no self-referential stamp, and the
sub-selects inside a definition need no marker (they are built under the home
environment already, exactly as on the read path).

**2. Consume it where the marker is already consumed.** In `buildSelectStmt`,
the line that today resets the parent CTE namespace to empty instead hands in the
body's own definitions:

```ts
const storedParentCTEs = storedSwap
    ? buildStoredBodyCTEs(storedCtx, stmt.storedBodyCTEs)   // empty Map when undefined
    : parentCTEs;
```

Build them on `storedCtx` (the home environment), before the `stmt.schemaPath`
swap. `buildWithContext` then merges the fragment's own `with` clause on top, so
a fragment-local name still shadows a body-local one, and the caller's namespace
stays cleared. Nothing changes when the swap is inert (a sub-select nested inside
an already-swapped fragment inherits the definitions through `ctx.cteNodes`, as
it does today).

**3. Build the definitions once per lowering, not once per fragment.** Two
fragments referencing the same definition must share one plan node, or each gets
its own copy and the runtime evaluates the block twice. A small memo on the
planning context, created by the funnel:

```ts
// planning-context.ts
readonly storedBodyCTECache?: Map<AST.WithClause, Map<string, CTEScopeNode>>;

// view-mutation-builder.ts — rename the parameter to ctxIn (the viewIn/view idiom
// already in this function) so the ~31 existing `ctx` uses below are untouched
const ctx: PlanningContext = viewIn.ephemeral ? ctxIn : { ...ctxIn, storedBodyCTECache: new Map() };
```

`buildStoredBodyCTEs` looks the WITH clause object up in that memo, builds on a
miss, and returns a **copy** of the map (`buildWithContext` mutates what it is
handed). Sharing one `CTENode` across references is the shape the
materialization-advisory pass already understands — it marks a multi-referenced
CTE `materialize`, and `emitCTE` then buffers it once per statement execution
(`runtime/emit/cte.ts`). Keying on the WITH clause object rather than the name
keeps a hypothetical second lowering in the same statement separate.

**Guard A — a data-modifying definition-local block must be rejected.** A view
body may legally contain `with m as (insert into … returning …)`, and today
*reading* such a view executes the insert (verified: `select * from vm` added the
row). Once the definitions are carried, the write executes it too — and with the
shared plan node it hits a genuine internal failure:

```
TypeError: sourceIterable is not async iterable
```

(reproduced with a logging-insert block referenced from two fragments; the
same shape on a plain read query — `with c as (insert … returning k) select
(select count(*) from c), (select count(*) from c)` — instead runs the insert
*twice* and trips a UNIQUE violation, so the underlying multi-reference-DML-CTE
path is shaky independently of this change). Do not expose it. Reject at the
stamp site in `buildViewMutation` when any carried definition's query is not a
`select`/`values`, with a new structured reason code (suggested:
`unsupported-body-cte-dml`) — strictly better than today's
`Table 'm' not found`. Add the code to the `MutationDiagnosticReason` union and
to the diagnostics table in `docs/view-updateability.md`.

**Guard B — `view_info` must not advertise the rejected shape.** `deriveViewInfo`
derives updatability from the *planned body*, which plans fine, so it reports
`YES` for a data-modifying-block body that guard A rejects. Mirror the guard
there (the `isJoinBody && !isDecomposableJoinBody` gate at `schema.ts` ~844 is the
existing precedent) and return `CONSERVATIVE_VIEW_INFO`. Everything else in the
table above becomes genuinely writable, so `YES` is then honest for it.

## Prototype evidence

The three moving parts above were prototyped end-to-end on this tree (guards A
and B were not) and then reverted — the tree is clean; nothing from the prototype
is committed. Under it:

- every row of the failure table succeeds and writes the expected value,
  including the materialized view, the `with inverse` put, the `with defaults`
  insert and the recursive block;
- arm 2 updates and deletes the row (the definition's block wins over the
  same-named real table, matching the read);
- a definition-local block that references an earlier sibling block
  (`with c1 as (…), c2 as (select … from c1)`) resolves;
- the two already-correct shapes above still behave as before;
- `yarn test` (repo-wide): **8468 passing, 0 failing, 13 pending** — identical to
  the counts the sibling ticket's review recorded, i.e. no regression.

## Notes and interactions

- The *analysis* that decides whether a reference inside a sub-query is local or
  reaches outward (`tableSourceColumnNames` in `mutation/scope-transform.ts`,
  the subject of `fix/bug-view-write-subquery-shadow-analysis-wrong-schema`) does
  consult `ctx.cteNodes`, but it never sees a body fragment: the definition's own
  `where` and column expressions are threaded through `normalizeBaseRefs`, not
  through the scope-aware descent, which only walks the *user's* clauses. No
  conflict today. If that descent is ever pointed at body fragments, it will need
  the carried definitions too.
- `storedBodyContext` clears `cteReferenceCache`, so each fragment mints its own
  `CTEReferenceNode` over the shared `CTENode` — which is what keeps their
  attribute ids distinct. Do not "optimize" that clearing away.
- Non-deterministic definition-local blocks (a `random()`, a table-valued
  function) evaluate once per statement under the shared node, matching the read.
  Per-fragment building would have made them disagree between fragments.

## TODO

- Add `SelectStmt.storedBodyCTEs?: WithClause` in `parser/ast.ts`, documented as
  write-through lowering metadata like its `storedHomeSchema` neighbour.
- Add `PlanningContext.storedBodyCTECache` and create it in `buildViewMutation`
  (parameter → `ctxIn`, local `const ctx`), skipped for an ephemeral target.
- Stamp `storedBodyCTEs` in the existing `mapNestedSelects` call.
- Add `buildStoredBodyCTEs` to `building/select.ts` and use it for
  `storedParentCTEs`; keep the empty-Map behaviour when no clause is carried.
- Guard A: reject a data-modifying definition-local block at the stamp site with
  a new `MutationDiagnosticReason`; add the reason to the docs diagnostics table.
- Guard B: mirror that rejection in `deriveViewInfo` so `view_info` reports the
  conservative row for it.
- Tests in `test/view-cte-isolation.spec.ts` (the CTE-namespace home): one case
  per row of the failure table, the arm-2 shadowing case for both `update` and
  `delete`, the sibling-block chain, a two-fragment reference (assert one
  evaluation, not two), plus regression pins for the two already-correct shapes
  (block as FROM source still rejects; unreferenced block still writes).
- Tests for the guards: the data-modifying-block write raises the new diagnostic,
  and `view_info` reports `NO`/`NO`/`NO` for that view.
- Update `docs/view-updateability.md` § Schema resolution during write-through
  (lines 97-107): describe the carried definitions, and drop this ticket from the
  "two related defects … remain open" sentence, leaving
  `fix/bug-view-write-lineage-subquery-base-table-qualifier`.
- Run `yarn lint` and `yarn test` before handing off.
