description: A query that uses an aggregate without a `group by` can hide a mistaken column reference inside a subquery, and instead of reporting the error the engine silently answers using one arbitrary row of the table.
repro: verified
severity: wrong-result
likelihood: unusual
difficulty: medium
tradeoffs: The shape is a user error to begin with and the same mistake IS caught the moment the query has a `group by`, so a maintainer may reasonably rank the silent-wrong-answer window as too narrow to be worth reworking how the post-aggregate context is built.
files:
  - packages/quereus/src/planner/building/select.ts               # ~line 427 — the gate that skips the check
  - packages/quereus/src/planner/building/select-aggregates.ts    # ~line 140 — where the context is (not) built; ~line 1136 — the local workaround
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # where the sibling grouped cases are pinned
----

# The whole-plan coverage check never runs for an aggregate query with no `group by`

## What a user sees

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

-- `wg.b` is not a grouping column and is not inside an aggregate. Illegal.
select count(*) as c from wg having (select max(t.a) from wg t where t.b = wg.b) = 'x';
→ []                    -- no error; the answer depends on which row `wg.b` happened to read

-- Add a `group by` and the SAME mistake is caught:
select a, count(*) as c from wg group by a
having (select max(t.a) from wg t where t.b = wg.b) = 'x';
-- error: Column 'wg.b' must appear in the GROUP BY clause or be used in an aggregate function
```

The result is not merely "no error" — it is an answer computed from an arbitrary
representative row of the table, so the same query can give different answers for
reasons the user cannot see. `order by` has the same hole:

```sql
select count(*) as c from wg order by (select max(t.a) from wg t where t.b = wg.b);
→ [{"c":3}]             -- accepted; should be rejected
```

The select list is not affected — an earlier, separate check ("Cannot mix aggregate and
non-aggregate columns in SELECT list without GROUP BY") already covers it.

## Where it comes from

Two checks guard a grouped query's clauses that sit above the aggregate:

- a per-clause check run while the clause is built. It deliberately does **not** look
  inside subqueries, because at build time it cannot tell a subquery's own columns
  apart from a correlated reference back out;
- a whole-plan check run once the plan is finished, which **can** tell them apart and
  therefore is the one that catches a mistaken reference buried in a subquery.

The second check only runs when the query has at least one `group by` key: the shared
context both checks need is built only in that case, and the call site is guarded on
that context existing. An aggregate query with no `group by` is still a grouped query —
it has exactly one, implicit group — but it never reaches the second check, so anything
its subqueries read goes unexamined.

Pre-existing; it is not a regression from the correlated-HAVING change, which left both
checks' subquery behaviour exactly as it found it. It was found while reviewing that
change (`complete/bug-having-rejects-correlated-outer-column`).

## What should happen

Both queries above should be rejected at plan time with the same
`Column '<name>' must appear in the GROUP BY clause or be used in an aggregate function`
message the grouped forms already raise. Nothing that is legal today should start
failing: an aggregate query with no `group by` whose subqueries only read their own
columns or correlate to an *enclosing* query stays legal, exactly as it is when the
query has a `group by`.

## The shape of the fix, and the trap in it

Build the shared context for the no-`group by` case too (with an empty key list) and
drop the guard on the call site. That is the change that retires the whole class rather
than patching the two clauses that expose it today — any future clause built above the
aggregate is then covered for free.

The trap: that context is also what decides whether the *grouping-key rewrite* runs over
post-aggregate expressions, and a query with no `group by` has no grouping keys to
rewrite — today it takes a pass-through branch precisely because the context is absent.
Making the context always present must not make the rewrite start walking expressions it
should leave alone. Whoever takes this should separate "the context needed to CHECK
coverage" from "the context that triggers the REWRITE", rather than reusing one value for
both.

The HAVING builder already contains a local workaround for exactly this — it constructs
the same context on the spot, for its own coverage check only, with a comment explaining
why it cannot hand it to the rewrite. That workaround should disappear into the general
fix.
