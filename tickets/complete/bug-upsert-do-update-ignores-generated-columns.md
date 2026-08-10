---
description: An insert that falls back to updating an existing row now recomputes auto-computed columns instead of leaving stale values behind, and refuses an attempt to write one directly.
files:
  - packages/quereus/src/planner/building/insert.ts          # appendGeneratedRecomputes + the SET-loop rejection
  - packages/quereus/src/planner/nodes/dml-executor-node.ts  # UpsertClausePlan.generatedAssignmentColumns
  - packages/quereus/src/runtime/emit/dml-executor.ts        # emit split + executeUpsertUpdate phase 2
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic   # sections 9, 9b–9m
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts        # child-walk guard for the appended nodes
  - docs/sql-dml.md                                          # § UPSERT / Generated Columns
---

# `on conflict … do update` recomputes generated columns, and rejects assigning one

## What was broken

`insert … on conflict … do update set` composes its row from the existing (conflicting) row
plus the SET assignments and writes it straight through `vtab.update`. It never routed
through `buildUpdateStmt`, so it inherited neither of the two things a plain `UPDATE` does
for generated columns:

- **Arm A** — no recompute. `g integer generated always as (w * 2)` kept its pre-update value
  after a DO UPDATE changed `w`, leaving the stored row internally inconsistent.
- **Arm B** — `do update set g = 99` was accepted and wrote 99 into the generated column,
  where `update t set g = 99` correctly raises `Cannot UPDATE generated column 'g'`.

## What landed

**Plan side (`planner/building/insert.ts`).** The DO UPDATE SET loop rejects an assignment
whose target column is generated, before the value expression is built, with the same wording
`building/update.ts` uses. `appendGeneratedRecomputes` then appends one implicit assignment
per entry of `tableSchema.generatedColumnTopoOrder` into the *same* `assignments` map and
returns the column indices in topological order, recorded on the new
`UpsertClausePlan.generatedAssignmentColumns`. Appending into the same map is what keeps
`DmlExecutorNode.getChildren()` / `withChildren()` working unchanged — both are
order-preserving over `assignments.values()` / `assignments.keys()`.

The recompute expressions get a dedicated `RegisteredScope` over the existing-row attributes,
parented on `ctx.scope` and wrapped in `schemaAuthoredContext` — deliberately *not* the SET
scope, which also carries `new.` / `excluded.` symbols that schema-authored SQL must not bind.
`validateDeterministicGenerated` runs unless `nondeterministic_schema` is set, matching
`update.ts`.

