---
description: When a query joins two sources, a column belonging to the second source can silently bind to a same-named column from the enclosing query instead — which either crashes the query or, worse, returns wrong rows. Fix the name-lookup order so a join's own sources always win.
files:
  - packages/quereus/src/planner/building/select.ts          # registerColumnScope (~line 340), buildJoin (~line 645), subquerySource branch (~line 609)
  - packages/quereus/src/planner/scopes/multi.ts             # MultiScope — first-match over peer scopes
  - packages/quereus/src/planner/scopes/registered.ts        # RegisteredScope — delegates to parent when a symbol is missing
  - packages/quereus/src/planner/scopes/empty.ts             # EmptyScope.instance — terminal scope, the fix's new parent
  - packages/quereus/src/planner/building/select-context.ts  # createCTEScope — registers `cte.col` against the CTE body's attribute ids
  - packages/quereus/test/logic/                             # .sqllogic regression cases belong here
  - docs/runtime.md                                          # § Common pitfalls checklist → "Scope resolution" bullet
difficulty: medium
---

# Join sources must win name lookup over the enclosing query

## What goes wrong

Every `from` source gets a small lookup table ("scope") mapping its column names to
the plan's internal column identifiers ("attribute ids"). A join combines its left and
right source scopes with `MultiScope`, which tries them **in order** and takes the first
match.

The defect: each source scope is built with the *enclosing query's* scope as its fallback
parent (`registerColumnScope`, `packages/quereus/src/planner/building/select.ts:340`).
So when `MultiScope` asks the **left** source about a name it does not own, the left
source does not answer "no" — it forwards the question up to the enclosing query and
returns whatever *that* has. The right source is never consulted.

Any name that exists both in the enclosing scope and in a join's right-hand source
therefore binds to the wrong one. Two independently reproducible symptoms:

**1. The reported bug — a `with` clause joined second.**

`buildWithContext` → `createCTEScope`
(`packages/quereus/src/planner/building/select-context.ts:53`) registers a qualified
symbol `c.rid` for every `with` clause column, bound to the **CTE body's** attribute ids.
That registration lives in the enclosing scope. So:

```sql
with c as (select cat, qty, rid from o)
select count(*) from r join c on c.rid = r.id;
```

`c.rid` is asked of `r`'s scope first → miss → forwarded to the enclosing scope → returns
the CTE *body's* attribute id, not the id the `CTEReferenceNode` republishes. Nothing in
the plan under that point publishes the body's id, so the query dies at runtime with:

```
QuereusError: No row context found for column rid. The column reference must be
evaluated within the context of its source relation.
```

