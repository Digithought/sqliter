----
description: The opt-in "strict" mode that blocks schema changes inside a transaction now also covers creating, dropping, and refreshing a materialized view — it used to let those slip through. Reviewed and completed.
files:
  - packages/quereus/src/runtime/emit/materialized-view.ts          # the three gated emitters + shared gate helper
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # backing-module default now shares one normalizer
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts     # unchanged; the helper being called
  - packages/quereus/src/runtime/emit/set-object-tags.ts            # NOTE tripwire only (no behavior change)
  - packages/quereus/src/core/database.ts                           # pragma description + convergence-API docstring
  - packages/quereus/test/logic/10.1.4-ddl-transaction-policy.sqllogic  # sections 6c/6d/6e/8 + permissive coverage in 7
  - docs/module-authoring.md                                        # gate scope, refresh rationale, tag/apply-schema scope
  - docs/materialized-views.md                                      # note under "## DDL statements"
----

# Complete: strict DDL-transaction gate covers materialized-view statements

## What shipped

Quereus tables are all backed by pluggable storage modules, and most modules cannot undo a
schema change when a transaction rolls back — so `create table t (…)` issued inside
`begin … rollback` leaves the table behind. The opt-in setting
`pragma ddl_transaction_policy = 'strict'` refuses such statements inside an explicit
`begin` instead of letting the change escape. The default, `permissive`, refuses nothing
and is unchanged.

Strict already covered `create`/`drop table`, `create`/`drop index`, and every
`alter table` form. It now also covers the three dedicated materialized-view statements,
which each drive a real module-backed table:

- **`create materialized view`** — gated unconditionally against the **backing host**
  module (the `using <module>(…)` clause, else `memory`; deliberately *not* the session
  default module, which materialized-view backing ignores).
- **`drop materialized view`** — gated against the module that owns the resolved view. A
  name that resolves to nothing skips the gate and falls through to the existing
  `if exists` / not-found diagnostics.
- **`refresh materialized view`** — gated. Rationale (in a code comment and in
  `docs/module-authoring.md`): its reshape arm reconciles a shifted body shape onto the
  live table with module `alterTable` operations, and both of its arms commit the contents
  swap, so `begin; refresh; rollback` does not undo the refresh. The effect escapes the
  transaction exactly like the other gated statements. The counter-argument — refresh is
  arguably data movement, and gating it means a strict application cannot refresh inside a
  transaction at all — is recorded in the code comment; reverting would be a comment plus
  test deletion, not a redesign.

Every gate is called at the top of the emitter's `run()`, before `_ensureTransaction()` and
before any catalog mutation, which is what the helper's contract requires so a refusal
leaves the enclosing transaction and any savepoints fully open.

## Verification

- `yarn test` — full workspace suite: 7180 + 251 + 104 + 51 + 17 + 28 + 960 + 477 + 52 +
  31 + 34 + 117 + 22 passing, **0 failing**, 13 pending.
- `yarn build` — clean. `yarn workspace @quereus/quereus run lint` — clean (eslint + the
  test-file type pass).
- `10.1.4-ddl-transaction-policy.sqllogic` also run against the LevelDB store backend
  (`QUEREUS_TEST_STORE=true`) — passing, so the assertions hold with store-backed sources.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Review findings

### Checked and clean

- **Gate placement.** All three call sites precede `_ensureTransaction()` and any catalog
  mutation, matching the helper's documented contract. Confirmed by reading each emitter
  end to end, not just the diff.
- **Module resolution for `create`.** The emitter resolves the backing host through
  `normalizeBackingModuleName`, the same decision the plan builder applies before storing
  the name — so the `mem` alias and casing cannot reach the gate unresolved.
- **Permissive path cost.** `drop` and `refresh` guard their view lookup behind the cheap
  policy check, so the default path does no extra work and its statement ordering is
  unchanged. `create`'s lookup is a map read, matching what `emitCreateTable` already does.
- **Sibling authoring surfaces.** `create table … maintained as` and the
  `alter table … set/drop maintained` lifecycle verbs route through the `CREATE TABLE` and
  `ALTER TABLE` emitters, which were already gated — no second hole. `drop table` on a
  maintained table likewise goes through the gated `emitDropTable`.
