description: |
  When a query says "this column equals a written-out value OR equals a placeholder", the planner
  rewrites it into a single IN list but records the wrong thing for the written-out branches, and
  the query fails with an internal error. Fix what gets recorded, and add a guard so a similar
  mistake fails loudly at planning time instead of deep inside execution.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts        # collapseBranchesToIn (~line 768) — the two bad pushes; columnSideOf (~line 1151) — model for the new helper
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # consumers: single-col multi-seek (~580), composite cross-product (~633-717)
  - packages/quereus/src/planner/analysis/change-scope.ts                # third consumer (~614) — verified unaffected, do not change
  - packages/quereus/test/plan/                                          # where the regression spec goes
----

# OR-collapsed IN must record each branch's *value* expression, not the whole comparison

## What is wrong, in plain terms

`where col = 10 or col = :p` is rewritten by the planner into the single equivalent
`where col in (10, :p)`. Alongside the list of values, the planner keeps a parallel list of
*expressions* — one per list member — so that a storage module can see how each member is
supplied (a written-out constant, a query parameter, a correlated column, ...).

For a member that came from a written-out constant, the planner stores the **entire
comparison** (`col = 10`) in that parallel list instead of just the value (`10`). A storage
module that offers to answer this `IN` as an index lookup then receives `col = 10` as a lookup
key. A lookup key is evaluated *before* any row is read, so evaluating an expression that
mentions `col` is impossible, and the query dies with:

```
No row context found for column i. The column reference must be evaluated within
the context of its source relation.
```

## Reproduction — verified, and reproducible with no external module

The originating report (lamina board, `bug-or-with-a-placeholder-branch-crashes`) said an
in-memory Quereus table was unaffected. **That is not correct** — it is unaffected only when
the column has no index. Add an index (or use the primary key) and the built-in memory module
claims the collapsed `IN` as a multi-seek (`vtab/memory/module.ts`, `evaluateIndexAccess` →
`setSeekColumns`), so every shape below throws against a plain `using memory` table:

```sql
create table p (id integer primary key, i integer, t text) using memory;
create index p_i on p(i);
create index p_t on p(t);

select i  from p where id = 1    or id = :p    -- primary key
select id from p where i  = 10   or i  = :p    -- indexed integer
select id from p where t  = 'aa' or t  = :p    -- indexed text
select id from p where i = 10 or i = 20 or i = :p
select id from p where i in (10, 20) or i = :p -- the *IN-branch* arm, below
```

and, on a composite key, the composite cross-product path throws too:

```sql
create table c (a integer, b integer, v integer, primary key (a, b)) using memory;
select v from c where a = 1 and (b = 1 or b = :p)
```

Controls that already pass and must keep passing: `i = 10 or i = 30` (all literal — no
parallel expression list is built at all), `i = :p or i = :q` (all dynamic), and
`i in (10, :p)` written directly (where the list is built from the author's own value
expressions, which is exactly the shape this ticket restores).

## Root cause — one function, two sibling sites

`collapseBranchesToIn` (`constraint-extractor.ts`, ~line 768) builds the parallel array
`valueExprs`. Two of its four arms push the constraint's `sourceExpression` — the whole
comparison node — where the other two push a genuine value expression:

- **Equality branch with a literal value** pushes the `BinaryOpNode` for `col = 10`.
- **All-literal `IN` branch** pushes the `InNode` for `col in (10, 20)`, once per member.

Both are wrong for the same reason and fix at the same place. The correct content is the
member's own value expression, which is already sitting inside the source node: the non-column
operand of the comparison, or the positionally-matching element of the `IN` node's value list.
This is precisely what `extractInConstraint` stores for a directly-written `in (10, :p)`
(`result.valueExpr = expr.values`), which is why that form has always worked.

### Nothing depends on the current (wrong) contents

Checked all three consumers of the array form:

