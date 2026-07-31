----
description: On the persistent storage backend, changing the sorting rule of a primary-key column inside an open transaction could silently destroy a row or corrupt a unique index. It now refuses or accepts cleanly before touching anything, matching the in-memory backend. Implemented; needs review.
files:
  - packages/quereus-store/src/common/store-table.ts                 # NEW: rekeyedKeyComputer + validateRekeyedPrimaryKey (the two probes); rekeyRows now shares the key computer
  - packages/quereus-store/src/common/store-module-alter-column.ts   # pkRekeyNeeded block: probes before ddlCommitPendingOps; rebuild now non-enforcing
  - packages/quereus-store/src/common/store-module-index.ts          # rebuildSecondaryIndexes skipDuplicateCheck doc extended to the PK re-key caller
  - packages/quereus-store/src/common/store-module-base.ts           # ddlCommitPendingOps doc: post-flush validation example corrected
  - packages/quereus-store/test/alter-collate-pk-rekey.spec.ts       # NEW spec: all three defect shapes + negative control + probe-order case
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic  # un-skipped, PK now `collate binary`, two new sections
  - packages/quereus/test/logic.spec.ts                              # MEMORY_ONLY_FILES entry removed (comment records why)
  - packages/quereus/src/vtab/memory/layer/manager.ts                # doc comment: stale ticket ref → StoreTable.validateRekeyedPrimaryKey
  - docs/memory-table.md                                             # stale ticket path fixed; store parity stated
  - docs/store.md                                                    # SET COLLATE bullet rewritten to the two-probe shape; pre/post-commit validation paragraph corrected
difficulty: hard
----

# Store PK `SET COLLATE` re-key: two pre-mutation probes, non-enforcing rebuild

## What was wrong (three defects, all reproduced first)

`alter column … set collate` on a primary-key column physically re-keys the store. Inside an
open transaction (store behind the isolation wrapper, whose overlay holds the transaction's
uncommitted writes):

1. **Silent row loss.** A staged insert colliding with a committed row under the new collation
   was caught by neither side — the store re-keyed the committed row onto the staged row's key
   and the commit flush overwrote it. No error; one row gone.
2. **False rejection + index corruption.** With a composite PK and a unique index over the
   altered column, deleting the index collider then altering was rejected by the *post-re-key*
   enforcing index rebuild (which sees committed rows only) — after the data store was already
   re-keyed and the index cleared. Index-backed seeks and full scans then disagreed.
3. **Right refusal, wrong shape.** A committed collider deleted in the transaction was refused
   as `CONSTRAINT` (invalid data) instead of `BUSY` (retryable pending state), with an
   unhelpful message, and only after `ddlCommitPendingOps()` had flushed the module transaction.

## What was built

`StoreTable.validateRekeyedPrimaryKey(newPkDef, newColumns, effectiveRows)` mirrors the memory
backend's oracle (`MemoryTableManager.validateRekeyedPrimaryKey`), called from
`alterColumnChange`'s `pkRekeyNeeded` block **before** the DDL flush:

- **Legality probe** over the rows the transaction can see (wrapper's `EffectiveRowSource`,
  else the table's own effective entries — which include the module's buffered ops, so no flush
  is needed to see a pending insert). Repeat → `CONSTRAINT`, memory's wording, naming the key
  (fixes defect 1).
- **Representability probe** over the store's committed rows (what a rollback must restore).
  Repeat → `BUSY`, memory's exact "…still collide under the new key definition and must survive
  a rollback. Commit/rollback and retry." wording (fixes defect 3 — both status and timing:
  the transaction now survives the refusal).
- Probe **order** makes statuses right without backend sniffing: run bare (no wrapper),
  effective ⊇ committed, so a committed collision always trips the legality probe first and
  reports `CONSTRAINT`.

