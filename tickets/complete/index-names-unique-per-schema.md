description: Two tables in the same database could each have an index with the same name, so dropping or re-tagging that index by name silently hit whichever table happened to be registered first. Creating a duplicate name is now rejected up front.
prereq:
files:
  - packages/quereus/src/schema/catalog.ts (isImplicitCoveringIndex ~494, implicitCoveringIndexExposure ~371, isHiddenImplicitIndex ~488)
  - packages/quereus/src/schema/manager.ts (createIndex ~2339, findIndexNameOwnerElsewhere ~2454, importIndex ~3260)
  - packages/quereus/src/schema/schema-differ.ts (duplicate declared index ~292/~338/~361)
  - packages/quereus/src/index.ts (export of isImplicitCoveringIndex)
  - packages/quereus-sync/src/sync/store-adapter.ts (findIndexOwner NOTE)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (counterKey NOTE ~880)
  - docs/sql-ddl.md (§6.3 CREATE INDEX; §5 ALTER INDEX bullet)
  - docs/invariants.md (SCH-001, added in review)
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic
  - packages/quereus/test/schema-manager.spec.ts ("Index names are unique per schema")
  - packages/quereus/test/schema-differ.spec.ts ("duplicate declared index names")
difficulty: medium
----

## What shipped

`docs/sql-ddl.md` asserted "index names are unique per schema" as fact while
nothing enforced it. Every by-name index resolver — `DROP INDEX`,
`ALTER INDEX … TAGS`, and the sync engine's index-owner lookup — finds the owning
table by scanning the schema's tables and stopping at the first hit, and "first"
is table-registration order, which is not stable across devices. The invariant is
now enforced where the ambiguity is introduced.

**Engine.** `SchemaManager.createIndex` rejects a name already held by a *user*
index on another table in the same schema, naming the existing owner:

```
Index 'idx_note' already exists in schema 'main' on table 't1'
```

`IF NOT EXISTS` deliberately does not suppress this (an index of that name on a
different table is a different object, so skipping would leave the requested index
absent with no signal); it still suppresses a same-table duplicate. Matching is
case-insensitive, which required keying `implicitCoveringIndexExposure`'s map
lowercase — widening `isHiddenImplicitIndex` to case-insensitive too, a strict
widening for both its call sites.

**Implicit covering structures are excluded.** The auto-built index backing a
plain `UNIQUE` constraint takes the constraint's name (or `_uc_<cols>`), and
constraint names are unique per *table*, so two tables may each declare
`constraint uq_email unique (email)`. New exported predicate
`isImplicitCoveringIndex(tableSchema, indexName)` in `catalog.ts` answers "is this
an implicit covering structure, hidden or exposed", and `createIndex` skips
anything it matches.

**Rehydration warns, never fails.** `importIndex` logs a warning naming both
owning tables on a collision, then imports as before — a database written before
this rule must still open.

**Declarative differ.** `computeSchemaDiff` keyed `declaredIndexes` schema-wide by
lowercased name, so two `index …` declarations sharing a name silently
last-writer-wins. It now raises a diagnostic, after the reserved-tag diagnostics
so a tag typo still surfaces first.

**Sync.** No code change; `NOTE:` comments at `findIndexOwner` (store-adapter) and
the migration `counterKey` (sync-manager-impl) record that their correctness now
rests on this invariant.

**Docs.** `docs/sql-ddl.md` §6.3 states the rule, the error, the `IF NOT EXISTS`
carve-out, the implicit-structure exclusion, the rehydration warning, and the
`declare schema` diagnostic; the §5 `ALTER INDEX` bullet points at the enforcement
instead of asserting it unbacked. The review pass added the normative statement to
the invariant register as `SCH-001`.

## Review findings

### Verified by re-running, not by reading

- `yarn build` clean; `yarn lint` clean (28s, includes the `tsconfig.test.json`
  type pass over spec files); `yarn workspace @quereus/quereus run test` → **7401
  passing, 13 pending, 0 failing** (7400 before this pass; +1 is the test added
  below). Full `yarn test` across all workspaces green earlier in the pass.
