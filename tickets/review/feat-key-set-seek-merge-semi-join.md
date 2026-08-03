---
description: When a query filters a table by a set of values on its primary key, the engine used to read every row of the big table; it now collects the small set first and looks up only the rows it needs, while still returning them in the right order.
files:
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts
  - docs/optimizer-rules.md
  - docs/optimizer-fd.md
  - docs/optimizer.md
---

# Review: key-set seek rewrite extended to merge semi joins

Implemented per `plan/feat-key-set-seek-merge-semi-join` (now deleted from
implement/; see git history for the full spec — this is the distilled handoff).

## What was built

`where pk in (select …)` on a table's primary key plans as a **merge** semi
join on the memory backend (both sides advertise a primary-key walk), so the
existing `rule-key-set-seek` — anchored on the hash semi join only — never saw
the most common IN-subquery shape and the big table was read in full. Changes:

1. **`seekPreservesTargetOrder(target, pushdown)`** — new exported predicate in
   `key-set-semi-join-node.ts`. True when the multi-seek's index IS the index
   the target leaf walks (single key column, leaf's advertised order matching
   that key column's direction). Under it, both runtime branches — untouched
   walk and multi-seek — emit in the leaf's own key order (a seek emits a
   subsequence of the walk; a subsequence of an ordered stream is still
   ordered). The full soundness argument is in the predicate's doc comment.

2. **`KeySetSemiJoinNode.computePhysical`** now claims the target's `ordering`
   and `monotonicOn` when the predicate holds (both arms — a hash-anchored node
   whose seek index is its walk index claims too). Derived on every call, never
   stored, so a leaf rebuild through `withChildren` cannot leave a stale claim.
   `accessCapabilities` stays dropped. `preservesTargetOrder` surfaced in
   `getLogicalAttributes` for EXPLAIN.

