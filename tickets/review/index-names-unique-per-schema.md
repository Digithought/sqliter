description: Two tables in the same database could each have an index with the same name, so dropping or re-tagging that index by name silently hit whichever table happened to be registered first. Creating a duplicate name is now rejected up front.
prereq:
files:
  - packages/quereus/src/schema/catalog.ts (isImplicitCoveringIndex ~475, implicitCoveringIndexExposure ~367, isHiddenImplicitIndex ~471)
  - packages/quereus/src/schema/manager.ts (createIndex ~2340, findIndexNameOwnerElsewhere ~2454, importIndex ~3220)
  - packages/quereus/src/schema/schema-differ.ts (duplicate declared index ~292/~340/~360)
  - packages/quereus/src/index.ts (export of isImplicitCoveringIndex)
  - packages/quereus-sync/src/sync/store-adapter.ts (findIndexOwner NOTE)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (counterKey NOTE ~880)
  - docs/sql-ddl.md (§6.3 CREATE INDEX; ALTER INDEX bullet)
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic (new)
  - packages/quereus/test/schema-manager.spec.ts ("Index names are unique per schema")
  - packages/quereus/test/schema-differ.spec.ts ("duplicate declared index names")
difficulty: medium
----

## What changed

`docs/sql-ddl.md` already asserted "index names are unique per schema" as fact,
but nothing enforced it. Every by-name index resolver — `DROP INDEX`,
`ALTER INDEX … TAGS`, and the sync engine's index-owner lookup — finds the
owning table by scanning the schema's tables and stopping at the first hit, and
"first" is table-registration order, which is not stable across devices.

The invariant is now enforced where the ambiguity is introduced.

**Engine (`SchemaManager.createIndex`).** After the pre-existing same-table
check, a new scan rejects a name already held by a *user* index on another table
in the same schema:

```
Index 'idx_note' already exists in schema 'main' on table 't1'
```

`IF NOT EXISTS` deliberately does **not** suppress this — an index of that name
on a different table is a different object, so skipping would leave the
requested index absent from the target table with no signal. It still suppresses
a same-table duplicate, unchanged.

**Implicit covering structures are excluded.** The auto-built secondary index
backing a plain `UNIQUE` constraint is named after that constraint (or
`_uc_<cols>`), and constraint names are unique per *table*, so two tables may
each declare `constraint uq_email unique (email)`. Counting those would reject a
valid schema. New exported predicate `isImplicitCoveringIndex(tableSchema,
indexName)` in `catalog.ts` answers "is this an implicit covering structure,
hidden or exposed" case-insensitively; `createIndex` skips anything it matches.

**Case sensitivity.** `implicitCoveringIndexExposure`'s map is now keyed
lowercase, so `isHiddenImplicitIndex` became case-insensitive too. Both of its
call sites (`manager.ts` `resolveIndexTagSwap`, `store-module.ts`) pass the
stored name, so this is a strict widening — no behavior change for them.

**Rehydration warns, never fails.** `SchemaManager.importIndex` logs a warning
naming both owning tables when an imported index collides, then imports as
before. A database written before this rule must still open.

**Declarative differ.** `computeSchemaDiff` keyed `declaredIndexes` schema-wide
by lowercased name, so two `index …` declarations sharing a name silently
last-writer-wins and half-applied the declaration. It now raises a diagnostic —
recorded during item collection, thrown *after* the reserved-tag diagnostics so
a tag typo still surfaces first (matching the existing deterministic ordering).

**Sync.** No code change. `NOTE:` comments at `findIndexOwner` (store-adapter)
and at the migration `counterKey` (sync-manager-impl) record that their
correctness now rests on this invariant.

**Docs.** `docs/sql-ddl.md` §6.3 states the rule, the error, the `IF NOT EXISTS`
carve-out, the implicit-structure exclusion, the rehydration warning, and the
`declare schema` diagnostic. The §5 `ALTER INDEX` bullet at the old line 696 now
points at the enforcement instead of asserting it unbacked.

