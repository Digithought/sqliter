description: A query asking for a table's last-saved view used to run on the very same table handle a writer was saving through, so it could see half a save. Those reads now get their own handle.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/module-capabilities.md, docs/architecture.md, docs/design-isolation-layer.md, docs/module-authoring.md, docs/store.md, docs/usage.md
----

# Committed reads under the isolation wrapper get a dedicated underlying handle

## What shipped

`IsolationModule` memoized ONE underlying `VirtualTable` per `(schema, table)` and
re-served it to every connect, whatever the options. A `committed.<table>` read
therefore ran on the *writer's* handle, and `commitConnectionOverlays` flushes staged
rows through that handle in two phases (Phase 1 begins the underlying and applies row
by row; Phase 2 commits) — so a read landing between the phases saw a half-applied
batch, even over a memory underlying whose own commit is atomic.

- **`IsolationModule.connect`** (`isolation-module.ts:795`) routes a `_readCommitted`
  connect into a private `connectCommitted(...)` (`isolation-module.ts:869`) that opens
  its own `underlying.connect(...)` handle and returns an `IsolatedTable(..., true)`.
  That path never reads and never writes `underlyingTables`. Not memoized either — a
  `_readCommitted` `MemoryTable` pins its read layer at the first scan pull, so a cached
  handle would serve the same committed state forever and hold the layer chain against
  collapse.
- **`IsolatedTable.disconnect`** (`isolated-table.ts:1978`) was a no-op; it now
  disconnects the underlying handle when and only when `this.readCommitted`. Required on
  the memory path — `MemoryTable.disconnect` is what releases the pinned read layer's
  collapse protection.
