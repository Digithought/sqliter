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

## Measured read cost (and why no cost profile is declared)

A storage backend can tell the query planner what its basic reads cost, relative to
reading one row sequentially during a full scan (1.0 by definition). The two knobs live in
[`@quereus/store`'s `cost-profile.ts`](../quereus-store/src/common/cost-profile.ts):
`pointRead` (resolving one secondary-index entry to its row, batched) and `seekPositioning`
(the per-key cost of a multi-key seek). IndexedDB declares measured values; **LevelDB
declares nothing and takes the framework's parity defaults (`pointRead: 1.0`,
`seekPositioning: 0.5`).** That was previously an assumption. It has now been measured, and
this section is the record so nobody has to re-ask.

### The numbers

Measured 2026-08-19 by `packages/quereus/bench/suites/store.bench.mjs`
(`leveldb-read-cost-20k`, `leveldb-read-cost-200k`) on an AMD Ryzen AI 9 HX 370 (24 cores,
31 GB, NVMe) running Windows 11 Pro 26200 under node v24.2.0. Values are 200 bytes, keys
are `encodeCompositeKey` integers, and the arms drive the `KVStore` directly — no
`Database`, no planner, no isolation overlay.

| dataset | arm | per operation | ratio vs sequential |
| --- | --- | --- | --- |
| 20 000 rows (~4 MB) | sequential `iterate()`, every value | 0.002514 ms/row | 1.00 (the denominator) |
| | 1 000 random keys via `getMany`, paged at `ROW_RESOLUTION_BATCH` | 0.003156 ms/row | **1.26** |
| | 1 000 random single-key `iterate({gte, lt, limit: 1})` | 0.047205 ms/key | **18.78** |
| 200 000 rows (~40 MB) | sequential `iterate()`, every value | 0.004442 ms/row | 1.00 |
| | 1 000 random keys via `getMany`, paged | 0.006399 ms/row | **1.44** |
| | 1 000 random single-key `iterate({gte, lt, limit: 1})` | 0.069098 ms/key | **15.55** |

Medians of 13 rounds (20k) and 7 rounds (200k), first round discarded. The 20k row's own
harness median carried a 28.5% spread and was marked `unstable`, so treat its per-arm
figures as the noisier pair; the 200k row's spread was 5.0%.

Re-run with:

```bash
QUEREUS_BENCH_LEVELDB=1 node packages/quereus/bench/run.mjs --filter store/leveldb-read-cost
```

### What the two sizes actually separate

**Not** page-cache-cold versus page-cache-warm. There is no portable way to drop the OS
page cache from Node, and a dataset big enough to exceed a modern machine's page cache
cannot be seeded inside a benchmark's time budget. What the sizes separate is
`classic-level`'s own **8 MB block cache**, which this provider does not override: 20 000
rows fit inside it and are served in-process; 200 000 rows do not, so their random reads go
out to the filesystem — which on a warm machine usually means the OS page cache, not the
physical disk. A claim of "cold" that is really "block-cache-miss, page-cache-hit" would be
worse than no claim, so it is not made.

### What the numbers mean, and why nothing is declared

**`pointRead` is near parity and stays undeclared.** 1.26 and 1.44 against a default of
1.0. The gap is also an *over*-statement of the truth: the planner's 1.0 unit is a scanned
row *including engine work*, while these arms measured the key-value layer alone. Engine
overhead lands on both sides of the ratio and therefore compresses it toward 1.0, so the
engine-inclusive value sits somewhere in `[1.0, 1.44]` — an interval that was not measured
and whose bottom is the current default. Declaring the top of it would be picking the
pessimistic end of a band on no evidence, so the parity default stands.

**`seekPositioning` is far from parity, and cannot be fixed by declaring a number.** 15.55
and 18.78 against a default of 0.5 — a factor of roughly 31 to 38. The cause is visible in
the raw milliseconds: a batched read costs ~3.2 µs per key while a single-key `iterate`
costs ~47 µs, so about 44 µs is fixed per-iterator setup and teardown (snapshot, native
iterator, close) that `getMany` amortizes over a whole page and a one-key window cannot.

The obstacle is that **one knob prices two arms whose runtime shapes differ by an order of
magnitude on this backend**:

| arm in `store-module-access-plan.ts` | what it runs (`store-table-scan.ts`) | measured per-key cost |
| --- | --- | --- |
| secondary-index multi-seek (`tryIndexAccessPlan`) | one `iterate()` window per distinct tuple prefix over the index store | ~15–19 (the single-seek arm) |
| primary-key multi-seek (`primaryKeyMultiSeekPlan`) | `scanMultiSeekPrimary` → `readEffectiveRowsByKeys`, one round trip per `ROW_RESOLUTION_BATCH` keys | ~1.3–1.4 (the batched arm) |

Both charge `seekKeyCount × seekPositioning`. Declaring ~15 would over-charge the
primary-key arm by roughly 12×, and that arm's cost is exactly what `rule-key-set-seek`
reads at 2 and 1 000 keys to interpolate a seek-versus-scan break-even — so the break-even
for `where pk in (…)` would move about 12× in the wrong direction. Declaring 0.5 leaves the
secondary arm 30-plus× too cheap, which is where it already is.

Splitting the knob so each arm can be priced honestly is
`backlog/debt-store-seek-positioning-conflates-two-arms`; the decision about what LevelDB
should ultimately declare is `backlog/debt-leveldb-cost-profile-measurement`, which stays
open on purpose.

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB plugin for browsers

## License

MIT