- `rule-select-access-path.ts` single-column multi-seek (~line 580) — uses the array verbatim
  as seek keys. Broken today; fixed by this change. Its own comment ("some values are
  dynamic") already describes the *intended* contract, which supports the read that the
  `sourceExpression` fill was never deliberate.
- `rule-select-access-path.ts` composite cross-product (~lines 633-717) — prefers
  `exprs[valueIdx]` over the literal value when present, so it is broken today in the same
  way, and fixed by the same change.
- `change-scope.ts` (~line 614) — reads `c.value[i]` first and only falls back to the
  expression when the value is `undefined` (i.e. a dynamic member). It therefore never touches
  a literal position's entry and is unaffected either way. **Do not change it.**

## Second arm — make the class fail loudly at the seam

This defect was silent at plan time and only surfaced as a confusing runtime error from deep
inside expression evaluation. The invariant it violated is simple and checkable:

> A seek key handed to `IndexSeekNode` for table T may reference columns of *other* relations
> (that is an ordinary correlated / index-nested-loop seek), but it can never reference a
> column of **T itself** — T's row is not in scope when its own lookup key is computed.

Add that check where seek keys are materialized in `rule-select-access-path.ts` (all the
`new IndexSeekNode(...)` call sites in this rule that pass a `seekKeys` array) and raise a
clear internal planner error naming the offending column and constraint. The check is a walk
over a handful of small expressions, so cost is not a concern.

Mechanics: `constraint-extractor.ts` already has a private `collectColumnRefAttributeIds`
(~line 311) doing exactly the walk needed; export it or add a local equivalent. The
"belongs to T" test is membership in `tableRef.getAttributes()` ids. Note that
`extractBinaryConstraint` already declines same-table column references on the value side for
this same reason (see its `sameTable` early return) — this guard is the backstop for values
that arrive by other routes, such as the OR collapse.

## Verified patch

Prototyped, run, and reverted — the working tree is clean; reproduce it as below. With it
applied, all eight shapes above pass, the full `packages/quereus` suite is green
(**10248 passing, 25 pending**, `node test-runner.mjs --no-bail` from `packages/quereus`), and
`yarn lint` in that package exits 0.

```diff
@@ function collapseBranchesToIn(
 	branches: { constraints: PredicateConstraint[] }[],
 	template: PredicateConstraint,
 	sourceExpr: ScalarPlanNode
-): { constraints: PredicateConstraint[] } {
+): { constraints: PredicateConstraint[] } | null {
@@
 			} else {
-				// All literal IN — push placeholder source expressions
-				for (const _v of c.value as SqlValue[]) {
-					valueExprs.push(c.sourceExpression);
+				// All-literal IN branch: the members' own expressions, positionally
+				// aligned with `c.value` (`extractInConstraint` maps 1:1 over
+				// `InNode.values`).
+				const src = c.sourceExpression;
+				if (!(src instanceof InNode) || !src.values || src.values.length !== (c.value as SqlValue[]).length) return null;
+				for (const ve of src.values) {
+					valueExprs.push(ve);
 				}
 			}
@@
 			} else {
-				valueExprs.push(c.sourceExpression);
+				// Literal equality branch: the value operand, never the whole
+				// comparison — a consumer materializes these as seek keys.
+				const src = c.sourceExpression;
+				if (!(src instanceof BinaryOpNode)) return null;
+				const valueSide = valueSideOf(src, c.attributeId);
+				if (!valueSide) return null;
+				valueExprs.push(valueSide);
 			}
```

plus a new helper beside `columnSideOf`:

```ts
function valueSideOf(src: BinaryOpNode, attributeId: number): ScalarPlanNode | undefined {
	const l = unwrapCast(src.left);
	if (l.nodeType === PlanNodeType.ColumnReference && (l as unknown as ColumnReferenceNode).attributeId === attributeId) return src.right;
	const r = unwrapCast(src.right);
	if (r.nodeType === PlanNodeType.ColumnReference && (r as unknown as ColumnReferenceNode).attributeId === attributeId) return src.left;
	return undefined;
}
```

Notes on the patch, for whoever applies it:

- The prototype inserted `valueSideOf` immediately *above* the doc comment that documents
  `columnSideOf`, orphaning that comment. Place the new function (with its own doc comment)
  after `columnSideOf` instead.
- The new `null` returns make `collapseBranchesToIn` fall through to `tryCollapseToOrRange`
  and then to "leave the OR residual" — a completeness loss only, never a wrong answer. In
  practice they are unreachable: the collation pre-gate in `tryExtractOrBranches` already
  requires every branch's `sourceExpression` to be a recognised `BinaryOpNode` (with an
  identifiable column side) or `InNode`, and declines the whole collapse otherwise. Keep them
  as defence, and update `collapseBranchesToIn`'s doc comment to state the array's contract:
  *every element is an expression evaluating to that member's value; never the branch's
  source comparison.*
- `unwrapCast` is used deliberately to *find* the column side, while the returned value side
  is the **raw** operand — matching `extractBinaryConstraint`, which keeps a converting cast
  in `valueExpr` on purpose.

## TODO

- Fix both `valueExprs.push(c.sourceExpression)` sites in `collapseBranchesToIn` per the patch
  above; add `valueSideOf` with a doc comment, placed after `columnSideOf`.
- Update `collapseBranchesToIn`'s doc comment and the `PredicateConstraint.valueExpr` field
  comment to state the array contract explicitly.
- Add the seek-key row-context invariant check in `rule-select-access-path.ts` covering every
  `seekKeys` array passed to `IndexSeekNode` from that rule; raise a named internal planner
  error, not a silent decline.
- Add a regression spec (a new `packages/quereus/test/plan/*.spec.ts` — these shapes need bound
  parameters, so a `.sqllogic` file is not the right home) covering: primary key, indexed
  integer, indexed text, three-way OR, `in (…) or col = :p`, the composite
  `a = 1 and (b = 1 or b = :p)`, and the three passing controls (all-literal OR, all-parameter
  OR, direct `in (10, :p)`). Assert returned rows, not just absence of a throw.
- Add a focused test for the new invariant check if it can be triggered without reintroducing
  the bug (e.g. a unit-level call); if it cannot be reached from SQL, say so in the handoff
  rather than contriving one.
- Validate: `yarn test` from the repo root (the fix-stage prototype run covered only the
  `packages/quereus` workspace), and `yarn lint`. `yarn test:store` was not run at fix stage —
  run it only if the reviewer asks; nothing here is store-specific.
