/**
 * S3 Snapshot Store - Full database snapshots for faster restore.
 *
 * Stores periodic full snapshots to S3 at:
 *   <prefix><storage_path>/snapshots/<timestamp>_<snapshot_id>.json.gz
 *
 * Snapshots are triggered by:
 * - Time interval (e.g., every 5 minutes)
 * - Change volume threshold (e.g., every 1000 changes)
 */

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { serviceLog } from '../common/logger.js';
import { serializeSnapshotChunk, deserializeSnapshotChunk } from '../common/index.js';
import {
	type S3StorageConfig,
	type StoragePathResolver,
	buildSnapshotKey,
	defaultStoragePathResolver,
} from './s3-config.js';
import type { SyncManager, SnapshotChunk, SnapshotColumnVersionsChunk, SerializedSnapshotChunk } from '@quereus/sync';

/**
 * Snapshot metadata stored alongside the snapshot.
 */
export interface SnapshotMetadata {
  /** Unique snapshot identifier */
  snapshotId: string;

  /** Database ID this snapshot belongs to */
  databaseId: string;

  /** Timestamp when snapshot was created */
  timestamp: string;

  /** Total number of rows in the snapshot */
  totalRows: number;

  /** Total number of tables in the snapshot */
  totalTables: number;

  /** Compressed size in bytes */
  compressedSizeBytes: number;

  /** HLC timestamp of latest change in snapshot */
  hlcTimestamp?: string;
}

/**
 * Configuration for periodic snapshots.
 */
export interface SnapshotScheduleConfig {
  /** Interval in milliseconds between snapshots (default: 5 minutes) */
  intervalMs: number;

  /** Change count threshold to trigger snapshot (default: 1000) */
  changeThreshold: number;

  /** Maximum number of snapshots to retain per database (default: 5) */
  maxRetained: number;
}

const DEFAULT_SCHEDULE_CONFIG: SnapshotScheduleConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  changeThreshold: 1000,
  maxRetained: 5,
};

/**
 * Tracker for pending snapshot operations.
 */
interface DatabaseSnapshotState {
  lastSnapshotAt: number;
  changesSinceSnapshot: number;
  snapshotInProgress: boolean;
}

/**
 * S3 Snapshot Store for full database snapshots.
 */
