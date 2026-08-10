---
description: Bypassing SQL to call the persistent storage backend's internal "change a column's data type" function directly used to silently corrupt a table when that column was part of the table's primary key; that direct call now fails with a clear error instead, matching the in-memory backend. No SQL statement could ever trigger it — a defense-in-depth fix for code that talks to the storage module directly.
files:
  - packages/quereus-store/src/common/store-module.ts               # the guard in alterColumnSetDataType (~2427), call site (~2139), NOTE (~2271)
  - packages/quereus-store/test/pk-retype-reject.spec.ts             # direct-module-call spec (4 cases after review)
  - packages/quereus-store/test/alter-table-conformance.spec.ts      # SQL-level rejected arm (store leg)
  - packages/quereus/test/alter-table-conformance.spec.ts            # SQL-level rejected arm (memory leg)
  - docs/store.md                                                    # ~401 — implicit-commit list now states the PK-member reject
difficulty: easy
---

# Store backend refuses a primary-key column retype

`StoreModule.alterColumnSetDataType` now receives the table's pre-alter schema and, inside the
existing "the new logical type actually differs from the old one" check, throws
`QuereusError` / `StatusCode.CONSTRAINT`:

```
Cannot change the data type of primary key column '<col>' of table '<table>'.
```

before scanning a row or writing anything. Without it, the value rewrite (`mapRowsAtIndex`, a
payload-only rewrite that reuses `entry.key` verbatim) moved a primary-key column's stored value
to the new type while the row's physical key stayed encoded under the OLD type — the row
unreachable under the new encoding, every secondary index still holding the stale key. A second
sub-case (retyping into/out of a type with its own key encoding, e.g. TIMESPAN or JSON) computed
new keys from the pre-rewrite values and then skipped the secondary-index rebuild.

The guard mirrors `MemoryTableManager.alterColumn`'s existing carve-out in wording and placement,
so the two backends stay aligned. Because it lives inside the type-difference check, an **alias**
retype of a primary-key column (`text` → `varchar(50)`, which `inferType` flattens to the same
shared type object) still succeeds as a schema-only no-op — same as memory.

Unreachable from SQL: `runAlterColumn`
(`packages/quereus/src/runtime/emit/alter-table.ts:970-977`) already refuses
`alter table … alter column <pk-col> set data type …` for every backend before any module
dispatch, and the materialized-view reshape declares a key-column retype inexpressible and
rebuilds instead. The fix guards direct module callers (other packages, plugins, future engine
paths, tests).

## Review findings

**Diff read first, then the handoff.** Implement commit `82fcc9af`: 35 lines in
`store-module.ts` (guard + param + comment refresh), one new spec, two conformance arms.

Checked and clean:

- **Guard correctness.** `oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)` is
  the same predicate the sibling `DROP NOT NULL`-on-PK guard in the same file and the memory
  backend both use; `colIndex` comes from the same pre-alter `oldSchema.columns` lookup, so the
  indices agree. Throw precedes every scan and every write — nothing mutates on reject.
- **Over-rejection.** Non-PK retypes and alias retypes of a PK column still succeed; both are
  pinned by the new spec.
- **Isolation layer (`@quereus/isolation`) — the handoff flagged this as unverified.** Verified:
  `IsolationModule.alterTable` calls `this.underlying.alterTable(...)` *before* it migrates any
  overlay, and the issuer's pre-validation is throw-only. So the new CONSTRAINT propagates with
  the underlying, the catalog, and every overlay untouched — a clean abort, no partial state, no
  poisoned foreign overlay. No isolation-side change needed.
- **Error/status shape.** `CONSTRAINT` (not `MISMATCH`) is right: it is a structural refusal, not
  a value-conversion failure, and isolation's poison routing keys on `MISMATCH` for the
  conversion path only.

Fixed in this pass (minor):

- **Named test gap closed.** The handoff listed composite primary keys and the
  `keyTransformChanged` sub-case as unpinned. Added one case to `pk-retype-reject.spec.ts`:
  a two-column primary key `(a, b)`, retyping the **non-leading** member `b` to `integer` and
  to `timespan` (the key-transformed type), asserting `CONSTRAINT` and byte-identical store
  contents both times. Store suite: 1041 → 1042 passing.
- **Stale doc.** `docs/store.md`'s implicit-commit list said `ALTER COLUMN … SET DATA TYPE`
  rewrites rows "for any move between two different logical types" with no mention of the
  primary-key refusal. Narrowed to `<non-pk-member>` and added the reject, mirroring the
  paragraph `docs/memory-table.md` already carries for the memory backend. `docs/sql-ddl.md`
  was read and is already correct ("Rejected on PRIMARY KEY columns") — no change needed there.

Noticed, deliberately not filed:

- **The engine is stricter than either backend.** `runAlterColumn` rejects *every*
  `set data type` on a primary-key column, including an alias retype that both backends would
  accept as a no-op. Not a defect — the backends agree with each other, and the engine's blanket
  refusal is the documented user-facing contract — but it does mean the alias-accepting branch is
  reachable only by a direct module call, which is exactly what the new spec covers.
- **The primary-key guard is now duplicated** (memory + store, identical message, nothing
  enforcing the match). The natural home for de-duplication is the already-filed
  `backlog/debt-share-retype-value-converter`, which folds the *value converter* of this same
  ALTER arm into one shared helper; that ticket was left unedited rather than scope-crept.
- **`createInMemoryProvider` is hand-rolled per spec file** (~25 copies under
  `packages/quereus-store/test/`). Pre-existing convention, far wider than this diff.
- **`store-module.ts` is 4258 lines.** The diff added 12. Pre-existing size concern; a prior
  ticket (`complete/4-store-altertable-decompose`) already did one decomposition pass on this
  arm, and the sub-helper this change touched is short and single-purpose.

No major findings — nothing warranted a new ticket. No tripwires recorded: the one conditional
concern in the code (what a future remover of this guard must reorder) was already captured as a
`NOTE:` comment above the `valueConvert` block by the implementer, and this review confirmed the
refreshed wording is accurate.

## Validation

| Command | Result |
| --- | --- |
| `yarn workspace @quereus/store run test` | 1042 passing |
| `yarn workspace @quereus/store run typecheck` | clean |
| `yarn workspace @quereus/quereus run lint` (eslint + test-file type pass) | clean |
| `yarn workspace @quereus/quereus run test` | 7268 passing, 13 pending (pre-existing skips) |

No pre-existing failures observed; `tickets/.pre-existing-error.md` not written.
`yarn test:store` deliberately not run — the guard has no SQL surface, so the store-mode logic
lane cannot exercise it either way.