Confirmed by dumping attribute ids from the built plan: the join condition's column
reference carries attribute id 14 (the CTE body's `rid`) while the `CTEReferenceNode`
above it publishes 18/19/20. `from c join r on …` works only because there the CTE
reference *is* the left peer, so its own scope answers first.

This also explains every row of the symptom table in the original ticket: aliasing the
reference (`join c as x on x.rid = …`) works, because the enclosing scope registers
`c.rid`, not `x.rid`; and `on r.id = r.id` works because no `c.` name is looked up.

**2. Silently wrong results — an alias shadowing an outer alias.** Same root cause, no
`with` clause involved, and *no error* — it just returns wrong rows:

```sql
create table t1 (id integer primary key, v integer) using memory;  -- rows (1,10),(2,20),(3,30)
create table t2 (id integer primary key, v integer) using memory;  -- rows (1,100),(2,200)

select x.id, (select count(*) from t2 join t1 as x on x.id = t2.id) as n
from t1 as x order by x.id;
```

The inner `x` must shadow the outer `x`, so `n` is 2 for every row. Today it returns
`n` = 3, 3, 0 — the inner `x.id` binds to the **outer** `x`, turning an uncorrelated
subquery into a correlated one. Reproduced on a clean tree at `4bfa8b94`.

The same leak exists on the inline-subquery FROM path, which builds its scope separately
(`select.ts:609`, `new RegisteredScope(parentContext.scope)`); swap the inner join's left
peer for `(select id from t2) s` and the identical wrong answer appears.

## The fix

Source scopes should hold **only their own columns** and answer "no" for anything else.
The fallback to the enclosing query already exists exactly once, at the right place —
`buildSelectStmt` builds `new ShadowScope([...columnScopes, contextWithCTEs.scope])`
(`select.ts:101`), and `buildJoin`'s LATERAL path likewise composes
`ShadowScope([leftOutputScope, parentContext.scope])` explicitly. The per-source parent
chaining is redundant there and harmful inside `MultiScope`.

So: build both `registerColumnScope`'s `RegisteredScope` and the `subquerySource`
branch's `subqueryScope` over `EmptyScope.instance` instead of the caller's scope. With
that, `MultiScope` falls through the left peer to the right peer as intended, and the
enclosing scope is consulted only after both.

`buildFrom` has exactly three call sites — `select.ts:89`, and the two peer builds in
`buildJoin` (`select.ts:649`/`660`) — so those are the only consumers whose fallback
behaviour changes. The mutation-side readers of `ctx.outputScopes`
(`planner/mutation/multi-source.ts:1125`, `planner/mutation/backward-body.ts:234`) use
the captured scope to resolve *alias-qualified base columns*, which own-only scopes serve
correctly; verify, don't assume.

Validated locally: with both edits applied, all four symptom shapes from the original
ticket return correct rows, symptom 2 returns 2/2/2, and the full
`yarn workspace @quereus/quereus run test` suite is green (8146 passing, 13 pending).

## Secondary: the stale `with`-clause registrations in `createCTEScope`

`createCTEScope` registers `cteName.column` → the CTE **body's** attribute id. Those ids
are never published by a `CTEReferenceNode` (which mints fresh ids per reference), so a
reference that resolves through them can only fail at runtime. The scope fix makes them
unreachable in the join shape above, but they remain a landmine: an invalid query that
names a `with` clause column without the CTE in `from` —

```sql
with c as (select id from t2) select c.id from t1;
```

— reports the confusing `No row context found for column id` instead of the normal
`c.id isn't a column`.

Deleting the registration loop was verified green against the full suite on its own
(before the scope fix). It has not been verified *combined* with the scope fix — do that
before keeping it. If something does turn out to depend on it, leave it in place and add
a `NOTE:` comment at the site recording the stale-id hazard instead.

## Regression coverage

New `.sqllogic` file under `packages/quereus/test/logic/` — `13.5-cte-join-order.sqllogic`
fits the existing `13.x` CTE numbering. Cover, with real row data so a wrong-rows
regression is caught and not just a crash:

- both join orders of the reported query returning identical counts
- the operand-swapped condition (`on r.id = c.rid`)
- a non-key join column (`on c.qty = r.qty`)
- `left join` with the `with` clause second
- a three-way join with the `with` clause in the middle
- the aliased spelling (`join c as x on x.rid = …`), which passes today — pin it

Plus a case for symptom 2, which is a scope bug rather than a CTE bug — either in the
same file or alongside `test/logic/07.7.6-correlated-predicate-scope.sqllogic`:

- inner join's right peer aliased the same as an outer source, asserting the *inner*
  binding wins (expected `n` = 2 for all three rows in the example above)
- the same with the inner left peer an inline subquery source

## TODO

- Change `registerColumnScope` (`select.ts:340`) to parent its `RegisteredScope` on
  `EmptyScope.instance`; drop the now-unused `parentScope` parameter and update its six
  call sites (`select.ts` lines ~392, ~414, ~507, ~544, ~556, ~569).
- Change the `subquerySource` branch's `subqueryScope` (`select.ts:609`) the same way.
- Re-check the two `ctx.outputScopes` consumers in `planner/mutation/` still resolve
  alias-qualified base columns correctly (view write-through / `update … from` paths).
- Add `packages/quereus/test/logic/13.5-cte-join-order.sqllogic` with the cases above.
- Add the outer-alias-shadowing cases (symptom 2) to the scope-focused logic tests.
- Try deleting the `columnTypes.forEach` registration loop in `createCTEScope`
  (`select-context.ts:69-77`); if the suite stays green with the scope fix applied,
  remove it and simplify `createCTEScope` accordingly. If not, keep it and add a `NOTE:`
  at the site about the stale attribute ids.
- Extend the "Scope resolution" bullet in `docs/runtime.md` § Common pitfalls checklist
  with the invariant this establishes: a FROM source's scope holds only its own columns;
  the enclosing-query fallback is composed once by the consumer (`ShadowScope`), never by
  chaining each source scope to its parent — otherwise `MultiScope`'s first-match reaches
  the outer scope through peer #1 before peer #2 is consulted.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`.
