---
description: When a query defines a temporary named result set that happens to share its name with a real table, one internal analysis pass picks the real table while the actual query execution picks the temporary one — so an update written through a view or through that temporary name can be rejected or rewritten to mean something other than the matching read.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts    # tableSourceColumnNames, ~line 494-518
  - packages/quereus/src/planner/building/select.ts             # buildFrom — the resolution order it must match
  - docs/view-updateability.md                                  # ~line 125 states the same-order requirement
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Only bites when a CTE deliberately shadows a real table of the same name, and the usual outcome is a rejected statement rather than a wrong answer, so a maintainer may prefer to make the analysis conservative instead of aligning two resolution orders.
---

# Two passes disagree on which relation an ambiguous bare FROM name means

## The rule that is supposed to hold

`docs/view-updateability.md` (§ the static shadow analysis) states it plainly: the pass
that decides which columns a FROM source owns "must resolve that name **on the same
environment, in the same order**, as `buildSelectStmt` does — otherwise the analysis and
the plan disagree about which object a `from` name denotes, and the disagreement is not
conservative: the shadow set decides the opposite of the truth, so the lowered statement
is either rejected outright or silently rewritten to mean something else than the
matching read."

## Where the orders differ

- `buildFrom` (`planner/building/select.ts`, the `fromClause.type === 'table'` branch)
  checks the statement's common-table-expression map **first**, and only falls through
  to the schema catalog when the name is not a CTE. A CTE therefore shadows a
  same-named real table — the ordinary SQL rule.
- `tableSourceColumnNames` (`planner/mutation/scope-transform.ts`, ~line 495) calls
  `findSchemaItem` **first** and reaches the CTE map only when the catalog lookup
  missed. Its own comment asserts the opposite ("A schema object of the same name was
  already resolved above, so this only fires for a genuine context-backed name"),
  which is exactly the inverted precedence.

So for a bare name that matches **both** a CTE and a real table, the analysis takes the
table's column set while the plan binds the CTE. Where their column names differ, the
shadow set is wrong in the direction the doc calls non-conservative.

## Reachability

Inferred from reading the two code paths; not yet observed running. The analysis only
runs when lowering a write through a view or through a common-table-expression name, and
its planning context only carries CTE definitions in the latter case — so the shape to
try is a write whose target is a `with` name, whose body reads a *prior sibling* `with`
definition, where a real table of that sibling's name also exists with **different**
column names. Something like:

```sql
create table s (a integer primary key, b integer);
with s as (select id as x, val as y from other),
     t as (select x, y from s)
update t set y = 1 where x = 2;
```

Confirming it means writing that as a sqllogic case and checking whether the lowering is
rejected (or rewrites to the wrong columns) while the equivalent `select` reads the CTE.
If the shape turns out to be unreachable today, the fix is still cheap and the code
comment is still wrong — but the priority drops.

## Expected behaviour

The static pass consults the planning context's common-table-expression definitions
**before** the schema catalog, matching `buildFrom`, so both agree on which relation an
ambiguous bare name denotes. The qualified-name case is handled separately — see
`bug-qualified-table-name-binds-cte`, which makes `buildFrom` honour a schema qualifier
so both passes ignore CTEs for qualified names.

## Notes

- Found while working `bug-qualified-table-name-binds-cte`, which touches the same
  function's comment but a different site and a different root cause. That ticket
  deliberately leaves this one alone.
- The comment in `tableSourceColumnNames` that asserts the wrong precedence should be
  corrected as part of whatever lands here.
