---
description: Changing a column's declared type to another type stored the same way (for example plain text to a date) now validates every value against the new type and rewrites each to the new type's canonical spelling, so a date column can no longer hold the word "hello" and a date written as "2024-06-05T00:00:00Z" becomes findable as "2024-06-05".
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — unified setDataType arm gated on logical-type identity (~2156); the three valueConvert-first chains
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # convertColumn doc — now also subsumes adoptSchema for comparator-moving same-class retypes
  - packages/quereus-store/src/common/store-module.ts        # alterColumnSetDataType — identity gate + NOTE on ignoring wrapper rows
  - packages/quereus-isolation/src/isolation-module.ts       # deriveSetDataTypeConvert — identity gate + doc
  - packages/quereus/test/logic/41.2-alter-column.sqllogic   # §10–17 (cross-module, memory + store legs)
  - packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row-memory.sqllogic
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic  # now cross-module
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES
  - packages/quereus/test/alter-table-conformance.spec.ts    # + store, isolation legs
  - docs/sql-ddl.md, docs/memory-table.md, docs/store.md
difficulty: hard
---

# Same-storage-class `SET DATA TYPE` validates and normalizes — completed

## What shipped

All three legs gate the `SET DATA TYPE` value rewrite on **logical-type identity**
(`inferType(newTypeName) !== oldColumn.logicalType`) rather than on the physical storage
class. Consequences:

- A retype between aliases of one type (`text → varchar(50)`, `integer → bigint` —
  `inferType` returns the same shared type object) stays schema-only: no scan, no rewrite,
  no re-key.
- Every other retype validates each value against the new type (`MISMATCH` on the first
  value the type refuses) and rewrites the accepted ones to the new type's canonical form —
  the value an `INSERT` would have stored (`'2024-06-05T00:00:00Z'` → `'2024-06-05'`,
  `'1 hour'` → `'PT1H'`) — whether or not the storage class changes.
- The UNIQUE pre-pass judges the **converted** rows under the **new** comparators, so the
  combined case (values collapse *and* the comparator moves) rejects before anything mutates.
- Memory: the two setDataType arms are unified; the `structuresRekeyed` / `valueConvert`
  if-else chains test `valueConvert` first, because its full rebuild subsumes the
  comparator-only re-sort and `TransactionLayer.convertColumn` subsumes `adoptSchema`.
- Store: `alterColumnSetDataType` gate change only; the caller already composes
  `rewritesValues` / `keyTransformChanged` / `pkRekeyNeeded` additively.
- Isolation: `deriveSetDataTypeConvert` gate change only; staged overlay rows are validated
  and normalized for same-class retypes exactly as for class-changing ones.

## Review findings

Everything below was found in the review pass over the implement diff (`c31f04be`); the
implementer's own honest-gaps list is not repeated here.

### Checked and clean (no finding)

- **Identity-gate soundness.** `TypeRegistry.inferType` only ever returns registered
  singletons (exact match, then SQLite affinity fallbacks, then `BLOB_TYPE`), and column
  schemas take their `logicalType` from it, so `!==` is a safe alias test rather than an
  accidental object-identity trap.
- **No other physical-class gates left.** Swept every package for `physicalType ===` /
  `!==`; the only remaining uses are the JSON/`OBJECT` comparison gates in the planner and
  a range check in `database.ts`. Nothing else keys retype behavior off the storage class.
- **The `valueConvert`-first reordering is genuinely subsuming.** `convertColumn` clears
  `secondaryIndexes` and re-runs `initializeSecondaryIndexes()` against the newly-installed
  schema, which reproduces `adoptSchema`'s add / replace / remove semantics wholesale.
  `pkColumnRekeyed` is reachable only from SET COLLATE (which never sets `valueConvert`), so
  the strict PK path is untouched.
- **Which type pairs newly convert.** Only `TEXT` ↔ `DATE`/`TIME`/`DATETIME`/`TIMESPAN`,
  `REAL` ↔ `NUMERIC`, and `NULL` ↔ `ANY` share a physical class. `JSON` is
  `PhysicalType.OBJECT` and `BOOLEAN` has its own class, so both already converted before
  this change. `NUMERIC.parse` / `ANY.parse` are identity on already-legal stored values, so
  the two numeric/any pairs are behavior-neutral as the handoff claimed.
- **Store composition.** The value rewrite, the PK re-key and the secondary-index rebuild
  stay mutually exclusive in the right order; the rebuild covers the new value bytes so
  index-backed lookups follow the normalization.
