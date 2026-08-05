description: When a table uses the transaction-isolation wrapper, a query asking for the table's last-saved view is served by the very same table handle the writer is saving through, so while a save is in progress that query can see half of it. Give those reads their own handle.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/module-authoring.md, docs/module-capabilities.md
difficulty: medium
repro: verified
----

# `committed.<table>` under the isolation wrapper runs on the writer's handle

## What the qualifier promises

`committed.<table>` opens the module with the `_readCommitted` connect option.
Today that promise is narrow — "do not show me the writer's staged rows" — and
the isolation wrapper keeps it: staged rows live in the per-connection overlay,
and `IsolatedTable.query` skips the overlay when the table is a committed read.

The promise the engine's new `readCommittedSnapshot` declaration needs is
stronger: the read must serve a state consistent as of *some* commit boundary and
keep serving that same state for the life of the scan, including while another
connection's commit lands. The wrapper cannot meet that today.

## Why not

`IsolationModule.connect` (`isolation-module.ts` ~line 794) memoizes **one**
underlying `VirtualTable` per `(schema, table)` in `underlyingTables` and
re-serves that handle to every subsequent connect. Two consequences fall out of
that single site:

**Arm 1 — the committed read tears mid-flush (verified).** The `_readCommitted`
option only reaches the underlying module on the *first* connect for a table, so
a later committed read gets the writer's handle back. `IsolatedTable.query`
delegates straight to it. Meanwhile `commitConnectionOverlays` flushes staged
rows through that same handle **incrementally** — Phase 1 begins the underlying
and applies row by row, Phase 2 commits — so a read landing between the phases
sees a half-applied batch. This holds even over the in-memory table, whose own
commit publishes atomically: the atomicity is defeated one level up.

Observed directly (mocha, `packages/quereus-isolation`): with an isolation module
over `MemoryTableModule` and a table holding two rows, opening a
`_readCommitted` table, then calling `begin()` + one `update()` on the memoized
underlying handle (standing in for Phase 1), a full scan of the committed reader
returned **three** rows including the uncommitted one. The equivalent check
against `MemoryTableModule` directly returns the pre-commit set, so the wrapper
is where it is lost.

**Arm 2 — a committed read arriving first sticks the option (static, unverified).**
If the first connect for a table is the committed one, the memoized handle is
built *with* `_readCommitted`, and every later reader and **writer** for that
table is then served a committed-snapshot underlying — whose `update()` throws
`Cannot modify committed-state snapshot`. Within a session the cache is normally
warmed by `xCreate` before any read, so this needs the handle to be evicted first
(`destroy`, `renameTable`, or one of the three attach seams around
`isolation-module.ts` line 208) and the next connect to be a committed read. Not
reproduced; it falls out of the same site and should be closed by the same fix.
Confirming it needs a test that evicts the memoized state and then issues
`select ... from committed.<table>` before any other access.

## Expected behaviour

A committed read through the wrapper serves a state consistent as of a commit
boundary at or before the read, unaffected by any overlay flush that overlaps it,
and never changes what a normal read or write of the same table is served.

Once that holds, `IsolationModule.readCommittedSnapshot` becomes the underlying's
value rather than a hard `false` (`isolation-module.ts` ~line 283), the wrapper
case in the committed-read conformance suite flips from "must refuse" to "must
pass" (`tickets/implement/3-concurrent-reads-conformance`), and the mid-flush
tearing test in `isolation-layer.spec.ts` ("a committed read shares the writer
underlying handle, so a mid-flush read tears") inverts to assert the pre-flush row
set.

## Shape of the problem, not the solution

The obvious direction is a second memoized handle per table — a committed-read
handle opened with `_readCommitted` alongside the writer handle — but it inherits
the writer handle's whole lifecycle surface, and that is where the work is rather
than in the connect itself:

- every seam that evicts `underlyingTables` (`destroy`, `renameTable`, the three
  attach seams) must evict both, and `disconnect` both;
- an underlying that ignores `_readCommitted` (the store stack) would hand back a
  handle indistinguishable from the writer's — the wrapper must not then claim to
  be snapshot-safe, so the declaration stays a function of the underlying;
- the extra handle costs a live connection per table for the whole table
  lifetime, which for the memory vtab pins a layer chain against collapse — so it
  likely wants to be opened per committed read and released with it, not
  memoized, which trades the cost for a per-read connect.

Whether the handle is memoized or per-read is the decision to settle first, with
a measurement of the per-read connect cost against the pinned-layer cost.

## Not this ticket

`backlog/feat-store-committed-snapshot-reads` covers the *store* stack's own
inability to serve a snapshot, and lists this file because the wrapper sits above
it. The two are independent: this ticket makes the wrapper stop degrading a
snapshot-safe underlying; that one makes a store-backed underlying snapshot-safe
in the first place. Neither subsumes the other.