Both probes and `rekeyRows` key rows through one shared closure
(`StoreTable.rekeyedKeyComputer`: `buildDataKey` + `resolvePkKeyCollations` +
`resolvePkKeyTransforms` over the post-ALTER columns), so probe verdicts are byte-identical to
what the re-key writes — deliberately NOT the `dedupeRowSignature` path, which disagrees for an
`any`-typed PK (pinned by `any-json-pk-binary-key.spec.ts`, still green).

The post-re-key `rebuildSecondaryIndexes` call now passes `skipDuplicateCheck = true` (fixes
defect 2): the pre-mutation `validateUniqueOverExistingRows` walk already judged every unique
structure covering the altered column over the effective rows (explicit unique indexes reach it
via their `derivedFromIndex` entry in `uniqueConstraints`; plain UNIQUE constraints natively),
and an index not covering the column cannot newly collide.

`rekeyRows` pass 1 is retained as a backstop for the SET COLLATE path and remains **the gate**
for `ALTER PRIMARY KEY` (see gaps below). Doc comments updated at all three sites; docs/store.md
and docs/memory-table.md updated to the two-probe shape and cross-backend parity.

## Validation run

- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — all workspaces green (quereus logic 8148 passing / 13 pending; quereus-store
  1207 passing; isolation 594 passing).
- `yarn test:store` — 8140 passing / 21 pending / 0 failing (LevelDB leg, includes the
  un-skipped 41.7.5).
- New spec `packages/quereus-store/test/alter-collate-pk-rekey.spec.ts` (isolated store over
  in-memory KV): staged-vs-committed → `CONSTRAINT`, txn usable, committed row never lost;
  deleted committed collider → `BUSY`, txn usable, rollback restores both rows, commit-then-retry
  succeeds; deleted unique-index collider → accepted, index seek and full scan agree; negative
  control (collider not deleted) → rejected pre-mutation, index intact; bare committed collision
  → `CONSTRAINT` (probe order).
- `41.7.5-…sqllogic` un-skipped (PK now `collate binary`; the skip-list's second reason was
  measured false, per the fix elsewhere the first reason — store NOCASE default — is what the
  explicit collation removes) and extended with two sections pinning the CONSTRAINT and BUSY
  shapes on both backends.

## Known gaps / notes for review

- **`ALTER PRIMARY KEY` deliberately unchanged.** Its duplicate pass still runs post-flush
  (`rekeyRows` pass 1). No staged-vs-committed hole exists there: the isolation wrapper refuses
  `alterPrimaryKey` outright while the transaction has staged writes for the table (`BUSY`,
  `isolation-module.ts` ~1349), and on the bare module the flush precedes the pass so pending
  rows are visible. Cost: a bare-module refusal there still arrives with the transaction
  flushed — documented in docs/store.md's updated paragraph, out of this ticket's scope.
- **Representability breadth differs from memory by design.** Memory's BUSY probe walks every
  statement-boundary layer, so a pair held only transiently (inserted AND deleted in the txn,
  41.7.5 §2) is refused by memory itself; on the store leg that same refusal comes from the
  overlay's own memory-table probe, not the store's committed probe (the store never held the
  pair). End-to-end parity is what the sqllogic file pins, and it holds.
- **The CONSTRAINT diagnostic names the second-iterated row's key**, so which case-variant
  spelling appears ('a' vs 'A') depends on merge order of the effective stream. Tests match the
  message substring, never the key value.
- **Soft status-code assertion in the new spec**: `expectRejection` checks `.code` only when the
  surfaced error carries one (it did in all runs); the message regexes are the primary pin. If
  review wants a hard pin, assert `err instanceof QuereusError` instead.
- **41.7.5 kept its `-memory` filename** though now cross-module — precedent: 41.7.3.1 did the
  same when it went cross-module; the skip-list comment records the state.
- Tripwire (recorded in the `rekeyRows` doc comment): the SET COLLATE path now scans the table
  three times before mutating (two probes + pass-1 backstop) plus pass 2. Fine for a statement
  this rare; if a huge table ever makes it slow, drop pass 1 for callers that pre-validated.
