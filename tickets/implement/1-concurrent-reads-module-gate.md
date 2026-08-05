description: Add a switch a virtual-table module uses to declare that it can serve a stable snapshot of already-committed data while another writer is committing, so a later change can safely let reads run alongside writes. Nothing changes behaviour yet — this only adds the declaration, turns it on for the in-memory table, and writes down what declaring it obliges a module to guarantee.
prereq:
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/src/common/store-module.ts, docs/module-authoring.md, docs/module-capabilities.md, packages/quereus/src/index.ts
difficulty: medium
----

# Committed-snapshot capability flag for virtual-table modules

## Why this exists

The engine is about to gain a path where a read-only statement runs **without**
the execution mutex, concurrently with another statement that is inside its
virtual-table commit (see the follow-on ticket `concurrent-reads-engine-path`).
That path serves each table's *last committed* state by opening the module with
the existing `_readCommitted` connect option.

Today `_readCommitted` means only **"do not show me the writer's staged rows"**.
That was sufficient because the exec mutex guarantees no read can ever overlap a
commit. Once reads overlap commits, "read the committed store directly" and
"read a *consistent* committed state" stop being the same statement. A module
whose commit publishes its new state in steps — per column, per index, per
chunk, or by mutating live structures in place rather than swapping one root at
the end — will let a concurrent reader observe a half-applied commit:

- a row present in one column's structure and absent in another (torn row on
  `select *`);
- base rows applied while the matching secondary/compound index entries are
  not, so an *index-driven* plan returns fewer rows than a full scan of the
  same nominal snapshot;
- for a module that deliberately splits one logical write into several atomic
  units, a partially-applied write.

At least two out-of-tree modules (the optimystic vtab and the Lamina vtab) already
implement `_readCommitted` under the weaker reading, so the concurrent path
**must not** assume any module that accepts the option can meet the stronger
one. This ticket adds the explicit, default-off declaration and states the
obligation in the module-authoring docs.

## The obligation being declared

> A connection opened with `_readCommitted` must serve a state that is
> consistent as of some commit boundary at or before the moment the read began,
> and must keep serving that same state for the life of the scan — including
> across another connection's commit landing mid-iteration, including across
> concurrent DDL on that table, and including across index-driven access paths
> (an index-driven plan and a full scan of the same connection must agree).

Two acceptable implementation shapes:

- **pin at scan start** — capture an immutable snapshot when the connection is
  opened (or when `query()` is entered) and iterate only that; or
- **publish atomically at end of commit** — make the committed state visible via
  a single swap so a live read can never observe a partial one.

A module that can do neither must leave the flag off. Leaving it off is not a
defect — it means reads against that module keep taking today's serialized path.

Two further consequences to state in the docs, because they are the parts a
module author will not infer:

- **A `_readCommitted` connection must not join the writer's transaction.** It
  must not be handed to `Database.registerConnection`, must never receive
  `begin` / `commit` / `rollback` / savepoint broadcasts, and its disconnect must
  not tear down per-database state the writer still owns. Modules that key their
  transaction state by `Database` rather than by connection are the exposed
  case: a committed-read connection landing in that map would drive the
  *writer's* transaction. The in-tree memory table already does this correctly —
  its `_readCommitted` branch in `MemoryTable.ensureConnection`
  (`vtab/memory/table.ts` ~line 78) creates an unregistered connection.
- **Temporal / change-stream scopes.** If a module offers a point-in-time or
  change-stream read scope whose interaction with `_readCommitted` is not
  defined, leave the flag off. The engine has no table-level temporal qualifier
  today, so it cannot arbitrate precedence for you.
- **Degraded state is the module's problem.** If a module can enter a state
  where it cannot serve a coherent committed snapshot (e.g. a commit that failed
  between its durable log append and its projection apply), it must throw from
  `connect` or from the first `query()` pull rather than answer. The engine adds
  no mid-flight "reads are unsafe" signal.

