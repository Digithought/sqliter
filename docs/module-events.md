# Database-Level Event System

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

Quereus provides a unified event system at the database level that aggregates events from all modules. This enables reactive patterns where applications can subscribe to data and schema changes without knowing which specific modules are being used.

## How It Works

1. **Event Aggregation**: The `Database` class provides `onDataChange()` and `onSchemaChange()` methods that receive events from all modules
2. **Native Module Events**: Modules that implement their own event emitter (via `getEventEmitter()`) have their events automatically forwarded to the database level
3. **Automatic Events**: For modules without native event support, the engine automatically emits events after successful DML and DDL operations
4. **Transaction Batching**: Events are batched during transactions and only delivered after successful commit; on rollback, events are discarded
5. **Savepoint Support**: Events respect savepoint semantics - `ROLLBACK TO SAVEPOINT` discards events from that savepoint forward, while `RELEASE SAVEPOINT` merges them into the parent transaction

## Row-Shape, Table-Name, and Row-Key Contract Across Mid-Transaction ALTER

`oldRow` / `newRow` are positional — a consumer pairs value *i* with column *i* of the table's
schema. The delivered contract is: **every event's row images match the schema current at
delivery**, even when the transaction changed the table's column set (`ALTER TABLE ADD/DROP
COLUMN`), a column name (`RENAME COLUMN`), or column values (`SET DATA TYPE`, `SET NOT NULL`
backfill) *after* the write was recorded. `changedColumns` never names a column that no longer
exists — but it is only ever *re-derived*, never *introduced*: a module that omits it (the store
does, so the sync layer diffs the rows itself) still omits it after an ALTER.

Who upholds it depends on where the not-yet-delivered event sits at ALTER time:

- Events already inside the engine's transaction batch — the auto-event path, and any module
  that flushes its queue into the engine during the ALTER (the store module's coordinator
  commit does) — are rewritten by the engine itself: the ALTER arms call
  `DatabaseEventEmitter.remapBatchedDataEvents` after the module's `alterTable` returns.
  (`RENAME COLUMN` is in that set: the images need no rewrite, but `changedColumns` does.)
- Events a module still holds in its **own** queue across the ALTER and emits only at commit
  are the **module's responsibility**: a third-party module that queues events per-transaction
  must rewrite their row images inside its `alterTable` (the memory module reshapes its
  per-layer pending-change log this way — see `docs/memory-table.md` § DDL and transactions).
  The rewrite should be best-effort per image (an unconvertible historical image keeps its raw
  value; an ADD COLUMN image that defeats the backfill gets `NULL` in the new slot) — never
  fail the ALTER over an event image — and must not deduplicate the log: every recorded write
  is a separately delivered event.

The same as-of-delivery rule covers `tableName` across `ALTER TABLE … RENAME TO`: an event a
commit delivers names the table as it exists at delivery, never a name the rename retired. Row
images and `key` are untouched (a rename moves no value), so only the label changes. Same split
of responsibility as above:

- Events sitting in the engine's batch are relabelled by the engine — `runRenameTable` calls
  `DatabaseEventEmitter.renameBatchedEvents` after the module's `renameTable` returns, walking
  the base batch, every open savepoint layer, and the maintenance-collision channel (a
  materialized view can be renamed too).
- A module holding its own queue across the rename must either stamp the table name at emit
  time from its current name — what the memory module does, so it needs no relabel — or
  relabel its queue itself inside `renameTable`.

`key` follows the same rule across `ALTER TABLE … ALTER PRIMARY KEY`: a delivered event
identifies its row by the primary key the table has **at delivery**, so a consumer that
addresses rows by `key` (an incremental cache, the sync change log) can pair it with a row the
table now holds — a key left at the retired arity matches nothing, and the commit still reports
success. A column-index shift (`ADD`/`DROP`/`RENAME COLUMN`) needs no equivalent: `key` is a
value list, not an index list. Same split:

- Both arms of `runAlterPrimaryKey` call `DatabaseEventEmitter.rekeyBatchedDataEvents` after
  the module's `alterTable` (or the rebuild fallback) returns, walking the base batch and every
  open savepoint layer. Each new key is projected from that event's **own** image: `newRow` for
  an insert, `oldRow` for a delete, and for an update whichever image reproduces the recorded
  key under the retired key's columns. Best-effort like the image remap — no key, no usable
  image, or an image too short for the new key columns keeps the key as-is and logs.
- A module holding its own queue across the ALTER re-derives `key` itself, by the same rule.

Batched **schema** events are deliberately not relabelled. A schema event records a DDL
operation, not current state; relabelling its `objectName` without rewriting its `ddl` text
would produce an incoherent instruction, and how a rename should reach a replicating peer is
an open question tracked separately.

## Event Types

**Data Change Events** (`DatabaseDataChangeEvent`):
```typescript
interface DatabaseDataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  moduleName: string;       // Which module raised this event
  schemaName: string;
  tableName: string;
  key?: SqlValue[];         // Primary key values, under the key the table has at delivery
  oldRow?: Row;             // Previous values (update/delete)
  newRow?: Row;             // New values (insert/update)
  changedColumns?: string[]; // Column names that changed (update only)
  remote: boolean;          // true if from sync/remote source, false for local
}
```

**Schema Change Events** (`DatabaseSchemaChangeEvent`):
```typescript
interface DatabaseSchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'column';
  moduleName: string;       // Which module raised this event
  schemaName: string;
  objectName: string;
  columnName?: string;      // For column operations
  ddl?: string;             // DDL statement if available
  remote: boolean;          // true if from sync/remote source
}
```

## Subscribing to Events

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Subscribe to data changes
const unsubData = db.onDataChange((event) => {
  console.log(`${event.type} on ${event.schemaName}.${event.tableName}`);
  console.log(`Module: ${event.moduleName}, Remote: ${event.remote}`);
  
  if (event.type === 'update' && event.changedColumns) {
    console.log('Changed columns:', event.changedColumns);
  }
});

// Subscribe to schema changes
const unsubSchema = db.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
});

// Unsubscribe when done
unsubData();
unsubSchema();
```

