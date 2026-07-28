# @quereus/isolation

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. See
> [Stability Tiers](../../docs/stability.md#tiers).

Generic transaction isolation layer for Quereus virtual table modules.

## Overview

The `@quereus/isolation` package provides connection-level transaction isolation for any Quereus virtual table module. It wraps existing modules to add:

- **Read-your-own-writes** — See uncommitted changes within your transaction
- **Read-committed reads of shared state** — Reads merge against the *live* underlying table, so another connection's committed writes can become visible mid-transaction. This is **not** snapshot isolation — reads are not a stable point-in-time view. A stable snapshot, if needed, is the job of whatever module is layered beneath this one (see [Isolation Level](#isolation-level) below).
- **Savepoint support** — Nested transaction control
- **No write-write conflict detection** — Concurrent writers to the same row are not detected; the last connection to flush wins.

This allows module authors to focus on storage concerns while getting isolation "for free."

## Installation

```bash
yarn add @quereus/isolation @quereus/quereus
```

## Quick Start

```typescript
import { Database, MemoryTableModule } from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';

const db = new Database();

// Create any underlying module (memory, store, custom, etc.)
const memoryModule = new MemoryTableModule();

// Wrap it with the isolation layer
const isolatedModule = new IsolationModule({
	underlying: memoryModule,
});

db.registerModule('isolated', isolatedModule);

// Use it like any other module, but with full isolation
await db.exec(`CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	name TEXT
) USING isolated`);

await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

// Reads see uncommitted changes
const user = await db.get('SELECT * FROM users WHERE id = 1');
console.log(user.name); // 'Alice'

await db.exec('COMMIT'); // Or ROLLBACK
```

## Architecture

The isolation layer operates at the **row level**, merging query results from two modules:

1. **Overlay module** — Stores uncommitted changes (inserts, updates, deletes as tombstones)
2. **Underlying module** — Stores committed data

