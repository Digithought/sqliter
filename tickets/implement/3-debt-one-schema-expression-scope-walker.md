---
description: Two schema-time checks that read the expressions written into a table definition each carry their own near-identical copy of the code that walks those expressions, so every fix has to be made twice by hand; merge them into one shared walk.
files:
  - packages/quereus/src/schema/rename/scope-frame.ts        # MOVES to schema/expr-scope/frame.ts
  - packages/quereus/src/schema/expr-scope/walk.ts           # NEW — the single traversal
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts
  - packages/quereus/src/schema/generated-column-refs.ts
  - packages/quereus/src/parser/visitor.ts                   # cross-reference NOTE only
  - packages/quereus/src/parser/ast.ts                       # node shapes (read-only)
  - packages/quereus/src/schema/table.ts                     # the two consumers (read-only)
  - packages/quereus/test/schema/expr-scope-walk.spec.ts     # NEW unit spec
difficulty: medium
---

# One scope-aware expression walk, two analyses on top of it

## Background

A table definition can contain expressions: a `check (...)` constraint body, a
`generated always as (...)` column body. Two schema-time analyses read those
expressions, and both need the same thing from them — walk the tree, keep track of
which `from` clauses inside it bind which names, and do something at every column
reference:

- `self-qualifier-strip.ts` **rewrites**: `check (t.qty > 0)` on table `t` becomes
  `check (qty > 0)`, unless an inner `from` could have bound `t` or `qty`.
- `generated-column-refs.ts` **reports**: every reference in a generated body,
  classified as `'own'` (the row being written), `'foreign'` (an inner source),
  `'unbound'` (a qualifier nothing binds), or `'unknown'` (undecidable).

The *frame model* they share — what a `from` binds, which sources the catalog can be
asked about, which are opaque — already lives in one place (`scope-frame.ts`). The
**traversal** does not: `visitStrip` (self-qualifier-strip.ts:75-189) and
`visitCollect` (generated-column-refs.ts:181-329) are two hand-written `switch`
statements over the same node kinds, arm for arm identical, differing only in what
they do at a column reference. They have already drifted (see the follow-on ticket
`debt-schema-scope-walk-uncovered-subtrees`).

This ticket merges the traversal with **no intended change to any behavior that
existing tests exercise**. The follow-on ticket then makes the single walk cover the
subtrees neither copy reaches. Keeping the two apart gives a clean bisect point: if a
guard-rail test moves, this ticket's diff is mechanical and the fault is obvious.

## Shape

### Move the frame model out of `rename/`

`schema/rename/scope-frame.ts` → `schema/expr-scope/frame.ts`, unchanged apart from
the doc comment's file references. `generated-column-refs.ts` has nothing to do with
renaming and currently reaches into `./rename/` for two imports; the new walk would
make that three. Only two files import it, so the move is four lines of churn.
Keep the exported symbol names as they are (`ScopeFrame`, `emptyScopeFrame`,
`opaqueScopeFrame`, `buildScopeFrame`, `collectScopeBindings`, `withScopeFrame`,
`isCteNameInScope`) — renaming them is noise.

`schema/rename/self-qualifier-strip.ts` **stays where it is**: it is re-exported
through `schema/rename-rewriter.ts`, which is the public seam its two planner callers
(`planner/building/constraint-builder.ts`, `planner/building/generated-column-scope.ts`)
import from. Do not move it or change that re-export.

### The new walk — `schema/expr-scope/walk.ts`

```ts
/** What a scope walk does when it reaches a name-bearing leaf. */
export interface ScopeWalkHandlers {
	/** Every `column` node reached. `stack[0]` is always the seed frame. */
	onColumn(col: AST.ColumnExpr, stack: ReadonlyArray<ScopeFrame>): void;
	/** Every bare `identifier` node reached in expression position. Omit when the
	 *  analysis has nothing to say about them (the self-qualifier strip). */
	onIdentifier?(ident: AST.IdentifierExpr, stack: ReadonlyArray<ScopeFrame>): void;
}

export interface ScopeWalkOptions {
	/** Lowercase schema an unqualified FROM table source belongs to — the owning
	 *  object's schema, NOT a search path. */
	readonly defaultSchema: string;
	/** Lowercase names the implicit seed frame binds (the owning table's name). */
	readonly seedBindings: ReadonlyArray<string>;
}

export function walkSchemaExpressionScope(
	root: AST.AstNode | undefined,
	options: ScopeWalkOptions,
	handlers: ScopeWalkHandlers,
): void;
```

`walkSchemaExpressionScope` builds the seed frame (an `emptyScopeFrame()` whose
`bound` holds every `seedBindings` entry), pushes it, and visits. Handlers receive the
live stack as a read-only view — they must not retain it past the call (it is mutated
as the walk unwinds); say so in the doc comment.

