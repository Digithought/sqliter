----
description: The opt-in "strict" mode that blocks schema changes inside a transaction now also covers creating, dropping, and refreshing a materialized view — it used to let those slip through.
files:
  - packages/quereus/src/runtime/emit/materialized-view.ts        # the three gated emitters
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # unchanged; the helper being called
  - packages/quereus/src/runtime/emit/set-object-tags.ts          # NOTE tripwire only (no behavior change)
  - packages/quereus/test/logic/10.1.4-ddl-transaction-policy.sqllogic  # new sections 6c/6d/6e + permissive coverage in 7
  - docs/module-authoring.md                                      # gate scope list + refresh rationale
  - docs/materialized-views.md                                    # note under "## DDL statements"
----

# Review: strict DDL-transaction gate now covers materialized-view statements

## What the feature is (for a reader with no context)

Quereus tables are all backed by pluggable storage modules. Most modules cannot undo a
schema change when a transaction rolls back — so `create table t (...)` issued inside
`begin … rollback` leaves the table behind. The opt-in setting
`pragma ddl_transaction_policy = 'strict'` refuses such statements inside an explicit
`begin` block instead of letting the change escape. The default, `permissive`, keeps the
old behavior and refuses nothing.

Strict already covered `create/drop table`, `create/drop index`, and every `alter table`
form. It did **not** cover the three dedicated materialized-view statements, even though a
materialized view is stored in a real module table. This ticket closed that hole.

## What changed

All three emitters in `runtime/emit/materialized-view.ts` now call the existing
`assertDdlTransactionPolicy(db, module, moduleName, statementLabel)` helper at the top of
`run()`, before `_ensureTransaction()` and before any catalog mutation — the placement the
helper's contract requires so a refusal leaves the enclosing transaction (and any
savepoints) fully open:

- `CREATE MATERIALIZED VIEW` — gated unconditionally (the module lookup is a cheap map
  read, mirroring `emitCreateTable`). The module consulted is the **backing host**: the
  `using <module>(…)` clause, else `memory`. That is *not* the session default module —
  materialized-view backing deliberately defaults to memory regardless of
  `default_vtab_module`, so the gate mirrors `buildBackingTableSchema`'s resolution
  (via `normalizeBackingModuleName`, which is what the plan builder already applied).
  Unregistered module ⇒ gate skipped, so the natural "no virtual table module named …"
  error still wins.
- `DROP MATERIALIZED VIEW` — the owning module comes off the resolved maintained-table
  record, so the lookup is guarded behind the cheap `isDdlPolicyStrict()` check (the
  `emitDropIndex` pattern). The permissive path pays nothing and its statement ordering is
  byte-for-byte unchanged. A missing view skips the gate and falls through to the existing
  `if exists` / not-found diagnostics.
