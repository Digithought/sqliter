---
description: A plain "drop index" could delete the hidden helper structure the database builds behind a UNIQUE constraint, and the same drop/create pair behaved differently on the in-memory backend than on the disk-backed one; both are now refused consistently on both backends.
prereq:
files:
  - packages/quereus/src/schema/manager.ts               # createIndex guard, dropIndex owner scan, importIndex NOTE
  - packages/quereus/src/runtime/emit/drop-index.ts      # strict-DDL-policy owner scan
  - packages/quereus/src/schema/catalog.ts               # collectSchemaCatalog exposure lookup
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic   # both backends
  - packages/quereus/test/schema-manager.spec.ts         # DROP INDEX guard + cross-schema cases
  - packages/quereus/test/covering-structure.spec.ts     # mixed-case catalog + differ idempotency
  - docs/sql-ddl.md                                      # §6.3 rules, ALTER INDEX note
  - docs/schema.md                                       # covering-structure lifecycle, createIndex API steps
difficulty: medium
---

# DROP INDEX / CREATE INDEX no longer touch a UNIQUE constraint's backing structure

## Outcome

Declaring `constraint uq_email unique (email)` makes the engine build a secondary
index behind the constraint for enforcement, named after the constraint (or
`_uc_<cols>` when unnamed). It was already documented as "not a user-addressable
index" and `ALTER INDEX … SET TAGS` on that name already raised `NOTFOUND`, but the
lifecycle verbs had no such guard and disagreed across backends:

| statement, table carries `constraint uq_email unique (email)` | memory (before) | store (before) | both (now) |
|---|---|---|---|
| `drop index uq_email` | succeeded, deleted the structure | `no such index` | `no such index` |
| `create index uq_email on b (email)` | already exists on table b | succeeded | already exists on table b |

The accepted `create index` on the store put the user index and the constraint's
structure on the **same** physical key-value store (`buildIndexStoreName` is a pure
function of schema + table + index name), so a later drop deleted a shared store.
On memory the accepted drop left the table with no indexes while the constraint list
still named `uq_email` — uniqueness fell back to full scan and the registered schema
no longer matched the constraint that produced the structure.

One existing predicate, `isImplicitCoveringIndex(tableSchema, name)`
(`packages/quereus/src/schema/catalog.ts`), is now applied at three write-path sites.
It reads only `tableSchema.uniqueConstraints`, which **both** backends carry, so a
single engine-side change fixed both — no store-package change was needed.

- **`SchemaManager.createIndex`** — the same-table duplicate test also fires when the
  requested name is a constraint's implicit name, with the same message and the same
  `IF NOT EXISTS` silent skip. Runs before `module.createIndex`, so a refusal never
  leaves a half-created physical store.
- **`SchemaManager.dropIndex`** — the owner scan **skips and keeps scanning** past an
  implicit match rather than stopping at it (the shape
  `findIndexNameOwnerElsewhere` already used). No owner found falls through to the
  existing `IF EXISTS` / `no such index` handling.
- **`emitDropIndex`** — its strict-DDL-policy owner scan skips implicit matches too.
- **`collectSchemaCatalog`** — bundled second defect: the exposure map is keyed
  lowercased but was looked up with the raw name, so a **mixed-case** constraint name
  leaked its hidden structure into `catalog.indexes` unmarked, which the declarative
  differ read as a real index and scheduled a `DROP INDEX "UQ_Email"` for against an
  already-converged schema. The lookup now folds case.

Docs: `docs/sql-ddl.md` §6.3 states the `create index` refusal as a
backend-independent rule and adds the `DROP INDEX` rule; the ALTER INDEX note covers
`DROP INDEX` alongside `ALTER INDEX … TAGS`. `docs/schema.md` gained a *Lifecycle*
paragraph next to the existing *Introspection* one and a name-collision step in the
`createIndex` API listing.

## Review findings

### Checked

The implement diff (`4ed9f595`) was read before the handoff summary. Beyond it:

- **Predicate correctness at all four sites.** `implicitCoveringIndexExposure`
  excludes `derivedFromIndex` constraints, so a real `create unique index` stays the
  user's index and stays droppable. `dropIndex`'s `storedIndexName` non-null
  assertion still holds — `ownerTable` only escapes the loop with a matching entry.
  `resolveIndexTagSwap` deliberately keeps the narrower `isHiddenImplicitIndex` (an
  *exposed* structure is a legitimate tag target); that asymmetry is documented at
  both call sites.
- **PRIMARY KEY is not in `uniqueConstraints`** (`extractUniqueConstraints` collects
  only `unique`), so no PK name is caught by the new guard.
- **False-refusal probe.** A UNIQUE that a PK or an earlier user index already covers
  might have had no materialized structure, which would have made the `create index`
  refusal a memory-side regression. Probed empirically on memory for three shapes
  (PK-identical `unique (id)`, `unique (a)` on a composite-PK prefix, and a UNIQUE
  added after `create index ix_email`): memory materializes the structure in **all**
  of them, so `existingIndex` was already true and the refusal is pre-existing
  behavior there. The store now agrees with memory, which is the ticket's goal.
- **Catalog consumers downstream of the case-fold fix.** `computeSchemaDiff` filters
  `CatalogIndex.implicit` out of `actualIndexes` before rename/create/drop, so the
  exposed case was already safe and only the hidden mixed-case leak was live. There
  is no `export_schema` implementation in the tree (docs reference it
  aspirationally), so nothing else consumes the catalog index set.
