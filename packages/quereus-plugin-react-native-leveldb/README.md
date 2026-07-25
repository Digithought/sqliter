# @quereus/plugin-react-native-leveldb

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. It rides `@quereus/store`'s on-disk key
> encoding, which is not frozen. See [Stability Tiers](../../docs/stability.md#tiers).

LevelDB storage plugin for Quereus on React Native. Provides fast, persistent storage for mobile iOS and Android applications using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Fast**: LevelDB offers excellent read/write performance, significantly faster than AsyncStorage
- **Transaction isolation**: Read-committed + read-your-own-writes by default (no write-write conflict detection; not snapshot isolation)
- **Synchronous API**: Uses rn-leveldb's synchronous, blocking APIs
- **Binary data**: Full support for binary keys and values via ArrayBuffers
- **Sorted keys**: Efficient range queries with ordered iteration
- **Persistent**: Data survives app restarts
- **Atomic batch writes**: Uses native LevelDB WriteBatch for atomic multi-key operations

## Installation

```bash
npm install @quereus/plugin-react-native-leveldb @quereus/store @quereus/isolation rn-leveldb

# Don't forget to link native modules
cd ios && pod install
```

## Required Polyfills

React Native apps typically need a few runtime polyfills for Quereus and its plugins:

- **`structuredClone`** - Quereus uses it internally for deep cloning operations
- **`TextEncoder` / `TextDecoder`** - Used by store plugins for binary data encoding
- **`Symbol.asyncIterator`** - Required for async-iterable support (for-await-of loops, async generators)
  - Quereus uses async iterables extensively for query results and data streaming
  - While Hermes has a workaround for AsyncGenerator objects, the `Symbol.asyncIterator` symbol itself must exist
  - Without it, you'll get `ReferenceError: Can't find variable: Symbol` when checking for async iterables

**The plugin automatically checks for these polyfills** and throws a clear error message with installation instructions if any are missing.

You can use packages like `core-js` or provide your own implementations:

```bash
npm install core-js text-encoding
```

Then in your app's entry point:

```typescript
import 'core-js/features/structured-clone';
import 'text-encoding';

// Ensure Symbol.asyncIterator exists
if (typeof Symbol.asyncIterator === 'undefined') {
  (Symbol as any).asyncIterator = Symbol.for('Symbol.asyncIterator');
}
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, {
	openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
	WriteBatch: LevelDBWriteBatch,
});

await db.exec(`
	create table users (id integer primary key, name text)
	using store
`);

// Full transaction isolation enabled by default
await db.exec('BEGIN');
await db.exec(`insert into users (id, name) values (1, 'Alice')`);
const user = await db.get('select * from users where id = 1'); // Sees uncommitted insert
await db.exec('COMMIT');
```

### Disabling Isolation

If you need maximum performance and don't require read-your-own-writes within transactions:

```typescript
await registerPlugin(db, leveldbPlugin, {
	openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
	WriteBatch: LevelDBWriteBatch,
	isolation: false  // Disable isolation layer
});
```

### Direct Usage with Provider

```typescript
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { Database } from '@quereus/quereus';
import { createReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';
import { createIsolatedStoreModule } from '@quereus/store';

const db = new Database();
const provider = createReactNativeLevelDBProvider({
	openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
	WriteBatch: LevelDBWriteBatch,
});
const storeModule = new StoreModule(provider);
db.registerModule('store', storeModule);

await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

## API

### ReactNativeLevelDBStore

Low-level KVStore implementation:

```typescript
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { ReactNativeLevelDBStore } from '@quereus/plugin-react-native-leveldb';

// Open using the factory function
const openFn = (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists);
const store = ReactNativeLevelDBStore.open(openFn, LevelDBWriteBatch, 'mystore');

await store.put(key, value);
const data = await store.get(key);
await store.delete(key);

// Range iteration
for await (const { key, value } of store.iterate({ gte: startKey, lt: endKey })) {
  console.log(key, value);
}

// Atomic batch writes (uses native LevelDB WriteBatch)
const batch = store.batch();
batch.put(key1, value1);
batch.put(key2, value2);
batch.delete(key3);
await batch.write();

await store.close();
```

### ReactNativeLevelDBProvider

Factory for managing multiple stores:

```typescript
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { createReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';

const provider = createReactNativeLevelDBProvider({
  openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
  WriteBatch: LevelDBWriteBatch,
  databaseName: 'myapp',
});

const userStore = await provider.getStore('main', 'users');
const catalogStore = await provider.getCatalogStore();

await provider.closeStore('main', 'users');
await provider.closeAll();
```

## Configuration

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openFn` | function | **required** | Factory function: `(name, createIfMissing, errorIfExists) => LevelDB` |
| `WriteBatch` | constructor | **required** | LevelDBWriteBatch constructor from rn-leveldb |
| `databaseName` | string | `'quereus'` | Base name prefix for all LevelDB databases |
| `createIfMissing` | boolean | `true` | Create databases if they don't exist |
| `moduleName` | string | `'store'` | Name to register the virtual table module under |

## Example with Transactions

```typescript
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, {
  openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
  WriteBatch: LevelDBWriteBatch,
});

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

## Why LevelDB?

rn-leveldb provides significant performance advantages over other React Native storage options:

| Storage Solution | Operations/sec | Notes |
|------------------|----------------|-------|
| rn-leveldb | ~50,000 | Synchronous, blocking API |
| AsyncStorage | ~2,000 | JSON serialization overhead |
| react-native-sqlite-storage | ~5,000 | Full SQL parsing overhead |

LevelDB is ideal for Quereus because:
- **Sorted keys**: Natural fit for the StoreModule's index-organized storage
- **Binary support**: No JSON serialization needed for keys/values
- **Range scans**: Efficient ordered iteration for query execution

## Peer Dependencies

This plugin requires:
- `@quereus/quereus` ^0.24.0
- `@quereus/store` ^0.3.5
- `rn-leveldb` ^3.11.0

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB plugin for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB plugin for browsers

## License

MIT

