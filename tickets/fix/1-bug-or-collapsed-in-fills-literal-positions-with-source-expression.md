description: |
  When a query says "this column equals a written-out value OR equals a placeholder", the planner
  rewrites it into a single IN list but records the wrong thing for the written-out branches. A
  virtual-table module that accepts that IN as an index lookup then gets un-evaluatable lookup keys
  and the query fails with an internal error.
repro: verified
files:
  - src/planner/analysis/constraint-extractor.ts   # collapseBranchesToIn — pushes c.sourceExpression at literal positions
  - src/planner/rules/access/rule-select-access-path.js  # the multiSeek arm that uses inConstraint.valueExpr verbatim as seekKeys
----

# OR-collapsed IN records the whole comparison, not the value, at literal positions

Filed from the lamina board (`bug-or-with-a-placeholder-branch-crashes`), where this surfaces
as a hard failure on an extremely ordinary query shape.

## The defect

`collapseBranchesToIn` turns `col = A or col = B` into one `IN` constraint. When any branch is
non-literal it also builds a parallel `valueExprs` array so a module can see each member's
binding. For an **equality branch whose value is a literal**, it pushes `c.sourceExpression` —
the whole `col = 10` `BinaryOpNode` — into that array, where every other producer of
`valueExpr` puts the *value* expression.

`rule-select-access-path`'s multi-seek arm then does, for a mixed-binding IN:

```js
if (Array.isArray(inConstraint.valueExpr)) {
    // Mixed-binding IN (from OR collapse): some values are dynamic ...
    seekKeys = inConstraint.valueExpr;
}
```

so the literal positions become seek keys that are column-referencing comparisons. Evaluating
one outside a row context throws:

```
No row context found for column i. The column reference must be evaluated within
the context of its source relation.
```

## Reproduction

Any module that advertises `seekColumnIndexes` for the column and reports the collapsed `IN`
as handled will hit it. Verified through the lamina virtual-table module (`lamina-quereus`),
where every one of these throws:

```sql
select id from p where i  = 10   or i  = :p   -- integer
select id from p where t  = 'aa' or t  = :p   -- text
select id from p where b  = true or b  = :p   -- boolean
select i  from p where id = 1    or id = :p   -- primary key
select id from p where i = 10 or i = 20 or i = :p
```

while `i = 10 or i = 30` (all literal), `i = :p or i = :q` (all parameters) and
`i in (10, :p)` (written directly as a list, where `valueExpr = expr.values` is correct at
every position) all work. A plain in-memory Quereus table also works — it does not claim the
constraint as a seek, so the bad keys are never evaluated.

## Expected behaviour

A literal branch's entry in the collapsed `valueExprs` array should be an expression that
evaluates to that branch's value — the same thing `extractInConstraint` produces for a
directly-written `in (10, :p)` list — so a module claiming the collapsed `IN` receives usable
seek keys for every position.

Worth checking in the same pass whether any consumer relies on the current contents. The
comment at the multi-seek arm reads as though the array were value expressions, which suggests
the `sourceExpression` fill was never intentional.
