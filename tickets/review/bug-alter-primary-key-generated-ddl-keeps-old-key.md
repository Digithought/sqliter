---
description: Fixed a bug where changing a table's primary key left the engine writing out SQL that still named the old key column, so a saved table came back with the wrong key after a restart and started accepting duplicates while rejecting legal inserts.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts                        # inline PK now rendered from primaryKeyDefinition
  - packages/quereus/src/schema/table.ts                                # new rekeySchemaPrimaryKey (~591, above createBasicSchema)
  - packages/quereus/src/index.ts                                       # ~196 export
  - packages/quereus/src/schema/column.ts                               # pkDirection NOTE (tripwire)
  - packages/quereus/src/vtab/memory/layer/manager.ts                   # buildRekeyedPrimaryKeySchema delegates; stale NOTE removed
  - packages/quereus-store/src/common/store-module-alter.ts             # alterPrimaryKeyChange delegates
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts        # NEW
  - packages/quereus/test/schema-rekey-primary-key.spec.ts              # NEW
  - packages/quereus/test/alter-table-conformance.spec.ts               # flag/definition agreement + shadow-rebuild leg
  - packages/quereus-store/test/alter-primary-key-persistence.spec.ts   # NEW
  - docs/schema.md                                                      # § DDL Generation
  - docs/module-authoring.md                                            # alterPrimaryKey row + section
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
inline `PRIMARY KEY` clauses (the parser silently merges those back into the old
composite key rather than rejecting).

For the store module that is data corruption, not cosmetics: `alterPrimaryKeyChange`
physically re-keys the KV store and then persists this text, so after `closeAll()` +
reopen the catalog claimed one key while the stored key bytes encoded another —
rehydration reported zero errors, PK uniqueness stopped being enforced on either column,
and a legal `insert into t values (10, 555)` was rejected `UNIQUE` because `id = 10`'s key
bytes aliased a pre-ALTER row whose `code = 10`.

# What changed

**Layer A — the generator renders the key from the definition.**
`generateTableDDLInternal` resolves `inlinePkIndex` once from `primaryKeyDefinition`
(`-1` when there is no single-column inline key to emit) and passes a boolean down;
`formatColumnDef` no longer reads `col.primaryKey` at all. No CREATE-time output changes
— at CREATE the flag and the definition already agree in every shape.

**Layer B — one shared helper restores the flag/definition invariant.**
New `rekeySchemaPrimaryKey(schema, newPkColumns): TableSchema` in `schema/table.ts`
(beside `shiftSchemaIndicesForDrop`, same role), exported from `src/index.ts`. It returns
a frozen schema with a frozen `primaryKeyDefinition` (each member carrying its column's
collation) and a frozen **new** column array of **new** `ColumnSchema` objects with
`primaryKey` / `pkOrder` rebuilt from membership. It never mutates the input columns (the
pre-ALTER schema is the `table_modified` `oldObject` and the memory manager's rollback
snapshot), never writes `pkDirection`, and performs no validation.

Both producers now delegate to it: `MemoryTableManager.buildRekeyedPrimaryKeySchema`
(keeping its bounds/duplicate/NOT-NULL loop) and
`StoreModuleAlter.alterPrimaryKeyChange`. The stale `NOTE:` on
`MemoryTableManager.alterPrimaryKey` documenting the flags as deliberately stale is gone.

The third producer — the engine's shadow rebuild
(`rebuildTableWithNewShape` → `buildShadowTableDdl` → create/copy/drop/rename) — ends at
a parser-built schema and needed no change; that is now asserted rather than assumed (see
below).

**Watch item from the plan resolved as a non-issue.** The store arm previously built its
PK members without `collation`; the shared helper now carries it. This does **not** change
store key encoding: `resolvePkKeyCollations` reads `columns[def.index].collation`, not
`def.collation`. `rehydrate-catalog.spec.ts`'s per-column PK key collation cases and the
full `yarn test:store` run pass unchanged.

# Use cases / how to exercise it

Manual, memory module:

```sql
create table t (id integer primary key, code integer not null);
alter table t alter primary key (code);
-- explain schema  → the CREATE TABLE now puts PRIMARY KEY on "code", not "id"
```

Manual, store module (the corruption case): create `using store`, insert rows,
`alter primary key (code)`, close, reopen — `table_info` reports `code`, a duplicate
`code` is rejected, a duplicate `id` is accepted, and `insert into t values (10, 555)`
succeeds.

