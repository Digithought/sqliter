description: When a table uses the transaction-isolation wrapper, a query asking for the table's last-saved view is served by the very same table handle the writer is saving through, so while a save is in progress that query can see half of it. Give those reads their own handle.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/module-capabilities.md, docs/architecture.md, docs/design-isolation-layer.md
difficulty: medium
repro: verified
----

# `committed.<table>` under the isolation wrapper runs on the writer's handle

## The defect

`IsolationModule.connect` (`isolation-module.ts` ~line 800) memoizes **one**
underlying `VirtualTable` per `(schema, table)` in `underlyingTables` and
re-serves that handle to every subsequent connect, whatever the connect options.
Two consequences fall out of that one site:

**Arm 1 — the committed read tears mid-flush (verified).** The `_readCommitted`
connect option only reaches the underlying module on the *first* connect for a
table, so a later committed read gets the writer's handle back and
`IsolatedTable.query` delegates straight to it. Meanwhile
`commitConnectionOverlays` flushes staged rows through that same handle
**incrementally** — Phase 1 begins the underlying and applies row by row, Phase 2
commits — so a read landing between the phases sees a half-applied batch. This
holds even over the in-memory table, whose own commit publishes atomically: the
atomicity is defeated one level up.

Executable in-tree today:
`packages/quereus-isolation/test/isolation-layer.spec.ts` → `readCommittedSnapshot`
→ *"a committed read shares the writer underlying handle, so a mid-flush read
tears"*. It opens a `_readCommitted` table over an isolation-wrapped
`MemoryTableModule` holding two rows, stands in for Phase 1 (`begin()` + one
`update()` on the memoized handle), and asserts the committed reader returns
**three** rows. Confirmed passing (i.e. bug present) at `d99425b7`.

**Arm 2 — a committed read arriving first sticks the option (static).** If the
first connect for a table is the committed one, the memoized handle is built
*with* `_readCommitted`, and every later reader **and writer** is then served a
committed-snapshot underlying — whose `update()` throws `Cannot modify
committed-state snapshot`. Reaching it needs the memoized handle evicted first
(`destroy`, `renameTable`, or one of the three attach seams around
`isolation-module.ts` line 208) and the next connect to be a committed read. Not
reproduced; it falls out of the same site and the fix below closes it by
construction (the committed path stops reading *and* stops writing the memo).

## The decision the fix ticket left open, now settled

The fix ticket asked whether the committed-read handle should be **memoized
alongside** the writer handle or **opened per committed read**. Answer:
**per read.** Memoization is ruled out by a correctness fact, not by cost.

**Memoization would freeze the snapshot forever.** A `_readCommitted`
`MemoryTable` creates its manager connection once, lazily, on the first scan pull
(`packages/quereus/src/vtab/memory/table.ts` — `ensureConnection`, the
`this.readCommitted` arm) and every later `query()` on that instance reads
`conn.readLayer`, the layer pinned at that moment. That is exactly the property
`MemoryTableModule.readCommittedSnapshot`'s audit point 2 relies on for
scan-to-scan agreement — but it means a handle memoized for the table's lifetime
serves the *same* committed state forever, going arbitrarily stale, and holds the
layer chain against collapse for as long as the table exists
(`MemoryTableManager.isLayerInUse` walks the connection's `readLayer` chain).
A stale-forever committed read is a worse bug than the one being fixed.

**The per-read connect is not a real cost.** Measured by reading both in-tree
underlyings' `connect`:

- `MemoryTableModule.connect` (`memory/module.ts` ~line 307) is a map lookup plus
  `new MemoryTable(...)`; the manager connection and the layer pin happen later,
  at the first scan pull, and are released at `disconnect()`.
- `StoreModule.connect` (`quereus-store/src/common/store-module.ts` ~line 382)
  returns its own memoized `StoreTable` on a `this.tables` map hit before doing
  any work at all.

Neither performs I/O per committed read. (An out-of-tree underlying with an
expensive `connect` pays it per committed read — acceptable, and the alternative
is the frozen snapshot above.)

**Per-read also erases the lifecycle surface** the fix ticket worried about:
nothing new lands in `underlyingTables`, so `destroy`, `renameTable` and the three
attach seams need no second eviction and stay exactly as they are.

## Shape of the change

Three edits, all small:

1. **`IsolationModule.connect`** — when `options._readCommitted === true`, open a
   dedicated underlying handle and return immediately, never touching
   `underlyingTables` in either direction:

   ```typescript
   if (readCommitted) {
     const committedUnderlying = await this.underlying.connect(
       db, pAux, moduleName, schemaName, tableName, options, tableSchema);
     return new IsolatedTable(db, this, schemaName, tableName, committedUnderlying, true);
   }
   ```

   The non-committed path below keeps the memo and passes `false`.

2. **`IsolatedTable.disconnect`** (`isolated-table.ts` ~line 1949, a no-op today)
   — disconnect the handle this wrapper opened, and only that one:

   ```typescript
   if (this.readCommitted) await this.underlyingTable.disconnect?.();
   ```

   Required on the memory path: `MemoryTable.disconnect` is what releases the
   pinned read layer's collapse protection (see its own NOTE at `table.ts` ~line
   415), and without it every committed read leaks a pinned layer chain. Safe on
   the store path: `StoreTable.disconnect`
   (`quereus-store/src/common/store-table-base.ts` ~line 946) is the documented
   per-scan no-op that only flushes stats — the engine already calls it after
   every scan. Symmetric by contract: the wrapper connected the handle, so the
   wrapper disconnects it; the shared writer handle stays untouched.

