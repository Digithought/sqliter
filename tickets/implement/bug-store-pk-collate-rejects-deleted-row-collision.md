description: On the persistent storage backend, changing the sorting rule of a primary-key column can silently destroy a row, or wreck a unique index, when the change is made inside an open transaction. Make it behave the way the in-memory backend already does — refuse cleanly, or accept cleanly, before touching anything.
files:
  - packages/quereus-store/src/common/store-module-alter-column.ts   # alterColumnChange; the `pkRekeyNeeded` block (~193-212) and the existing UNIQUE probe (~168-181)
  - packages/quereus-store/src/common/store-table.ts                 # rekeyRows (~115-207) — two-pass re-key, committed-only
  - packages/quereus-store/src/common/store-module-index.ts          # rebuildSecondaryIndexes + its `skipDuplicateCheck` doc (~289-347)
  - packages/quereus-store/src/common/store-module-index-build.ts    # rowsFromEntries, validateUniqueOverExistingRows, assertNoDuplicateRows
  - packages/quereus-store/src/common/pk-key-resolution.ts           # resolvePkKeyCollations / resolvePkKeyTransforms
  - packages/quereus-store/src/common/key-builder.ts                 # buildDataKey, buildFullScanBounds
  - packages/quereus/src/vtab/memory/layer/manager.ts                # validateRekeyedPrimaryKey (~3489-3585) — THE ORACLE, mirror it
  - docs/memory-table.md                                             # ~492-525 describes the two-question contract; also holds a stale path to this ticket
  - docs/store.md                                                    # ~514-520 (SET COLLATE re-key), ~648 (which checks precede the DDL commit)
  - packages/quereus/test/logic.spec.ts                              # MEMORY_ONLY_FILES entry for 41.7.5
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic
  - packages/quereus-store/test/isolated-store.spec.ts               # harness for a store-behind-isolation spec
difficulty: hard
----

# `ALTER COLUMN … SET COLLATE` on a primary-key column, inside a transaction, on the store

## Background in one paragraph

Quereus has two table backends. The **memory** backend keeps a transaction's uncommitted
writes in its own layered structures. The **store** backend (LevelDB and friends) runs behind
an **isolation wrapper** that keeps each connection's uncommitted writes in a private *overlay*;
the store itself holds only committed rows. When a DDL statement has to judge row content, the
wrapper hands the store the merged stream — committed rows with the connection's own inserts
added and its own deletes removed. That merged stream is the `EffectiveRowSource` parameter on
`alterTable` / `createIndex`.

`alter column … set collate` on a **primary-key** column is the most invasive shape: the
column's sort rule is part of the physical key, so every stored row has to be re-keyed and every
secondary index rebuilt (index keys embed the primary key).

## The memory backend already defines the correct behaviour

