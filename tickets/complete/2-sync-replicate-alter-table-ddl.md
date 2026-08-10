---
description: Column and constraint changes — adding, dropping or renaming a column, adding or dropping a constraint, changing the primary key — now reach other synced devices, apply idempotently there, and cannot leak phantom changes back onto the wire.
files:
  - packages/quereus-store/src/common/events.ts                    # beginRemoteSchemaScope / endRemoteSchemaScope (replaced expect/clear)
  - packages/quereus-sync/src/sync/store-adapter.ts                # decideAlterTable + decision table; scope-based applySchemaChange
  - packages/quereus/src/index.ts                                  # + exports: expressionToString, namedConstraintExists
  - packages/quereus-store/test/events.spec.ts                     # rewritten for the scope API
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts        # end-to-end two-peer coverage
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # alter_column decision-table coverage
  - packages/quereus-sync/test/sync/schema-alter-table-warnings.spec.ts     # synthetic drives for the two kept warnings
  - docs/sync-schema.md                                            # § What replicates, § Idempotent DDL application
---

# Table alterations replicate

Every `ALTER TABLE` form except `RENAME TO` now crosses the wire and applies
idempotently on the receiver: add / drop / rename column, add / drop / rename
constraint, all `alter column` sub-forms, and `alter primary key`. `RENAME TO`
stays excluded — `sync-replicate-rename-table` owns it.

## What shipped

**Scoped remote-event marking** (`packages/quereus-store/src/common/events.ts`).
The one-for-one remote-event expectation registry (matched on
type+objectType+schema+object, consumed one event per marker, never expired) is
replaced by refcounted scopes keyed on `(schema, object)`:
`beginRemoteSchemaScope` / `endRemoteSchemaScope`. While a scope is open, every
schema event naming that object is marked remote; matching never decrements; the
caller's `finally` releases it. Zero-event and multi-event statements both behave,
closing the two failure classes the old registry produced — a leaked phantom local
change, and a stranded marker swallowing the next genuine local DDL. Tradeoff
(a host issuing local DDL on the very table being replicated at that instant is
mis-marked remote) is documented on the method.

**`alter_column` idempotency** (`decideAlterTable`, store-adapter.ts). The
migration carries only statement text, so the arm parses it with the engine
`Parser` and decides against the local `TableSchema` per a decision table now
mirrored in `docs/sync-schema.md`. `add column` is the only definition comparison,
and only on the logical type; a mismatch throws a conflict naming the column and
both types. Absent table or absent column converge with a warning
(most-destructive-wins). Parse failure logs and executes, so the engine's own
error surfaces.

**Warnings.** Both blank-DDL warnings (origin and receiver) kept for older-build
peers and third-party modules, now driven synthetically in tests.

## Review findings

Reviewed the implement diff (`a7a17765`) against the parser AST definitions, the
store module's event emission sites, and the sync manager's local-capture path;
ran `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn docs:check`.

### Fixed in this pass (minor)

