----
description: Declaring the same plain UNIQUE rule twice on one table used to behave three different ways depending on how it was written and which storage backend was in use; it is now refused the same way everywhere, with a message about the constraint rather than about a hidden index.
files:
  - packages/quereus/src/schema/catalog.ts                         # the guards, beside assertUniqueConstraintIndexNameFree
  - packages/quereus/src/runtime/emit/add-constraint.ts            # ALTER TABLE ADD CONSTRAINT wiring
  - packages/quereus/src/runtime/emit/alter-table.ts               # ADD COLUMN … unique wiring
  - packages/quereus/src/schema/manager.ts                         # createTable wiring
  - packages/quereus/src/vtab/memory/layer/manager.ts              # ensureUniqueConstraintIndexes hardening
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # §10, §11
  - packages/quereus/test/index-ddl-roundtrip.spec.ts              # memory-hardening shape tests
  - packages/quereus-store/test/index-persistence.spec.ts          # store: refused before any catalog write
  - docs/sql-alter.md                                              # ADD CONSTRAINT § — the rule and its two carve-outs
  - docs/sql-ddl.md                                                # §7.3 UNIQUE — the rule as CREATE TABLE readers meet it
repro: verified
----

## What shipped

A table may not carry two **unnamed, non-partial** UNIQUE constraints over the same
column set. Refused with `CONSTRAINT` and the message
`Cannot <operation>: an equivalent UNIQUE constraint on (<cols>) already exists.` at
every declaration site — `CREATE TABLE` (both the column-level and table-level
spellings), `ALTER TABLE … ADD CONSTRAINT`, `ALTER TABLE … ADD COLUMN … unique` — always
before module dispatch (so a store-backed statement persists nothing) and always before
the older hidden-index-name check (so the message names the constraint, not an index the
user never created).

Before, the same statement got three answers: memory refused it but blamed an index
`_uc_c`; store accepted it and persisted `… unique (c), unique (c)`; and
`create table … unique (c), unique (c)` was accepted on memory with two index entries
under one name. Neither accepted copy could be dropped — an unnamed constraint has no
name for `DROP CONSTRAINT` to address.

Identity is the **column set**: order-insensitive, case-folded, repetition-folded.
Carve-outs, both deliberate: a partial UNIQUE (one carrying a `where` predicate) is a
different rule, and a *named* UNIQUE beside an unnamed one over the same columns stays
legal (both are addressable and droppable).

`MemoryTableManager.ensureUniqueConstraintIndexes` was additionally hardened to **adopt**
a structure name already claimed rather than push a second entry under it, so no path
produces the two-entries-under-one-name shape — defence in depth for catalogs written
before the guards.

## Review findings

### Checked

- **Every declaration site.** Read the three wired sites plus the ones that could have
  been missed: `buildDeclaredTableSchema` (maintained-table create — registers through
  `createTable`, so it inherits the guard), `importCatalog` (deliberately exempt; the
  store rehydrates through it, verified in `store-module-schema-sync.ts`, so a legacy
  catalog still opens), `CREATE UNIQUE INDEX` (produces a `derivedFromIndex` constraint,
  correctly exempt). No site is missing the guard.
- **Both backends agree.** Read `quereus-store`'s `withImplicitUniqueIndexes` — it adds
  each derived name to a `present` set before pushing, so it never doubles up; the
  implementer's "no change needed" is correct.
- **Edge cases, by direct probe** (throwaway spec, since removed): a column repeated in
  one constraint (`unique (a, a)` — folds to `(a)`, and a later `unique (a)` is refused,
  which is the intended reading); `DROP COLUMN` on a covered column (drops the whole
  constraint, so two constraints can never *converge* onto one column set after the
  fact); `unique (id)` twice beside an `integer primary key` (refused, PK is not a UNIQUE
  constraint and does not interfere); a named and an unnamed inline `unique` on one
  `ADD COLUMN` (accepted — the documented carve-out); and quoted column names, which
  found the defect below.
- **Atomicity.** The store spec's `traceCatalogWrites()` assertion (zero writes on the
  refused statement) is the right shape and passes.
