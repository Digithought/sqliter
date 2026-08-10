---
description: Fixed a bug where changing a table's primary key left the engine writing out SQL that still named the old key column, so a saved table came back with the wrong key after a restart and started accepting duplicates while rejecting legal inserts.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts                        # inline PK rendered from primaryKeyDefinition
  - packages/quereus/src/schema/table.ts                                # rekeySchemaPrimaryKey (~587)
  - packages/quereus/src/index.ts                                       # ~196 export
  - packages/quereus/src/schema/column.ts                               # primaryKey/pkOrder mirror doc; pkDirection NOTE (tripwire)
  - packages/quereus/src/vtab/memory/layer/manager.ts                   # buildRekeyedPrimaryKeySchema delegates
  - packages/quereus-store/src/common/store-module-alter.ts             # alterPrimaryKeyChange delegates
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts        # NEW
  - packages/quereus/test/schema-rekey-primary-key.spec.ts               # NEW
  - packages/quereus/test/alter-table-conformance.spec.ts                # flag/definition agreement + shadow-rebuild leg
  - packages/quereus-store/test/alter-primary-key-persistence.spec.ts    # NEW
  - docs/schema.md                                                       # § DDL Generation
  - docs/module-authoring.md                                             # alterPrimaryKey row + section
difficulty: medium
---

# What was wrong

A table's key is recorded twice in `TableSchema`:

- `primaryKeyDefinition` — the authoritative ordered `{ index, desc, collation }` list.
- per-column flags on each `ColumnSchema` — `primaryKey`, `pkOrder`, `pkDirection`.

`ALTER TABLE … ALTER PRIMARY KEY` was the only operation that broke the agreement: every
producer swapped the definition and left the flags at their CREATE-time values. The DDL
generator's *inline single-column* `PRIMARY KEY` branch read the **flag**, so after a
re-key it emitted DDL naming the retired key — and on a composite→single move, **two**
inline `PRIMARY KEY` clauses (the parser silently merges those back into the old composite
key rather than rejecting).

For the store module that is data corruption, not cosmetics: `alterPrimaryKeyChange`
physically re-keys the KV store and then persists this text, so after `closeAll()` +
reopen the catalog claimed one key while the stored key bytes encoded another —
rehydration reported zero errors, PK uniqueness stopped being enforced on either column,
and a legal `insert into t values (10, 555)` was rejected `UNIQUE` because `id = 10`'s key
bytes aliased a pre-ALTER row whose `code = 10`.

# What was done

**Layer A — the generator renders the key from the definition.**
`generateTableDDLInternal` resolves `inlinePkIndex` once from `primaryKeyDefinition`
(`-1` when there is no single-column inline key to emit) and passes a boolean down;
`formatColumnDef` no longer reads `col.primaryKey` at all. CREATE-time output is unchanged
— at CREATE the flag and the definition already agree in every shape.

