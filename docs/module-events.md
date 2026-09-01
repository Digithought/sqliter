# Database-Level Event System

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

Quereus provides a unified event system at the database level that aggregates events from all modules. This enables reactive patterns where applications can subscribe to data and schema changes without knowing which specific modules are being used.

## How It Works

1. **Event Aggregation**: The `Database` class provides `onDataChange()` and `onSchemaChange()` methods that receive events from all modules
2. **Native Module Events**: Modules that implement their own event emitter (via `getEventEmitter()`) have their events automatically forwarded to the database level
3. **Automatic Events**: For modules without native event support, the engine automatically emits events after successful DML operations and after the DDL statements listed under [For Modules without Native Events](#for-modules-without-native-events)
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
  open savepoint layer. Each new key is projected from that event's **own** image — the same
  rule the producers follow when they record the key in the first place: `newRow` for an insert
  or an update, `oldRow` for a delete. Best-effort like the image remap — no key, no usable
  image, or an image too short for the new key columns keeps the key as-is and logs.
- A module holding its own queue across the ALTER re-derives `key` itself, by the same rule.

Batched **schema** events are deliberately not relabelled. A schema event records a DDL
operation, not current state; relabelling its `objectName` without rewriting its `ddl` text
would produce an incoherent instruction. A consumer replays the schema events in order — the
rename is one of them, carrying its own `ddl` and the pre-rename name in `oldObjectName` — so
earlier events legitimately name the old table.

## Event Types

**Data Change Events** (`DatabaseDataChangeEvent`):
```typescript
interface DatabaseDataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  moduleName: string;       // Which module raised this event
  schemaName: string;
  tableName: string;
  key?: SqlValue[];         // Primary key projected from this event's OWN row image (newRow for
                            // insert/update, oldRow for delete), under the key the table has at
                            // delivery. An update never moves a row — a relocating PK change is
                            // delivered as delete-then-insert. See usage.md § Subscribing to Data Changes.
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
  oldObjectName?: string;   // Pre-rename table name (ALTER TABLE ... RENAME TO only)
  columnName?: string;      // For column operations
  oldColumnName?: string;   // Pre-rename column name (RENAME COLUMN only)
  ddl?: string;             // DDL statement if available — always set for ALTER TABLE
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

#### Don't hand-roll the `ALTER TABLE` event shape

A subscriber must see the same facts whichever backend holds the table, so the per-arm
`type` / `objectType` / `columnName` / `oldColumnName` of an `ALTER TABLE` announcement is a
contract, not a module's choice — see [usage.md § What each `ALTER TABLE` arm
reports](usage.md#what-each-alter-table-arm-reports) for the table. Derive it from the
`SchemaChangeInfo` you were handed with the exported `alterEventShape(change)` instead of
writing the triple out per arm; you supply only the rest of the event:

```typescript
import { alterEventShape } from '@quereus/quereus';

if (change.ddl !== undefined) {
  this.eventEmitter?.emitSchemaChange?.({
    ...alterEventShape(change),
    schemaName,
    objectName: tableName,   // the TABLE, even for a column arm
    ddl: change.ddl,
  });
}
```

Its `switch` is exhaustive over the arm union, so a new arm fails your build rather than
announcing the wrong shape. `RENAME TO` is not an arm of that union — it goes through
`renameTable` and reports `alter`/`table` with `oldObjectName` set to the pre-rename name.

#### A failed DDL statement announces nothing, even from a native emitter

A module emits its schema event from inside its own `create` / `alterTable` / `destroy`, which
is not the end of the statement — the engine may still do work that fails and unwinds
everything. Two cases in the tree today:

- `alter table … add column <inline constraint>` installs each constraint through further
  module calls after the `alterTable` that announced.
- `create table … maintained as` (and `create materialized view`) creates the backing table —
  your `create` announces it — and fills it afterwards; a body that violates the declaration
  drops the table again.

Your module does not have to detect that: the engine scopes **every** DDL statement's batched
schema events and **retracts** them when the statement throws
(`withStatementScopedSchemaEvents` in `runtime/emit/ddl-event-scope.ts`, over the emitter's
`beginSchemaEventScope`/`discardSchemaEventsSince` pair). Emit as usual; a statement that
unwound delivers no schema event on either path. Data events are not retracted — a module
that flushes earlier buffered writes during a DDL call would otherwise lose them.

The retraction reaches only events the module has already handed to the engine (the store and
memory modules emit theirs synchronously from inside the call). A module that instead holds
its schema events in its own queue and emits them at commit is past the scope by then, and
must drop a failed statement's own events itself — the same division of responsibility as the
row-image contract above.

**Carve-out: a partially-applied migration keeps what landed.** A declarative `apply schema`
is not scoped as one unit — it runs each generated migration statement through the ordinary
statement path, and a failure on the Nth leaves statements 1..N-1 applied with no catalog
rollback. Those really happened, so their events stay; each generated sub-statement carries
its own scope, so only the failing one retracts.

### For Modules without Native Events

If your module doesn't need custom event logic (e.g., remote change tracking), simply don't implement `getEventEmitter()`. The engine will automatically emit events for all successful DML operations, and for the DDL statements listed below. These auto-emitted events:

- Have `remote: false` (local changes only)
- Include all event fields (`key`, `oldRow`, `newRow`, `changedColumns`)
- Are batched within transactions and delivered after commit

#### DDL coverage of the auto path

The engine's fallback raises a schema-change event for the statements below — and, like every
other producer, **only when the statement succeeds** (see § [A failed DDL statement announces
nothing, even from a native emitter](#a-failed-ddl-statement-announces-nothing-even-from-a-native-emitter)):

- `CREATE TABLE` / `DROP TABLE` / `CREATE INDEX` / `DROP INDEX`
- **every structural `ALTER TABLE` arm** — `RENAME TO`, `RENAME COLUMN`, `ADD COLUMN`, `DROP COLUMN`, all four `ALTER COLUMN` attribute forms, `ALTER PRIMARY KEY`, `ADD CONSTRAINT`, `DROP CONSTRAINT`, `RENAME CONSTRAINT`

One event per statement, on its success path only, in the same shape a natively-emitting backend reports — see [usage.md § What each `ALTER TABLE` arm reports](usage.md#what-each-alter-table-arm-reports) for the per-arm table. The engine emits at the *end* of the arm (after its catalog swap), where a natively-emitting module emits from inside its own `alterTable`; the ordering difference is not observable, since each arm produces one event and delivery is batched to commit.

Two `ALTER TABLE` arm families are **excluded** on both paths, so no asymmetry is introduced:

- the metadata-tag arms (`SET TAGS`, `ADD TAGS`, `DROP TAGS`) — catalog-only; they never reach `module.alterTable`, and no backend announces them
- the materialized-view lifecycle arms (`SET MAINTAINED`, `DROP MAINTAINED`) — these raise only *internal* catalog notifications (`materialized_view_added` / `_modified` / `_removed`)

The `ALTER TABLE` arms are the exception to the auto path's usual silence about statement text: they **do** carry `ddl` (the planner renders the statement's canonical, schema-qualified SQL once at plan-build time and every arm passes it through), so a table alteration replicates from a module with no emitter of its own. The `CREATE`/`DROP TABLE` and `CREATE`/`DROP INDEX` auto events carry none — the fallback has only the schema/object names at those emit sites — so a module that needs *those* replicated should implement its own emitter and render the DDL itself, as the memory and store modules do.

### Engine-Internal Scaffolding Is Silent

A few statements the engine issues on its own behalf are not statements the application made, and are deliberately invisible on both channels. The engine runs them inside a suppression scope (`DatabaseEventEmitter.withPublicEventsSuppressed`): while it is open, no auto event is generated, and an event forwarded from a module's own emitter is discarded (with a debug log line) instead of delivered or batched.

Today there is exactly one such scope: the shadow-table rebuild behind `ALTER TABLE … ALTER PRIMARY KEY` on a module that cannot re-key in place. It creates a shadow table with the new key, copies every row into it, drops the original, renames the shadow over it, and re-creates the table's user indexes — none of which is a change the application asked for, so a subscriber hears nothing about any of it. (The `ALTER PRIMARY KEY` statement's own `alter`/`table` event is raised *outside* the scope, so the re-key itself still reports.) See [sql-alter.md § ALTER PRIMARY KEY](sql-alter.md) for the user-facing consequence.

What this means for a module with a native emitter:

- **Emit during the write, not at your own commit.** Events you emit while the engine's statement is executing are correctly suppressed. Events you defer to a later tick or to your own commit callback arrive after the scope has closed and would leak the rebuild's row copy to subscribers.
- Suppression covers only the application-facing channels. The internal catalog-change notifier keeps firing, so cached schemas are invalidated normally and the rebuilt table is immediately usable under its new key.

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
3. **Completeness**: All successful mutations generate events (either native or auto), with one deliberate exception — see [Engine-internal scaffolding is silent](#engine-internal-scaffolding-is-silent)
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
