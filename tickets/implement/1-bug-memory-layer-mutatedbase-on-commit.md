---
description: Deleting a row from a table that other tables point at with "on delete cascade" can crash the commit with an internal error, and the same crash hits two write chains running at once on one database.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts (tryCollapseLayers, isLayerInUse, disconnect — the defect site)
  - packages/quereus/src/vtab/memory/layer/transaction.ts (TransactionLayer constructor — where a child records that it derived from its parent)
  - packages/quereus/src/vtab/memory/layer/base.ts (BaseLayer — same signal on the chain root)
  - packages/quereus/src/vtab/memory/layer/interface.ts (Layer interface)
  - packages/quereus/src/vtab/memory/layer/connection.ts (createSavepoint eager path, hasOpenWork)
  - docs/memory-table.md (lines 27, 35 — "Layer Promotion" / "Layer Collapse" bullets)
  - node_modules/inheritree/dist/b-tree.js (clearBase / chainVersion / checkBase — read-only reference, do not edit)
difficulty: medium
repro: verified
---

# Layer collapse detaches a layer other layers are still inheriting from

## Symptom

```
MutatedBaseError: Base tree was mutated while a derived child was live
  (base-immutability contract violated)
 ❯ BTree.checkBase                        inheritree
 ❯ BTree.getCount                         inheritree
 ❯ new BTree                              inheritree
 ❯ new TransactionLayer                   vtab/memory/layer/transaction.ts
 ❯ MemoryTableManager.commitTransaction   vtab/memory/layer/manager.ts:587
 ❯ MemoryTableConnection.commit           vtab/memory/layer/connection.ts
 …
```

Both arms of the source ticket were reproduced, root-caused to **one site**, and a
prototype fix was validated against both plus the full `yarn test` suite (see
*Validation already done* below).

## Minimal reproductions (both verified against `packages/quereus/dist` at v4.7.0)

**Arm A — single-threaded.** A parent table with an `on delete cascade` child, and
**no matching child rows**:

```js
const db = new Database();
await db.exec(`create table P (id integer primary key, name text)`);
await db.exec(`create table C (id integer primary key,
	pid integer not null references P(id) on delete cascade)`);
await db.exec(`insert into P values (1, 'A')`);
await db.exec(`insert into P values (2, 'B')`);
await db.exec(`delete from P where id = 2`);   // ← MutatedBaseError
```