3. **`IsolationModule.readCommittedSnapshot`** (~line 283) — becomes a getter
   over the underlying instead of a hard `false`:

   ```typescript
   get readCommittedSnapshot(): boolean {
     return this.underlying.readCommittedSnapshot === true;
   }
   ```

   It stays a function of the underlying because an underlying that *ignores*
   `_readCommitted` (the store stack — its `connect` re-serves one cached table
   per key) hands back a handle indistinguishable from the writer's, and the
   wrapper must not claim snapshot safety it cannot deliver. Making `store`
   itself snapshot-safe is `backlog/feat-store-committed-snapshot-reads` — a
   separate, independent ticket; do not fold it in here.

   Note the overlay module does **not** enter this expression: committed reads
   bypass the overlay entirely (`IsolatedTable.query`'s fast path), so the
   overlay's own snapshot behaviour is irrelevant. This is deliberately unlike
   `concurrencyMode`, which is the weaker-of because merged reads touch both.

### Prototype result (de-risking, not landed)

All three edits were applied together and the whole workspace test suite run:
`yarn test` → green across every package (8750 `packages/quereus`, 380
`quereus-isolation`, plus the rest). The tearing test flipped from 3 rows to 2,
and — the load-bearing result — the **committed-read conformance harness passed
in full** against the wrapper: `observedCommitOverlap === true` and
`fullScanRows === 20`. The prototype was then reverted; the working tree is
unchanged. Treat this as evidence the direction works, not as finished work: it
did not add the new tests below, did not touch docs, and ran only the
memory-backed suite (`yarn test:store` still needs a pass).

## What the tests must say afterwards

In `packages/quereus-isolation/test/isolation-layer.spec.ts`, `describe('readCommittedSnapshot')`:

- `ISOLATION_SERVES_COMMITTED_SNAPSHOT` (~line 4409) flips to `true`. It gates an
  "asserts a pass" branch that has never executed; flipping it turns the
  conformance case into a full `runCommittedReadConformance` pass. Rename the
  enclosing `it(...)` — "the conformance harness refuses the wrapper today" stops
  being what it tests. Consider dropping the constant entirely once the pass
  branch is the only one, rather than leaving a dead `else`.
- *"a committed read shares the writer underlying handle, so a mid-flush read
  tears"* inverts: same setup, now asserting the **pre-flush** row set (2 rows,
  not 3). Rename it and rewrite its comment — it becomes the regression guard for
  this fix.
- *"is false even over a snapshot-safe underlying"* becomes "mirrors the
  underlying": `true` over `MemoryTableModule` and over `snapshotStub(true)`.
  Keep the companion case asserting `false` over `snapshotStub()` /
  `snapshotStub(false)` — that arm is unchanged and is what keeps the store stack
  honest.

New coverage to add:

- **Arm 2 regression.** Evict the memoized state (drop and recreate the table, or
  call `renameTable`), then issue a committed read as the *first* access, then a
  normal write. Today the write throws `Cannot modify committed-state snapshot`;
  afterwards it must succeed. This is the arm that was never reproduced — if it
  turns out not to reproduce even before the fix, say so in the review handoff
  rather than deleting the test.
