---
description: A block that inserts, updates or deletes rows is now only allowed at the very start of a statement; putting one inside a sub-query or a saved view is rejected with a clear message instead of silently doing nothing (or silently running again on every read).
files:
  - packages/quereus/src/planner/planning-context.ts                  # optional field `topLevelWithClauses`
  - packages/quereus/src/planner/building/block.ts                    # buildBlock marks the set; collectTopLevelWithClauses; leadingClauses; accepted-tradeoff NOTEs
  - packages/quereus/src/planner/building/with.ts                     # buildWithClause gate + rejectNestedDataModifyingCte
  - packages/quereus/test/logic/13.12-nested-dml-cte-rejected.sqllogic # the whole behaviour
  - packages/quereus/test/view-cte-isolation.spec.ts                  # definition-time rejection + read-time rejection for an older-catalog definition
  - docs/sql-select.md            # § 3.7 — "Where a data-modifying CTE may appear"
  - docs/runtime-caching.md       # § Shared CTE materialization — gap list went 2 → 1
  - docs/view-updateability.md    # the body-CTE-DML guard is now a backstop
---

# Reject a data-modifying `with` member outside a statement's own leading clause

## What shipped

A `with` member whose body is an `insert` / `update` / `delete … returning` is accepted
**only** in a statement's own leading `with` clause. Everywhere else it is a build-time
error, replacing three prior behaviours (silently dropped, written once per statement,
re-written on every read of a view) with one rejection, matching PostgreSQL.

Three build-phase changes:

1. **`PlanningContext.topLevelWithClauses`** — optional `ReadonlySet<AST.WithClause>`.
   Absent ⇒ nothing is top-level ⇒ conservative rejection. Propagates to every derived
   context through the usual object spread.
2. **`buildBlock`** collects the leading `with` clause of each statement it is handed into
   that set, keyed on the **clause AST object**, and builds both `buildStatement` and
   `attachUnreferencedDmlCtes` under the marked context.
3. **`buildWithClause`** rejects a data-modifying member, before any member is built, when
   the clause is not in that set. One check on the clause covers every nesting position,
   because they all funnel through `buildWithContext` or `buildStoredBodyCTEs`.

Stable error substring the tests key on: `only allowed in a statement's own leading WITH
clause`. `StatusCode.ERROR`, sited at `cte.query.loc`.

## Review findings

Reviewed the implement diff (`bde30222`) first, then probed the engine directly for
positions the diff's tests do not reach, then ran lint + the full suite.

### Fixed in this pass (minor)

- **`is an DELETE`.** The message interpolated the statement type after a fixed article:
  `is an ${type.toUpperCase()}` reads correctly for `INSERT`/`UPDATE` and ungrammatically
  for `DELETE`. Reworded to `is data-modifying (DELETE)`, which is article-free and names
  the same three types. `docs/sql-select.md`'s quoted message updated to match; the
  substring every test asserts on is in the unchanged tail.
- **Two hand-written structural casts for the same shape.** `collectTopLevelWithClauses`
  and `attachUnreferencedDmlCtes` each cast `AST.Statement` to a literal
  `{ withClause?; schemaPath? }` shape (a third copy lives in `select-context.ts`).
  Replaced both with one `leadingClauses(stmt)` helper that switches on the discriminated
  union and returns the statement itself for the four forms that can carry either clause —
  no cast at all, so an AST change is a compile error rather than a silent `undefined`.