Internal state is one object (`{ options, handlers, stack }`) threaded through the
visit functions, mirroring the `StripState` / `CollectState` shape both files already
use. Decompose rather than growing one giant `switch` body: `visit`, `visitSelect`,
`visitDml`, `visitBarrier`, `visitResultColumns`, `visitWindowDefinition`.

### Behavior contract for this ticket

The merged walk must be **exactly the union of what the two copies do today**. Every
arm is already identical between them except the DML arms, which only
`visitCollect` has:

- `select` — verbatim from either copy: push a `withFrame`; for each CTE, visit its
  body under a barrier (`opaqueScopeFrame`) then add its name to `withFrame.cteNames`;
  build the FROM frame with `buildScopeFrame(stmt.from, options.defaultSchema, stack)`,
  push it, and under it visit result-column expressions, the `from` items, `where`,
  `groupBy`, `having`, `orderBy` exprs, `limit`, `offset`, `union`, and
  `compound.select`.
- `insert` / `update` / `delete` — `visitCollect`'s arms verbatim: one
  `opaqueScopeFrame` around the whole statement, CTE bodies under an additional
  barrier, then `source` (insert) / `targetSource` + `assignments` + `where`
  (update) / `targetSource` + `where` (delete). **Do not** add the sub-parts these
  arms skip (`returning`, `upsertClauses`, `contextValues`) — that is the follow-on
  ticket, and it is a real widening, not a tidy-up.
- `values`, `join`, `functionSource`, `subquerySource`, `binary`, `unary`, `cast`,
  `collate`, `function`, `subquery`, `windowFunction`, `windowDefinition`, `case`,
  `in`, `exists`, `between`, `column` — verbatim.
- `identifier` — call `handlers.onIdentifier` when supplied. The strip supplies none,
  which is exactly its current no-op.
- `default` — silently ignore. Unlike `parser/visitor.ts`'s `traverseAst`, do **not**
  warn: a schema expression legitimately contains `literal`, `parameter`, and `table`
  nodes with no names to hand over.

Why descending into DML is safe for the strip even though it does not descend today:
the DML arms push an opaque frame, and `stripColumnQualifier`'s capture loop returns
on the first frame with `hasOpaque`. So the strip visits more nodes and rewrites
exactly the same ones — none, inside a DML.

### Deliberately not descended

One block comment in `walk.ts` listing what the walk passes over and why, so the
next reader does not have to diff it against `traverseAst` to find out:

- `InsertStmt.table` / `UpdateStmt.table` / `DeleteStmt.table` / `TableSource.table` /
  `FunctionSource.name` — object names, not column references; the frame model
  already accounts for them.
- `ResultColumnExpr.inverse`, `SelectStmt.defaults`, window frame bound expressions
  (`WindowDefinition.frame`) — not reached yet; owned by
  `debt-schema-scope-walk-uncovered-subtrees`. Name that slug in the comment.

### Both analyses become handlers

`self-qualifier-strip.ts`: `stripSelfQualifierInSchemaExpression` keeps its exported
signature and its `changed` return. `visitStrip` and `visitStripBarrier` are deleted.
`stripColumnQualifier` takes the stack as a parameter instead of reading it off state:

```ts
walkSchemaExpressionScope(expr, { defaultSchema, seedBindings: [tableNameLower] }, {
	onColumn: (col, stack) => stripColumnQualifier(col, stack, state),
});
```

`generated-column-refs.ts`: `collectGeneratedColumnRefs` keeps its exported signature
and return type. `visitCollect` / `visitCollectBarrier` are deleted;
`classifyUnqualified`, `classifyQualified`, `recordColumnRef`, `recordIdentifierRef`
take the stack as a parameter. **Preserve the four-variant `RefBinding` exactly** —
`'own' | 'foreign' | 'unbound' | 'unknown'` — and `classifyQualified`'s opacity
tracking (an opaque frame crossed on the way out downgrades `'unbound'` to
`'unknown'`). That semantics is a recent bug fix; collapsing it would re-open the bug.

Both files keep their existing header comments — those explain the *analysis*, which
is still theirs. Move only the traversal-shape prose into `walk.ts`.

### Keep the generic visitor honest

`parser/visitor.ts`'s `traverseAst` is a third walk over the same node kinds, used by
`schema/manager.ts`. It is generic infrastructure with no scope model and is out of
scope here — but a future edit to the AST node shapes has to reach both. Add a
`NOTE:` line at the top of `traverseAst` and a matching one in `walk.ts` naming the
other, so a grep from either site finds its sibling. Do not attempt to unify them.

## Edge cases & interactions

- **The strip mutates the AST in place.** Its callers pass a clone
  (`test/schema/clone-expr-isolation.spec.ts` pins that). Descending into DML now
  visits subtrees the strip previously never touched — assert that clone-isolation
  spec still passes, and that no `col.table = undefined` happens under any barrier.
- **Seed frame identity.** `stack[0]` is the seed; both classifiers loop
  `for (let i = stack.length - 1; i >= 1; i--)` and `for (let i = 1; ...)`, i.e. they
  deliberately skip index 0. Do not change the seed's position or those bounds.