## Interface

`packages/quereus/src/vtab/module.ts`:

```ts
export interface VirtualTableModule<...> {
	/**
	 * Declares that a connection opened with `_readCommitted` serves a stable,
	 * self-consistent snapshot of committed state for the life of the scan —
	 * see docs/module-authoring.md § Committed-snapshot reads.
	 *
	 * Omit (default `false`) to decline the engine's concurrent committed-read
	 * path; reads against this module then keep taking the serialized path.
	 */
	readonly readCommittedSnapshot?: boolean;
}
```

`packages/quereus/src/vtab/concurrency.ts`:

```ts
export function getModuleReadCommittedSnapshot(module: AnyVirtualTableModule): boolean {
	return module.readCommittedSnapshot === true;
}
```

**This is deliberately not `VtabConcurrencyMode`.** That enum answers a
different question — "may the runtime issue concurrent calls on *one*
connection?" The concurrent committed-read path opens its own separate
connection, so intra-connection reentrancy is not what is at stake; what is at
stake is whether the module's *shared, cross-connection* state tears while a
commit publishes. The two are orthogonal: the memory vtab is
`'reentrant-reads'` and also snapshot-safe, but a hypothetical
`'fully-reentrant'` module could still publish commits incrementally. Reusing
the enum would silently over-promise.

`concurrencyMode` still needs to be *accurate* on the store stack, and it
already is: `StoreModule` omits it (⇒ `'serial'`), and `IsolationModule` computes
the weaker of underlying and overlay (`weakerMode`, `isolation-module.ts` ~line
259). No edit needed there — say so in the handoff so the reviewer does not go
looking for a missing change.

## Per-module declarations in this ticket

**Memory vtab (`vtab/memory/module.ts`) — `true`.** Record the audit as a code
comment next to the declaration, in the style of the existing `concurrencyMode`
/ `scanSnapshotIsolation` comments:

- layers are immutable BTrees; a commit publishes by a single pointer assignment
  to `_currentCommittedLayer` (`layer/manager.ts` ~lines 695, 1759, 3234, 3842),
  so a reader sees either the pre- or the post-commit root, never a mix;
- a `_readCommitted` connect creates a fresh **unregistered** manager connection
  (`table.ts` ~line 78) whose `readLayer` is pinned at connect time, and
  `query()` starts from `conn.readLayer` (`table.ts` ~line 266) rather than the
  pending layer;
- that connection *is* in the manager's `connections` map (`manager.connect()`,
  `layer/manager.ts` ~line 524), so layer collapse's in-use check keeps the
  pinned layer's ancestor chain alive; `MemoryTable.disconnect` releases it
  (`table.ts` ~line 416).

Verify each of those four points against the code before writing the comment;
if any no longer holds, the flag must not be set and the handoff must say why.
Pay particular attention to the collapse path — `layer/manager.ts` ~line 946
carries a comment about a case the in-use check "misses"; confirm whether that
case can strand a `_readCommitted` snapshot, and if it can, either fix it here
or leave the flag off and file a `fix/` ticket.

**Isolation wrapper (`quereus-isolation/src/isolation-module.ts`) — inherited.**
The `_readCommitted` path unconditionally bypasses the per-connection overlay
(`isolated-table.ts` ~line 405), so the wrapper contributes no tearing of its
own; it can only be as good as what it wraps:

```ts
get readCommittedSnapshot(): boolean {
	return this.underlying.readCommittedSnapshot === true;
}
```

Over the memory vtab this resolves to `true`; over `StoreModule` to `false`.
Mirror the getter style already used for `concurrencyMode` there (the getter
form is required by `exactOptionalPropertyTypes`, per the existing comment at
~line 257).

