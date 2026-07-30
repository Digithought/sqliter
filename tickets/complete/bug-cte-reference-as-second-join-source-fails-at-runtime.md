---
description: A query joining two sources could bind one source's column to a same-named column from the surrounding query instead — crashing the query or silently returning wrong rows. Name lookup now checks a join's own sources first, then falls back outward.
files:
  - packages/quereus/src/planner/building/select.ts                             # registerColumnScope (~349), buildJoin ON-condition context (~687), NOTE at ~101
  - packages/quereus/src/planner/building/select-context.ts                     # createCTEScope deleted
  - packages/quereus/src/planner/scopes/aliased.ts                              # NOTE tripwire on the 3-part branch
  - packages/quereus/test/logic/13.5-cte-join-order.sqllogic
  - packages/quereus/test/logic/07.7.7-join-source-scope-shadowing.sqllogic
  - docs/runtime.md                                                             # § Common pitfalls checklist → "Scope resolution"
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

Four edits:

**1. Source scopes are own-only.** `registerColumnScope` and the `subquerySource`
branch of `buildFrom` parent their `RegisteredScope` on `EmptyScope.instance`.
`registerColumnScope` lost its now-unused `parentScope` parameter (six call sites
updated).

**2. Every consumer composes the enclosing-query fallback itself.** Own-only peers mean
the fallback has to exist once per consumer, *after* the peers:

| consumer | scope built |
|---|---|
| `buildSelectStmt` | `ShadowScope([...sourceScopes, outerScope])` (pre-existing) |
| `buildJoin` ON condition | `ShadowScope([MultiScope([left, right]), outerScope])` (**added in review**) |
| `buildJoin` LATERAL right side | `ShadowScope([leftOutputScope, outerScope])` (pre-existing) |

What each consumer *publishes* into `ctx.outputScopes` stays own-only, because its own
consumer may be another join that has to consult a sibling peer first.

**3. `createCTEScope` deleted.** It registered `cteName.column` → the CTE **body's**
attribute id into the enclosing scope. No `CTEReferenceNode` ever publishes those ids
(each reference mints fresh ones), so anything resolving through them could only fail at
runtime. `buildWithContext` now only threads `cteNodes` / `cteReferenceCache` through the
context. A `cteName.column` symbol is published solely by `buildFrom`'s CTE branch,
against the ids that reference republishes.

**4. Two `NOTE:` tripwires** — see Review findings.

## Symptoms fixed

**Crash — a `with` clause joined second:**

```sql
with c as (select cat, qty, rid from o)
select count(*) from r join c on c.rid = r.id;
-- was: QuereusError: No row context found for column rid.
```

`from c join r on …` worked only because there the CTE reference is the left peer.

**Silently wrong rows — an inner alias shadowing an outer one (no CTE involved):**

```sql
select x.id, (select count(*) from t2 join t1 as x on x.id = t2.id) as n
from t1 as x order by x.id;
-- was: n = 3, 3, 0   (inner `x.id` bound to the OUTER `x`)
-- now: n = 2, 2, 2
```

**Spurious ambiguity — an unqualified outer column named in an `on` clause:**

```sql
select o.id, (select count(*) from t2 join t1 as x on x.id = t2.id and x.v = ov) as n
from (select id, v as ov from t1) as o;
-- was: "ambiguous column name: ov" — both peers forwarded outward and
--       answered with the SAME outer symbol, which MultiScope read as two hits
```

## Validation

`yarn lint` clean. `yarn test` (all workspaces) — **8148 passing, 13 pending, 0 failing**
in `@quereus/quereus`, every other workspace green. `yarn test:store` not run (see below).

## Review findings

### Checked

Read the implement diff before the handoff. Walked every scope class
(`RegisteredScope`, `AliasedScope`, `MultiScope`, `ShadowScope`, `EmptyScope`),
every `registerColumnScope` call site, every `ctx.outputScopes` producer and consumer
(including the two in `planner/mutation/`), and every `buildFrom` / `buildWithContext`
caller. Probed each behaviour change against a temporarily-restored pre-commit
`select.ts` to separate regression from pre-existing.

### Major — fixed in this pass

