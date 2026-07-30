---
description: Changing a table's primary key part-way through a transaction used to throw away everything that transaction had written to the table while the commit still reported success; the in-memory table now re-keys itself in place, so those writes (and their change notifications) survive.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterPrimaryKey + buildRekeyedPrimaryKeySchema; shared re-key pre-pass
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # prepare/installRekeyedPrimaryKeyColumns; netOwnWriteEffects (review: shared collapse head)
  - packages/quereus/src/vtab/memory/module.ts               # alterPrimaryKey arm delegates to the manager
  - packages/quereus/src/vtab/memory/table.ts                # alterSchema arm delegates; validate-only allowed for alterPrimaryKey
  - packages/quereus/src/runtime/emit/alter-table.ts         # rebuildMemoryTable DELETED; rebuild fallback is shadow-SQL only
  - packages/quereus/test/alter-primary-key-in-transaction.spec.ts  # regression matrix, 24 tests, two producer legs
  - packages/quereus/test/alter-table-events.spec.ts         # ALTER PK arms assert row survival too
  - packages/quereus/test/alter-table-conformance.spec.ts
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus/test/declarative-equivalence.spec.ts    # review: comments referencing the deleted rebuild
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic
  - packages/quereus-isolation/src/isolation-module.ts       # comment-only
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # refusing stub + native end-to-end test
  - packages/quereus-isolation/README.md                     # review: stale "memory rejects ALTER PRIMARY KEY"
  - docs/memory-table.md, docs/sql-ddl.md, docs/module-authoring.md, docs/design-isolation-layer.md
difficulty: hard
---

# What shipped

`alter table … alter primary key` on a memory table is now an **in-place re-key**. The engine's
memory-specific rebuild fallback — which built a fresh table from the *committed* rows only and
discarded the open transaction's pending layer, deleting its writes while the commit reported
success — is deleted. `MemoryTableModule.alterTable` handles the change natively; the generic
shadow-table rebuild remains only for a third-party module that answers `UNSUPPORTED`.

## Mechanism

`MemoryTableManager.alterPrimaryKey(newPkColumns, rows?, validateOnly?)` follows `alterColumn`'s
ordering contract: latch → `ensureSchemaChangeSafety()` → resolve/reject the definition
(`buildRekeyedPrimaryKeySchema`: bounds, duplicates, NOT NULL, each member carrying its column's
collation) → the shared two-question re-key pre-pass `validateRekeyedPrimaryKey` (visible
collision → sited `CONSTRAINT`; collision only a rollback could restore → retryable `BUSY`) →
`validateOnly` returns here → prepare every open layer → rebuild the base (secondary indexes,
then the strict primary tree, with undo recorded) → swap the manager schema → install
oldest-first → emit one `{type:'alter', objectType:'table'}` schema-change event.

Open-layer adoption is a two-phase prepare/install pair
(`TransactionLayer.prepareRekeyedPrimaryKeyColumns` / `installRekeyedPrimaryKeyColumns`), because
three things must be re-derived from row images that only the intact pre-rebuild chain resolves:
a net **deletion**'s new key (an own-write logs a delete by key alone); a **shadowed parent
image** whose new key diverges from the upsert that replaced it (else the row duplicates); and
the layer's **pending change-event log**, whose recorded keys are re-projected from each event's
own image so commit-time delivery uses the arity the schema has at delivery.

Behavior changes worth knowing: the two shared pre-pass messages were generalized (they now
serve both `set collate` and `alter primary key`); secondary indexes now survive the statement
(the deleted rebuild silently dropped them all); `rollback` still does not undo the DDL (the
settled non-transactional tier, owned by
`backlog/bug-rolled-back-rows-violate-surviving-ddl`).

# Review findings

Reviewed the implement diff (`a2075b91`) against the code before reading the handoff, then
re-derived the replay algebra by hand.

## Correctness — no defects found

Traced the prepare/install replay against the cases most likely to break it, and each is
correct: net deletion of a key that never existed below (dropped, no image to re-key); an upsert
whose shadowed parent image lands at a different new key (extra deletion emitted, and
`installNetOwnWrites` applies all deletions before all upserts, so a deletion whose new key
another write's row now occupies cannot eat it); a savepoint stack where each layer moves the
same row again (each layer's parent image is its parent's *effective* row, so the chain telescopes);
delete-then-reinsert at one old key. The deletion replay's old-key identity check can only be
tripped by a colliding pair the pre-pass already refuses, matching the `rekeyPrimaryKey`
precondition it inherits. The manager/layer schema object identity that `commitTransaction`'s
snapshot-wrap check depends on holds (the same frozen `newSchema` object reaches every layer).

Also checked and found sound: `undo` capture ordering matches `applyAlterColumnToBase` (primary
tree recorded before the strict rebuild that replaces it); `buildRekeyedPrimaryKeySchema` leaves
no derived schema field stale (`uniqueConstraints` excludes the PK by definition, and
`tableConstraints` is not read by the DDL generator).

## Minor — fixed in this pass

- **DRY, `transaction.ts`**: the "collapse `ownWrites` to one entry per key, paired with the
  layer's effective row" loop existed in four near-identical copies (`rekeyPrimaryKey`,
  `convertColumn`, `prepareReshapedColumns`, and the new `prepareRekeyedPrimaryKeyColumns`).
  Extracted as the private generator `netOwnWriteEffects(tree, encode)` — the shared *head* to
  `installNetOwnWrites`'s shared tail. The implementer flagged this duplication as a possible
  follow-up; it is small and fully test-covered, so it is done rather than deferred.