**Layer B — one shared helper restores the flag/definition invariant.**
`rekeySchemaPrimaryKey(schema, newPkColumns): TableSchema` in `schema/table.ts` (beside
`shiftSchemaIndicesForDrop`, same role), exported from `src/index.ts`. Returns a frozen
schema with a frozen `primaryKeyDefinition` (each member carrying its column's collation)
and a frozen **new** column array of **new** `ColumnSchema` objects with `primaryKey` /
`pkOrder` rebuilt from membership. It never mutates the input columns (the pre-ALTER schema
is the `table_modified` `oldObject` and the memory manager's rollback snapshot) and never
writes `pkDirection`.

Both membership-changing producers delegate to it: `MemoryTableManager.buildRekeyedPrimaryKeySchema`
(keeping its bounds/duplicate/NOT-NULL loop, which produces the user-facing rejections) and
`StoreModuleAlter.alterPrimaryKeyChange`. The third producer — the engine's shadow rebuild
(`rebuildTableWithNewShape` → create/copy/drop/rename) — ends at a parser-built schema and
needs no change; that is now asserted rather than assumed.

Docs updated: `docs/schema.md` § DDL Generation (the key is rendered from the definition,
never the flags) and `docs/module-authoring.md` (`alterPrimaryKey` contract row + a
"build the returned schema with `rekeySchemaPrimaryKey`" section).

# Verification

```
yarn lint        # clean
yarn build       # clean
yarn typecheck   # clean
yarn test        # 0 failing — engine 7926 passing / 13 pending, store pkg 1191, sync 594, others green
yarn test:store  # 0 failing — 7917 passing / 22 pending
```

Manual, memory module:

```sql
create table t (id integer primary key, code integer not null);
alter table t alter primary key (code);
-- explain schema  → the CREATE TABLE now puts PRIMARY KEY on "code", not "id"
```

Manual, store module (the corruption case): create `using store`, insert rows,
`alter primary key (code)`, close, reopen — `table_info` reports `code`, a duplicate `code`
is rejected, a duplicate `id` is accepted, and `insert into t values (10, 555)` succeeds.

# Test coverage

`packages/quereus/test/alter-primary-key-generated-ddl.spec.ts` — for single→single,
single→single `desc`, composite→single, single→composite subset, single→composite
all-columns, **single→empty (`primary key ()`)**, and composite→composite reordered: the
generated DDL names the new key, carries exactly one `PRIMARY KEY` occurrence (zero for the
synthesized all-columns key), and re-parses in a fresh `Database` to an equal key. Plus a
round-trip idempotence case over five unaltered shapes, pinning that CREATE-time output did
not move.

`packages/quereus/test/schema-rekey-primary-key.spec.ts` — unit contract for the helper:
member order / `desc` defaulting, collation carried and its BINARY fallback, the empty-key
shape, **out-of-range and repeated index rejection**, flag mirroring (membership, 1-based
`pkOrder`, non-members zeroed), `pkDirection` untouched, other column fields preserved,
input not mutated, everything frozen.

`packages/quereus/test/alter-table-conformance.spec.ts` — `expectKeyFlagsAgreeWithDefinition`
asserted on the `alterPrimaryKey` row, plus an explicit test for the shadow-rebuild leg.

`packages/quereus-store/test/alter-primary-key-persistence.spec.ts` — five cases on the
close→reopen harness: single→single (persisted catalog text, zero rehydrate errors,
`table_info`, point lookup, new-key UNIQUE enforced, old-key duplicate accepted, and the
`(10, 555)` aliasing insert that failed pre-fix), composite→single, `desc`, a `catalog.put`
trace proving no bundle is ever written naming the retired key, and flag/definition agreement.

# Review findings

## Checked

- **The implement diff read first**, source + tests + docs, before the handoff summary.
- **Every producer of a re-keyed schema enumerated** by grepping `primaryKeyDefinition:`
  writers across all packages, not just the two the handoff names. Membership-changing
  producers: the memory manager, the store alter arm (both now via the helper), and the
  engine's shadow rebuild (parser-built, asserted). Non-membership writers — `alterColumn`'s
  `set collate` re-key, `shiftSchemaIndicesForDrop`, `addColumn`'s `insertAtIndex`, the
  materialized-view backing builder, the memory manager's construction/rehydrate paths —
  move indices or comparators, not membership, so the mirror stays valid by construction.
  No producer in `quereus-isolation` or `quereus-sync`.
- **Every flag consumer enumerated**: four planner access/join rules (uniqueness hints),
  `schema/catalog.ts`'s per-column `primaryKey` in the exported catalog, the `RENAME COLUMN`
  `ColumnDef` rebuild, the materialized-view backing column def, and `findColumnPKDefinition`
  (CREATE-only). All of them were reading the stale flag pre-fix and are corrected by layer B
  — the fix is wider than the DDL generator alone.
- **The `RENAME COLUMN` AST rebuild is really consumed**, not decorative: both modules feed
  it through `columnDefToSchema`. Both also carry `primaryKeyDefinition` over from
  `oldSchema`, which is what keeps the `pkDirection` gap a tripwire rather than a live bug.
- **`DROP COLUMN` of a PK member** — the other candidate for mirror divergence, since
  `shiftSchemaIndicesForDrop` filters existing column objects and would leave a surviving
  composite member's `pkOrder` stale. Probed directly: the engine rejects the statement
  ("Cannot drop PRIMARY KEY column 'a'"), so the divergence is unreachable from SQL. Not a
  defect, no ticket.
- **The sync claim in the handoff.** Loose but harmless: `generateTableDDL` rides the
  *create* event and the store's catalog bundle, not the alter event. `decideSchemaChange`
  in `quereus-sync/src/sync/store-adapter.ts` compares generated DDL only for
  `create_table` / `add_index`; an alter migration falls to `execute`, replaying the raw
  `alter table … alter primary key` SQL. So a peer is fixed by layers A and B and needs no
  separate change. Suite green (594 passing).
- **The store collation claim.** Confirmed inert as stated: the helper carries
  `def.collation`, but store key encoding resolves from `columns[def.index].collation`.
- **`resolvePkDefaultConflict` after a re-key.** It iterates `primaryKeyDefinition`, so the
  retired column's column-level `on conflict` action correctly stops governing and a new
  member's starts. Correct by construction — noted, not a finding.
- **Source hygiene.** `schema/table.ts` is 1442 lines; the helper adds ~95 (a third of it
  doc). Sizeable, but it is the canonical home for schema mutations and matches its
  `shiftSchemaIndicesForDrop` sibling's doc density, so the placement and weight are right.
  No split warranted here.
- **lint, build, typecheck, test, and test:store all run and pass** (numbers above). No
  pre-existing failures surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

## Fixed in this pass (minor)

- **`rekeySchemaPrimaryKey` silently accepted a self-inconsistent key list.** An
  out-of-range index produced a definition member addressing no column (the `?.collation`
  optional chain swallowed it into a `BINARY` fallback); a repeated index produced a
  definition with more members than the `pkOrder` mirror can order, i.e. exactly the
  flag/definition disagreement this ticket exists to remove. Unreachable from SQL (both
  callers or the engine emitter resolve by name first) but reachable from a wrapper driving
  the module API. Now asserts `INTERNAL` for both, matching how the sibling
  `shiftSchemaIndicesForDrop` asserts its column index. User-level NOT-NULL validation
  deliberately stays with the callers. Two unit tests added; `docs/module-authoring.md`'s
  "performs no validation" sentence corrected.
- **`ColumnSchema.primaryKey` / `pkOrder` JSDoc said nothing about being a mirror** — the
  one site a reader lands on when they wonder which record is authoritative, while the
  explanation lived only in `docs/` and in the helper. Added, pointing at
  `rekeySchemaPrimaryKey`.
- **The `pkDirection` NOTE covered only one direction of the gap.** It described a
  table-level / post-ALTER `desc` key reconstructing as `direction: undefined`; the
  symmetric case also exists — a column created `integer primary key desc` and later
  ALTERed ascending keeps `pkDirection: 'desc'` and reconstructs as descending. Extended.
- **A test title overclaimed.** "leaves an unaltered table's DDL byte-identical (no
  CREATE-time change)" asserts round-trip idempotence, not equality against pre-fix output.
  Retitled.
- **`alter primary key ()` had no ALTER-path test** (the handoff's own stated gap). Probed
  and added as a case: exactly one `PRIMARY KEY ()` clause, flags cleared, round-trips.
- **`columnDefs` built with `forEach` + `push`** where a `map` says it directly. Collapsed.

## Major (new tickets)

None. The change is a two-layer fix with one shared helper, both callers delegating, docs
matched to it, and the third producer asserted; the only defects found were the small ones
fixed above.

## Second opinion requested by the handoff

The conformance suite's `alterPrimaryKey` shadow-rebuild test needs a stub that keeps
`renameTable`. **Agree with the implementer: stub artifact, not a product defect, no
ticket.** The engine's policy for a module without `renameTable` is a catalog-only rename,
and that is the same policy plain `ALTER TABLE … RENAME TO` follows — the shadow rebuild is
not doing anything special. `renameTable` is documented optional precisely for modules that
do not persist by table name; the stub delegates to a name-keyed `MemoryTableModule` while
omitting the hook, so it violates the contract it is claiming. Making the engine refuse a
rename for such a module would be a behavior change on the general rename path, not a fix
to this ticket.

## Tripwires (parked, not ticketed)

- **`pkDirection` is populated by only one authoring form.** Parked as the `NOTE:` on its
  declaration in `packages/quereus/src/schema/column.ts` (extended this pass to cover both
  directions of drift). Fine today because every consumer reads `primaryKeyDefinition.desc`;
  it only becomes work if a module is added that rebuilds its key from the `ColumnDef` AST
  that `RENAME COLUMN` reconstructs.
- **New `ColumnSchema` object identity.** Flagged by the handoff and re-checked here: the
  helper builds fresh column objects (required by the no-mutation constraint) where
  `shiftSchemaIndicesForDrop` filters existing ones. Both full suites pass and no consumer
  compares column objects by identity, so there is nothing to park at a code site — recorded
  here only.
