---
description: Generated-column formulas now resolve names scope-aware — a name bound by a FROM clause inside the formula belongs to that source, so subqueries over other tables no longer trigger false "column not found" or false circular-dependency errors.
files:
  - packages/quereus/src/schema/rename/scope-frame.ts           # NEW — conservative FROM-frame model, extracted from self-qualifier-strip
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # repointed at scope-frame.ts; behavior unchanged
  - packages/quereus/src/schema/generated-column-refs.ts        # NEW — collectGeneratedColumnRefs (own/foreign/unknown classification)
  - packages/quereus/src/schema/table.ts                        # dependency extraction + ADD COLUMN pre-flight rewritten on the collector
  - packages/quereus/src/schema/manager.ts                      # CREATE TABLE call site threads the catalog resolver
  - packages/quereus/src/schema/column-source-resolver.ts       # header caller list refreshed (review)
  - packages/quereus/src/runtime/emit/alter-table.ts            # 3 re-analysis sites threaded; resolver hoisted per-ALTER (review)
  - packages/quereus/src/planner/building/alter-table.ts        # ADD COLUMN pre-flight threads the resolver
  - packages/quereus/test/logic/41-generated-column-scope.sqllogic                 # NEW — CREATE/ALTER arms (+3 review arms)
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic  # unqualified arm added, workaround comment removed
  - docs/sql-alter.md                                           # ADD COLUMN "one current exception" note deleted
  - docs/sql-ddl.md                                             # Generated Columns — resolution rule stated (tightened in review)
---

# Scope-aware reference analysis for generated-column expressions

## What shipped

One scope-aware reference collector for `generated always as (<expr>)` bodies,
consumed by both schema-time analyses so they give one answer to "does this name
bind the owning table's row?".

- `schema/rename/scope-frame.ts` — the conservative `FROM`-frame model (bound
  qualifiers, catalog-askable real sources, opaque flag, CTE names) extracted from
  the CHECK self-qualifier strip, which now consumes it unchanged.
- `schema/generated-column-refs.ts` — `collectGeneratedColumnRefs` returns every
  column / identifier reference in a generated body classified `own` (binds the row
  being computed), `foreign` (binds an inner `FROM` source), or `unknown` (an
  opaque subquery / function / CTE source intervenes, so it cannot be decided).
- `schema/table.ts` — dependency-graph extraction and the ALTER ADD COLUMN
  pre-flight both rewritten on the collector. An `own` reference to a known column
  records a dependency edge and to an unknown name raises the original "not found";
  a `foreign` reference is ignored; an `unknown` reference records an edge when the
  name is a known column and is otherwise ignored. Questions about the table under
  analysis are answered from the in-flight column list rather than the catalog
  (CREATE: absent; DROP COLUMN: pre-drop; ADD COLUMN: plus the new column).
- Every call site threads the shared catalog-backed `buildColumnSourceResolver`.

Net effect: a generated expression may now read another table through a subquery
without qualifying the inner names, and two generated columns reading another
table's like-named columns no longer produce a false cycle. Both existing error
messages are byte-identical and the ADD COLUMN duplicate-column suppression is
preserved.

## Review findings

Implement diff read first, before the handoff summary. Lint, the full workspace
test suite, and the store-backed run of the touched logic files were all run at the
end of the pass and pass (numbers under *Validation* below).

### Checked and clean — nothing found

- **Node coverage of the new walker.** Every member of the `AST.Expression` union
  (`packages/quereus/src/parser/ast.ts:27`) has an arm in `visitCollect`; the only
  kinds reaching `default` are `literal` and `parameter`, which hold no
  sub-expressions. A missed kind here would silently drop a dependency edge, so
  this was checked exhaustively rather than sampled.
- **Frame classification against the strip walker.** The collector scans frames
  innermost-first and stops at the first source exposing the name; the strip scans
  outermost-first and stops at the first opaque frame. The collector is strictly
  more precise, and both err toward the safe side of their respective analyses
  (collector: record an edge; strip: decline to rewrite). No case found where the
  collector answers `foreign` for a reference that genuinely binds the row.
- **Choice of default schema for unqualified table names inside the body.** The
  collector passes the *owning table's* schema, with no search-path fallback. This
  is not a gap: `docs/schema.md:353` states that a generated-column expression
  resolves relation names against the owning table's schema only, so a body naming
  a relation in another schema must qualify it. Behavior matches the documented
  rule.
- **Agreement between the ADD COLUMN pre-flight and the emitter's re-analysis.**
  The pre-flight answers questions about the target table from the post-ALTER
  column set, so it accepts exactly the set the emitter will. Walked the
  self-reference, duplicate-column, and cycle paths by hand; they agree.
- **Call-site coverage.** All six sites that recompute the graph or run the
  pre-flight thread a resolver; nothing was left on a default.
