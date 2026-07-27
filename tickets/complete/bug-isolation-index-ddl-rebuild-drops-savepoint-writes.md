---
description: Fixed a data-loss bug where creating or dropping an index inside a transaction silently threw away rows the transaction had already inserted, once it rolled back to an earlier savepoint.
files:
  - packages/quereus-isolation/src/isolation-module.ts                        # createIndex / dropIndex / applyIndexChangeToOverlays / applyInPlaceOverlayChange / createOverlayIndexSchema / assertIndexPresent
  - packages/quereus-isolation/src/isolated-table.ts                          # index-DDL delegation doc
  - packages/quereus-isolation/test/isolation-layer.spec.ts                   # savepoint-chain suite (~1824) + new "index DDL adopted into an already-open overlay" suite (~1916)
  - packages/quereus-isolation/package.json                                   # typecheck now covers test files
  - packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic       # § 4, cross-backend savepoint sequence
  - packages/quereus/test/logic.spec.ts                                       # note recording the folded-away memory-only file
difficulty: medium
---

# Index DDL inside a transaction no longer discards pre-savepoint writes

## What was wrong

Each connection's uncommitted rows live in a private staging table (an "overlay"). `create index`
and `drop index` used to throw that staging table away and copy the staged rows into a fresh one.
The copy's first write lazily registered the new staging table's connection with the `Database`,
and registration replays `begin()` plus the whole active savepoint stack **before** the copy runs.
So every copied row landed *above* the replayed savepoint, and the next `rollback to savepoint`
discarded rows staged long before that savepoint was taken. Silent data loss.

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');   -- staged BEFORE the savepoint
savepoint s;
drop index ix;
rollback to savepoint s;
select id, v from t;             -- was []; now [{id:1, v:'a'}]
```

Not store-specific — reproduced equally on a plain in-memory table wrapped by the isolation layer.

## What changed

Both index paths now adopt the change **in place** instead of rebuilding:

- `IsolationModule.createIndex` / `dropIndex` → `applyIndexChangeToOverlays`, which walks each
  non-poisoned overlay for the table and calls `createOverlayIndex` / `dropOverlayIndex` on it.
- `createOverlayIndexSchema(idx, baseName, overlayName)` was factored out of `createOverlaySchema`
  so a single index handed to an already-open overlay is structurally identical to one copied in
  at overlay-creation time (predicate narrowed to live rows, self-qualifier rescoped onto the
  overlay's table name).
- `applyInPlaceOverlayChange` routes a `CONSTRAINT` thrown by an in-place adopt: the issuer's own
  overlay → `INTERNAL` (validation and migration have drifted), a foreign overlay → poison it and
  leave it untouched so its owner errors and rolls back. Shared with the ALTER TABLE forwards, so
  the two cannot drift on error routing.
- `rebuildOverlaysForIndexChange`, `rebuildOverlayForIndexChange`, `adoptRebuiltOverlay`,
  `insertIntoRebuiltOverlay` and `buildRebuildPoisonMessage` are all gone, with no callers left
  (the ALTER paths were converted to in-place forwards by the two sibling `isolation-alter-*`
  tickets). `assertIndexPresent` is kept — the overlay's index schema is derived from the
  underlying's refreshed schema, so an underlying that does not refresh must still be caught
  loudly.

The rebuild originally existed because an open write `TransactionLayer` froze its schema at
creation. `bug-drop-index-in-transaction-still-enforced` gave `TransactionLayer.adoptSchema` both
an additive and a removal branch, so an open layer can adopt an index change with its savepoint
snapshots intact.

## Provenance

Most of the implementation landed in commit `8ead1843`, which the runner committed when an earlier
attempt at this ticket timed out mid-run. Two sibling tickets then refactored on top of it:
`isolation-alter-forward-column-shape` (`c604abce`) and
`isolation-alter-forward-constraints-and-retype` (`27a1e650`, `ccdbd94c`) generalized the
error-routing seam into `applyInPlaceOverlayChange` and converted the ALTER paths the same way.
The implement-stage commit `272af3b9` was comment-only — it verified the tree against the TODO
list and ran the validation the timed-out run never reached.

## Validation

All run from the repo root, all green, both before and after the review's own edits:

- `yarn build` — clean.
- `yarn lint` — clean (only `packages/quereus` has a real lint; every other package is a
  deliberate no-op).
- `yarn typecheck` — clean, and now type-checks `packages/quereus-isolation/test` too (see
  finding 8).
- `yarn test` — 7404 + 318 + 1081 + 594 + others passing, **0 failing**, 13 pending.
- `yarn test:store` — 7398 passing, **0 failing**, 19 pending.

### Use cases the tests pin

`packages/quereus-isolation/test/isolation-layer.spec.ts`, against `MemoryTableModule` as the
underlying:

Suite *"index DDL inside a transaction preserves the overlay savepoint chain"* (~line 1824):

| test | pins |
|---|---|
| `DROP INDEX after a savepoint keeps rows staged before the savepoint` | the drop direction |
| `CREATE UNIQUE INDEX after a savepoint keeps rows staged before the savepoint` | the create direction |
| `rollback to savepoint keeps pre-savepoint rows and discards post-savepoint ones across a DROP INDEX` | **both** directions in one sequence — the important one |
| `a staged tombstone survives DROP INDEX under a savepoint` | a staged DELETE still lands at commit |

Suite *"index DDL adopted into an already-open overlay"* (~line 1916, **added by this review**):

| test | pins |
|---|---|
| `a SELF-QUALIFIED partial unique index created mid-transaction is rescoped onto the overlay` | the predicate's self-qualifier is moved from the base table's name onto the overlay's generated name; without it the memory module rejects the index at build time |
| `a SELF-QUALIFIED partial unique index … is enforced over the overlay's own staged rows` | the adopted index catches a duplicate that exists only in the transaction's staged rows |
| `DROP then CREATE an index of the same name mid-transaction lands the NEW definition` | the DROP really removed the overlay's copy, so the name-keyed presence guard in `createOverlayIndex` does not mask a stale index |

