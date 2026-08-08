---
description: When a maintained table is rebuilt after one of its source columns changed type, the engine checks the rebuilt rows against the table's OLD column type and only changes the type afterwards — so the rows are checked under the wrong rules and, in between, the table's stored values disagree with the type it says they have.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # classifyBackingReshape (~2213) queues `retype` post-reconcile; reshapeBackingInPlace runs rebuildBacking (~1386) — which validates — before those ops
  - packages/quereus/src/runtime/emit/materialized-view.ts           # refreshMaintainedTable (~159) — the caller
  - packages/quereus/src/schema/constraint-builder.ts                # validateChecksOverExistingRows (~285) — the scan that sees the transitional state
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # pins the current behaviour as a documented limitation (3 tests)
  - docs/materialized-views.md                                       # § REFRESH MATERIALIZED VIEW "Known limitation — type-sensitive CHECK on the reshape arm"
repro: verified
difficulty: hard
---

# What is wrong

A **maintained table** is a table whose contents the engine derives from a query over other
tables and keeps up to date automatically. When one of those source columns changes type,
the maintained table has to be reshaped: its own column takes the new type and its contents
are rebuilt from the source.

Today the reshape runs in this order:

1. rebuild the contents from the source (the rows now carry the **new** type's values);
2. validate the rebuilt contents against the table's declared constraints — still using the
   **old** column type;
3. change the column's declared type.

Two things go wrong because step 3 is last.

**The check runs under the wrong rules.** A `check (v < '9')` on a column moving from text
to whole numbers is evaluated as a *text* comparison in step 2 (where `'10' < '9'` is true,
because text compares letter by letter) and never re-evaluated as a *number* comparison
(where `10 < 9` is false). A row that violates its own constraint under the final type is
committed and survives. This is already pinned as a documented limitation in
`maintained-table-refresh-revalidation.spec.ts` and in `docs/materialized-views.md`.

**Between steps 1 and 3 the table lies about itself.** Its catalog says the column is text
while every stored value is a number. The engine's own physical-representation checker
(`QUEREUS_REPR_STRICT`, `runtime/strict-representation.ts`) catches this at the scan that
step 2 performs and refuses the refresh:

```
repr-strict: representation mismatch at module 'memory' query() row for main.mt column 1 (v):
declared type TEXT admits a string, but the value is a JS number (10) (rule R2).
```

That is the whole of the strict checker's current failure list against the test suite — 3
tests, all in `maintained-table-refresh-revalidation.spec.ts`, all this one cause. Until it
is resolved, `yarn test:repr-strict` cannot be added to the repository's `yarn check` chain
(a note to that effect sits on `check` in the root `package.json`).

# Expected behavior

The declared type change lands **before** the rebuilt contents are validated, so that:

- constraints are evaluated under the type the column actually ends up with;
- no point in the operation exposes rows whose JavaScript form disagrees with their
  column's declared type, to any reader — including the engine's own validation scan.

# Why this is not a small move

The current ordering is deliberate, and the existing code comments name the constraints:
the data-validating column ops (`retype`, `recollate`, tighten-NOT-NULL) are queued
post-reconcile precisely so they validate the *reconciled body rows* rather than the
backing contents that are about to be discarded. Moving `retype` earlier means moving it
into the window *after* the contents are replaced but *before* they are validated, which is
a third position the two-phase plan does not currently have. `docs/materialized-views.md`
additionally cites commit-first ordering and attach-path parity as blockers for closing the
CHECK half of this.

# Use cases to cover

- Source column `v` retyped text → integer, maintained table has `check (v < '9')`, a row
  holding `'10'`: the refresh must now REJECT the row (it violates the check under the
  final integer type) rather than committing it.
- The collation sibling (`recollate`) behaves consistently with whatever is decided for
  `retype` — there is a parallel "recollate limitation" block in the same spec.
- The three currently-failing tests in `maintained-table-refresh-revalidation.spec.ts` pin
  the OLD (limitation) behavior and will need rewriting to pin the new behaviour; they are
  the specification of what changes.
- After the fix, run `yarn test:repr-strict` — it must be clean — and add it to the root
  `check` chain, removing the `//check-repr` note.
