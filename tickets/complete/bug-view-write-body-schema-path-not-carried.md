---
description: A view definition can name the schemas its tables should be looked up in. Reading such a view honoured that list but updating or deleting through it did not, failing with "table not found". The write now carries the list, and the three pieces of a view definition's naming environment travel as one marker instead of three.
files:
  - packages/quereus/src/parser/ast.ts                                # StoredBodyEnv (new, ~206-257); SelectStmt.storedBodyEnv replaces storedHomeSchema + storedBodyCTEs
  - packages/quereus/src/planner/building/select-context.ts           # enterStoredBodyEnv (new, ~90-150) — the whole marker consumption; buildStoredBodyCTEs
  - packages/quereus/src/planner/building/select.ts                   # buildSelectStmt — now a 2-line call plus the fragment's own `with schema` (~73-85)
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # buildViewMutation — the single stamp site (~92-135)
  - packages/quereus/src/planner/mutation/scope-transform.ts          # mapNestedSelects — doc only
  - packages/quereus/src/planner/stored-body-context.ts               # doc only
  - packages/quereus/src/planner/planning-context.ts                  # doc only
  - packages/quereus/test/view-home-schema.spec.ts                    # new describe at the tail (10 tests)
  - packages/quereus/test/view-cte-isolation.spec.ts                  # doc comment updated for the renamed marker
  - docs/view-updateability.md                                        # § Schema resolution during write-through
---

# A view definition's declared `with schema` path now reaches write-through lowering

## What shipped

A `select` can end in `with schema a, b`, naming the schemas its unqualified table names
resolve against; a view definition is a `select`, so a view can carry one. Reading such a
view honoured the clause. Writing through it (`update` / `delete` / `insert`) honoured it
only for the definition's own `from` sources — any sub-query *inside* the definition
resolved on the view's plain home path, so the write and the matching read disagreed about
which tables exist.

A write through a view is lowered into a plain statement against the base table, with
pieces of the definition (the view's own `where`, each column's base-term expression, an
authored `with inverse` put, a `with defaults` value) copied in. That lowered statement
mixes caller-authored clauses with definition-derived fragments on one context, so "which
naming environment does this piece belong to" rides the AST node, not the context. The
stamp carried two of the definition's three environment pieces; the declared path was the
missing third.

- `SelectStmt.storedHomeSchema` and `SelectStmt.storedBodyCTEs` are folded into one
  `SelectStmt.storedBodyEnv: StoredBodyEnv` carrying `homeSchema`, `schemaPath`, and
  `withClause` — always stamped together, always consumed together, in a load-bearing
  order.
- `buildViewMutation` builds one `StoredBodyEnv` per lowering from the body's top-level
  select and stamps it onto every nested sub-select via `mapNestedSelects`.
- Consumption is `enterStoredBodyEnv` (`planner/building/select-context.ts`), called at the
  top of `buildSelectStmt`: (1) `storedBodyContext` — home path, caller's CTE namespace
  cleared; (2) override with the definition's declared path; (3) build the carried `with`
  clause on *that* context. Step 4, back in `buildSelectStmt`: the fragment's own
  `with schema` clause still wins.

## Validation

`yarn lint` clean. `yarn test` clean across all workspaces. `yarn docs:check` fails only on
`docs/schema.md`, which is pre-existing and tracked (see below).

## Review findings

### Verified, not just read

- **The step-2-before-step-3 ordering claim.** Swapped the two lines and re-ran: the
  carried-block test fails inside `buildStoredBodyCTEs` exactly as the handoff predicted.
  Restored.
- **Regression strength of the new block.** Disabled step 2 alone: 8 of the 10 tests in the
  new describe go red, and the two that stay green are precisely the two controls (a
  fragment's own `with schema` outranking the carried path; a definition with no clause
  staying on the home path). The block pins the behaviour rather than the implementation.
- **The fold is complete.** Grepped every `.ts` and `.md` for `storedHomeSchema` /
  `storedBodyCTEs`: no live code reference survives.
- **The per-lowering CTE memo still holds.** `storedBodyCTECache` is keyed on the `with`
  clause AST object, and the declared path is now applied before the memoized build — safe
  only because one lowering stamps one shared env on all its fragments, so every fragment
  reaching the memo built on the same path. Parked as a `NOTE:` tripwire on
  `buildStoredBodyCTEs`.
