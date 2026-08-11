---
description: Two different parts of a parsed query are both labelled "column", so code that scans a query for column references can pick up a result-list item by mistake and crash; make the two labels distinct.
files:
  - packages/quereus/src/parser/ast.ts                                  # ColumnExpr and ResultColumnExpr, both `type: 'column'`
  - packages/quereus/src/planner/analysis/predicate-shape.ts            # walkAstNodes + columnIndexFromExpr / collectColumnNames
  - packages/quereus/src/planner/analysis/assertion-classifier.ts       # predicateReferencesForeignColumns — hand-rolled walk, same shape
  - packages/quereus/src/planner/building/select-aggregates.ts          # mentionsSelectListAlias — where the collision was hit and worked around
difficulty: medium
tradeoffs: Renaming an AST tag touches every switch, visitor, and stringifier that matches on it, and each individual walker can be patched with a one-line `typeof name === 'string'` guard instead — a maintainer may reasonably prefer the cheap guards over a repo-wide rename.
---

# `ResultColumnExpr` and `ColumnExpr` are both `type: 'column'`

## What is wrong

The parsed form of a query (its abstract syntax tree, AST) tags each node with a
`type` string. Two structurally unrelated nodes share the tag `'column'`:

```ts
// packages/quereus/src/parser/ast.ts
export interface ColumnExpr extends AstNode {   // a reference TO a column: `t.a`
	type: 'column';
	name: string;
	table?: string;
	schema?: string;
}

export type ResultColumnExpr = {                // one item of a SELECT list: `x + 1 as c`
	type: 'column',
	expr: Expression,
	alias?: string,
	inverse?: ReadonlyArray<ResultColumnInverse>,
}
```

A `ResultColumnExpr` has no `name`. So any code that walks an AST subtree, matches
`node.type === 'column'`, and then reads `node.name` throws
`TypeError: Cannot read properties of undefined (reading 'toLowerCase')` the moment
the subtree contains a select list — i.e. the moment the expression contains a
subquery. The error surfaces to the user as `Planning error: Cannot read properties
of undefined (reading 'toLowerCase')`, with no indication of which query construct
caused it.

The two nodes never overlap in a *typed* position — nothing declares a slot that
accepts either — so TypeScript never catches the confusion. It only bites walkers
that discover children reflectively (or by hand) and therefore see both.

## Evidence

**Verified.** Implementing `bug-ungrouped-aggregate-order-by-cannot-see-its-own-columns`
added an alias scan built on `walkAstNodes` (`mentionsSelectListAlias` in
`select-aggregates.ts`). Every ORDER BY containing a subquery immediately crashed:

```sql
select count(*) as zz from g order by (select 1);
-- Planning error: Cannot read properties of undefined (reading 'toLowerCase')
```

`walkAstNodes` reached the inner select's `columns` array, whose items are
`ResultColumnExpr`. That ticket worked around it locally with a
`typeof col.name !== 'string'` guard and a comment; the collision itself is
untouched.

**Suspected, not confirmed, at a second site.**
`predicateReferencesForeignColumns` in `assertion-classifier.ts` is a hand-rolled
walk with the same `node.type === 'column'` → `col.name.toLowerCase()` shape, and it
runs *before* the classifier's subquery rejection gate. Several attempts to reach it
(an assertion whose inner `where` contains an `in (select …)`, a CHECK constraint with
a subquery, a partial index with a subquery) did **not** crash — the classifier or an
earlier validation bailed first in each case. What would confirm it: a
`create assertion` whose body structurally matches the classifier's
`not exists (select … from T where <predicate>)` pattern with a subquery inside
`<predicate>`, reaching line 110 of `assertion-classifier.ts`. `collectColumnNames`
and `columnIndexFromExpr` in `predicate-shape.ts` have the same shape and the same
open question.

## What to build

Make the confusion unrepresentable rather than guarding each walker. The obvious
form: give the SELECT-list node its own tag (e.g. `type: 'result-column'`), leaving
`'column'` to mean "a reference to a column" everywhere. Then a walker matching
`'column'` is right by construction, and the existing `typeof name` guards can go.

That rename reaches the parser, every `switch` / visitor over result columns, the
AST stringifier, and any test fixture that writes result columns literally. An
alternative shape — renaming `ColumnExpr`'s tag instead — is worse: column
references are the far more numerous match site.

Whatever tag scheme is chosen, the acceptance test is behavioural, not textual: a
query with a subquery inside every clause that gets AST-walked (ORDER BY, GROUP BY,
HAVING, a CHECK body, an assertion body, a partial-index predicate) must plan without
a `TypeError`.
