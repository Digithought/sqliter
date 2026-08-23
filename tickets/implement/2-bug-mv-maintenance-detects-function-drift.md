description: If an application replaces one of its own SQL functions after a materialized view was built on it, the view's saved table can end up holding a mix of old and new results — some rows computed one way, some the other — with nothing flagging it.
prereq: bug-mv-rewrite-gates-on-function-identity
files:
  - packages/quereus/src/core/database-materialized-views.ts   # ~308 registerMaterializedView (capture + the drift check), ~355 markMaterializedViewStale
  - packages/quereus/src/schema/derivation.ts                  # TableDerivation.bodyFunctions — added by the prereq ticket
  - packages/quereus/src/runtime/emit/alter-table.ts           # ~328 the rename path that re-registers a maintained table
  - packages/quereus/test/                                     # no existing home; a maintenance-side spec is new
  - docs/materialized-views.md                                 # staleness / rebuild contract
repro: verified
difficulty: medium
---

# Re-registering a view after a function changed leaves the saved rows mixed

## What is wrong

A materialized view's saved table is kept up to date by a maintenance plan that is
compiled **once**, when the view is registered, and cached. The plan captures the actual
implementations of the functions the view body calls. So long as that one plan keeps
running, every row in the saved table was produced by the same functions — which is what
makes the table trustworthy.

Some operations re-register the view and therefore recompile that plan against whatever
functions are registered *at that moment* — `alter table … rename` is one, and opening a
database over already-saved state is another. If a function the body uses has been
replaced in between, maintenance quietly switches to the new implementation while the rows
already in the saved table were produced by the old one. Nothing notices, nothing warns,
and the table now holds two different functions' answers side by side.

## Observed (run for this ticket, `packages/quereus`, memory backing)

Base table `t(id integer primary key, k integer not null, x integer not null)` with rows
`(1,1,10),(2,1,20),(3,2,30)`; view `mv as select k, sum(x) as s from t group by k`, so the
saved table holds `k=1→30, k=2→30`.

Then a deterministic user `sum/1` that counts rows is registered, followed by:

```sql
alter table mv rename to mvr;
insert into t values (4,2,5);
```

Reading the saved table directly gives:

| group | value | produced by |
| --- | --- | --- |
| `k=1` | `30` | the built-in `sum` — untouched since the rename |
| `k=2` | `2` | the counting user `sum` — the group maintenance re-derived |

One table, two functions' semantics. For contrast, with **no** rename in between, the
cached plan keeps running and the table stays internally consistent (`k=2` goes `30 → 35`,
built-in semantics throughout) — which is what the prereq ticket's read-side gate assumes.

The same mechanism applies whenever a persisted database is reopened and the application
registers a replacement for one of its functions before the view is registered again.
That path was not reproduced here (it needs a persistent backing rather than the memory
module) and is worth confirming during implementation.

## Root cause

`MaterializedViewManager.registerMaterializedView`
(`src/core/database-materialized-views.ts` ~308) rebuilds the maintenance plan
unconditionally and installs it. It has no notion of a *previous* registration to compare
against, so it cannot tell "first registration of this view" from "re-registration after
the meaning of a body function changed".

The prereq ticket, `bug-mv-rewrite-gates-on-function-identity`, adds exactly the missing
comparand: `TableDerivation.bodyFunctions`, a map from `getFunctionKey(name, argc)` to the
function schema that resolved when the plan was last built. Because the derivation object
is shared by reference across catalog swaps (`alter table … rename` rebuilds the table
schema with `{...table}` — `alter-table.ts` ~2377 `rewriteTableForTableRename`), the map
from the previous registration is still there to compare against at the moment of
re-registration.

## What must hold

**A saved table must never hold rows produced by two different implementations of the same
body function.** When re-registration discovers that a body function now resolves to a
different registration than the one that produced the existing rows, the saved table is no
longer a faithful derivation of its sources and must not be served or incrementally
maintained as if it were.