**`StoreModule` (`quereus-store/src/common/store-module.ts`) — explicit
`false`,** with a comment naming both reasons: `connect` returns a *shared*
cached `StoreTable` per table key (~line 378) so the `_readCommitted` option is
dropped entirely, and `StoreTable.query` merges the coordinator's pending-op
view over the committed store (read-your-own-writes — see the `getCapabilities`
doc comment ~line 124), so a read taken during a commit flush observes partially
applied ops. Declaring it explicitly rather than relying on the default keeps
the reason attached to the code.

The four platform plugins (leveldb, indexeddb, nativescript-sqlite,
react-native-leveldb) wrap `StoreModule` behind `IsolationModule`, so they
inherit `false` with no edit. Confirm that by reading their registration, and
say so in the handoff.

## Docs

- `docs/module-authoring.md` — new subsection **"Committed-snapshot reads
  (`_readCommitted`)"** next to § 3 *Concurrency Mode*. State the obligation
  verbatim from above, both acceptable implementation shapes, the
  do-not-register-the-connection rule, the temporal/change-stream and
  degraded-state rules, and that `readCommittedSnapshot` is orthogonal to
  `concurrencyMode` (with the reason). Write it as something an out-of-tree
  module author can implement against without reading engine source.
- `docs/module-capabilities.md` — add `readCommittedSnapshot` to the capability
  surface listing.
- Export the type/helper from `packages/quereus/src/index.ts` alongside
  `getModuleConcurrencyMode` / `VtabConcurrencyMode`.

## Edge cases & interactions

- **Flag defaults to absent.** Every existing in-tree and out-of-tree module
  must keep working untouched; nothing reads the flag yet in this ticket, so the
  whole change must be behaviour-neutral.
- **A module that sets the flag but registers its `_readCommitted` connection.**
  Not detectable from a declaration alone; the engine-side assertion lands in
  the follow-on ticket. Note the exposure in the docs.
- **`committed.<table>` references** already flow `_readCommitted` through
  `runtime/emit/scan.ts` (~line 105) for *every* module, flag or no flag. This
  ticket must not change which modules accept the option — only which ones
  advertise the stronger snapshot guarantee.
- **`exactOptionalPropertyTypes`** — the isolation wrapper's getter form exists
  precisely because of this; do not regress it to an optional property.
- **Memory layer collapse racing a pinned snapshot** — the audit item above.
  This is the one place where setting the flag could be *wrong* rather than
  merely conservative.

## Key tests

- `packages/quereus/test/vtab/concurrency-mode.spec.ts` (or a sibling): default
  is `false` for a module that omits the flag; `true` when declared.
- Memory-vtab snapshot coherence, driven directly through the module (no engine
  change needed): open a `_readCommitted` connection, start iterating, land a
  full commit on another connection mid-iteration, assert the iteration returns
  exactly the pre-commit row set and that a second `_readCommitted` connection
  opened after the commit sees the post-commit set.
- Same shape but with an index-driven access path on the pinned connection —
  assert the index-driven result equals the full-scan result for that snapshot.
- Isolation wrapper: `readCommittedSnapshot` is `true` over `MemoryTableModule`
  and `false` over a stub whose flag is absent.

## TODO

- Add `readCommittedSnapshot?: boolean` to `VirtualTableModule` with the
  obligation doc comment.
- Add `getModuleReadCommittedSnapshot` to `vtab/concurrency.ts`; export both
  from the package index.
- Audit the memory vtab against the four points above; declare `true` with the
  audit comment, or leave it off and file a `fix/` ticket explaining what broke.
- Add the inherited getter on `IsolationModule`.
- Declare explicit `false` on `StoreModule` with the two-reason comment.
- Confirm (and record in the handoff) that the four platform plugins inherit
  `false` through the isolation wrapper with no edit, and that `concurrencyMode`
  on the store stack is already accurate.
- Write the `docs/module-authoring.md` subsection and the
  `docs/module-capabilities.md` entry.
- Tests above.
- `yarn build`, `yarn lint`, `yarn test`.