Test commands used:

```
yarn lint          # clean
yarn build         # clean
yarn typecheck     # clean
yarn test          # 0 failing (engine 7923 passing, store package 1191 passing)
yarn test:store    # 7913 passing, 22 pending — 0 failing
```

# Test coverage added

`packages/quereus/test/alter-primary-key-generated-ddl.spec.ts` — for single→single,
single→single `desc`, composite→single, single→composite subset, single→composite
all-columns, and composite→composite reordered: the generated DDL names the new key,
carries **exactly one** `PRIMARY KEY` occurrence (zero for the synthesized all-columns
key), and re-parses in a fresh `Database` to an equal key (index + `desc`). Plus an
idempotence case over five unaltered shapes, pinning that CREATE-time output did not move.

`packages/quereus/test/schema-rekey-primary-key.spec.ts` — unit contract for the helper,
modeled on `schema-shift-drop-column.spec.ts`: member order / `desc` defaulting, collation
carried and its BINARY fallback, the empty-key shape, flag mirroring (membership,
1-based `pkOrder`, non-members zeroed), `pkDirection` untouched, other column fields
preserved, input **not** mutated, and everything frozen.

`packages/quereus/test/alter-table-conformance.spec.ts` — new
`expectKeyFlagsAgreeWithDefinition` helper asserted on the `alterPrimaryKey` row, plus a
new explicit test for the **shadow-rebuild** leg (producer 3).

`packages/quereus-store/test/alter-primary-key-persistence.spec.ts` — five cases on the
`createPersistentProvider` close→reopen harness: single→single (persisted catalog text,
zero rehydrate errors, `table_info`, point lookup, new-key UNIQUE enforced, old-key
duplicate accepted, and the `(10, 555)` aliasing insert that failed pre-fix),
composite→single, `desc`, a `catalog.put` trace proving no bundle is *ever* written naming
the retired key, and flag/definition agreement.

# Known gaps / notes for review

- **The conformance matrix's stub leg does not run the `alterPrimaryKey` row.** The plan
  said adding an assertion to that row would cover producers 1 and 3 in one place; it does
  not — the second `describe` filters on `stubUnsupported`, and that row is `false`. Hence
  the separate explicit shadow-rebuild test.
- **That test needs a `renameTable`-keeping stub.** The plain no-`alterTable` stub
  delegates to an inner `MemoryTableModule` whose table map is keyed by name, while
  omitting `renameTable` — so the rebuild's closing DROP + RENAME leaves the module's map
  under the shadow name and the table cannot be connected (`Memory table definition for
  't' not found`). `makeNoAlterModule` now takes `{ withRenameTable }` and the rebuild test
  opts in. I judged this a stub artifact, not a product defect: `renameTable` is documented
  optional precisely for "modules that don't persist by table name", which the stub
  violates by sharing name-keyed state. **Worth a second opinion** — if you disagree, the
  product-side question is whether the engine should reject a rename (rather than proceed)
  for a module that omits the hook.
- **`pkDirection` tripwire parked** as a `NOTE:` on its declaration in
  `schema/column.ts`. The plan's premise was slightly off and the NOTE states the verified
  behavior: an *inline* `a integer primary key desc` **does** populate it, while a
  table-level `primary key (a desc)` leaves it `undefined`, as does
  `rekeySchemaPrimaryKey`. So `buildConstraintsFromColumn`'s reconstructed `ColumnDef`
  carries `direction: undefined` for the table-level and post-ALTER descending shapes.
  Harmless today (every consumer reads `primaryKeyDefinition.desc`); a future module that
  rebuilt its key from that AST would silently flip a `desc` key ascending.
- **New `ColumnSchema` object identity.** Unlike `shiftSchemaIndicesForDrop` (which
  filters the existing objects), the helper builds fresh column objects — required by the
  no-mutation constraint. No identity-dependent consumer surfaced in the full suite, but
  it is the change most likely to bite somewhere untested.
- **Sync not directly tested.** Both modules attach `generateTableDDL(...)` to their
  schema-change events, so a peer replaying a post-ALTER statement is fixed by layer A;
  there is no new test asserting the event payload itself. The `quereus-sync` suite
  (594 passing) is unchanged.
- **`alter primary key ()`** (the empty-key singleton) goes through the helper and emits
  `PRIMARY KEY ()`, but has no dedicated ALTER-path test — only the helper's unit case.