- **Handle distinctness.** A committed connect must not return, and must not
  install, the memoized writer handle: assert the committed `IsolatedTable`'s
  underlying is a different object from `getUnderlyingState(...)!.underlyingTable`
  (over `MemoryTableModule`), and that a committed connect against a table with
  no memoized state leaves `getUnderlyingState(...)` still `undefined`.
- **Handle release.** After `IsolatedTable.disconnect()` on a committed instance,
  the underlying memory table's manager connection is gone — assert via the
  manager's connection count, so the pinned-layer leak has a guard.

## Loose end to close while you are in here

`IsolatedTable.createConnection()` (~line 358) builds an `IsolatedConnection`
wrapping `this.underlyingTable.createConnection?.()` with no regard for
`readCommitted`. If it were ever called on a committed instance, that connection
could be registered and would then receive begin/commit/rollback broadcasts —
precisely what `docs/module-authoring.md` § "Committed-Snapshot Reads
(`_readCommitted`)" forbids ("a `_readCommitted` connection must not join the
writer's transaction"). Nothing reaches it today (the committed `query` path
returns before `ensureConnection`), so this is latent rather than live — but it is
one line to close and the dedicated handle makes it newly relevant. Throw from
`createConnection` on a committed instance, with a test.

## Docs to update alongside

- `docs/module-capabilities.md` line 52 — the `readCommittedSnapshot` row's
  isolation-module cell currently reads "`false` **regardless of underlying** —
  one memoized underlying handle per table is re-served to committed reads, and
  the overlay flush applies through it incrementally". Replace with the new rule:
  mirrors the underlying, because committed reads get their own `_readCommitted`
  handle and bypass the overlay.
- `docs/architecture.md` line 199 — "memory vtab declares it, store/isolation
  decline" becomes "memory vtab declares it, the isolation wrapper mirrors its
  underlying, store declines".
- `docs/design-isolation-layer.md` — add the dedicated committed-read handle to
  the read-path description (the existing committed-read mentions are around
  lines 218 and 929): committed reads do not share the writer's underlying
  handle, are not memoized, and are released on `disconnect`.
- `docs/module-authoring.md` § "Committed-Snapshot Reads (`_readCommitted`)"
  already tells module authors a committed read "opens its **own separate**
  connection". Worth one added sentence aimed at *wrapper* modules specifically:
  a wrapper that memoizes one underlying handle per table must open a separate
  one for a committed read rather than re-serving the writer's, or it silently
  degrades a snapshot-safe underlying.
- `docs/usage.md` line 238 says store-backed modules do not qualify — still true,
  leave it.

## TODO

- Add the committed-read branch to `IsolationModule.connect`: open a dedicated
  underlying handle via `this.underlying.connect(...)` with the caller's
  `options` (already carrying `_readCommitted`), return an `IsolatedTable`
  constructed with `readCommitted = true`, and never read or write
  `underlyingTables` on that path. Document *why* it is not memoized (frozen
  snapshot + pinned layer chain) at the site.
- Make `IsolatedTable.disconnect()` disconnect the underlying handle when
  `this.readCommitted`, leaving the shared writer handle untouched. Document why
  it is safe and why it is required (memory's pinned read layer).
- Turn `IsolationModule.readCommittedSnapshot` into a getter over
  `this.underlying.readCommittedSnapshot`; rewrite its doc comment, which
  currently explains at length why the wrapper declines and points at this
  ticket.
- Guard `IsolatedTable.createConnection()` against being called on a committed
  instance (throw), per the "must not join the writer's transaction" obligation.
- Flip `ISOLATION_SERVES_COMMITTED_SNAPSHOT` to `true` and rename/retitle the two
  cases that encoded the bug as expected behaviour; invert the tearing test to
  assert the pre-flush row set.
- Add the new tests: arm-2 regression (committed read as first access after
  eviction, then a write), handle distinctness (not the memoized handle, and does
  not install one), handle release after `disconnect`.
- Update `docs/module-capabilities.md`, `docs/architecture.md`,
  `docs/design-isolation-layer.md`, and the wrapper sentence in
  `docs/module-authoring.md`.
- Validate: `yarn test` (memory-backed — the prototype's green run), then
  `yarn test:store`, which the prototype never exercised and which is the run
  that covers the store underlying declining the flag. Then `yarn lint` and
  `yarn typecheck`.
- In the review handoff, state plainly whether arm 2 reproduced before the fix,
  and whether `yarn test:store` was actually run to completion.