`MemoryTableManager.validateRekeyedPrimaryKey` asks **two** questions before mutating anything,
over two different row sets (documented at `docs/memory-table.md` §"A collation change on a
PRIMARY KEY column obeys a stricter rule"):

1. **Is the change legal?** — over the rows the transaction can *see* (the wrapper's
   `EffectiveRowSource`, else its own effective view). Two rows landing on one new key here is a
   duplicate a `select` in this transaction would return, so the statement is invalid →
   `CONSTRAINT`, naming the key.
2. **Can the structures carry it?** — over the rows that physically exist and that a `rollback`
   must be able to restore. Two rows landing on one new key here may be invisible to the
   transaction right now (it deleted one), but the re-keyed structure cannot hold both →
   `BUSY`, "…must survive a rollback. Commit/rollback and retry."

Both run before any mutation, so either refusal leaves the table, the catalog and the
transaction untouched.

Measured memory behaviour on the three shapes below (this is the target):

| shape | memory result |
|---|---|
| committed collider **deleted** in this txn | `BUSY` — "rows this transaction has removed still collide… Commit/rollback and retry." |
| **staged** row collides with a committed row | `CONSTRAINT` — "primary key collides under the new key definition (key: 'a')" |
| **unique index** collider deleted in this txn (primary key itself does not collide) | accepted, index intact |

## What the store does today

Reproduced end-to-end against `StoreModule` behind `createIsolatedStoreModule`
(in-memory KV provider; same wiring as `packages/quereus-store/test/isolated-store.spec.ts`).

### Defect 1 — silent row loss, no error at all (most severe)

```sql
create table t (k text collate binary primary key, v text) using store;
insert into t values ('A', 'x');

begin;
insert into t values ('a', 'y');                     -- staged in the overlay
alter table t alter column k set collate nocase;     -- ACCEPTED (memory rejects: CONSTRAINT)
commit;

select k, v from t;   -- [{'a','y'}]   ← the committed 'A' row is GONE
```

Nobody checks staged-versus-committed. The wrapper's own pre-flight
(`validateOverlayMigration`'s `pkRekey` arm, `packages/quereus-isolation/src/alter-migration.ts`
~538) only looks for two *staged* rows on one key; the store's `rekeyRows` only looks at its own
*committed* rows. The pair spans both sets, so it falls between them. The store re-keys `'A'` to
the NOCASE key that the staged `'a'` also occupies, the overlay row shadows it, and the commit
flush overwrites it. There is an existing `NOTE:` at `store-module-alter-column.ts` ~200 saying
exactly this.

### Defect 2 — false rejection that also corrupts a unique index

```sql
create table t (k text collate binary, j integer, v text, primary key (k, j)) using store;
create unique index t_k on t (k);
insert into t values ('A', 1, 'x'), ('a', 2, 'y');

begin;
delete from t where k = 'a';                         -- the collider is gone from this txn's view
alter table t alter column k set collate nocase;     -- REJECTED: "UNIQUE constraint failed: t (k)"
```

The primary key here is `(k, j)`, so the re-key itself does not collide — the rejection comes
from the *secondary-index rebuild* that follows it, which runs with its in-pass uniqueness check
**enabled** over the store's committed rows. It cannot see the overlay's deletion.

Worse, that rebuild runs after `rekeyRows` and after the rebuild has already cleared the index
store. Measured aftermath (after `rollback`):

- `select k, j from t where k = 'A'` → `[]` — the index-backed seek finds nothing,
- `select k, j from t order by j` → both rows — the full scan still sees them.

So the table silently returns **wrong query results** depending on the access path, and the
persisted DDL still declares the old collation while the data store now holds new key bytes.

**Verified fix**: passing `skipDuplicateCheck = true` to the post-re-key
`rebuildSecondaryIndexes` call makes this accept, *and* a genuine collision (same table, collider
NOT deleted) still rejects — because the pre-mutation probe already covers it. A standalone
`create unique index` synthesises a `derivedFromIndex` entry in `uniqueConstraints`, so the
existing `validateUniqueOverExistingRows` walk at `store-module-alter-column.ts` ~168 judges it
over the effective rows, before any mutation. That negative control was run and it rejected
cleanly with the index left intact.

This mirrors what the value-rewriting arm already does — see the `skipDuplicateCheck` rationale
in `rebuildSecondaryIndexes`' doc comment, which spells out this exact "committed rows may retain
a row the wrapper's transaction has deleted" reasoning.

### Defect 3 — right answer, wrong status, wrong time

```sql
create table t (k text collate binary primary key, v text) using store;
insert into t values ('A', 'x'), ('a', 'y');

begin;
delete from t where k = 'a';
alter table t alter column k set collate nocase;
-- store:  CONSTRAINT "UNIQUE constraint failed: duplicate primary key on rekey of 'main.t'"
-- memory: BUSY      "…rows this transaction has removed still collide… Commit/rollback and retry."
```

**Refusing is correct here** — the ticket's original "must not block the change" reading is not
physically achievable. The store must keep both committed rows for a possible `rollback`, and a
re-keyed store cannot hold both under one key. `docs/memory-table.md` already states that the
store refuses this shape for the same reason. What is wrong is the *shape* of the refusal:

- it is `CONSTRAINT` (invalid data) rather than `BUSY` (retryable pending state), and its
  message tells the user nothing about what to do;
- it arrives **after** `StoreModuleBase.ddlCommitPendingOps()`, which commits every buffered
  write this store module holds — across all its tables. Under the isolation wrapper that flush
  is a no-op (the writes are in the overlay), so the transaction survives; on the bare
  `StoreModule` path it commits the module transaction and the refusal then lands with the
  transaction already gone.

## What to build

Give `StoreModuleAlterColumn`'s `pkRekeyNeeded` block the same two questions the memory backend
asks, **both before `ddlCommitPendingOps()`**, then make the index rebuild non-enforcing.

```
pkRekeyNeeded:
    ── legality probe ───────────────────────────────────────────────
    rows to judge: rows?.() ?? rowsFromEntries(table.iterateEffectiveEntries(fullScan))
    key each row under the NEW encoding; a repeat  → CONSTRAINT
    (fixes Defect 1; no flush needed, so the transaction survives a rejection)

    ── representability probe ───────────────────────────────────────
    rows to judge: the store's COMMITTED entries
    key each row under the NEW encoding; a repeat  → BUSY, memory's wording
    (fixes Defect 3; still before the flush, so the transaction survives)

    ── mutate ───────────────────────────────────────────────────────
    ddlCommitPendingOps()
    rekeyRows(...)                       // pass 1 is now a backstop, not the gate
    rebuildSecondaryIndexes(..., skipDuplicateCheck = true)   // fixes Defect 2
```

Notes that matter for correctness:

- **The two probes and `rekeyRows` must compute identical key bytes.** `rekeyRows` builds its key
  with `buildDataKey` + `resolvePkKeyCollations` + `resolvePkKeyTransforms` over the post-ALTER
  columns. Do **not** re-derive it through `dedupeRowSignature`/`KeyNormalizerResolver` (the path
  `validateUniqueOverExistingRows` uses) — the two disagree in at least one live case: an `any`
  typed primary-key column pins BINARY regardless of its declared collation, which
  `packages/quereus-store/test/any-json-pk-binary-key.spec.ts` pins ("re-keys an `any` PK to the
  same BINARY bytes across `alter column … set collate`"). Extract the key computation out of
  `rekeyRows` into a small shared helper (something like `makeRekeyProbe(newPkDef, newColumns,
  encodeOptions)` returning `(row) => hex`) and drive all three from it.
- **Probe order is what makes the status codes right.** The representability probe fires only
  when the legality probe passed, i.e. only when the effective rows are a strict subset of the
  committed rows — which only happens under a wrapper that deleted something. Without a wrapper
  the effective stream is a superset of committed, so a committed collision always trips the
  legality probe first and correctly reports `CONSTRAINT`. No backend sniffing needed.
- **The legality probe over effective entries also removes the reason the old check needed the
  flush.** `rekeyRows`' doc comment justifies its post-flush position by "a pending insert can
  itself be the duplicate" — `iterateEffectiveEntries` already includes this module's buffered
  ops, so the new probe covers that without committing anything. Update that comment and
  `store-module-base.ts`'s `ddlCommitPendingOps` doc, which currently names the re-key's
  duplicate pass as the example of validation that must run after the flush.
- **The `pkRekeyNeeded` rebuild rebuilds *every* index, not only ones covering the altered
  column.** Making it non-enforcing is still safe: an index that does not cover the column has
  unchanged values and an unchanged collation, so it cannot newly collide, and the PK suffix
  change does not affect uniqueness of the index columns.

## Also in scope

- **`packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic`
  can probably be un-skipped.** Its `MEMORY_ONLY_FILES` note in `packages/quereus/test/logic.spec.ts`
  gives two reasons; the second one ("even with an explicit `collate binary` PK the store's
  re-key … falsely reject[s] the deleted row's collision") is **not true** — both sections were
  run against the store with `collate binary` on the primary key and both already match memory
  (§1 accepted and commits to `{'a','y'}`; §2 refused with the same "still collide under the new
  key definition" substring the file matches on, transaction still usable). The only genuine
  blocker is the first reason: the store defaults an undecorated text primary key to `NOCASE`
  (see the `10.2.2-default-collation-memory.sqllogic` note), so the case-variant re-insert
  collides before any ALTER runs. Declare `collate binary` on the PK in the file, drop the entry,
  and confirm under `yarn test:store`. Fix the stale claim in the skip-list note either way.
- **Stale ticket path in `docs/memory-table.md` ~519** — points at
  `tickets/backlog/bug-store-pk-collate-rejects-deleted-row-collision.md`; the ticket has moved.
  Reference it by slug, or point at the store doc instead.
- **`docs/store.md`** — the §"`ALTER COLUMN … SET COLLATE` on a PK column" bullet (~514) and the
  "validation that can reject the statement runs before the commit" paragraph (~648) both still
  describe the re-key's duplicate pass as necessarily post-commit. Update both to the two-probe
  shape and state the store/memory parity explicitly.

## Out of scope

Accepting Defect 3's shape (rather than refusing it cleanly) needs transaction-scoped DDL on a
native backend — already tracked as `feat-transactional-ddl-native-backends`.

## TODO

Phase 1 — probes

- Extract the new-key computation from `StoreTable.rekeyRows` into a reusable probe helper over
  `AsyncIterable<Row>`, keyed identically (`buildDataKey` + `resolvePkKeyCollations` +
  `resolvePkKeyTransforms` over the post-ALTER columns, `encodeOptions` from the table).
- In `alterColumnChange`'s `pkRekeyNeeded` block, before `ddlCommitPendingOps()`: run the
  legality probe over `rows?.() ?? rowsFromEntries(table.iterateEffectiveEntries(buildFullScanBounds()))`
  and throw `CONSTRAINT` on a repeat, naming the colliding key the way the memory module does.
- Then run the representability probe over the store's committed entries and throw `BUSY` with
  the memory module's wording on a repeat.
- Leave `rekeyRows`' own pass 1 in place as a backstop; update its doc comment (and
  `ddlCommitPendingOps`') to say the gate now lives before the flush.

Phase 2 — non-enforcing rebuild

- Pass `skipDuplicateCheck = true` to the `rebuildSecondaryIndexes` call inside `pkRekeyNeeded`,
  and extend that method's `skipDuplicateCheck` doc paragraph to cover this second caller.
- Confirm the pre-mutation `validateUniqueOverExistingRows` walk covers every unique structure
  over the altered column on this path — explicit unique indexes (via their `derivedFromIndex`
  `uniqueConstraints` entry) and plain `UNIQUE` constraints backed by an implicit `_uc_*`.

Phase 3 — tests

- Add a store-behind-isolation spec (model it on `packages/quereus-store/test/isolated-store.spec.ts`,
  which already has the in-memory `KVStoreProvider` helper) pinning all three shapes: staged-vs-committed
  → `CONSTRAINT` with the transaction still usable; deleted-committed-collider → `BUSY` with the
  transaction still usable; unique-index collider deleted → accepted, and an index-backed seek
  after the ALTER returns the right rows.
- Add a negative control: the Defect 2 table with the collider **not** deleted must still be
  rejected, before any mutation, with the index still serving correct seeks afterwards.
- Try un-skipping `41.7.5-…` per "Also in scope"; if it passes on both legs, remove the
  `MEMORY_ONLY_FILES` entry.
- Consider promoting the three shapes into a cross-backend `.sqllogic` under
  `packages/quereus/test/logic/` so `yarn test` and `yarn test:store` both pin the parity.

Phase 4 — validate

- `yarn build`, `yarn lint`, `yarn typecheck`.
- `yarn test` and `yarn test:store` (stream with `tee`; `test:store` is the slow leg).
