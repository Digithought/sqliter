/**
 * Basis-table lifecycle store — durable per-basis-table classification + the
 * mapped-since / unmapped-since bookkeeping that drives legacy-table retirement
 * (`docs/migration.md` § 2 Converge).
 *
 * Each shared (basis) table is classified into one of four states relative to
 * the app's current lens deployments and the basis schema's own derivations:
 *
 *   - `directly-mapped`        — some deployed lens backs a logical column with it.
 *   - `derivation-source-only` — referenced *solely* as a maintained table's
 *                                source (the "this table is now legacy" signal).
 *   - `unreferenced`           — in the basis, but neither mapped nor a
 *                                derivation source.
 *   - `detached`               — no longer in the basis schema; physical storage
 *                                may linger (an eviction candidate).
 *
 * The classification is recomputed on every lens deploy
 * ({@link import('../sync/sync-manager-impl.js').SyncManagerImpl.recordLensDeployment}).
 * Records are KV-durable so the classification — and its timestamps — survive a
 * restart with no prior deploy in the session.
 *
 * The record is a flat JSON-safe object (strings / numbers / booleans /
 * `string[]`), so serialization is a plain `JSON.stringify`; no custom
 * SqlValue / HLC encoding is needed (unlike `quarantine.ts` / `column-version.ts`).
 */

import type { SqlValue } from '@quereus/quereus';
import type { KVStore, WriteBatch } from '@quereus/store';
import type { SyncConfig } from '../sync/protocol.js';
import { buildBasisLifecycleKey, buildAllBasisLifecycleScanBounds } from './keys.js';

/** The aggregate lifecycle state of one basis table. */
export type BasisLifecycleState =
  | 'directly-mapped'
  | 'derivation-source-only'
  | 'unreferenced'
  | 'detached';

/**
 * Per-table eviction override (the `quereus.sync.evict` reserved tag, captured
 * into the lifecycle record at observation time). `never` opts the table out of
 * auto-eviction; `immediate` evicts on the first sweep after detach (zero
 * horizon); a number is a custom horizon in milliseconds. Absent ⇒ fall back to
 * the global {@link SyncConfig.basisEviction} mode.
 */
export type EvictPolicy = 'never' | 'immediate' | number;

/**
 * The persisted lifecycle record for one basis table.
 *
 * `mappedBy` stores each deployed logical schema's contribution separately and
 * the aggregate `state` ORs them, so a basis table mapped by logical schema `A`
 * but not `B` stays `directly-mapped` until the *last* mapper drops it — without
 * the recorder having to enumerate every deployed logical schema (no public
 * enumerator exists; see the recorder's per-schema-contribution note).
 */
export interface BasisTableLifecycleRecord {
  /** Basis schema name (original case where known, else the lowercased key part). */
  schema: string;
  /** Basis table name (original case where known, else the lowercased key part). */
  table: string;
  /** Aggregate state across all deployed logical schemas + the basis derivations. */
  state: BasisLifecycleState;
  /** Logical schema names (lowercased) whose latest deploy directly maps this table. */
  mappedBy: string[];
  /** True iff some maintained table in the current basis lists it in `sourceTables`. */
  derivationSource: boolean;
  /** True iff the table is present in the basis schema as of the last deploy. */
  inBasis: boolean;
  /** Wall-clock ms when the aggregate state last entered `directly-mapped`. */
  mappedSince?: number;
  /** Wall-clock ms when it last left `directly-mapped` (the retirement hint timestamp). */
  unmappedSince?: number;
  /** Wall-clock ms when the state last entered `detached` (cleared on re-attach). */
  detachedAt?: number;
  /**
   * The dynamic network signal: the wall-time (ms) of the latest *inbound remote*
   * write observed while this table was NOT directly mapped locally — presumed to
   * originate at a peer that still maps it directly (a conservative over-estimate;
   * see `docs/migration.md` § 2 Converge). Bumped by the change applicator; resets
   * the eviction quiet clock. Absent until the first such write.
   */
  lastDirectlyMappedWriteAt?: number;
  /**
   * Per-table eviction override, captured from the `quereus.sync.evict` reserved
   * tag at observation time (the tag is gone once the table detaches, so it is
   * snapshotted while in-basis and carried through detach). Absent ⇒ the global
   * {@link SyncConfig.basisEviction} mode governs.
   */
  evictPolicy?: EvictPolicy;
  /**
   * Secondary-index names captured while the table was in-basis, so the eviction
   * sweep can reclaim the index stores by name after detach (the table schema —
   * and its index list — is gone once detached). Carried through detach; absent
   * for an index-less table.
   */
  indexNames?: string[];
}

