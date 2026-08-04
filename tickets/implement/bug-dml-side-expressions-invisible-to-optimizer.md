----
description: A subquery written inside a conflict-handling clause, or inside the clause that supplies extra values to a write, always crashes the query instead of running. The fix is known and has been validated end-to-end.
files:
  - packages/quereus/src/planner/nodes/dml-executor-node.ts        # getChildren/withChildren — main site
  - packages/quereus/src/planner/nodes/constraint-check-node.ts    # second site (mutation-context values only)
  - packages/quereus/src/runtime/emit/dml-executor.ts              # consumes the expressions (emit order reference)
  - packages/quereus/src/runtime/emit/constraint-check.ts          # consumes mutation-context values
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic  # pins the failure today
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic   # Test 17b pins it too
  - packages/quereus/test/logic/46-mutation-context.sqllogic       # natural home for new WITH CONTEXT coverage
  - packages/quereus/test/logic/47-upsert.sqllogic                 # natural home for new ON CONFLICT coverage
  - docs/invariants.md                                             # add the new invariant
  - docs/optimizer.md                                              # § Plan Node Hierarchy → Key Methods
difficulty: easy
repro: verified
----

# Expose DML side expressions to the optimizer

## What is broken

The optimizer rewrites a query plan by walking it through `PlanNode.getChildren()`.
Anything not reachable that way is never rewritten, so it arrives at the runtime in its
logical (un-executable) form and blows up with an internal-looking error.

Three kinds of user-written expression are held by DML plan nodes but are **not** in their
`getChildren()` result:

| held by | expressions |
|---|---|
| `DmlExecutorNode` | every `on conflict … do update` assignment value and its optional `where` condition |
| `DmlExecutorNode` | `with context <var> = <expr>` values |
| `ConstraintCheckNode` | the same `with context` values (it already exposes its constraint expressions and NOT NULL default evaluators — that is the pattern to copy) |

A *simple* expression in those positions (`excluded.w`, `'z'`, `1`, `p.id > 0`) needs no
rewriting, so it works today. A **subquery** does need rewriting, so it always fails.

Verified failures (all five reproduce with no `with` clause and no `with schema`):

```
insert into q values (1,'y') on conflict (id) do update set w = (select count(*) from p);
  → QuereusError: No emitter registered for Aggregate
insert into q values (1,'y') on conflict (id) do update set w = (select v from p where id = 1);
  → QuereusError: RetrieveNode for table 'p' was not rewritten to a physical access node…
insert into q values (1,'y') on conflict (id) do update set w = 'z' where (select count(*) from p) > 0;
insert into mc with context who = (select count(*) from p) values (1,'x');
update mc set v = 'y' where id = 1 with context who = (select count(*) from p);
delete from mc where id = 1 with context who = (select count(*) from p);
```

## Root cause

One shape, two sites. `getChildren()` must return every expression the node's emitter will
later emit, and `withChildren()` must slice the rewritten children back into exactly the
slots they came from. Ordering has to be canonical and the split exact, because the
upsert expressions live in a `Map<number, ScalarPlanNode>` per clause plus an optional
`whereCondition` per clause, and the context values live in a `Map<string, ScalarPlanNode>`.

Note the ticket that produced this one named `InsertNode` as a third site. It is **not**
one: `InsertNode`, `UpdateNode` and `DeleteNode` all carry a `mutationContextValues`
reference, but no emitter reads it from them — `emitDmlExecutor` and `emitConstraintCheck`
are the only consumers, and all three nodes are handed the *same* `Map` instance by the
builders. Exposing it on `InsertNode` too would be redundant (the optimizer memoises by
node id, so it would return the identical rewritten node) — leave those three alone.

## Validated fix

The patch below was applied in a scratch working tree, and the full `packages/quereus`
suite was run against it: **2738 passing**, with only the two intentionally-pinned
failure files going red (which is the expected, desired outcome — see *Tests* below).
It was then reverted so this stage hands off a clean tree. Apply it as the starting point.

`packages/quereus/src/planner/nodes/dml-executor-node.ts`:

