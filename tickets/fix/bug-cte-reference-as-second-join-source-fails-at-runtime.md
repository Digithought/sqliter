---
description: A query that lists a `with` clause second in its `from` and joins on one of its columns crashes instead of returning rows; writing the same join the other way round works fine.
files:
  - packages/quereus/src/planner/nodes/cte-reference-node.ts   # mints fresh attribute ids per reference (buildAttributes, ~line 38)
  - packages/quereus/src/planner/building/select.ts            # builds the FROM list / join tree
  - packages/quereus/src/runtime/emit/cte-reference.ts         # emitter that registers the reference's row context
  - packages/quereus/test/logic/                               # where a .sqllogic regression case belongs
difficulty: medium
---

# Joining to a `with` clause listed second in `from` fails at runtime

## Symptom

```sql
create table o (id integer primary key, cat text, qty integer, rid integer) using memory;
create table r (id integer primary key, cat text, qty integer) using memory;

-- works, returns a count
with c as (select cat, qty, rid from o)
select count(*) from c join r on c.rid = r.id;

-- same join, sources swapped — throws
with c as (select cat, qty, rid from o)
select count(*) from r join c on c.rid = r.id;
```

The second statement raises:

```
QuereusError: No row context found for column rid. The column reference must be
evaluated within the context of its source relation.
```

No `analyze` is needed to reproduce; the tables need no particular contents.

## What is and is not affected

Confirmed by direct execution (each row a separate statement against the schema above):

| shape | result |
| --- | --- |
| `from c join r on c.rid = r.id` (the `with` clause first) | works |
| `from r join c on c.rid = r.id` | **throws** |
| `from r join c on r.id = c.rid` (operands of the condition swapped) | **throws** |
| `from r join c on c.qty = r.qty` (non-key column) | **throws** |
| `from r left join c on c.rid = r.id` | **throws** |
| `from r join c on r.id = r.id` (join condition names no column of `c`) | works |
| `from r join (select cat, qty, rid from o) c on c.rid = r.id` (inline subquery, no `with`) | works |
| `from r join o on o.rid = r.id` (plain table) | works |

So the trigger is: a reference to a `with` clause appears as the **second** source of
a join **and** the join condition names one of its columns. An inline subquery in the
same position is fine, which is what makes this specific to the `with` spelling.

The failure is also sensitive to what the statement selects — `select c.cat, r.cat
from r join c on c.rid = r.id limit 1` returned a row, while the `count(*)` form above
threw. So whichever join strategy the optimizer picks decides whether the bad path is
taken; the diagnosis should not assume one plan shape.

## Why this is being filed now

Found while reviewing `bug-cte-reference-loses-column-origin-attribution`. It is
**not** caused by that work: the same two statements were run with
`planner/util/column-origins.ts` and `planner/rules/predicate/rule-filter-selectivity.ts`
reverted to their pre-fix contents (commit `dbeafd08`) and the failure is identical.
Nothing in that ticket's diff touches attribute construction or the runtime.

What the review *did* surface is a second, milder symptom of what looks like the same
root cause. The error message says the column reference could not find its source
relation — i.e. the plan holds a `ColumnReference` whose attribute id nothing beneath it
publishes. That is directly observable: in the failing plan the residual `where`
predicate references attribute id *N* while the `CTEReferenceNode` under it publishes a
different, later-minted set. `CTEReferenceNode.buildAttributes` mints fresh ids on
every reference, so something in this shape appears to build the reference twice and
keep the predicate bound to the first one's ids. A consequence is that a `where`
conjunct over the `with` clause silently gets no row estimate in this join order (it
resolves to no known column), while the working order estimates it — but the estimate
is a side effect, not the bug.

## Expected behaviour

Both join orders return the same rows, as they do for the equivalent inline subquery.

## Suggested scope

- Reproduce and find where the second `CTEReferenceNode` is minted (or where the
  predicate is left bound to the first).
- A `.sqllogic` regression case covering both join orders, plus the `left join` and
  non-key-column variants from the table above, since they fail independently of which
  physical join is chosen.
