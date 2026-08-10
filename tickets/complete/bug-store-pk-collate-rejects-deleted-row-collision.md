description: On the persistent storage backend, changing the sorting rule of a primary-key column inside an open transaction could silently destroy a row or corrupt a unique index. It now refuses or accepts cleanly before touching anything, matching the in-memory backend. Implemented and reviewed.
files:
  - packages/quereus-store/src/common/store-table.ts                 # rekeyedKeyComputer (private) + validateRekeyedPrimaryKey (the two probes); rekeyRows shares the key computer
  - packages/quereus-store/src/common/store-module-alter-column.ts   # pkRekeyNeeded block: probes before ddlCommitPendingOps; rebuild non-enforcing
  - packages/quereus-store/src/common/store-module-index-build.ts    # NEW effectiveDdlRows helper (shared by every pre-mutation ALTER probe)
  - packages/quereus-store/src/common/store-module-alter.ts          # ADD CONSTRAINT UNIQUE probe uses effectiveDdlRows
  - packages/quereus-store/src/common/store-module-index.ts          # rebuildSecondaryIndexes skipDuplicateCheck doc extended to the PK re-key caller
  - packages/quereus-store/src/common/store-module-base.ts           # ddlCommitPendingOps doc: post-flush validation example corrected
  - packages/quereus-store/test/alter-collate-pk-rekey.spec.ts       # 8 cases: three defect shapes, negative control, probe order, accept paths, bare module
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic  # un-skipped, PK now `collate binary`, two new sections
  - packages/quereus/test/logic.spec.ts                              # MEMORY_ONLY_FILES entry removed
  - packages/quereus/src/vtab/memory/layer/manager.ts                # doc comment: stale ticket ref → StoreTable.validateRekeyedPrimaryKey
  - docs/store.md                                                    # SET COLLATE bullet: two probes, bare-module BUSY, non-transactional-DDL consequence
  - docs/memory-table.md                                             # stale ticket path fixed; store parity stated
  - docs/design-isolation-layer.md                                   # the underlying's own BUSY, alongside the overlay's
----

# Store PK `SET COLLATE` re-key: two pre-mutation probes, non-enforcing rebuild

## What was wrong

`alter column … set collate` on a primary-key column physically re-keys the store. Inside
an open transaction (store behind the isolation wrapper, whose overlay holds the
transaction's uncommitted writes), three defects, all reproduced first:

1. **Silent row loss.** A staged insert colliding with a committed row under the new
   collation was caught by neither side — the store re-keyed the committed row onto the
   staged row's key and the commit flush overwrote it. No error; one row gone.
2. **False rejection + index corruption.** With a composite PK and a unique index over the
   altered column, deleting the index collider then altering was rejected by the
   *post-re-key* enforcing index rebuild (which sees committed rows only) — after the data
   store was already re-keyed and the index cleared.
3. **Right refusal, wrong shape.** A committed collider deleted in the transaction was
   refused as `CONSTRAINT` (invalid data) rather than `BUSY` (retryable pending state), and
   only after `ddlCommitPendingOps()` had already spent the transaction.

## What was built

`StoreTable.validateRekeyedPrimaryKey(newPkDef, newColumns, effectiveRows)` mirrors the
memory backend's `MemoryTableManager.validateRekeyedPrimaryKey` and is called from
`alterColumnChange`'s `pkRekeyNeeded` block **before** the DDL flush:

- **Legality probe** over the rows the transaction can see (the wrapper's effective row
  stream, else the table's own effective entries — which include the module's buffered ops,
  so no flush is needed to see a pending insert). Repeat → `CONSTRAINT`, memory's wording,
  naming the key (fixes defect 1).
- **Representability probe** over the store's committed rows (what a rollback must
  restore). Repeat → `BUSY`, memory's "…must survive a rollback. Commit/rollback and
  retry." wording (fixes defect 3, both status and timing).
- Probe **order** makes the statuses right with no backend sniffing: the committed probe
  can only fire once the effective one passed, i.e. only when the transaction has deleted a
  committed row.

Both probes and `rekeyRows` key rows through one shared private closure
(`StoreTable.rekeyedKeyComputer`), so probe verdicts are byte-identical to what the re-key
writes — deliberately not the `dedupeRowSignature` path, which disagrees for an `any`-typed
PK (pinned by `any-json-pk-binary-key.spec.ts`).

The post-re-key `rebuildSecondaryIndexes` call passes `skipDuplicateCheck = true` (fixes
defect 2): the pre-mutation `validateUniqueOverExistingRows` walk already judged every
unique structure covering the altered column over the effective rows, and an index not
covering the column cannot newly collide.

`rekeyRows` pass 1 is retained as a backstop for the SET COLLATE path and remains the gate
for `ALTER PRIMARY KEY`.

## Review findings

Reviewed the implement diff (`2605a739`) fresh against the sources, then re-derived
behavior with throwaway probe specs before trusting the handoff's account of it.

### Fixed in this pass (minor)

- **Probe-order rationale was wrong for the bare module.** The docstring claimed "run
  without a wrapper, effective ⊇ committed, so a committed collision always reports
  `CONSTRAINT`". False when the module's own coordinator holds a buffered *delete*: probed
  directly, that path answers `BUSY`, not `CONSTRAINT`. The behavior is right — and
  stricter than before the fix, which flushed the delete and re-keyed happily, spending the
  transaction's rollback in silence — but it was undocumented and untested. Corrected the
  docstring and the matching test comment, and added a bare-module test pinning the `BUSY`
  plus the commit-then-retry recovery.
