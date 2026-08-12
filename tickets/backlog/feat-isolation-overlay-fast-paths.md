---
description: The isolation layer copies every write into a temporary overlay table and rescans that overlay at commit, which is wasted work for the common case of a single write statement with no reading afterwards; these are the proposed fast paths that would skip it, carried over from the design document.
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus-isolation/src/flush.ts
  - docs/design-isolation-challenges.md
difficulty: medium
tradeoffs: These are speculative optimizations with no measurement behind their claimed benefit, and the isolation layer is Beta with correctness work still landing, so every fast path added multiplies the code shapes each future correctness fix has to cover.
---

# Isolation overlay fast paths

`docs/design-isolation-layer.md` carried a `## Optimization Strategies` chapter — seven proposed
fast paths for the isolation layer, none of them measured — plus a phase checklist with three
items still open. `docs/doc-conventions.md` says unimplemented work does not live in `docs/`
("A doc describing an unimplemented capability is indistinguishable, to a reader, from a doc that
has drifted"), so the chapter was removed from the document and preserved here in full. This
ticket is where that content now lives; nothing was lost.

## Status of each proposal

Read against `packages/quereus-isolation/src` at commit `355ca1ab`. The original chapter's own
status claims were stale — check this table, not the prose below it.

| # | Proposal | Status at `355ca1ab` |
| --- | --- | --- |
| 1 | Direct passthrough for write-only autocommit | **Not shipped.** No passthrough mode exists; `IsolatedTable.update` always calls `ensureOverlay()` (`isolated-table.ts:1160`). |
| 2 | Lazy overlay with deferred creation | **Partly.** The overlay is created lazily on the first write (that is the Phase 4 "lazy overlay creation" item). The further deferral proposed here — buffer writes and only materialize an overlay when a read-after-write arrives — is not shipped; there is no pending-write buffer. |
| 3 | Existence check via point lookup | **Shipped**, and beyond the sketch. `rowExistsInUnderlying` (`flush.ts:111`) drives the underlying's primary-key index through `makePkPointLookupFilter` (`filter-info.ts:21`), and the flush additionally hoists every probe ahead of the first write of that table (`flush.ts:69-73`) because an underlying module is not obliged to serve index-driven reads over its own uncommitted writes. |
| 4 | Batch commit | **Not shipped** as a batched write API — the flush still issues one `update()` per overlay entry (`flush.ts:75-104`). A related but different mechanism *is* shipped: for a `quereus-store` underlying, Phase 2 of the commit rides the store's module-wide transaction coordinator so every table's ops land in one atomic batch (`isolation-module.ts:445-455`). That buys atomicity, not fewer write calls. |
| 5 | Read-only transaction fast path | **Shipped** (`isolated-table.ts:417-422`), and since extended to cover committed-snapshot reads. The chapter's proposed enhancement — skip connection registration entirely for read-only access — is not shipped. |
| 6 | Upsert semantics | **Not shipped.** The flush still probes existence per live row and picks insert vs update (`flush.ts:84-102`). |
| 7 | Planner hints | **Not shipped.** No `IsolationHints` type or equivalent exists. |

Also shipped, from the same phase checklist: `O(1) clearOverlay()` — clearing an overlay releases
the whole staging table (`isolated-table.ts:1939-1942` → `IsolationModule.clearConnectionOverlay`),
it does not delete rows one at a time.

## Open items from the phase checklist

These three were unchecked when the chapter was removed and are not covered by the table above:

- Full integration testing — autocommit mode, and savepoint coordination with the underlying store.
- Switch Quoomb Web's Store and Sync modes to use the isolated path.
- Performance benchmarking of isolated vs. non-isolated access. **Do this first.** Every
  optimization below claims a benefit nobody has measured; a benchmark is what turns this ticket
  from a wish list into scoped work, and it may well show some of these are not worth the shapes
  they add.

## The original chapter, verbatim

Everything below is the text as it stood in `docs/design-isolation-layer.md` at `355ca1ab`,
unedited. Its status claims (notably Optimization 3's block quote and Optimization 5's "Already
Implemented") are the document's own and are superseded by the table above.

## Optimization Strategies

### Current Overhead Analysis

For a single-statement autocommit write (the most common case), the current flow is:

```
Statement.run()
  → _beginImplicitTransaction()
  → IsolatedTable.update()
      → ensureConnection()
      → ensureOverlay()           ← Creates overlay table + indexes
      → write to overlay          ← Memory allocation, BTree insert
  → _commitImplicitTransaction()
      → flushOverlayToUnderlying()
          → full scan overlay     ← Iterate all overlay entries
          → for each entry:
              → rowExistsInUnderlying()  ← Full scan to check existence!
              → underlying.update()
          → underlying.commit()
      → clearOverlay()
```

**Key inefficiencies:**

1. **Overlay creation overhead** — Schema cloning, index creation, even for a single row
2. **Double write** — Row written to overlay, then copied to underlying
3. **Full scan for existence check** — `rowExistsInUnderlying()` does a full table scan per row
4. **Overlay scan at commit** — Even for one row, we iterate the overlay

### Optimization 1: Direct Passthrough for Write-Only Autocommit

**Scenario:** Single DML statement in autocommit mode with no subsequent reads.

**Insight:** If we're just doing `INSERT INTO t VALUES (...)` with no reads, we don't need the overlay at all. The write can go directly to the underlying module.

**Detection:**
- Autocommit mode (no explicit `BEGIN`)
- Statement is pure DML (INSERT/UPDATE/DELETE) without RETURNING
- No reads from the same table within the statement

**Implementation:**

```typescript
interface IsolationModuleConfig {
  // ... existing
  
  /** Enable direct passthrough for write-only autocommit statements */
  enableDirectPassthrough?: boolean;  // default: true
}

class IsolatedTable {
  private directPassthroughMode = false;
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Check if we can use direct passthrough
    if (this.canUseDirectPassthrough()) {
      this.directPassthroughMode = true;
      return this.underlyingTable.update(args);
    }
    
    // ... existing overlay logic
  }
  
  private canUseDirectPassthrough(): boolean {
    return (
      this.db.getAutocommit() &&           // Autocommit mode
      !this.hasChanges &&                   // No prior writes in this "transaction"
      !this.overlayTable &&                 // Overlay not yet created
      !this.pendingReads                    // No reads pending (would need overlay)
    );
  }
  
  async commit(): Promise<void> {
    if (this.directPassthroughMode) {
      // Already written to underlying, just commit
      await this.underlyingTable.commit?.();
      this.directPassthroughMode = false;
      return;
    }
    // ... existing flush logic
  }
}
```

**Benefit:** Eliminates all overlay overhead for simple writes.

**Risk:** Must ensure no reads occur after the write within the same implicit transaction. The planner/executor could hint this.

### Optimization 2: Lazy Overlay with Deferred Creation

**Current:** Overlay created on first write.

**Improvement:** Defer overlay creation until a read-after-write occurs.

```typescript
class IsolatedTable {
  /** Pending writes before overlay is created */
  private pendingWrites: UpdateArgs[] = [];
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    if (!this.overlayTable && this.db.getAutocommit()) {
      // Buffer the write, don't create overlay yet
      this.pendingWrites.push(args);
      this.hasChanges = true;
      // Return optimistic result
      return args.values;
    }
    
    // ... existing logic if overlay exists or explicit transaction
  }
  
  query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (this.pendingWrites.length > 0) {
      // Read-after-write detected, materialize overlay now
      await this.materializePendingWrites();
    }
    // ... existing merge logic
  }
  
  async commit(): Promise<void> {
    if (this.pendingWrites.length > 0 && !this.overlayTable) {
      // No reads occurred, apply directly to underlying
      for (const write of this.pendingWrites) {
        await this.underlyingTable.update(write);
      }
      await this.underlyingTable.commit?.();
      this.pendingWrites = [];
      return;
    }
    // ... existing flush logic
  }
}
```

**Benefit:** Avoids overlay creation for write-only transactions.

### Optimization 3: Existence Check via Point Lookup

**Current:** `rowExistsInUnderlying()` does a full table scan.

**Fix:** Use primary key lookup instead.

```typescript
private async rowExistsInUnderlying(pk: SqlValue[]): Promise<boolean> {
  if (!this.underlyingTable.query) return false;
  
  // Build point lookup filter using PK constraints
  const pkFilter = this.buildPKPointLookupFilter(pk);
  
  for await (const _row of this.underlyingTable.query(pkFilter)) {
    return true;  // Found it
  }
  return false;
}

private buildPKPointLookupFilter(pk: SqlValue[]): FilterInfo {
  const pkIndices = this.getPrimaryKeyIndices();
  const constraints = pkIndices.map((colIdx, i) => ({
    column: colIdx,
    op: IndexConstraintOp.EQ,
    value: pk[i],
  }));
  
  return {
    idxNum: 0,
    idxStr: '_pk_point_lookup',
    constraints,
    args: pk,
    // ... rest of FilterInfo
  };
}
```

> This optimization is now implemented, but the real `buildPKPointLookupFilter` delegates to
> the engine's `makeIndexEqSeekFilterInfo` (via `makePkPointLookupFilter`) so the FilterInfo
> also carries a typed `accessPath` — required by the merge's scan-order resolution above. The
> `idxStr: '_pk_point_lookup'` sketch here predates that and does not reflect the current shape.

**Benefit:** O(log n) instead of O(n) for existence checks.

### Optimization 4: Batch Commit

**Current:** Each overlay entry applied individually to underlying.

**Improvement:** Collect all changes and apply via batch API if available.

```typescript
private async flushOverlayToUnderlying(): Promise<void> {
  // ... collect overlay entries ...
  
  // Check if underlying supports batch writes
  if (this.underlyingTable.batchUpdate) {
    await this.underlyingTable.batchUpdate(overlayEntries.map(e => ({
      operation: e.isTombstone ? 'delete' : 'upsert',
      values: e.dataRow,
      key: e.pk,
    })));
  } else {
    // Fallback to individual updates
    for (const entry of overlayEntries) {
      // ... existing logic
    }
  }
}
```

**Benefit:** Reduces round-trips for underlying modules that support batching (LevelDB, IndexedDB).

### Optimization 5: Read-Only Transaction Fast Path

**Scenario:** Transaction with only reads (SELECT).

**Current:** Overlay is never created (good), but merge logic still checks `hasChanges`.

**Already Implemented:** The `query()` method has this fast path:

```typescript
// Fast path: no overlay or no changes, skip merge overhead
if (!this.overlayTable || !this.hasChanges) {
  return this.underlyingTable.query(filterInfo);
}
```

**Enhancement:** Could also skip connection registration for read-only access.

### Optimization 6: Upsert Semantics

**Current:** At commit, we check `rowExistsInUnderlying()` to decide insert vs update.

**Improvement:** If underlying module supports UPSERT (INSERT OR REPLACE), use it.

```typescript
private async flushOverlayToUnderlying(): Promise<void> {
  const supportsUpsert = this.underlyingTable.capabilities?.upsert;
  
  for (const entry of overlayEntries) {
    if (entry.isTombstone) {
      await this.underlyingTable.update({ operation: 'delete', ... });
    } else if (supportsUpsert) {
      // Skip existence check, let underlying handle it
      await this.underlyingTable.update({
        operation: 'insert',
        onConflict: ConflictResolution.REPLACE,
        values: entry.dataRow,
      });
    } else {
      // ... existing check-then-insert/update logic
    }
  }
}
```

**Benefit:** Eliminates existence check overhead for modules supporting upsert.

### Optimization 7: Planner Hints

The query planner knows the statement structure. It could provide hints to the isolation layer:

```typescript
interface IsolationHints {
  /** Statement is write-only (no reads from written tables) */
  writeOnly?: boolean;
  
  /** Statement is read-only */
  readOnly?: boolean;
  
  /** Tables that will be read after write */
  readAfterWriteTables?: string[];
  
  /** Single-row operation (point insert/update/delete) */
  singleRow?: boolean;
}
```

The executor could pass these hints, allowing the isolation layer to choose optimal strategies.

### Optimization Summary

| Optimization | Benefit | Complexity | Priority |
|-------------|---------|------------|----------|
| Direct passthrough | Eliminates overlay for write-only | Medium | High |
| PK point lookup | O(log n) existence check | Low | High |
| Upsert semantics | Skip existence check | Low | High |
| Deferred overlay | Avoid overlay for write-only | Medium | Medium |
| Batch commit | Fewer round-trips | Medium | Medium |
| Planner hints | Informed optimization | High | Low |

### Recommended Implementation Order

1. **PK point lookup** — Simple fix with immediate benefit
2. **Upsert semantics** — Leverage existing module capabilities  
3. **Direct passthrough** — Major win for common case
4. **Batch commit** — Depends on underlying module support
5. **Planner hints** — Requires cross-layer coordination
