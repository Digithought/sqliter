description: Dropping a table, adding an index, or dropping an index now actually reaches the other synced devices instead of going over the wire as an instruction that does nothing.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts (generateDropTableDDL / generateDropIndexDDL + casing NOTE)
  - packages/quereus/src/index.ts:198 (export barrel)
  - packages/quereus/src/schema/manager.ts:2514 (NOTE on emitAutoSchemaEventIfNeeded)
  - packages/quereus-store/src/common/store-module.ts:834, :1075, :1153 (three attach sites)
  - packages/quereus/src/vtab/memory/module.ts:255, :916 (create/drop table)
  - packages/quereus/src/vtab/memory/layer/manager.ts:2762, :2827 (create/drop index)
  - packages/quereus-sync/src/sync/store-adapter.ts (blank-DDL comment corrected in review)
  - packages/quereus-sync/test/sync/schema-ddl-replication.spec.ts (14 cases end-to-end)
  - packages/quereus/test/vtab/memory-schema-ddl.spec.ts (6 cases, direct event assertions)
  - docs/sync.md (§ What replicates; § Idempotent DDL application)
difficulty: medium
----

## What shipped

A device records a schema change as an event carrying the SQL text that produced
it; sync ships that text to the other devices and re-runs it there. Only
`create table` was attaching text, so `drop table`, `create index` and
`drop index` crossed the wire as an empty statement and the receiving device did
nothing — silent divergence, no error anywhere.

Two generators were added beside the existing ones in `ddl-generator.ts`:

```ts
generateDropTableDDL(schemaName, tableName)  // drop table "main"."orders"
generateDropIndexDDL(schemaName, indexName)  // drop index "main"."idx_orders_note"
```

Both use the file's `quoteName` helper, so they qualify and quote the way
`generateTableDDL` / `generateIndexDDL` do, and both are exported from the
package barrel. Text is now attached at seven emit sites — three in the store
module (drop table, create index, drop index) and four in the memory module
(create/drop table, create/drop index).

`alter` events in both modules were deliberately left alone; ALTER TABLE
replication is `sync-alter-table-migrations-are-silent`, already in `implement/`.
The receiving side's blank-DDL short-circuit stays, because `alter_column` still
arrives blank and so does anything from a peer on an older build.

## Review findings

Implement-stage diff read first (`git show 8f08c4c2`), then the surrounding
code, then the handoff. Validation: `yarn build`, `yarn typecheck`, `yarn lint`,
`yarn test` — all clean, **0 failing** (7390 + 579 + the rest of the workspace).
`yarn test:store` was not run, per AGENTS.md; the store paths here are covered by
the quereus-sync specs, which are store-backed by construction.

### Fixed in this pass (minor)

- **A stale comment in the receiving adapter contradicted the change.**
  `store-adapter.ts` still opened `applySchemaChange` with "Every store schema
  event except `create_table` replicates with a blank `ddl`" — false as of this
  work, and it is the comment that explains why the blank-DDL early return
  exists. Rewritten to name what actually still arrives blank (`*_column`
  migrations, and anything from an older peer).

- **Three test comments claimed to exercise a branch they never reach.** Idempotent
  re-delivery is absorbed by a *first* gate — the `(schema, object, version)` +
  HLC guard in `change-applicator.ts` — before the adapter's `decideSchemaChange`
  is ever called. The "applied twice" and "receiver independently created the
  identical index" cases are all skipped there, so their stated rationale
  ("the receiver finds it already present and converges") was wrong even though
  the assertions were fine. Comments corrected to say which gate absorbs them.

- **One test comment was factually wrong.** "converges when the receiver never had
  the index" asserted that `b` never received the create — but `relayAll` ships
  the whole migration log, so `b` created the index and then dropped it. Rewritten
  to strip the `add_index` migration out of the relayed batch, so the drop now
  genuinely arrives for an index `b` does not have. It reaches the intended branch
  (`[Sync] Remote drop_index … already applied locally` appears in the run log).

- **The byte-equality that the whole convergence design rests on was untested
  end-to-end.** The implementer's assertion compared two *locally regenerated*
  strings (`indexDDL(a)` vs `indexDDL(b)`), never the string the origin actually
  put on the wire against what the receiver regenerates. Added
  *"converges through the already-applied branch when the receiver created it
  first"*: the receiver writes first so the incoming migration carries the greater
  HLC, is admitted past the first gate, and hits `assertDefinitionMatches` — which
  throws on any rendering difference. Confirmed reaching it
  (`[Sync] Remote add_index … already applied locally`).

- **Untested index shapes** (the handoff flagged these). Added
  *"replicates a unique partial index and keeps it enforcing on the receiver"* —
  a `create unique index … where note is not null` round trip that checks the
  `unique` flag survived, that both peers render identical canonical text, and
  that a duplicate insert is actually rejected on the receiver. UNIQUE + partial
  in one case covers the two clauses `generateIndexDDL` emits beyond the plain
  form; index tags and non-`main` schemas remain uncovered and are noted below.

