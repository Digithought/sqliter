---
description: A query that joins two sources could bind one source's column to a same-named column from the surrounding query instead — crashing the query or silently returning wrong rows. Name lookup now checks a join's own sources first.
files:
  - packages/quereus/src/planner/building/select.ts                             # registerColumnScope (~340), subquerySource branch (~613)
  - packages/quereus/src/planner/building/select-context.ts                     # createCTEScope deleted
  - packages/quereus/src/planner/scopes/aliased.ts                              # NOTE tripwire on the 3-part branch
  - packages/quereus/test/logic/13.5-cte-join-order.sqllogic                    # new
  - packages/quereus/test/logic/07.7.7-join-source-scope-shadowing.sqllogic     # new
  - docs/runtime.md                                                            # § Common pitfalls checklist → "Scope resolution"
difficulty: medium
---

# Join sources win name lookup over the enclosing query

## What changed and why

Every `from` source gets a lookup table ("scope") mapping its column names to plan
attribute ids. A join combines its left and right source scopes with `MultiScope`,
which tries them in order and takes the first match.

Each source scope used to be built with the *enclosing query's* scope as its fallback
parent. So when `MultiScope` asked the **left** source about a name it did not own, the
left source did not answer "no" — it forwarded the question outward and returned
whatever the enclosing query had. The right source was never consulted.

Three edits:

**1. Source scopes are own-only.** `registerColumnScope` and the `subquerySource`
branch of `buildFrom` now parent their `RegisteredScope` on `EmptyScope.instance`. The
enclosing-query fallback already exists exactly once at the right place —
`buildSelectStmt`'s `ShadowScope([...sourceScopes, outerScope])`, and `buildJoin`'s
LATERAL `ShadowScope([leftOutputScope, outerScope])`. `registerColumnScope` lost its
now-unused `parentScope` parameter (six call sites updated).

**2. `createCTEScope` deleted.** It registered `cteName.column` → the CTE **body's**
attribute id into the enclosing scope. No `CTEReferenceNode` ever publishes those ids
(each reference mints fresh ones), so anything resolving through them could only fail at
runtime. That registration was the thing edit 1 stopped reaching in the join case; with
it gone, `buildWithContext` only threads `cteNodes` / `cteReferenceCache` through the
context and no longer overrides `ctx.scope`. A `cteName.column` symbol is published
solely by `buildFrom`'s CTE branch, against the ids that reference republishes.

The ticket said to verify the deletion *combined* with edit 1 before keeping it — done:
full suite green with both applied (see Validation).

**3. A `NOTE:` tripwire in `AliasedScope`** (see Review notes below).

## Symptoms fixed

**Crash — a `with` clause joined second:**

```sql
with c as (select cat, qty, rid from o)
select count(*) from r join c on c.rid = r.id;
-- was: QuereusError: No row context found for column rid.
```

`from c join r on …` worked only because there the CTE reference is the left peer and
answers first.

**Silently wrong rows — an inner alias shadowing an outer one (no CTE involved):**

```sql
select x.id, (select count(*) from t2 join t1 as x on x.id = t2.id) as n
from t1 as x order by x.id;
-- was: n = 3, 3, 0   (inner `x.id` bound to the OUTER `x`, correlating an
--                     uncorrelated subquery)
-- now: n = 2, 2, 2
```

## Validation / what to exercise

`yarn workspace @quereus/quereus run test` → **8148 passing, 13 pending, 0 failing**
(8146 before; the two new logic files add one test each). `yarn test` across all
workspaces → clean. `yarn lint` → clean.

New regression files:

- `packages/quereus/test/logic/13.5-cte-join-order.sqllogic` — both join orders of the
  reported query (count *and* projected rows, so wrong-rows regressions are caught, not
  just crashes); operand-swapped condition; non-key join column; `left join` with the
  CTE second; three-way join with the CTE in the middle (`(r join c) join s`, so the
  outer join's left peer is itself a `MultiScope`); the aliased spelling `join c as x`
  which passed pre-fix, pinned; and `with c as (…) select c.cat from r` now giving
  `c.cat isn't a column` instead of a runtime row-context failure.
- `packages/quereus/test/logic/07.7.7-join-source-scope-shadowing.sqllogic` — the
  outer-alias-shadowing symptom, with the inner left peer both a plain table and an
  inline subquery source, plus the inline subquery on the right; a genuinely correlated
  subquery over the same shape (the enclosing fallback must still work, just later); and
  a LATERAL case (right peer must still see the left peer's columns).

Manual A/B checks run beyond the suite:

- The two `ctx.outputScopes` consumers in `planner/mutation/` (`multi-source.ts:1125`
  view write-through, `backward-body.ts:234`) resolve alias-qualified base columns
  through the *join's* combined scope, which own-only peers serve correctly. Covered by
  the passing `08*-view*`, `53*-materialized-view*`, `93.x-view-mutation*` and
  `01.7-update-from` logic files.
- Three-part `schema.alias.column` references: `select main.t.id from t` errors with
  `main.t.id isn't a column` both **before and after** the change (verified by
  temporarily reverting the edits and re-running the same probe). Not a regression.

## Known gaps for the reviewer

- **No plan-shape assertions.** All new coverage is row-level `.sqllogic`. Nothing pins
  *which* attribute id a join condition's column reference carries, so a future scope
  change that lands on a different-but-also-correct id would not be noticed, and the
  original diagnosis technique (dumping attribute ids from the built plan) is not
  captured as a test. A `test/plan/` case asserting the join condition resolves to the
  `CTEReferenceNode`'s republished ids would be stronger.
- **`createCTEScope`'s deletion is validated only by the suite passing.** I did not
  enumerate every shape that could have depended on a `cteName.column` symbol existing
  outside a `from`-referenced CTE — e.g. a CTE named in an `update`/`delete` `where`
  subquery, or a CTE column referenced from a `returning` clause. The suite covers CTEs
  in DML (`13.x`, `01.9-query-expr-dml`), but I did not hand-audit for uncovered shapes.
- **`MultiScope` ambiguity semantics unchanged.** With peers now able to answer "no",
  an unqualified name present in both peers still reports ambiguous, and a name in
  neither now falls to the enclosing scope one level later than before. I did not
  construct an adversarial case where that ordering change alters an *ambiguity* verdict
  (as opposed to a binding).
- **Store backend not exercised.** Only `yarn test` (memory vtab) was run;
  `yarn test:store` was not. The change is planner-only, so store divergence is
  unlikely, but it is unverified.

## Review notes / tripwire parked

- `packages/quereus/src/planner/scopes/aliased.ts` — `NOTE:` added on the three-part
  (`schema.alias.column`) branch. It rewrites to `main.<parentName>.column` and asks the
  source's `RegisteredScope`, which only holds **bare** column names, so the lookup
  always misses. That was already true; before this change the miss leaked to the
  enclosing scope, now it ends the search. Three-part column references are unsupported
  either way today. The note says what to do (strip to the bare column name, like the
  two-part branch) *if* they are ever supported.
