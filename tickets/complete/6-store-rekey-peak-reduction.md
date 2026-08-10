description: A table primary-key change in the persistent store used to hold two full copies of the table in memory; it now holds one copy plus a small set of key fingerprints, while staying all-or-nothing.
files:
  - packages/quereus-store/src/common/store-table.ts   # rekeyRows (~578-666)
  - packages/quereus-store/test/alter-table.spec.ts     # all-or-nothing + SET COLLATE tests
difficulty: medium
----

# Complete: halve `rekeyRows` peak memory, keep single-batch atomic

## What shipped

`StoreTable.rekeyRows` re-keys every stored row under a new primary-key
definition — it drives `ALTER PRIMARY KEY` and `ALTER COLUMN … SET COLLATE` on a
PK member. It was a two-pass design that held the whole table twice (a
`Map<hex, {newKey, oldKey, row}>` alive while the write batch was built). It now:

- **Pass 1** iterates once, computes each row's new key, keeps only a
  `Set<string>` of hex key signatures for collision detection, and throws
  `CONSTRAINT` on a repeat signature before pass 2 writes anything.
- **Pass 2** re-scans the same committed store, recomputes each new key through
  the same `computeNewKey` helper (so a pass-1 collision judgement is
  byte-identical to what pass 2 writes), and batches `delete(oldKey)` +
  `put(newKey, row)` for rows whose key actually moves — into ONE `batch.write()`.

Peak drops from ~two tables to one table (the batch) + a signature set. Cost:
O(rows) extra CPU for the second iterate + recompute + re-serialize.

## Review findings

Adversarial pass over the implement diff (`eeb45757`). Ran, with fresh eyes on
the diff before the handoff.

**Checked — correctness of the refactor:**
- Collision detection is complete. Pass 1 computes every row's new key and
  rejects on any repeat, so two rows collapsing to one new key is caught whether
  or not either row moves (a mover colliding with a stayer is caught too). No
  write happens before the throw.
- Pass 2's recompute is byte-identical to pass 1: both deserialize `entry.value`
  and route through the single `computeNewKey` closure. No key can be judged
  legal in pass 1 then written differently in pass 2.
- Both passes iterate the SAME `buildFullScanBounds()` over the SAME committed
  store; nothing writes between them (single-threaded ALTER, outside the
  coordinator, callers ran `ddlCommitPendingOps`). Confirmed the re-scan
  assumption holds for the ALTER path.
- Atomicity preserved: still exactly one `batch.write()`; empty batches (empty
  table, all no-op rows) write cleanly.

**Checked — memory claim (by inspection; no profiling harness in this package):**
- Old peak = the full-row map alive while the batch is built ≈ two tables. New
  peak = the signature `Set` alive while the batch is built ≈ one table + sigs.
  The halving claim holds. The `seen` set stays referenced through pass 2 (it is
  small vs the batch, so not worth nulling early).

**Checked — tests (starting point, extended):** 948 store tests pass. New tests
cover the guarantee the refactor must not break — the "no partial re-key" ALTER
PRIMARY KEY case (5 rows, one collision, full ordered row set byte-unchanged),
plus SET-COLLATE-on-PK collision-rejects / no-collision-succeeds. The `any`-PK
BINARY no-op re-key stays green. Happy path, collision/error path, and the
empty-table edge are all exercised.

**Checked — docs:** the change is internal to `rekeyRows`; no `docs/` file
documents its two-pass mechanics. Code comments in the function are thorough and
now match the signatures-only design. The referenced
`debt-store-atomic-batch-bounded-memory` ticket exists (in `backlog/`), so the
residual single-batch peak is genuinely tracked. Nothing stale found.

**Checked — validation:** `yarn workspace @quereus/store typecheck` clean;
`yarn workspace @quereus/quereus lint` clean (exit 0). LevelDB store path
(`yarn test:store`) not run — `rekeyRows` is store-agnostic (only
`KVStore.iterate`/`batch`), so the in-memory suite exercises the contract.

**Minor findings:** none — nothing to fix inline.

**Major findings:** none — no new ticket filed.

**Pre-existing observation (NOT filed, NOT a regression):** the KV-store write
batch applies ops sequentially (verified in `memory-store.ts` `batch()` and the
IndexedDB/SQLite backends). So a *cyclic* re-key — a row's new key equal to a
different row's OLD key (e.g. row1 K1→K2 while row2 K2→K3) — emits
`delete K1, put K2, delete K2, put K3`, and the `delete K2` erases row1's freshly
written value. This is a latent, pre-existing store-level concern: op order is
byte-for-byte identical before and after this refactor (old code emitted from
`pending.values()` in the same store-scan order), so this change neither
introduces nor worsens it. It is also speculative — it requires a new key's bytes
to land exactly on another row's existing key. Left as an observation here rather
than a ticket: pre-existing, out of this ticket's diff, and unproven to be
reachable. If a future change makes cyclic re-keys plausible (e.g. PK-column
permutations that alias byte-space), a two-phase batch (all deletes staged before
puts, or write to a scratch keyspace) would be the fix.

**Tripwire (parked by implementer, confirmed appropriate):** pass 2 re-serializes
each moved row instead of reusing the iterator-owned `entry.value`, to avoid
retaining a backend buffer in the batch. Recorded as a `NOTE:` at the site in
`rekeyRows` pass 2; revisit only if re-key CPU shows up hot. No ticket — correct
disposition.

## Residual / out of scope

- The single-batch peak (the batch still buffers every changed row) is
  irreducible without breaking atomicity — tracked in
  `debt-store-atomic-batch-bounded-memory`.
- No memory-profiling assertion added; there is no such harness in the package
  and the peak claim rests on code inspection. Correctness and atomicity are what
  the tests guard.