## Design

In `registerMaterializedView`, before overwriting `derivation.bodyFunctions`:

- Read the prior map. Absent ⇒ this is a first registration; nothing to compare, proceed
  normally.
- Present ⇒ compare each key's recorded schema against the freshly resolved one by object
  identity. Any key whose resolution changed (including one that previously resolved and
  now does not) is **drift**.
- On drift, mark the view stale — the same transition
  `markMaterializedViewStale` (~355) already performs: set `derivation.stale`, detach the
  row-time plan, and invalidate cached prepared-statement plans reading the saved table.
  Log the drifted `(name, argc)` explicitly; this is a condition an application author
  needs to be able to see, not a silent downgrade.

Marking stale is the right landing point rather than an immediate rebuild:

- The read-side rewrite already treats `derivation.stale === true` as `no-candidate`
  (`query-rewrite-matcher.ts` ~352 and its siblings), so the optimizer stops using the
  saved table the moment drift is seen — no new gate needed there.
- Staleness is the existing, documented way of saying "the saved rows are behind their
  definition", and `refresh materialized view` is the existing way to clear it. Drift is
  the same claim, arrived at differently.
- Rebuilding inside registration would run a full recompute at `alter table … rename`
  time, which is a surprising cost for a rename and puts a query inside a DDL path that
  today only compiles.

**Interaction with the rename path.** `alter-table.ts` ~303 snapshots which views were
stale *before* the statement's schema-change notifications, so the propagation that
follows cannot clear a pre-existing flag. Setting the flag from inside
`registerMaterializedView` (~330, after that snapshot) must survive to the end of the
statement — verify it does, and if the propagation clears it, set it after the
re-registration instead of inside it.

## Scope boundaries

**Detecting drift, not preventing it.** An application is allowed to replace its own
functions; the goal is that the engine notices and stops trusting the saved rows, not that
it refuses the registration.

**Within a session only.** Object identity does not survive a process boundary, so a
reopen starts with no prior map and reports no drift. That limit is inherent and is
already stated in `docs/usage.md` by the prereq ticket; this ticket does not widen it. If
the reopen path turns out to warrant a persisted, weaker witness (for example "this body
function was the built-in"), file that separately with the evidence rather than growing it
in here.

## TODO

Phase 1 — the drift check

- In `registerMaterializedView`, capture the prior `derivation.bodyFunctions` before overwriting it and compare key-by-key by object identity against the freshly resolved schemas.
- On any difference, mark the view stale via the same transition `markMaterializedViewStale` performs (flag + detach row-time plan + invalidate cached statement plans), and log the drifted `(name, argc)` pairs.
- Confirm the flag survives the `alter table … rename` statement's stale-snapshot / propagation sequence (`alter-table.ts` ~303–330); move the check after the re-registration call if it does not.

Phase 2 — tests

- Rename-after-replacement: build the view, register a replacement aggregate, `alter table mv rename to mvr`, and assert the view is stale and a covered query is computed from the base table rather than the saved one.
- Assert the saved table does not acquire mixed rows: after the rename, an insert must not leave one group on the old function's semantics and another on the new one (the `k=1→30` / `k=2→2` shape above is the failure to guard against).
- `refresh materialized view` clears the flag and the saved table is then internally consistent under the new function.
- Control: a rename with **no** function change does not mark the view stale — a regression guard, since renaming a maintained table is otherwise routine.

Phase 3 — validation and docs

- `yarn workspace @quereus/quereus test` green, plus `yarn lint` and `yarn typecheck`.
- `docs/materialized-views.md`: add drift to the list of things that mark a view stale, with one sentence on why (the saved rows and the maintenance plan would otherwise disagree about what a body function means).
- Confirm — or record as not-yet-confirmed, with what would settle it — whether reopening a persistent backing re-registers the view against the live registry in the same way. The prereq ticket's persisted-state case is the same question from the read side.
