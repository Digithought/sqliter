# Virtual Table Module Authoring Guide

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

This guide provides documentation for implementing virtual table modules in Quereus. It covers the architecture, optimization integration, and best practices for module authors.

## Overview

Virtual table modules are the primary extension point for custom data sources in Quereus. A module implements the `VirtualTableModule` interface and provides instances of `VirtualTable` that handle data access, updates, and query optimization.

### Key Concepts

- **Module**: Factory that creates table instances; implements `create()`, `connect()`, and optimization methods
- **Table Instance**: Represents a specific table; implements `query()`, `update()`, and transaction support
- **Optimization Integration**: Modules communicate capabilities to the optimizer via `BestAccessPlan` API or `supports()` method
- **Retrieve Boundary**: The optimizer wraps all table references in `RetrieveNode`, marking where data transitions from module execution to Quereus execution

## Architecture: Retrieve-Based Push-down

### The Retrieve Node Boundary

Every table reference is automatically wrapped in a `RetrieveNode` at build time:

```
RetrieveNode (optimizer boundary)
  └─ pipeline: RelationalPlanNode (module-supported operations)
      └─ TableReferenceNode (leaf table reference)
```

**Key principle**: Operations inside the `RetrieveNode` pipeline are executed by the module; operations above are executed by Quereus.

### How Push-down Works

1. **Predicate Normalization**: The optimizer normalizes filter predicates and extracts constraints
2. **Supported-only Placement**: Only predicates the module can handle are pushed into the `Retrieve` pipeline
3. **Residual Predicates**: Unsupported predicates remain above the `Retrieve` boundary
4. **Binding Capture**: Parameters and correlated column references are captured in `Retrieve.bindings`

Example:
```sql
select * from users where id = 1 and name like 'A%' and age > 30;
```

If the module supports equality on `id` but not LIKE or range comparisons:
```
Filter (name LIKE 'A%' AND age > 30)  ← Quereus executes
  └─ Retrieve
      └─ Filter (id = 1)              ← Module executes
          └─ TableReference
```

### Retrieve Node Structure

The `RetrieveNode` contains:
- **pipeline**: The operations the module will execute (initially just `TableReferenceNode`, but grows as predicates are pushed down)
- **bindings**: Parameters and correlated column references captured from pushed-down operations

At runtime:
1. Bindings are evaluated to produce concrete values
2. The module receives these values via `FilterInfo.args` (for index-based) or as part of the plan (for query-based)
3. The module executes the pipeline and returns rows
4. Quereus applies any residual operations above the `Retrieve` boundary

### Supported-only Placement Policy

The optimizer enforces a strict policy: **only operations the module can handle are placed inside the Retrieve boundary**. This is determined by:

1. **For query-based modules**: The `supports()` method returns a result
2. **For index-based modules**: The `getBestAccessPlan()` method marks filters as handled via `handledFilters` array

If a module claims to handle an operation but fails at runtime, data corruption can result. Always be conservative in capability reporting. See *Claiming `handledFilters`* below for the exact per-column, per-role rule the planner applies.

## Module Capability APIs

Modules communicate their capabilities through two complementary interfaces:

### 1. Query-Based Push-down (Advanced)

Implement `supports()` to analyze entire query pipelines:

```typescript
interface VirtualTableModule {
  supports?(node: PlanNode): SupportAssessment | undefined;
}

interface SupportAssessment {
  cost: number;           // Module's cost estimate
  ctx?: unknown;          // Opaque context for runtime
}
```

**When to use**: SQL federation, document databases, remote APIs that can execute complex queries.

**Important**: If `supports()` returns a result, the module **must** implement `executePlan()` to execute the pipeline. The optimizer will call `executePlan()` at runtime with the same plan node and context.

**Example**: A PostgreSQL federation module analyzing a Filter+Project+Sort pipeline:
```typescript
supports(node: PlanNode): SupportAssessment | undefined {
  if (node instanceof FilterNode) {
    // Check if predicate is SQL-compatible
    if (this.canTranslatePredicate(node.predicate)) {
      return { cost: 10, ctx: { sql: this.generateSQL(node) } };
    }
  }
  return undefined; // Can't handle this pipeline
}

// At runtime, executePlan() receives the same node and ctx
async* executePlan(db: Database, node: PlanNode, ctx?: unknown): AsyncIterable<Row> {
  const sql = (ctx as any)?.sql;
  // Execute the SQL against the remote database
  const results = await this.executeRemoteSQL(sql);
  for (const row of results) {
    yield row;
  }
}
```

### 2. Index-Based Access (Standard)

Implement `getBestAccessPlan()` to expose index capabilities:

```typescript
interface VirtualTableModule {
  getBestAccessPlan?(
    db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult;
}

interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: OrderingSpec;
  limit?: number | null;
  estimatedRows?: number;
}

interface BestAccessPlanResult {
  handledFilters: readonly boolean[];  // Which filters the module handles
  cost: number;                        // Cost estimate
  rows: number | undefined;            // Cardinality estimate
  providesOrdering?: readonly OrderingSpec[]; // If module provides ordering
  indexName?: string;                  // Name of the chosen index ('_primary_' or a secondary)
  indexDescriptor?: IndexDescriptor;   // Structured identity of that index (see below)
  seekColumnIndexes?: readonly number[]; // Columns forming the seek key
  isSet?: boolean;                     // If result is guaranteed unique
  explains?: string;                   // Free-text explanation for debugging
  residualFilter?: (row: any) => boolean; // Optional JS filter for residual predicates

  // Optional monotonic-storage advertisements. The optimizer lifts these onto
  // the physical leaf node's `physical.monotonicOn` / `physical.accessCapabilities`
  // and downstream rules use them to license rewrites that depend on
  // total-order emit (streaming asof, monotonic merge join, ordinal-seek
  // pushdown). Not propagated through pass-through nodes.
  monotonicOn?: { columnIndex: number; direction: 'asc' | 'desc'; strict: boolean };
  supportsOrdinalSeek?: boolean;       // Implies monotonicOn; O(log N) seek to kth row
  supportsAsofRight?: boolean;         // Implies monotonicOn; forward-only repositioning
}
```

