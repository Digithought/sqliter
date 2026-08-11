----
description: |
  When a row is updated through a deployed logical schema, the engine re-reads the whole finished
  row once for every required-value rule the table declares, instead of once per write. On a
  ten-column table that is ten re-reads where one would do.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts # lensRowLocalDecompositionUpdateConstraints (~693) — the per-check loop, and the NOTE at the site that comes out with the fix
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # synthesizeLensRowLocalDeferredConstraint, collectLensRowLocalLogicalChecks
  - packages/quereus/src/schema/table.ts # RowConstraintSchema — where the opt-in flag below goes
  - packages/quereus/src/planner/nodes/constraint-check-node.ts # ConstraintCheck — carries the flag from schema to emit
  - packages/quereus/src/runtime/row-constraints.ts # constraintViolationMessage + checkCheckConstraints — the immediate and deferred failure paths
  - packages/quereus/test/logic/lens-decomposition-checks.sqllogic # existing row-local rule coverage over decompositions
  - docs/lens.md # § Constraint Attachment describes the deferred re-read seam — update to the collapsed shape
difficulty: hard
repro: verified
----

# One deferred logical-row re-read per declared rule, where one per write would do

Filed from the lamina board (lamina ticket `lens-decomposition-update-probe-collapse`), promoting
this board's backlog ticket `perf-lens-decomposition-update-probe-per-check` with a fuller, measured
spec. This file **supersedes** that backlog sketch — in particular its failure-attribution
suggestion (re-evaluate each check individually on failure) is replaced by the constant-plan-count
shape below, because per-rule plan construction is exactly the cost being removed.

## What goes wrong

A lens decomposition stores each column of a logical table in its own member store, so a write
through the logical schema fans out into several per-member writes. A rule stated about the *whole*
logical row (an authored `check`, or a `not null`) cannot be checked against any single per-member
write, so the engine defers it to the end of the statement, re-reads the finished logical row out of
the view, and asserts the rule against it.

`lensRowLocalDecompositionUpdateConstraints` (view-mutation-builder.ts ~693) emits **one such
re-read per rule, per member relation the statement touched**:

```ts
for (const op of baseOps) {
    ...
    for (const check of checks) {
        constraints.push(synthesizeLensRowLocalDeferredConstraint(...));
    }
}
```

The `(relation, correlation)` half is already deduped by `seen`. The `checks` loop is not, so the
number of full logical-row reconstructions per written row is

    (member relations the write touched) x (row-local rules the table declares)

That was nearly free while row-local rules meant authored `check` clauses, of which a typical table
declares none. Since every undefaulted `not null` column contributes a rule (the
NOT-NULL-write-enforcement work landed under `fe269626`/`967334fb`), and columns are `not null` by
default, a typical table now declares roughly one rule per column.

Each of those constraints is a **separately planned** subquery, and plan construction is where the
cost lands.

## Measurement (from the lamina consumer)

Lamina-backed logical table over a matching basis schema, one stored row, ten single-column
`update`s averaged, varying only how many of the ten logical columns are declared `not null`.
Measured without and with the correlation-walk dedup (`correlation-detector.ts`, landed under
`3912811f`):

| rules declared | before walk dedup | after walk dedup |
| --- | --- | --- |
| 0  | 26.7 ms | 26.2 ms |
| 1  | 1284.4 ms | 55.1 ms |
| 2  | 2545.5 ms | not measured |
| 5  | 6840.7 ms | not measured |
| 10 | 13401.3 ms | 258.9 ms |

Cost is exactly linear in the rule count in both columns — the walk dedup changed the per-rule
constant (from ~1300 ms to ~23 ms), not the multiplication. Row count is irrelevant (1 row and 8
rows measure the same). `insert` is unaffected: inserts evaluate the rules once on the proposed row
at the write envelope, which needs no re-read.

## The invariant

> The cost of the deferred logical-row re-read is proportional to the number of member relations the
> write touched, and **independent of how many row-local rules the logical table declares.**

Concretely: for each `(relation, correlation)` pair the statement touches, emit **one** constraint
that re-reads the row once and decides all of that group's rules against the row it already has.

## Per-rule error attribution must survive

The messages are pinned by tests in both repos and must not regress to a generic "some rule failed":

- `CHECK constraint failed: lens:<name>` for an authored check;
- `NOT NULL constraint failed: <table>.<col>` for a synthesized not-null rule
  (`LensRowLocalLogicalCheck.violationMessage` carries this today).