**Emit side (`runtime/emit/dml-executor.ts`).** The clause's assignments split into user
targets (`assignmentIndices`, phase 1) and generated recomputes (`generatedAssignments`,
ordered off the plan's topo list rather than map order). The existing static-type coercion
rule applies to generated values too. A distinct `generatedRowDescriptor` is cloned from
`existingRowDescriptor` via `.slice()`; a missing existing-row descriptor is an internal error
rather than a silent skip.

**Runtime (`executeUpsertUpdate`).** After phase 1 applies and coerces the user assignments,
one `withAsyncRowContext` binds the cloned descriptor to the live `updatedRow` array and
evaluates the generated evaluators in topological order, awaiting each and writing back before
the next runs.

## Review findings

Diff read first (`c257f67b`), then the follow-on edits the next commit (`b92b04d5`, a review
of an unrelated ticket) made to the same code, then the handoff.

### Verified correct — no change needed

- **Arm B parity.** Rejection wording and placement match `building/update.ts`; raised before
  the value expression builds, so the diagnostic does not depend on that expression resolving.
- **Scope isolation.** The recompute scope registers only existing-row columns. Schema-authored
  SQL cannot reach `new.` / `excluded.`, and `schemaAuthoredContext` keeps the writing
  statement's CTEs out of it.
- **Child-walk invariants.** `getChildren` emits `assignments.values()` then `whereCondition`
  per clause; `withChildren` re-slices by `assignments.keys()` and rebuilds each clause with
  `{ ...clause }`, so `generatedAssignmentColumns` survives verbatim. The new optimizer spec
  case pins both the identity round-trip and a substitution.
- **Descriptor clone.** `RowDescriptor` is a sparse array indexed by attribute id; `slice()`
  preserves the holes. The `StatusCode.INTERNAL` throw on a missing existing-row descriptor is
  the right call — degrading would skip the recompute silently.
- **Stored vs virtual generated columns.** `generatedStored` is informational everywhere in the
  engine (`table_info` reports it; the INSERT projection chain and the UPDATE recompute both
  ignore it), so the new arm introduces no stored/virtual divergence of its own.
- **No third path missed.** The engine has exactly two sites composing an `operation: 'update'`
  row (`dml-executor.ts:608` — this arm — and `:1213`, the plain UPDATE executor, fed by
  `emitUpdate`'s own recompute). There is no `MERGE` statement. Nothing else writes a row that
  would need this pass.
- **Source hygiene.** `dml-executor.ts` 1439 lines, `insert.ts` 1001 (`wc -l`), both under the
  ~1800 at which this project has previously filed a split ticket; the open
  `debt-emit-source-files-too-large` covers files at 3107 and 2419. The prior review already
  extracted `registerExistingRowColumns` / `appendGeneratedRecomputes`, so the added logic
  reads as two named helpers rather than inline blocks. No size finding.
- **Docs.** `docs/sql-dml.md:104-109` gained a *Generated Columns* paragraph under UPSERT
  (prior review) and is accurate; `docs/sql-ddl.md:345` ("Cannot INSERT into or UPDATE a
  generated column directly") is now true for this path too. Both re-read against the code.

### Fixed in this pass

Four sections added to `test/logic/41-generated-column-extras.sqllogic`:

- **9j — multi-row DO UPDATE.** Every pre-existing case conflicted on a single row. A statement
  mixing two conflicting rows and one clean insert now pins per-row recompute. *Non-vacuity
  verified*: with the phase-2 block stubbed off the case fails on `g:2` vs the expected `g:20`.
- **9k — static-type coercion of a generated value on this arm** (handoff gap: "coverage of the
  phase-2 coercion is indirect"). A `text`-declared column generated from an integer expression,
  driven through DO UPDATE, asserted on both value and `typeof`. Fails without phase 2 (stale
  value) *and* would fail without the coercion (`typeof` would read `integer`).
- **9l — generated column whose dependency the SET does not touch.** Guards the opposite defect
  from the one fixed: the recompute must read the *composed* row, not the proposed one. The
  proposed row carries `a = 9` and the existing row `a = 1`; `g` must stay `10`.
- **9m — the view-write decomposition path** (handoff gap: "Arm B untested on that path").
  See below.

Two comments in `runtime/emit/dml-executor.ts` corrected. Both claimed the cloned descriptor
avoids a *collision* with the existing-row binding. There is no collision to avoid: phase 1
binds `existingRowDescriptor` inside a `withAsyncRowContext` that has already unwound by the
time phase 2 binds (the only three bindings of that descriptor in the file are all scoped and
awaited). The separate object is defensive, not load-bearing today; the comments now say that,
so a future reader does not infer an overlap that isn't there.

### Investigated and closed without a ticket

- **Arm B on the view-write decomposition path.** The handoff flagged this as possibly a
  *regression* — a synthesized `on conflict … do update` that previously wrote a generated basis
  column would now be rejected. It cannot happen: the view-write classifier marks a projected
  generated column read-only and rejects first, with `column 'pv' is a computed
  (non-invertible) expression and is read-only`. Reproduced and pinned as 9m so the ordering
  cannot drift.
  I also tried to reach this arm's *recompute* through a view, including the outer-join
  optional-member shape whose decomposition comment says one upsert replaces both the matched
  UPDATE and the materialize INSERT (`planner/mutation/decomposition.ts:1229-1232`). Stubbing
  phase 2 off left that case passing, i.e. the write lowered to a plain member UPDATE, not this
  arm. 9m's second half is therefore a view-path regression guard, not coverage of this arm; I
  could not construct a decomposition shape that reaches it with a generated-column basis table.

- **Multi-clause DO UPDATE** and the **`assignmentCount` plan-golden growth** (handoff gaps).
  Both were already closed by commit `b92b04d5`: section 9i covers two `on conflict` clauses on
  one generated-column table, and `getLogicalAttributes` now reports the user SET count and a
  separate `generatedAssignmentCount`.

### Found, already tracked — deliberately not re-filed

**NOT NULL is not enforced against a recomputed generated column on this arm.** Reproduced:

```sql
create table t (id integer primary key, w integer,
                g integer not null generated always as (w + 1) stored);
insert into t (id, w) values (1, 1);
insert into t (id, w) values (1, 2) on conflict (id) do update set w = null;
-- no error; the row is stored with g = null
```

Root cause is the one the handoff named: `executeUpsertUpdate` calls `vtab.update` directly
after only the *insert-shaped* constraint pass, so no UPDATE-shaped CHECK / NOT NULL / FK
validation ever runs on the composed row. That site is already claimed by
`tickets/fix/bug-upsert-do-update-skips-constraint-checks.md`, whose "use cases to exercise"
lists this exact case ("a DO UPDATE whose SET is fine but whose generated-column recompute
produces a CHECK-violating or NULL value in a NOT NULL generated column"). No second ticket,
and no test asserting the current wrong behavior.

### Tripwires

None newly parked. The prior review already left the one conditional concern in this code as a
`NOTE` at `runtime/emit/dml-executor.ts:583-588` — this arm converts each generated value before
the next generated column reads it, whereas `emitUpdate` converts the whole row once after its
phase-2 loop; the two agree unless a generated column reads another whose expression type
differs from its declared type. That note still stands and is still correctly sited.

## Verification

- `yarn build` — clean.
- `yarn lint` — clean (the real pass is `packages/quereus`: eslint plus a `tsc -p
  tsconfig.test.json --noEmit` over the test files).
- `yarn test` — 8675 passing in `packages/quereus`, 13 pending, all other workspaces green,
  0 failing. Re-run after the comment edits: same.
- Non-vacuity checked per new test section as noted above, by temporarily short-circuiting the
  phase-2 block and reverting immediately.
