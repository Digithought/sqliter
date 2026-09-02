# Committed-Snapshot Reads (`_readCommitted`)

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

The `readCommittedSnapshot` declaration a module makes when it can serve a consistent committed state to a read running concurrently with another connection's commit: the obligation that declaration takes on, the two implementation shapes that meet it, the consequences a wrapper module has to honor, and the conformance harness that proves it. A satellite of [Virtual Table Module Authoring Guide](module-authoring.md).

## The declaration and its obligation

A table reference qualified `committed.<table>` (and, in future, a statement the
engine elects to run outside the execution mutex) opens the module with the
`_readCommitted` connect option. On its own that option means only *"do not show
me the writer's staged rows"* — a weak promise several modules already implement.

`readCommittedSnapshot` is the separate, default-off declaration that the module
can meet the **stronger** promise the engine needs before it runs such a read
*concurrently* with another connection's commit:

```typescript
interface VirtualTableModule {
  readonly readCommittedSnapshot?: boolean;   // default false
}
```

**The obligation you take on by declaring it:**

> A connection opened with `_readCommitted` must serve a state that is consistent
> as of some commit boundary at or before the moment the read began, and must keep
> serving that same state for the life of the scan — including across another
> connection's commit landing mid-iteration, including across concurrent DDL on
> that table, and including across index-driven access paths (an index-driven plan
> and a full scan of the same connection must agree).
>
> **And it may be no *older* than that boundary.** The state is pinned for the life
> of **one scan**, not for the life of a connection, a table, or a process: a
> committed read that *begins* after a commit has landed must observe that commit.
> Equivalently — a `_readCommitted` read may never be staler than an ordinary read
> of the same module taken at the same instant. Holding one state across a scan is
> the obligation; holding it across scans is a defect.

The freshness bound is the half that is easy to miss, because "at or before the
moment the read began" is an upper bound only, and a module that captures one
snapshot and serves it unchanged forever satisfies that clause literally. It is
also the half a module is most likely to break by accident, since the natural way
to implement the upper bound — capture a handle, serve from it — becomes a
violation the moment that handle is cached beyond the scan that opened it. Both
halves are checked by the conformance harness below.

Why the bar is that high: once reads overlap commits, *"read the committed store
directly"* and *"read a consistent committed state"* stop being the same
statement. A module whose commit publishes its new state in steps — per column,
per index, per chunk, or by mutating live structures in place rather than
swapping one root at the end — lets a concurrent reader observe a half-applied
commit: a row present in one column's structure and absent in another (a torn row
on `select *`); base rows applied while the matching secondary-index entries are
not, so an index-driven plan returns fewer rows than a full scan of the same
nominal snapshot; or, for a module that splits one logical write into several
atomic units, a partially applied write.

**Two acceptable implementation shapes:**

1. **Pin at scan start** — capture an immutable snapshot when the connection is
   opened (or when `query()` is entered) and iterate only that.
2. **Publish atomically at end of commit** — make the committed state visible via
   a single swap, so a live read can never observe a partial one.

A module that can do neither must leave the flag off. **Leaving it off is not a
defect** — reads against that module simply keep taking today's serialized path.

**Three consequences you will not infer from the sentence above:**

- **A `_readCommitted` connection must not join the writer's transaction.** Do
  not hand it to `Database.registerConnection`; it must never receive
  `begin` / `commit` / `rollback` / savepoint broadcasts, and disconnecting it
  must not tear down per-database state the writer still owns. Modules that key
  transaction state by `Database` rather than by connection are the exposed case:
  a committed-read connection landing in that map would drive the *writer's*
  transaction. (The engine cannot detect this from the declaration alone — it is
  on the module.)
- **Temporal / change-stream scopes.** If your module offers a point-in-time or
  change-stream read scope whose interaction with `_readCommitted` is undefined,
  leave the flag off. The engine has no table-level temporal qualifier today, so
  it cannot arbitrate precedence for you.
- **Degraded state is the module's problem.** If the module can enter a state
  where it cannot serve a coherent committed snapshot (e.g. a commit that failed
  between its durable log append and its projection apply), it must throw from
  `connect` or from the first `query()` pull rather than answer. The engine adds
  no mid-flight "reads are unsafe" signal.