```
┌─────────────────────────────────────────────────────────┐
│                   IsolationModule                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Overlay Module (e.g., memory vtab)         │ │
│  │  - Stores pending inserts, updates, tombstones     │ │
│  │  - Per-connection isolation                        │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│                          │ row-level merge               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │           Underlying Module (any)                   │ │
│  │  - LevelDB / IndexedDB store                       │ │
│  │  - Custom module without isolation                 │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Reading a pushed index window

When the underlying serves a read through an index seek, the overlay must be narrowed to
the same window — otherwise a staged row outside it would leak into the answer. The
overlay is full-scanned (it cannot resolve an index name the underlying minted for its own
plan), and `IsolatedTable`'s constraint matcher re-applies the pushed window itself. Several
equality constraints on the *same* column are read as an **IN set**, not as an AND: that is
how an `IN`-list seek is encoded — one equality per seek value — so an AND reading would
match nothing and silently drop every staged row.

This holds for a set of values that only exists at run time (`where v in (select …)`,
which the engine may materialize and push down as a seek) exactly as it does for a literal
`in (1, 2, 3)`: the pushed window has the same shape either way, and this layer cannot —
and need not — tell them apart.

One ordering caveat. The **primary-key** merge walks both streams in ascending key order.
The engine sorts a run-time key set before pushing it, so that path arrives in order. A
**literal** list does not: `where pk in (3, 1, 2)` is visited in list order, and with rows
staged in the transaction the merge mis-pairs them — a staged update can surface alongside
the stale stored row, and a staged delete can reappear. That is tracked as
`backlog/bug-isolation-multiseek-merge-order`; the secondary-index merge is unaffected
(it sorts the overlay itself and excludes shadowed rows by primary key).

## Isolation Level

The guarantee this layer actually provides is closer to **read-committed with
read-your-own-writes** than to snapshot isolation:

- **Read-your-own-writes** — a connection always sees its own uncommitted overlay
  changes.
- **Live reads of shared state** — the merged read path queries the *live* underlying
  table on every read, not a point-in-time copy taken at `BEGIN`. If another
  connection commits mid-transaction, the next read in this transaction can observe
  that write. Reads are **not** isolated from concurrent commits.
- **No write-write conflict detection** — two connections that write the same row in
  overlapping transactions are not detected as conflicting; whichever connection
  flushes (commits) last overwrites the other.
- **Snapshotting is delegated downward** — if a consumer needs a stable, point-in-time
  view of the data, that guarantee must come from the module wrapped *beneath* this
  layer (the `underlying` module), not from `IsolationModule` itself. A future
  optional snapshotting pass-through module may be added below the isolation layer
  for consumers that need this; it does not exist today.

### Key Features

**Per-connection overlay** — Each database instance gets its own overlay storage, ensuring proper isolation between connections.

**Lazy overlay creation** — No memory overhead until the first write in a transaction.

**Transparent hook forwarding** — `IsolationModule` is a wrapper, so the engine/planner/lens machinery reaches *it* (the registered module) rather than the underlying. Optional `VirtualTableModule` hooks whose behavior is isolation-transparent are forwarded straight through to the underlying: `getMappingAdvertisements` (decomposition shape), `getBestAccessPlan` (index awareness), the `beginSchemaBatch` / `endSchemaBatch` APPLY SCHEMA batch hooks (single-substrate-commit batching of migration DDL), `assertCatalogObjectPersistable` (the pre-flight veto that lets a persisting module refuse a view / materialized view whose catalog entry it could not durably write — whether a definition is encodable is a property of the definition text, not of the overlay, and without the forward a wrapped store would silently keep dropping such views on reopen), and `getBackingHost` (the materialized-view backing-host capability — assigned in the constructor only when the underlying implements it, so method *presence* mirrors the underlying; backing writes are privileged and bypass the per-connection overlay entirely, making the underlying host's pending state the right surface). Hooks whose underlying value would *misdescribe* the wrapped behavior are intentionally **not** forwarded: `getCapabilities` is augmented with `isolation`/`savepoints` rather than passed through verbatim; `supports` (full-query push-down) is suppressed so the overlay always sees every row to merge; and `concurrencyMode` / `expectedLatencyMs` are derived rather than passed through verbatim: `concurrencyMode` is the weaker of the underlying and overlay modes, capped at `reentrant-reads` (the wrapper's own write path mutates shared overlay-merge state non-atomically, so it is never `fully-reentrant`), while `expectedLatencyMs` forwards the underlying's hint (defaulting to `0` when the underlying declares none).

**Atomic ALTER (issuer-faithful) + cross-connection poison** — DDL through Quereus is not transaction-scoped and the shared underlying base auto-commits its mutation immediately, so a half-applied ALTER cannot be rolled back. The blast radius is isolation-faithful — an ALTER never depends on another connection's uncommitted data:

- **Issuer's own overlay** — `IsolationModule.alterTable` dry-run **validates the issuing connection's own affected overlay's backfill** (per-row `NOT NULL` checks — for a new `ADD COLUMN ... NOT NULL` and for tightening an existing column with `ALTER COLUMN ... SET NOT NULL` — and the tombstone-present guard) *before* mutating the underlying. A rejection fires while the underlying, the schema catalog, and every overlay are still untouched, so for the issuer the ALTER either fails clean or fully applies — base and catalog never diverge. (The issuer staged both the data and the DDL, so rejecting up front is the least-surprising behavior.)
- **`ALTER TABLE ... ALTER COLUMN ... SET COLLATE` on a primary-key column** — the change re-keys the table, so two staged rows can land on one new key. A deletion marker sharing its new key with a staged live row is that row's before-image (delete `'A'`, insert `'a'`, then switch to `NOCASE`), so the marker is discarded and the ALTER succeeds; two staged **live** rows on one key are a real duplicate and are refused. A shape the re-keyed overlay cannot physically hold — a savepoint that could restore both a marker and its replacement at one key — is refused as retryable (`BUSY`), the same answer a plain non-isolated table gives. Every refusal is surfaced *before* the shared underlying is touched, so the transaction survives intact.
- **`ALTER TABLE ... ALTER PRIMARY KEY`** — the one change no overlay can follow: an overlay's staged rows (and its deletion markers) are keyed by the *old* primary key. A connection that has uncommitted changes staged for the table is therefore rejected with `UNSUPPORTED` *before* the underlying is touched — commit or roll back first, then retry. Another connection's overlay holding staged rows is poisoned; one holding nothing is swapped for an empty overlay under the new key. (The bundled `MemoryTableModule` rejects `ALTER PRIMARY KEY` outright, so this only arises under a store-backed underlying.)
- **Another connection's overlay** — the shared underlying and the catalog change regardless of any *other* connection's uncommitted state. A foreign overlay that *can* migrate is carried forward as usual (a staged `NULL` is backfilled when a usable literal `DEFAULT` exists); one that *cannot* (its staged row can't satisfy the new or newly-`NOT NULL` column) is left in place and marked **poisoned**. Its owning connection then raises a `CONSTRAINT` error the next time it reads (merged), writes, or commits that table, and recovers by rolling back (which discards the overlay and its poison). A committed-snapshot (`committed.<table>`) read bypasses the overlay and keeps working. A layer-invariant violation (e.g. a missing tombstone column, `INTERNAL`) still rethrows loud for everyone rather than poisoning.

**Configurable overlay module** — Use memory for fast transactions, or persistent storage for large transactions:

```typescript
import { IsolationModule } from '@quereus/isolation';
import { MemoryTableModule } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';