- **Type surface.** `StoredBodyEnv.schemaPath?: string[]` matches
  `PlanningContext.schemaPath`; no widening or assertion needed at the assignment.

### Fixed in this pass (minor)

- **Three `env!` non-null assertions** in `buildSelectStmt`, forced by narrowing a boolean
  `storedSwap` instead of the value. Replaced with a narrowed `swapEnv` local.
- **A 55-line comment wall around 6 lines of logic** at the top of `buildSelectStmt`.
  Extracted the whole marker consumption into `enterStoredBodyEnv`
  (`planner/building/select-context.ts`, next to `buildStoredBodyCTEs`, which it calls); the
  essay is now that function's docstring, and the call site is two lines. Every NOTE the
  implementer wrote — the schema-name-not-body-identity guard, the explicit-`parentCTEs`
  hazard, why the declared path is not folded into `storedBodyContext` — is preserved.
- **Two uncovered copy channels** for the declared-path arm: a sub-select in a view column's
  defining expression, and one in an authored `with inverse` put expression (the handoff
  named the second as a gap). Both confirmed red with step 2 disabled.
- **`docs/view-updateability.md` said "Two related defects … remain open"** — there are now
  three; the set-op right-leg ticket the implementer filed was not listed. Listed it, and
  repointed the consumption site at `enterStoredBodyEnv`.
- **A stale symbol in an open ticket.** `tickets/fix/bug-view-write-subquery-shadow-analysis-wrong-schema`
  told its fix stage to read `AST.SelectStmt.storedHomeSchema`, which no longer exists.
  Repointed at `storedBodyEnv` and noted that the whole environment now reads off one field
  — which is the point of the fold for that ticket.

### Major — no new tickets filed

The one real remaining defect, set-operation right legs losing the declared path, was
already filed by the implementer as `fix/bug-setop-right-leg-write-drops-declared-schema-path`
with a verified reproduction. Re-derived it independently and confirmed the diagnosis: the
right operand *is* stamped, but its branch body is planned under a context that is already
at-home, so the marker is inert there and the branch body has no path of its own. Appended
one thing the ticket was missing — the shortcut a fix-stage agent will reach for first
(honour the marker even when at-home) regresses nested `with schema` precedence, which the
new precedence test pins. Nothing else rose to a ticket.

### Tripwires (recorded, not filed)

- `buildStoredBodyCTEs` memo key assumes one shared env per lowering — `NOTE:` at that
  function in `planner/building/select-context.ts`.

### Checked and deliberately left alone

- **No lens / decomposition / multi-source test arm** for the declared path. All spines read
  the single `storedBodyEnv` built before any spine dispatch in `buildViewMutation`, and six
  distinct arms through that stamp are now pinned (plain `where`, carried block, defining
  expression, `with inverse`, `with defaults`, materialized view, set-op left leg). Adding
  three more spines would re-test one line. Not filed.
- **`view-mutation-builder.ts` is 1372 lines** (`wc -l`). Pre-existing size debt; this
  ticket's net contribution is about ten lines. Not this change's finding, not filed.
- **The `StoredBodyEnv` object is built even for an ephemeral target**, where it is
  discarded. One object literal per plan build; not worth the branch.

### Pre-existing, not mine

`yarn docs:check` fails on the `docs/schema.md` word-count ratchet, already listed in
`tickets/.pre-existing-known.md` against `debt-doc-size-ratchet-red-at-head`. `docs/schema.md`
is not in this diff; `docs/view-updateability.md` (which is) stays under its own ratchet with
room to spare.

## Siblings still open

- `fix/bug-setop-right-leg-write-drops-declared-schema-path` — the set-op branch body's own
  path (different site).
- `fix/bug-view-write-subquery-shadow-analysis-wrong-schema` — the analysis-side sibling. It
  walks the same AST, so it can now read a fragment's whole naming environment off
  `SelectStmt.storedBodyEnv` in one read; its notes were updated to say so.
- `fix/bug-view-write-lineage-subquery-base-table-qualifier` — same machinery, third site
  (qualifier spelling); no overlap.
