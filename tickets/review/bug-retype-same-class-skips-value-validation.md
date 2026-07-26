---
description: Changing a column's declared type to another type stored the same way (for example plain text to a date) now validates every value against the new type and rewrites each to the new type's canonical spelling, so a date column can no longer hold the word "hello" and a date written as "2024-06-05T00:00:00Z" becomes findable as "2024-06-05".
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — unified setDataType arm gated on logical-type identity (~2152); the three valueConvert-first chains (~2320, ~2360, ~2400)
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # convertColumn doc — now also subsumes adoptSchema for comparator-moving same-class retypes
  - packages/quereus-store/src/common/store-module.ts        # alterColumnSetDataType — identity gate + NOTE on ignoring wrapper rows (~2394)
  - packages/quereus-isolation/src/isolation-module.ts       # deriveSetDataTypeConvert — identity gate + doc (~1795)
  - packages/quereus/test/logic/41.2-alter-column.sqllogic   # new §10–15 (cross-module, memory + store legs)
  - packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row-memory.sqllogic  # memory-only deleted-row arm
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES — added 41.2.1, removed stale 41.7.3.1 entry
  - packages/quereus/test/alter-table-conformance.spec.ts    # 3 new same-storage-class arms (narrowing MISMATCH, normalize honored, UNIQUE-collision CONSTRAINT)
  - packages/quereus-store/test/alter-table-conformance.spec.ts     # same 3 arms, store leg
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts # same 3 arms + 4 overlay-transaction tests
  - docs/sql-ddl.md                                          # SET DATA TYPE bullet rewritten; UNIQUE re-validation bullet updated
difficulty: hard
---

# Same-storage-class `SET DATA TYPE` now validates and normalizes — review handoff

## What was built

All three legs now gate the `SET DATA TYPE` value rewrite on **logical-type identity**
(`inferType(newName) !== oldColumn.logicalType`) instead of the physical storage class:

- **Memory** (`MemoryTableManager.alterColumn`): the two setDataType arms (same-class /
  class-changing) are unified into one. Any non-alias retype rejects a PK column, computes
  `comparatorChanged`, runs the throw-only convert pass over the transaction's effective
  rows, and sets `valueConvert`. An alias retype (`text → varchar(50)` — `inferType`
  returns the same shared type object) stays schema-only. The three
  `structuresRekeyed`/`valueConvert` if-else chains were reordered to test `valueConvert`
  **first**, because a same-class retype is the first change to set both flags:
  - pre-pass: one `validateRekeyedUniqueStructures` call judging **converted** rows under
    the **new** comparators (catches the normalization-collides-under-UNIQUE case);
  - base rebuild: `convertBaseRows` + `rebuildPrimaryTreeFromRows` (which itself calls
    `rebuildAllSecondaryIndexes`, so it subsumes the comparator-only re-sort);
  - open layers: `TransactionLayer.convertColumn` (installs the new schema and rebuilds
    every secondary index from it, so it subsumes `adoptSchema`).
  `pkColumnRekeyed` is unaffected: it is set only by SET COLLATE, which never sets
  `valueConvert`, so the SET COLLATE PK path still takes the `structuresRekeyed` arm.
- **Store** (`StoreModule.alterColumnSetDataType`): one-line gate change. The caller
  `alterColumnChange` already composes `rewritesValues` and `keyTransformChanged`
  additively, so no restructuring. The NOTE at ~2263 (valueConvert/pkRekeyNeeded never
  coincide) re-verified — still true for the SQL path (the engine refuses PK retype).
- **Isolation** (`deriveSetDataTypeConvert`): same gate change; staged overlay rows are
  validated (`validateOverlayMigration`) and normalized (`translateOverlayRow`) for
  same-class retypes exactly as for class-changing ones.

Docs: `docs/sql-ddl.md` SET DATA TYPE bullet rewritten (validate + normalize between any
two different logical types; alias retypes schema-only; `VARCHAR(n)` lengths explicitly
not enforced), and the UNIQUE re-validation bullet now covers the combined
values-collapse + comparator-move case.

## Use cases to validate against