/**
 * Aggregate one basis table's state from its three orthogonal facts.
 * `directly-mapped` wins over `derivation-source-only`, which wins over plain
 * basis membership; a table no longer in the basis is `detached`.
 */
export function classifyBasisLifecycle(
  mappedBy: ReadonlyArray<string>,
  derivationSource: boolean,
  inBasis: boolean,
): BasisLifecycleState {
  if (mappedBy.length > 0) return 'directly-mapped';
  if (derivationSource) return 'derivation-source-only';
  if (inBasis) return 'unreferenced';
  return 'detached';
}

/**
 * Split a lowercased `schema.table` relation key into its parts (first dot is the
 * separator — schema names carry no dots). Used as the display-name fallback for
 * a key that no current basis enumeration provides original case for (a stored
 * detached record, or a derivation source that resolved to no basis member).
 */
export function splitRelKey(key: string): { schema: string; table: string } {
  const dot = key.indexOf('.');
  if (dot === -1) return { schema: '', table: key };
  return { schema: key.slice(0, dot), table: key.slice(dot + 1) };
}

/**
 * True iff the recomputed record differs from the prior in any persisted field —
 * the gate that keeps an idempotent re-apply (identical deploy) from rewriting
 * every record. Compares the comparable fields explicitly rather than by
 * stringify so field-presence/order quirks never produce a false diff. Reserved
 * eviction-policy fields are carried through unchanged, so they only differ when
 * `basis-eviction-policy` actually mutated them.
 */
export function basisLifecycleRecordChanged(
  a: BasisTableLifecycleRecord,
  b: BasisTableLifecycleRecord,
): boolean {
  return a.state !== b.state
    || a.derivationSource !== b.derivationSource
    || a.inBasis !== b.inBasis
    || a.mappedSince !== b.mappedSince
    || a.unmappedSince !== b.unmappedSince
    || a.detachedAt !== b.detachedAt
    || a.lastDirectlyMappedWriteAt !== b.lastDirectlyMappedWriteAt
    || a.evictPolicy !== b.evictPolicy
    || a.mappedBy.length !== b.mappedBy.length
    || a.mappedBy.some((v, i) => v !== b.mappedBy[i])
    || (a.indexNames ?? []).length !== (b.indexNames ?? []).length
    || (a.indexNames ?? []).some((v, i) => v !== (b.indexNames ?? [])[i]);
}

/**
 * Parse a `quereus.sync.evict` reserved-tag value into an {@link EvictPolicy}, or
 * `undefined` when absent / malformed (a malformed tag falls back to the global
 * mode rather than failing the deploy — the engine's reserved-tag validator
 * surfaces the shape error separately). Accepts `'never'` / `'immediate'`
 * (case-insensitive) and a non-negative number (numeric value or numeric string).
 */
export function parseEvictPolicyTag(value: SqlValue): EvictPolicy | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : undefined;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'never') return 'never';
    if (v === 'immediate') return 'immediate';
    if (v.length === 0) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Resolve a record's effective eviction horizon (ms) by composing its per-table
 * {@link EvictPolicy} override with the global {@link SyncConfig.basisEviction}
 * mode. Returns `null` for "never evict", `0` for "evict immediately once
 * detached", or a positive horizon in milliseconds. The per-table override always
 * wins over the global mode.
 */
export function effectiveEvictHorizonMs(
  record: Pick<BasisTableLifecycleRecord, 'evictPolicy'>,
  config: Pick<SyncConfig, 'basisEviction' | 'retentionHorizonMs'>,
): number | null {
  const p = record.evictPolicy;
  if (p === 'never') return null;
  if (p === 'immediate') return 0;
  if (typeof p === 'number') return p;
  // No per-table override — fall back to the global mode.
  const eviction = config.basisEviction ?? { mode: 'horizon' as const };
  switch (eviction.mode) {
    case 'never': return null;
    case 'immediate': return 0;
    case 'horizon':
    default: return eviction.horizonMs ?? config.retentionHorizonMs;
  }
}