3. **The `orderingLoadBearing` decline moved** out of `admitLeaf` to after
   `planPushdown`, conditioned on `!seekPreservesTargetOrder`. So an ORDER BY
   the walk absorbed no longer blocks the rewrite when the seek reproduces the
   order — `… order by pk` now seeks. The old behaviour is preserved where the
   indexes differ (pinned by the pre-existing "declines when the leaf order
   absorbed the Sort" test, unchanged).

4. **`admitJoin` widened** to `BloomJoinNode | MergeJoinNode`; two merge-only
   gates in `ruleKeySetSeek`: (a) `seekPreservesTargetOrder` must hold — a
   merge join propagates the probe side's ordering upward for semi, so a
   replacement that cannot re-claim it is a wrong-order plan; (b) decline when
   `node.right.physical.estimatedRows` exceeds
   `min(pushdown.maxKeys, pushdown.breakEvenKeys)` — past the runtime's own
   seek threshold the rewrite trades a streaming merge for a pointless key-set
   materialization. Inert on undoctored memory tables (their estimates read 0).

5. **New registry entry `key-set-seek-merge`** on `PlanNodeType.MergeJoin` in
   `optimizer.ts`, immediately after `key-set-seek` (two entries, not a
   nodeType array — fan-out would rename the existing id). Placement rationale
   in the registry comment. `propagate.ts` already classified `KeySetSemiJoin`;
   no DML-diagnostics change needed (verified).

6. Docs updated together: `optimizer-rules.md` (rule bullet), `optimizer-fd.md`
   (node's property row — now the conditional rule), `optimizer.md` ("where an
   IN (SELECT …) ends up" — merge semi join is no longer the end of the line).

## Behaviour to spot-check

- `select id from big where id in (select id from small)` (memory backend, both
  ids primary keys) → `KeySetSemiJoin via _primary_`, `plan=5;inCount=K` idxStr
  on `big`, only K rows pulled, emission ascending.
- Same with `order by id` → **no SortNode**, rows ascend (previously this
  declined the rewrite entirely).
- `delete from big where id in (select id from small)` → same seek;
  `returning` verified.
- `primary key (id desc)` → arrives as a **hash** semi join (a descending side
  is not merge-ready), exercises the relaxed decline: `order by id desc`
  absorbed, rewrite fires, rows descend. Depends on the prereq
  `bug-desc-pk-scan-advertises-ascending-order` (landed).
- Declines left in place: composite pk (module declines the runtime set —
  merge join survives), anti merge join (`not exists`), residual-carrying
  merge join (two-pair exists), key source estimate over the threshold,
  absorbed-Sort shapes where seek index ≠ walk index.
- Store backend: declines runtime-set IN on its pk
  (`backlog/feat-store-pk-in-list-multiseek`), keeps the merge join — the
  sqllogic cases assert rows only, byte-identical across backends.

## Test coverage added

- `test/optimizer/key-set-seek.spec.ts` (38 passing): merge-arm rewrite for
  select/delete/update; physical `ordering`/`monotonicOn` claim equals the
  target leaf's (what the merge join claimed); absorbed `order by pk` with no
  Sort + row order; `order by w` Sort survives; composite/anti/residual/
  key-source-size declines (the size decline has a below-threshold control so
  it cannot pass vacuously); desc-pk end to end; non-unique secondary index tie
  shape; direct `seekPreservesTargetOrder` unit tests over real leaves ×
  synthetic pushdown variants; `withChildren` rebuild re-derivation (claim
  survives same-access-path rebuild, disappears on a changed one).
- `test/vtab/key-set-semi-join-runtime.spec.ts` (21 passing): merge-arm
  `_primary_` multi-seek observed via `IdxStrCapturingModule` — inCount, row
  pull ≤ K, ascending emission asserted raw; absorbed ORDER BY served through
  the seek; delete + RETURNING; above-ceiling scan fallback still ascending.
- `test/logic/08.4-key-set-semi-join.sqllogic`: primary-key section — select
  with/without ORDER BY, duplicate + NULL keys, empty set, DELETE, UPDATE,
  desc pk, read-your-own-writes txn. Runs on both backends (memory seeks,
  store keeps the merge join) — the cross-backend row-equivalence proof.
- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts` (374 passing
  package-wide): new merge-arm describe — staged insert/update/delete in an
  open transaction, rows AND raw emission order asserted (no JS sort), with
  the `_primary_` multi-seek pinned so it cannot pass vacuously on a scan.

## Known gaps and honest notes for the reviewer

- **Key-source-size decline test is cost-model-coupled.** Doctored
  `TableSchema.statistics` of big=100000/small=1200: with small=5000 the
  physical selector flips to index-nested-loop and the merge anchor never
  forms (discovered while writing the test). The test's "MergeJoin survives"
  assertion means a future cost flip fails loudly rather than passing
  vacuously, but the specific 1200/900 boundary assumes the default memory
  cost curves (threshold = engine ceiling 1000).
- **NULL keys through the merge arm specifically are structurally untested** —
  a merge-shape key source is its own non-null primary key, so a NULL can't
  reach that arm from the shapes that plan as merge joins today. NULL-key
  semantics are covered by the hash-arm runtime tests and the sqllogic rows.
- **`not in` on the pk shape never forms an anti join at all** (stays a
  Filter + IN set probe); the anti-decline coverage uses `not exists`, which
  does form an anti merge join.
- **Ties on a non-unique seek index are unconstrained by the claim** — pinned
  as "v ascends, row set exact" rather than a full row order; a downstream
  consumer relying on more than the claim would surface here first.
- The isolation package's mocha resolves `@quereus/quereus` to built `dist` —
  rebuild before re-running just that file (existing NOTE in the file).
- Pre-existing, not mine: `yarn test:store` prints repeated
  `[TransactionCoordinator] release/rollback-to savepoint … out of range`
  log noise (documented as pre-existing in
  `complete/bug-desc-pk-scan-advertises-ascending-order`); 0 failing.

## Validation

- `yarn build` (full monorepo) — clean.
- `yarn lint` (root fan-out; quereus eslint + test-file tsc) — clean.
- `yarn test` (root, all workspaces) — quereus 8573 passing / 13 pending /
  0 failing; isolation 374 passing; all other packages green.
- `yarn test:store` — 8565 passing / 21 pending / 0 failing.