- **CTE name registration order.** A CTE body is visited *before* its own name is
  added to `withFrame.cteNames`, so a non-recursive CTE cannot see itself. Preserve
  the order exactly; a swap silently changes which sources `collectScopeBindings`
  treats as opaque.
- **`defaultSchema` is not a search path.** Both callers pass the owning object's
  schema name; `main.t.qty` inside an expression on `temp.t` is not a self-reference.
  The move must not turn this into a resolver lookup.
- **Empty / absent subtrees.** `walkSchemaExpressionScope(undefined, ...)` returns
  without touching the handlers; the strip's public entry already guards on this.
- **Nested selects inside a barrier.** A CTE body containing its own select must
  still build its own FROM frame *above* the barrier frame — barriers stack, they do
  not replace.
- **Handler-free identifiers.** With `onIdentifier` omitted, an `identifier` node
  must still be a terminal (no children to descend) — do not fall into `default` in a
  way that would warn or throw.

## Guard rails

These must be green and unchanged. Run `yarn test` from the repo root (streams; see
AGENTS.md) plus `yarn lint` and `yarn typecheck` in `packages/quereus`.

- `packages/quereus/test/logic/41-generated-column-scope.sqllogic`
- `packages/quereus/test/logic/41-generated-column-errors.sqllogic`
- `packages/quereus/test/logic/41-generated-columns.sqllogic`
- `packages/quereus/test/logic/41-generated-column-extras.sqllogic`
- `packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic`
- `packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic`
- `packages/quereus/test/logic/13.9-schema-authored-cte-isolation.sqllogic`
- `packages/quereus/test/logic/40-constraints.sqllogic`, `40.2-check-extras.sqllogic`
- `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`
- `packages/quereus/test/schema/clone-expr-isolation.spec.ts`
- `packages/quereus/test/schema/column-scope-body-spellings.spec.ts`

## New test — pin the walk itself, not just its two users

`packages/quereus/test/schema/expr-scope-walk.spec.ts`. Parse with
`parseExpressionString` (`src/parser/index.js`, the idiom
`test/schema/clone-expr-isolation.spec.ts` already uses), walk with a recording
handler, assert the recorded sequence of
`{ shape, name, qualifier, depth, sawOpaque }`. This is the generalized test the two
analyses inherit: a future node kind added to the walk gets covered here once instead
of twice, and the follow-on ticket extends this file rather than writing a third.

Cases worth pinning:

- bare `qty` in a bare expression → one `column` record at depth 1 (seed only),
  no opaque frame crossed.
- `t.qty` where the seed binds `t` → the handler sees the qualifier; the stack has
  no frame above the seed binding `t`.
- `(select qty from other)` → the record's stack has a FROM frame whose `realSources`
  holds `main.other`.
- `(with c as (select 1) select qty from c)` → the FROM frame is opaque (`c` is a CTE
  in scope), and the ref inside the CTE body sits under a barrier.
- `(select qty from (select 1) x)` → derived-table body under a barrier; the outer
  frame binds `x` and is opaque.
- `exists (insert into other values (1) returning k)` → the ref inside is reached and
  sits under an opaque frame. (This is the arm the strip did not have before.)
- an `identifier`-shaped leaf reaches `onIdentifier`, and a walk with no
  `onIdentifier` completes without error over the same input.

## TODO

Phase 1 — move and merge

- Move `src/schema/rename/scope-frame.ts` to `src/schema/expr-scope/frame.ts`; update
  the two importers and the file-path references in its own and their doc comments.
- Add `src/schema/expr-scope/walk.ts` with `ScopeWalkHandlers`, `ScopeWalkOptions`,
  `walkSchemaExpressionScope`, and the decomposed visit functions.
- Port the arms verbatim per the behavior contract above; add the
  "deliberately not descended" comment block naming
  `debt-schema-scope-walk-uncovered-subtrees`.
- Add the reciprocal `NOTE:` lines in `walk.ts` and `parser/visitor.ts`.

Phase 2 — rewire the two analyses

- `self-qualifier-strip.ts`: delete `visitStrip` / `visitStripBarrier`, pass
  `stripColumnQualifier` as `onColumn`, thread `stack` as a parameter. Public
  signature and the `rename-rewriter.ts` re-export unchanged.
- `generated-column-refs.ts`: delete `visitCollect` / `visitCollectBarrier`, pass
  `recordColumnRef` / `recordIdentifierRef` as handlers, thread `stack` as a
  parameter. `RefBinding`'s four variants and the opacity tracking survive intact.

Phase 3 — verify

- Add `test/schema/expr-scope-walk.spec.ts` with the cases above.
- `yarn build`, then `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
  from the repo root, then `yarn lint` and `yarn typecheck` in `packages/quereus`.
- Check whether `docs/schema.md` or `docs/sql-ddl.md` names either walker's file path;
  update if so. Do not add a new doc.