- **The tripwire the handoff claimed to have recorded was not in the source.** The handoff
  said the "three scans before mutating" note lived in `rekeyRows`' doc comment; no such
  `NOTE:` existed. Written now (on `validateRekeyedPrimaryKey`, where the scans were added)
  and corrected to four — two probes, pass 1, pass 2.
- **Soft status assertion in the new spec.** `expectRejection` asserted `.code` only when
  the surfaced error happened to carry one. Hardened to require a `QuereusError` and match
  the code unconditionally; all cases pass, so nothing was being skipped.
- **`rekeyedKeyComputer` was public with a never-used default parameter.** Made private
  (both call sites are inside `StoreTable`) and the parameter required.
- **DRY: `rows ? rows() : rowsFromEntries(table.iterateEffectiveEntries(…))`** was spelled
  out at four sites across two files, one of them added by this diff. Extracted
  `effectiveDdlRows(table, rows)` next to `rowsFromEntries` and used it at all four.

### Coverage gaps closed

The implementer's five cases covered the three defects, a negative control, and probe
order — all refusal shapes. Added three accept-path/interaction cases:

- a staged row that does *not* collide: ALTER accepted, staged row lands under the new key,
  point lookups on both rows resolve (the effective probe's success path was untested);
- an accepted re-key over a deleted unique-index collider followed by `rollback`: the data
  store and the index still describe the same rows (this is what defect 2 actually
  damaged — the implementer's version only checked the `commit` branch);
- the bare-module `BUSY` described above.

Also probed and confirmed correct without adding tests (covered transitively by the
sqllogic file or by existing specs): delete-then-reinsert-at-the-case-variant (memory
41.7.5 §1 shape), a staged PK-moving `update` before the ALTER, and a descending composite
PK re-key with staged rows.

### Filed as new tickets (major)

- `backlog/bug-store-alter-primary-key-rejection-eats-transaction` — `alter primary key`
  still flushes the transaction before its duplicate check, so a rejected statement
  permanently commits the user's earlier uncommitted work. The handoff called this
  deliberately out of scope, which was the right call for that pass; it is a reachable
  defect on the bare module and now cheap to fix, since `validateRekeyedPrimaryKey` is
  exactly the probe it needs.
- `backlog/debt-store-test-shared-inmemory-provider` — the store package's specs each carry
  their own copy of `createInMemoryProvider` (20+ near-identical copies, this diff added
  the latest). Pre-existing and outside this diff's blame, but it is now the default way to
  start a new spec in that package.

### Tripwires (recorded, not ticketed)

- **Four full table scans before the SET COLLATE re-key mutates** (two probes, `rekeyRows`
  pass 1 backstop, pass 2), each holding one hex key signature per row. Fine for a
  statement this rare. Recorded as a `NOTE:` on `validateRekeyedPrimaryKey`, with the exit:
  drop pass 1 for callers that pre-validated — it cannot fire for them.

### Checked and found sound

- **The `skipDuplicateCheck = true` argument holds.** `pkRekeyNeeded` implies
  `collationChanged || keyTransformChanged`, which is a subset of the condition gating the
  pre-mutation UNIQUE walk — so that walk has always run by the time the rebuild is
  reached, and it covers standalone unique indexes through their `derivedFromIndex` entry
  (pinned by the negative-control test).
- **The non-enforcing rebuild cannot displace an index entry.** Index entry keys carry the
  PK suffix, so two rows never share one entry key; the rollback test confirms data and
  index agree afterwards.
- **Diagnostic wording matches memory's** character-for-character on both statuses; the
  memory-only empty-key branch is unreachable here (a SET COLLATE PK always has members).
- **`valueConvert` and `pkRekeyNeeded` are still mutually exclusive**, so the ordering note
  guarding that assumption remains accurate.
- **Docs**: every file the change touches, plus the ones it should have touched. Beyond the
  implementer's updates, `docs/store.md` gained the bare-module `BUSY` and the
  non-transactional-DDL consequence (an accepted re-key is durable while the transaction's
  own row changes are not — memory leaves the same state), and
  `docs/design-isolation-layer.md` gained the underlying's own `BUSY`, which its `SET
  COLLATE` section previously attributed solely to the overlay. `docs/invariants.md` was
  checked and needs nothing: it records no invariant for either backend's re-key probe.

### Deliberately not changed

- **Representability breadth differs from memory by design.** Memory's `BUSY` probe walks
  every statement-boundary layer, so a pair held only transiently is refused by memory
  itself; on the store leg that refusal comes from the overlay's memory-table probe (the
  store never held the pair). End-to-end parity is what the sqllogic file pins, and it
  holds on both legs.
- **41.7.5 keeps its `-memory` filename** though now cross-module — precedent: 41.7.3.1 did
  the same, and the skip-list comment records the state.

## Validation

- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — all workspaces green, 0 failing (quereus logic 8148 passing / 13 pending;
  quereus-store 1210 passing; isolation 594 passing; sync 355; the rest as before).
- `yarn test:store` — 8140 passing / 21 pending / 0 failing (LevelDB leg, includes the
  un-skipped 41.7.5).
- `packages/quereus-store/test/alter-collate-pk-rekey.spec.ts` — 8 passing.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