- **Error ordering.** Plan-time rejections (unknown module, missing backing-host
  capability, body arity) still fire before the runtime gate; a refused statement produces
  the policy error and nothing else.

### Found and fixed in this pass

- **Duplicated gate blocks (`materialized-view.ts`).** The `refresh` and `drop` gates were
  byte-identical except for their label, each carrying its own copy of the same eight-line
  rationale comment. Extracted `assertMaintainedTableDdlPolicy(db, schemaName, viewName,
  label)`; the call sites are now one call plus the statement-specific reasoning.
- **Two spellings of the `memory` backing default.** The implementer flagged that
  `buildBackingTableSchema` used a bare `moduleName ?? 'memory'` while the new gate used
  `normalizeBackingModuleName`. They agreed only because the plan builder normalizes first.
  `buildBackingTableSchema` now calls the same normalizer, so there is one decision — which
  also makes the catalog-import path (which reaches it without the builder) alias-safe.
- **Stale scope lists.** The `ddl_transaction_policy` option description shown by option
  introspection still read "CREATE/DROP TABLE/INDEX, ALTER TABLE", as did the test file's
  header comment. Both now name the materialized-view verbs.
- **Test coverage gaps the handoff listed as open.** Added: a savepoint-scoped refusal for
  the materialized-view verbs (section 6b covered `create index` only); a
  `create materialized view if not exists <existing>` case inside `begin`, which documents
  that the gate keys off the statement rather than the outcome — deliberately asymmetric
  with `drop … if exists`, which has no target to resolve a module from; and a new
  section 8 covering `apply schema`.
- **`apply schema` interaction — the handoff's "nobody has checked either way".** Now
  checked and covered. Declarative migrations execute their generated statements inside the
  engine's *implicit* transaction, so strict does not fire statement-by-statement during a
  migration; wrapping the `apply schema` in an explicit `begin` does trip the gate on the
  first gated statement. Both directions are asserted in section 8 and stated in
  `docs/module-authoring.md`.

### Filed as a new ticket

- **`backlog/bug-declared-materialized-view-non-main-schema.md`** — pre-existing, unrelated
  to this change and not a regression: a materialized view declared in a schema other than
  `main` cannot be applied, because the statement the differ generates for it carries no
  schema prefix on either the view name or its body, and the migration loop runs it against
  the default search path. Found while writing the section 8 test (which was rewritten to
  use `main` and is unaffected).

### Recorded as tripwires, not tickets

- **Tag-only edits escape the gate.** `alter materialized view / view / index …
  {set|add|drop} tags` route through `emitSetObjectTags`, which dispatches to no module and
  so sits outside the gate's stated "module-dispatching DDL" scope — while
  `alter table … set tags` *is* refused, because the `ALTER TABLE` emitter gates all its
  arms uniformly. Conditional (it only becomes wrong if a module ever persists tags such
  that the edit survives rollback, or if the gate's scope is restated as "anything that
  escapes the transaction"). Parked as the `NOTE:` comment the implementer added at
  `packages/quereus/src/runtime/emit/set-object-tags.ts`, and now also stated in
  `docs/module-authoring.md` so the asymmetry is documented rather than folklore.
- **`Database.refreshAllMaterializedViews()` bypasses the gate.** It is an engine
  convergence primitive (used by sync snapshot bootstrap), not a SQL statement, so the
  policy does not apply — deliberate, but previously unstated. Added a paragraph to its
  docstring in `packages/quereus/src/core/database.ts` rather than filing anything.

### Known limit, accepted

- **The backing-host-vs-session-default module choice is not directly observable in a
  test.** Distinguishing the two would need a registered module declaring
  `ddlTransactionality: 'transactional'` *and* implementing the backing-host capability; no
  such fixture exists, and every real module is non-`transactional`, so both resolutions
  refuse identically today. Building that fixture was judged more surface than the residual
  risk warrants, especially now that the gate and `buildBackingTableSchema` share one
  normalizer. Stated here rather than left implicit.
