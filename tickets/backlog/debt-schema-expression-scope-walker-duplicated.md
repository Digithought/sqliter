---
description: Two schema-time analyses walk expression trees with near-identical hand-written code, so a fix or a new syntax form applied to one silently misses the other; they have already drifted apart in three places.
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts   # visitStrip — 115 lines of traversal
  - packages/quereus/src/schema/generated-column-refs.ts         # visitCollect — 149 lines of traversal
  - packages/quereus/src/schema/rename/scope-frame.ts            # the shared frame model both already use
  - packages/quereus/src/parser/ast.ts                           # the node shapes both walk
difficulty: medium
tradeoffs: The two walkers work today and the drift found so far only affects syntax nobody writes in a constraint or generated expression, so a maintainer could reasonably leave two working copies alone rather than risk a refactor of the delicate CHECK-rewrite path.
---

# One scope-aware expression walker, not two hand-written copies

## What exists now

Two schema-time analyses need the same thing: walk an expression that belongs to a
table definition (a CHECK constraint body, a `generated always as (...)` body),
tracking which `FROM` clauses inside it bind which names, and do something at each
column reference.

- `self-qualifier-strip.ts` walks a CHECK body and *rewrites* it: a reference
  qualified with the owning table's own name gets the qualifier removed, unless an
  inner `FROM` could have bound it.
- `generated-column-refs.ts` walks a generated body and *reports* every reference,
  classified as belonging to the owning table's row, to some inner source, or
  undecidable.

The frame model they share — what a `FROM` binds, which sources the catalog can be
asked about, which are opaque — was already extracted into `scope-frame.ts`. The
**traversal** was not. `visitStrip` (self-qualifier-strip.ts:72-186, 115 lines) and
`visitCollect` (generated-column-refs.ts:159-307, 149 lines) are two hand-written
`switch` statements over the same 16 node kinds, structurally identical arm for arm,
differing only in what they do when they reach a column reference.

## Why it is worth fixing

The two copies have already drifted, in three ways found while reviewing the change
that created the second copy:

- **Statements that modify data, written inside an expression.** A generated body
  may contain something like `(select … from (insert … returning …) q)`. The
  generated-column walker descends into that inner statement; the CHECK walker does
  not descend at all, so a self-qualified reference inside one never gets rewritten.
- **Window frame bounds.** Neither walker looks at the expressions in a
  `rows between <expr> preceding and …` clause. A reference appearing *only* there
  is invisible to both — no dependency recorded, no qualifier rewritten. (This was
  also true of the generic tree-walk the generated-column analysis used before, and
  is marked `// TODO` there, so it is not new.)
- **View write-through metadata attached to result columns** (`with inverse (...)`,
  and a select's trailing `with defaults (...)` clause). Neither walker descends
  into those subtrees.

None of these is reachable by anything a person is likely to write today, which is
why this is debt rather than a bug. The cost is the shape of the problem: every
future fix, and every new expression form the parser learns, has to be applied twice
by hand, and nothing catches it when it is not. A third analysis needing the same
walk would make it three.

## What "done" looks like

One traversal, in one file, that carries the scope-frame stack and hands each column
reference (and each bare identifier) to a caller-supplied action along with the
current stack. The two existing analyses become the two actions. Adding an
expression form, or teaching the walk about a subtree it currently skips, is then a
single edit that both analyses inherit.

The three drift items above are the natural acceptance cases: after the merge, each
should be either handled by the one walker or explicitly and visibly skipped in one
place, not silently absent from one copy and present in the other.

Behavior must not change for anything currently exercised — `packages/quereus/test/logic/41-generated-column-scope.sqllogic`,
`41.14-alter-add-column-subquery-backfill.sqllogic`, and the CHECK self-qualifier and
column-rename suites are the guard rails.
