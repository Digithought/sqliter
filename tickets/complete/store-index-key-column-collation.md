---
description: The persistent store now writes each secondary index's text values using the sorting rule declared on the indexed column itself, instead of one table-wide rule, so the stored bytes agree with how the database actually compares those values. Reviewed, validated, and completed.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # resolveIndexKeyCollations
  - packages/quereus-store/src/common/key-builder.ts                # buildIndexKey (two IndexKeyHalf halves); buildIndexPrefixBounds collations
  - packages/quereus-store/src/common/store-table-base.ts           # validateKeyCollations over index key collations; assertIndexKeyCollationsCanKey
  - packages/quereus-store/src/common/store-table-scan.ts           # indexKeyCollations (memoized), getIndexComparator, window threading
  - packages/quereus-store/src/common/store-table-constraints.ts    # index maintenance, `_uc_*` preference, enforcement-seek guard
  - packages/quereus-store/src/common/store-module-index-build.ts   # build/rebuild threading
  - packages/quereus-store/src/common/store-module-index.ts         # CREATE INDEX pre-validation
  - packages/quereus-store/src/common/store-module-alter-column.ts  # SET COLLATE on an indexed non-PK column rebuilds covering indexes
  - packages/quereus-store/src/common/store-module-schema-sync.ts   # per-table try/catch + eviction in the rehydrate reconcile loop
  - packages/quereus-store/src/common/implicit-unique-index.ts      # reuse gate is now load-bearing
  - packages/quereus-isolation/src/isolated-table.ts                # comparator preference + PK-collation NOTE (docs only)
  - packages/quereus/src/index.ts                                   # exports CompareFn
  - packages/quereus-store/test/index-column-collation.spec.ts      # 21 tests (19 from implement + 2 added in review)
  - packages/quereus-store/test/key-builder.spec.ts                 # new buildIndexKey shape + per-column collation
  - packages/quereus-store/test/custom-collation-key.spec.ts        # two tests rewritten to the new contract
  - docs/store.md                                                   # per-column index key collation, DDL validation set, SET COLLATE rebuild, re-index-on-upgrade
  - docs/design-isolation-layer.md                                  # § When Phase 2 may seek — rationale refreshed
---

# Complete: secondary-index columns key under the column's own collation

## What shipped

A store table's secondary-index KEY bytes used to encode every text index-column value
under the table key collation `K` (`collation = …` module option, default NOCASE), while
everything that COMPARED those values — the scan residual, the planner's cover analysis,
UNIQUE enforcement — used the index column's own effective collation `C` (index `COLLATE`
?? table column collation ?? BINARY). The bytes now encode under `C`, resolved once by
`resolveIndexKeyCollations` and threaded through every site that writes, seeks, rebuilds,
or merges index bytes:

- `StoreTableConstraints.updateSecondaryIndexes` — DML maintenance (delete + insert)
- `buildIndexEntries` — CREATE INDEX and every rebuild
- `StoreTableConstraints.findUniqueConflictViaIndex` — UNIQUE enforcement seek
- `StoreTableScan.analyzeIndexAccess` / `buildIndexRangeBounds` / `scanMultiSeek` — read windows

`buildIndexKey` was reshaped into two symmetric `IndexKeyHalf` objects; `StoreTableScan`
gained `getIndexComparator`, so the isolation overlay merges an index scan in the order the
store actually emits. The PK suffix and data-store bytes are unchanged. Supporting changes:
DDL-time validation now checks the index key collations rather than blanket-requiring `K`;
`ALTER COLUMN … SET COLLATE` on an indexed non-PK column rebuilds every covering index; the
rehydrate reconcile loop isolates and evicts a table whose index collation this connection
cannot key.

**On-disk impact:** secondary-index key bytes change for any text index column whose
effective collation differs from `K`. There is no format-version stamp, so a
previously-persisted database with such an index must be re-indexed (drop + recreate) or
recreated. Documented in `docs/store.md`.

## Review findings

### Checked and clean

- **Encode/seek-site audit.** Every `buildIndexKey` / `buildIndexPrefixBounds` call site in
  the repo threads the resolved collations (the parameter types differ from the transform
  array, so a mis-ordered positional argument cannot compile). The only untouched caller is
  the `@deprecated buildIndexScanBounds` shim, which nothing calls.
- **Behavioral probes against a memory-table oracle** (written, run, then deleted — the
  cases were either already covered or found nothing to pin): `v any collate nocase` with an
  index seek; an index `COLLATE nocase` over an undecorated column; a two-column index whose
  second column is NOCASE; an `RTRIM` column; a `TIMESPAN` index column. Store and memory
  agreed on all five. The `any collate nocase` case was the one I expected to break — its
  key collation is hard-`BINARY` while the store's residual compares under the declared
  NOCASE — but the window is exactly what the engine's own `ANY` comparison admits, so the
  result matches memory and the previous K-encoding was the looser answer.
- **Removing `K` from `validateKeyCollations` does not push a bad `K` to write time.** An
  `undefined` collation entry (the `EncodeOptions.collation` fallback, i.e. `K`) is produced
  only for never-text columns, and `encodeValue` reaches a normalizer only for text / JSON
  values. Every text-capable PK and index position carries an explicit validated name.
