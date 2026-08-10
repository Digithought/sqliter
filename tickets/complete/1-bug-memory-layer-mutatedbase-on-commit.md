description: Fixed a crash where deleting a row from a table that other tables point at with "on delete cascade" could fail the commit with an internal error; the fix has now been reviewed, given direct tests, and validated.
files:
  - packages/quereus/src/vtab/memory/layer/interface.ts        # noteDerivedChild / hasDerivedChildren on Layer
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # constructor marks its parent; clearBase precondition
  - packages/quereus/src/vtab/memory/layer/base.ts             # same flag on the base layer
  - packages/quereus/src/vtab/memory/layer/manager.ts          # promoteCommittedHead, isLayerInUse, chainContains, disconnect
  - packages/quereus/test/vtab/layer-collapse-mutated-base.spec.ts   # SQL-level regression (implement stage)
  - packages/quereus/test/vtab/layer-derived-child-guard.spec.ts     # unit contracts (review stage)
  - docs/memory-table.md                                       # § Layer Management now carries the promotion rule
---

# Layer collapse detached a layer other layers were still inheriting from

## What was wrong

The in-memory table engine stores each transaction as a "layer": a B-tree built on top of
the layer below it, sharing everything it did not change. When a table's newest committed
layer looked idle, `MemoryTableManager.tryCollapseLayers()` cut it loose from the layer
underneath (`clearBase()`) to let the older chain be released.

The underlying B-tree library (`inheritree`) guards its "a base never changes under a live
child" contract with a running version total that each child snapshots when it is built.
Cutting the base loose removes the base's whole contribution from that total, so every
layer already built on top of the cut layer instantly fails its next check with
`MutatedBaseError` — with no row having moved. The failure surfaced one step later, inside
the `TransactionLayer` constructor of the *next* commit, as an internal error out of an
ordinary `delete` on a table another table references `on delete cascade`.

## The fix

`Layer` gained `noteDerivedChild()` / `hasDerivedChildren()`. The `TransactionLayer`
constructor marks its parent before building anything over it, and promotion refuses any
layer that reports a derived child. The flag never clears — there is no layer-destruction
hook, and the manager's connection map cannot stand in as a liveness registry because
`disconnect` detaches connections that are still live and commit later.

Three adjacent gaps closed with it: `disconnect` now defers on `connection.hasOpenWork()`
(an eager savepoint moves a connection's uncommitted rows into its read layer and leaves no
pending layer, so the old test dropped a live connection); `isLayerInUse` walks both the
read and pending chains to the chain root instead of only the pending one; and
`tryCollapseLayers` no longer loops over a head its body never advanced.

Both promotion conditions, and why the second is the load-bearing one, are written up in
`docs/memory-table.md` § Layer Management.

## Review findings

### Verified (no defect found)

*   **Derivation-hole sweep.** Every construction of a B-tree over another layer's tree was
    checked, since one that skipped the new mark would leave the guard blind:
    `TransactionLayer`'s constructor, its `newPrimaryTreeOverParent()` rebuild, and
    `MemoryIndex`'s inherited form. The rebuild re-derives from a parent the constructor
    already marked, and the mark never clears, so it is covered. The manager's two other
    B-trees (`oldByKey`, `makePrimaryKeyProbe`) have no base at all.
*   **The other side of `clearBase()`.** Per `inheritree`'s own docs the call is a pointer
    drop, so a promoted layer goes on sharing nodes with its former base and a later write
    into that base would corrupt both. Checked every base-layer write path: `BaseLayer`
    never mutates a live primary tree in place — each schema path builds a fresh tree and
    assigns it — so that hazard is not reachable from the base side.
*   **The two hand-rolled ancestor walks folded into `chainContains()`.** The helper is
    self-inclusive where the originals started at the parent; both call sites are already
    guarded against the self case, so the rewrite is exact.
*   **Checks run:** `yarn workspace @quereus/quereus run lint` (eslint + test-file type
    pass), `yarn typecheck`, `yarn docs:check`, `yarn test` across the monorepo
    (8705 passing in `packages/quereus`, 13 pending, 0 failing anywhere). No pre-existing
    failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Fixed in this pass