## Use cases to exercise

Original repro, now rejected:

```sql
create table t1 (id integer primary key, note text);
create table t2 (id integer primary key, note text);
create index idx_note on t1 (note);
create index idx_note on t2 (note);   -- error, names t1 as owner
drop index idx_note;                  -- unambiguous
```

Cases worth poking at beyond the committed tests:

- `create index IDX_NOTE on t2 (note)` — case-divergent collision (covered).
- `create index if not exists idx_note on t2 (note)` — still errors (covered).
- `create unique index idx_note on t2 (note)` — same namespace (covered).
- Two tables each with `constraint uq_email unique (email)` — still legal, both
  constraints still enforce (covered).
- `create index uq_email on b (email)` where `b` already carries the implicit
  `uq_email` — still the *same-table* error, not the new cross-table one
  (covered, memory-only; see gaps).
- Same index name in two *different* schemas (`main` and `aux`) — legal, the
  check is schema-scoped (covered).
- `declare schema` with two `index idx …` on different tables — now errors
  (covered).
- Not covered: a **temp**-schema table vs a `main` table with the same index
  name; and `create index` against a table in a schema reached via the search
  path rather than an explicit qualifier.

## Validation run

- `yarn build` — clean.
- `yarn test` — 7400 passing in `packages/quereus`, 0 failing; all other
  workspaces green.
- `yarn test:store` — 7394 passing, 19 pending, 0 failing. The new sqllogic file
  runs in both modes.
- `yarn lint` — clean.
- End-to-end check against the built `dist/src/index.js`, not just tests: the
  ticket's original repro now prints
  `SECOND CREATE ERROR: Index 'idx_note' already exists in schema 'main' on table 't1' (at line 1, column 14)`.

## Known gaps — please treat these as the starting point

- **Exposed implicit covering indexes remain first-match.** Two tables can each
  expose a same-named implicit structure via
  `quereus.expose_implicit_index`, and `ALTER INDEX` on that name still resolves
  by registration order. This cannot be closed at `create index` time — the
  collision is created by `create table` — and closing it properly would mean
  making constraint names unique per schema. Parked as a `NOTE:` on
  `findIndexNameOwnerElsewhere` in `manager.ts`, per the ticket's instruction.
- **The store backend never registers implicit covering indexes at all.** The
  implement ticket asserted store mode materializes them into the engine-facing
  schema via `withImplicitUniqueIndexes`; reading `store-table.ts` (the comment
  on `StoreTable.materializedSchema`) says the opposite — the result is held
  only in a private enforcement copy. So the *same-table* `create index uq_email
  on b (email)` error exists in memory mode but not store mode. That divergence
  is pre-existing and out of this ticket's scope, but it is why that one
  assertion lives in `schema-manager.spec.ts` (memory-only) rather than in the
  sqllogic file, which runs under both backends. Worth a reviewer's eye on
  whether the divergence deserves its own ticket.
- **`importIndex`'s warning path has no automated test.** It is a `warnLog` on a
  rehydration path; verified by reading, not by exercising. A test would need a
  catalog import containing a pre-existing collision.
- **The differ diagnostic reports only the first duplicate.** A declaration with
  several duplicate index names names one pair and stops. Consistent with how
  the surrounding structural conflicts behave, but it is a choice, not a
  necessity.
- **Nothing was added to the sync test suite.** The sync changes are comments
  only; the claim that the invariant makes `findIndexOwner` and the migration
  version key unambiguous is reasoned, not demonstrated by a two-device test.

## Spun off

- `tickets/backlog/bug-drop-index-can-delete-a-unique-constraints-backing-structure.md`
  — found while verifying this work: `DROP INDEX uq_email` deletes a UNIQUE
  constraint's hidden backing structure in memory mode (reproduced), while the
  same statement raises `no such index` under the store backend. Independent of
  this ticket's change; `DROP INDEX` simply never learned the
  implicit-vs-user distinction that `ALTER INDEX … TAGS` already applies.