/**
 * The wall-time (ms) the table's "quiet" clock starts from: the later of when the
 * local peer stopped directly mapping it (`unmappedSince`, falling back to
 * `detachedAt` for a table never directly mapped) and the last observed inbound
 * remote write (`lastDirectlyMappedWriteAt`). See `docs/migration.md` § 4 Contract.
 */
export function quietSince(record: BasisTableLifecycleRecord): number {
  const base = record.unmappedSince ?? record.detachedAt ?? 0;
  return Math.max(base, record.lastDirectlyMappedWriteAt ?? 0);
}

/**
 * Whether a record is eligible for storage reclamation at `now`. Default eviction
 * targets `detached` tables ONLY — an in-basis `unreferenced` table is a signal,
 * never auto-dropped (dropping it would diverge from the basis the app still
 * declares, and a re-map would resurrect it). `'never'` opts out entirely;
 * `'immediate'` still requires `detached`.
 */
export function isEvictable(
  record: BasisTableLifecycleRecord,
  now: number,
  config: Pick<SyncConfig, 'basisEviction' | 'retentionHorizonMs'>,
): boolean {
  if (record.state !== 'detached') return false;
  const horizon = effectiveEvictHorizonMs(record, config);
  if (horizon === null) return false;            // 'never'
  return now - quietSince(record) >= horizon;
}

/** Serialize a lifecycle record to bytes (flat JSON — see file header). */
export function serializeBasisLifecycleRecord(record: BasisTableLifecycleRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/** Deserialize a lifecycle record from bytes. */
export function deserializeBasisLifecycleRecord(buffer: Uint8Array): BasisTableLifecycleRecord {
  return JSON.parse(new TextDecoder().decode(buffer)) as BasisTableLifecycleRecord;
}

/**
 * KV-backed store for basis-table lifecycle records. Owns read / write / iterate;
 * the transition detection + timestamp stamping live in the recorder, which
 * stages writes into a single batch per deploy.
 */
export class BasisLifecycleStore {
  constructor(private readonly kv: KVStore) {}

  /** Read one record by basis `schema.table`, or undefined when none is stored. */
  async get(schemaName: string, tableName: string): Promise<BasisTableLifecycleRecord | undefined> {
    const value = await this.kv.get(buildBasisLifecycleKey(schemaName, tableName));
    return value ? deserializeBasisLifecycleRecord(value) : undefined;
  }

  /**
   * Stage a record write into a caller-owned batch (keyed by `schema.table`
   * lowercased, so re-recording overwrites its own entry). The recorder folds
   * all of a deploy's changed records into one batch.
   */
  put(batch: WriteBatch, record: BasisTableLifecycleRecord): void {
    batch.put(buildBasisLifecycleKey(record.schema, record.table), serializeBasisLifecycleRecord(record));
  }

  /**
   * Delete one record by basis `schema.table` (the eviction sweep clears the
   * record once a detached table's storage is reclaimed; a later re-create starts
   * fresh). Idempotent — deleting an absent key is a no-op.
   */
  async delete(schemaName: string, tableName: string): Promise<void> {
    await this.kv.delete(buildBasisLifecycleKey(schemaName, tableName));
  }

  /**
   * Read every stored record, keyed by lowercased `schema.table` — the recorder's
   * starting point for transition detection (it OR-folds the new deploy over these).
   */
  async getAll(): Promise<Map<string, BasisTableLifecycleRecord>> {
    const result = new Map<string, BasisTableLifecycleRecord>();
    for await (const entry of this.kv.iterate(buildAllBasisLifecycleScanBounds())) {
      const record = deserializeBasisLifecycleRecord(entry.value);
      result.set(`${record.schema}.${record.table}`.toLowerCase(), record);
    }
    return result;
  }

  /** List every stored record (introspection — bounded by the basis table count). */
  async list(): Promise<BasisTableLifecycleRecord[]> {
    const records: BasisTableLifecycleRecord[] = [];
    for await (const entry of this.kv.iterate(buildAllBasisLifecycleScanBounds())) {
      records.push(deserializeBasisLifecycleRecord(entry.value));
    }
    return records;
  }
}
