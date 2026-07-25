# @quereus/plugin-indexeddb

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. It rides `@quereus/store`'s on-disk key
> encoding, which is not frozen. See [Stability Tiers](../../docs/stability.md#tiers).

IndexedDB storage plugin for Quereus. Provides persistent storage for browser environments using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Browser-native**: Uses IndexedDB for reliable persistent storage
- **Transaction isolation**: Read-committed + read-your-own-writes by default (no write-write conflict detection; not snapshot isolation)
- **Read cache**: In-memory LRU cache reduces redundant IDB transactions (enabled by default)
- **Cross-tab sync**: BroadcastChannel-based synchronization across browser tabs, with automatic cache invalidation
- **Async iteration**: Efficient range queries with cursor-based iteration

## Installation

```bash
npm install @quereus/plugin-indexeddb @quereus/store @quereus/isolation
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';

const db = new Database();
await registerPlugin(db, indexeddbPlugin, { prefix: 'myapp' });

await db.exec(`create table users (id integer primary key, name text) using store`);

// Full transaction isolation enabled by default
await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
const user = await db.get('SELECT * FROM users WHERE id = 1'); // Sees uncommitted insert
await db.exec('COMMIT');
```

### Disabling Isolation

If you need maximum performance and don't require read-your-own-writes within transactions:

```typescript
await registerPlugin(db, indexeddbPlugin, { 
	prefix: 'myapp',
	isolation: false  // Disable isolation layer
});
```

### Direct Usage with Provider

```typescript
import { Database } from '@quereus/quereus';
import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';
import { createIsolatedStoreModule } from '@quereus/store';

const db = new Database();
const provider = createIndexedDBProvider({ prefix: 'myapp' });

// With isolation (recommended)
const storeModule = createIsolatedStoreModule({ provider });
db.registerModule('store', storeModule);

await db.exec(`create table users (id integer primary key, name text) using store`);
```

## API

### IndexedDBStore

Low-level KVStore implementation:

```typescript
import { IndexedDBStore } from '@quereus/plugin-indexeddb';

const store = await IndexedDBStore.open({ path: 'myapp_main_users' });

await store.put(key, value);
const data = await store.get(key);
await store.delete(key);

// Range iteration
for await (const { key, value } of store.iterate({ gte: startKey, lt: endKey })) {
  console.log(key, value);
}

await store.close();
```

### IndexedDBProvider

Factory for managing multiple stores:

```typescript
import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';

const provider = createIndexedDBProvider({ prefix: 'myapp' });

const userStore = await provider.getStore('main', 'users');
const catalogStore = await provider.getCatalogStore();

await provider.closeAll();
```

### CrossTabSync

Synchronize changes across browser tabs:

```typescript
import { CrossTabSync } from '@quereus/plugin-indexeddb';

const sync = new CrossTabSync('myapp');

sync.onDataChange((event) => {
  console.log('Tab change:', event.storeName, event.type, event.key);
  refreshUI();
});

// Broadcast a change to other tabs
sync.notifyDataChange('main.users', 'put', key);

sync.close();
```

## Configuration

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `databaseName` | string | `'quereus'` | Name for the unified IndexedDB database |
| `moduleName` | string | `'store'` | Name to register the virtual table module under |
| `cache` | CacheOptions | `{ enabled: true, maxEntries: 1000 }` | Read cache configuration (see below) |

### Cache Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxEntries` | number | `1000` | Maximum cached entries per store |
| `maxBytes` | number | — | Maximum cached bytes per store (unlimited if omitted) |
| `enabled` | boolean | `true` | Set `false` to disable caching entirely |

### IndexedDBProvider Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databaseName` | string | `'quereus'` | Name for the unified IndexedDB database |
| `cache` | CacheOptions | — | Read cache configuration |

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB plugin for Node.js

## License

MIT