**Orthogonal to [`concurrencyMode`](module-authoring.md#3-concurrency-mode-parallel-runtime).** That
enum answers *"may the runtime issue concurrent calls on **one** connection?"* A
committed read opens its **own separate** connection, so intra-connection
reentrancy is not what is at stake — what is, is whether the module's shared,
cross-connection state tears while a commit publishes. The two do not imply each
other in either direction: the memory vtab is `'reentrant-reads'` *and*
snapshot-safe, while a hypothetical `'fully-reentrant'` module could still publish
its commits incrementally. Reusing the enum would silently over-promise.

The engine-side reader is `getModuleReadCommittedSnapshot`, which fails closed:

```typescript
import { getModuleReadCommittedSnapshot } from '@quereus/quereus';

if (getModuleReadCommittedSnapshot(module)) {
  // may open a `_readCommitted` connection and read it without the exec mutex
}
```

**In-tree declarations.** The memory vtab declares `true`: layers are immutable
BTrees, a commit publishes by a single pointer assignment to the current
committed layer, a `_readCommitted` connect makes a fresh *unregistered*
connection whose read layer is pinned when the scan first pulls, and the scan
captures that layer's BTree object at scan start — so a concurrent DDL rebuild
(which replaces tree objects wholesale) leaves the in-flight walk on a *stale but
coherent* snapshot, which is the documented semantics rather than corruption.

Both wrappers decline. `StoreModule` declares `false`: its `connect` returns a
shared cached table per table key — dropping the `_readCommitted` option — and
its `query` merges the coordinator's pending-op view over the committed store, so
a read taken during a commit flush sees a partially applied batch. The platform
plugins (leveldb, indexeddb, nativescript-sqlite, react-native-leveldb) wrap
`StoreModule`, so they inherit `false`. `IsolationModule` **mirrors its
underlying**, and how it earns that is the instructive part: skipping the overlay
is not sufficient. It memoizes one underlying `VirtualTable` per (schema, table)
for writers, and re-serving that handle to a committed read put the read on the
*writer's* handle while `commitConnectionOverlays` flushed staged rows through it
incrementally — a half-applied flush observable even over a memory underlying
whose own commit is atomic. It therefore opens a **dedicated** `_readCommitted`
underlying handle per committed read (unmemoized, released on `disconnect`) and
refuses `createConnection` on such an instance. **A wrapper is only as
snapshot-safe as its own commit path** — and never more than the module beneath
it, which is why the mirror stops at `false` over an underlying that ignores
`_readCommitted`.

**If you write a wrapper module that memoizes one underlying handle per table**,
this is the rule to copy: open a **separate** underlying handle for a
`_readCommitted` connect rather than re-serving the writer's, or you silently
degrade a snapshot-safe underlying to a tearing one. Do not cache that handle for
the table's lifetime either — an underlying that pins its snapshot at first pull
would then serve the same, ever-staler state forever, which is the freshness bound
in [the obligation](#the-declaration-and-its-obligation) broken by caching rather
than by tearing.

## Proving it: the conformance harness

The obligation above is prose; `runCommittedReadConformance` is the runnable form
of it. It ships from the package root so an out-of-tree module can run it against
its own table, and it is framework-agnostic — it throws a descriptive `Error` on
failure and returns a result object on success, so it drops into Mocha, Vitest,
or a plain script with no assertion library.

```typescript
import { Database, installCommitStall, runCommittedReadConformance } from '@quereus/quereus';

const db = new Database();
// `installCommitStall` patches the database so the next commit parks until you
// release it. It works for any module that registers its write connections with
// `Database.registerConnection`; supply your own `stallCommit` if yours does not.
// TEST SUPPORT ONLY — the patch is permanent for the life of `db`.
const stall = installCommitStall(db);

db.registerModule('mymod', new MyModule());
await db.exec('create table conf (id integer primary key, v text) using mymod');

const result = await runCommittedReadConformance({
  db,
  table: 'conf',          // must be EMPTY on entry — the harness owns its contents
  keyColumn: 'id',        // integer primary key
  valueColumn: 'v',       // a text column the writer rewrites
  stallCommit: () => stall.asStallCommit(),
});
```

What it does, in order:

1. **Refuses** unless the table's module declares `readCommittedSnapshot` — the
   harness only applies to modules claiming the guarantee, and a confusing
   assertion failure is a poor way to say "you never opted in".
2. Seeds `rowCount` rows (default 200) and commits.
3. Starts an **unawaited** writer that rewrites *every* seeded row's value **and**
   appends new rows in one statement, so a torn publish shows up both as a mix of
   old and new values and as a longer result set. `stallCommit` parks it
   mid-commit.
4. While it is parked, runs two reads with `readConcurrency: 'committed'` — a full
   scan and an index-driven path over `keyColumn`. The index leg is only run if
   the plan really contains a seek; otherwise it is **skipped with a reason** in
   the result rather than silently rerun as a second full scan.
5. Asserts both reads return exactly the seeded snapshot, that every value column
   holds its pre-write value, and that the two legs agree row-for-row. Any
   divergence is reported with the specific rows that differed. *Without* a
   provable park the bar necessarily drops: each read must equal ONE whole state
   (pre- or post-write) — a mix is still a failure, but a writer that committed
   before the read began is not — and the two legs are not compared, since they
   may legitimately straddle the commit.
6. Releases the stall, awaits the writer, and asserts a fresh read now sees the
   post-write state — the freshness bound. Both paths are checked: an ordinary
   read (which catches a module that is stale on *every* path) and then a
   `readConcurrency: 'committed'` read compared against it (which catches the
   subtler module that pins only its `_readCommitted` connections while ordinary
   reads refresh normally — the shape a module takes when its committed handle is
   a cached pre-transaction object it never re-fetches). Finally it deletes the
   rows it wrote.

**Read `observedCommitOverlap` before believing a pass.** It is `true` only when a
`stallCommit` was supplied *and* the writer stayed parked for the whole of both
reads. `false` means "no evidence the read overlapped a commit" — **not**
"conformant". Without a stall, a module that commits in one synchronous step may
leave no window to observe at all.

```typescript
if (!result.observedCommitOverlap) {
  throw new Error('no commit overlap observed — supply a stallCommit for a meaningful run');
}
if (result.indexDrivenSkippedReason) {
  console.warn(`index-driven leg not covered: ${result.indexDrivenSkippedReason}`);
}
```

**Where the gate parks bounds what the harness can catch.** `installCommitStall`
wraps each registered `VirtualTableConnection.commit` and parks at its **entry**, so
the observed window is "before the module's commit begins", not "inside it". A module
that publishes in one step is fully covered. A module that publishes in *phases* after
`commit()` is entered — `IsolationModule` applies its overlay row-by-row into the
underlying, then commits — has its own publish window entirely downstream of the gate,
so a torn read there is invisible to the harness and it still passes. Verified in tree:
disabling the wrapper's dedicated-handle branch does not fail
`runCommittedReadConformance`. If you own such a module, keep a direct test that drives
your phases by hand (the isolation package's mid-flush tear test does), and treat a
harness pass as a full-stack smoke test rather than proof. Closing the gap needs a
stall that parks *inside* the module's commit, which `installCommitStall` cannot reach.
