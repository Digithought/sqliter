description: Declaring a table column with a custom text-sorting rule the application registered on the connection is now accepted, while an unregistered rule is rejected up front for every column type.
prereq:
files:
  - packages/quereus/src/schema/table.ts                 # validateCollationForType (registry-aware), columnDefToSchema (4th param)
  - packages/quereus/src/core/database.ts                # isCollationRegistered()
  - packages/quereus/src/core/database-internal.ts       # isCollationRegistered on DatabaseInternal
  - packages/quereus/src/schema/manager.ts               # buildColumnSchemas threads predicate (CREATE + importTable + logical/lens)
  - packages/quereus/src/runtime/emit/alter-table.ts     # runAlterColumn SET COLLATE threads rctx.db predicate
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn / addColumn / renameColumn thread this.db predicate
  - packages/quereus-store/src/common/store-module.ts    # alterColumnSetCollation / alterAddColumn / alterRenameColumn thread db predicate
  - packages/quereus-isolation/src/isolation-module.ts   # deriveAddColumnBackfill threads db predicate
  - packages/quereus/src/planner/analysis/sat-checker.ts # tryResolve doc: unknown-branch now DDL-unreachable (tripwire)
  - packages/quereus/test/vtab/memory-collation-per-database.spec.ts
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts
  - packages/quereus-isolation/test/collation-resolver.spec.ts
  - docs/schema.md
----

# Complete: column DDL accepts registered collations

## What shipped

Column-DDL collation gate (`validateCollationForType` in `schema/table.ts`) is now
registry-aware. An explicit column `COLLATE <name>`:
- `BINARY` → always accepted (fast-path, ahead of every list check);
- name on the type's supported list (TEXT's `BINARY`/`NOCASE`/`RTRIM`) → accepted;
- empty-list type (`JSON`, temporal) → every non-BINARY name rejected, registered or not;
- otherwise (TEXT off-list, or a no-list type `INTEGER`/`REAL`/`BLOB`/`ANY`) → accepted
  **iff** the connection registered the collation (`db.isCollationRegistered(name)`), else
  rejected with `Unknown collation '<name>' for type '<type>' …`.

New public `Database.isCollationRegistered(name)` (also on `DatabaseInternal`) is threaded
into every column-DDL site with a live `db`: CREATE + catalog rehydrate (`buildColumnSchemas`
choke point, shared by `createTable`/`importTable`/`buildLogicalTableSchema`), engine
`ALTER COLUMN SET COLLATE`, memory add/rename/alter, store add/rename/setcollation, isolation
`deriveAddColumnBackfill`. Db-less `createBasicSchema` passes no predicate → legacy static-list
branch, byte-for-byte (and never emits a COLLATE anyway — its constraint list is empty).

Headline behavior tightening: `INTEGER/REAL/BLOB collate <unregistered>` is now rejected at
DDL (previously accepted, then failed later at comparator build with `no such collation
sequence`). `collate binary` on JSON/temporal now accepted (BINARY fast-path). Reopen replays
CREATE DDL through the same gate, so a persisted custom-collation column reopens cleanly only
when the collation is re-registered — a loud, documented, no-silent-fallback failure.

## Review findings

Adversarial pass over the implement diff (`877487ab`). Checked from correctness, DRY,
completeness-of-wiring, error-shape, type-safety, and test-coverage angles.

**Correctness — clean.** `validateCollationForType` branch order is sound and total: BINARY
fast-path → type-list include → empty-list reject → registry gate → typed throw. No path
wrong-accepts an unregistered name (predicate is `BINARY || _getCollation !== undefined`;
built-ins `NOCASE`/`RTRIM` live in the collations map so they resolve on no-list types) and
none wrong-rejects a registered/valid one. Case/whitespace normalization (`normalizeCollationName`)
is applied identically at the gate and in the registry.

**Wiring — complete.** Enumerated every `columnDefToSchema` / `validateCollationForType`
caller in `packages/**/src`. All sites with a live `db` thread the predicate; the sole db-less
caller (`createBasicSchema`) never carries a COLLATE constraint. `importTable` confirmed to
route through `buildTableSchemaFromAST` → `buildColumnSchemas` (manager.ts:1845), so the
reopen-revalidation claim is real, not aspirational. Store `alterColumnSetCollation` has a
single caller, threaded.

**Tests — comprehensive, all green.** Implementer's new `column DDL accepts a registered
collation` describe covers happy path (REVERSE on TEXT PK orders descending), case/whitespace
variants, registered built-in on INTEGER no-op, empty-list JSON reject, BINARY-on-JSON
fast-path, ALTER SET COLLATE registered/unregistered, and reopen round-trip (both re-registered
success and unregistered throw). Flipped tests in isolation + memory + predicate-contradiction
specs reflect the new reject-at-DDL shape. No happy/edge/error gap found worth adding inline.

- `yarn workspace @quereus/quereus run lint` → **exit 0** (eslint + tsc typecheck of specs).
- `yarn workspace @quereus/quereus run test` → **6968 passing, 13 pending, 0 failing**.
- `yarn workspace @quereus/isolation run test` → **245 passing**.
- `yarn workspace @quereus/store run test` → **948 passing** ("Data change listener error: boom"
  is an intentional listener-error test, unrelated).

**Docs — current.** `docs/schema.md` gained a "Column COLLATE validation (declaration time)"
section and the `ANY_TYPE` note was corrected to explain NOCASE passes because it is a
registered built-in. Read every touched file; docs reflect new reality.

**Minor — handoff mischaracterization, no code change (noted, not fixed).** The implement
handoff listed "the view-MV DDL helper" among *db-less legacy* callers that keep static-list
behavior. In fact `buildLogicalTableSchema` (manager.ts:1904, the lens/logical-table helper)
routes through `buildColumnSchemas` and IS registry-gated now — it has a live `this.db`, so
the predicate is threaded correctly. This is a strict tightening (an unregistered explicit
COLLATE on a lens logical-table column now throws at declaration instead of sliding through),
consistent with the feature intent, and no test regressed. Behavior is correct/better; only
the prose label was wrong. No action.

**Tripwire (recorded, not a ticket).** `sat-checker.ts` `tryResolve` unknown-branch is now
DDL-unreachable — CREATE rejects the unregistered collation before the planner sees it. The
defensive catch is kept as cheap insurance; reasoning is recorded as a `NOTE:`-style doc
comment at the site and the branch stays directly unit-tested at
`predicate-contradiction.spec.ts:294` ("a resolver that throws on the name degrades to unknown,
not to BINARY"). No action unless a future path reintroduces an unvalidated collation onto a
column.

**Major findings:** none — no new tickets filed.

## Known gaps carried forward (from implement, still open, non-blocking)

- Store-mode `.sqllogic` cannot call `registerCollation`, so store-mode coverage of a
  *registered custom* collation (vs built-ins) on CREATE and `ALTER … SET COLLATE` — including
  the store's physical PK re-key path — is not exercised end-to-end. The store code change is
  mechanical (same predicate as memory) and the memory spec covers the custom path fully; a
  store `.spec.ts` registering a collation in JS would close it. Full `yarn test:store` (all
  logic tests under LevelDB) was not run — only store unit specs + filtered store-mode collation
  sqllogic. Not a defect; a coverage gap.
- Isolation/store test edits are not tsc-typechecked (those packages' `lint` is a no-op; edits
  are string literals + comments, ran green under mocha).
