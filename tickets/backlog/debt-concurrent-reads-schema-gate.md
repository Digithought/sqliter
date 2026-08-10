description: Reads that run alongside writes currently rely on each storage adapter to keep serving a consistent older view while table definitions are being changed. If an adapter ever wants in that cannot do that on its own, the engine needs a way to hold table-definition changes and those reads apart.
prereq: concurrent-reads-engine-path
files: packages/quereus/src/core/database.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/core/statement.ts
difficulty: hard
tradeoffs: No adapter needs this today - every module that opts into concurrent committed reads meets the obligation structurally - so building the gate now is work against a hypothetical future adapter.
----

# Shared/exclusive schema gate for the concurrent committed-read path

## Context

The concurrent committed-read path lets an opted-in read-only statement run
without the execution mutex. Its plan is compiled outside the mutex, and the
scan then iterates for as long as the query takes — potentially straddling a
table-definition change (`create` / `drop` / `alter`) issued by another
statement.

The engine path shipped **without** a plan-time schema gate, on this reasoning:

- `Statement.compile()` is synchronous, so it observes the catalog either
  wholly before or wholly after any awaited step of a table-definition change —
  never half-applied.
- `EmissionContext.validateCapturedSchemaObjects()` re-checks captured schema
  objects at execution start, and the schema-change notifier invalidates a
  cached plan.
- For the long window — the scan itself — the obligation attached to the
  `readCommittedSnapshot` module flag already requires a module to keep serving
  its pinned snapshot across concurrent table-definition changes. The in-memory
  table meets this structurally: the pinned read layer is an immutable tree the
  reader holds a reference to, so a concurrent `alter`/`drop` yields a stale but
  self-consistent snapshot, which is the documented semantics.

## When this becomes real work

The moment a module wants onto the concurrent path but **cannot** pin a snapshot
across a table-definition change — for example a module that mutates its own
catalogue and per-table caches during the change (clearing a shared per-table
scan-plan registry on schema refresh is the known out-of-tree shape). Then the
module-side obligation is not enough, and the engine has to hold the two apart
itself.

## Shape of the fix

A reader/writer gate: concurrent reads take it shared for the duration of their
compile (and possibly their whole scan); a table-definition change takes it
exclusive around its local catalogue mutation — and, critically, **never** holds
it across a virtual-table commit, or it reintroduces exactly the stall this
whole line of work exists to remove.

The hard part is scope. Holding shared for the whole scan turns a long query
into a table-definition-change blocker; holding it only for compile leaves the
scan window uncovered and puts us back on the module obligation. Whoever picks
this up should settle that first, with a named consumer's requirements in hand.

The engine path leaves a `NOTE:` at `Database._isConcurrentReadEligible`
pointing here.