Cross-connection behavior (suite *"row-validating DDL cross-connection poison semantics"*):
`poisons a foreign overlay whose staged rows violate a newly created UNIQUE index` drives two
connections sharing one `IsolationModule`, with connection B holding staged rows that collide
under the UNIQUE index connection A creates.

`packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic` § 4 asserts the same
sequence against both backends, plus that `rollback to savepoint` does *not* undo the DROP itself
(DDL is non-transactional on both, so a would-be duplicate insert after the rollback is still
accepted). The former memory-only file `10.1.3.1-ddl-drop-savepoint-memory.sqllogic` was folded
into it and deleted.

## Review findings

### Checked

- **The whole diff, read before the handoff summary.** `8ead1843` (the substance) and `272af3b9`
  (comment-only), plus the three sibling commits that refactored on top.
- **The fix's mechanism against the real memory-module code**, not just the handoff's account of
  it. `MemoryTableManager.createIndex` / `dropIndex`
  (`packages/quereus/src/vtab/memory/layer/manager.ts:2695` and `:2785`) do call
  `adoptSchemaOnOpenLayers`, and the drop arm strips the UNIQUE constraint derived from the index
  — so the in-place adopt genuinely reaches an open transaction layer, and nothing survives to
  keep enforcing a dropped index.
- **That the foreign-overlay poison path is reachable, not theoretical.**
  `MemoryTableManager.createIndex` pre-validates a UNIQUE index over `effectiveDdlRows()`, which
  for an overlay resolves to that overlay's own staged view — so a foreign overlay's staged
  duplicate really does raise `CONSTRAINT`, before any mutation, leaving the overlay intact for
  its owner to roll back.
- **Dead code.** Every rebuild helper named in the handoff is gone, and nothing references it —
  no dangling `{@link}`s, no unreachable branches.
- **Docs.** `docs/design-isolation-layer.md` (the overlay-migration section, the poison section,
  and the overlay-schema section) and `packages/quereus-isolation/README.md` already describe the
  in-place adopt correctly; the sibling review commit `ccdbd94c` updated them. No stale text left
  in `docs/`.
- **Whether folding away the memory-only sqllogic file lost coverage.** It did not: § 4 of
  `10.1.3-ddl-drop-in-transaction.sqllogic` asserts a strict superset of the deleted file's
  sequence, and now asserts it on both backends instead of one.
- **Concurrency.** `connectionScopedKeys` snapshots the overlay keys into an array before the
  walk, so a concurrent discard during one of the walk's awaits would leave a `.get(key)!`
  undefined. Not filed: the module caps its advertised `concurrencyMode` at `reentrant-reads`
  precisely because the write path mutates shared overlay state non-atomically, so no second
  writer can interleave — and the same snapshot-then-walk shape predates this diff at three
  other sites in the file.
- **The store-mode warning the handoff flagged** (`[TransactionCoordinator] rollback-to savepoint
  depth 0 out of range … transaction was committed out from under it`, twice per `yarn test:store`
  run). Not filed. It does not come from this ticket's new § 4 — running
  `10.1.3-ddl-drop-in-transaction.sqllogic` alone under store mode emits it zero times — and it is
  a deliberate, documented degradation in `packages/quereus-store/src/common/transaction.ts:386`
  for a store DDL-commit that clears the savepoint stack while the engine still broadcasts the
  savepoint ("degrades to DDL-commit semantics").

