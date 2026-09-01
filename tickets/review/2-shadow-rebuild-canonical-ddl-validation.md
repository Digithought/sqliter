description: Review the change that makes a table rebuilt by ALTER PRIMARY KEY keep everything it declared — its checks, unique rules, foreign keys, tags and indexes — instead of silently losing them, plus the tests and docs that now cover it.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # buildShadowTableDdl → generateTableDDL; rebuildUserIndexes; index re-creation; FK suppression around the internal DROP; createIndex precondition (~line 1943)
  - packages/quereus/src/schema/manager.ts                  # assertNoReferencingChildrenForDrop early-returns under _isFkRestrictSuppressed (~line 1469)
  - packages/quereus/src/core/database.ts                   # _setFkRestrictSuppressed jsdoc — now documents the second caller and the drop-guard honoring site (~line 2610)
  - packages/quereus/test/runtime/shadow-ddl.spec.ts        # unit spec over the canonical shadow DDL (10 cases)
  - packages/quereus/test/alter-table-conformance.spec.ts   # NEW describe block, 12 end-to-end rebuild-preservation arms (from ~line 642)
  - packages/quereus/test/no-alter-module.ts                # withCreateIndex flag forwards createIndex/dropIndex
  - docs/sql-alter.md                                       # ALTER PRIMARY KEY § — preservation guarantee, third precondition, statement-count wording
  - docs/module-authoring-schema-changes.md                 # third refusal case for the fallback
  - docs/module-events.md                                   # suppressed-scope statement list now includes index re-creation
difficulty: medium

# Review: ALTER PRIMARY KEY shadow rebuild now renders through the canonical DDL writer

## What the change is, in plain terms

When a storage backend cannot change a table's primary key by itself, the engine
does it the long way: it creates a second, hidden table with the new key, copies
every row across, drops the original, and renames the hidden one over it. That
hidden table used to be described by a small hand-written `CREATE TABLE`
builder that only knew about column names, types, nullability, defaults and
collations. Everything else the table declared — its CHECK rules, UNIQUE rules,
foreign keys, generated columns, tags, the key's `ON CONFLICT` action, and its
indexes — was simply not written down, so the rebuilt table came back without
them and stopped enforcing them. No error was raised; the statement reported
success.

The fix replaces that builder with the engine's one official table-definition
writer (`generateTableDDL`), fed a copy of the real table schema with only the
name and the key substituted. Indexes are not part of a `CREATE TABLE`, so they
are re-created explicitly after the rename.

## What landed

Source (all of this was committed by the prior run, in 7ea936d01 — this run
validated it, fixed nothing in it, and added tests + docs):

- `buildShadowTableDdl(tableSchema, shadowName, newPkDef)` is a thin wrapper over
  `generateTableDDL({ ...tableSchema, name: shadowName, primaryKeyDefinition: newPkDef })`,
  called without a `db` argument so the text is fully qualified and annotated
  and re-parses identically under any session settings. The old
  `survivingColumns` parameter is gone end-to-end — the rebuild is whole-table
  by construction (stored constraints address columns by index, so a subset copy
  would need every constraint remapped).
- The insert-select projection excludes generated columns; the shadow declares
  the same `GENERATED ALWAYS AS` clauses and computes them itself.
- `rebuildUserIndexes(tableSchema)` filters out a declared UNIQUE constraint's
  implicit backing structure (it re-materializes from the constraint the shadow
  already declares); each surviving index is re-created after the RENAME with
  `generateIndexDDL(idx, tableSchema)`.
- `runAlterPrimaryKey` refuses up front (sited `UNSUPPORTED`) when the table has
  user indexes and the module has no `createIndex` — failing later would strand
  a half-rebuilt table, and skipping the re-creation would silently disarm a
  UNIQUE index.
- The rebuild's internal `DROP TABLE` runs with `db._setFkRestrictSuppressed(true)`
  (restored in a `finally`), and `SchemaManager.assertNoReferencingChildrenForDrop`
  now early-returns under that flag. Without this a self-referencing FK (the
  shadow is a referencing child of the original) or any other table's FK with
  rows present would refuse the drop.

This run added:

- 12 end-to-end arms in `alter-table-conformance.spec.ts` (details below).
- A non-vacuity guard inside the general subsumer arm, so it cannot pass on a
  table that happens to declare nothing.
- Doc updates in `docs/sql-alter.md`, `docs/module-authoring-schema-changes.md`,
  `docs/module-events.md` (preservation guarantee; the fallback's precondition
  count went 2 → 3; the internal-statement count is no longer fixed at four).
- `Database._setFkRestrictSuppressed`'s jsdoc, which described only the
  external-row apply path, now names both callers and the drop-guard honoring
  site.

## Validation performed

| Command | Result |
| --- | --- |
| `yarn workspace @quereus/quereus test` | 10277 passing, 25 pending, 0 failing |
| `yarn test` (all workspaces) | all green, ~6m54s |
| `yarn workspace @quereus/quereus run lint` | clean (eslint + `tsc -p tsconfig.test.json`) |
| `yarn build` | clean |