```ts
  /** Upsert-clause expressions in canonical child order: per clause, assignments then WHERE. */
  private upsertExpressions(): ScalarPlanNode[] {
    const out: ScalarPlanNode[] = [];
    for (const clause of this.upsertClauses ?? []) {
      if (clause.assignments) out.push(...clause.assignments.values());
      if (clause.whereCondition) out.push(clause.whereCondition);
    }
    return out;
  }

  getChildren(): readonly PlanNode[] {
    return [
      this.source,
      ...this.upsertExpressions(),
      ...(this.mutationContextValues?.values() ?? []),
    ];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const upsertExprs = this.upsertExpressions();
    const ctxKeys = [...(this.mutationContextValues?.keys() ?? [])];
    const expected = 1 + upsertExprs.length + ctxKeys.length;
    if (newChildren.length !== expected) {
      throw new Error(`UpdateExecutorNode expects ${expected} children, got ${newChildren.length}`);
    }

    const [newSource] = newChildren;
    const newUpsertExprs = newChildren.slice(1, 1 + upsertExprs.length) as ScalarPlanNode[];
    const newCtxExprs = newChildren.slice(1 + upsertExprs.length) as ScalarPlanNode[];

    if (!isRelationalNode(newSource)) {
      throw new Error('UpdateExecutorNode: child must be a RelationalPlanNode');
    }

    const upsertUnchanged = newUpsertExprs.every((e, i) => e === upsertExprs[i]);
    const ctxUnchanged = newCtxExprs.every((e, i) => e === this.mutationContextValues!.get(ctxKeys[i]));
    if (newSource === this.source && upsertUnchanged && ctxUnchanged) {
      return this;
    }

    // Slice rewritten expressions back into their clause slots, same order as above
    let cursor = 0;
    const newUpsertClauses = this.upsertClauses?.map(clause => {
      const next: UpsertClausePlan = { ...clause };
      if (clause.assignments) {
        next.assignments = new Map(
          [...clause.assignments.keys()].map(colIndex => [colIndex, newUpsertExprs[cursor++]] as const)
        );
      }
      if (clause.whereCondition) {
        next.whereCondition = newUpsertExprs[cursor++];
      }
      return next;
    });

    const newContextValues = this.mutationContextValues
      ? new Map(ctxKeys.map((k, i) => [k, newCtxExprs[i]] as const))
      : undefined;

    // …then pass newContextValues and newUpsertClauses to the new DmlExecutorNode
    // in place of this.mutationContextValues / this.upsertClauses. lensRouted still
    // carries forward unchanged.
```

`packages/quereus/src/planner/nodes/constraint-check-node.ts` — append the context values
after the NOT NULL defaults in `getChildren()`, widen `expectedChildren` by
`ctxKeys.length`, bound the existing `newDefaultExprs` slice (it currently runs to the end
of the array and would otherwise swallow the new tail), and rebuild the map:

```ts
    // getChildren(), after the notNullDefaults loop:
    if (this.mutationContextValues) {
      children.push(...this.mutationContextValues.values());
    }

    // withChildren():
    const ctxKeys = [...(this.mutationContextValues?.keys() ?? [])];
    const expectedChildren = 1 + constraintCount + defaultCount + ctxKeys.length;
    …
    const newDefaultExprs = newChildren.slice(1 + constraintCount, 1 + constraintCount + defaultCount);
    const newCtxExprs = newChildren.slice(1 + constraintCount + defaultCount) as ScalarPlanNode[];
    …
    const ctxUnchanged = newCtxExprs.every((e, i) => e === this.mutationContextValues!.get(ctxKeys[i]));
    // …fold ctxUnchanged into the early-return, and pass the rebuilt Map to the constructor.
```

The child order for the upsert expressions deliberately mirrors the order
`emitDmlExecutor` walks them (per clause: assignments in map order, then `where`), so the
two never drift.

## Answers to the open questions the previous stage left

- **Correlated subqueries work with nothing more than child exposure.** The runtime
  already wraps every upsert evaluator in the existing-row and proposed-row contexts
  (`executeUpsertUpdate` in `runtime/emit/dml-executor.ts`). Verified against the patch:
  `… do update set w = (select v from p where p.id = excluded.id)` and the analogous
  reference to the conflicting existing row (`… where p.id = q.id`) both produce the right
  value. No diagnostic, no rejection, no extra machinery needed.