- The new sqllogic file was run **explicitly under the store backend**
  (`QUEREUS_TEST_STORE=true … --grep 10.5.5-index-name-uniqueness`) — passes, so
  the cross-table rejection holds on both backends, not just memory.

### Correctness — checked, nothing wrong found

- **Declarative apply order.** The new `createIndex` rejection could have broken
  any migration that moves an index between tables (drop + recreate under one
  name). `generateMigrationDDL` emits `DROP INDEX` before `CREATE INDEX`
  (schema-differ.ts:2414 vs :2423), and `DROP TABLE` before both, so every
  ordering — move between tables, table renamed, owner dropped — frees the name
  first. Not a regression.
- **`ALTER INDEX` still reaches a user index shadowed by another table's hidden
  implicit structure.** `resolveIndexTagSwap` `continue`s past a hidden implicit
  match rather than returning NOTFOUND, so the case the new check newly permits
  (`create index uq_email on c` while `a` carries an implicit `uq_email`) still
  resolves. Verified by reading manager.ts:1240-1248.
- **Differ status code.** The new throw uses `StatusCode.ERROR`, which is what all
  seven other `computeSchemaDiff` throws use. Consistent.
- **Unreachable guard.** `findIndexNameOwnerElsewhere`'s `if (!schema) return
  undefined` cannot fire from either caller (both resolved a table out of that
  schema first). Harmless defensive code, left alone.

### Two of the handoff's "not covered" gaps are moot — verified

- **temp-schema vs main.** `create temp table` raises `TEMP/TEMPORARY is not
  supported.`, and `createIndex` resolves its table with `getTable(schema, name)`,
  which is exact-schema with no search-path fallback. There is no temp-vs-main
  index-name scenario to cover.
- **Search-path-reached schema.** Same reason: `create index` has no search-path
  arm; unqualified always means the current schema. Nothing uncovered.

### Major — filed as tickets

- **`declare schema` still silently drops duplicate table / view / materialized-view
  / assertion names.** The fix guarded `declaredIndexes` only; the four sibling maps
  in the same collection loop still last-writer-wins. Reproduced all four against
  the built `dist`: two `table t1` declarations produce a migration containing only
  the second (the first table's columns vanish with no diagnostic); same for views
  and assertions; and a name declared as both a `table` and a `view` lands in two
  different maps, so **both** are created and `getSchemaItem` makes the table
  unreachable. Filed
  `tickets/backlog/bug-declare-schema-silently-drops-duplicate-object-names.md`
  with the four reproductions, and noting that the current shape (one
  `let duplicateDeclaredIndex` captured then thrown later) does not generalize to
  five maps.

- **The store/memory divergence the handoff asked about is real — and cuts the
  create side too.** Probed both backends against the built `dist`:
  `create index uq_email on b (email)` where `b` carries
  `constraint uq_email unique (email)` **errors on memory and succeeds on the
  store**. Nothing on the store sees the clash: the engine's per-table check reads
  a schema with no implicit entry, and the store's own `assertStoreNameFree` takes
  occupancy from `collectOccupiedStoreNames`, which also walks the engine-facing
  schema — while the physical store name is
  `buildIndexStoreName(schema, table, indexName)`, identical for both structures.
  So on the store the user index and the constraint's hidden structure share one
  physical index store. UNIQUE enforcement did **not** break in the probe (duplicate
  rejected after the create, and after a following `drop index`, via the store's
  full-scan fallback), so the demonstrated harm is divergence plus aliasing, not
  lost enforcement. Recorded in the existing drop-index ticket (see below).

- **The implement stage filed a duplicate backlog ticket.**
  `bug-drop-index-can-delete-a-unique-constraints-backing-structure` (new) and
  `bug-drop-index-removes-unique-constraint-backing` (pre-existing) are the same
  defect. Consolidated into the pre-existing one — which keeps its own sharper
  framing of the consequence (the constraint silently loses its point-seek) and now
  also carries the backend-divergence table, the create-side finding above, the
  cross-reference distinguishing it from `debt-store-implicit-unique-index-reuse`,
  and a note recommending the four duplicated owner-scans be unified. The duplicate
  file was deleted.

### Minor — fixed in this pass

- **`SCH-001` added to the invariant register** (`docs/invariants.md`). The whole
  premise of the ticket was that `docs/sql-ddl.md` asserted the rule as fact with
  nothing enforcing it; the register is the repo's normative text and its `SCH —
  Schema` area was empty. The entry names `findIndexNameOwnerElsewhere`,
  `isImplicitCoveringIndex`, `computeSchemaDiff`, guards on the
  `schema-manager.spec.ts` suite, and is explicit that exposed implicit structures
  are outside the guarantee. `yarn docs:check` validates its pointers and 120-word
  budget — it passes.
- **`importIndex`'s warning path now has a test.** It was verified by reading only.
  `schema-manager.spec.ts` → "should import a colliding index rather than fail the
  rehydration" imports two same-named indexes on different tables through
  `importCatalog` and asserts both land — pinning the "rehydration must not brick
  an open" contract without needing log capture.
- **Duplicated owner-scan (DRY).** Four copies of "scan a schema's tables for the
  index of this name" now exist (`findIndexNameOwnerElsewhere`, `dropIndex`,
  `resolveIndexTagSwap`, sync's `findIndexOwner`) and they already disagree on
  implicit structures. Not unified here: the correct unification changes
  `dropIndex`'s implicit handling, which is exactly what the drop-index ticket
  will do — doing it now would collide. Recorded there as the shape to adopt.

### Tripwire — parked, not ticketed

- `importIndex` calls `findIndexNameOwnerElsewhere` once per imported index, so a
  cold open costs O(indexes × tables) where `createIndex` costs one scan. Fine at
  present schema sizes. Parked as a `NOTE:` at the call site in `manager.ts`
  suggesting one name→owner map per import if opening a large catalog ever profiles
  slow.

### Deliberately not changed

- **Error-message asymmetry.** The pre-existing same-table error reads
  `Index idx_note already exists on table t1` (unquoted) while the new cross-table
  one quotes both names. Cosmetic; the old string is pinned by existing tests and
  docs, so re-wording it is churn with a blast radius.
- **The differ reports only the first duplicate index name.** Consistent with the
  surrounding structural conflicts; the generalization ticket above is the right
  place to revisit it if it ever matters.
- **`manager.ts` is 3310 lines** and this change added ~70. Not filed: splitting
  the schema manager is an architectural decision, not a review fix, and singling
  out this ticket for a pre-existing size problem would be arbitrary.
- **No sync two-device test.** The sync changes are comments only. A test proving
  `findIndexOwner` and the migration version key are unambiguous would be testing
  the *absence* of a cross-device divergence, which needs the two-device harness;
  worth having but not this ticket's debt to create, and the residual risk is
  covered by `bug-sync-migration-version-key-ignores-object-kind` (already filed,
  and correctly cited by the new `counterKey` NOTE).
- **Exposed implicit covering indexes remain first-match** — the handoff's own
  first gap. Confirmed unfixable at `create index` time (the collision is created
  by `create table`) and correctly parked as a `NOTE:` on
  `findIndexNameOwnerElsewhere`. It is now also stated as an explicit carve-out in
  `SCH-001`, so the register does not over-claim.

### Pre-existing failure recorded

`yarn docs:check` fails at HEAD on three size ratchets — `docs/runtime.md` (+574
words), `docs/schema.md` (+784), `docs/sync.md` (+2782) — none of which this
ticket or its implement commit touched. Written up in
`tickets/.pre-existing-error.md`. Consequence for this pass: the cross-reference
sentences that would have gone into `schema.md`'s differ section and `sync.md`'s
idempotent-DDL section were **deliberately omitted** rather than grow two docs that
are already over budget; the normative statement went to `docs/invariants.md`
instead, which is within its ratchet.
