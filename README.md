# Quereus

<img src="docs/images/Quereus_colored_wide.svg" alt="Quereus Logo" height="150">

A pure-TypeScript SQL engine. No WASM. No native bindings. Runs natively in the browser, Node.js, React Native, edge workers — anywhere JavaScript runs.

## Overview

Quereus is a full SQL engine built from the ground up in TypeScript. It gives you real SQL — joins, CTEs, window functions, transactions, constraints — running directly in your JavaScript process with zero compilation or binary dependencies.

Unlike SQLite-in-the-browser approaches that ship WASM blobs, Quereus is native JavaScript with an async-first architecture. All data access flows through **virtual table modules** — pluggable adapters that can connect to memory, IndexedDB, LevelDB, REST APIs, or any data source you can imagine.

Pair it with [**Quereus Sync**](#sync) for fully opaque CRDT replication: write normal SQL, and sync handles conflict resolution, schema migration propagation, and offline-first operation automatically — no special data types, no manual conflict wiring, no schema annotations.

**Key Characteristics:**
- **Pure TypeScript** — No native dependencies, no WASM, runs anywhere JS runs
- **Async/Await Native** — Built for modern JavaScript with full async support
- **Virtual Table Architecture** — Extensible data access through pluggable modules
- **Persistent Storage** — IndexedDB (browser), LevelDB (Node/RN), SQLite (NativeScript), or your own
- **Rich SQL** — Joins, CTEs, window functions, constraints, assertions, declarative schema
- **Universal Runtime** — Node.js, browsers, React Native, Cloudflare Workers, Deno

## Quick Start

### Installation

```bash
npm install quereus
```

### Basic Usage

```typescript
import { Database } from 'quereus';

const db = new Database();

// Create an in-memory table
await db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE
  ) USING memory
`);

// Insert data
await db.exec(`
  INSERT INTO users (name, email) VALUES 
    ('Alice', 'alice@example.com'),
    ('Bob', 'bob@example.com')
`);

// Query data
const users = await db.all('SELECT * FROM users WHERE name LIKE ?', ['A%']);
console.log(users); // [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
```

### Working with JSON Data

```typescript
// Query JSON data directly
await db.exec(`
  CREATE TABLE products 
  USING json_each('[
    {"id": 1, "name": "Laptop", "price": 999},
    {"id": 2, "name": "Mouse", "price": 25}
  ]')
`);

const expensiveProducts = await db.all(`
  SELECT json_extract(value, '$.name') as name,
         json_extract(value, '$.price') as price
  FROM products 
  WHERE json_extract(value, '$.price') > 500
`);
```

## Architecture

Quereus is built around a three-layer architecture:

### 1. **SQL Layer**
- **Parser** — Converts SQL text into Abstract Syntax Trees
- **Planner** — Transforms AST into optimized logical plans  
- **Optimizer** — Converts logical plans to efficient physical execution plans

### 2. **Runtime Layer**
- **Scheduler** — Executes physical plans with dependency management
- **Instructions** — Instruction execution
- **Context System** — Manages row and column references during execution

### 3. **Storage Layer**
- **Virtual Table Interface** — Pluggable data access abstraction
- **Memory Tables** — High-performance in-memory storage with MVCC
- **Store** — Persistent storage with KV/Pair (includes LevelDB and IndexedDB)
- **JSON Tables** — Direct JSON data querying capabilities
- **Custom Modules** — Extensible interface for any data source

## Packages

This repository contains multiple packages:

### Core
- **[`packages/quereus/`](packages/quereus/)** — Core SQL engine and runtime

### Storage
- **[`packages/quereus-store/`](packages/quereus-store/)** — Core store plugin (platform-agnostic interfaces and utilities)
- **[`packages/quereus-isolation/`](packages/quereus-isolation/)** — Transaction isolation layer for virtual table modules
- **[`packages/quereus-plugin-leveldb/`](packages/quereus-plugin-leveldb/)** — LevelDB storage backend for Node.js
- **[`packages/quereus-plugin-indexeddb/`](packages/quereus-plugin-indexeddb/)** — IndexedDB storage backend for browsers

### Sync
- **[`packages/quereus-sync/`](packages/quereus-sync/)** — Multi-master CRDT replication with automatic conflict resolution
- **[`packages/quereus-sync-client/`](packages/quereus-sync-client/)** — WebSocket sync client (connection management, reconnection, batching)
- **[`packages/sync-coordinator/`](packages/sync-coordinator/)** — Production-ready sync server/coordinator

### Tools
- **[`packages/plugin-loader/`](packages/plugin-loader/)** — Dynamic plugin loading system
- **[`packages/quoomb-web/`](packages/quoomb-web/)** — Web-based query interface and visualizer
- **[`packages/quoomb-cli/`](packages/quoomb-cli/)** — Command-line interface
- **[`packages/sample-plugins/`](packages/sample-plugins/)** — Sample plugins for testing and development

## Documentation

### Core Documentation
- **[SQL Reference](docs/sql.md)** — Comprehensive SQL dialect guide
- **[Built-in Functions](docs/functions.md)** — Complete function reference
- **[Virtual Tables](docs/memory-table.md)** — Virtual table system and memory tables
- **[Module Capability Negotiation](docs/module-capabilities.md)** — Every capability surface a virtual table module can implement, and what the engine does when it doesn't
- **[Runtime Architecture](docs/runtime.md)** — Execution engine internals

### Storage & Sync
- **[Persistent Store](docs/store.md)** — LevelDB/IndexedDB storage architecture
- **[View Persistence](docs/view-persistence.md)** — How the store keeps view and materialized-view definitions across reopen
- **[Schema Replication](docs/sync-schema.md)** — Replicating the catalog between peers, and shipping an app's initial schema as a seed
- **[Sync Protocol](docs/sync-protocol.md)** — Wire data structures, the `SyncManager` API, and the WebSocket message protocol
- **[Store Plugin base README](packages/quereus-store/README.md)** — Quick start and API reference

### Advanced Topics
- **[Query Optimizer](docs/optimizer.md)** — Query planning and optimization
- **[Usage Examples](docs/usage.md)** — Practical examples and patterns
- **[Documentation Conventions](docs/doc-conventions.md)** — What belongs in a design doc, and the checks that keep them honest

## Features

### SQL Capabilities
- **Full SELECT Support** — JOINs, subqueries, CTEs, window functions
- **Data Modification** — INSERT, UPDATE, DELETE with transaction support
- **Schema Operations** — CREATE/DROP tables, indexes, views
- **Advanced Features** — Recursive CTEs, constraints, savepoints

### Virtual Table Ecosystem
- **Memory Tables** — ACID-compliant in-memory storage with MVCC isolation
- **Persistent Storage** — LevelDB/IndexedDB with optional transaction isolation layer
- **JSON Processing** — Native JSON querying with `json_each()` and `json_tree()`
- **Function Tables** — Table-valued functions like `generate_series()`
- **Custom Modules** — Build your own data source integrations

### Performance & Reliability
- **Query Optimization** — Cost-based query planning with join reordering
- **MVCC Transactions** — Multi-version concurrency control for isolation
- **Efficient Execution** — Dependency-aware instruction scheduling
- **Memory Management** — Copy-on-write data structures with automatic cleanup

## Sync

Quereus Sync provides **fully opaque CRDT replication** — your application writes normal SQL and sync handles the rest. No special data types in your app code, no manual conflict wiring, no schema annotations.

```typescript
import { createSyncModule, createStoreAdapter } from '@quereus/sync';