- **Lint / typecheck / tests.** `yarn lint` clean, `yarn typecheck` clean, `yarn test`
  8166 passing / 0 failing, `yarn test:store` 8158 passing / 0 failing (+1 each over the
  implementer's numbers — the new spec test below).

### Found and fixed in this pass

- **A column name containing a comma was refused as a duplicate.** *(correctness, minor)*
  `uniqueConstraintColumnSetKey` joined the sorted column names with `,`, so the single
  quoted column `"a,b"` keyed identically to the two-column set `(a, b)`. On a table
  carrying `unique (a, b)`, the legal statement `alter table t add unique ("a,b")` was
  refused — verified before the fix. The key is now `JSON.stringify` of the sorted array,
  which is injective for any column name. Regression pinned in §10f of
  `10.5.7-implicit-unique-index-lifecycle.sqllogic` (runs on both backends): both
  constraints are accepted, both enforce independently, and the genuine repeat is still
  refused.
- **Two comments overstated how hard the sibling collision is to reach.** *(accuracy,
  minor)* The NOTE on `findIndexShadowedByUniqueConstraint` and the new roundtrip spec
  both said the derived-structure-name collision is "only reachable when the user writes
  the engine's reserved `_uc_` prefix". It is also reachable with ordinary names, because
  the derived name joins columns with `_`: `unique (a_b)` and `unique (a, b)` both derive
  `_uc_a_b`. Both comments corrected, and a sibling spec test in
  `index-ddl-roundtrip.spec.ts` pins the shape for the ordinary-name spelling.
- **The declare/apply-schema `CREATE TABLE` arm was untested** — the implementer flagged
  this gap. §11 of the sqllogic file now applies a declared schema whose table carries the
  same plain UNIQUE twice and asserts the refusal plus that no table is registered.
- **`docs/sql-ddl.md` never mentioned the rule.** `docs/sql-alter.md` documented it
  thoroughly from the ALTER side, but `CREATE TABLE` is now tightened too and a reader of
  §7.3 (UNIQUE Constraint) would not have learned it. Added there, cross-referencing the
  ALTER doc for the carve-outs.

### Found and filed (existing ticket, arm appended)

- **`backlog/bug-create-table-unique-derived-name-collision`** already owns the site, so
  the new evidence was appended there rather than filed fresh: the silent loss of
  enforcement is reachable with ordinary column names (`unique (a_b)` beside
  `unique (a, b)`), not only by typing the reserved `_uc_` prefix, which removes that
  ticket's "no ordinary schema does that" argument. Its `description` was broadened
  accordingly and a note added recommending promotion out of `backlog/`. Also confirmed
  while there that the persistent store is **not** affected — it resolves a constraint's
  serving index by columns rather than by name
  (`store-table-constraints.ts:findIndexForUniqueConstraint`) and falls back to a correct
  full scan — so the two backends silently disagree; that is recorded in the ticket. The
  new spec test asserts only the index-list *shape*, not the enforcement loss, so a future
  fix flips it visibly rather than being blessed.

### Explicitly nothing found

- **Tripwires: none recorded.** The conditional concerns the implementer listed are
  already inert — the `alsoDeclared` arm is written generically, and the guards are
  linear in a table's constraint count on DDL statements only, which no plausible schema
  makes hot. Nothing that is "fine now, breaks if X".
- **No resource-cleanup, error-handling, or type-safety findings.** The guards throw
  `QuereusError`/`StatusCode.CONSTRAINT` before any allocation or module dispatch; there
  is nothing to release on the failure path, and no `any` was introduced.
- **The unreachable-by-user memory hardening stays untested through a user statement**,
  as the implementer said. Confirmed the same way they did: with all three declaration
  guards in place, no write path can hand `ensureUniqueConstraintIndexes` two constraints
  deriving one name *from duplicate unnamed UNIQUEs*. The two spec tests reach the arm by
  the two derived-name-collision doors instead, which is the best available route and now
  covers both of them.
- **Isolation / sync wrapper modules were not separately exercised**, also as flagged.
  `runAddConstraintViaModule` is the single engine-side ADD CONSTRAINT path and the guard
  sits above the dispatch, so a wrapper cannot bypass it by construction; their suites
  pass. Left as-is rather than adding a test that would only re-assert control flow.

### Not mine

`yarn docs:check` still fails at HEAD on `docs/schema.md` and `docs/sync.md` (both over
their recorded word-count maximums) — unchanged by this work and owned by
`backlog/debt-doc-size-ratchet-red-at-head`. `docs/sql-ddl.md` and `docs/sql-alter.md`,
which this ticket edits, both pass.

## Bugs found during implement, filed then

- `tickets/fix/bug-memory-unique-reuses-partial-index` (verified) — on the memory
  backend, a full `UNIQUE` adopts a *partial* index over the same columns as its enforcing
  structure and then stops rejecting duplicates outside the filter. The store excludes
  partial indexes from that search and is correct.
- `tickets/backlog/bug-create-table-unique-derived-name-collision` (verified) — see
  above; the review added a second, more reachable route to it.
