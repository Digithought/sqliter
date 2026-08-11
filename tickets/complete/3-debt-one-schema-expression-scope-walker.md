---
description: Two schema-time checks that read the expressions written into a table definition carried near-identical copies of the code that walks those expressions; they now share one walk, with no change in behavior.
files:
  - packages/quereus/src/schema/expr-scope/frame.ts             # moved from schema/rename/scope-frame.ts
  - packages/quereus/src/schema/expr-scope/walk.ts              # the single traversal
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # a handler over the walk
  - packages/quereus/src/schema/generated-column-refs.ts        # a handler over the walk
  - packages/quereus/src/parser/visitor.ts                      # reciprocal NOTE: only
  - packages/quereus/test/schema/expr-scope-walk.spec.ts        # 37 cases
difficulty: medium
---

# One scope-aware expression walk, two analyses on top of it

A table definition can hold expressions: a `check (...)` constraint body, a
`generated always as (...)` column body. Two schema-time analyses read them, and each
walked the tree itself with an arm-for-arm identical `switch`:

- **`self-qualifier-strip.ts`** rewrites — `check (t.qty > 0)` on table `t` becomes
  `check (qty > 0)`, unless an inner `from` could have rebound `t` or `qty`.
- **`generated-column-refs.ts`** reports — every reference in a generated body,
  classified `'own'` / `'foreign'` / `'unbound'` / `'unknown'`.

They are now one function.

- `schema/rename/scope-frame.ts` → `schema/expr-scope/frame.ts`, contents unchanged
  apart from file references in its header comment; exported names all kept.
- New `schema/expr-scope/walk.ts`: `walkSchemaExpressionScope(root, options, handlers)`
  with `ScopeWalkOptions { defaultSchema, seedBindings }` and
  `ScopeWalkHandlers { onColumn, onIdentifier? }`, decomposed into `visit`,
  `visitSelect`, `visitDml`, `visitBarrier`, `visitResultColumns`,
  `visitWindowDefinition`.
- Both analyses keep their exported signatures; the four classifier/recorder functions
  take the frame stack as a parameter instead of reading it off their state object.
  `self-qualifier-strip.ts` stayed in `rename/`, still re-exported through
  `schema/rename-rewriter.ts` (the seam its two planner callers import from).
- Reciprocal `NOTE:` comments in `walk.ts` and `parser/visitor.ts` so a grep from
  either finds the other; `traverseAst` otherwise untouched.

The one behavior widening: the strip's old walk had no `insert` / `update` / `delete`
arms and stopped at a DML node, so the merged walk *visits* DML subtrees for the first
time. It still rewrites nothing there — each DML arm pushes an opaque frame and the
strip's capture loop returns at the first frame with `hasOpaque`.

The walk still skips six kinds of sub-expression on purpose (`returning` lists, upsert
clauses, `contextValues`, `with inverse (...)`, `with defaults (...)`, window frame
bound expressions). Both predecessors had exactly these gaps; closing them is
`debt-schema-scope-walk-uncovered-subtrees` (`tickets/implement/`), which also owns the
compound-leg frame fault the merge exposed.

## Review findings

