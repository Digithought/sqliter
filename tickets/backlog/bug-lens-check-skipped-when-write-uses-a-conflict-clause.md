----
description: |
  Some rules a deployed application schema declares can only be checked after a write has landed.
  When a write asks the database to skip or replace conflicting rows instead of failing, those
  rules get checked too early — before the new data exists — so they see nothing wrong and let bad
  data through.
files:
  - packages/quereus/src/runtime/row-constraints.ts # `mustEvaluateNow` (~328) — the site that forces an after-the-write check to run early
  - packages/quereus/src/planner/building/view-mutation-builder.ts # `rejectLensSetLevelConflictResolution` (~863) and `rejectRowLocalDeferredConflictResolution` — the two hand-written guards this would replace
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # `synthesizeLensRowLocalDeferredConstraint` — synthesizes one such after-the-write check
  - docs/lens.md # § Constraint Attachment — documents both guards
difficulty: hard
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: |
  Both known instances are now guarded by refusing the write outright, so nothing is silently wrong
  today; a maintainer may reasonably prefer two cheap refusals over building a general mechanism
  that also has to answer what "skip the offending row" even means for a check that only runs once
  the whole statement is done.
----

# Checks that must run after a write are forced to run before it

## What goes wrong

Some rules the database enforces cannot be answered until the write has actually landed. Two exist
today over lens-backed (application-schema) tables:

- a **uniqueness** rule with no index behind it, answered by counting rows at the end of the
  statement;
- a **row rule that reads other tables**, answered by re-reading the written row back out of the
  application-schema view at the end of the statement.

Both are queued to run at the end. But the runtime refuses to queue anything when the statement
asks for non-default conflict handling — `or ignore`, `or fail`, `or rollback`, `or replace` — on
the reasoning that skipping or replacing an offending row is something you can only do while the
row is in your hand. So the rule is run early instead. Run early, a rule that reads the written row
back out sees a table that does not contain it yet, finds nothing wrong, and the violating row is
written and kept.

Observed directly (Quereus, 2026-08-11), against a lens-backed table with a row rule that reads
another table:

```sql
-- CHECK: exists (select 1 from Allowed where Allowed.name = tag)
insert           into app.W (id, name, tag) values (2, 'beta', 'nope');   -- correctly rejected
insert or ignore into app.W (id, name, tag) values (2, 'beta', 'nope');   -- ACCEPTED, row persists
insert or fail   into app.W (id, name, tag) values (2, 'beta', 'nope');   -- ACCEPTED, row persists
insert or replace into app.W (id, name, tag) values (2, 'beta', 'nope');  -- ACCEPTED, row persists
```

The uniqueness rule has the same shape. Its own guard refuses `or replace`, `or ignore` and upserts
up front, and its comment states that `or fail` and `or rollback` "are fine — they ABORT". That
reasoning does not match the runtime: the runtime only leaves a rule queued when the action is
`abort`, so `or fail` and `or rollback` force it early too, where the count is taken before the new
row exists. Not reproduced — inferred from reading both sites. Confirming it needs a lens-backed
table whose logical unique key has no covering materialized view behind it, and an
`insert or fail` of a duplicate.

## Why it is not urgent

The row-rule instance above was found during review of
`lens-row-local-checks-skipped-when-value-is-null` and is now **guarded**: that statement shape is
refused with a loud diagnostic naming the check, instead of silently writing bad data. So the known
hole is closed. What remains is that the closure is two hand-written guards at two call sites, plus
one comment that states the wrong rule — the next after-the-write check anyone adds inherits the
trap and nothing catches it.

## What would actually retire this

A check that can only be answered after the write should not be *representable* as one the runtime
may choose to run early. Concretely: mark it at synthesis (a "must defer" property on the
constraint), have the runtime honour that marker ahead of the conflict-handling rule, and decide
once — in one place — what a non-default conflict clause means for such a check. The two options
are to refuse the statement (what both guards do by hand today) or to keep the rule deferred and
downgrade the conflict handling to plain failure. Either is fine; what matters is that it is
answered once, at the seam, rather than re-answered per constraint class by whoever remembers.

That change also lets both hand-written guards be deleted and the stale comment removed.

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
