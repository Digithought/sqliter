description: An insert statement that declares a temporary named result set up front, or that says which schema to look names up in, now applies that to the whole statement instead of only the rows being inserted; reviewed and validated.
files:
  - packages/quereus/src/planner/building/insert.ts                           # the fix — one hoisted buildWithContext, then threading
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic   # new in implement, extended in review
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic              # Tests 17a / 17b
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic               # view-target once-only cases
  - docs/sql-select.md                                                        # §2.1.1 and §3.7 prose
  - docs/sql-dml.md                                                           # `with clause` option bullets cross-reference §3.7
difficulty: medium
---

# INSERT derives ONE statement-level planning context

## What was wrong

`buildInsertStmt` was the only DML builder that never derived a single statement-level
planning context. It built its leading `with` clause by hand into a local map handed to
exactly one consumer — the `select` source branch — and built `returning`, `on conflict`
and `with context` against the bare incoming context. Consequences:

- A common table expression declared on the insert was invisible everywhere except a
  `select` source: `returning`, a scalar subquery inside a `values` row, a nested-DML
  source, and the view / materialized-view target dispatch all failed with
  `Table 'c' not found in schema path: main`.
- The statement's `with schema` search path did not reach a `returning` subquery either,
  for the same reason (`update` and `delete` already resolved it).
- The hand-rolled map started empty, and `buildWithContext` prefers a non-empty explicit
  argument over the context's inherited definitions — so an insert carrying its own
  `with` clause **replaced** rather than shadowed into whatever it had inherited from an
  enclosing statement.

## The fix

One `buildWithContext(contextWithSchemaPath, stmt)` call hoisted above the CTE-name-target
dispatch, mirroring `buildUpdateStmt`. The resulting context is threaded through every
**user-authored** clause: the CTE-target resolution, all three `buildViewMutation` calls,
`buildTableReference`, the `with context` assignment build, `buildValuesStmt`,
`buildSelectStmt` (its explicit `parentCTEs` argument dropped — definitions ride the
context instead, which is what keeps them from leaking past `storedBodyContext`'s clearing
on the stored-body write-through path), the three nested-DML source branches,
`buildUpsertClausePlans`, and the `returning` scope + projections.

Schema-authored builds stay off that context on purpose: `createRowExpansionProjection`
(column defaults, generated columns) on `contextWithSchemaPath`, and
`buildConstraintChecks` / `buildNotNullDefaults` / `buildChildSideFKChecks` on the bare
`ctx`. A `default (select count(*) from c)` written in a table's DDL therefore still binds
the real table `c`, not the inserting statement's CTE of that name.

Because `buildWithContext` seeds from `ctx.cteNodes` and merges `stmt.withClause` on top,
an insert's own `with` clause now shadows into rather than replaces its inherited
definitions — closing the second arm with no extra code.

## Review findings

Reviewed the implement diff (`260e77aa`) first, then the handoff. Ran the probes below
against a live `Database` rather than reasoning from the code alone.

### Checked and clean — no defect found

- **Leak risk from passing the CTE-aware context to `buildViewMutation`.** The obvious
  hazard is a caller CTE whose name collides with a base table read *inside* the view
  body — the write would silently land on the CTE instead of the real table. Probed
  directly (`create view vbase as select … from base`, then
  `with base as (select … from other) insert into vbase values (…)`): the row went to the
  real `base`, `other` untouched. The stored-body environment clears the caller's CTE
  namespace, and dropping the explicit `parentCTEs` argument is what keeps it cleared.
- **Ordering hazards from hoisting the `with` build above the target dispatch.** A
  recursive CTE target still raises the structured
  `cannot write through common table expression 'rc': a recursive CTE has no recoverable
  base operation`, not a build error from the hoisted clause; a CTE target whose body is
  non-updateable still rejects with its own body-shape reason.
- **`resolveCteTarget` / `flattenCteBody` behavior under the new context.** Neither reads
  `ctx.cteNodes` — the target match is against `stmt.withClause` AST — so passing the
  CTE-aware context there is inert, and matches what `buildUpdateStmt` already did.
- **`buildTableReference` under the new context.** Only `buildFrom` resolves names against
  `cteNodes`, and it takes that map as an explicit argument; the insert target cannot be
  hijacked by an inherited CTE name.
- **CTE bodies resolve on the statement's `with schema` path.** Verified with
  `with c as (select count(*) as n from lk) insert into tgt values (3, (select n from c))
  with schema myapp` against a `lk` that exists only in `myapp`.