**Checked.** Read the implement diff before the handoff prose. Compared the merged
walk arm-for-arm against both deleted walks: every arm of the collector's walk is
present, the strip's walk was a strict subset, and the DML arms are the only added
reach. Re-derived the no-rewrite claim independently — any leaf inside a DML, CTE body,
or derived-table body has an opaque frame at stack index ≥ 1, and
`stripColumnQualifier`'s capture loop returns there before it can clear `col.table`.
Confirmed both ordering invariants (seed at `stack[0]` with every classifier loop
starting at 1; a CTE's name registered only after its own body is walked) and the
`defaultSchema` plumbing (the strip passes the owning schema, the collector passes
`schemaName` — the same values the predecessors used). Grepped for dangling
`scope-frame` references: none outside ticket archives. Confirmed the ticket's claim
that the parser produces `identifier` nodes only for table and pragma names
(`parser/parser.ts:955`, `:4169`), so `onIdentifier` genuinely has no SQL-level path;
the arm came over unchanged and was left alone.

**Docs — read, no update warranted.** `docs/architecture.md` lists `schema/` only at
directory level, so the new subdirectory needs no entry. `docs/schema.md` §"Stored
bodies resolve against their home schema" / §"Schema-authored expressions never see the
writing statement's namespace" describe semantics this change did not touch.
`docs/sql-ddl.md:364` states the self-qualifier is folded away — still true.
`docs/schema-rename-detection.md`'s `with defaults` prose is about the column-rename
walk, a different walker. No doc names any of the moved files.

**Fixed inline (minor).** The implementer's spec was explicitly a floor: node kinds the
`switch` descends had only transitive coverage through sqllogic. Added 17 cases —
`case` (both spellings), `in` over a value list and over a subquery, `between`, scalar
`subquery`, `cast`, `collate`, `unary` (both spellings), `function`, `join` plus its
condition, `functionSource` args, `group by` / `having` / `order by` / `limit` /
`offset`, both compound legs, `values` under a derived table, and a terminal-kinds case.
Each asserts only which leaves are reached and in what order, so
`debt-schema-scope-walk-uncovered-subtrees` can change frame shapes without churning
them. 20 cases → 37.

Also added a compile-time coverage ledger to the spec:
`EXPRESSION_KINDS: Record<AST.Expression['type'], 'descend' | 'leaf' | 'terminal'>`.
A new expression node kind cannot enter the AST union without a recorded decision,
because `yarn lint` typechecks test files — that is the class guard behind the
individual cases, whose failure mode is silent (a node kind the walk does not descend
hides a reference; a hidden reference in a generated body means no dependency edge and
a column computed before what it reads). Limitation, stated in the spec comment: it
covers the `Expression` union only. The statement and clause kinds the walk also
switches on (`select`, the three DML kinds, `join`, `subquerySource`, `values`,
`windowDefinition`) are not in that union and get no compile-time guard.

**Tripwire recorded (not a ticket).** `visitDml` never registers a DML-attached CTE's
name on a frame, unlike `visitSelect`'s with-clause frame, so `from <cte>` below it
reads as an askable real table source of that name. Inert today: the whole DML sits
under one opaque frame, so every leaf below is undecidable for the collector and
unstrippable for the strip regardless. `NOTE:` at the site in `walk.ts` with the
revisit condition — if the DML barrier is ever narrowed to less than the whole
statement, register the names first.

**Major findings — none filed, two candidates already owned.** Both concerns I reached
independently are arms of `debt-schema-scope-walk-uncovered-subtrees` in
`tickets/implement/`: the six deliberately-skipped sub-expression kinds (its changes
1–4), and the compound-leg frame fault — `union` / `compound.select` visited inside the
leading leg's FROM-frame push, so a bare name in the second leg can be captured by the
first leg's source and come back `'foreign'`, costing a dependency edge (its change 5,
with the same consequence and the same fix I would have proposed). That ticket already
states both arms; nothing to append.

**Considered and left as-is.** The frame stack is handed to handlers as a read-only
view of the walk's live, mutating array — a retained reference would read the wrong
stack. Copying per leaf would allocate on every reference; the contract is documented
on `ScopeWalkHandlers.onColumn` and both handlers read eagerly. Not worth changing.

**Accepted tradeoffs.** None recorded — no finding landed on a site carrying an
existing accepted-tradeoff `NOTE:`.

## Validation

- `yarn build` — clean.
- `yarn test` (repo root, all workspaces) — **0 failing**; `packages/quereus` reports
  **9365 passing, 25 pending** (9348 before this review pass; +17 is the new spec
  cases).
- `yarn lint` and `yarn typecheck` in `packages/quereus` — both exit 0.
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` written.
- Guard rails all green: `41-generated-column-scope`, `41-generated-column-errors`,
  `41-generated-columns`, `41-generated-column-extras`,
  `41.13-alter-add-column-generated-backfill`,
  `41.14-alter-add-column-subquery-backfill`, `13.9-schema-authored-cte-isolation`,
  `40-constraints`, `40.2-check-extras`, `41.3-alter-rename-propagation`, plus
  `test/schema/clone-expr-isolation.spec.ts` and
  `test/schema/column-scope-body-spellings.spec.ts`.

Net across the three touched source files: 319 lines deleted, 78 added.