```sql
-- reject: type and value unchanged, statement fails MISMATCH
create table j (id integer primary key, v text); insert into j values (1, 'hello');
alter table j alter column v set data type date;            -- MISMATCH

-- normalize: canonical spelling stored, equality lookup works
insert into t values (1, '2024-06-05T00:00:00Z');
alter table t alter column v set data type date;            -- v now '2024-06-05'
select id from t where v = '2024-06-05';                    -- finds the row

-- UNIQUE collision under normalization rejects before mutating
-- ('2024-06-05' + '2024-06-05T00:00:00Z' are one DATE)      -- CONSTRAINT

-- timespan: '1 hour' → 'PT1H'; lookup by 'PT60M' finds it (semantic compare)
-- alias: text → varchar(2) is a no-op, oversized values survive
-- transactions: a pending illegal value rejects; pending rows are normalized in-tx
--   and past commit; a value only in a tx-deleted row does not block (memory leg)
```

Tests: sqllogic 41.2 §10–15 (runs on memory AND store legs), 41.2.1 (memory-only),
3 conformance arms × 3 legs, 4 isolation overlay-transaction tests.

## Honest gaps and deviations from the ticket

1. **`date → time` does NOT reject** — the ticket's phase-3 expected it to. Reality:
   `TIME.parse('2024-06-05')` accepts a bare date (Temporal parses it as a PlainDateTime
   with implicit `00:00:00`), and an INSERT does the same, so the retype normalizes
   `'2024-06-05'` → `'00:00:00'`. The test pins that conversion; the temporal-narrowing
   *reject* case is covered by `time → date` instead (a bare time holds no date). Both in
   41.2 §13.
2. **Store leg ignores wrapper-supplied rows in its convert pre-pass** (pre-existing;
   NOTE now at the site in `alterColumnSetDataType`). Concrete consequence surfaced by
   this work: under the isolation wrapper, a committed unconvertible value in a row the
   transaction has *deleted* still blocks the retype on the store leg (the overlay
   tombstone is invisible to the store's own scan), where the memory leg accepts. Hence
   the deleted-row sqllogic arm is memory-only (41.2.1 + MEMORY_ONLY_FILES entry). The
   open backlog decision `bug-retype-of-deleted-row-leaves-wrong-typed-value` already
   covers whether deleted rows should block at all (its rollback corner applies to the
   same-class path identically now); resolving it either way collapses this divergence.
3. **`comparatorChanged` is now computed for class-changing retypes too** (previously
   same-class only). Only visible effect: fresh `IndexSchema` objects are built on the
   class-changing path (`structuresRekeyed` gates that rebuild). Harmless — the
   `valueConvert`-first chains mean `adoptSchema` is never reached on that path — but it
   is a behavior-surface widening a reviewer should eyeball.
4. **REAL → NUMERIC / NULL → ANY now run the scan** where they previously skipped it.
   `NUMERIC.parse`/`ANY.parse` are identity on already-legal stored values, so no
   behavior change per the ticket's class table; not separately tested.
5. **Opportunistic cleanup**: removed the stale `41.7.3.1-…-memory.sqllogic` store-mode
   exclusion — its fixing ticket (`bug-isolation-retype-leaves-staged-rows-unconverted`)
   landed earlier but never removed the entry. Verified the file passes in store mode
   before removing.
6. **Direct-module-call PK retype on the store leg** remains unguarded at module level
   (memory has defense-in-depth; store relies on the engine's refusal —
   `runtime/emit/alter-table.ts`). Pre-existing, and there is already a `fix/` ticket
   `bug-store-pk-column-set-data-type-corrupts-keys` tracking it; the widened store gate
   makes a same-class PK retype reach `valueConvert` too if that guard is bypassed.

## Validation run

- `yarn build` — clean; `yarn lint` (quereus eslint + test-file tsc) — clean;
  `yarn typecheck` (all workspaces) — clean.
- `yarn test` (all workspaces): quereus 7267 passing, isolation 275, store 1025, rest green.
- `yarn test:store` (logic vs LevelDB): 7259 passing, 0 failing (one more than before —
  41.7.3.1 now included).
- Pre-existing same-class retype tests confirmed passing: TIMESPAN conformance arms
  (memory spec), `timespan-semantic-key-identity.spec.ts` § ALTER interactions (store).
