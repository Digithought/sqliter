# @quereus/plugin-nativescript-sqlite

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. It rides `@quereus/store`'s on-disk key
> encoding, which is not frozen. See [Stability Tiers](../../docs/stability.md#tiers).

SQLite storage plugin for Quereus on NativeScript. Provides persistent storage for iOS and Android mobile apps using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Native SQLite**: Uses the device's built-in SQLite via `@nativescript-community/sqlite`
- **Transaction isolation**: Read-committed + read-your-own-writes by default (no write-write conflict detection; not snapshot isolation)
- **Order-preserving keys**: BLOB keys with `memcmp()` comparison ensure correct lexicographic byte ordering
- **Single database file**: All stores share one SQLite database (separate tables)
- **ACID transactions**: SQLite transactions for atomic batch writes
- **WITHOUT ROWID**: Optimized key-value table structure

## Installation

```bash
npm install @quereus/plugin-nativescript-sqlite @quereus/store @quereus/isolation @nativescript-community/sqlite
```

Or with NativeScript CLI:

```bash
ns plugin add @quereus/plugin-nativescript-sqlite
ns plugin add @nativescript-community/sqlite
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { openOrCreate } from '@nativescript-community/sqlite';
import { Database, registerPlugin } from '@quereus/quereus';
import sqlitePlugin from '@quereus/plugin-nativescript-sqlite/plugin';

// Open or create the SQLite database
const sqliteDb = openOrCreate('quereus.db');

// Create Quereus database and register the plugin
const db = new Database();
await registerPlugin(db, sqlitePlugin, { db: sqliteDb });

// Create tables using the 'store' module
await db.exec(`
	create table users (id integer primary key, name text)
	using store
`);

// Full transaction isolation enabled by default
await db.exec('BEGIN');
await db.exec(`insert into users values (1, 'Alice')`);
const user = await db.get(`select * from users where id = 1`); // Sees uncommitted insert
await db.exec('COMMIT');
```

### Disabling Isolation

If you need maximum performance and don't require read-your-own-writes within transactions:

```typescript
await registerPlugin(db, sqlitePlugin, { 
	db: sqliteDb,
	isolation: false  // Disable isolation layer
});
```

### Direct Usage with Provider

```typescript
import { openOrCreate } from '@nativescript-community/sqlite';
import { Database } from '@quereus/quereus';
import { createSQLiteProvider } from '@quereus/plugin-nativescript-sqlite';
import { createIsolatedStoreModule } from '@quereus/store';


const sqliteDb = openOrCreate('quereus.db');
const provider = createSQLiteProvider({ db: sqliteDb });
const storeModule = new StoreModule(provider);

const db = new Database();
db.registerModule('store', storeModule);

await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

## API

### SQLiteStore

Low-level KVStore implementation backed by a SQLite table:

```typescript
import { openOrCreate } from '@nativescript-community/sqlite';
import { SQLiteStore } from '@quereus/plugin-nativescript-sqlite';

const sqliteDb = openOrCreate('myapp.db');
const store = SQLiteStore.create(sqliteDb, 'my_kv_table');

// Key-value operations (keys and values are Uint8Array)
await store.put(key, value);
const data = await store.get(key);
await store.delete(key);

// Range iteration
for await (const { key, value } of store.iterate({ gte: startKey, lt: endKey })) {
  console.log(key, value);
}

// Batch writes (atomic)
const batch = store.batch();
batch.put(key1, value1);
batch.put(key2, value2);
batch.delete(key3);
await batch.write();

await store.close();
```

### SQLiteProvider

Factory for managing multiple stores in a single SQLite database:

```typescript
import { openOrCreate } from '@nativescript-community/sqlite';
import { createSQLiteProvider } from '@quereus/plugin-nativescript-sqlite';

const sqliteDb = openOrCreate('quereus.db');
const provider = createSQLiteProvider({ db: sqliteDb });

// Each store gets its own table: quereus_main_users, quereus_main_orders, etc.
const userStore = await provider.getStore('main', 'users');
const orderStore = await provider.getStore('main', 'orders');
const catalogStore = await provider.getCatalogStore();

await provider.closeStore('main', 'users');
await provider.closeAll();  // Also closes the SQLite database
```

## Configuration

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `db` | SQLiteDatabase | **required** | SQLite database from `openOrCreate()` |
| `tablePrefix` | string | `'quereus_'` | Prefix for all table names |
| `moduleName` | string | `'store'` | Virtual table module name for `USING` clause |

### SQLiteStore Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `db` | SQLiteDatabase | **required** | The SQLite database instance |
| `tableName` | string | `'kv'` | Table name for this store |

## How It Works

### Key Storage

Keys and values are stored as BLOBs (binary). SQLite compares BLOBs using `memcmp()`, which provides correct lexicographic byte ordering - exactly what's needed for range scans.

### Table Structure

Each store creates a table with this schema:

```sql
create table quereus_main_users (
  key blob primary key,
  value blob
) without rowid
```

The `WITHOUT ROWID` optimization is ideal for key-value workloads where the key is the primary lookup.

## Platform Support

| Platform | Status |
|----------|--------|
| iOS | ✅ Supported |
| Android | ✅ Supported |
| NativeScript 8+ | ✅ Supported |

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB plugin for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB plugin for browsers

## License

MIT