- **The idempotency docs described only one of the two gates.** `docs/sync.md`
  § Idempotent DDL application read as though `decideSchemaChange` was the whole
  story. Added the `change-applicator.ts` version/HLC gate that precedes it,
  including the detail that an index migration's identity is the index name with
  no table component — which is what the new `fix/` ticket below turns on.

### Filed as tickets (major)

- **`fix/index-names-not-unique-per-schema`** — `docs/sql-ddl.md:696` states index
  names are unique per schema; nothing enforces it. `create index idx_note on t2`
  succeeds after `create index idx_note on t1`, and every by-name resolver
  (`DROP INDEX`, `ALTER INDEX`, index tags, and now sync) takes a first-match scan
  over the schema's tables. Reproduced directly against a memory-backed database:
  the second create is accepted, and the unqualified drop hits `t1`. This diff
  makes it reachable across devices — `drop index "main"."idx_note"` has no place
  to name the owning table, so a receiver whose table order differs drops the
  other one and both sides believe they converged. Filed to `fix/` rather than
  `backlog/` because there is a clean repro and the fix is to enforce an already
  documented invariant.

- **`backlog/bug-sync-materialized-views-replicate-as-plain-tables`** — the store
  module's create-table event renders with `generateTableDDL`, which emits column
  shape only. A maintained table (materialized view) therefore ships peers a plain
  `create table`: they get an empty table with no derivation that never refreshes.
  `generateMaintainedTableDDL` exists and the catalog path uses it; the event path
  does not. **Pre-existing, not caused here** — `create_table` was already the one
  migration carrying real text. Filed to `backlog/` because the first question is a
  design decision (should a materialized view replicate as a definition at all, or
  be excluded from replication?), not an implementation.

### Recorded as tripwires, not tickets

- **Drop text is lowercase while CREATE text is uppercase**, inside one file. The
  handoff asked for a second opinion. Lowercase is the repo convention
  (`AGENTS.md`) and the CREATE generators are the outliers — they are uppercase
  because their output is compared byte-for-byte against persisted catalog text
  and cannot be changed casually. Nothing compares drop text (sync and the catalog
  both treat a drop as presence), so the split is harmless. Left as-is with a
  `NOTE:` at `generateDropTableDDL` saying the casing must be pinned on both sides
  first if a drop's text ever becomes a comparison key.

### Checked and found clean

- **Spurious drop events.** `StoreModule.destroy` is the only store site emitting a
  table drop; `reclaimDetachedTable` (basis eviction) deliberately emits none, and
  the memory module's `destroy` emits only when it actually held the table. No path
  found where a rename, an ALTER rebuild, or a close emits a drop.
- **Implicit indexes are not replicated.** The hidden `_uc_*` structures backing
  plain UNIQUE constraints never route through `module.createIndex` — they are
  materialized inside the store module's own paths — so the new `create index` text
  cannot leak one onto the wire.
- **Origin/receiver rendering symmetry.** The origin renders from the index schema
  built pre-append and the receiver from its post-append catalog entry; both go
  through `appendIndexToTableSchema` with the same object, so the strings agree.
  Now proven end to end by the new already-applied test rather than by inspection.
- **Event-count accounting.** `drop table` over an indexed table emits exactly one
  event on both modules (tested in both packages), so the receiver's
  one-expectation-per-migration bookkeeping stays balanced.
- **The `emitAutoSchemaEventIfNeeded` parking decision** (the handoff asked for a
  second opinion). Agreed: the fallback has no object schema to render from, and
  nothing routes memory-backed tables through sync today. A `NOTE:` at the
  definition is the right weight — a ticket would sit unworked.
- **Docs touched by the change.** `docs/usage.md`'s schema-event table already
  documents `ddl` generically ("DDL statement if available") and needs nothing;
  `docs/module-authoring.md` documents `SchemaChangeInfo` (the ALTER hook), not
  event emission, so it is not the place for the new attach-canonical-DDL
  expectation — `docs/sync.md` § What replicates is, and it says so.
- **The memory tests' package placement** (the handoff flagged the deviation).
  Correct as placed: the memory module is `packages/quereus`'s code and that
  package's `lint` type-checks its own test files.

### Deliberately not addressed

- **Index tags and non-`main` schemas** still have no sync round-trip test. The
  generators handle both by the same code paths the store catalog already persists
  and re-parses, and the drop generators take the schema name explicitly. Left
  uncovered rather than filed: after the UNIQUE/partial case above, the remaining
  risk is in shared, already-exercised rendering code, not in this change.
- **The one-directional conflict test** the handoff warned about is real and now
  documented in place — the sibling case in the create-table spec sits in the same
  trap. The added already-applied test is the symmetric counterpart, so both HLC
  directions are now covered by *something*.
