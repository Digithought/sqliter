---
description: A view definition can name the schemas its tables should be looked up in. Reading such a view honoured that list but updating or deleting through it did not, failing with "table not found". The write now carries the list, and the three pieces of a view definition's naming environment travel as one marker instead of three.
files:
  - packages/quereus/src/parser/ast.ts                                # StoredBodyEnv (new, ~198-255); SelectStmt.storedBodyEnv replaces storedHomeSchema + storedBodyCTEs
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # buildViewMutation — the single stamp site (~92-134)
  - packages/quereus/src/planner/building/select.ts                   # buildSelectStmt — the consumption site and the 4-step order (~73-133)
  - packages/quereus/src/planner/building/select-context.ts           # buildStoredBodyCTEs — doc only; still keyed on the WithClause object
  - packages/quereus/src/planner/stored-body-context.ts               # doc only
  - packages/quereus/src/planner/mutation/scope-transform.ts          # mapNestedSelects — doc only
  - packages/quereus/src/planner/planning-context.ts                  # storedBodyOf / storedBodyCTECache — doc only
  - packages/quereus/test/view-home-schema.spec.ts                    # new describe at the tail (8 tests) + one doc comment updated
  - packages/quereus/test/view-cte-isolation.spec.ts                  # doc comment updated for the renamed marker
  - docs/view-updateability.md                                        # § Schema resolution during write-through — rewritten
difficulty: medium
---

# Review: a view definition's declared `with schema` path now reaches write-through lowering

## What changed

A `select` can end in `with schema a, b`, naming the schemas its unqualified table names
resolve against; a view definition is a `select`, so a view can carry one. Reading such a
view honoured the clause. Writing through it (`update` / `delete` / `insert`) honoured it
only for the definition's own `from` sources — any sub-query *inside* the definition
resolved on the view's plain home path, so the write and the matching read disagreed about
which tables exist.

