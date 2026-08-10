# Transaction Coordinator Architecture

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

> **Current implementation note (module-scoped, no isolation).** The text below
> describes the original connection-scoped *isolation* design. The shipped
> `@quereus/store` coordinator differs in two ways the rest of this doc predates:
> (1) it is **one coordinator per storage module**, shared by every table the
> module owns — the unit of *cross-table atomicity* (a transaction touching
> several of the module's tables commits/rolls back as one all-or-nothing batch),
> not per-table; and (2) every op is addressed by its explicit target `KVStore`
> handle — there is no default-store bucket and no `getStore()` accessor (read
> paths pass the data-store handle explicitly). The bare store module reports
> `isolation: false` (`getCapabilities`); cross-connection isolation is layered by
> `IsolationModule`, not by this coordinator. Read the sections below for the
> mutation/commit/savepoint mechanics, with those two corrections in mind.

The Transaction Coordinator provides transaction support for virtual table modules. It enables multiple concurrent operations to work with coherent commit/rollback and savepoint semantics.

## Problem Statement

Virtual table modules (like `@quereus/store`) need transaction support for:
- **Atomicity**: Multiple mutations commit or rollback together
- **Isolation**: Concurrent operations don't see each other's uncommitted changes
- **Durability**: Committed changes persist to the underlying storage

The challenge is that a single `Database` instance may have multiple concurrent async operations, each expecting independent transaction semantics. A naive singleton transaction manager causes race conditions:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PROBLEM: Shared Transaction State                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Operation A (main flow)           Operation B (background)              │
│  ────────────────────────          ─────────────────────────            │
│  1. begin() → inTransaction=true                                         │
│  2. put(key1, val1)                                                      │
│                                    3. begin() → no-op (already true)     │
│                                    4. put(key2, val2)                    │
│                                    5. commit() → inTransaction=false ❌  │
│  6. put(key3, val3) → ERROR!                                             │
│     "Cannot queue outside transaction"                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

Operation B's commit clears the shared `inTransaction` flag, causing Operation A to fail unexpectedly.

## Architecture Overview

The solution separates transaction **state** (per-connection) from transaction **coordination** (shared):

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Quereus Database                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Connection Registry                             │  │
│  │  connectionId → VirtualTableConnection                            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│           │                    │                    │                    │
│           ▼                    ▼                    ▼                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  Connection A   │  │  Connection B   │  │  Connection C   │         │
│  │  (main flow)    │  │  (background)   │  │  (query)        │         │
│  │                 │  │                 │  │                 │         │
│  │  pendingOps: [] │  │  pendingOps: [] │  │  (read-only)    │         │
│  │  savepoints: {} │  │  savepoints: {} │  │                 │         │
│  │  inTxn: true    │  │  inTxn: true    │  │  inTxn: false   │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                    │
│           └────────────────────┼────────────────────┘                    │
│                                ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                   Transaction Coordinator                          │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │  Shared Resources                                            │  │  │
│  │  │  • KVStore reference (for reads and final writes)           │  │  │
│  │  │  • Event emitter (for change notifications)                 │  │  │
│  │  │  • Connection registry (tracks active transactions)         │  │  │
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                │                                         │
│                                ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                        KVStore                                     │  │
│  │  (LevelDB, IndexedDB, or custom backend)                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Connection-Scoped Transaction State

Each `StoreConnection` owns its transaction state:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  StoreConnection                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  connectionId: string          Unique identifier for this connection     │
│  coordinator: Coordinator      Reference to shared coordinator           │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Transaction State (private to this connection)                  │    │
│  ├─────────────────────────────────────────────────────────────────┤    │
│  │  inTransaction: boolean     Whether a transaction is active      │    │
│  │  pendingOps: PendingOp[]    Buffered put/delete operations      │    │
│  │  pendingEvents: Event[]     Queued change events (fire on commit)│    │
│  │  savepoints: Map<id, Snap>  Savepoint snapshots                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Methods:                                                                │
│  ─────────                                                               │
│  begin()              Start transaction (sets inTransaction=true)        │
│  put(key, value)      Queue write to pendingOps                         │
│  delete(key)          Queue delete to pendingOps                        │
│  commit()             Write pendingOps atomically, fire events          │
│  rollback()           Discard pendingOps and events                     │
│  createSavepoint(id)  Snapshot current pendingOps/events indices        │
│  rollbackTo(id)       Truncate to savepoint snapshot                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Isolation Level: Read Committed

The coordinator implements **Read Committed** isolation:

| Behavior | Description |
|----------|-------------|
| **Reads** | Always see the latest committed data from the KVStore |
| **Writes** | Buffered in connection-local `pendingOps` until commit |
| **Own writes** | A connection can read its own uncommitted writes |
| **Commit** | Writes batch atomically to KVStore |
| **Rollback** | Discards pending operations without touching KVStore |

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Read Committed Isolation                                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Connection A                    Connection B                            │
│  ────────────                    ────────────                            │
│  begin()                                                                 │
│  put(k1, v1)                                                             │
│                                  begin()                                 │
│                                  get(k1) → undefined (not committed)     │
│  commit()                                                                │
│                                  get(k1) → v1 ✓ (now visible)            │
│                                  commit()                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Read-Your-Own-Writes

A connection sees its own uncommitted changes:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Read-Your-Own-Writes                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Connection A                                                            │
│  ────────────                                                            │
│  begin()                                                                 │
│  put(k1, "new value")                                                    │
│  get(k1) → "new value" ✓  (sees own pending write)                       │
│  rollback()                                                              │
│  get(k1) → "old value"    (rollback discarded the write)                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Transaction Flow

### Begin Transaction

```
┌─────────────────────────────────────────────────────────────────────────┐
│  begin()                                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Check if already in transaction (no-op if true)                      │
│  2. Set inTransaction = true                                             │
│  3. Initialize empty pendingOps and pendingEvents arrays                 │
│  4. Register with coordinator as active transaction                      │
│                                                                          │
│  Connection State After:                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  inTransaction: true                                             │    │
│  │  pendingOps: []                                                  │    │
│  │  pendingEvents: []                                               │    │
│  │  savepoints: {}                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Queue Operations

```
┌─────────────────────────────────────────────────────────────────────────┐
│  put(key, value) / delete(key)                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Verify inTransaction is true (throw if false)                        │
│  2. Append operation to pendingOps                                       │
│                                                                          │
│  Connection State After put(k1,v1), put(k2,v2), delete(k3):              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  pendingOps: [                                                   │    │
│  │    { type: 'put', key: k1, value: v1 },                         │    │
│  │    { type: 'put', key: k2, value: v2 },                         │    │
│  │    { type: 'delete', key: k3 }                                  │    │
│  │  ]                                                               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Commit Transaction

```
┌─────────────────────────────────────────────────────────────────────────┐
│  commit()                                                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. If not in transaction, return (no-op)                                │
│  2. Create WriteBatch from pendingOps                                    │
│  3. Write batch atomically to KVStore                                    │
│  4. Fire all pendingEvents to event emitter                              │
│  5. Clear transaction state                                              │
│  6. Unregister from coordinator                                          │
│                                                                          │
│  ┌─────────────────┐                                                     │
│  │  pendingOps     │────▶ WriteBatch ────▶ KVStore.batch().write()       │
│  └─────────────────┘                                                     │
│                                                                          │
│  ┌─────────────────┐                                                     │
│  │  pendingEvents  │────▶ eventEmitter.emitDataChange(event)             │
│  └─────────────────┘                                                     │
│                                                                          │
│  Connection State After:                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  inTransaction: false                                            │    │
│  │  pendingOps: []                                                  │    │
│  │  pendingEvents: []                                               │    │
│  │  savepoints: {}                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Rollback Transaction

```
┌─────────────────────────────────────────────────────────────────────────┐
│  rollback()                                                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. If not in transaction, return (no-op)                                │
│  2. Discard pendingOps (no KVStore interaction)                          │
│  3. Discard pendingEvents                                                │
│  4. Clear transaction state                                              │
│  5. Unregister from coordinator                                          │
│                                                                          │
│  ┌─────────────────┐                                                     │
│  │  pendingOps     │────▶ (discarded, nothing written)                   │
│  └─────────────────┘                                                     │
│                                                                          │
│  Connection State After: (same as commit)                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  inTransaction: false                                            │    │
│  │  pendingOps: []                                                  │    │
│  │  pendingEvents: []                                               │    │
│  │  savepoints: {}                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Savepoint Support

Savepoints create nested snapshots within a transaction:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Savepoint Operations                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  createSavepoint(id)                                                     │
│  ──────────────────                                                      │
│  1. If not in transaction, begin one implicitly                          │
│  2. Record current indices: { opIndex, eventIndex }                      │
│  3. Store in savepoints map                                              │
│                                                                          │
│  rollbackToSavepoint(id)                                                 │
│  ────────────────────────                                                │
│  1. Find savepoint snapshot                                              │
│  2. Truncate pendingOps to opIndex                                       │
│  3. Truncate pendingEvents to eventIndex                                 │
│  4. Remove this and later savepoints                                     │
│                                                                          │
│  releaseSavepoint(id)                                                    │
│  ───────────────────                                                     │
│  1. Remove savepoint from map (no-op, operations remain)                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Savepoint Example

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Savepoint Flow                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  begin()                                                                 │
│  put(k1, v1)                    pendingOps: [put(k1,v1)]                 │
│  put(k2, v2)                    pendingOps: [put(k1,v1), put(k2,v2)]     │
│                                                                          │
│  createSavepoint(1)             savepoints: {1: {opIndex:2, eventIndex:0}}│
│                                                                          │
│  put(k3, v3)                    pendingOps: [..., put(k3,v3)]            │
│  delete(k4)                     pendingOps: [..., delete(k4)]            │
│                                                                          │
│  rollbackToSavepoint(1)         pendingOps: [put(k1,v1), put(k2,v2)] ✓   │
│                                 (k3 and k4 operations discarded)         │
│                                                                          │
│  commit()                       Only k1 and k2 are persisted             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Coordinator Role

The `TransactionCoordinator` manages shared resources and coordinates commits:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TransactionCoordinator                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Responsibilities:                                                       │
│  ─────────────────                                                       │
│  • Hold reference to shared KVStore                                      │
│  • Hold reference to event emitter                                       │
│  • Track active connections with pending transactions                    │
│  • Provide KVStore access for reads                                      │
│  • Execute atomic writes on behalf of connections                        │
│                                                                          │
│  NOT Responsible For:                                                    │
│  ────────────────────                                                    │
│  • Transaction state (owned by connections)                              │
│  • Pending operations (owned by connections)                             │
│  • Savepoints (owned by connections)                                     │
│                                                                          │
│  Interface:                                                              │
│  ──────────                                                              │
│  getStore(): KVStore                                                     │
│  commitBatch(ops: PendingOp[]): Promise<void>                           │
│  emitEvents(events: DataChangeEvent[]): void                            │
│  registerActiveTransaction(connectionId: string): void                  │
│  unregisterTransaction(connectionId: string): void                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Multi-Table Transactions

The Quereus `Database` class coordinates transactions across multiple tables:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Multi-Table Transaction Flow                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  SQL: BEGIN;                                                             │
│       INSERT INTO users VALUES (1, 'Alice');                             │
│       INSERT INTO orders VALUES (100, 1, 50.00);                         │
│       COMMIT;                                                            │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Database._beginImplicitTransaction()                            │    │
│  │  ├── connection_users.begin()                                    │    │
│  │  └── connection_orders.begin()                                   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  INSERT INTO users...                                            │    │
│  │  └── connection_users.put(user_key, user_row)                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  INSERT INTO orders...                                           │    │
│  │  └── connection_orders.put(order_key, order_row)                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Database._commitImplicitTransaction()                           │    │
│  │  ├── connection_users.commit()   → WriteBatch to users store     │    │
│  │  └── connection_orders.commit()  → WriteBatch to orders store    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Note: Each table's commit is atomic, but cross-table atomicity          │
│  depends on the underlying storage backend (e.g., single IDB database).  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Write Conflict Handling

With Read Committed isolation, write conflicts are possible:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Write Conflict Scenario                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Connection A                    Connection B                            │
│  ────────────                    ────────────                            │
│  begin()                         begin()                                 │
│  get(k1) → "v1"                  get(k1) → "v1"                          │
│  put(k1, "v2")                   put(k1, "v3")                           │
│  commit() ✓                      commit() ✓                              │
│                                                                          │
│  Final value of k1: "v3" (last writer wins)                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Conflict Resolution Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| **Last Writer Wins** | Default - later commit overwrites | Simple, eventual consistency |
| **Optimistic Locking** | Check version/timestamp before commit | Detect conflicts, retry |
| **Pessimistic Locking** | Lock rows during transaction | Prevent conflicts |

The coordinator implements **Last Writer Wins** by default. Applications requiring stronger guarantees should implement optimistic locking at the application layer using version columns or timestamps.

## Module Author Integration

Virtual table module authors can integrate with the coordinator:

### 1. Implement StoreConnection

```typescript
class MyStoreConnection implements VirtualTableConnection {
  private coordinator: TransactionCoordinator;
  private inTransaction = false;
  private pendingOps: PendingOp[] = [];
  private pendingEvents: DataChangeEvent[] = [];
  private savepoints: Map<number, Savepoint> = new Map();

  begin(): void {
    if (this.inTransaction) return; // Already in transaction
    this.inTransaction = true;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepoints.clear();
  }

  put(key: Uint8Array, value: Uint8Array): void {
    if (!this.inTransaction) {
      throw new Error('Cannot queue operation outside transaction');
    }
    this.pendingOps.push({ type: 'put', key, value });
  }

  async commit(): Promise<void> {
    if (!this.inTransaction) return;
    try {
      await this.coordinator.commitBatch(this.pendingOps);
      this.coordinator.emitEvents(this.pendingEvents);
    } finally {
      this.clearTransaction();
    }
  }

  rollback(): void {
    if (!this.inTransaction) return;
    this.clearTransaction();
  }

  private clearTransaction(): void {
    this.inTransaction = false;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepoints.clear();
  }
}
```

### 2. Use Coordinator for Reads

```typescript
async get(key: Uint8Array): Promise<Uint8Array | undefined> {
  // First check pending writes (read-your-own-writes)
  for (let i = this.pendingOps.length - 1; i >= 0; i--) {
    const op = this.pendingOps[i];
    if (keysEqual(op.key, key)) {
      return op.type === 'put' ? op.value : undefined;
    }
  }
  // Fall back to committed data
  return this.coordinator.getStore().get(key);
}
```

### 3. Register Connection with Database

The Quereus `Database` class manages connections and coordinates transaction lifecycle:

```typescript
// During table access
const connection = await table.createConnection();
await db.registerConnection(connection);

// Database coordinates begin/commit/rollback across all connections
await db._beginImplicitTransaction();  // Calls begin() on all connections
// ... execute SQL ...
await db._commitImplicitTransaction(); // Calls commit() on all connections
```

## Comparison with Memory VTable Layers

The memory virtual table uses a different isolation model based on **copy-on-write layers**:

| Aspect | Store Coordinator | Memory Layers |
|--------|-------------------|---------------|
| **Isolation** | Read Committed | Snapshot Isolation |
| **Uncommitted reads** | Not visible to others | Not visible to others |
| **Committed reads** | Immediately visible | Visible after layer promotion |
| **Storage** | Pending ops in memory | Full layer snapshots |
| **Memory usage** | O(mutations) | O(data size) |
| **Best for** | Persistent storage | In-memory tables |

The layer-based approach provides stronger isolation but requires more memory. The coordinator approach is better suited for persistent storage where the KVStore already provides durability.

## Future Enhancements

### Repeatable Read Isolation

For applications requiring consistent reads within a transaction:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Repeatable Read (Future)                                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Option 1: Read Cache                                                    │
│  ─────────────────────                                                   │
│  Cache reads within transaction; return cached value on re-read.         │
│  Pro: Simple. Con: Memory grows with reads.                              │
│                                                                          │
│  Option 2: Snapshot Iterator                                             │
│  ───────────────────────────                                             │
│  Take KVStore snapshot at transaction start.                             │
│  Pro: True isolation. Con: Requires backend support.                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Serializable Isolation

For applications requiring full serializability:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Serializable (Future)                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Option 1: Pessimistic Locking                                           │
│  ─────────────────────────────                                           │
│  Lock keys on first access; hold until commit/rollback.                  │
│  Pro: No conflicts. Con: Reduced concurrency.                            │
│                                                                          │
│  Option 2: Serializable Snapshot Isolation (SSI)                         │
│  ───────────────────────────────────────────────────────────             │
│  Track read/write sets; detect conflicts at commit time.                 │
│  Pro: High concurrency. Con: Complex implementation.                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## TODO

### Phase 1: Core Refactoring

- [ ] **Move transaction state from `TransactionCoordinator` to `StoreConnection`**
  - Add `inTransaction`, `pendingOps`, `pendingEvents`, `savepoints` fields to `StoreConnection`
  - Update `begin()`, `commit()`, `rollback()` to operate on connection-local state
  - Update savepoint methods to use connection-local savepoints map

- [ ] **Refactor `TransactionCoordinator` to be a shared resource manager**
  - Remove `inTransaction` flag (now per-connection)
  - Remove `pendingOps` and `pendingEvents` (now per-connection)
  - Add `commitBatch(ops: PendingOp[]): Promise<void>` method
  - Add `emitEvents(events: DataChangeEvent[]): void` method
  - Keep `getStore()` for read access

- [ ] **Update `StoreTable.update()` to use connection-scoped transactions**
  - Get coordinator from connection instead of table
  - Queue operations to connection's pendingOps
  - Support both transactional and non-transactional (auto-commit) modes

### Phase 2: Read-Your-Own-Writes

- [ ] **Implement pending write lookup in `StoreConnection.get()`**
  - Search pendingOps in reverse order for key
  - Return pending value if found, otherwise delegate to KVStore
  - Handle delete operations (return undefined)

- [ ] **Update `StoreTable.query()` to check pending writes**
  - For point lookups, check connection's pending writes first
  - For range scans, merge pending writes with KVStore results
  - Maintain correct sort order when merging

### Phase 3: Testing

- [ ] **Add concurrent transaction isolation tests**
  - Two connections modifying different keys (should not interfere)
  - Two connections modifying same key (last writer wins)
  - Connection A commits while B is still in transaction
  - Rollback only affects the rolling-back connection

- [ ] **Add savepoint isolation tests**
  - Savepoint rollback only affects that connection
  - Savepoint in connection A doesn't affect connection B

- [ ] **Add read-your-own-writes tests**
  - Connection sees its uncommitted writes
  - Other connections don't see uncommitted writes
  - After commit, all connections see the writes

### Phase 4: Documentation

- [ ] **Update `store.md` to reference coordinator architecture**
- [ ] **Add integration examples for module authors**
- [ ] **Document migration path for existing code**

### Phase 5: Future Enhancements (Deferred)

- [ ] **Optimistic locking support** (version columns, conflict detection)
- [ ] **Repeatable Read isolation** (read cache or snapshot iterator)
- [ ] **Cross-table atomicity** for IndexedDB single-database mode
- [ ] **Metrics and observability** (transaction duration, conflict rate)