export class S3SnapshotStore {
  private readonly client: S3Client;
  private readonly config: S3StorageConfig;
  private readonly scheduleConfig: SnapshotScheduleConfig;
  private readonly resolveStoragePath: StoragePathResolver;
  private readonly databaseStates = new Map<string, DatabaseSnapshotState>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    client: S3Client,
    config: S3StorageConfig,
    scheduleConfig: Partial<SnapshotScheduleConfig> = {},
    resolveStoragePath?: StoragePathResolver
  ) {
    this.client = client;
    this.config = config;
    this.scheduleConfig = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfig };
    this.resolveStoragePath = resolveStoragePath ?? defaultStoragePathResolver;
  }

  /**
   * Start periodic snapshot checks.
   */
  start(): void {
    if (this.checkTimer) return;
    // Check every 30 seconds for databases needing snapshots
    this.checkTimer = setInterval(() => this.checkScheduledSnapshots(), 30_000);
    serviceLog('S3SnapshotStore started with interval=%dms, threshold=%d',
      this.scheduleConfig.intervalMs, this.scheduleConfig.changeThreshold);
  }

  /**
   * Stop periodic snapshot checks.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Record that changes have been applied to a database.
   */
  recordChanges(databaseId: string, changeCount: number): void {
    let state = this.databaseStates.get(databaseId);
    if (!state) {
      state = {
        lastSnapshotAt: 0,
        changesSinceSnapshot: 0,
        snapshotInProgress: false,
      };
      this.databaseStates.set(databaseId, state);
    }
    state.changesSinceSnapshot += changeCount;
  }

  /**
   * Check if a database needs a snapshot based on time or change volume.
   */
  needsSnapshot(databaseId: string): boolean {
    const state = this.databaseStates.get(databaseId);
    if (!state || state.snapshotInProgress) return false;

    const now = Date.now();
    const timeSinceSnapshot = now - state.lastSnapshotAt;

    // Check time interval
    if (timeSinceSnapshot >= this.scheduleConfig.intervalMs) {
      return true;
    }

    // Check change threshold
    if (state.changesSinceSnapshot >= this.scheduleConfig.changeThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Check all tracked databases for scheduled snapshots.
   */
  private checkScheduledSnapshots(): void {
    for (const databaseId of this.databaseStates.keys()) {
      if (this.needsSnapshot(databaseId)) {
        serviceLog('Scheduled snapshot triggered for: %s', databaseId);
        // Note: actual snapshot creation requires the SyncManager,
        // which should be called by the coordinator
      }
    }
  }

  /**
   * Create and store a full snapshot for a database.
   */
  async createSnapshot(
    databaseId: string,
    syncManager: SyncManager
  ): Promise<SnapshotMetadata> {
    const state = this.databaseStates.get(databaseId) ?? {
      lastSnapshotAt: 0,
      changesSinceSnapshot: 0,
      snapshotInProgress: false,
    };
    this.databaseStates.set(databaseId, state);

    if (state.snapshotInProgress) {
      throw new Error(`Snapshot already in progress for ${databaseId}`);
    }

    state.snapshotInProgress = true;
    const snapshotId = randomUUID();
    const timestamp = new Date().toISOString();

    try {
      const storagePath = this.resolveStoragePath(databaseId);
      const key = buildSnapshotKey(this.config, storagePath, snapshotId, timestamp);

      // Stream snapshot chunks through gzip compression
      let totalEntries = 0;
      let totalTables = 0;
      const chunks: SnapshotChunk[] = [];

      for await (const chunk of syncManager.getSnapshotStream()) {
        chunks.push(chunk);
        if (this.isColumnVersionsChunk(chunk)) {
          totalEntries += chunk.entries?.length ?? 0;
        } else if (chunk.type === 'table-start') {
          totalTables++;
        }
      }

      // Serialize chunks for JSON-safe storage, then compress
      const jsonData = JSON.stringify({
        snapshotId, databaseId, timestamp,
        chunks: chunks.map(c => serializeSnapshotChunk(c)),
      });
      const compressed = await this.compressData(jsonData);

      // Upload to S3
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: compressed,
        ContentType: 'application/gzip',
        ContentEncoding: 'gzip',
        Metadata: {
          'x-snapshot-id': snapshotId,
          'x-database-id': databaseId,
          'x-entry-count': String(totalEntries),
          'x-table-count': String(totalTables),
        },
      }));

      const metadata: SnapshotMetadata = {
        snapshotId,
        databaseId,
        timestamp,
        totalRows: totalEntries, // Using entries count as "rows"
        totalTables,
        compressedSizeBytes: compressed.length,
      };

      serviceLog('Snapshot created: %s (%d entries, %d tables, %d bytes)',
        snapshotId, totalEntries, totalTables, compressed.length);

      // Update state
      state.lastSnapshotAt = Date.now();
      state.changesSinceSnapshot = 0;

      return metadata;
    } finally {
      state.snapshotInProgress = false;
    }
  }

  /**
   * Type guard to check if a chunk is a column-versions chunk.
   */
  private isColumnVersionsChunk(chunk: SnapshotChunk): chunk is SnapshotColumnVersionsChunk {
    return chunk.type === 'column-versions';
  }

  /**
   * Check if a snapshot exists for a database.
   */
  async hasSnapshot(databaseId: string): Promise<boolean> {
    const storagePath = this.resolveStoragePath(databaseId);
    const prefix = this.config.keyPrefix ?? '';
    const listPrefix = `${prefix}${storagePath}/snapshots/`;

    const command = new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: listPrefix,
      MaxKeys: 1,
    });

    const response = await this.client.send(command);
    return (response.KeyCount ?? 0) > 0;
  }

  /**
   * Download and deserialize the latest snapshot for a database.
   * Returns null if no snapshots exist.
   */
  async downloadLatestSnapshot(databaseId: string): Promise<{
    chunks: SnapshotChunk[];
    metadata: { snapshotId: string; timestamp: string };
  } | null> {
    const storagePath = this.resolveStoragePath(databaseId);
    const prefix = this.config.keyPrefix ?? '';
    const listPrefix = `${prefix}${storagePath}/snapshots/`;

    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: listPrefix,
    }));

    if (!response.Contents?.length) return null;

    // Keys have timestamp prefix → alphabetical order is chronological
    const sorted = response.Contents
      .filter(obj => obj.Key)
      .sort((a, b) => a.Key!.localeCompare(b.Key!));
    const latestKey = sorted[sorted.length - 1].Key!;

    serviceLog('Downloading snapshot for %s: %s', databaseId, latestKey);

    const getResponse = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: latestKey,
    }));

    const compressed = await getResponse.Body!.transformToByteArray();
    const decompressed = await this.decompressData(Buffer.from(compressed));
    const data = JSON.parse(decompressed);

    const chunks = (data.chunks as SerializedSnapshotChunk[]).map(c => deserializeSnapshotChunk(c));

    serviceLog('Downloaded snapshot for %s: %s (%d chunks)',
      databaseId, data.snapshotId, chunks.length);

    return {
      chunks,
      metadata: { snapshotId: data.snapshotId, timestamp: data.timestamp },
    };
  }

  /**
   * Compress data using gzip.
   */
  private async compressData(data: string): Promise<Buffer> {
    const gzip = createGzip();
    const buffers: Buffer[] = [];

    gzip.on('data', (chunk) => buffers.push(chunk));

    return new Promise((resolve, reject) => {
      gzip.on('end', () => resolve(Buffer.concat(buffers)));
      gzip.on('error', reject);
      gzip.end(Buffer.from(data, 'utf-8'));
    });
  }

  /**
   * Decompress gzipped data.
   */
  private async decompressData(data: Buffer): Promise<string> {
    const gunzip = createGunzip();
    const buffers: Buffer[] = [];

    gunzip.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise((resolve, reject) => {
      gunzip.on('end', () => resolve(Buffer.concat(buffers).toString('utf-8')));
      gunzip.on('error', reject);
      gunzip.end(data);
    });
  }

  /**
   * Get databases that need snapshots (for external scheduling).
   */
  getDatabasesNeedingSnapshot(): string[] {
    const result: string[] = [];
    for (const databaseId of this.databaseStates.keys()) {
      if (this.needsSnapshot(databaseId)) {
        result.push(databaseId);
      }
    }
    return result;
  }

  /**
   * Force a snapshot for a database (ignoring schedule).
   */
  async forceSnapshot(databaseId: string, syncManager: SyncManager): Promise<SnapshotMetadata> {
    return this.createSnapshot(databaseId, syncManager);
  }

  /**
   * Get snapshot state for a database.
   */
  getState(databaseId: string): DatabaseSnapshotState | undefined {
    return this.databaseStates.get(databaseId);
  }
}

/**
 * Create an S3 snapshot store from configuration.
 */
export function createS3SnapshotStore(
  client: S3Client,
  config: S3StorageConfig,
  scheduleConfig?: Partial<SnapshotScheduleConfig>,
  resolveStoragePath?: StoragePathResolver
): S3SnapshotStore {
  return new S3SnapshotStore(client, config, scheduleConfig, resolveStoragePath);
}

