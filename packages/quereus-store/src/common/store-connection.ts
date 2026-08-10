/**
 * Generic VirtualTableConnection implementation for KVStore-backed tables.
 *
 * Delegates transaction operations to a shared TransactionCoordinator.
 */

import type { VirtualTableConnection } from '@quereus/quereus';
import type { TransactionCoordinator } from './transaction.js';

let connectionCounter = 0;

/**
 * Connection to a KVStore-backed table.
 *
 * All connections of one storage module share its single TransactionCoordinator
 * for cross-table atomicity (see {@link TransactionCoordinator}). Because the
 * coordinator is no longer per-table, coordinator identity can no longer pin a
 * connection to one backing-table incarnation; {@link owner} carries that pin
 * instead — set to the owning StoreTable ONLY for connections the backing host
 * creates (see `StoreBackingHost.connect` / `ownsConnection`). Ordinary DML
 * connections leave it `undefined`.
 */
export class StoreConnection implements VirtualTableConnection {
  public readonly connectionId: string;
  public readonly tableName: string;
  /** The owning StoreTable instance, for backing-host incarnation pinning (host connections only). */
  public readonly owner?: object;
  private coordinator: TransactionCoordinator;

  constructor(tableName: string, coordinator: TransactionCoordinator, owner?: object) {
    this.connectionId = `store-${tableName}-${++connectionCounter}`;
    this.tableName = tableName;
    this.coordinator = coordinator;
    this.owner = owner;
  }

  /** Begin a transaction. */
  begin(): void {
    this.coordinator.begin();
  }

  /** Commit the transaction. */
  async commit(): Promise<void> {
    await this.coordinator.commit();
  }

  /** Rollback the transaction. */
  rollback(): void {
    this.coordinator.rollback();
  }

  /** Create a savepoint. */
  createSavepoint(index: number): void {
    this.coordinator.createSavepoint(index);
  }

  /** Release a savepoint. */
  releaseSavepoint(index: number): void {
    this.coordinator.releaseSavepoint(index);
  }

  /** Rollback to a savepoint. */
  rollbackToSavepoint(index: number): void {
    this.coordinator.rollbackToSavepoint(index);
  }

  /** Disconnect (rolls back if in transaction). */
  async disconnect(): Promise<void> {
    if (this.coordinator.isInTransaction()) {
      this.coordinator.rollback();
    }
  }
}