- **Validation.** `yarn build`, `yarn lint` (eslint + test-file tsc), `yarn typecheck`,
  `yarn test` (quereus 7267, isolation 275, store 1025, rest green), `yarn test:store`
  (7260 passing, 0 failing — one more than before, see below). No pre-existing failures
  surfaced; `tickets/.pre-existing-error.md` not written.

### Minor — fixed in this pass

- **Docs described the superseded rule.** `docs/sql-ddl.md` was updated by the implementer,
  but two other docs were not. `docs/memory-table.md` still split the ALTER families into
  "same storage class, no value rewritten" vs "value rewrite across storage classes", and
  its `SET DATA TYPE` section still routed same-class retypes through `adoptSchema`;
  `docs/store.md` still said the retype re-stores values only "when the new type has a
  different physical representation" and still listed "`SET DATA TYPE` within one physical
  representation" among the DDL that **writes no rows and therefore does not force-commit**
  the open transaction — a user-visible transactional claim that is now wrong. All four
  passages rewritten around logical-type identity.
- **Stale test-file comments.** `41.7.4`'s header asserted that a `TEXT` ↔ `TIMESPAN` retype
  "rewrites no stored value", and its §3 repeated it. A rewrite pass does run now; those
  particular values survive only because ISO durations are already canonical (`'1 hour'`
  would not). Reworded so the file stops teaching the old rule.
- **Stale store-mode exclusion.** `41.7.4` was memory-only because the store covered the
  `TIMESPAN`/`JSON` halves via its key-transform guard but not the `DATE`/`TIME`/`DATETIME`
  half. With the store on the same identity gate that is no longer true — verified the file
  passes in store mode and removed the `MEMORY_ONLY_FILES` entry (store logic suite 7259 →
  7260). Mirrors the implementer's own cleanup of the `41.7.3.1` entry.
- **Test coverage gaps.** The added tests proved the *values* move but never that the
  *structures keyed by them* follow. Added to `41.2` (both legs):
  - §16 — a normalizing retype under a plain index and a UNIQUE index: ordering, equality
    lookup, UNIQUE now enforcing over the normalized value, and a fresh value still
    accepted;
  - §16b — the same inside the DDL transaction, asserted before and after commit;
  - §16c — a pending row that collides with a committed one only after normalization:
    rejects, and the transaction survives to retry;
  - §17 — writes issued *after* the retype in the same transaction coerce and enforce under
    the new type.

### Tripwire (recorded, not filed)

- The rewrite is unconditional once the two types differ, even when every converted value
  comes back byte-identical (already-canonical ISO durations), costing a full base-tree +
  secondary-index rebuild on memory and a physical rewrite of every row on the store. Fine
  at current table sizes; `NOTE` at the gate in `MemoryTableManager.alterColumn` describes
  the fix (have the pre-pass record whether any value actually moved) if ALTER on a large
  table ever shows up as slow.

### Major — no new tickets filed, and why

- **`alterColumn` is 410 lines inside a 3447-line `manager.ts`**, mostly comment blocks,
  where the store module has already decomposed its equivalent into per-attribute helpers.
  Real debt, but `backlog/debt-memory-alter-column-method-too-long` already tracks exactly
  this; a second ticket would be noise.
- **The per-value `convert` closure is written three times** (memory, store, isolation),
  identically. Already tracked by `backlog/debt-share-retype-value-converter`.
- **Memory and store now disagree behind the isolation wrapper** on a retype whose only
  offending value sits in a row the transaction has deleted (memory accepts, store rejects,
  hence the memory-only `41.2.1`). This is the same decision
  `backlog/bug-retype-of-deleted-row-leaves-wrong-typed-value` exists to make, so rather
  than filing a duplicate the concrete divergence, its test-file consequence, and what each
  of that ticket's three options implies for the store's pre-pass were appended to it.

### Noted, no action

- The implement commit also carried `packages/quereus-isolation/test/flush-probe-ordering.spec.ts`
  (216 lines) and a `docs/design-isolation-layer.md` paragraph, neither mentioned in the
  handoff and neither related to this ticket. They pin the commit-flush read/write ordering
  invariant whose source fix landed untested in the previous ticket's review commit
  (`c4b39bf8`). Beneficial and green — kept.
- `date → time` silently converting `'2024-06-05'` to `'00:00:00'` is data-destroying but is
  exactly what an `INSERT` of that value into a `TIME` column does; pinned in `41.2` §13.