A write through a view is not executed as the body plan; it is **lowered** into a plain
statement against the base table, with pieces of the definition (the view's own `where`,
each column's base-term expression, an authored `with inverse` put, a `with defaults` value)
copied in. That lowered statement is a mix of caller-authored clauses and definition-derived
fragments planned on one context, so "which naming environment does this piece belong to"
rides the AST node, not the context. The stamp carried two of the definition's three
environment pieces; the declared path was the missing third.

Three changes, in the shape the ticket specified:

- **The marker was folded.** `SelectStmt.storedHomeSchema` and `SelectStmt.storedBodyCTEs`
  are replaced by one `SelectStmt.storedBodyEnv: StoredBodyEnv` carrying `homeSchema`,
  `schemaPath`, and `withClause`. They were always stamped together, always consumed
  together, and their consumption order is load-bearing — one object gives that invariant
  one place to live. There were exactly five code references before the fold; there are
  three now (one declaration, one stamp, one read).
- **`buildViewMutation`** builds one `StoredBodyEnv` per lowering, reading all three pieces
  off the body's top-level select under the existing `!ephemeral && type === 'select'`
  guard, and stamps it via `mapNestedSelects`. The `rejectDataModifyingBodyCTE` gate reads
  the same `withClause`.
- **`buildSelectStmt`** consumes it in a fixed four-step order, now spelled out in the
  comment there: (1) `storedBodyContext` — home path, caller's CTE namespace cleared;
  (2) override with the definition's declared path; (3) build the carried `with` clause on
  *that* context; (4) the fragment's own `with schema` clause still wins. Steps 2-and-3
  ordering is the load-bearing part — reversed, a carried block's own sources resolve on
  the plain home path and the build fails inside `buildStoredBodyCTEs`.

The declared path is deliberately **not** pushed into `storedBodyContext`: that function is
shared with the read path, takes only a schema name, and has no access to the body AST.

## Validation

`yarn lint` clean. `yarn test` clean — 11 209 passing, 0 failing across all workspaces.

New coverage lives at the tail of `packages/quereus/test/view-home-schema.spec.ts`, in
`a view definition carries its declared 'with schema' path into write-through lowering`
(8 tests). Both reproductions from the source ticket were confirmed red before the change
and are green after:

```sql
create table main.wa (id integer primary key, x integer);
create table temp.wt (id integer primary key);
insert into main.wa values (1, 10), (2, 20);
insert into temp.wt values (1);

-- (1) sub-query in the definition's own `where`
create view main.wv as select id, x from wa where id in (select id from wt)
  with schema "temp", main;
update main.wv set x = 48 where id = 1;        -- was: Table 'wt' not found in schema path: main

-- (2) sub-query reading a block from the definition's own leading `with` clause
create view main.wp as with c as (select id from wt)
  select id, x from wa where id in (select id from c) with schema "temp", main;
update main.wp set x = 48 where id = 1;        -- was: the same error, raised one level deeper
```

The rest of the block covers: `delete` through the same view; a fragment sub-select whose
**own** `with schema` outranks the carried path (precedence, passed before the change too);
the control where a definition with no clause stays on the home path in a case where a
declared path would have differed; a materialized-view arm (a different adapter object
reaches the same funnel); and an insert-through arm via `with defaults (col = (select …))`
(a different copy channel onto the same stamp).

`test/view-cte-isolation.spec.ts` (the carried-`with`-clause sibling) is unchanged apart
from a doc comment naming the renamed marker; its 34 tests still pass, which is the
regression floor for the fold.

## Known gaps — please probe these

- **Set-operation right legs are still broken, at a different site.** The ticket asked for a
  compound probe. Result: the **left** leg of a `union` definition inherits the declared path
  structurally (`leftBranchSelect` spreads the compound's root node, which is where the
  parser attaches the clause), so it works and is pinned by a test. The **right** leg does
  not — `rightBranchSelect` spreads the right operand, which the parser never lets carry the
  clause — so a sub-query in a right leg still fails with
  `Table '<t>' not found in schema path: <home>`. This is the branch **body**'s path, not the
  fragment marker, so it is outside this ticket's site. Filed with a verified reproduction as
  `fix/bug-setop-right-leg-write-drops-declared-schema-path`; the passing left-leg test's
  comment names it. Worth confirming the same asymmetry in the flag-less set-op path
  (`buildFlaglessLeg`), which the ticket did not investigate.
- **`insert` coverage is one channel deep.** The insert arm exercises `with defaults`; an
  authored `with inverse` put expression rides the same stamp through
  `cloneInverseClause` and is untested *for the declared-path arm specifically* (it is
  covered for the home-schema and carried-`with`-clause arms elsewhere in the same files).
- **No lens / decomposition / multi-source arm** for the declared path. All of those route
  through the same single `buildViewMutation` stamp, so they should be free — but "should be
  free" is an argument, not a test.
- **Nothing pins the step-2/step-3 ordering directly.** The `with`-clause reproduction fails
  if the order is reversed, so it pins it *in effect*, but a reviewer swapping the two lines
  should see that test go red — worth verifying that is actually what happens rather than
  taking the comment's word for it.

## Sibling relationships

`fix/bug-view-write-subquery-shadow-analysis-wrong-schema` is the analysis-side sibling: it
resolves a fragment's `from` sources against one fixed schema rather than any path, at
`tableSourceColumnNames` in `planner/mutation/scope-transform.ts`. The fold delivered here is
what makes the two able to share one answer — that analysis walks the same AST, so it can now
read a fragment's whole naming environment off `SelectStmt.storedBodyEnv` instead of
reassembling it from separate fields. Nothing in that ticket was touched here beyond doc
comments, so it has no `prereq:` on this one; its fix stage should know the shape is already
there.

`fix/bug-view-write-lineage-subquery-base-table-qualifier` is in the same machinery at a
third site (qualifier spelling); no overlap.

## Pre-existing, not mine

`yarn docs:check` fails on the `docs/schema.md` word-count ratchet. Already listed in
`tickets/.pre-existing-known.md` against `debt-doc-size-ratchet-red-at-head`; `docs/schema.md`
is not in this diff. `docs/view-updateability.md` (which is) stayed under its own ratchet.