- **Interactions the change newly enables**, exercised against a built database
  before deciding they were correct: the cross-table DROP COLUMN guard refuses a
  drop reached only through an unqualified subquery name; the RENAME COLUMN cascade
  rewrites such a body and the value still computes; an inner name that also names
  a column of the table being defined resolves to the subquery's source at both
  analysis time and evaluation time (they agree). All three are now test arms — see
  below.

### Minor — fixed in this pass

- `runAddColumn` built a fresh catalog resolver at each of two re-analysis sites,
  one of them *inside* the per-inline-constraint loop. Hoisted to one per ALTER
  statement, with a note on why sharing it is safe (it reads the live catalog per
  call, so sharing does not freeze answers between rounds).
  `packages/quereus/src/runtime/emit/alter-table.ts:842`
- The header of `buildColumnSourceResolver` opened "Four callers, one definition"
  and enumerated them. This change added five more. Rewritten to list the current
  set, including the two module-side ALTER hooks.
  `packages/quereus/src/schema/column-source-resolver.ts:10`
- **Test gaps.** The implementer's arms covered the collector's own classification
  well but stopped at the module boundary. Added three arms to
  `41-generated-column-scope.sqllogic`: the cross-table DROP COLUMN refusal and
  RENAME COLUMN cascade through an unqualified subquery name; an inner name
  shadowing a column of the table being defined, asserted at both ALTER-backfill
  and later-INSERT time; and a negative arm locking the one behavior change in the
  reject direction (`generated always as (new.nosuch + 1)` is now refused at DDL
  time — confirmed by hand first, since it was accepted before this change and
  failed only at the first write).
- `docs/sql-ddl.md` § Generated Columns stated the new resolution rule but not its
  two consequences a reader will actually hit: that an unrebound `new.<name>` which
  is not a column is a typo like any other, and that an unqualified cross-table
  reference is visible to the DROP / RENAME COLUMN guards. Both added.

### Major — filed

- **The two scope-aware walkers are hand-written duplicates.** The frame model was
  extracted and shared, but the traversal was not: `visitStrip`
  (`self-qualifier-strip.ts:72-186`, 115 lines) and `visitCollect`
  (`generated-column-refs.ts:159-307`, 149 lines) are two `switch` statements over
  the same 16 node kinds, identical arm for arm, differing only at the leaf action.
  They have already drifted in three places (statements-inside-expressions are
  walked by one and not the other; window frame bounds and view write-through
  metadata subtrees are walked by neither). None is reachable by anything a person
  is likely to write, so this is debt, not a bug — but every future fix has to be
  applied twice by hand with nothing catching a miss. Filed at the invariant rung
  rather than as three point fixes: one walker parameterized by the leaf action
  makes the drift unrepresentable, and the three items become its acceptance cases.
  `tickets/backlog/debt-schema-expression-scope-walker-duplicated.md`

### Conditional — recorded, not filed

Nothing new. The two conditional concerns this code carries already have `NOTE:`
comments at their sites and neither has tripped: the opaque-source residual at
`generated-column-refs.ts:23` (an own-column name reachable only through an opaque
source still yields a spurious edge, and a mutual pair of those still raises a false
cycle), and the per-inline-constraint round-trip cost at
`runtime/emit/alter-table.ts:883`, which now also covers the per-round re-analysis
this change added.

### Considered and not filed

- A reference spelled `main.t.a` loses its dependency edge when an inner `FROM`
  aliases `t`. This is deliberate parity with the strip walker
  (`self-qualifier-strip.ts:192-194`), which applies the same alias-wins rule, and
  the spelling cannot be evaluated on the write path at all — that is the sibling
  `generated-column-one-row-scope` ticket's territory, not a new defect here.
- Window frame bounds, `with inverse`, and `with defaults` subtrees going unwalked
  is pre-existing — true of the generic tree-walk this replaced (which carries its
  own `TODO`) and of both walkers today. Folded into the debt ticket above as
  acceptance cases rather than filed separately; they resolve at the same site.

## Validation

- `yarn build` — clean.
- `yarn lint` (eslint + the test-file type pass) — clean.
- `yarn test` (all workspaces) — green; `packages/quereus` alone: **9233 passing,
  0 failing, 25 pending**.
- `node test-runner.mjs --store --grep "41"` — **47 passing, 1 pending** (the
  pending one is a pre-existing memory-only skip).

## Known limits carried forward

- Accepting more schemas means a newly-legal schema depends on its referenced
  tables being resolvable when the graph is recomputed. Store import replays DDL in
  original order, so every legally-created schema re-analyzes consistently; a
  catalog manipulated out-of-band could surface "not found" where creation
  succeeded.
- The write path still cannot evaluate a schema-qualified self reference
  (`main.t.a` inside the body) — the analysis accepts it and records the edge, as
  the previous code did. Sibling ticket `generated-column-one-row-scope` owns that.
- `temp.x.y` unquoted does not parse in expression position (a contextual-keyword
  gap in the parser's three-part column arm), so the tests spell it `"temp".x.y`.
  Unrelated to this change.