Narrowing matrix (16 combinations run): the trigger is **`on delete cascade` with zero
matching child rows**. `declare schema` / `apply schema`, secondary indexes, and
`prepare()+run()` vs `exec()` are all irrelevant — each combination with cascade and no
child rows fails, each without cascade passes. With child rows present it also passes
(the cascade's real delete changes the ordering enough to dodge it).

**Arm B — two interleaved chains on one `Database`.** Same shape: `insert or replace`
into a table that an `on delete cascade` foreign key points at (an `insert or replace`
that replaces an existing row runs the delete side, so it takes the same cascade path).

```js
// two async chains under Promise.all, each doing:
//   insert into ConnectionEvent (…)          -- no FK
//   insert or replace into IntegrationState  -- WebhookEndpoint references it
//                                            --   on delete cascade
```

A full runnable copy of both is in the *Repro scripts* section at the bottom.

## Root cause

`MemoryTableManager.tryCollapseLayers()` calls `layerToPromote.clearBase()` on the
committed head **while other live layers are still inheriting from that head's BTrees**.

`inheritree` tracks the base-immutability contract with a version total:

```js
chainVersion() { return this._version + (this.base ? this.base.chainVersion() : 0); }
checkBase()    { if (this.base && this.base.chainVersion() !== this.baseVersion) throw new MutatedBaseError(); }
```

A child snapshots `base.chainVersion()` at construction. `clearBase()` sets
`base = undefined`, which **removes the base's whole contribution from the total** — so
every already-derived child's snapshot instantly stops matching, and its next
`checkBase()` throws. No row changed; the guard fires on the version arithmetic alone.

`checkBase()` runs from `getCount()`, and `new BTree(…, { base })` calls
`base.getCount()` in its constructor — which is why the throw surfaces at
`new TransactionLayer(...)` rather than at the collapse.

`clearBase()` is also unsound here for a second, data-level reason: per inheritree's own
docs it is a pointer drop, not a copy, so the promoted tree keeps sharing nodes by
identity with its former base and "the base-immutability contract outlives this call".

### Observed sequence (from an instrumented run of Arm A)

```
delete from P where id = 2
  statement savepoint (depth 0)          → conn0[P]: lazy marker
  parent delete                          → pending = TransactionLayer#1002 over head #1001
  cascade child DELETE opens savepoint 1 → BROADCAST to conn0[P]
      createSavepoint EAGER path: snapshot = #1002, markCommitted,
      readLayer = #1002, pendingTransactionLayer = null, readSnapshot = #1002
  cascade finishes, savepoints released
  scan closes → MemoryTable.disconnect → manager.disconnect(conn0)
      pendingTransactionLayer is null  → deferral does NOT trigger
      conn0 is REMOVED from manager.connections
      void tryCollapseLayers()
        → #1001.clearBase()   ×10   (see "Collapse loop spins" below)
  commit → pending null, readLayer #1002 ahead of head #1001
        → new TransactionLayer(#1002)
        → #1002.tree.getCount() → checkBase() → THROW
```

`#1002` snapshotted `chainVersion(#1001.tree) === 2` (`#1001._version 1` +
`#1000._version 1`). After `#1001.clearBase()` it reads `1`. Mismatch → throw.

### Why the existing guards miss it

Three independent gaps, all at or around the collapse:

1. **`isLayerInUse` never checks the layer being promoted.** It is called only on
   `parentLayer` (`manager.ts:882`). But `clearBase()` mutates `layerToPromote`, and the
   trees at risk are the ones derived **from** it — exactly the check that is absent.

2. **`isLayerInUse` never walks `readLayer`'s ancestor chain.** Per connection it checks
   `conn.readLayer === layer`, `conn.pendingTransactionLayer === layer`, and then walks
   only `conn.pendingTransactionLayer`'s parents. After an eager savepoint
   (`MemoryTableConnection.createSavepoint`) the connection's uncommitted layer lives in
   `readLayer` with `pendingTransactionLayer === null` — precisely the crash state — so
   nothing in the ancestor chain is seen.

3. **`disconnect()` drops still-live connections.** It defers only while
   `connection.pendingTransactionLayer` is non-null and uncommitted. After an eager
   savepoint the pending layer has moved into `readLayer` and been marked committed, so
   the guard passes, the connection is deleted from `this.connections`, and the collapse
   then runs with no record of it at all. `MemoryTableConnection.hasOpenWork()`
   (`pendingTransactionLayer !== null || readSnapshot !== null`) exists for exactly this
   distinction and is not used here.

Note gap 3 is not merely a missed deferral: the disconnected `MemoryTableConnection`
object stays alive in the *database's* connection registry and is committed later
(`MemoryTable.ensureConnection` reuses it — see its comment at
`table.ts:95-100`). **`manager.connections` is therefore not an authoritative liveness
registry**, and no amount of improvement to `isLayerInUse` alone can make the collapse
safe. The liveness signal has to live on the layer.

### Collapse loop spins

Separately: `tryCollapseLayers`'s `while` loop condition tests
`this._currentCommittedLayer`, which the loop body never reassigns. A collapsible head is
therefore `clearBase()`d up to `maxCollapseIterations` (10) times per call — confirmed by
the trace above (ten identical `clearBase #1001` calls). Iterations 2-10 are no-ops on an
already-detached tree, but the loop is plainly not doing what its comments describe.

## Expected behaviour (unchanged from the source ticket)

- A committed transaction leaves no live derived child guarding the tree the next commit
  will derive from.
- A delete followed by an unrelated update commits cleanly, single-threaded.
- Two interleaved transaction chains on one `Database` both commit, or one fails with a
  real serialization error — never with a base-immutability contract violation, which is
  an internal invariant, not a user-facing condition.

## Validation already done

A prototype of the recommended fix (below) was applied and measured, then reverted so
this stage hands off a clean tree:

| check | result |
| --- | --- |
| Arm A minimal repro (16-case matrix) | fixed |
| Arm B minimal repro | fixed |
| `yarn workspace @sitecad/site-cad test ground-model` | 92 passed, 0 failed (was 1 failed) |
| `yarn workspace @sitecad/sim test --run lifecycle` | 12 passed, 0 failed (was 1 failed) |
| `yarn test` (whole quereus monorepo) | all green, 0 failing |

Note for whoever re-runs the consumer tests: **SiteCAD executes
`packages/quereus/dist`, not `src`** — its stack traces show `src/*.ts` paths only
because of source maps. Editing quereus source without `yarn workspace @quereus/quereus
run build` first has no effect on those runs. This cost a full false-negative experiment
during triage.

## Recommended fix

Give a layer its own derived-child signal, independent of `manager.connections`, and
refuse to collapse a layer that has one. Exact shape validated:

```ts
// interface.ts — on Layer
/** Records that a child layer built its BTrees over this layer's. */
noteDerivedChild(): void;
/** True once any child layer has built its BTrees over this layer's. */
hasDerivedChildren(): boolean;

// transaction.ts — in the TransactionLayer constructor, before building the tree
parent.noteDerivedChild();

// manager.ts — tryCollapseLayers, immediately after picking layerToPromote
if (layerToPromote.hasDerivedChildren()) break;
```

Implemented on both `BaseLayer` and `TransactionLayer` as a plain counter.

The counter is never decremented — there is no layer-destruction hook and no reliable
liveness registry to build one from. That is deliberate and safe in the conservative
direction: collapse fires only on a head that has *never* had a child derived from it,
which is exactly the quiescent case where detaching it changes no other tree's
`chainVersion()`. It does mean collapse becomes rarer; see the tripwire below.

Alternative considered and **not** recommended for this ticket: replace `clearBase()`
with inheritree's `flatten()`, which produces a genuinely independent tree and leaves the
old tree object untouched (so existing children keep reading valid, unchanged content).
That is correct but turns an O(1) pointer drop into an O(n) copy on a path that fires on
every scan close. If the guard above proves to cost real memory, `flatten()` behind a
chain-depth threshold is the follow-up shape.

## Scope note

`tickets/backlog/debt-memory-table-manager-file-too-large.md` also targets `manager.ts`,
but as a whole-file split, not this defect site. No open ticket claims
`tryCollapseLayers` / `clearBase` / `isLayerInUse`.

---

## TODO

### Phase 1 — the fix

- Add `noteDerivedChild()` / `hasDerivedChildren()` to the `Layer` interface, with real
  docstrings explaining *why* the counter never decrements (no destruction hook; the
  conservative direction is correct) and why `manager.connections` cannot serve as the
  liveness registry (`disconnect` removes connections that are still live and still get
  committed — cite `table.ts:95-100`).
- Implement both on `BaseLayer` and `TransactionLayer` as a plain counter.
- Call `parent.noteDerivedChild()` in the `TransactionLayer` constructor, before the
  primary BTree is built.
- Guard `tryCollapseLayers`: `break` when `layerToPromote.hasDerivedChildren()`. Explain
  at the site that `clearBase()` changes the layer's `chainVersion()` and therefore trips
  every already-derived child's `checkBase()`, and that inheritree's contract additionally
  forbids it for node-sharing reasons.

### Phase 2 — the adjacent gaps (defence in depth; each is independently reachable)

- `disconnect()`: gate the deferral on `connection.hasOpenWork()` rather than
  `pendingTransactionLayer && !isCommitted()`, so a connection whose uncommitted rows sit
  in an eager savepoint snapshot is not dropped from `this.connections`.
- `isLayerInUse()`: also walk `conn.readLayer`'s ancestor chain, not just
  `conn.pendingTransactionLayer`'s. Both walks should terminate on `getParent() === null`
  rather than on the `instanceof TransactionLayer` check the current pending-chain walk
  uses.
- `tryCollapseLayers()`: fix the loop so it cannot re-promote the same layer. Either
  advance/exit after one successful promotion, or make the condition depend on something
  the body changes. Keep `maxCollapseIterations` as a backstop, but it must stop being the
  thing that actually terminates the loop.

### Phase 3 — regression tests

- Add a memory-vtab test for Arm A: parent + `on delete cascade` child, **no child rows**,
  `delete` then an unrelated `update`. Assert both commit and the surviving rows are
  correct. Place it alongside the existing vtab tests (`packages/quereus/test/vtab/`).
- Add a test for Arm B: two `Promise.all` chains, each `insert` + `insert or replace` on a
  table referenced by an `on delete cascade` foreign key, sharing one `Database`. Assert
  every row lands and no `MutatedBaseError` escapes.
- Both must fail at `b42f2b6e` (v4.7.0) and pass after Phase 1.

### Phase 4 — docs + verification

- Update `docs/memory-table.md` lines 27 and 35 ("Layer Promotion" / "Layer Collapse"):
  state the precondition that a layer with any derived child is never promoted, and why
  `clearBase()` on such a layer is a contract violation rather than a cheap optimization.
- Record the tripwire as a `NOTE:` comment at the guard site in `tryCollapseLayers`:
  *the derived-child counter never decrements, so a long-lived table whose head always has
  a child may never collapse; if layer-chain memory growth ever shows up, switch the
  promotion to `BTree.flatten()` (a real O(n) independent copy) behind a chain-depth
  threshold instead of loosening the guard.*
- Run `yarn build`, `yarn test`, `yarn lint`.
- Rebuild quereus dist, then re-run the two consumer repros and confirm `1 failed → 0` on
  each:
  - `cd ../SiteCAD_branch && yarn workspace @sitecad/site-cad test ground-model`
    — "Layer CRUD DB Behavior > createRemoveLayerCommand compacts sequences after delete"
  - `cd ../SiteCAD_branch && yarn workspace @sitecad/sim test --run lifecycle`
    — "ConnectionEvent id allocation across lifecycles on one stateDb > interleaved
      concurrent transitions across two lifecycles never collide on the PK"

---

## Repro scripts

Drop either at the repo root and run with `node`. Both fail at `b42f2b6e`.

**Arm A** (also the narrowing matrix — flip `cascade` / `childRows`):

```js
import { Database } from './packages/quereus/dist/src/index.js';

const db = new Database();
await db.exec(`create table P (id integer primary key, name text)`);
await db.exec(`create table C (id integer primary key,
	pid integer not null references P(id) on delete cascade)`);
await db.exec(`insert into P values (1, 'A')`);
await db.exec(`insert into P values (2, 'B')`);
await db.exec(`delete from P where id = 2`);          // MutatedBaseError
await db.exec(`update P set name = 'z' where id = 1`);
await db.close();
```

**Arm B**:

```js
import { Database } from './packages/quereus/dist/src/index.js';

const db = new Database();
await db.exec(`declare schema sim {
	table IntegrationState (
		integration_id text primary key, state text,
		last_transition_ts integer, attempt_count integer default 0, last_error text null
	)
	index idx_integrationstate_state on IntegrationState(state)
	table WebhookEndpoint (
		integration_id text primary key, path_token text, created_at integer,
		foreign key (integration_id) references IntegrationState(integration_id) on delete cascade
	)
	table ConnectionEvent (
		id integer primary key, integration_id text, ts integer,
		from_state text, to_state text, reason text null
	)
	index idx_connectionevent_integration on ConnectionEvent(integration_id, ts)
	index idx_connectionevent_ts on ConnectionEvent(ts)
}`);
await db.exec(`apply schema sim`);
db.setSchemaPath(['sim']);

let next = 1, seed = null;
async function allocate() {
	seed ??= (async () => {
		for await (const r of db.eval(`select max(id) as maxId from ConnectionEvent`)) {
			next = (r.maxId ?? 0) + 1;
			return;
		}
	})();
	await seed;
	return next++;
}

async function transition(intId, from, to, reason = null) {
	const id = await allocate();
	await db.exec(
		`insert into ConnectionEvent (id, integration_id, ts, from_state, to_state, reason)
		 values (?, ?, ?, ?, ?, ?)`,
		[id, intId, id * 10, from, to, reason]);
	await db.exec(
		`insert or replace into IntegrationState
		 (integration_id, state, last_transition_ts, attempt_count, last_error)
		 values (?, ?, ?, ?, ?)`,
		[intId, to, id * 10, 0, reason]);
}

await Promise.all([                                    // MutatedBaseError
	(async () => {
		await transition('int-a', 'disconnected', 'connecting');
		await transition('int-a', 'connecting', 'connected');
		await transition('int-a', 'connected', 'degraded', 'a');
	})(),
	(async () => {
		await transition('int-b', 'disconnected', 'connecting');
		await transition('int-b', 'connecting', 'connected');
		await transition('int-b', 'connected', 'degraded', 'b');
	})(),
]);
await db.close();
```