- `REFRESH MATERIALIZED VIEW` — **gated** (this was the open question in the source
  ticket). Rationale, recorded in a code comment and in `docs/module-authoring.md`:
  1. Its reshape arm reconciles a shifted body shape onto the live table with module
     `alterTable` operations — a genuine escaping schema change. That arm fires only when a
     source `alter` shifted the body's output shape, so gating refresh *only* on that arm
     would make strict fire unpredictably on data-dependent input.
  2. Both arms are commit-first: `begin; refresh; rollback` does **not** undo the refresh
     today (see `rebuildBacking`'s docstring in `materialized-view-helpers.ts`), so the
     effect escapes the enclosing transaction exactly like the gated DDL statements.

  A reviewer who disagrees should note the counter-argument: refresh rewrites rows, so it
  is arguably DML, and gating it means an application that opts into strict cannot refresh
  inside a transaction at all. Reverting to "not gated" would be a comment + test deletion,
  not a redesign.

The stale `NOTE:` marker in `emitCreateMaterializedView` that pointed at this ticket is
gone, replaced by the real gate.

## How to validate

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "10.1.4|materialized"
```

New sections in `test/logic/10.1.4-ddl-transaction-policy.sqllogic`:

- **6c** — under strict, `create materialized view` inside `begin` is refused; the
  transaction survives (a later `insert` + `commit` both work and the row lands); nothing
  was materialized (a follow-up `drop materialized view` errors with "no such materialized
  view"). Also locks the skip-the-gate path: `drop materialized view if exists <missing>`
  inside `begin` is a no-op, not a refusal.
- **6d** — the same `create` succeeds outside a transaction (autocommit).
- **6e** — under strict, `refresh` and `drop` inside `begin` are both refused, the view
  survives both refusals and is still readable, and both succeed outside a transaction.
- **7** — after `pragma ddl_transaction_policy = 'permissive'`, `create` / `refresh` /
  `drop materialized view` inside `begin … commit` all work again (the default behavior is
  unchanged).

Manual smoke, if you want to see it by hand:

```sql
create table t (id integer primary key, v text);
insert into t values (1, 'a');
pragma ddl_transaction_policy = 'strict';
begin;
create materialized view mv as select id, v from t;   -- refused
insert into t values (2, 'b');                        -- transaction still usable
commit;
create materialized view mv as select id, v from t;   -- succeeds in autocommit
```

## Verification run

- `yarn test` — full workspace suite, all passing (7180 + 251 + 104 + 51 + 17 + 28 + 960 +
  477 + 52 + 31 + 34 + 117 + 22 passing, 0 failing).
- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` and `… run typecheck` — clean.
- Store backend spot-check: `QUEREUS_TEST_STORE=true … --grep "10.1.4|materialized"` — 8
  files passing, so the new assertions hold with LevelDB-backed source tables too.
- No pre-existing failures surfaced.

## Known gaps / things a reviewer should poke at

- **`alter materialized view … set tags` is still ungated**, as are `alter view` /
  `alter index` tag edits — they route through `emitSetObjectTags`, which dispatches to no
  module and so sits outside the gate's stated "module-dispatching DDL" scope. But
  `alter table t set tags` *is* gated, because the ALTER emitter gates all its arms
  uniformly. That asymmetry is real. Parked as a `NOTE:` tripwire in
  `runtime/emit/set-object-tags.ts` rather than fixed, since whether tag-only edits belong
  in the gate is a policy call, not a defect. See `## Review findings` below.
- **The memory default is now spelled in two places** — `buildBackingTableSchema`'s
  `moduleName ?? 'memory'` and the emitter's `normalizeBackingModuleName(...)`. They agree
  today (the plan builder normalizes before either sees it, so the alias `mem` cannot reach
  them unresolved), but there is no single constant tying them together.
- **Declarative schema (`apply schema`) was not examined.** If that path can create or drop
  materialized views without going through these three emitters, strict would not see it.
  Out of scope for this ticket; nobody has checked either way.
- **No unit test was added** to `test/capabilities.spec.ts` — the coverage is entirely
  end-to-end SQL in the `.sqllogic` file. That is the same shape the original feature's
  statement-level coverage takes, but it means the module-resolution logic (backing host vs
  session default) is only exercised through the default `memory` path; a
  `create materialized view … using <other-module>` case is untested.
- **Untested interaction:** a savepoint-scoped refusal for the MV verbs specifically
  (section 6b covers it for `create index` only). The gate is the same helper, so it should
  behave identically, but it is asserted, not proven, for the MV statements.

## Review findings

- Noticed while gating: `alter materialized view / view / index … {set|add|drop} tags`
  escapes the strict gate while `alter table … set tags` does not. Conditional (only
  matters if a module ever persists tags such that the edit survives rollback, or if the
  gate's scope is restated as "anything that escapes the transaction"), so parked as a
  `NOTE:` comment at `packages/quereus/src/runtime/emit/set-object-tags.ts` rather than
  filed as a ticket.