- **`_uc_*`-vs-explicit index resolution** and the restated
  `indexSeekHonorsEnforcementCollation` (exact per-column equality, never-text exempt): the
  name-first pick is scoped to the column-set candidates, and every path that can still hand
  it a collation-divergent index declines to the always-correct full scan.
- **The `ALTER … SET COLLATE` rebuild** runs before `updateSchema`, against the materialized
  updated schema, and `rebuildSecondaryIndexes` clears each index store before rebuilding, so
  no stale-collation entries survive.
- Read guards (`eqSafeToHandle`, `rangeSafeToHandle`, `indexRangeIsOrderSafe`) are now merely
  conservative, and the two decision sites still agree with each other — a plan the planner
  marks handled is one `analyzeIndexAccess` can build a window for.
- `yarn build`, `yarn lint`, `yarn typecheck` clean. `yarn test`: all workspaces green
  (engine 8277, store 1271, isolation 367, sync 643; 0 failing). `yarn test:store`: 8269
  passing, 21 pending, 0 failing.

### Found and fixed in this pass (minor)

- **Unhandled rejection on the new eviction path.** `void table.dispose()` in the rehydrate
  reconcile loop: `dispose` flushes stats first, so a failing flush became an unhandled
  promise rejection. Now `.catch`-logged (store-module-schema-sync.ts).
- **Four stale doc/comment sites the implementation should have touched.**
  - `docs/store.md` § Collation Support still described DDL validation as "each text-capable
    PK column plus `K` when any index column can hold text" — that is precisely what changed.
  - `docs/store.md` § Order preservation pointed at
    `backlog/debt-store-index-keys-use-column-collation` as future work; that ticket is this
    one, and the remaining `C === K` range demand is now leftover conservatism tracked by
    `implement/store-index-collation-guard-collapse`.
  - `docs/design-isolation-layer.md` § *When Phase 2 may seek* justified its BINARY-only gate
    with "the store's index key bytes come from an encoder registry that does not consult the
    database's collation registry" — false on both counts now. Rewritten, with the widening
    tracked and the interaction with `backlog/debt-iso-store-unique-seek-rowcount` named.
  - `IsolatedTable.getPkCollations`' NOTE repeated the same retired claim.

### Test gaps closed (2 tests added, both mutation-verified)

- **The rehydrate eviction had no test of its own.** Added: two store tables, one indexed
  under a custom collation the reopening connection never registers. Asserts exactly one
  recorded error, that the *sibling* table still reconciled its index (its derived UNIQUE
  enforces — an index-less half-schema could not), and that the failed table raises on DML
  instead of accepting it. Mutation-checked twice: removing the `try`/`catch` fails it (the
  whole rehydrate aborts), and keeping the catch but dropping the eviction fails it too (the
  half-schema'd table silently accepts DML without maintaining its index). Both arms of the
  new code are load-bearing.
- **`getIndexComparator` had no direct unit test** (only end-to-end through the isolation
  merge). Added: NOCASE key collation folds case, a DESC column's comparator is negated, a
  hidden `_uc_*` resolves against the materialized schema and keys BINARY for an undecorated
  text column, an unknown name returns `undefined`.

### Tripwires parked (not tickets)

- **`getIndexComparator` states comparator order, which is byte order only while the
  collation's key normalizer preserves order.** Fine today (built-ins assert it; a custom
  equality-only collation is not reachable on an index column through DDL), and the isolation
  layer's descriptor fallback carried the same exposure before this method existed. `NOTE:` at
  the method in store-table-scan.ts, with what to do if such a collation ever ships.

### Filed as follow-up work

- No new tickets. One **arm appended** to the existing
  `implement/store-index-collation-guard-collapse` (same root cause, different file):
  `IsolatedTable.canSeekForConstraint`'s BINARY-only gate was justified by the byte
  divergence this ticket removed, so it is now conservatism — a collated index-derived UNIQUE
  full-scans the underlying on every insert. The arm records what to establish before
  widening it and its conflict with `backlog/debt-iso-store-unique-seek-rowcount`'s proposed
  negative control.

### Noted, deliberately not actioned

- `store-module.ts` (~line 427) and `rehydrate-catalog.spec.ts` (~line 649) still say
  "Physical key bytes are always K-encoded". That is a **PK-side** comment, already stale
  before this ticket (per-column PK collations landed earlier) and outside its index-side
  scope; correcting it means re-deriving the surrounding "a legacy divergent declared PK
  collation is stale metadata, not a correctness risk" argument, which is only reachable for
  pre-per-column-PK data — and backwards compatibility is waived project-wide (AGENTS.md).
  Both sites, plus `docs/store.md` line ~556, cite `store-pk-collate-legacy-reopen-divergence`,
  which is not a ticket on the board; that dangling reference is also pre-existing.
- The implement handoff's own listed gaps were re-examined and left as-is: the reopen test
  pins the COLLATE round-trip through UNIQUE enforcement rather than a read lookup (a plain
  `where email = 'x'` genuinely cannot observe an index COLLATE — the residual compares under
  it either way), "no double rebuild" on PK-member SET COLLATE stays a behavioral rather than
  structural assertion, and no test combines a semantic-ordering index column with the new
  collation threading (its key collation is hard-BINARY and the transforms are threaded
  independently, so the combination carries no new interaction).
