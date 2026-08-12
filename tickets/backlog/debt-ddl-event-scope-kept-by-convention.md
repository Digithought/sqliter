----
description: The rule that a failed schema-changing statement must announce nothing is currently kept by every such statement remembering to opt in by hand — a new one that forgets silently brings the bug back, with nothing to catch it.
files:
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts
  - packages/quereus/src/runtime/register.ts
  - packages/quereus/src/runtime/emitters.ts
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/src/runtime/emit/schema-declarative.ts
difficulty: medium
tradeoffs: The convention is documented, greppable, and currently complete, so a maintainer may reasonably say a one-line-per-emitter opt-in is cheap and explicit — and that centralizing it hides a behavior that readers of a single emitter can see today.
----

# The success-path-only announcement rule is enforced by convention, not by construction

## What is in place today

A statement that changes the schema (`create table`, `drop table`, `create index`,
`create materialized view`, `alter table`, …) tells listeners what changed. If the statement
fails part-way, it must tell them nothing — otherwise a peer device replicating those events
builds an object the originating device never kept.

The engine gets that by having each schema-changing statement's implementation wrap its work
in one helper, `withStatementScopedSchemaEvents` (`packages/quereus/src/runtime/emit/ddl-event-scope.ts`),
which drops any event the statement raised if the statement then throws. There are 14 such
call sites across 12 files, each an identical hand-written wrapper — measured with
`grep -rn "withStatementScopedSchemaEvents(rctx" packages/quereus/src --include=*.ts`.

Nothing checks that a fifteenth remembers. The helper's own docstring tells the reader to
grep the statement-registration block of `runtime/register.ts` and confirm every entry calls
it — a manual audit, run by whoever happens to think of it.

## Why this is worth hardening rather than leaving

This is not hypothetical: the class already shipped once. `alter table` got the wrapper when
the leak was first found; the ten-odd object-lifecycle statements did not, and `create table …
maintained as` demonstrably announced a create and then a drop for a statement that did
nothing. Closing that took its own ticket (`ddl-statement-schema-event-atomicity`, now in
`tickets/complete/`). The fix left the *same* enforcement model in place, just with more
sites obeying it — so the next statement added is one forgotten wrapper away from re-opening it,
and the symptom (a subscriber or a syncing peer seeing a phantom object) shows up far from
the cause.

## What "enforced by construction" would mean

Two shapes are worth weighing; the ticket does not pick one.

**Apply the scope where statements are registered.** Every schema-changing statement's
implementation is registered in one block in `runtime/register.ts`, through
`registerEmitter(nodeType, emitter)` (`runtime/emitters.ts:53`). A registration path that
applies the scope for a declared set of statement kinds turns "did every one of those files
remember?" into "is this kind in the set?", decided once, at a site a reviewer already reads
when adding a statement. Cost: the wrapping stops being visible in the file a reader is
looking at, so the helper's docstring and the registration site have to carry that weight.

**Assert at the event-recording seam.** `DatabaseEventEmitter` could track whether a scope is
open and complain when a schema event is recorded outside one during statement execution.
This catches the omission at its source rather than preventing it, and needs care: schema
events also arrive from paths that legitimately have no statement scope (a remote change
applied by the sync engine, catalog rehydration when a persisted database is opened), so a
blunt assertion would fire on correct behavior.

## The carve-out any solution must keep

Applying a declarative schema (`apply schema`) deliberately does **not** get a whole-statement
scope. It runs each generated migration statement as an ordinary statement, and a failure on
the Nth leaves 1..N-1 genuinely applied with no rollback — those must stay announced. Each
generated statement carries its own scope instead. Whatever replaces the convention has to
express "this one is deliberately excluded" as clearly as the current comment does, and the
existing regression test for it (`packages/quereus/test/ddl-schema-event-atomicity.spec.ts`,
the partially-applied-migration case) must keep passing unchanged.

## Related

`docs/module-events.md` and `docs/usage.md` both state the rule to module authors and users;
whichever shape is chosen, the file reference in those sections needs to keep pointing at
wherever the enforcement actually lives.