- **`QuereusError` constructed by hand** where the codebase's `quereusError(msg, code,
  cause, astNode)` helper already unpacks `loc`. Switched; same error, same position.
- **Test gaps closed in `13.12`.** (a) The file asserted "no object was defined" only in a
  comment — now checks `view_info()` / `assertion_info()` and a read of the maintained
  table. (b) `with recursive` in a nested position (the handoff flagged it unverified —
  probed, it rejects on the same path, now pinned). (c) A clause two nesting levels down,
  reached through a read-only nested clause — the handoff's "does not cross positions"
  gap.
- **Read-time behaviour for an older-catalog definition was untested.** Probing showed a
  plain `select * from vm` on an imported legacy view now *rejects* rather than re-driving
  the carried insert. That is the change's main effect on such definitions and nothing
  pinned it. Added a case to `view-cte-isolation.spec.ts`; corrected the now-stale present
  tense in `docs/view-updateability.md` and stated the read-path behaviour there.

### Checked and found correct (no change)

- **No false rejection anywhere reachable.** Probed the paths most likely to break on
  clause-object identity: a CTE-name DML target with a data-modifying sibling
  (`with d as (insert …), c as (select …) update c …`), an inline subquery target
  (`update (select …) as z …`), a compound with a top-level data-modifying member, view
  write-through with one, a materialized-view refresh with a read-only body clause, and a
  top-level `with recursive` data-modifying member. All still write exactly once.
  `flattenCteBody` never synthesizes a `with` clause (it refuses a body that has one), so
  the write-through re-plan genuinely carries the same object, as the handoff claimed.
- **Clause objects are never shared between a top-level and a nested statement.** The
  parser threads a `with` clause downward as *resolution context* only; it is attached to a
  statement node in exactly two places (`statement()` and `parseQueryExpr`), and
  `statementSupportsWithClause` limits that to `select`/`insert`/`update`/`delete`. So the
  marker set cannot be widened by parser plumbing.
- **`view-cte-isolation.spec.ts`'s `importCatalog` switch is not a test that stopped
  testing.** The imported view really is in the catalog — the sibling cases still reach the
  write-through diagnostic naming `vm` and the all-`NO` `view_info` row — so `importCatalog`
  models "persisted by an older build" faithfully rather than skipping the setup.
- **Rejected DDL leaves nothing behind.** Verified for `create view`, `create materialized
  view`, `create table … maintained`, `create assertion`: the reject fires while the body is
  planned, before registration.
- **Error surfaces cleanly through introspection.** `query_plan('<nested DML CTE>')` returns
  the rejection as its `ERROR` row rather than planning the statement.

### Recorded as tripwires, not tickets

- **Stored bodies re-planned as top-level statements** (the handoff's first gap, and its
  request for a second opinion on adding a "this is a stored body" flag to `_buildPlan`).
  Verdict: leave it, and the `NOTE:` at the `buildBlock` marker site is rewritten as an
  explicit accepted tradeoff with a revisit condition. Reasoning: the shape needs a
  definition persisted by an older build; on that path an ordinary read now rejects and
  write-through has its own `unsupported-body-cte-dml` guard, so what remains is
  introspection (`view_info`, `explain_assertion`, MV refresh), where planning successfully
  is more useful than erroring. Revisit condition named in the NOTE: a legacy definition
  found to re-drive its write through one of those paths — materialized-view refresh is the
  one that would.
- **The gate is by omission, not by assertion** (the handoff's third gap). Nothing stops a
  future path from re-entering `buildBlock` on a nested statement, which would mark that
  clause top-level and open every nested position silently. Recorded as a second `NOTE:` at
  the same site, with the shape of the fix if it ever matters (a positive "this clause is
  owned" flag set by the statement builders rather than membership-by-omission). Not a
  ticket: `_buildPlan` is the only non-test caller today, so there is nothing wrong now.

### Filed as tickets

None. Everything found was either fixable in this pass or genuinely conditional.

### Not covered, deliberately

- **A spec-level test for `topLevelWithClauses` itself.** Its behaviour is only observable
  through the SQL surface, which `13.12` covers per position; a spec test would pin the
  field's shape rather than the guarantee. The related fact — that a hand-built
  `PlanningContext` (several `test/**/*.spec.ts` build one) omits the optional field and
  therefore rejects every data-modifying member — is the intended conservative direction and
  is exercised implicitly by those specs continuing to pass.
- **Store-backed run** (`yarn test:store`). The change is entirely in the planner's build
  phase and touches no vtab or storage path.

## Validation run

- `yarn lint` from the repo root: clean (2m 28s).
- `yarn test` from the repo root: all workspaces green — quereus 9230 passing / 25 pending
  (one more than the handoff's 9229: the new read-rejection spec), every other package
  unchanged and passing (9m 20s).
