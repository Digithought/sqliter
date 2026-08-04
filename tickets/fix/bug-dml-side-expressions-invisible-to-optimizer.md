----
description: A subquery written inside a conflict-handling clause, or inside the clause that supplies extra values to a write, always crashes the query instead of running.
files:
  - packages/quereus/src/planner/nodes/dml-executor-node.ts       # getChildren/withChildren — the main site
  - packages/quereus/src/planner/nodes/insert-node.ts             # same shape, also carries mutationContextValues
  - packages/quereus/src/planner/nodes/constraint-check-node.ts   # already does it right — copy this pattern
  - packages/quereus/src/planner/building/insert.ts               # buildUpsertClausePlans builds the expressions
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic  # pins the current failure
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic  # Test 17b pins it too
repro: verified
----

# Subqueries in `on conflict` and `with context` are never optimized, so they cannot run

## Symptom

Any subquery written inside an `on conflict … do update` clause, or inside a
`with context <var> = …` assignment, fails at execution with an internal-looking
error rather than producing a value:

```sql
create table p (id integer primary key, v text);
insert into p values (1,'a'),(2,'b');
create table q (id integer primary key, w text);
insert into q values (1,'x');

insert into q values (1,'y') on conflict (id) do update set w = (select count(*) from p);
-- QuereusError: No emitter registered for Aggregate

insert into q values (1,'y') on conflict (id) do update set w = 'z'
  where (select count(*) from p) > 0;
-- QuereusError: No emitter registered for Aggregate

create table mc (id integer primary key, v text) with context (who integer);
insert into mc with context who = (select count(*) from p) values (1,'x');
-- QuereusError: No emitter registered for Aggregate

update mc set v = 'y' where id = 1 with context who = (select count(*) from p);
-- QuereusError: No emitter registered for Aggregate

delete from mc where id = 1 with context who = (select count(*) from p);
-- QuereusError: No emitter registered for Aggregate
```

The exact message depends on what the subquery contains — an aggregate reports
`No emitter registered for Aggregate`; a plain `(select v from p where id = 1)` reports
`RetrieveNode for table 'p' was not rewritten to a physical access node`. Both are the
same underlying story: the subquery's plan subtree reaches the runtime **still logical**.

Non-subquery forms are unaffected and work today: `do update set w = excluded.w`,
`do nothing`, `do update … where p.id > 0`, `with context who = 1`.

## Root cause — one site, one shape

The optimizer walks the plan tree via `PlanNode.getChildren()`. Three DML nodes hold
user expressions that are **not** in their `getChildren()` result, so those subtrees are
never visited and never rewritten from logical to physical:

| node | expressions it hides |
|---|---|
| `DmlExecutorNode` (`planner/nodes/dml-executor-node.ts:94`) | every `UpsertClausePlan`'s `assignments` values and `whereCondition`; also `mutationContextValues` |
| `InsertNode` (`planner/nodes/insert-node.ts:72`) | `mutationContextValues` |
| `ConstraintCheckNode` (`planner/nodes/constraint-check-node.ts:76`) | `mutationContextValues` (it already exposes its constraint expressions and NOT NULL default evaluators — this node is the pattern to copy) |

`ConstraintCheckNode` demonstrates the correct shape: push the extra expression nodes
onto the children array so the optimizer sees them. The matching `withChildren()` must
then slice the rewritten children back into the same slots — that is the real work here,
because the upsert expressions live in a `Map<number, ScalarPlanNode>` per clause plus an
optional `whereCondition` per clause, and `mutationContextValues` is a
`Map<string, ScalarPlanNode>`. Order must be stable and the split must be exact.

## Expected behavior

All five statements above should execute, evaluating the subquery once and using its
value — the same semantics the equivalent expression already gets in a `SET` clause of an
ordinary `UPDATE`.

Open sub-question for whoever implements: a correlated subquery in these positions (one
referencing the proposed `new.`/`excluded.` row or the conflicting existing row) may need
more than child exposure — decide whether to support it in the first cut or reject it
with a clear diagnostic.

## How it was found

Surfaced while fixing `bug-insert-stmt-context-not-threaded` (now in `review/`), which
made these clauses *resolve* the statement's common table expressions and `with schema`
path for the first time. Before that fix they failed earlier, with
`Table 'c' not found in schema path: main`, which masked this. The failure is
independent of that ticket — it reproduces with no `with` clause and no `with schema`,
as the plain examples above show.

## Tests already in place

Two test files currently **pin the failure** with `-- error: No emitter registered for
Aggregate`, so they will go red the moment this is fixed — update them to real
assertions rather than deleting them:

- `packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic`, final
  section ("ON CONFLICT and WITH CONTEXT: name resolution is fixed, execution is not") —
  five pinned statements.
- `packages/quereus/test/logic/06.4-schema-search-path.sqllogic`, Test 17b — one pinned
  statement, which additionally checks that the `with schema` path reaches the subquery.

Both name this ticket's slug in a comment.