- **`IsolatedTable.createConnection`** (`isolated-table.ts:365`) throws
  `QuereusError`/`MISUSE` on a committed instance ("a `_readCommitted` connection must not
  join the writer's transaction"). Latent path — the committed `query` fast path returns
  before `ensureConnection`.
- **`IsolationModule.readCommittedSnapshot`** (`isolation-module.ts:305`) — hard `false`
  replaced by a getter mirroring `this.underlying.readCommittedSnapshot === true`. The
  overlay deliberately does not enter the expression (committed reads bypass it), unlike
  `concurrencyMode`, which is weaker-of.

Docs: `docs/module-capabilities.md`, `docs/architecture.md`,
`docs/design-isolation-layer.md` (new sub-section under *Read Operations*),
`docs/module-authoring.md` § 4, plus — added during review — `docs/store.md` and
`docs/usage.md`.

## Validation

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` | green — 8750 `packages/quereus`, 386 `quereus-isolation`, 1375 store, 725 sync, rest as usual; 0 failing |
| `yarn test:store` | 8742 passing, 21 pending, 0 failing (~3m) |
| `yarn typecheck` | clean (the isolation package's `typecheck` covers its test files) |
| `yarn lint` | clean |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Review findings

### Verified independently (not taken from the handoff)

- **The fix's tests really discriminate.** Emulated the pre-fix behaviour (committed
  branch short-circuited off, `readCommitted` threaded back into the memoized path) and
  re-ran the isolation suite: 4 cases fail — the mid-flush read returns 3 rows instead of
  2, the committed connect returns the writer handle, the committed connect installs a
  memo, and the pinned manager connection is not released. Reverted afterwards; tree
  restored.
- **The handoff's honest gap is accurate.** With the branch disabled, the conformance
  case still passes. `installCommitStall` wraps `VirtualTableConnection.commit` and parks
  at its **entry**, which for the wrapper is upstream of the whole Phase-1/Phase-2 apply,
  so the reader never overlaps the wrapper's own publish window. The load-bearing guard is
  the explicit tear test, which drives Phase 1 by hand.
- **Handle lifecycle is closed, including on the path this change newly enables.**
  `runtime/emit/scan.ts` caches the connected instance per scan site in
  `RuntimeContext.scanConnections`; `core/statement.ts:409-421` disconnects each exactly
  once in the execution `finally` (normal completion, break, error, abort). The mutex-free
  concurrent read routes through that same function, so a committed handle is released per
  statement rather than leaked. A scan with no cache (transient contexts) owns and
  disconnects its own instance in the generator's `finally`.
- **Writes cannot reach a committed instance.** `IsolatedTable.update` has no
  `readCommitted` guard and would stage into the overlay if called — but
  `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt` each refuse a `committed.`
  target at plan time (`Cannot modify committed-state table …`), so it is unreachable. No
  ticket.
- **`query` is the only read entry.** `IsolatedTable` implements neither `executePlan`
  nor `supports`, so the other `_readCommitted` connect site
  (`runtime/emit/remote-query.ts`) cannot reach the wrapper. Its fast path covers
  `readCommitted` correctly.

### Fixed in this pass (minor)

- **`docs/store.md` claimed the wrapper "declines the flag on its own account too".**
  False after this change. Rewritten to say the wrapper mirrors, and that mirroring
  `false` over a store is caused by the store's own shared-cached-handle behaviour.
- **`packages/quereus-store/test/isolated-store.spec.ts:193` carried the same dead
  reason** in its comment. Rewritten; the assertion itself was and remains correct — it
  is now the case that keeps the mirror honest. This file was outside the implement
  stage's `files:` list and was not checked there.
- **The exclusive-ownership claim was wrong in tree.** `IsolatedTable.disconnect`'s
  comment said "nothing else holds a reference to it". `StoreModule.connect`
  (`store-module.ts:382`) re-serves a cached `StoreTable` on a map hit, so over a store
  the "dedicated" handle *is* the writer's object and `disconnect()` now lands on a shared
  instance. That is safe only because `VirtualTable.disconnect` is contracted
  per-statement (`StoreTable.disconnect` merely flushes stats, and the unwrapped store
  path already gets one per scan) — not because the wrapper owns the object. Comments
  corrected at both sites (`isolated-table.ts` and `connectCommitted`).
- **`docs/usage.md` eligibility list omitted the wrapper** — it read as if only the
  in-memory module qualifies, when a wrapped qualifying module now does too. Clause added.
- **`docs/module-authoring.md` § conformance harness had no gate-placement caveat.** The
  implementer parked that limitation as a `NOTE:` in the spec file only, but the doc is
  what module authors read and it presents the harness as proof of the guarantee. Added a
  paragraph: the stall parks at commit *entry*, so a module that publishes in phases after
  `commit()` is entered has its own publish window downstream of the gate and a torn read
  there is invisible; keep a direct phase-driving test and treat a pass as a smoke test.

### Test gaps closed

Both added to `describe('readCommittedSnapshot')` in `isolation-layer.spec.ts`:

- *"a writer instance disconnect leaves the shared underlying handle alone"* — the other
  half of the disconnect rule, which nothing pinned. Confirmed discriminating: making
  `disconnect` unconditional fails it. Without this, a dropped `readCommitted` check would
  release the shared handle out from under every connection on the table.
- *"over an underlying that re-serves one cached handle, the mirror stays false and
  disconnect lands once"* — the store shape reproduced inside the isolation package (no
  store dependency): a stub whose `create` seeds and whose `connect` re-serves one table
  per key. Asserts the mirror stays `false`, that the handle really is the writer's
  object, that disconnect lands exactly once, and that the shared handle is still writable
  afterwards.

### Tripwires (recorded, not filed)

- **Destructive-`disconnect` underlyings.** Parked as a `NOTE:` on
  `IsolatedTable.disconnect`: symmetry (one connect, one disconnect) does not imply
  exclusive ownership, so a wrapper author copying this pattern over an underlying whose
  `disconnect` tears down rather than being per-statement would kill the writer's handle.
  Fine today — no in-tree underlying does that.
- **Per-committed-read `underlying.connect` cost** for an out-of-tree underlying with an
  expensive `connect`. Already documented at `connectCommitted` by the implementer;
  accepted as the price of not freezing the snapshot.

### Not filed, with reasons

- **No major findings.** Every defect found was a stale or over-strong statement in a
  comment or doc, or a missing test — all fixed here. The mechanism itself (dedicated
  handle, no memo, release on disconnect, mirrored declaration) held up under the
  reachability checks above.
- **`isolation-layer.spec.ts` is 7284 lines** (`wc -l`, after this pass; 7187 before).
  Large and growing, but pre-existing debt untouched in shape by this change, and
  splitting it is not this ticket's site. Noted, not filed.