Today's authored-check message has no expression hint appended: `constraintViolationMessage`
(runtime/row-constraints.ts) appends `(<expr>)` only when the stringified constraint expression is
≤ 60 characters, and these constraints are whole `not exists (select … )` subqueries, far over that.
So both messages are fixed strings known at plan time — the collapsed form can reproduce them
exactly.

### The shape that works

Do **not** recover attribution by planning one probe per rule and evaluating them on failure — that
re-creates exactly the per-rule plan-construction cost this ticket removes. Attribution must cost a
constant number of plans.

The suggested shape is a single subquery that yields the failing rule's message instead of a
boolean:

```sql
(select case
          when not (<rule 1>) then '<rule 1 message>'
          ...
          when not (<rule n>) then '<rule n message>'
          else null
        end
   from <logical view> _lr
  where <row address over <CORR>.<relationKeyColumn>>)
```

with a new opt-in flag on `RowConstraintSchema` (and carried through `ConstraintCheck` to
`ConstraintMetadataEntry`) meaning *this constraint's expression evaluates to NULL when satisfied
and to the violation message when violated*. `checkCheckConstraints` then inverts its usual test for
such a constraint — failure iff the value is non-NULL — and `constraintViolationMessage` uses the
value it already computed. One expression, one plan, exact attribution, nothing evaluated twice.

NULL semantics carry for free and must be preserved: a rule evaluating to NULL makes its
`when not (<rule>)` branch NULL, so the branch is not taken and the rule passes — SQL's
NULL-passes-a-CHECK convention, which is what today's per-rule form gives. A rule that is definitely
false selects its branch and aborts. Note the equivalent property for a plain conjunction: `c1 AND …
AND cn` is FALSE exactly when some conjunct is FALSE, so a conjunction-based variant would be
correct too — it just cannot name the failing rule.

If a different shape is cleaner, that is fine, subject to the constraints below.

### Design constraints

- **Do not narrow which rows get re-checked.** Skipping rules whose columns the statement did not
  assign would silently reopen the enforcement holes `1dec0513` closed. Whole-row semantics are
  deliberate: they are what makes a grandfathered row reject on a sibling-column update. Keep the
  per-op threading total.
- **Keep the `(relation, correlation)` dedupe and the per-op gate as they are.** The collapsed
  constraint references the same single `(relation, key column)` pair, so
  `referencedWriteRowRelations` and `constraintsForOp` need no change.
- **Constant plan count per group.** Whatever shape is chosen, the number of planned subqueries per
  `(relation, correlation)` must not grow with the rule count. This is the whole ticket.
- **Exact messages, not equivalent ones.** Assert the two literal strings above in tests.
- **Do not add a `Database` argument or new construction seam** to the enforcement collectors; they
  take the `PlanningContext` / `LensSlot` they already take.
- The collapsed constraint still needs a name for the deferred queue's bookkeeping
  (`_queueDeferredConstraintRow` takes one) and for the "constraint rode no base op" trace log. Pick
  a stable one (e.g. `lens:rowlocal`) and make sure it does not leak into a user-visible message.

## TODO

- Collapse the `checks` loop in `lensRowLocalDecompositionUpdateConstraints` to emit one constraint
  per `(relation, correlation)` covering every row-local rule of the group.
- Add the message-carrying constraint flag to `RowConstraintSchema`, thread it through
  `ConstraintCheck` and `ConstraintMetadataEntry`, and honour it in both the immediate and the
  deferred failure paths in `runtime/row-constraints.ts` (the deferred wrapper builds its message up
  front today — it will need to compute it from the evaluated value instead).
- Extend `synthesizeLensRowLocalDeferredConstraint` (or add a sibling) to build the grouped form
  from a list of `LensRowLocalLogicalCheck`, preserving each rule's message text verbatim.
- Remove the `NOTE:` at the site in `view-mutation-builder.ts` recording this cost.
- Pin the exact failure messages for both rule classes on a decomposition update, and pin that the
  planned deferred-constraint count for a `k`-rule table does not grow with `k`.
- Update `docs/lens.md` § Constraint Attachment, which describes this deferred re-read seam, to
  match the collapsed shape.
- Run `node test-runner.mjs` in `packages/quereus` (baseline 9315 passing / 25 pending).

## Coordination

The lamina board carries the companion ticket (`lens-decomposition-update-probe-collapse`). Lamina
ships a bench scenario on its side measuring the update cost at 1 declared rule vs 10 and asserting
the ratio; its gate is parked (record-only) until this ticket lands, then armed at a ~1.5x bound —
today's code measures the ratio at roughly the rule-count multiple. No lamina-side code change is
needed for this ticket beyond that guard; the lamina suite reads this repo's `src/` directly through
its vitest alias map, so this fix takes effect there on landing with no rebuild.
