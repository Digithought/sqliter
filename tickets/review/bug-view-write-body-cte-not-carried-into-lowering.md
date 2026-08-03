---
description: A view whose definition uses a named sub-query block (a "with" clause) can now be updated and deleted through — before, such a write either failed with a confusing "table not found" error or silently changed nothing.
files:
  - packages/quereus/src/parser/ast.ts                                # SelectStmt.storedBodyCTEs — the new lowering-only field
  - packages/quereus/src/planner/planning-context.ts                  # PlanningContext.storedBodyCTECache — the per-lowering memo
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # buildViewMutation (ctxIn/ctx, the stamp) + rejectDataModifyingBodyCTE
  - packages/quereus/src/planner/building/select-context.ts           # buildStoredBodyCTEs — builds + memoizes the carried definitions
  - packages/quereus/src/planner/building/select.ts                   # buildSelectStmt (~98-115) — consumes the marker
  - packages/quereus/src/planner/mutation/scope-transform.ts          # mapNestedSelects doc note updated (no code change)
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts      # new reason code `unsupported-body-cte-dml`
  - packages/quereus/src/func/builtins/schema.ts                      # hasDataModifyingBodyCte + the deriveViewInfo gate
  - packages/quereus/test/view-cte-isolation.spec.ts                  # 16 new cases (second describe block)
  - docs/view-updateability.md                                        # § Schema resolution during write-through, § Diagnostics
difficulty: medium
---

# Review: a stored view body now carries its own `with` clause into write-through lowering

## What the change does

Writing through a view is **lowered** into a plain INSERT / UPDATE / DELETE against the
base table, and pieces of the view definition are copied into that lowered statement (the
definition's own `where`, each view column's defining expression, an authored
`with inverse` put expression, a `with defaults` value). A prior ticket made each copied
piece re-enter the view's own naming environment, which clears the *caller's* named-block
namespace. This change supplies the other half: the definition's **own** named blocks now
travel with the copied piece, so a sub-select inside one can bind them.

Mechanically:

- `AST.SelectStmt.storedBodyCTEs` — a new lowering-only field, the sibling of the existing
  `storedHomeSchema` marker. Never set by the parser; inert everywhere else.
- `buildViewMutation` stamps it on the same clones, in the same `mapNestedSelects` call.
- `buildSelectStmt` hands those definitions in as the copied fragment's parent namespace
  (`buildStoredBodyCTEs`), instead of the empty map it used before. The fragment's own
  `with` clause still merges on top and shadows a same-named definition block.
- `PlanningContext.storedBodyCTECache` — a memo created once per lowering, keyed on the
  `with` clause AST object, so all fragments of one lowering share **one** plan node per
  block. The multi-reference advisory then marks it `materialize`, so the block evaluates
  once per statement (matching the read).
- Two guards: a write through a view whose definition contains a **data-modifying** block
  is rejected with a new structured reason `unsupported-body-cte-dml`, and `view_info()`
  reports the conservative all-`NO` row for that same shape so the advertised writability
  agrees with the dynamic truth.

## What to exercise

Every row below is covered by a test in `test/view-cte-isolation.spec.ts` (second
`describe`), but they are the shapes worth poking at by hand.

Shared setup:

```sql
create table main.a (id integer primary key, x integer);
create table main.b (id integer primary key);
insert into main.a values (1, 10);
insert into main.b values (1);
```

**The channels that copy a fragment** — each used to raise
`QuereusError: Table 'c' not found in schema path: main`:

| shape | statement |
| --- | --- |
| definition `where` | `create view main.vc as with c as (select id from b) select id, x from a where id in (select id from c);` → `update main.vc set x = 99 where id = 1` / `delete from main.vc where id = 1` |
| a view column's defining expression | `create view main.vn as with c as (select id from b) select id, x, (select count(*) from c) as n from a;` → `update main.vn set x = 55 where n = 1` |
| an authored `with inverse` put | `create view main.vi as with c as (select 5 as k from b) select id, x + (select max(k) from c) as y with inverse (x = new.y - (select max(k) from c)) from a;` → `update main.vi set y = 20 where id = 1` (x → 15) |
| a `with defaults` value (INSERT) | `create view main.vdf as with c as (select 7 as k from b) select id, x from a with defaults (x = (select max(k) from c));` → `insert into main.vdf (id) values (3)` (row 3 gets x = 7) |
| a materialized view | `create materialized view main.mv as with c as (select id from b) select id, x from a where id in (select id from c);` → `update main.mv set x = 88 where id = 1` |
| a recursive block | `create view main.vr as with recursive r(n) as (select 1 union all select n+1 from r where n < 3) select id, x from a where id in (select n from r);` → `update main.vr set x = 33 where id = 1` |
| a block referencing an earlier sibling block | `with c1 as (select id from b), c2 as (select id from c1) …` |

