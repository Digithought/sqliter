description: A table rule that checks a value against another table was being applied too early — against the data as it stood before the transaction — so it could reject a value that was present by the end, or accept one that had been removed. Root cause found and the one-line engine fix is already in the working tree; this ticket adds the test coverage and doc/comment updates around it.
prereq:
files:
  - packages/quereus/src/planner/building/constraint-builder.ts        # containsSubquery — the fix
  - packages/quereus/src/runtime/deferred-constraint-queue.ts          # commit-time evaluation (unchanged; works correctly)
  - packages/quereus/src/runtime/emit/constraint-check.ts              # shouldDefer, immediate-path error message
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # existing subquery-CHECK coverage
  - packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic # case 10 NOTE points at this slug
  - docs/architecture.md                                               # lines ~136, ~143 describe auto-deferred CHECKs
difficulty: easy
----

# Root cause: a membership CHECK was never actually deferred

## What the original ticket assumed, and what is actually true

The filed ticket assumed the check *was* deferred to `COMMIT` but evaluated against a
frozen snapshot (a stale `IN` probe set). That is wrong.

The check was **never deferred at all**. It ran immediately, at row-write time, like any
ordinary CHECK. The stack trace from the reproduction lands in
`checkCheckConstraints` (`runtime/emit/constraint-check.ts`) during the `insert`, not in
`DeferredConstraintQueue.runDeferredRows`. Both reported symptoms follow directly:

- *false violation* — the check fired during `insert into zt`, before `insert into zl`
  supplied the value.
- *false pass* — the check fired during `insert into zt2`, passed, and was never
  re-evaluated after the row it depended on was deleted.

The deferred-constraint queue is fine. It does read the transaction's own writes, exactly
as the deferred-FK tests already demonstrate.

## The actual defect

`constraint-builder.ts` decides whether a CHECK must be postponed to commit:

```ts
const needsDeferred = containsSubquery(expression) || containsCommittedRef(expression);
```

`containsSubquery` walked the expression tree looking for two specific plan-node types:

```ts
if (n.nodeType === PlanNodeType.ScalarSubquery || n.nodeType === PlanNodeType.Exists)
```

`x in (select …)` builds as `InNode`, which carries its source relation in
`InNode.source` but reports `PlanNodeType.In` — not in that list. So every
`check (col in (select …))` fell through as an ordinary immediate check.
`(select …)` and `exists (…)` shapes were correctly deferred all along, which is why the
gap went unnoticed.

## The fix (already applied in the working tree)

Detect the subquery **structurally** rather than by enumerating the scalar node types that
can wrap one — if any node under the scalar expression is relational, the expression reads
a relation and cannot be decided from the mutating row alone:

```ts
function containsSubquery(expr: ScalarPlanNode): boolean {
  const stack: PlanNode[] = [expr];
  while (stack.length) {
    const n = stack.pop()!;
    if (isRelationalNode(n)) return true;
    stack.push(...n.getChildren());
  }
  return false;
}
```

This is not a wider net than intended: `in (<value list>)` has no relational child and
correctly stays immediate (verified). Any future scalar node that embeds a relation is
covered without another edit here.

`PlanNodeType` is no longer used in the file and its import was dropped;
`isRelationalNode` (`planner/nodes/plan-node.ts`) is imported instead.

## Verification already done

- Both reproductions from the original ticket now behave as specified: the false-violation
  case commits, the false-pass case raises `ConstraintError` at `commit`.
- `check (x in ('a','b'))` still errors at the `insert`, inside an open transaction — not
  deferred.
- The autocommit path (no explicit `begin`) still reports the violation and leaves no row.
- Full `yarn test` is green (7416 + sibling packages, 0 failing) with the fix in place.

## What is left for this ticket

### Regression coverage

There is no `.sqllogic` case pinning either direction. Add one — the natural home is
`packages/quereus/test/logic/40.2-check-extras.sqllogic`, whose section 6 already covers a
subquery-CHECK (`not Color in (select Code from Block)`) but only in the autocommit path,
where immediate and deferred evaluation are indistinguishable. The two cases that
discriminate:

```sql
-- read-your-own-writes: the value the check needs arrives LATER in the transaction
begin;
insert into zt values (1, 'a');
insert into zl values ('a');
commit;
-- must succeed

-- and the reverse: the value the check needs is REMOVED later in the transaction
begin;
insert into zt2 values (1, 'a');
delete from zl2 where code = 'a';
commit;
-- error: constraint
```

Also worth pinning alongside them, since they are what make the fix safe rather than merely
correct: `in (<value list>)` still failing at the `insert` (immediate), and the existing
`exists (…)` / scalar-subquery shapes continuing to defer.

### Case 10 of `41.11-deferred-fk-with-rename.sqllogic`

Its `NOTE` block (lines ~201-206) documents the old broken behaviour and points at this
slug. It is now stale in two ways: the check *is* deferred, and it *does* re-read
`dr_lookup` at commit — so the case now genuinely exercises the rename remap instead of
passing vacuously. Rewrite the NOTE, and strengthen the case into a real guard by having
the transaction write to the renamed lookup table after the rename and before the commit,
so a broken remap changes the outcome.

### Error-message shape (decide, then do or explicitly skip)

The immediate path reports `CHECK constraint failed: zt_ck (code in (select code from zl))`
— constraint name plus expression text. The deferred path
(`DeferredConstraintQueue.evaluateEntry`) reports only `CHECK constraint failed: zt_ck`.
Moving a shape from immediate to deferred therefore silently drops the expression text from
the user's error. Existing assertions match on the prefix, so nothing breaks, but the
message got less useful. Either thread `constraintExpr` through `DeferredConstraintRow` so
both paths read the same, or note in the handoff that the difference is deliberate.

### Docs

`docs/architecture.md:136` already states that CHECKs referencing other tables are
automatically deferred — it describes the intended behaviour, which is now the real one, so
no correction is needed. Re-read it once the tests land and confirm; if you touch nothing,
say so in the handoff rather than leaving the reviewer to check.

## TODO

- Add the two discriminating deferred-subquery-CHECK cases to
  `packages/quereus/test/logic/40.2-check-extras.sqllogic` (read-your-own-writes insert, and
  the delete that must be caught at commit)
- Add the negative case: `in (<value list>)` must still fail at the `insert`, inside an open
  transaction
- Rewrite the stale `NOTE` in case 10 of
  `packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic` and strengthen the
  case so a broken rename remap actually changes its outcome
- Decide the deferred-vs-immediate CHECK error-message question above; implement or record
  the decision
- Confirm `docs/architecture.md` needs no change (or change it)
- `yarn lint` and `yarn test` green before handoff