- **A partial UNIQUE was treated as equivalent to an unconditional one.**
  `equivalentUniqueExists` compared only column-index sets, so a local UNIQUE
  carrying a predicate (the constraint a `create unique index … where …`
  synthesizes) converged an incoming unnamed `add unique (…)`. The peer would then
  sit under strictly weaker enforcement than the alteration asked for, and rows
  duplicate-but-outside-the-predicate would replicate here and be rejected on the
  origin. Now `uc.predicate === undefined` is required; regression test added
  (`schema-replication-idempotency.spec.ts`, "a PARTIAL unique over the same
  columns is not equivalent"), decision table in `docs/sync-schema.md` updated.
- **Dropped/renamed-column warning text was stale.** `mergeColumnUpdates` still
  said an unknown column name "could be a sync bug"; with DROP/RENAME COLUMN now
  replicating, the ordinary cause is a change-log fact recorded before the
  alteration arrived. Message reworded to name that cause and say the value is
  discarded; level kept at `warn` so a genuine mismatch still shows.
- **DRY:** the column-index lookup was open-coded in two places and the
  sort-and-join key twice; extracted `localColumnIndex` and `sortedIndexKey`.

### Filed as new tickets (major)

- **`bug-sync-tightening-ddl-applied-before-its-data`** (backlog, `repro: verified`).
  Schema changes are applied ahead of the same batch's row changes, so an
  alteration that *tightens* a rule fails on the very batch carrying the rows that
  satisfy it. Reproduced end-to-end: fill a NULL, then
  `alter column note set not null`, relay both together → `apply-to-store failed
  for 1 change(s): main.orders (alter_column): column note contains NULL values`.
  Self-heals on the next sync round (the row values do land), so the cost is a
  spurious error to the application plus a wasted round trip — not a permanent
  block. Whole class: also `add constraint unique`, narrowing `set data type`,
  `alter primary key`. Newly reachable because these forms did not replicate
  before. NOTE at the `setNotNull` arm and a paragraph in `docs/sync-schema.md`
  point at the ticket.
- **`debt-sync-test-typecheck-blocks-subpath-imports`** (backlog). The sync
  package's `tsconfig.test.json` overrides `moduleResolution` to node10 and
  compiles `src/**/*` as well as `test/**/*`, so the *test* config decides what
  *source* may import — the engine's `/parser` and `/emit` entry points are
  invisible. Verified with a probe file: source config clean, test config
  `TS2307 … could not be resolved under your current 'moduleResolution' setting`.
  That is why the ALTER AST types are derived structurally from `Parser['parse']`
  and why two engine helpers were added to the main index. Both workarounds are
  documented at their sites; the ticket is to unwind them once resolution matches.

### Recorded as tripwires, not tickets

- Two peers concurrently adding the **same unnamed CHECK** enforce it twice (the
  engine auto-names each install). Semantically harmless — same predicate,
  evaluated twice. NOTE at the `addConstraint` arm names the identity to compare
  on (the rendered predicate) if it ever matters.
- `decideAlterTable` trusts the migration's `(schema, table)` envelope and never
  reads `stmt.table`. Unreachable from the real capture path, which files both
  from one event. NOTE at the site says to compare the two if migrations ever
  arrive from outside that path.
- The unknown-column warning emits one line per column per change. NOTE says to
  aggregate per `(table, column)` rather than demote, if a wide table's drop ever
  drowns the log.

### Checked, no finding

- **Phantom index events.** Feared the `(schema, object)` scope key would miss
  index-named events emitted inside an ALTER. It does not: `store-module-alter.ts`
  emits exactly one event, named for the table, gated on `change.ddl !== undefined`;
  DROP COLUMN's dependent-index removal goes through `tearDownIndexStore` and
  `reconcileImplicitUniqueIndexStores`, neither of which emits. Index events come
  only from `createIndex` / `dropIndex`, whose migrations carry the index name as
  the envelope object — so the scope key matches those too.
- **Decision-table arm correctness** against `ast.ts`: `ColumnSchema.defaultValue`
  is `Expression | null`, so the `setDefault === null` / `defaultValue === null`
  comparison is right; `inferType(undefined)` is a legal call, so a typeless
  `add column` does not throw; `AlterTableAction`'s optional-field discipline
  (exactly one populated) matches the `!== undefined` chain, including
  `setNotNull: false`.
- **Emitter refcount semantics** — nested scopes, close-without-open, zero-event
  and multi-event statements are all pinned by `events.spec.ts`.
- **Source hygiene.** `store-adapter.ts` is ~910 lines; this repo files splitting
  tickets at ~1,800 (`debt-emit-source-files-too-large` cites 2,155 and 3,093), so
  no size finding. Functions are short and single-purpose; comment density is high
  but load-bearing.
- **Docs.** `docs/sync-schema.md` was rewritten by the implementer and read
  accurate; the two edits above are the only corrections. No doc or source file
  still references the replaced emitter API — `grep` for
  `expectRemoteSchemaEvent` / `clearExpectedRemoteSchemaEvent` /
  `schemaEventSignature` finds only one deliberate historical mention in a test
  comment explaining what a regression test is guarding.
- **Handoff's own gaps** were each dispositioned above; the implementer's
  `bug-sync-stale-create-migration-conflicts-after-alter` and
  `bug-sync-rename-and-pk-change-strand-crdt-metadata` are on the board and
  correctly out of scope here.

### Validation

`yarn build`, `yarn typecheck`, `yarn lint` clean. `yarn test`: 8615 (engine),
1359 (store), 693 (sync, +1 for the new regression test) and every other package
passing, no failures. `yarn docs:check` reports only the two pre-existing
over-budget docs (`docs/schema.md`, `docs/sync.md`) already tracked by
`debt-docs-size-ratchet-red-again` — `docs/sync-schema.md` is not flagged.