- **Stale docs on `installNetOwnWrites`**: it said "the three whole-layer rebuilds" and "only
  `rekeyPrimaryKey` passes `deletionTargets`" — the new install is a fourth caller and a second
  `deletionTargets` user. Corrected, including *why* the new path can produce a
  deletion/upsert collision (a shadowed parent image, not two keys collapsing).
- **`declarative-equivalence.spec.ts`**: a REGRESSION test's comment block described the deleted
  `rebuildMemoryTable` connection-cleanup fix as the thing it guards, and two labels called the
  path "the rebuild". Rewritten to say the stale-connection shape is now structurally
  unreachable and what the case still guards end-to-end.
- **`packages/quereus-isolation/README.md`**: still told readers "the bundled
  `MemoryTableModule` rejects `ALTER PRIMARY KEY` outright, so this only arises under a
  store-backed underlying" — the `docs/` counterpart was updated, this one was missed. Fixed.
- **`memory/table.ts` comment**: claimed the isolation layer pre-flights *a re-keying change*,
  which reads as if `alterPrimaryKey` has a dry-run caller. It does not (the isolation layer
  never forwards `alter primary key` to an overlay); only `alterColumn` does. Comment now says
  so, and says why the capability is still offered.
- **Empty-key error text**: `alter primary key ()` on a table with two rows rendered
  `… collides under the new key definition (key: )` — an arity-0 key has no components to name.
  Now renders `(the empty key admits one row)`.

## Major — none

No finding warranted a new ticket. The two adjacent defects this work surfaced were already
filed by the implement stage and were checked for accuracy here:
`fix/bug-alter-primary-key-generated-ddl-keeps-old-key` (verified: the single-column inline PK
clause reads the stale per-column flag while the composite clause reads the definition, so a
single→composite move emits *both*, exactly as the ticket states) and
`fix/bug-alter-primary-key-shadow-rebuild-destroys-rows` (its background paragraph still
described the now-deleted memory fast path as existing — that one paragraph was corrected in
place, since this ticket is what invalidated it).

## Test coverage — 5 tests added (19 → 24 in the dedicated matrix)

The implementer's matrix covered the happy paths and the key-moving cases well. Added the
missing edges, all closing gaps the handoff itself named or that guard a load-bearing claim:

- **Retryable `BUSY` arm** for `alter primary key` (the pre-pass's second question was pinned
  only through `set collate`): a committed row this transaction deleted still collides in the
  base, so the change is refused as unrepresentable, the transaction survives, and a rollback
  restores both rows.
- **`rollback to savepoint` after the re-key** — the snapshot is a layer of its own; if the
  install skipped it, its rows would still be old-keyed and the commit would silently drop
  them (the failure mode `installReshapeOnOpenLayers` documents for the reshape pair).
- **Sibling connection commits before the re-key, then we commit** — the handoff's largest
  named gap (`commitTransaction` case B). Reachable with the existing manager-level harness
  (`manager.connect()` / `performMutation`) rather than a two-`Database` setup; the re-keyed
  own-write log replays onto the moved head and every row lands.
- **`alter primary key ()` with a pending second row** — the other named gap; the singleton key
  makes any pair collide and the pre-pass rejects, transaction intact.
- **Collation carried into the new key** — a `NOCASE` column re-keyed to must reject the
  `'A'`/`'a'` pair, and after the re-key the tree must refuse a case-variant duplicate.
  Guards the `collation:` line in `buildRekeyedPrimaryKeySchema`; without it the first
  assertion fails.

## Tripwires (parked, not filed)

- `MemoryTableManager.alterPrimaryKey` does the full O(rows × layers) rebuild even when the new
  definition equals the current one, where `alterColumn` early-returns. Fine today — the only
  producer, the declarative differ, emits the statement solely on a genuine change. `NOTE:` at
  the site says what to add if that ever stops holding.
- The pre-pass's per-layer collision walk and its row-holding probe already carry `NOTE:`
  comments about their cost from the `set collate` work; the new caller reuses them unchanged,
  so nothing was added.

## Docs

Read every file the diff touched plus the ones it should have (`docs/memory-table.md`,
`sql-ddl.md`, `module-authoring.md`, `design-isolation-layer.md`, both package READMEs,
`docs/module-events.md`) and swept for stale "memory rejects / memory rebuilds" claims. All
accurate after the one README fix above. `docs/module-events.md`'s "the module's `alterTable`
(or the rebuild fallback)" is still correct — the fallback survives for third-party modules.

# Validation

- `yarn workspace @quereus/quereus run test` — **7904 passing, 13 pending (pre-existing), 0
  failing**.
- `packages/quereus-isolation` — **349 passing**.
- Root `yarn test` (all workspaces) — 0 failing.
- `yarn lint`, `yarn build`, `yarn typecheck` — clean.
- Not run: `yarn test:store` (memory-only change; the store's native arm is untouched and the
  one message-pinning sqllogic is in `MEMORY_ONLY_FILES`).