// Fast, ephemeral overlay (default)
const isolatedModule = new IsolationModule({
	underlying: myStoreModule,
	overlay: new MemoryTableModule(),
});

// Or use persistent overlay for large transactions
const isolatedModule = new IsolationModule({
	underlying: myStoreModule,
	overlay: new StoreModule(tempStoreProvider),
});
```

## API

### `IsolationModule`

```typescript
class IsolationModule implements VirtualTableModule {
	constructor(config: IsolationModuleConfig);
	getCapabilities(): ModuleCapabilities;
}
```

#### Configuration

```typescript
interface IsolationModuleConfig {
	/** Module to wrap with isolation semantics */
	underlying: VirtualTableModule<any, any>;

	/** Optional overlay module (defaults to MemoryTableModule) */
	overlay?: VirtualTableModule<any, any>;

	/** Optional tombstone column name (defaults to '_tombstone') */
	tombstoneColumn?: string;
}
```

### Merge Utilities

The package also exports low-level utilities for merging sorted streams:

```typescript
import { mergeStreams, createMergeEntry, createTombstone } from '@quereus/isolation';

// Merge two sorted streams (overlay and underlying)
const merged = mergeStreams(overlayStream, underlyingStream, {
	comparePK: (a, b) => /* compare primary keys */,
	extractPK: (row) => /* extract PK from row */,
});
```

See the [design document](https://github.com/gotchoices/quereus/blob/main/docs/design-isolation-layer.md) for detailed architecture and implementation notes.

## Use Cases

### Store Module Isolation

The `@quereus/store` package provides a convenience function:

```typescript
import { createIsolatedStoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const provider = createLevelDBProvider({ basePath: './data' });
const module = createIsolatedStoreModule({ provider });

db.registerModule('store', module);
```

### Custom Module Isolation

Wrap any custom module:

```typescript
import { IsolationModule } from '@quereus/isolation';
import { MyCustomModule } from './my-module';

const isolatedModule = new IsolationModule({
	underlying: new MyCustomModule(),
});
```

## Checking Capabilities

```typescript
const caps = isolatedModule.getCapabilities();
console.log(caps.isolation);  // true
console.log(caps.savepoints); // true
console.log(caps.persistent); // (from underlying module)
```

## Performance

The isolation layer adds minimal overhead:

- **Fast path** — No overlay merging if no writes have occurred
- **Point lookups** — O(log n) via PK index seek on the overlay
- **Range scans** — Streaming merge of sorted results
- **Commit flush** — O(log n) per-row existence check against the underlying table

For performance-critical applications, consider:
- Using memory overlay for small transactions
- The memory vtab uses integrated isolation (no separate layer)

## Testing

```bash
yarn test
```

## License

MIT

## Related Packages

- [@quereus/quereus](https://www.npmjs.com/package/@quereus/quereus) — Core SQL engine
- [@quereus/store](https://www.npmjs.com/package/@quereus/store) — Abstract key-value storage
- [@quereus/plugin-leveldb](https://www.npmjs.com/package/@quereus/plugin-leveldb) — LevelDB storage
- [@quereus/plugin-indexeddb](https://www.npmjs.com/package/@quereus/plugin-indexeddb) — IndexedDB storage