// Sync plugs into your existing Quereus database and store module —
// inbound changes maintain secondary indexes, materialized views, and
// Database.watch subscriptions just like local writes
const { syncManager, syncEvents } = await createSyncModule(kv, storeEvents, {
  applyToStore: createStoreAdapter({ db, storeModule, events: storeEvents }),
  getTableSchema: (schema, table) => db.schemaManager.getTable(schema, table),
});

// Delta sync between replicas
const changes = await syncManager.getChangesSince(peerSiteId);
await syncManager.applyChanges(remoteChanges);
```

**What makes this different from other sync solutions:**

- **Opaque to app code** — Write normal `INSERT`/`UPDATE`/`DELETE`. No CRDT document types, no special APIs. Your app doesn't know sync exists.
- **Column-level conflict resolution** — Concurrent updates to different columns of the same row both apply. Same column uses Last-Write-Wins with hybrid logical clocks.
- **Schema sync** — DDL changes (`CREATE TABLE`, `ALTER TABLE`) propagate across replicas automatically.
- **Pure JavaScript** — No WASM runtime (unlike cr-sqlite). Same code runs in browser, Node.js, React Native.
- **Transport agnostic** — Bring your own WebSocket, HTTP, or WebRTC. The sync-client and coordinator packages provide a production-ready WebSocket implementation.
- **Snapshot + delta sync** — New replicas bootstrap via streaming snapshots with checkpoint/resume. Existing replicas use efficient delta sync.

See [`@quereus/sync` README](packages/quereus-sync/) for full API details.

## Use Cases

Quereus excels in scenarios where you need SQL capabilities without traditional database overhead:

- **Local-first apps** — Full SQL + sync on the client with offline support and multi-device replication
- **AI agent storage** — Embedded SQL engine for tool-using agents — structured working memory in the same JS process
- **Edge computing** — SQL processing in Cloudflare Workers, Deno Deploy, or serverless functions with no external DB
- **Data analysis** — ETL pipelines, data transformation, reporting with familiar SQL
- **Application logic** — Complex business rules expressed in SQL with constraints and assertions
- **Embedded analytics** — SQL queries over application data structures via virtual tables

## Contributing

We welcome contributions! Please see our [development guide](packages/quereus/README.md) for:

- Setting up the development environment
- Running tests and benchmarks  
- Code style and architectural guidelines
- Submitting issues and pull requests

### Development Quick Start

```bash
# Clone the repository
git clone https://github.com/gotchoices/quereus.git
cd quereus

# Install dependencies
yarn install

# Run tests
yarn test

# Build all packages
yarn build
```

## License

MIT License — see [LICENSE](LICENSE) for details.

## Status

Quereus is actively developed with the core SQL engine, storage plugins, and sync system all in production use. Ongoing work includes query optimizer improvements, additional virtual table modules, and extended SQL standard compliance.

For questions, issues, or discussions, please use [GitHub Issues](https://github.com/gotchoices/quereus/issues) or [Discussions](https://github.com/gotchoices/quereus/discussions).