- **`new.<col>` inside `with context` stays rejected, and that is correct** — context
  values are documented as evaluated once per statement, not per row
  (`docs/sql-ddl.md` § Mutation Context). It fails at name resolution
  (`new.id isn't a column`) before the optimizer is involved, so it is out of scope here
  and is not a defect.
- **Values are right, not merely non-crashing.** Spot-checked with the patch: the
  aggregate assignment stores `2`; a false `where` leaves the row untouched; a `with
  context` subquery value reaches a `check (who > 1)` constraint and correctly passes for
  `who = 2` and fails for `who = 1`.

## Tests

Two files currently pin the failure with `-- error: No emitter registered for Aggregate`.
Both go red the moment the fix lands — that is intended. Convert them to real
assertions, do not delete them:

- `packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic`, final section
  ("ON CONFLICT and WITH CONTEXT: name resolution is fixed, execution is not") — five
  pinned statements, plus the section comment which describes the bug in the present
  tense and must be rewritten.
- `packages/quereus/test/logic/06.4-schema-search-path.sqllogic`, Test 17b (around line
  141) — one pinned statement that additionally checks the `with schema` path reaches the
  subquery; it uses `returning name`, so it can assert a real returned value.

## TODO

- Apply the `DmlExecutorNode` patch above (`getChildren`, `withChildren`, and the two
  constructor arguments that must become the rebuilt map / clause list).
- Apply the `ConstraintCheckNode` patch above — remember to bound the existing
  `newDefaultExprs` slice, which currently runs to the end of the children array.
- Convert the pinned block in `13.8-insert-with-clause-visibility.sqllogic` to real
  result assertions and rewrite its explanatory comment (it currently states the bug as
  present-tense fact and names this ticket slug).
- Convert Test 17b in `06.4-schema-search-path.sqllogic` to a real result assertion.
- Add positive coverage in `47-upsert.sqllogic`: subquery in a `do update set` value,
  subquery in the clause's `where`, a subquery correlated to `excluded.<col>`, and one
  correlated to the conflicting existing row. Include a multi-clause `on conflict` (two
  targets, each with its own assignments and `where`) so the child ordering / slicing is
  actually exercised rather than assumed.
- Add positive coverage in `46-mutation-context.sqllogic`: a subquery `with context`
  value on each of INSERT, UPDATE and DELETE, and one where the context value feeds a
  CHECK constraint (proves the value reaches `ConstraintCheckNode`, not just the executor).
- Add a structural spec (suggested: `packages/quereus/test/optimizer/dml-child-exposure.spec.ts`)
  asserting that for a plan carrying upsert clauses and context values, every one of those
  expression nodes appears in the owning node's `getChildren()`, and that
  `withChildren(getChildren())` round-trips to an equivalent node. `plan-validator.ts`'s
  existing "no logical-only node reaches emission" check cannot serve as the guard here —
  it walks `getChildren()` too, so it is blind to exactly the subtrees this ticket exposes.
- Add an invariant to `docs/invariants.md` in the `OPT-` series (`OPT-009` is free, and
  sits next to the `withChildren` invariants OPT-008 / OPT-012): *every user expression a
  plan node holds and later emits must be reachable through `getChildren()`, and
  `withChildren` must slice it back into the same slot.* Cite the two node files as
  `code:` and the new spec as `guard:`.
- Tighten the `getChildren()` bullet under `docs/optimizer.md` § Plan Node Hierarchy →
  Key Methods to say "all child nodes — including every held scalar expression — in a
  consistent order", linking the new invariant.
- Run `yarn test` and `yarn lint` from `packages/quereus`.

## Notes for the implementer

- `packages/quereus/src/planner/nodes/dml-executor-node.ts` is also named in
  `tickets/backlog/debt-row-estimates-die-at-set-operations.md`, but that ticket's arm is
  `estimatedRows` relaying — a different site in the same file. No conflict.
- NOTE-worthy while you are in `runtime/emit/constraint-check.ts`: its context-row builder
  skips a declared context variable that has no supplied value (`if (valueExpr)`), which
  would shift every later value out of alignment with `contextDescriptor`. It is
  unreachable today because `emitDmlExecutor` throws `Missing mutation context value for
  '<name>'` at prepare time first (verified: a table with two declared context variables
  and only one supplied errors out, it does not misalign). Worth a `NOTE:` comment at that
  line so the coupling is visible; not worth a ticket.