- **Every doc that mentions the structure**: `docs/sql-ddl.md` (§565, §659, §733,
  §766, §6.3), `docs/schema.md` (§ covering structures, `setIndexTags`,
  `computeSchemaDiff`), `docs/mv-constraints.md`, `docs/lens.md`,
  `docs/module-authoring.md`. Only `schema.md` was stale — see below; the others make
  no lifecycle claim that the change invalidates.
- **Validation, all from the repo root, all green, no skips added or disabled:**
  `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json
  --noEmit`) clean; `yarn build` clean; `yarn test` (whole monorepo) exit 0, with
  `packages/quereus` at 8047 passing / 13 pending; `yarn test:store` 8038 passing /
  22 pending (the 22 are the pre-existing `MEMORY_ONLY_FILES` skips) / 0 failing. No
  pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.

### Minor — fixed in this pass

- **`docs/schema.md` was never touched.** The SchemaManager reference documented the
  *introspection* hiding rule for covering structures but said nothing about their
  lifecycle, and the `createIndex(stmt)` numbered steps omitted name-collision
  validation entirely (a pre-existing omission that predates this ticket's new term).
  Added a *Lifecycle* paragraph naming the predicate and its three sites, plus a
  validation step in the API listing.
- **`emitDropIndex`'s strict-DDL-policy branch was untested** (the implementer
  flagged this). Added section 8 to
  `10.5.7-implicit-unique-index-lifecycle.sqllogic`: under
  `ddl_transaction_policy = 'strict'` inside `begin`, a name held only by a
  constraint's structure fails with `no such index` (the gate never fires), while a
  real index of that name on another table is still found past the skip and the gate
  *does* fire. Confirmed the test bites by reverting the skip — pre-fix the statement
  failed with the policy error claiming the drop "would escape the transaction" for
  an index that does not exist. Runs on both backends.
- **Cross-schema scoping was only covered indirectly** (also flagged). Added
  `should keep the skip-past-implicit scan inside one schema` to
  `schema-manager.spec.ts`: with a `uq_email` constraint on `main.t` and a real
  `uq_email` index on `aux.t2`, an unqualified `drop index uq_email` raises `no such
  index` and leaves aux's index intact, while `drop index aux.uq_email` drops it and
  leaves main's constraint and structure untouched.

### Major — no new tickets filed

Both genuine adjacent defects were already filed by the implementer; each was
re-verified against the tree rather than taken on trust, and both are accurate and
correctly scoped, so neither was re-filed:

- `fix/bug-hidden-implicit-index-leaks-into-introspection` — confirmed:
  `packages/quereus/src/func/builtins/schema.ts` iterates `tableSchema.indexes`
  unfiltered at both TVF sites (`schema()` ~150, `index_info()` ~410), so memory
  lists a hidden structure under any casing while the store lists none. Judged out of
  scope here: it is a distinct pre-existing defect from the four sites this ticket
  names, and it is why the new `10.5.7` file pins the hidden/exposed distinction at
  the catalog level (unit test) rather than through SQL.
- `fix/bug-unique-constraint-name-collides-with-index-name` — the same-table clash
  (`create index foo on t (b); alter table t add constraint foo unique (a);`, both of
  which succeed today) leaves the predicate true for a name a real user index also
  carries, so `drop index foo` is now refused there. Refusing is the right default:
  the state is already broken in worse ways (memory holds two entries literally named
  `foo`) and dropping the user index on a first-match guess would be worse than
  erroring. A `NOTE:` at the `dropIndex` owner scan already says so.
- **DRY:** four hand-rolled "which table owns this index" scans in the engine (five
  counting `quereus-sync`'s `store-adapter.ts`) is the largest remaining structural
  smell, and it is already ticketed as `implement/debt-unify-index-owner-lookup`
  with this slug as its `prereq`. Not re-filed.

### Tripwires

- `importIndex` deliberately does not consult `isImplicitCoveringIndex`, so a store
  catalog written before this fix — the only way a shadowing index can exist — still
  imports it, after which the name resolves to a real index the write path now
  refuses to drop. Only reachable by opening such a database (and repo policy is that
  backwards compatibility is not yet a concern). Parked as a `NOTE:` beside the
  existing rehydration-tolerance comment in `SchemaManager.importIndex`.

### Checked and deliberately left alone

- **Error-message wording.** `create index uq_email on b (email)` reports "Index
  uq_email already exists on table b" even where introspection reports no such index
  (the store today, both backends once the introspection-leak ticket lands). A
  constraint-specific message would read better, but a pre-existing test
  (`should still raise the same-table error for a name held by that table's implicit
  index`) deliberately pins this message and comments that the per-table check "must
  keep owning" the case; backend parity holds either way. Cosmetic, not a defect.
- **Test placement.** The mixed-case `collectSchemaCatalog` assertion went into
  `covering-structure.spec.ts` rather than `schema-manager.spec.ts` as the implement
  ticket asked. Left as-is: it sits next to the existing "introspection hiding" and
  declarative-idempotency cases that already own that surface and already import
  `collectSchemaCatalog`.
- **Source hygiene.** Comment density on the new guards is high but matches the
  surrounding file's established style; no file grew materially and no function grew
  past a single purpose. No `any`, no swallowed exceptions, no new resource paths.
