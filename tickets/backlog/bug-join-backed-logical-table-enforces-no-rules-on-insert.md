----
description: |
  When an application-schema table is backed by two underlying tables joined together, inserting a
  row through it skips every rule the application schema declares — required values, uniqueness,
  and references to other tables are all ignored. Updating the same table does apply them.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts # `buildMultiSourceInsert` (~1026) — passes an empty extra-constraint list at its `buildInsertStmt` call (~1094)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # the collectors whose output is dropped on this path
  - docs/lens.md # § Constraint Attachment — states which write paths carry which seam
difficulty: medium
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: |
  Nobody has shown that such a table can carry enforceable rules in the first place — the checker
  that decides which declared rules are enforceable may already reject every one of them for a
  join-backed table, in which case there is nothing to enforce and this is a no-op; a maintainer may
  want that question settled before any code changes.
----

# A join-backed logical table applies none of its declared rules on insert

## What is missing

A logical (application-schema) table can be backed in three ways: by one underlying table, by
several underlying tables split column-wise, or by several underlying tables joined together. The
first two apply the rules the application schema declares — `check`, uniqueness, references — to
every write. The third applies them on update and delete, but **not on insert**: the insert builder
hands each side of the join an empty list of extra rules to enforce, so every rule the deploy
derived is silently dropped for that statement.

This is a different site from the NULL-write problem fixed in
`lens-row-local-checks-skipped-when-value-is-null` — that one was about *when* a rule was consulted
on a column-wise split; this one is about a whole write path never being handed the rules at all.
It is pre-existing, and was noticed while reviewing that fix.

## What would confirm it

Nobody has built a join-backed logical table that carries an enforceable rule and watched an insert
slip past it. Confirming needs exactly that: a logical table whose body joins two underlying tables,
a `check` (or unique key, or foreign key) on the logical table that the deploy classifies as
enforceable, and an insert that violates it. If the deploy refuses to classify any rule as
enforceable for a join-backed table, the finding is moot and this ticket should be closed with that
recorded — which is itself worth knowing, since the documentation currently reads as though this
path enforces the same way the single-table path does.

## Shape of the fix, if it is real

The update path already collects the same rules and gates each one onto the base operation that
owns the columns it references. The insert path should reuse that, not grow a parallel collector.
The one thing to decide is what happens to a rule whose columns span both sides of the join — the
column-wise-split path answers this explicitly (it either rides the one side that owns every column
it names, or is deferred to the end of the statement), and the join path should give the same
answer rather than inventing a second one.

## Filed from the Lamina board

Written on Lamina's board during a review pass there, but every file it names is in this repository,
so it is filed here rather than worked from the other side — Lamina's `AGENTS.md` now requires that
for cross-repo work, direct commits being reserved for trivial updates.

Filed into `backlog/` rather than `fix/` deliberately: queue priority here is this repo's call, not
the filer's. Check the header for `repro:` and `severity:` when triaging.

**Sibling ticket:** this was filed alongside the other lens-enforcement bug from the same pass
(`bug-join-backed-logical-table-enforces-no-rules-on-insert` /
`bug-lens-check-skipped-when-write-uses-a-conflict-clause` — whichever this is not). They sit in the
same subsystem (`planner/building/view-mutation-builder.ts`, `planner/mutation/lens-enforcement.ts`,
`docs/lens.md` § Constraint Attachment) but at different sites, so they were filed as two tickets
rather than one. Whoever takes either should read both — a fix that unifies the constraint-attachment
seam may retire both at once, which is the higher rung.

No Lamina-side change is pending on either; Lamina has no workaround in place for them.