*   **Dead code after promotion.** `promoteCommittedHead` re-pointed any connection reading
    the detached parent — but `isLayerInUse(parentLayer)` returns true for exactly that
    connection (the chain walk includes the layer itself), so the loop could never run.
    Instrumented the whole suite to confirm: 0 hits in 11,536 promotion attempts. Removed,
    with the reasoning left as a comment so a future narrowing of `isLayerInUse` is not
    silently wrong.
*   **Neither half of the fix had a test that fails without it.** The handoff was honest
    that the `disconnect` half had none; measurement showed the *guard* half had none
    either — the SQL-level regression spec passes with either half alone (checked all three
    combinations; with both disabled, case 1 fails with the reported `MutatedBaseError`).
    Added `packages/quereus/test/vtab/layer-derived-child-guard.spec.ts`: five unit
    contracts covering the constructor's mark, the `MutatedBaseError` it prevents (which
    also pins the `inheritree` behaviour the guard is justified by), promotion refusing a
    head with a derived child, and `disconnect` retaining a connection whose rows sit in an
    eager savepoint. Verified two of them fail with the corresponding half disabled.
*   **Docs stated the new rule in the wrong place.** The two edited bullets were multi-line
    paragraphs inside one-line skim lists, while the sections that actually describe
    promotion and cleanup — § Layer Management's "Automatic Promotion", § Memory
    Management's "Base Clearing" — still stated the old, now-wrong rule. Bullets trimmed to
    one line, the mechanism moved into § Layer Management as the two conditions, the stale
    bullets corrected.
*   **Brittle cross-file line reference** (`table.ts:95-110`) in the `interface.ts` doc
    comment dropped; the symbol name alone survives a re-edit of that file.

### Corrected measurement (no code change)

The handoff reported "collapse is now rarer, and it was already not firing", from 50
autocommit inserts into one table. That workload never disconnects, so
`tryCollapseLayers` is never *called* there — it says nothing about collapse in general.
Instrumenting the full suite: promotion is attempted 11,536 times and succeeds 8,489. The
new derived-children condition accounts for 1,140 refusals (deepest layer chain at a
refusal: 8) and the widened `isLayerInUse` for 4. So collapse is live, the guard's cost is
bounded and observed, and the `isLayerInUse` widening is near-inert — worth keeping as
defence in depth, but it is not what changed behaviour.

### Tripwires (recorded, not ticketed)

*   Existing `NOTE:` at the promotion guard in `manager.ts` — if layer-chain memory growth
    ever appears, switch promotion to `BTree.flatten()` behind a depth threshold rather
    than loosening the guard. Left as written; still accurate as a conditional, and the
    measurement above shows the condition has not tripped.
*   New `NOTE:` at `MemoryTableManager.disconnect` — the deferral has no timeout, so a
    transaction abandoned without commit or rollback pins its connection and layer chain
    for the table's lifetime. Already true for an abandoned pending layer; the `hasOpenWork`
    change widens it. If abandoned transactions ever show as a leak, the fix is a reaper
    over `connections`, not a narrower test at the deferral.

### Considered, deliberately left alone

*   **Residual the guard does not cover:** a *detached* connection still reading the
    promoted layer's former base. Already documented on `isLayerInUse` ("necessary but not
    sufficient"); not reachable from any test that could be constructed, and `flatten()` is
    the real answer if it ever bites.
*   `derivedChildCount` is a counter that never decrements and is never read as a number —
    a boolean would say the same thing more honestly — but it is harmless and useful under
    a debugger. `BaseLayer`'s copy is never read at all (promotion only ever tests a
    transaction layer), and exists to satisfy the interface.
*   `manager.ts` is 3,891 lines (`wc -l`), up from the 3,589 recorded when
    `debt-memory-table-manager-file-too-large` was filed. That backlog ticket already owns
    the site; no second ticket filed.

### No new tickets

Nothing found in this pass was major: every defect was a dead branch, a missing test, or a
doc that had not caught up, all fixed here. The two genuinely conditional concerns are
parked as tripwires above, and the one open architectural residual is already documented at
its code site.