## Module Integration

### For Modules with Native Events

If your module needs fine-grained control over event emission (e.g., for remote change tracking), implement `getEventEmitter()`:

```typescript
class MyModule implements VirtualTableModule<MyTable, MyConfig> {
  private eventEmitter = new DefaultVTableEventEmitter();
  
  getEventEmitter(): VTableEventEmitter {
    return this.eventEmitter;
  }
  
  // Your create/connect/destroy implementations...
}

class MyTable extends VirtualTable {
  constructor(private emitter: VTableEventEmitter, ...) {
    super(...);
  }
  
  getEventEmitter(): VTableEventEmitter {
    return this.emitter;
  }
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Perform the update...
    const result = await this.performUpdate(args);
    
    // Emit event with remote flag based on your logic
    this.emitter.emitDataChange?.({
      type: args.operation,
      schemaName: this.schemaName,
      tableName: this.tableName,
      key: this.extractKey(args),
      oldRow: args.operation !== 'insert' ? args.oldKeyValues : undefined,
      newRow: result,
      remote: this.isRemoteChange(), // Your logic for determining remote
    });
    
    return result;
  }
}
```

### For Modules without Native Events

If your module doesn't need custom event logic (e.g., remote change tracking), simply don't implement `getEventEmitter()`. The engine will automatically emit events for all successful DML operations. These auto-emitted events:

- Have `remote: false` (local changes only)
- Include all event fields (`key`, `oldRow`, `newRow`, `changedColumns`)
- Are batched within transactions and delivered after commit

## Remote vs Local Events

The `remote` field distinguishes the origin of changes:

- **`remote: false`** (local): Changes made through SQL execution on this database instance
- **`remote: true`** (remote): Changes that originated from sync replication or external sources

For modules with native events, set `remote: true` when applying changes received from sync:

```typescript
// In your sync handler
applyRemoteChange(change: RemoteChange): void {
  // Apply the change to storage...
  
  // Emit with remote: true
  this.emitter.emitDataChange?.({
    type: change.type,
    schemaName: this.schemaName,
    tableName: this.tableName,
    key: change.pk,
    newRow: change.values,
    remote: true, // Mark as remote
  });
}
```

## Event Semantics

1. **Timing**: Events are emitted after successful commit, never during rollback
2. **Ordering**: Events are delivered in the order operations occurred within a transaction
3. **Completeness**: All successful mutations generate events (either native or auto)
4. **Listener Errors**: Exceptions in listeners are logged but don't affect other listeners
5. **Listener Order**: Listeners are called in registration order
6. **Savepoints**: Events within a savepoint are tracked separately; `ROLLBACK TO SAVEPOINT` discards those events while `RELEASE SAVEPOINT` merges them into the parent

## Event Ordering Guarantees

When events are flushed after a commit:

- **Schema events are emitted before data events.** This ensures listeners see table creation before insertions into that table.
- **Within each category** (schema or data), events from nested savepoints are flattened into the parent transaction in the order they occurred.
- **Cross-layer chronological order may not be preserved.** If a transaction creates a table and then inserts data, the schema event fires first, then the data event — but if the transaction performs schema changes interleaved with data changes, the relative ordering between the two categories is not guaranteed to match wall-clock order.

## Listener Memory Management

Listeners hold strong references. Failing to unsubscribe causes the listener (and anything it closes over) to remain in memory for the lifetime of the `Database` instance.

**Best practices:**

- **Always call the returned unsubscribe function** when the listener is no longer needed. Store the unsubscribe function and call it in your component's cleanup or teardown path.
- **Clean up before discarding the Database instance.** Although `db.close()` removes all listeners internally, relying on that means leaked listeners persist until close. Explicitly unsubscribe to make resource ownership clear.
- **Use `setMaxListeners(n)`** to adjust the warning threshold if your application legitimately registers many listeners. Set to `0` to disable the warning. The default limit is 100 per event type — exceeding it logs a warning that may indicate a listener leak.

## See Also

- [Module Authoring Guide](module-authoring.md) - Implementing a virtual table module
- [Memory Table](memory-table.md) - The reference module's event behavior across DDL