- **`on` conditions could no longer reach the enclosing query at all.**
  `buildJoin` built the ON condition against the bare `MultiScope` of its two peers.
  That was survivable while each peer chained outward; with own-only peers it left the
  ON clause with *no* fallback, so a correlated outer column
  (`… on u.id = q.id and q.id = p.id` inside a subquery) failed with
  `p.id isn't a column`, and a bind parameter in an ON clause failed with
  `:lim isn't a parameter`. Both A/B-confirmed as working before the implement commit
  and broken after. Fixed by building the ON condition against
  `ShadowScope([combinedScope, parentContext.scope])` — peers first, enclosing query
  second. The whole 8148-test suite passed with this broken, which is the more useful
  finding: **no test anywhere named a bind parameter or a correlated outer column in an
  `on` clause.** Coverage added, below.

### Minor — fixed in this pass

- `buildWithContext`'s two branches had become byte-identical after `createCTEScope`
  was removed, and both respelled `cteReferenceCache` that `...ctx` already carried.
  Collapsed to one `cteNodes.size > 0 ? {...ctx, cteNodes} : ctx`.
- `registerColumnScope`'s doc comment and the `docs/runtime.md` invariant both listed
  the consumers that compose the outer fallback, and both were now missing the
  ON-condition one. Updated, plus a sentence stating that what goes into
  `ctx.outputScopes` stays own-only.

### Test coverage added

The implementer's two files covered the reported symptoms well but only ever asserted
that the join's peers *win*; nothing asserted that anything else still resolves.

`07.7.7-join-source-scope-shadowing.sqllogic` — new section: qualified correlated outer
column in an ON clause; unqualified correlated outer column in an ON clause (the
spurious-ambiguity case above); a bind parameter in an ON clause, paired with a second
`?` in the `where` so positional ordering is pinned too; a scalar subquery inside an ON
clause correlated to the join's own left peer; a three-way join whose outer ON reaches
past a peer that is itself a join; and a genuine peer-vs-peer ambiguity inside an ON
clause, to pin that the new fallback sits *behind* `MultiScope` and cannot mask an
`Ambiguous` verdict.

`13.5-cte-join-order.sqllogic` — new section covering exactly the gap the handoff
flagged as unaudited for the `createCTEScope` deletion: a `cteName.column` read from a
nested subquery with the CTE in the outer `from`; a CTE in an `update` `where`
subquery; a CTE in an `update` `set` subquery correlated to the target; a CTE in a
`delete` `where` subquery with `returning`; and a CTE read from an `update`'s
`returning` clause. All pass — the deletion is now hand-audited, not just
suite-validated.

### Major — filed as a new ticket

- `backlog/bug-insert-with-clause-not-visible-in-returning` — found while auditing the
  `createCTEScope` deletion. A leading `with` clause on an `insert` reaches the insert's
  *source* but not its `returning` clause, so
  `with c as (…) insert into q values (…) returning (select count(*) from c)` fails with
  `Table 'c' not found`. `update` / `delete` do not have this gap. Confirmed present
  before this ticket's changes and caused by table-name threading in
  `buildInsertStmt`, not by column-scope resolution — unrelated to this diff.

### Tripwires parked

- `packages/quereus/src/planner/scopes/aliased.ts` (kept from implement) — `NOTE:` on
  the three-part `schema.alias.column` branch: it rewrites to
  `main.<parentName>.column` and asks a scope holding only bare column names, so the
  lookup always misses. Three-part column references are unsupported today either way
  (verified identical before and after); the note says what to change *if* they are ever
  supported.
- `packages/quereus/src/planner/building/select.ts` (~101, added in review) — `NOTE:` on
  the `ctx.outputScopes.get(ft) || ft.scope` fallback in `buildSelectStmt`. It fires only
  for the FROM-less `SingleRowNode`, which `buildFrom` never registers. If it ever starts
  firing for a real source, `ft.scope` is that node's enclosing chain and would silently
  reinstate exactly the chaining this ticket removed.

### Not done, deliberately

- **`yarn test:store` not run.** The change is planner-only — it never touches a vtab
  module, cursor, or key encoding — and the store leg runs the identical `.sqllogic`
  corpus through the same planner. Full store run costs enough wall-clock to be
  unreliable inside a ticket; left for CI.
- **No plan-shape (`test/plan/`) assertions.** Carried over from the handoff's own gap
  list and accepted rather than filed: a wrong attribute id manifests either as a runtime
  "No row context found" or as wrong rows, and both classes now have row-level coverage
  on both join orders. A `test/plan/` case pinning *which* id a join condition carries
  would additionally catch a change that lands on a different-but-also-correct id — real,
  but low value against the cost of a plan snapshot that churns on unrelated planner work.