`yarn test:store` was **not** run (see gaps).

## The 12 new end-to-end arms

All in `describe('ALTER PRIMARY KEY — shadow rebuild preserves the table definition')`,
driven through a real `alter table … alter primary key` against
`makeNoAlterModule({ withRenameTable: true })` — a module with no `alterTable`,
which is what forces the rebuild path. Each asserts survival *behaviorally* (the
rule still rejects a violating write) rather than by reading DDL text:

- a table-level `CHECK` still rejects a violating insert (and still admits a
  satisfying one)
- a `UNIQUE` constraint still rejects a duplicate
- a declared `FOREIGN KEY` is still enforced, and is present in the rebuilt schema
- table tags survive
- the key's `ON CONFLICT REPLACE` survives — a duplicate-key insert replaces
  instead of erroring
- user indexes survive with `withCreateIndex: true`; the UNIQUE one still rejects
  a duplicate
- with the `createIndex` hook removed, the statement is refused with a sited
  `UNSUPPORTED` naming the capability, and key / index / rows are all unchanged
- `alter primary key ()` yields the empty singleton key on a one-row table
- `alter primary key ()` rejects on a two-row table, leaving key and rows intact
- a self-referencing FK table rebuilds, the FK still points at the table itself,
  and an orphan reference is still rejected
- another table's FK into the rebuilt table, **with a referencing row present**:
  the rebuild succeeds and the child's FK still rejects an orphan
- **the general subsumer**: `generateTableDDL` captured before and after a
  re-key, with every `PRIMARY KEY` clause stripped from both, must be
  byte-identical. The table under test declares a CHECK, a UNIQUE, a COLLATE, a
  DEFAULT, a generated column, tags and a `using` clause, and the arm asserts
  each of those appears in the captured text before comparing — so the
  comparison cannot pass vacuously.

## Known gaps and things worth a reviewer's attention

- **The `createIndex` precondition is not reachable through SQL today.**
  `SchemaManager.createIndex` already refuses on a module without the hook, so
  you cannot create an index on such a module in the first place. The guard
  exists for the other way in — a table arriving with indexes already attached,
  e.g. a store-backed catalog rehydrate. The test simulates that by deleting the
  hook from the stub module after setup, which is honest about what the engine
  sees at ALTER time but is not a path a user can currently walk. A reviewer may
  reasonably ask whether the guard should stay (it is cheap and the failure it
  prevents is data loss) or whether the simulation is too artificial.
- **`yarn test:store` was not run.** No store-package source was touched, and the
  store module re-keys in place so it never reaches this fallback — but the store
  leg of the ALTER-conformance matrix lives in `@quereus/store`'s own suite and
  was only exercised via the `yarn test` fan-out, not the `--store` re-run of the
  quereus logic tests. Worth one run if the reviewer wants belt and braces.
- **The FK drop-guard suppression is a real behavior change beyond this ticket.**
  `assertNoReferencingChildrenForDrop` now early-returns whenever the flag is
  set, and the external-changes apply path sets that flag during applied drops.
  So an apply-path drop of a table that still has referencing children now
  proceeds instead of refusing. That is the trust-the-origin posture the rest of
  that path already takes, and no existing test asserted the old refusal (the
  full suite is green), but it was not the ticket's stated goal and deserves a
  second opinion.
- **Rebuild atomicity is unchanged and still imperfect.** If re-creating an index
  fails after the rename, the error propagates and the table is left rebuilt but
  missing that index; the `catch` only drops a leftover shadow. The up-front
  capability check makes this exceptional rather than routine, but it is not an
  all-or-nothing rebuild.
- The arms that need the FK target to stay unique re-key by flipping the key to
  descending (`alter primary key (code desc)`) rather than moving it to another
  column. That is a genuine re-key that takes the full rebuild path (the same
  device an existing declarative-equivalence regression test uses), but it does
  mean those two arms do not also exercise a column-set change.

## Tripwires already recorded in code (index only — do not re-file)

- `rebuildUserIndexes` in `alter-table.ts` carries a `NOTE:` — an *exposed*
  implicit index's user tags do not survive a rebuild. Conditional: only matters
  if a rebuild-path backend ever exposes implicit indexes with tags. Nothing does
  today.
- A second `NOTE:` was added this run, in `rebuildViaShadowTable` beside the
  drop-suppression block: a CHECK constraint (or partial-index predicate, or
  view/assertion body) whose subquery names its own table makes the shadow's copy
  of that expression a declared dependent of the original, so the separate
  expression-dependency guard in `drop-table.ts` — not the FK guard this change
  suppresses — would refuse the internal DROP. Pre-existing shape, nothing in the
  tree writes such an expression, not handled. The note says what to do if a
  rebuild ever fails that way.