**Capability contracts**:
- `monotonicOn` is the leaf's natural emit order (storage property, not request-dependent). Stronger than `providesOrdering` — implies a total order with no gaps in coverage.
- `supportsOrdinalSeek` enables the `monotonic-limit-pushdown` rule: when advertised, the runtime may stamp `FilterInfo.offset`/`FilterInfo.limit` and the module must seek directly to the kth monotonic row (see `query()` contract above). Modules that advertise `supportsOrdinalSeek` but ignore the directives at runtime degrade to a streaming `LIMIT` (the rule's slice operator enforces the cap above the leaf).
- `supportsAsofRight` enables the `lateral-top1-asof` rule: forward-only repositioning per left row.

**Claiming `handledFilters` — the positional contract**:

A module may set `handledFilters[i] = true` only for a filter it will actually apply.
For the seek-family operators (`=`, `IN`, `<`, `<=`, `>`, `>=`, `OR_RANGE`) the planner
consumes at most one filter per column per role — the first `=`, the first lower bound,
the first upper bound, **in `request.filters` order**. Claim positionally: mark the first
match, leave redundant same-column same-role filters unhandled so they survive as a
residual `Filter`. The planner defends itself against an over-claim by reattaching any
seek-family filter it did not consume, so an over-claiming module costs a redundant
filter, not a wrong answer.

Three corollaries worth spelling out:

- **Count distinct columns, not filters.** `a = 1 and a = 2` on a composite primary key
  `(a, b)` is *not* a full key match. Deduplicate by `columnIndex` before deciding that
  every key column is pinned.
- **Only claim what you can seek.** A range on a non-leading key column, for instance,
  is not turned into a bound; leave it unhandled.
- **A range bound is seeked only on the leading seek column.** A range on a later seek
  column is usable only as the trailing bound of a prefix seek, and only when every
  preceding seek column is pinned by a *single-valued* equality (`a = 1`, or `a in (1)`
  — not `a in (1, 2)`). Otherwise the planner declines the seek entirely and scans.

**Runtime-valued `IN` sets**:

`where col in (select …)` has no plan-time values. It arrives with `op: 'IN'`, **no
`value`**, and `runtimeSet: { maxCount, estimatedCount? }` instead — *"an `IN` over
`columnIndex` with 1..`maxCount` values I cannot name"*. The two fields are mutually
exclusive; `estimatedCount` is an advisory integer in `0..maxCount`.

Accepting it (`handledFilters[i] = true`, plus `indexName` and `seekColumnIndexes`)
promises one thing: you can serve that column as a multi-seek on the named index. In
return, `query()` gets an ordinary `plan=5` multi-seek `FilterInfo` — `K` EQ constraints
and `K` values in `args`, `1 ≤ K ≤ maxCount` — indistinguishable from a literal list, so
**your runtime does not change**. The engine, not the module, enforces `maxCount`: an empty
or oversized set falls back to a scan and never reaches you. Only single-column runtime
sets exist today.

Declining is always correct; only the speed-up is lost. A module predating `runtimeSet`
declines automatically, since `Array.isArray(f.value) && f.value.length > 0` is false.

If you accept one: never claim `providesOrdering` or `monotonicOn` over its column (a
multi-seek walks in seek-key order, so the planner would elide a `Sort` it needs), and
apply your existing safety gates — collation windows that may under-fetch, semantically
compared seek columns, your own cross-product cap — against `maxCount`, the worst case you
could be handed. Use the exported `equalitySeekKeyCount(filter)` (seek keys it contributes
as an equality, or `null` when it fills no equality role) and `isMultiValueEquality(filter)`
rather than re-deriving the four `IN` shapes.

**Naming the chosen index — `indexName` and `indexDescriptor`**:

When a module sets `indexName` (and `seekColumnIndexes`) the engine records the choice on
the physical leaf as both a text `idxStr` and a structured `FilterInfo.accessPath`. Order-
sensitive consumers — most importantly the transaction-isolation overlay, which must merge
its per-connection changes in the *same sort order the underlying scan emits* — read the
structured form to learn what the index actually is: whether it is the primary key, its full
key columns, and whether it is unique.

The engine resolves that structure itself in two cases:

- `indexName` is `_primary_` (the primary key), or
- `indexName` matches an index present in `tableInfo.indexes` (case-insensitive).

If your module names the index anything else — most commonly a **per-plan alias** for the
primary key, e.g. `_primary_1`, minted so a downstream layer can recover which plan produced
a given scan — the engine cannot resolve it from the schema. You **must** then also return an
`indexDescriptor`:

```typescript
interface IndexDescriptor {
  name: string;                 // must equal the plan's indexName
  role: 'primary' | 'secondary';
  keyColumns: readonly { columnIndex: number; desc: boolean; collation?: string }[]; // FULL key, in index order
  unique: boolean;
  reverse?: boolean;            // true ⇒ the scan walks this index in reverse of keyColumns order
}
```

`role` is authoritative, not `name`: a descriptor with `role: 'primary'` **is** the primary
key however it is named. `validateAccessPlan` rejects a descriptor whose `name` disagrees with
the plan's index name.

Scan **direction** matters to the same order-sensitive consumers: a module whose `idxStr` already
encodes direction (the in-memory vtab's `ordCons=DESC` convention) needs nothing extra, but a
module that carries direction only in an opaque per-plan index name — minting a distinct name per
scan direction rather than writing a direction marker anywhere text-visible — **must** set
`reverse: true` on the descriptor for a reversed scan. Otherwise an emission-order consumer (the
isolation overlay's merged read) has no way to learn the underlying stream is reversed and merges
it against a forward comparator, scrambling row order.

**Multi-seek key order is a hard requirement, independent of `providesOrdering`.** A
`multiSeek` access path (`plan=5`) must emit its rows in the scanned index's own key
order, never in seek-argument order (the order the `IN` list appears in the SQL text, or
a runtime set's iteration order) — even though the guidance above says not to *claim*
`providesOrdering` over such a plan. The transaction-isolation overlay's merge assumes an
index access path emits in index-key order for any plan kind whose resolved index has
`role: 'primary'` or names a known secondary index (see Scan direction, above, for the
`reverse` half of the same contract); it mis-pairs overlay rows against stale stored rows
when that assumption is violated (fix/bug-isolation-multiseek-merge-order). Both shipped
backends (the in-memory table and the persistent store) sort their multi-seek keys under
the index's own key comparator before visiting them for exactly this reason. A module
whose multi-seek does not sort equivalently corrupts reads for any table wrapped in
`create table ... using isolated`.

A module that aliases an index name **without** supplying a matching `indexDescriptor` has its
access path recorded as `{ kind: 'unresolvedIndex' }` (and the engine logs a warning). Order-
sensitive consumers refuse an unresolved plan rather than guess — so the alias-without-
descriptor path is a correctness bug in the module, not a slow path. Name the primary key
`_primary_` or supply the descriptor.

**When to use**: Most modules (in-memory tables, file-based storage, traditional indexes).

**Example**: [Indexed Table](#indexed-table), under Common Patterns.

### 3. Concurrency Mode (Parallel Runtime)

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

When a parallel-runtime consumer (e.g. fan-out lookup join) wants to issue
multiple vtab calls in flight on a single connection, it consults the
module's declared `concurrencyMode`. By default, modules opt out of
parallelism — the runtime acquires a per-connection lock so calls are
serialized.

```typescript
interface VirtualTableModule {
  readonly concurrencyMode?: 'serial' | 'reentrant-reads' | 'fully-reentrant';
}
```

| Mode | Per-connection guarantee from the module |
| --- | --- |
| `'serial'` (default) | Nothing. Runtime serializes via `acquireConnectionLock`. |
| `'reentrant-reads'` | Concurrent `query()` is safe; writes still serialize. |
| `'fully-reentrant'` | All operations are safe to interleave on one connection. |

**Default is `'serial'`** — the safe choice for any module that hasn't
been audited. The cost is that parallel consumers fall back to lock
serialization on shared connections, defeating parallelism for that
module. The declaration is the knob that actually buys parallelism;
nothing else needs to change.

**Upgrading a module:**

1. Identify the connection-level state mutated by `query()`, `update()`,
   savepoints, etc. If `query()` snapshots its working set at call entry
   and never touches state another call writes, `'reentrant-reads'` is
   safe.
2. Walk through the worst-case interleavings under
   single-threaded JS: torn reads can only happen if a write publishes
   state in more than one statement step. Atomic single-statement
   pointer swaps are safe; multi-step state machines aren't.
3. For `'fully-reentrant'`, the same holds for writes. This is a much
   higher bar and is usually not worth it — `'reentrant-reads'` is the
   common upgrade target.

The runtime helpers live at `vtab/concurrency.ts`:

```typescript
import { getModuleConcurrencyMode, acquireConnectionLock } from '@quereus/quereus';

const mode = getModuleConcurrencyMode(module);
if (mode === 'serial') {
  const release = await acquireConnectionLock(connection);
  try {
    for await (const row of vtab.query(filterInfo)) yield row;
  } finally {
    release();
  }
}
```

Memory vtab declares `'reentrant-reads'`: `query()` captures the
connection's read or pending layer at call entry and iterates that
captured BTree, so concurrent reads on one connection see consistent,
non-mutating snapshots. Writes serialize because, once a transaction is
open, subsequent writes mutate the existing pending layer's BTree in
place — `'fully-reentrant'` would require either fresh-per-write layers
or an iterator-safe mutation path. Layered stores, isolation wrappers,
and persistent plugins stay default until their owners audit them.

### 4. Backing Host (Materialized-View Backing Tables)

A module may volunteer to host materialized-view backing tables by implementing
the optional `getBackingHost` hook — presence of the method is the capability
(the `getMappingAdvertisements` signaling style):

```typescript
interface VirtualTableModule {
  getBackingHost?(db: Database, schemaName: string, tableName: string): BackingHost | undefined;
}
```

`BackingHost` (`vtab/backing-host.ts`; `BackingHost`, `BackingScanRequest`,
`MaintenanceOp`, and `BackingRowChange` are exported from the package root) is
the privileged per-table surface the engine drives MV maintenance through:

- `ownsConnection(conn)` — true when `conn` is a live connection to **this**
  backing-table incarnation. The host must be pinned to one incarnation (capture
  the table's internal handle by reference at resolve time): after a
  drop+recreate of the same name, the new host must reject the old
  incarnation's connections.
- `connect()` — a fresh `VirtualTableConnection`; the engine registers it so
  coordinated commit/rollback (savepoint replay included) covers its pending
  state in lockstep with the source write.
- `applyMaintenance(conn, ops)` — apply an ordered `MaintenanceOp` batch
  (`delete-key` / `upsert` / `delete-by-prefix` / `replace-all`) to `conn`'s
  **pending** transaction state, bypassing user-DML read-only enforcement while
  keeping secondary-index / change-tracking bookkeeping. Returns the
  **effective** `BackingRowChange`s realized — exact reporting is part of the
  contract (the MV-over-MV cascade replays them; no-op ops yield nothing,
  `replace-all` yields the minimal keyed diff). Later reads on `conn` must
  observe the applied ops (reads-own-writes).
- `replaceContents(rows, onDuplicateKey?)` — atomically replace the
  **committed** contents (create-fill / refresh); throw `onDuplicateKey()` (or a
  generic `CONSTRAINT`) on a duplicate PK; concurrent readers see pre- or
  post-swap state, never partial.
- `scanEffective(conn, { equalityPrefix?, descending? })` — reads-own-writes
  scan over `conn`'s effective state in PK order, honoring `equalityPrefix` as a
  seek + early-terminate leading-PK prefix range.

**Cost contract:** PK-ordered storage with O(log n) keyed
upsert/delete/point-lookup **and** the ordered prefix-range scan are required —
do not advertise the capability without them (the engine does not gate per
maintenance arm). A backing table must reject user DML (READONLY) while
admitting the privileged surface, and the engine adds no latching around it —
the host owns its own concurrency discipline under the module's declared
`concurrencyMode`. The memory module is the reference implementation
(`MemoryTableModule.getBackingHost`); the store module is the second realized
host (`StoreBackingHost` in `@quereus/store` — pending state on the per-table
`TransactionCoordinator`, reads-own-writes via the store's pending-merge read
paths, with the isolation wrapper forwarding the capability conditionally); see
[`docs/mv-backing-host.md`](mv-backing-host.md#backing-host-capability)
for the engine-side view.

A capability-advertising module is selectable as an MV's backing host via
`create materialized view mv using <module>(args) as <body>` (omitting the
clause defaults to memory) — the create builder and the catalog-import path
both gate on `getBackingHost` presence and reject a capability-less module with
a sited `UNSUPPORTED`. One soft edge rides on `alterTable` rather than the
capability itself: source column-rename propagation renames the backing's
shifted columns through the host module's `alterTable`; a host without it
throws `UNSUPPORTED` and the propagation's failure path marks the MV stale
(recoverable by `refresh`) instead of renaming in place.

**Durable hosts and the rehydrate adopt fast path.** By default, catalog import
drops a pre-existing same-module `_mv_<name>` table and refills it from the body
— always correct, never trusting persisted derived rows. A durable host that
wants the adopt-without-refill fast path on reopen does two things: persist its
backing as an **ordinary table entry** in its catalog (so its own rehydration
phase 1 reconnects the table before the MV entries import), and pass
`importCatalog`'s `trustBackings: true` (plus one shared `adoptedBackings` set
across the session's calls) **only when it can attest no crash since the last
open** — the store module's vehicle is a single-use clean-shutdown catalog
marker written by `closeAll` and consumed at `rehydrateCatalog`. Never pass
`trustBackings` unconditionally: the engine's remaining gates are DDL-level and
cannot see content divergence from a crash. See
[`docs/mv-backing-host.md` § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity)
for the full gate set.

## Capability negotiation surface

The `VirtualTableModule` contract signals capability three different ways, and the
behavior when a module does *not* implement a surface ranges from a clean negotiated
rejection to **silent divergence**. This section is the single inventory of every
negotiation surface: how it is signaled, what the engine substitutes when the module
omits it, and which built-in modules implement it. Module authors and reviewers should
treat it as the reference for "what happens if my module doesn't do X".

### Signaling styles

| Signaling | Members | Engine consults it? |
| --- | --- | --- |
| **Method presence** | `supports` / `executePlan`, `getBestAccessPlan`, `getMappingAdvertisements`, `getBackingHost`, `createIndex` / `dropIndex`, `alterTable`, `renameTable`, `finalizeRename`, `beginSchemaBatch` / `endSchemaBatch`, `notifyLensDeployment`, `onRegister`, `assertCatalogObjectPersistable` | yes, per call site (varies) |
| **Static field** | `concurrencyMode`, `expectedLatencyMs` | yes, before dispatch (the clean model) |
| **`getCapabilities()` flag** | `delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators`, `ddlTransactionality` (live); `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` (informational) | only the first three |

The static-field model (`concurrencyMode`, see [Concurrency Mode](#3-concurrency-mode-parallel-runtime) above) is the clean exemplar: a defaulted, queryable value the engine reads *before* it dispatches, to choose its path. The [recommended pattern](#recommended-capability-negotiation-pattern) generalizes toward it.

### Classification legend

Each surface below is tagged by how its **unsupported path** behaves:

- **Negotiated rejection** — the engine consults presence (or catches a thrown `UNSUPPORTED`) and turns the unsupported case into a clean, sited error before / at dispatch.
- **Engine-side fallback** — absence has a defined behavior the engine substitutes.
- **Silent divergence** — the module no-ops a mandate it cannot meet, and the engine never learns. This is the bug class this inventory exists to surface.
- **Data-dependent throw** — the module throws `CONSTRAINT` / `MISMATCH` per the arm's contract (correct — not a gap).

### Surface inventory

| Surface | Signaling | Unsupported-path | memory | store | isolation | leveldb / indexeddb |
| --- | --- | --- | --- | --- | --- | --- |
| `create` / `connect` / `destroy` | required | n/a | ✓ | ✓ | wraps underlying | via store |
| `getBestAccessPlan` | presence | engine-side fallback (default full-scan; isolation returns a default plan when the underlying lacks it) | ✓ | ✓ | forwards | via store |
| `supports` / `executePlan` | presence (pair) | engine-side fallback (index path) — isolation **deliberately suppresses** it so the overlay sees every row | — | — | suppressed | — |
| `getMappingAdvertisements` | presence | engine-side fallback (name-match only) | ✓ tags | ✓ tags | forwards | via store |
| `getBackingHost` | presence | negotiated rejection (`create materialized view … using <module>` and catalog import both reject a capability-less module with a sited `UNSUPPORTED`; resolving a host on an already-created backing without the capability is a sited `INTERNAL` — engine bug) | ✓ | ✓ (`StoreBackingHost` — coordinator-pending) | conditional forward (constructor-assigned **only when the underlying implements it**, so method presence mirrors the underlying — a wrapper around a capability-less module must not advertise) | via store |
| `createIndex` / `dropIndex` | presence | negotiated rejection (`SchemaManager.createIndex` — "does not support CREATE INDEX") | ✓ | ✓ | forwards (instance-level preferred) | via store |
| `alterTable` (method present) | presence | negotiated rejection (each data-affecting `run*` in `runtime/emit/alter-table.ts` throws a sited `UNSUPPORTED` if absent — except `renameColumn`, which degrades to an engine-side schema-only rename) | ✓ | ✓ | forwards (throws if underlying lacks) | via store |
| `renameTable` | presence | engine-side fallback (schema-only rename) | ✓ | ✓ physical move | forwards + rekeys maps | via store |
| `finalizeRename` | presence | engine-side fallback (no-op — `renameTable` did all the work) | n/a | ✓ deletes old catalog entry after dependents persist (two-phase, see [schema.md](schema.md)) | forwards | via store |
| `beginSchemaBatch` / `endSchemaBatch` | presence | engine-side fallback (per-DDL commits) | n/a | ✓ | forwards | via store |
| `notifyLensDeployment` | presence | engine-side fallback (no-op) | n/a | n/a | forwards | n/a |
| `onRegister` | presence | engine-side fallback (no-op — the module first sees its `Database` in a table hook) | n/a | ✓ subscribes to the schema-change notifier at `registerModule`, so a view created before the first store table is still persisted (and still vetoed) | forwards | via store |
| `assertCatalogObjectPersistable` | presence | engine-side fallback (no-op — the object is registered and its catalog write, if any, stays fire-and-forget) | n/a | ✓ refuses a view / MV / rename-rewritten table whose key or generated DDL it could not encode (tables self-filtered on ownership) | forwards | via store |
| `concurrencyMode` | static field | engine-side fallback (`'serial'`) | `reentrant-reads` | `serial` (default) | computed: `weaker(underlying, overlay)`, capped at `reentrant-reads` | via store |
| `expectedLatencyMs` | static field | engine-side fallback (`0`) | 0 | 0 | forwards underlying | via store |
| `getCapabilities().delegatesNotNullBackfill` | flag (live) | engine-side gate (ADD COLUMN skips `validateNotNullBackfill`) | off | off | inherits underlying | off |
| `getCapabilities().permitsGrandfatheredCheckViolators` | flag (live) | engine-side gate (`getTrustedCheckExtraction` returns the empty extraction, so `TableReferenceNode` skips the CHECK lift and the lens prover refuses the table's CHECK-derived enum domains) | off | off | inherits underlying | off |
| `getCapabilities().ddlTransactionality` | flag (live) | engine-side gate (`ddl_transaction_policy = strict` refuses module-dispatching DDL inside an explicit transaction unless the tier is `transactional`; default `permissive` never consults it — see [DDL transactionality tiers](#ddl-transactionality-tiers)) | `non-transactional` | `auto-commit` | **forwards underlying verbatim, never upgrades** | via store |
| `getCapabilities().{isolation,savepoints,persistent,secondaryIndexes,rangeScans}` | flag (informational) | **never consulted by engine** — asserted only in tests; isolation augments `isolation` / `savepoints` but nothing reads them | varies | varies | augments | varies |

> **Isolation wrapper asymmetry is intentional.** `IsolationModule` forwards the isolation-transparent hooks (`getBestAccessPlan`, `getMappingAdvertisements`, the batch + lens lifecycle hooks, `onRegister`, `assertCatalogObjectPersistable`, `renameTable`, `finalizeRename`, `alterTable`) but **suppresses** `supports` (so the overlay always sees every row to merge), computes a conservative `concurrencyMode` (the weaker of the underlying and overlay modes, capped at `reentrant-reads` because its own write path is never fully-reentrant), and forwards the underlying's `expectedLatencyMs`. See the **Transparent hook forwarding** paragraph in [`packages/quereus-isolation/README.md`](../packages/quereus-isolation/README.md) for the full rationale — do not restate it divergently here.

### DDL transactionality tiers

`getCapabilities().ddlTransactionality` declares how a module's DDL (schema-change)
statements behave with respect to the enclosing transaction. It is a single
**worst-case summary** across every DDL statement the module can execute — per-statement
detail belongs in the backend docs, not the flag. Three tiers, in severity order:

- **`transactional`** — the reference semantics. A schema change is part of the enclosing
  transaction: the catalog entry and physical structures (index trees, migrated rows,
  moved storage) are buffered with the transaction, visible to later statements inside it,
  made durable atomically with the DML at commit, and discarded whole on `rollback` /
  `rollback to savepoint`. **No built-in module reaches this tier today** — it needs a
  transaction-scoped catalog, which `SchemaManager` does not have (tracked by the backlog
  ticket `feat-transactional-ddl-native-backends`).
- **`non-transactional`** — the schema change escapes the transaction (it survives
  `rollback`) but buffered DML still rolls back normally. This is the **memory** module,
  and the store's non-committing DDL statements (`create index`, `add constraint`,
  schema-only arms).
- **`auto-commit`** — executing certain DDL commits the module's buffered transaction at
  DDL time: the schema change **and every buffered write** become durable immediately, and
  a later `rollback` undoes nothing. This is the **store** module (its row-rewriting ALTER
  arms and `renameTable` flush pending ops); because a module declares its worst case, the
  store declares `auto-commit` even though much of its DDL is only non-transactional.

**Default when absent: `non-transactional`.** A module must EXPLICITLY claim
`transactional`; defaulting to the clean semantics would let every existing module
silently over-promise.

**The gate.** The `ddl_transaction_policy` option / pragma governs enforcement:

- `permissive` (default) — today's behavior, unchanged; the flag is not consulted.
- `strict` — a statement that dispatches to a module DDL surface (`create table … using`,
  `drop table`, `create index`, `drop index`, any `alter table` arm, `rename table`,
  `create`/`drop`/`refresh materialized view`) while an **explicit** transaction is open on
  a module whose tier is not `transactional` raises a sited `QuereusError` before any
  dispatch or catalog mutation. The transaction stays open and usable. Autocommit-mode DDL
  (the normal case) is never gated — only an explicit `BEGIN` trips it.

  The materialized-view verbs consult the **backing-host** module — the `using <module>(…)`
  host, else the `memory` default, *not* the session default module. `refresh` is gated
  even though it mostly rewrites rows: its reshape arm reconciles a shifted body shape with
  module `alterTable` ops, and both of its arms commit the contents swap (a `begin; refresh;
  rollback` does not undo the refresh), so its effect escapes the enclosing transaction the
  same way the schema statements' do.

Engine-only schema objects (`create view`, `create assertion`, `declare schema`) are out
of the gate's scope: they touch no module, and the engine's own schema is transient by
design (see [architecture.md § Transient Schema](architecture.md)). Tag-only edits
(`alter view/index/materialized view … set tags`) are likewise ungated — they dispatch to
no module either. The one inconsistency: `alter table … set tags` *is* refused, because
the `ALTER TABLE` emitter gates all of its arms uniformly rather than per-arm.

`apply schema` runs its generated migration DDL through the engine's *implicit*
transaction, so the gate does not fire statement-by-statement inside a migration. It does
fire — on the first gated statement the migration emits — if the caller wrapped the
`apply schema` in an explicit `begin`.

The isolation wrapper **forwards the underlying's declared tier verbatim and never
upgrades it**: the overlay stages DML outside the underlying module, so an underlying
DDL-commit flushes only module-side ops — forwarding the pessimistic underlying value is
the honest choice.

### `alterTable` sub-arms — the fine-grained mandate layer

`alterTable` presence is **one bit covering ~12 `SchemaChangeInfo` arms** (see [Schema Changes](#schema-changes-schemachangeinfo) below), each with its own mandate. This mismatch is the divergence hazard: a module can be "ALTER-capable" (the method is present) yet silently fail one arm it cannot honor. The `alterPrimaryKey` row is the model the [recommended pattern](#recommended-capability-negotiation-pattern) promotes to a universal rule: **try native → on `UNSUPPORTED` apply a defined fallback**.

| Arm | Mandate | memory | store |
| --- | --- | --- | --- |
| `addColumn` | append column; backfill; NOT-NULL gated by `delegatesNotNullBackfill`; honor `insertAtIndex` **or throw `UNSUPPORTED`** | ✓ (honors a position) | ✓ (append only — rejects a position) |
| `dropColumn` | remove slot + reindex | ✓ | ✓ |
| `renameColumn` | schema-only | ✓ | ✓ |
| `alterPrimaryKey` | re-key in place **or throw `UNSUPPORTED`** | in-place re-key (open-transaction pending layers and their change events re-keyed too) | in-place re-key |
| `addConstraint` | materialize + validate (unique / fk) | ✓ | ✓ unique / fk; throws `UNSUPPORTED` for others |
| `dropConstraint` / `renameConstraint` | schema rewrite | ✓ | ✓ |
| `alterColumn.setNotNull` | backfill from default or throw `CONSTRAINT` | ✓ | ✓ |
| `alterColumn.setDataType` | physical convert or throw `MISMATCH` | ✓ | ✓ |
| `alterColumn.setDefault` | schema-only | ✓ | ✓ |
| `alterColumn.setCollation` (non-PK UNIQUE) | re-validate uniqueness under new collation | ✓ | ✓ |
| `alterColumn.setCollation` (**PK column**) | re-key / re-validate PK under new collation (`module.ts` setCollation contract) | ✓ re-keys | ✓ re-keys (physical re-key + secondary-index rebuild; `CONSTRAINT` on a collision under the new collation) |

> The PK-column `setCollation` cell is **honored by a physical re-key** on both modules. The store keys each PK column under its own declared collation (`StoreTable.pkKeyCollations`), so a PK `SET COLLATE` re-encodes every data-store key under the new collation (`StoreTable.rekeyRows`) and rebuilds each secondary index (whose keys embed the PK suffix). A re-key that would collide under the new collation throws a sited `CONSTRAINT` in the validation pass **without mutating the store** (all-or-nothing, mirroring `ALTER PRIMARY KEY`); a target equal to the column's current collation is a schema-only no-op. This is the `store-pk-collate-physical-rekey` follow-up to the earlier negotiated-rejection stopgap — the store now reaches full memory parity, so neither the engine-side logical-enforce scan nor the `UNSUPPORTED` reject is needed.

> **CREATE honors any declared PK collation too.** `StoreModule.create` keys an *explicit* per-column PK collation natively (`create table t (x text collate binary primary key)` is keyed under BINARY), and only applies the store's table-level default K (`config.collation || 'NOCASE'`) to an *implicit*-default text PK column (so an undecorated text PK keeps the store's historical NOCASE-keyed behavior rather than the engine's BINARY column default). The implicit-vs-explicit distinction is carried by `ColumnSchema.collationExplicit` (set by `columnDefToSchema` only on a `COLLATE` clause — purely additive; every other consumer ignores it). The per-column key collation round-trips through the column's (BINARY-elided) `COLLATE` clause, so the load path (`connect` / rehydrate) needs no reconciliation. Non-text PK columns keep their declared collation — collation governs key bytes only for text. See [`docs/schema.md` § Per-column PK key collation](schema.md) for the store-side detail.

### Recommended capability-negotiation pattern

These are the rules new modules and new contract points should follow. They generalize the clean models already in the tree (`concurrencyMode`, the `alterPrimaryKey` protocol) and retire the failure mode the inventory above flags.

1. **Presence-signaling is reserved for purely-additive optional hooks** whose absence is already a clean engine-side fallback (`getMappingAdvertisements`, the batch / lens lifecycle notifications). Absence there means a documented no-op — it can never diverge.

2. **Any contract point where the engine assumes a behavior must be declared and consulted before dispatch.** `concurrencyMode` is the template: a defaulted, queryable value the engine reads to choose its path. Generalize toward this, not toward more presence bits.

3. **`getCapabilities()` is the single home for binding capability gates.** Three flags are **live gates** the engine consults before/at dispatch — `delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators`, and `ddlTransactionality` (see [DDL transactionality tiers](#ddl-transactionality-tiers)) — and this is where new binding gates belong. The five informational flags — `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` — are **advisory / non-binding**: the engine does not consult them, so toggling them changes nothing about engine behavior (they are asserted only in tests, and isolation augments `isolation` / `savepoints` for its own bookkeeping). Do not be misled into treating them as gates, and do not grow that advisory set. (Their removal / relocation is a separate code ticket; the distinction is documented here, not yet acted on.)

4. **Hard contract — no silent divergence.** A module that cannot honor an invoked `alterTable` arm MUST throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message — **never silently no-op**. The engine maps `UNSUPPORTED` to a defined fallback (generic rebuild, schema-only, or engine-side logical enforcement) or surfaces it as a clean user error. This promotes the existing `alterPrimaryKey` protocol to a universal rule.

5. **Fine-grained ALTER negotiation.** Because `alterTable` presence is one coarse bit, per-arm support is negotiated at the relevant `run*` call site. The negotiation does **not** have to be a static capability flag or an engine routing branch: when the accept/reject decision is intrinsically module-internal — depending on per-table physical state the engine neither owns nor tracks — the **behavioral `throw UNSUPPORTED` contract** (rule 4) *is* the negotiation. The store's PK-column `setCollation` is the worked example: the accept/reject call hinges on the table's fixed physical key collation K (`config.collation`), so the store resolves it by applying a consistent change (target == K) schema-only and throwing a sited `UNSUPPORTED` on a divergent one — `runAlterColumn` propagates the throw cleanly with no engine change. The `native | logical-enforce | reject` trichotomy the work explored collapses, for the store, to `reject` (the consistent case being plain schema-only, not a special mode); logical-enforce and physical re-key remain documented future enhancements. New arms adopt whichever shape fits — a queryable value when the engine must choose its path *before* dispatch (à la `concurrencyMode`), or the behavioral contract when the decision is module-internal — incremental, not a giant up-front descriptor.

## Runtime Execution Modes

### Query-Based Execution

If module implements `supports()`, implement `executePlan()`:

```typescript
interface VirtualTable {
  executePlan?(
    db: Database,
    plan: PlanNode,
    ctx?: unknown
  ): AsyncIterable<Row>;
}
```

The module receives the entire pipeline and executes it within its own context.

### Index-Based Execution

If module implements `getBestAccessPlan()`, implement `query()`:

```typescript
interface VirtualTable {
  query?(filterInfo: FilterInfo): AsyncIterable<Row>;
}

interface FilterInfo {
  args: SqlValue[];           // Constraint values
  argIndices: number[];       // Which constraints are provided
  limit?: number;             // Optional row cap (LIMIT pushdown)
  offset?: number;            // Optional kth-row seek (only valid when supportsOrdinalSeek was advertised)
}
```

The module receives individual constraints and returns matching rows.

**Pushdown directives**: `FilterInfo.limit` is a soft row cap — modules may stop emitting once `limit` rows have been yielded. `FilterInfo.offset` is a seek-to-kth-row directive and is only set when the access plan advertised `supportsOrdinalSeek` for this query — modules without ordinal-seek support can ignore both fields safely (a streaming guard above the leaf still enforces correctness).

## Optimization Integration Points

### Physical Property Computation

Modules should communicate:
- **Cardinality**: Estimated row count
- **Ordering**: If module provides sorted output
- **Uniqueness**: If result is guaranteed unique

These properties enable the optimizer to make better decisions about join order, aggregation strategy, and materialization.

### Binding Capture

When predicates are pushed into the `Retrieve` pipeline, parameters and correlated column references are captured:

```typescript
// Query with parameter
select * from users where id = ?;

// Retrieve.bindings contains: [ParameterReference(1)]
// At runtime, the module receives the parameter value via FilterInfo.args
```

This enables efficient parameterized queries and correlated subqueries.

## Transaction Support

Modules can implement transaction methods for ACID compliance:

```typescript
interface VirtualTable {
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(index: number): Promise<void>;
  rollbackTo?(index: number): Promise<void>;
  release?(index: number): Promise<void>;
}
```

See [runtime.md](runtime.md) for transaction semantics.

### DDL inside an open transaction

`createIndex` and the row-validating `alterTable` arms (`ADD CONSTRAINT ... UNIQUE`,
`ALTER COLUMN ... SET COLLATE`, and the two value-rewriting arms `ALTER COLUMN ... SET DATA TYPE`
/ `ALTER COLUMN ... SET NOT NULL`, whose rewrite can collapse two distinct values onto one) can be
invoked while the calling connection has uncommitted writes. Two obligations follow, and both bundled modules meet them:

*   **Validate against the effective rows**, not the committed ones — the rows a `SELECT` on
    that connection would return. Scanning committed rows alone lets a duplicate the
    transaction just inserted slip past the check and land under a constraint that forbids it.
*   **Enforce the new constraint for the rest of that transaction.** A module that snapshots
    the table schema per transaction must refresh that snapshot, or the statement after the
    DDL is checked against a schema that does not yet know the constraint exists.

Neither module makes DDL itself transactional: the catalog entry and any physical structure
are written outside the transaction coordinator, so a `ROLLBACK` discards the rows but leaves
the index behind. That is safe only because both re-validate an index entry against the live
row before returning or acting on it. See [memory-table.md](memory-table.md) § DDL and
transactions for the full statement of the boundary and what a fully-cooperating module would
do instead.

#### When the pending rows live outside your module: `EffectiveRowSource`

A module cannot always reach the transaction's uncommitted rows. Under the isolation layer
(`@quereus/isolation`) each connection's writes are staged in a private in-memory *overlay*;
the wrapped module holds only committed rows and cannot see the overlay at all. Its own
"effective rows" are therefore the committed rows, and the first obligation above becomes
impossible to meet unaided.

The optional last parameter of `createIndex` and `alterTable` closes that gap:

```ts
/** Re-callable; each call returns a fresh stream. */
export type EffectiveRowSource = () => AsyncIterable<Row>;

createIndex?(db, schemaName, tableName, indexSchema, rows?: EffectiveRowSource): Promise<void>;
alterTable?(db, schemaName, tableName, change, rows?: EffectiveRowSource): Promise<TableSchema>;
createIndex?(indexSchema, rows?: EffectiveRowSource): Promise<void>;   // VirtualTable, instance level
```

**Who supplies it.** Only a wrapper module that holds the issuing connection's pending rows
outside the target module. The engine's own emitters (`CREATE INDEX`, `ALTER TABLE`) pass
nothing, so an unwrapped module keeps validating its own effective rows exactly as before. The
isolation layer supplies its issuing connection's merged view: committed rows, minus the ones
that connection's overlay tombstones, superseded by the ones it rewrote, plus the ones it
added. A *foreign* connection's overlay never contributes — its staged duplicates are its own
problem at commit time, exactly as a concurrent duplicate insert would be.

**What the receiver must do with it.** When `rows` is present it is the ONLY set the module may
judge row CONTENT against:

*   Every row-content check — UNIQUE duplicate detection, collation-rekey collision detection,
    value-rewrite collapse detection (`SET DATA TYPE` / `SET NOT NULL` backfill, judged with the
    altered column already converted) — reads this stream.
*   The module MUST NOT reject the DDL as a *constraint violation* over a duplicate that exists
    only in its own committed data. That duplicate may be a row the issuing transaction has
    already deleted; calling it invalid data is a false positive the caller cannot work around.
    **One narrow exception:** a structure that physically cannot *hold* the duplicate — a re-keyed
    PRIMARY KEY tree, which is a map, not a multi-map, and whose committed rows must survive a
    rollback — may still refuse. It must do so as `BUSY` ("commit/rollback and retry"), never
    `CONSTRAINT`: the data is valid, the storage merely cannot represent it while those rows are
    still resident. Both bundled backends do exactly this for `ALTER COLUMN … SET COLLATE` on a
    PK member.
*   Physical structures are still built from the module's OWN rows. Building an index over
    committed rows while validating over the merged view is deliberate and sound: an index entry
    with no live row behind it is harmless, because every reader resolves an entry back to its
    live row and drops it when the row is gone. Both bundled modules document this at the build
    site (`BaseLayer.addIndexToBase`, `StoreModule.buildIndexEntries`).
*   Validate BEFORE creating any physical artifact, so a rejection leaves nothing behind.

`rows` is re-callable because a single `ALTER` may validate more than once (one pass per UNIQUE
constraint covering the altered column). Row order is unspecified — every consumer is a
set-shaped check.

Not covered: a PRIMARY KEY collision introduced by `ALTER COLUMN ... SET COLLATE` on a PK
member. The wrapper's staged rows are re-keyed inside the wrapper's own overlay and the
module's inside its own store, so a pending row that collides with a committed one under the
new collation is checked by neither. Both re-key sites carry a `NOTE:` to that effect.

### Connection Registration

For modules that need to participate in the database's transaction coordination (e.g., receiving `commit()` and `rollback()` calls when the database commits or rolls back), you must register connections with the database.

The `DatabaseInternal` interface exposes internal methods for this purpose:

```typescript
import type { Database, DatabaseInternal, VirtualTableConnection } from '@quereus/quereus';

class MyTable extends VirtualTable {
  private connection: MyConnection | null = null;

  private async ensureConnection(): Promise<MyConnection> {
    if (!this.connection) {
      this.connection = new MyConnection(this.tableName);
      
      // Register with database for transaction coordination
      await (this.db as DatabaseInternal).registerConnection(this.connection);
    }
    return this.connection;
  }
}
```

**`DatabaseInternal` methods:**

| Method | Description |
|--------|-------------|
| `registerConnection(conn)` | Registers a connection for transaction management. If a transaction is already active, `begin()` is called on the connection and the active savepoint stack is replayed by calling `createSavepoint(depth)` for each open depth, so subsequent `releaseSavepoint` / `rollbackToSavepoint` broadcasts targeting earlier depths are in-range on the new connection. |
| `unregisterConnection(id)` | Unregisters a connection. May be deferred during implicit transactions. |
| `getConnection(id)` | Gets a connection by ID. |
| `getConnectionsForTable(name)` | Gets all connections for a table. Matches the qualified name *or* the bare table name, so it can reach a same-named table in another schema. Useful for connection reuse. |
| `getAllConnections()` | Gets all active connections. |
| `removeConnectionsForTable(schema, table)` | Force-removes **every** connection registered under `schema.table`, bypassing the implicit-transaction deferral. Only correct when the table itself is going away (`destroy` / drop), where no connection under that name can still have state worth committing. The engine calls it for you on drop. |
| `removeConnection(id)` | Force-removes one connection by id, bypassing the deferral. This is the tool a `renameTable` implementation needs. |

**Evicting connections on `renameTable`:**

The engine's rename path does *not* evict connections, so a module whose connections are pinned to the old table name must evict them itself or leak one per rename. Evict **only the connections your own module created** — discriminate with `instanceof` (or a brand property) *and* an exact qualified-name match, then call `removeConnection(conn.connectionId)` on each:

```typescript
const oldQualified = `${schemaName}.${oldName}`.toLowerCase();
for (const conn of dbInternal.getAllConnections()) {
  if (conn instanceof MyConnection && conn.tableName.toLowerCase() === oldQualified) {
    dbInternal.removeConnection(conn.connectionId);
  }
}
```

Do **not** reach for `removeConnectionsForTable` here. A wrapping module — `IsolationModule` is the one in-tree — registers its own connection under the same qualified name, and that connection is the only thing that drives its staged writes to storage at `COMMIT`. A blanket name-keyed sweep deletes it, and the transaction's writes vanish while the commit reports success.

**Connection reuse pattern:**

Before creating a new connection, check if one already exists for the table:

```typescript
private async ensureConnection(): Promise<MyConnection> {
  if (!this.connection) {
    // Check for existing connection to reuse
    const dbInternal = this.db as DatabaseInternal;
    const existing = dbInternal.getConnectionsForTable(this.tableName);
    
    if (existing.length > 0 && existing[0] instanceof MyConnection) {
      this.connection = existing[0];
    } else {
      // Create and register new connection
      this.connection = new MyConnection(this.tableName);
      await dbInternal.registerConnection(this.connection);
    }
  }
  return this.connection;
}
```

**Adopting a runtime-offered connection (`adoptConnection`):**

The reuse pattern above is *pull*: your `ensureConnection` looks the registry up when it happens to run. The runtime also *pushes* — when it materializes a fresh `VirtualTable` instance for a table that already has a registered connection, it offers that connection to the instance via the optional `adoptConnection` hook on `VirtualTable`, so the new instance reuses the in-flight connection (and its uncommitted transaction state) instead of opening a rival one:

```typescript
adoptConnection(connection: VirtualTableConnection): void {
  // Reject connections another module registered under the same qualified name.
  if (!(connection instanceof MyConnection)) return;
  // Reject a stale connection whose backing state no longer matches this instance
  // (e.g. a dropped-then-recreated table); adopt only when the state matches.
  if (connection.backingStore !== this.store) return;
  this.connection = connection;
}
```

Contract:

- **The module owns the accept/reject decision.** The runtime knows nothing about your connection type — it hands you the registered `VirtualTableConnection` and ignores the return value. Downcast with `instanceof` (or a brand check) and reject connections you did not create, plus connections whose backing state no longer matches this instance. Silently do nothing when you decline.
- **Ownership is not transferred.** The adopted connection stays owned by the database connection registry that registered it. Adopting it must not make this instance responsible for closing it beyond your module's existing `disconnect` contract.
- **It must be idempotent.** Calling `adoptConnection` more than once on the same instance must be safe (re-setting the same connection).

Implement the hook when a table's uncommitted state lives on the connection and a second instance of the same table within one statement must see it. Modules whose per-instance state is self-contained can omit it — a module without the hook behaves exactly as before (the runtime's optional-chain call is a no-op).

**When to use connection registration:**

- Your module maintains state that must be committed or rolled back with transactions
- You need to flush changes to persistent storage on commit
- You implement an isolation layer with overlay tables
- You coordinate with external systems that have their own transaction semantics

**Note:** The `DatabaseInternal` interface is marked `@internal` and may change between versions. It's intended for tight integration scenarios like storage backends and isolation layers.

## Identifier casing in module-facing calls

Every SchemaManager → module hook receives **canonical stored names**, never the raw spelling of the triggering statement:

- `schemaName` is **canonical** — lowercase, folded through `SchemaManager.canonicalSchemaName`. A `MAIN.t` qualifier, or an unqualified statement under a non-`main` current schema, reaches the module as `main` / `aux` / … exactly as `getCurrentSchemaName()` would resolve it.
- An existing object's **own name** (table name to `connect` / `createIndex` / `dropIndex` / `destroy`, the index name to `dropIndex`) is its **stored display casing** — the casing captured when the object was created — not the casing used in the `create index … on T` / `drop index iDx` / `drop table T` that triggered the call.

This holds for the whole hook surface: `create`, `connect`, `createIndex`, `dropIndex`, `destroy`, `alterTable`, `renameTable`, `getBackingHost`, and the auto-emitted schema-change events. Because the names are stored and stable, a module **may** key its storage, physical stores, and internal registries by the call arguments verbatim — a table created under one casing and later dropped/queried under another will address the same key. (`create` is handed the full canonical `TableSchema`, so its `tableSchema.schemaName` / `tableSchema.name` follow the same rule.)

**The one as-spelled exception** is a *new* object's own name — the index name in `createIndex` (`indexSchema.name`) and `newName` in `renameTable`. These are not yet stored; they *become* the stored name, carrying the casing as written in the DDL (the same way `CREATE TABLE Foo` stores `Foo`). A module that persists the new object should adopt that casing as its stored display name.

This is the module-call analogue of the schema-change event naming contract; see [schema § Schema Change Events](schema.md#event-types).

## Schema Changes (`SchemaChangeInfo`)

When `ALTER TABLE` performs a data-affecting change, the engine calls

```typescript
VirtualTableModule.alterTable(db, schemaName, tableName, change): Promise<TableSchema>
```

passing a `SchemaChangeInfo` discriminated union as `change` and registering the returned `TableSchema` in the catalog. This is a **module-level** hook; the engine never dispatches an `ALTER TABLE` statement through the optional per-table `VirtualTable.alterSchema` method. That method survives for *in-process wrappers* that own a table instance directly — the isolation layer forwards a change to a connection's overlay table through it. Such a caller may pass `alterSchema(change, /* validateOnly */ true)`, which must run every pre-mutation validation the change would run, throw exactly what the real application would throw, and **mutate nothing**; a module that cannot validate without mutating must throw `UNSUPPORTED` rather than silently apply. The statement dispatch lives in `runtime/emit/alter-table.ts`: each `run*` helper resolves the change and, if `module.alterTable` is absent, throws a sited `QuereusError(StatusCode.UNSUPPORTED)`. `ALTER TABLE ... RENAME TO` is schema-only and routes through the separate `renameTable` hook instead.

The current arms of the union (`vtab/module.ts`):

```typescript
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef; backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
	    insertAtIndex?: number }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| { type: 'addConstraint'; constraint: TableConstraint }
	| { type: 'dropConstraint'; constraintName: string }
	| { type: 'renameConstraint'; oldName: string; newName: string }
	| { type: 'alterColumn'; columnName: string;
	    setNotNull?: boolean; setDataType?: string; setDefault?: Expression | null; setCollation?: string };
```

### Per-arm mandate

Each arm carries its own contract. A module that implements `alterTable` is responsible for every arm it is handed — see the [`alterTable` sub-arm table](#altertable-sub-arms--the-fine-grained-mandate-layer) for the implementation status of the built-in modules.

| Arm | Mandate |
| --- | --- |
| `addColumn` | Append the column and backfill existing rows. A literal / NULL default is bulk-written; a **per-row value source** — a non-foldable default (e.g. `new.<col>`) or a `GENERATED ALWAYS AS` expression — arrives as `backfillEvaluator`, which the module must call **per existing row**. Key the module's own "NOT NULL needs a value source" rejection on the evaluator's *presence*, not on which kind of DEFAULT the column def carries: a generated column has no DEFAULT at all, yet the evaluator fills every row (and a row it evaluates to NULL is rejected per row during the backfill). A literal default must be folded **and converted to the new column's declared logical type** — use the exported `foldDefaultToType(expr, logicalType, columnName)`, never a bare `tryFoldLiteral`, or the backfilled cell holds the raw literal (`INTEGER DEFAULT '7'` → the text `'7'`) where an INSERT under the same DEFAULT stores the converted one. `backfillEvaluator`'s result is already converted by the engine and must be stored as-is. NOT-NULL backfill rejection is gated by the `delegatesNotNullBackfill` capability. `insertAtIndex`, when present, asks for the column at that slot instead of the end (every existing column at or after it shifts right by one, and every index-bearing schema field — PK definition, index / UNIQUE / FK column lists — must be renumbered to match). SQL never produces one; it reaches a module only from an in-process wrapper. A module that cannot place a column anywhere but the end must **throw `UNSUPPORTED`** for a position it cannot honor rather than silently appending. |
| `dropColumn` | Remove the column slot and reindex remaining columns — every index-bearing schema field (PK definition, index / UNIQUE / FK column lists) renumbers down over the removed slot, the mirror of `addColumn`'s `insertAtIndex` obligation. Don't hand-roll it: the exported `shiftSchemaIndicesForDrop(schema, colIndex)` returns the renumbered `columns` / `primaryKeyDefinition` / `indexes` / `uniqueConstraints` / `foreignKeys` and is what both built-in modules use. A PRIMARY KEY member, UNIQUE constraint, foreign key, or UNIQUE index that *names* the dropped column is removed **outright**, not narrowed to its surviving columns — one missing a column is a different, stronger constraint; a plain index is narrowed, and one left with no columns is dropped. It also returns `removedUniqueConstraints` (pre-shift column indices) so a module that materializes a physical structure per UNIQUE constraint can tear down exactly the ones this drop removes. `columnIndexMap` is the caller's to rebuild via `buildColumnIndexMap`. **The schema rewrite is only half the arm for a module that keeps a physical structure per index.** Diff the pre-drop index list against the returned `indexes`, by name, and act on both differences: an index the helper **removed** must have its physical structure **torn down** — the same teardown `dropIndex` performs — or it leaks, and a later `CREATE INDEX` reusing that name adopts the stale entries and answers a range scan with each row twice; an index the helper **narrowed** must have its physical structure **re-encoded** from the post-drop rows, because its key now holds one fewer column value while all later maintenance uses the narrow layout — leave it and an indexed lookup silently misses pre-drop rows and a DELETE orphans their entries. A survivor whose column *count* is unchanged needs nothing: its column indices shifted, but it encodes the same values in the same order. Ordering: re-encode after the row migration (the rebuild reads the migrated rows), tear down after the catalog write (so a failed physical delete cannot resurrect the index on reopen). |
| `renameColumn` | Schema-only rename (no row migration). |
| `alterPrimaryKey` | Re-key in place **or** throw `UNSUPPORTED` (see below). Don't hand-roll the schema swap: the exported `rekeySchemaPrimaryKey(schema, newPkColumns)` returns the re-keyed `TableSchema` and is what both built-in modules use. Swapping `primaryKeyDefinition` alone is **not enough** — the per-column `primaryKey` / `pkOrder` flags mirror it, and a stale mirror makes the canonical DDL generator emit the *retired* key (which, for a store-backed table, is what gets persisted and reloaded on reopen). See below. |
| `addConstraint` | Materialize and validate the constraint (UNIQUE / FK) against existing rows; throw `CONSTRAINT` on a violation. Also reached from `ALTER TABLE ADD COLUMN`: a constraint declared **inline** on the added column arrives as its own follow-up `addConstraint` call (UNIQUE → CHECK → FK) right after the `addColumn` call, so the module — not the engine's catalog copy — owns it and it survives later structural ALTERs. Implementing `addColumn` without `addConstraint` therefore makes `add column … check (…)` / `… references …` fail rather than silently lose the constraint. If one of those follow-ups throws, the engine reverts by handing each already-accepted CHECK / FK back through `dropConstraint` (newest first) and then `dropColumn`, so both arms must tolerate being called for a constraint/column added moments earlier in the same statement. |
| `dropConstraint` / `renameConstraint` | Rewrite the schema (and any implicit covering index that backs a UNIQUE). No row migration. |
| `alterColumn.setNotNull` | Backfill NULLs from the column default if present, else throw `CONSTRAINT`. Fold the default through `foldDefaultToType` so the fill value is converted to the column's declared type, as `addColumn`'s is. |
| `alterColumn.setDataType` | Convert each row and throw `MISMATCH` on loss (narrowing, NaN, overflow) when the physical type changes. Don't hand-roll the decision or the converter: the exported `planRetypeConversion(dataType, oldLogicalType, columnName)` resolves the declared type, returns a `null` converter for an alias retype (nothing to rewrite), and otherwise returns the per-value converter that validates, normalizes, and throws the engine's own `MISMATCH` message — the isolation layer keys its staged-row handling off that status code, so a module that invents its own message/code diverges from it. When the physical type is **unchanged**, no value moves — but the change is schema-only only if the two logical types also *compare* identically. If they do not (`TEXT` ↔ `TIMESPAN`, where `'PT1H'` ≡ `'PT60M'`; `TEXT` ↔ `JSON`, where `'{"a":1}'` ≡ `'{ "a" : 1 }'`; `TEXT` ↔ `DATE`/`TIME`/`DATETIME`, whose comparison ignores the column's collation), the module owes the same obligation as `setCollation` below: re-key / re-sort every structure ordered by the column and re-validate uniqueness under the new comparator, throwing `CONSTRAINT` on a collapse. Skipping it leaves lookups missing rows and duplicates slipping past UNIQUE. Retyping a PRIMARY KEY column is refused by the engine before dispatch. |
| `alterColumn.setDefault` | Schema-only — new inserts pick up the default, existing rows are untouched. |
| `alterColumn.setCollation` | Re-key / re-sort any PK / UNIQUE / index ordered by the column and re-validate uniqueness under the new collation (a set unique under `BINARY` may collide under `NOCASE` → throw `CONSTRAINT`). A module that enforces the PRIMARY KEY *physically* under a fixed table key collation (the store) instead negotiates the PK-column case **honor-iff-consistent**: apply schema-only when the target equals that fixed key collation, else throw `UNSUPPORTED` (sited) — never silently no-op. |

### No silent divergence

The hard rule for every arm: **a module that cannot honor the invoked change MUST throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message — never silently no-op.** A silent no-op leaves the catalog and the physical state diverged with the engine none the wiser; a thrown `UNSUPPORTED` lets the engine substitute a defined fallback or surface a clean user error. The store's PK-column `setCollation` was the canonical violator of this rule and now honors it: a divergent PK collation throws a sited `UNSUPPORTED` (a consistent one applies schema-only) instead of silently applying a schema change the fixed-collation key bytes never enforce. See the [recommended pattern](#recommended-capability-negotiation-pattern), rule 4.

### `alterPrimaryKey`

The `alterPrimaryKey` variant is dispatched for `ALTER TABLE ... ALTER PRIMARY KEY (...)`. Each entry in `newPkColumns` gives the column `index` (0-based position in the table's column list) and whether the column is `desc`. An empty array means the table reverts to an implicit key.

**Build the returned schema with `rekeySchemaPrimaryKey`.** A table records its key twice: `TableSchema.primaryKeyDefinition` (authoritative — what `table_info`, key extraction and the canonical DDL generator read) and the per-column `ColumnSchema.primaryKey` / `pkOrder` flags (a `CREATE TABLE`-time mirror feeding the planner's uniqueness hints and the `ColumnDef` AST that `RENAME COLUMN` reconstructs). A module that swaps only the definition leaves the mirror naming the retired key. The exported helper — the ALTER PRIMARY KEY sibling of `dropColumn`'s `shiftSchemaIndicesForDrop` — rebuilds both together:

```typescript
import { rekeySchemaPrimaryKey } from '@quereus/quereus';

const updatedSchema = rekeySchemaPrimaryKey(oldSchema, change.newPkColumns);
```

It returns a frozen schema with a frozen `primaryKeyDefinition` (each member carrying its column's `collation`, so a `NOCASE` key column isn't silently re-keyed under `BINARY`) and a frozen **new** column array of **new** `ColumnSchema` objects — the incoming columns are never mutated, which matters because the pre-ALTER schema is handed onward as `oldObject` on the `table_modified` notification and kept by the memory module as its rollback snapshot. It performs no *user-level* validation: the engine's `runAlterPrimaryKey` validates the column list (existence, no duplicates, every member NOT NULL) by name before dispatch, and a module driving the API directly should keep its own pre-checks — a NOT-NULL violation reaching the helper is not caught there. It does assert the two inputs that would produce a self-inconsistent schema instead of a rejected statement — an out-of-range column index and a repeated one — throwing `INTERNAL`, exactly as `shiftSchemaIndicesForDrop` asserts its column index. The per-column `pkDirection` is deliberately left untouched — direction lives in `primaryKeyDefinition.desc`, which is what the DDL generator and every key builder read.

It is the template for the no-silent-divergence rule. Modules that can re-key in place should handle the change directly and return an updated `TableSchema` — both built-in modules do (the memory module re-keys its trees, secondary indexes, and any open transaction's pending layers and pending change events; the store physically re-keys the data store). Modules that **cannot** re-key in place should throw `QuereusError(StatusCode.UNSUPPORTED)` — `runAlterPrimaryKey` catches that specific code and falls back to a generic shadow-table rebuild that copies all rows from the old table into a new table with the updated PK definition, then swaps it in place. Any other thrown error propagates unchanged. Beware what the fallback cannot do: a shadow rebuild copies **committed** rows only, so a module that owns transactional pending state must either re-key it natively or refuse the change with a non-`UNSUPPORTED` error (`BUSY` reads best) while a transaction holds uncommitted writes — an `UNSUPPORTED` refusal is swallowed by the fallback and the pending writes are silently lost.

The engine will also decline to run the fallback at all in two cases, raising a sited error instead (so "throws `UNSUPPORTED`" does not guarantee the statement then succeeds):

- **The module implements no `renameTable`.** The rebuild finishes by renaming the shadow table over the original, and a module that never hears about that rename keeps its rows under the shadow name — the rebuilt table cannot be connected. Refused with `UNSUPPORTED` regardless of transaction state. A module that wants the fallback must implement `renameTable`.
- **An explicit (`BEGIN`-opened) transaction is in progress.** The rebuild's `DROP` + `RENAME` survives `ROLLBACK` while its row copy does not, so a rollback would leave an empty table and destroy rows committed before the transaction began. Refused with `ERROR` (not `BUSY` — retrying inside the same transaction can never succeed). This is the engine's backstop for *any* module; it does not remove a module's own obligation to refuse with `BUSY` when it holds uncommitted writes, since that refusal has to happen even when the module's own `alterTable` is present.

Neither check runs before your `alterTable` — both sit between it and the rebuild, so a module raising `UNSUPPORTED` (which by contract has mutated nothing) still sees the catalog, the table and the transaction left untouched by the refusal.

## Best Practices

### 1. Estimate honestly

`cost` and `rows` drive join order, aggregation strategy, and materialization decisions, so
a wrong estimate buys a wrong plan. Charge `O(n)` for a sequential scan, `O(log n)` for an
index seek, `O(k + log n)` for an index scan returning `k` rows. Push filtering in wherever
you can: what you decline stays a residual above the boundary, so a pushed filter costs
nothing and saves transfer.

### 2. Report capabilities conservatively

If `supports()` returns a result, the module must execute that pipeline correctly; if
`getBestAccessPlan()` marks a filter handled, the module must apply it. Over-reporting
yields silent wrong answers, not slow ones.

### 3. Preserve Attribute IDs

When implementing `xExecutePlan()`, preserve the attribute IDs from the input plan:
- Column references use stable attribute IDs
- Transformations must maintain these IDs
- See [runtime.md](runtime.md) for attribute system details

## Common Patterns

### Indexed Table

A scan-only module is this one minus the seek arm: return `handledFilters` all-false with
scan cost and let every predicate stay residual.

```typescript
class IndexedTable extends VirtualTable {
  private index = new Map<SqlValue, Row[]>();

  getBestAccessPlan(req: BestAccessPlanRequest): BestAccessPlanResult {
    // Claim the FIRST '=' on column 0 only — a second `id = ...` is never seeked
    // and must stay residual. See "Claiming handledFilters" above.
    const eqIndex = req.filters.findIndex(f => f.op === '=' && f.columnIndex === 0);
    if (eqIndex >= 0) {
      return {
        handledFilters: req.filters.map((_f, i) => i === eqIndex),
        cost: 1,
        rows: 1,
        isSet: true,
        explains: 'Index equality seek'
      };
    }
    return {
      handledFilters: req.filters.map(() => false),
      cost: 100,
      rows: 100,
      explains: 'Full table scan'
    };
  }

  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (filterInfo.argIndices.length > 0) {
      const key = filterInfo.args[0];
      yield* this.index.get(key) || [];
    } else {
      for (const rows of this.index.values()) {
        yield* rows;
      }
    }
  }

  async update(op: string, values?: Row, oldKeys?: Row): Promise<Row | undefined> {
    if (op === 'insert' && values) {
      const key = values[0];
      if (!this.index.has(key)) this.index.set(key, []);
      this.index.get(key)!.push(values);
    }
    return undefined;
  }

  async disconnect(): Promise<void> {}
}
```

## Statistics for Cost-Based Optimization

Virtual table modules can optionally provide statistics for the optimizer's cost model. Implement `getStatistics()` on your `VirtualTable` subclass to report row counts, per-column distinct values, min/max, and histograms.

```typescript
import type { TableStatistics, ColumnStatistics } from '@quereus/quereus';

class MyTable extends VirtualTable {
  getStatistics(): TableStatistics {
    return {
      rowCount: this.data.length,
      columnStats: new Map([
        ['id', { distinctCount: this.data.length, nullCount: 0 }],
        ['name', { distinctCount: this.uniqueNames, nullCount: 0 }],
      ]),
    };
  }
}
```

When `getStatistics()` is implemented, the `ANALYZE` command calls it directly. Otherwise, ANALYZE performs a full scan to collect statistics. Statistics are cached on `TableSchema.statistics` and consumed by `CatalogStatsProvider` for selectivity estimation.

## Update results and REPLACE displacement

`update()` returns an `UpdateResult`. On success (`{ status: 'ok', … }`) it reports what the call actually did through `row`, plus — via two **independent, additive, optional** channels — any rows this same call displaced through `OR REPLACE` conflict resolution. A module that reports neither displacement channel behaves exactly as it would have before they existed, so those two are purely opt-in; `row` is not.

```typescript
type UpdateResult =
  | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
  | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
```

- **`row`** — **whether** you return it says a row really was written or removed; **what** you return is the row you stored. Leaving it out is how you report that nothing changed — a key-not-found UPDATE/DELETE, or a conflict you resolved as IGNORE — and the executor then skips the entire post-write pipeline and emits no row downstream. So return it on every real write, on all four operations. Its contents matter for INSERT/UPDATE: `row` is `args.values` after your own coercion to the declared column logical types. **If you coerce, return the coerced row.** The executor reports `row` — not the values it handed you — to every post-write consumer: `RETURNING`, change tracking, row-time materialized-view maintenance, FK cascades, and data-change events. Returning the raw input from a coercing module makes `RETURNING` disagree with a subsequent `select` of the same row (a `json` column would report the input TEXT while the table holds a parsed JSON value). Nothing is coerced above `update()`, so your pass is the only one — you will never be handed a value you already converted. A row whose width is not the table's column count makes the executor fall back to the proposed values. For DELETE the contents are never read (the OLD image comes from the source scan), so a PK-only placeholder is fine.
- **`replacedRow`** — the row displaced at the **same primary key** by a PK-collision REPLACE (the new row landed on an occupied PK; the old row had the same PK). The executor models it as an update-in-place of that PK slot: change-tracking as `update(replacedRow → newRow)` on the INSERT path (or `delete(replacedRow)` on a UPDATE move), with foreign-key actions fired as a *delete* of the old image.
- **`evictedRows`** — rows at **other primary keys** fully removed because REPLACE resolved a **non-PK UNIQUE** conflict for this same `update()` call. Report them in **user-facing schema** (no internal/overlay columns). The executor models **each** as a full DELETE — change-tracking, row-time materialized-view maintenance, foreign-key `ON DELETE` actions (CASCADE / SET NULL / …), and a delete event — fired **before** the new row's own bookkeeping, matching the substrate's evict-then-write order.

Report `evictedRows` whenever your `update()` internally deletes a row at a different PK to resolve a secondary-UNIQUE REPLACE; otherwise those cross-cutting effects (FK cascades, change subscriptions, events, covering-MV backing maintenance) silently do **not** run for the evicted row. Detection is necessarily module-specific (each module enumerates its current rows its own way), but the maintenance and cascades are **not** — reporting the eviction lets the engine's single post-write pipeline handle them uniformly. The two channels are independent and may both be present in principle; the executor handles each cleanly.

> **`ON DELETE RESTRICT` / `NO ACTION` enforcement for evictions.** The executor enforces FK `RESTRICT` / `NO ACTION` for an evicted row alongside the FK *actions* (`CASCADE` / `SET NULL` / `SET DEFAULT`). The substrate has already physically deleted the row by the time it reports `evictedRows`, so there is no pre-mutation point to block at; instead the executor runs the transitive RESTRICT scan **post-eviction** (the child rows it keys off remain) and, on a violation, throws — the statement-scope savepoint then rolls back, unwinding both the eviction and the writing row. A secondary-UNIQUE REPLACE that would orphan a `RESTRICT` (or default `NO ACTION`) child therefore fails the statement and leaves data unchanged, matching SQLite. Enforced on the key-based memory, direct-store, and isolation-wrapped substrates; rowid-chained backends (lamina) remain out of scope (the post-eviction transitive recursion cannot dereference the already-removed parent), mirroring the documented SET-DEFAULT recursion gap.

## Mutation Statements

Virtual table modules can opt-in to receive deterministic mutation statements for each row-level operation. This enables replication, audit logging, and change data capture with guaranteed reproducibility.

### Overview

When a module sets `wantStatements: true`, Quereus provides a `mutationStatement` string with each `update()` call. This statement:

- Represents the **bottom-level mutation** at the VirtualTable.update() level (not the top-level DML statement)
- Contains all values as **literals** (no parameters; non-deterministic source expressions like `random()` or `datetime('now')` are already resolved to the concrete per-row values the engine evaluated)
- Includes **resolved mutation context** values as literals in the WITH CONTEXT clause
- Is the **audit / transport encoding** of the resolved per-row primitive that hit the module; replay is the act of applying that primitive at the same module boundary on another instance — not re-parsing the captured SQL through the full DML pipeline (re-execution would re-fire CHECKs, default evaluation, and generated-column computation, which is explicitly not the supported replay path)

### Module Opt-In

Modules enable mutation statements by setting a property:

```typescript
class MyReplicatedTable extends VirtualTable {
  // Opt-in to mutation statements
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // args.mutationStatement contains the deterministic SQL statement
    if (args.mutationStatement) {
      await this.replicationLog.append(args.mutationStatement);
    }

    // Perform the actual mutation
    return this.performUpdate(args);
  }
}
```

### Statement Format

Mutation statements use Quereus SQL syntax with all values as literals:

**INSERT Example:**
```sql
-- Original statement with parameters
insert into orders (id, amount) values (:id, :amount)

-- Logged mutation statement (per row)
insert into orders (id, amount) values (1, 100)
```

**INSERT with Mutation Context:**
```sql
-- Original statement
insert into orders (id, amount, created_at)
with context now = datetime('now')
values (1, 100, now)

-- Logged mutation statement (context resolved to literal)
insert into orders (id, amount, created_at) with context now = '2024-01-15T10:30:00Z' values (1, 100, '2024-01-15T10:30:00Z')
```

**UPDATE Example:**
```sql
-- Original statement
update users set name = :newName where id = :userId

-- Logged mutation statement (per row)
update users set name = 'Alice' where id = 1
```

**DELETE Example:**
```sql
-- Original statement
delete from sessions where user_id = :userId

-- Logged mutation statement (per row)
delete from sessions where user_id = 42 and session_id = 'abc123'
```

### Determinism Guarantees

The mutation statement system ensures determinism by:

1. **Resolving Execution Parameters**: All `:name` and `?` parameters are replaced with their literal values
2. **Resolving Mutation Context**: All context variables are evaluated once per statement and emitted as literals
3. **Resolving Defaults / Generated Columns**: DEFAULT and `GENERATED ALWAYS AS` expressions are evaluated per row and emitted as literal values — this is true even when the source expressions contain non-deterministic functions (allowed under `pragma nondeterministic_schema = true`; see [Determinism Validation](determinism.md))
4. **Preserving Order**: Mutations are logged in the order they're applied to the virtual table

Replay then means: take the captured primitive and re-apply it at the module boundary (e.g. feed `mutationStatement` rows back through `vtab.update()` on the replica), not re-execute the SQL through the full DML pipeline. The atomicity of the original commit — including deferred CHECKs that were evaluated once at commit time — is preserved by replaying the transaction's writes as a unit.

### Use Cases

**Replication:**
```typescript
class ReplicatedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Send mutation to replicas
    await this.replicator.broadcast(args.mutationStatement!);

    // Apply locally
    return this.storage.update(args);
  }
}
```

**Audit Logging:**
```typescript
class AuditedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Log mutation with timestamp and user
    await this.auditLog.record({
      timestamp: Date.now(),
      user: this.currentUser,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

**Change Data Capture:**
```typescript
class CDCTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Publish change event
    await this.eventBus.publish({
      table: this.tableName,
      operation: args.operation,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

The database-level event system a module feeds — `getEventEmitter()`, the auto-event path,
transaction batching, and the row-shape / table-name / row-key contract across mid-transaction
ALTER — is documented separately in [Database-Level Event System](module-events.md).

## See Also

- [Database-Level Event System](module-events.md) - Data and schema change events
- [Optimizer Documentation](optimizer.md) - Detailed optimization architecture
- [Runtime Documentation](runtime.md) - Execution model and context system
- [Plugins Documentation](plugins.md) - Plugin packaging and discovery