- **Lint / tests / docs.** `yarn lint` clean. `yarn test` — 8649 passing in
  `packages/quereus`, every other workspace green, **zero** failing. `yarn docs:check` —
  only the two already-known ratchet failures (`docs/schema.md`, `docs/sync.md`, tracked
  as `debt-docs-size-ratchet-red-again` in `tickets/.pre-existing-known.md`); nothing my
  edits added is over budget.

### Found and fixed in this pass (minor)

- **Test gaps the handoff named as untested, now covered.** Added to
  `13.8-insert-with-clause-visibility.sqllogic`:
  - the `update`- and `delete`-bodied nested-DML source branches (only the `insert`-bodied
    one was pinned, though all three changed);
  - a **multi-source** (join-bodied) view target with a leading `with` clause — the
    `preBuiltSource` decomposition path, which re-enters this builder once per view member;
  - an insert nested in **FROM position** and in **expression position** with no `with`
    clause of its own, inheriting the enclosing statement's definitions purely through
    `ctx.cteNodes`. Both shapes only work because `returning` now builds on the CTE-aware
    context; neither was covered.
- **Once-only execution was pinned for the weaker case only.** `13.6-cte-dml-runs-once`
  pinned a data-modifying CTE feeding an insert through a *single-source* view (clause
  built twice). Added the multi-source case, where the clause is built once per view member
  on top of the outer build — the stronger guard. Verified: one log row, not one per member.
- **`docs/sql-dml.md` was stale.** The implement pass documented the new visibility rule in
  `docs/sql-select.md` §3.7, but the `insert` / `update` / `delete` syntax reference — where
  a reader looking up the `with clause` option actually lands — still said only "Common
  Table Expressions for use in the insert". All three bullets now state the visibility rule
  and link §3.7.

### Found, correctly deferred by the implementer — verified, not re-filed

- `on conflict` / `with context` **subqueries** resolve names now but still cannot execute
  (`DmlExecutorNode.getChildren()` does not expose those expressions, so the optimizer never
  rewrites them). Confirmed independent: the same statements fail identically with no `with`
  clause and no `with schema`. Filed as
  `fix/bug-dml-side-expressions-invisible-to-optimizer` with a verified repro; both test
  files pin the statements as expected errors naming that slug, so they fail loudly when it
  lands and must be converted to real assertions rather than deleted.
- Inherited CTE definitions still leak into **schema-authored** expressions (a column
  `default (select count(*) from c)` binding a caller's `c`). Pre-existing — the
  schema-authored builds take contexts derived from the bare incoming `ctx`, whose
  `cteNodes` this change does not touch — and explicitly out of scope for this ticket.
  Filed as `fix/bug-schema-defaults-bind-callers-cte`.

### Observations recorded, deliberately not filed

- **Cosmetic error-precedence shift.** With the `with` build hoisted above the target
  dispatch, `with c as (select * from nosuch) insert into alsonosuch values (1)` now reports
  the CTE body's missing table before the missing target. `buildUpdateStmt` has always
  behaved this way; no ticket.
- **Source size.** `insert.ts` measured 929 lines (`wc -l`), up from 905 — the change removed
  the hand-rolled map and added explanatory comments. It is the largest of the three DML
  builders (`update.ts` 478, `delete.ts` 365), but nothing in this diff caused that and no
  seam here suggests a split; no size ticket.

### Tripwire (unchanged from implement, re-confirmed)

`packages/quereus/src/planner/building/insert.ts` carries a `NOTE:` at the hoisted
`buildWithContext` call: on a view target the `with` clause is built once here and again
when `buildViewMutation` re-plans through this same builder (`buildWithClause` does not
memoize) — on a multi-source view, once per member. Wasted planning work, not a behavior
change; once-only *execution* of a DML-bodied definition is now pinned for both the
single-source and multi-source shapes. If view write-through planning cost ever shows up,
memoize per `(context, withClause)` rather than re-ordering the dispatch.

### Not covered, and why

- **A lens-routed view target with a leading `with` clause.** It reaches the same
  `buildViewMutation(contextWithCTEs, …)` call site as the single-source and multi-source
  view cases, both of which are now pinned end-to-end; a lens fixture adds setup cost over
  zero additional code path.
- **`yarn test:store`.** Not run. The change is planner-only with no storage-module surface,
  and per `AGENTS.md` the store leg is for store-specific diagnosis or release prep.
- **No planner-level (`test/plan/`) assertion** that the definitions ride the context rather
  than an explicit argument. Coverage is behavioral `.sqllogic` throughout. The structural
  property is indirectly pinned by the stored-body write-through cases, which are exactly
  what the explicit argument used to break.