**The silent-no-op arm — the severe one.** With a *real* table also named `c`, the old
lowering bound that table instead, so the write reported success and changed nothing while
the read of the same view returned the row:

```sql
create table main.c (id integer primary key);
insert into main.c values (2);                          -- a DIFFERENT id
create view main.vs as with c as (select id from b) select id, x from a where id in (select id from c);

select * from main.vs;                    -- [{id:1, x:10}]  — the definition's block wins
update main.vs set x = 42 where id = 1;   -- must now actually update
delete from main.vs where id = 1;         -- must now actually delete
```

**Sharing.** Two fragments referencing one block must produce one plan node, so the block
runs once. The test registers a non-deterministic scalar function `bump()` in the block and
asserts exactly one call for a write whose lowering copies two fragments that both read it.
Verified discriminating: with the memo lookup disabled the same test observes 2 calls.

**Regression pins that must keep their old behaviour:**

- a definition whose FROM *source* is a block (`… with c as (…) select id, x from c`) still
  rejects with `view body operator 'CTEReference' is not updateable in phase 1`;
- a definition whose block no fragment references still writes fine.

**The guards:**

```sql
create table main.logt (k integer primary key);
create view main.vm as with m as (insert into logt (k) values (1) returning k)
  select id, x from a where id in (select k from m);

update main.vm set x = 1 where id = 1;
-- ViewMutationError: cannot write through view 'vm': its body's WITH clause defines 'm'
--   as a data-modifying statement (insert), … reason `unsupported-body-cte-dml`

select is_insertable_into, is_updatable, is_deletable from view_info() where name = 'vm';
-- NO | NO | NO
```

## Validation run

- `yarn lint` — clean (the eslint + test-file `tsc` pass in `packages/quereus`; every other
  package is the intentional no-op).
- `yarn test` (repo-wide) — **8484 passing, 0 failing, 13 pending** in the `packages/quereus`
  suite. Baseline recorded on the implement ticket was 8468 passing / 13 pending, and this
  change adds exactly 16 cases, so nothing regressed. No other workspace suite failed.
- `tsc --noEmit` on `packages/quereus` — clean.

## Known gaps and judgement calls — please push on these

- **The data-modifying-block guard is unconditional on body shape, not on whether a copied
  fragment actually references the block.** So a view whose definition contains
  `with m as (insert … returning …)` that no fragment reads *used to* write fine and now
  rejects. That is a deliberate narrowing (the ticket specified it, `view_info` mirrors it,
  and the shape is pathological), but it is a real behaviour change and no test pins the
  old permissive case — worth a second opinion on whether to narrow the guard to
  referenced-only.
- **The underlying reason for that guard is a separate, reachable defect I verified and
  filed:** `fix/bug-dml-cte-executes-once-per-reference`. A plain read query —
  `with c as (insert into t (k) values (1) returning k) select (select count(*) from c), (select count(*) from c)`
  — runs the insert twice and trips `UNIQUE constraint failed`. No view involved. It does
  not resolve at this ticket's code site, hence the separate ticket rather than an arm here.
- **`buildStoredBodyCTEs` landed in `building/select-context.ts`, not `building/select.ts`
  as the implement ticket specified.** It sits next to `buildWithContext`, the only other
  function that builds a CTE-definition map, and `select-context.ts` already imports
  `buildWithClause` — putting it in `select.ts` would have added a fresh `select → with`
  import cycle edge for no gain. Pure placement call; behaviour is identical.
- **The memo degrades silently rather than failing when absent.** `buildStoredBodyCTEs`
  uses `ctx.storedBodyCTECache?.…`, so a future caller that reaches it without a memo builds
  per-fragment (correct results, duplicated evaluation) instead of erroring. Today the only
  producer is `buildViewMutation`, which always creates one for a non-ephemeral target.
- **`storedBodyOf` keying is unchanged and still schema-name-based**, so the pre-existing
  note in `building/select.ts` about view-over-view write-through still applies verbatim —
  this change inherits that limitation, it does not widen it.
- **Not covered by tests:** a body-local block inside a *set-operation* view body's branch
  (the per-branch synthetic view-likes inherit the stamp, so it should work, but no case
  pins it), and a body-local block in a *lens* / decomposition-backed body. Both flow through
  the same single funnel, so I expect them to work; neither was exercised.
- **No performance measurement was taken.** The memo is a `Map` created once per view-write
  plan build (plans are cached), and the stamp reuses the existing `mapNestedSelects` walk,
  so no new tree walk was added — but that is reasoning, not a benchmark.

## Tripwires parked in code

None new. The pre-existing `NOTE:` in `buildViewMutation` about deep-cloning the whole body
AST per plan build is unchanged and still accurate — the carry rides the same clone.