### Found and fixed in this pass

1. **The handoff's first "known gap" was wrong.** Foreign-overlay poisoning on `create index` *is*
   directly tested, by exactly the two-connection scenario the handoff said was missing
   (`poisons a foreign overlay whose staged rows violate a newly created UNIQUE index`). Nothing
   added; the record is corrected above.
2. **A real coverage hole, now closed.** No test drove `createOverlayIndexSchema`'s predicate
   rescoping through the `create index`-into-an-already-open-overlay route — only through the
   overlay-creation route. Added the three-test suite listed above. Verified non-vacuous by
   mutation: disabling `rescopePredicateQualifier` fails **exactly** the new rescope test and
   nothing else, confirming the path had been entirely uncovered.
3. **`dropIndex` asymmetry** (flagged in the handoff, believed harmless — it is not, for a
   third-party underlying). It now mirrors `createIndex` and returns before the overlay walk when
   neither `dropIndex` hook exists. An underlying that declares indexes at CREATE TABLE time but
   cannot drop one would otherwise have had the index removed from the overlays alone, leaving
   each overlay enforcing *less* than the base it flushes into — a divergence surfacing only as a
   commit-time rejection. Unreachable with both bundled underlyings, which is why it never showed
   up as a failure.
4. **A double non-null assertion.** `createIndex` re-found the just-created index with
   `updatedSchema.indexes!.find(...)!` right after `assertIndexPresent` had already proved it
   present. `assertIndexPresent` now returns `{ schema, index }`, and a new `findSchemaIndex`
   helper backs the existing `schemaHasIndex` predicate.
5. **Stale comments describing the removed rebuild machinery, in the present tense**, in eight
   places: the `IsolatedTable.createIndex` delegation doc, the `assertIndexPresent` doc, and six
   spots in the spec — including two test *names* (`write + create index (overlay rebuild) + …`),
   a `describe` block (`a rebuild-poisoned overlay is freed on rollback`), and assertion messages
   claiming a half-built overlay was freed. All rewritten to describe the in-place adopt.
6. **A test that had quietly become vacuous.** `DROP INDEX on the table neither migrates nor
   un-poisons a poisoned overlay` could no longer fail for its stated reason: with in-place adopt,
   no path clears poison, so both its assertions held trivially. Added an assertion that the
   skipped overlay *still carries the dropped index*, which is what actually proves the skip
   happened.
7. **A misleading note about backend agreement.** `logic.spec.ts` read as though the isolation
   layer is why the *memory* leg agrees with the store leg. Memory mode runs the plain `memory`
   module with no isolation layer at all; it is the store leg (which does run behind isolation)
   that changed. Reworded.
8. **The isolation package's test files were never type-checked.**
   `packages/quereus-isolation/tsconfig.test.json` existed but no script referenced it, and mocha
   runs the specs transpile-only — so type errors in the 5900-line `isolation-layer.spec.ts`, the
   primary test surface for this whole subsystem, were invisible to `yarn check`. Wired into the
   package's `typecheck` script (the placement AGENTS.md prescribes, and the pattern
   `plugin-loader` already uses). It passes clean as-is.

### Filed as new tickets

None. No correctness defect survived scrutiny: the mechanism holds against the memory module's
actual code, the removed machinery left nothing dangling, and folding away the memory-only
sqllogic file cost no coverage. The three genuine gaps the handoff flagged were either already
covered (finding 1), closable inline with tests (finding 2), or a one-line guard (finding 3).

### Tripwires parked in code

- `isolation-module.ts`, `applyInPlaceOverlayChange` — **new.** A rethrow of a non-`CONSTRAINT`
  error abandons the rest of the caller's overlay walk *after* the DDL has already landed on the
  shared underlying, so overlays not yet visited neither adopt the change nor get poisoned. Safe
  today (every non-`CONSTRAINT` source is an `INTERNAL` layer-invariant violation no overlay could
  have satisfied); if the overlay module ever reports a per-overlay *data* condition under some
  other status code, that code has to be routed here too.
- `isolation-module.ts`, `replaceOverlayForPrimaryKeyChange` — pre-existing, from the implement
  stage. This is now the only path that swaps an overlay table rather than adopting in place, so a
  registered `IsolatedConnection` keeps the old overlay's connection and forwards savepoint calls
  to a released table. Benign today (the swapped overlay is clean, and the fresh one registers its
  own connection), but it is the same shape as the bug this ticket fixed.
- `isolation-module.ts`, `releaseOverlayTable` doc comment — pre-existing; names the
  `alterPrimaryKey` swap as the one remaining per-DDL overlay allocation, since rebuilds no longer
  exist. The matching comment in the spec's leak suite was drifted and is now corrected too.
