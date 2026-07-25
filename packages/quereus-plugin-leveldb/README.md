# @quereus/plugin-leveldb

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. It rides `@quereus/store`'s on-disk key
> encoding, which is not frozen. See [Stability Tiers](../../docs/stability.md#tiers).

LevelDB storage plugin for Quereus. Provides persistent storage for Node.js environments using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Fast**: LevelDB offers excellent read/write performance for key-value workloads
- **Transaction isolation**: Read-committed + read-your-own-writes by default (no write-write conflict detection; not snapshot isolation)
- **Sorted keys**: Efficient range queries with ordered iteration
- **Crash-safe commits**: A whole transaction's data + secondary-index writes commit in one atomic, durable LevelDB batch (see [Storage layout](#storage-layout))
- **Compression**: Built-in Snappy compression for reduced disk usage

## Storage layout

All of a database's stores live inside **one physical LevelDB** at `basePath`,
each as a [sublevel](https://github.com/Level/abstract-level#sublevel) keyed by
its store name:

| Logical store | Sublevel name |
|---|---|
| Table data | `{schema}.{table}` |
| Secondary index | `{schema}.{table}_idx_{name}` |
| Unified stats | `__stats__` |
| Catalog (DDL) | `__catalog__` |

Because every sublevel shares one physical store, a single chained batch commits
across all of a table's sublevels (data + every secondary index) **atomically and
durably** — closing the crash window where a per-store commit loop could leave a
table's rows and its indexes divergent on disk. By default each commit is
`fsync`'d so it survives power loss; see [`syncCommits`](#plugin-settings).

> **Hard cutover (no on-disk migration).** This shared-root layout is the only
> LevelDB layout. Databases written by the older per-directory layout
> (`{basePath}/{schema}/{table}`, a separate LevelDB per table) are **not** read
> by this version and must be re-created. Pre-1.0 dev data is expected to be
> thrown away; there is no migration importer.

## Installation

```bash
npm install @quereus/plugin-leveldb @quereus/store @quereus/isolation
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { basePath: './data' });

await db.exec(`
	create table users (id integer primary key, name text)
	using store
`);

// Full transaction isolation enabled by default
await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
const user = await db.get('SELECT * FROM users WHERE id = 1'); // Sees uncommitted insert
await db.exec('COMMIT');
```

### Disabling Isolation

If you need maximum performance and don't require read-your-own-writes within transactions:

```typescript
await registerPlugin(db, leveldbPlugin, { 
	basePath: './data',
	isolation: false  // Disable isolation layer
});
```

### Direct Usage with Provider

```typescript
import { Database } from '@quereus/quereus';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';
import { createIsolatedStoreModule } from '@quereus/store';

const db = new Database();
const provider = createLevelDBProvider({ basePath: './data' });

// With isolation (recommended)
const storeModule = createIsolatedStoreModule({ provider });
db.registerModule('store', storeModule);

await db.exec(`
	create table users (id integer primary key, name text)
	using store
`);
```

## API

### LevelDBStore

Low-level KVStore implementation. `LevelDBStore.open()` opens a **standalone**
single physical LevelDB database — useful for one-off key-value stores (e.g. sync
metadata). The multi-table StoreModule backend does not use this directly; it
opens one shared root and hands out sublevel-backed stores via `LevelDBProvider`.

```typescript
import { LevelDBStore } from '@quereus/plugin-leveldb';

const store = await LevelDBStore.open({ path: './data/mystore' });

await store.put(key, value);
const data = await store.get(key);
await store.delete(key);

// Range iteration
for await (const { key, value } of store.iterate({ gte: startKey, lt: endKey })) {
  console.log(key, value);
}

// Batch writes
const batch = store.batch();
batch.put(key1, value1);
batch.put(key2, value2);
batch.delete(key3);
await batch.write();

await store.close();
```

### LevelDBProvider

Factory for managing multiple stores:

```typescript
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const provider = createLevelDBProvider({ basePath: './data' });

// All stores are sublevels of the single LevelDB at ./data
const userStore = await provider.getStore('main', 'users');  // sublevel main.users
const catalogStore = await provider.getCatalogStore();       // sublevel __catalog__

await provider.closeStore('main', 'users'); // drops the sublevel handle
await provider.closeAll();                   // closes the shared root
```

## Configuration

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `basePath` | string | `'./data'` | Directory of the single shared LevelDB database |
| `createIfMissing` | boolean | `true` | Create the database if it doesn't exist |
| `syncCommits` | boolean | `true` | `fsync` each transaction commit so it survives power loss (slower commits when on) |
| `moduleName` | string | `'store'` | Name to register the virtual table module under |
| `isolation` | boolean | `true` | Wrap with the isolation layer (read-committed + read-your-own-writes; no write-write conflict detection, not snapshot isolation) |

### LevelDBStore Options (standalone `open`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | required | Directory path for the database |
| `createIfMissing` | boolean | `true` | Create database if it doesn't exist |

## Example with Transactions

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { basePath: './data' });

await db.exec(`create table accounts (id integer primary key, balance real) using store`);

await db.exec('begin');
try {
  await db.exec(`update accounts set balance = balance - 100 where id = 1`);
  await db.exec(`update accounts set balance = balance + 100 where id = 2`);
  await db.exec('commit');
} catch (e) {
  await db.exec('rollback');
  throw e;
}
```

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB plugin for browsers

## License

MIT

