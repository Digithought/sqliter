/**
 * Wire protocol - the single source of truth for the sync transport layer.
 *
 * `protocol.ts` (this module's sibling) holds the transport-agnostic DATA
 * structures (`ChangeSet`, `Change`, `SnapshotChunk`, ...). This module holds
 * everything that turns those structures into JSON-safe objects and back, plus
 * the message envelopes the sync client and coordinator exchange over the wire:
 *
 * - cross-platform base64 helpers (browser btoa/atob, Node `Buffer` fallback);
 * - `Serialized*` types describing the on-the-wire JSON shapes;
 * - codec functions (`serialize*` / `deserialize*`) for change sets, snapshot
 *   chunks, snapshot checkpoints, and HLCs;
 * - the `ClientMessage` / `ServerMessage` unions (the true superset of what both
 *   sides emit and handle);
 * - `PROTOCOL_VERSION`, stamped into the handshake so peers can detect drift.
 *
 * This module imports ONLY from within `@quereus/sync` (`protocol.ts`, the clock,
 * the metadata codec, `manager.ts` for the `SnapshotCheckpoint` type) and
 * `@quereus/quereus`. It must NOT import from `@quereus/sync-client` or
 * `@quereus/sync-coordinator` — both depend on `@quereus/sync`, so importing the
 * other way would create a cycle.
 *
 * Uint8Array (blob) `SqlValue`s ride the `{ __bin: "<base64>" }` tagged encoding
 * from `encodeSqlValue` / `decodeSqlValue`; HLCs and site ids ride base64.
 *
 * NOTE: every `deserialize*` here trusts its input to match the declared
 * `Serialized*` shape — malformed JSON throws from inside a base64/HLC helper
 * with an opaque message ("Cannot convert undefined to a BigInt") rather than a
 * named validation error. Callers catch and report it, so this is a diagnostics
 * gap, not a crash. If peers ever need actionable protocol errors, add a
 * validation layer across the whole module rather than one codec at a time.
 */

import type { SqlValue, Row } from '@quereus/quereus';
import {
  serializeHLC,
  deserializeHLC,
  siteIdToBase64,
  siteIdFromBase64,
} from '../clock/index.js';
import type { HLC } from '../clock/hlc.js';
import { encodeSqlValue, decodeSqlValue } from '../metadata/column-version.js';
import type {
  ChangeSet,
  Change,
  ColumnChange,
  RowDeletion,
  SchemaMigration,
  SchemaMigrationType,
  SnapshotChunk,
} from './protocol.js';
import type { SnapshotCheckpoint } from './manager.js';

// ============================================================================
// Protocol version
// ============================================================================

/**
 * Wire protocol version. Bump on ANY breaking change to message shapes or codec.
 *
 * NOTE: strict integer equality today (see the `protocolVersion` field on the
 * handshake / handshake_ack). If rolling/mixed-version upgrades ever become a
 * requirement, widen to a `{min,max}`-supported range and negotiate — do not
 * silently accept a mismatch.
 */
export const PROTOCOL_VERSION = 1;

// ============================================================================
// Base64 helpers (work in both browser and Node.js)
// ============================================================================

// Cross-platform base64: btoa/atob when present (browser), `Buffer` otherwise
// (Node). This is a RESOLVED divergence, not a style choice — the coordinator's
// old copy was `Buffer`-only, which throws in a browser. `@quereus/sync` runs in
// the browser too (it backs the sync client), so the dual path is mandatory.

/** Encode bytes to a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    // NOTE: `String.fromCharCode(...bytes)` spreads every byte as an argument; a
    // very large blob (hundreds of KB) can exceed the JS arg-count limit and
    // throw. Fine for HLCs and typical cell blobs; if big-blob snapshot chunks
    // ever appear here, switch to a chunked loop over `bytes`.
    return btoa(String.fromCharCode(...bytes));
  }
  return Buffer.from(bytes).toString('base64');
}

/** Decode a base64 string to bytes. */
export function base64ToBytes(str: string): Uint8Array {
  if (typeof atob === 'function') {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(str, 'base64'));
}

// ============================================================================
// HLC transport helpers
// ============================================================================

/** Serialize an HLC for transport (base64 of the binary HLC encoding). */
export function serializeHLCForTransport(hlc: HLC): string {
  return bytesToBase64(serializeHLC(hlc));
}

/** Deserialize an HLC from transport format (base64 → binary → HLC). */
export function deserializeHLCFromTransport(str: string): HLC {
  return deserializeHLC(base64ToBytes(str));
}

// ============================================================================
// Serialized (JSON-shape) types
// ============================================================================

/**
 * A ChangeSet serialized for JSON transport.
 * SiteIds are base64url-encoded, HLCs are base64-encoded.
 */
export interface SerializedChangeSet {
  siteId: string;
  transactionId: string;
  hlc: string;                          // base64 of serializeHLC
  changes: SerializedChange[];
  schemaMigrations: SerializedSchemaMigration[];
}

export interface SerializedChange {
  type: 'column' | 'delete';
  schema: string;
  table: string;
  pk: unknown[];                        // encodeSqlValue per cell
  column?: string;                      // column changes only
  value?: unknown;                      // column: encodeSqlValue(value)
  hlc: string;
  priorValue?: unknown;                 // column: present iff priorHlc
  priorHlc?: string;                    // column: present iff priorValue
  priorRow?: unknown[];                 // delete: present-only ([] is present)
}

export interface SerializedSchemaMigration {
  type: string;
  schema: string;
  table: string;
  ddl: string;
  hlc: string;
  schemaVersion: number;
}

// --- Serialized snapshot chunks ---------------------------------------------
// Model on the discriminated `SnapshotChunk` union in protocol.ts, with the
// binary fields (siteId, HLCs, blob SqlValues) as their base64/tagged JSON shapes.

export interface SerializedSnapshotHeaderChunk {
  type: 'header';
  siteId: string;                       // base64
  hlc: string;                          // base64
  tableCount: number;
  migrationCount: number;
  snapshotId: string;
}

export interface SerializedSnapshotTableStartChunk {
  type: 'table-start';
  schema: string;
  table: string;
  estimatedEntries: number;
}

export interface SerializedSnapshotColumnVersionsChunk {
  type: 'column-versions';
  schema: string;
  table: string;
  /** [versionKey, hlc-base64, encodeSqlValue(value)] tuples. */
  entries: Array<[string, string, unknown]>;
}

export interface SerializedSnapshotTombstoneChunk {
  type: 'tombstone';
  schema: string;
  table: string;
  entries: Array<{
    pk: unknown[];                      // encodeSqlValue per cell
    hlc: string;                        // base64
    createdAt: number;
    priorRow?: unknown[];               // present-only ([] is present)
  }>;
}

export interface SerializedSnapshotTableEndChunk {
  type: 'table-end';
  schema: string;
  table: string;
  entriesWritten: number;
}

export interface SerializedSnapshotSchemaMigrationChunk {
  type: 'schema-migration';
  migration: SerializedSchemaMigration;
}

export interface SerializedSnapshotFooterChunk {
  type: 'footer';
  snapshotId: string;
  totalTables: number;
  totalEntries: number;
  totalMigrations: number;
}

export type SerializedSnapshotChunk =
  | SerializedSnapshotHeaderChunk
  | SerializedSnapshotTableStartChunk
  | SerializedSnapshotColumnVersionsChunk
  | SerializedSnapshotTombstoneChunk
  | SerializedSnapshotTableEndChunk
  | SerializedSnapshotSchemaMigrationChunk
  | SerializedSnapshotFooterChunk;

/**
 * A {@link SnapshotCheckpoint} serialized for JSON transport.
 *
 * Derived from the in-memory shape so a field added to `SnapshotCheckpoint`
 * fails to compile here until the codec below carries it too. Only the two
 * binary fields are re-typed: `siteId` (raw bytes) and `hlc` (whose `wallTime`
 * is a bigint that `JSON.stringify` throws on) both become base64 strings.
 * Everything else is already JSON-safe and passes through unchanged.
 */
export interface SerializedSnapshotCheckpoint extends Omit<SnapshotCheckpoint, 'siteId' | 'hlc'> {
  siteId: string;                       // base64
  hlc: string;                          // base64
}

// ============================================================================
// Schema migration codec
// ============================================================================

function serializeSchemaMigration(m: SchemaMigration): SerializedSchemaMigration {
  return {
    type: m.type,
    schema: m.schema,
    table: m.table,
    ddl: m.ddl,
    hlc: serializeHLCForTransport(m.hlc),
    schemaVersion: m.schemaVersion,
  };
}

function deserializeSchemaMigration(m: SerializedSchemaMigration): SchemaMigration {
  return {
    type: m.type as SchemaMigrationType,
    schema: m.schema,
    table: m.table,
    ddl: m.ddl,
    hlc: deserializeHLCFromTransport(m.hlc),
    schemaVersion: m.schemaVersion,
  };
}

// ============================================================================
// ChangeSet codec
// ============================================================================

function serializeChange(c: Change): SerializedChange {
  const base = {
    type: c.type,
    schema: c.schema,
    table: c.table,
    pk: c.pk.map(v => encodeSqlValue(v)),
    hlc: serializeHLCForTransport(c.hlc),
  };
  if (c.type === 'column') {
    const cc = c as ColumnChange;
    return {
      ...base,
      column: cc.column,
      value: encodeSqlValue(cc.value),
      // Carry the per-cell before-image (value + HLC) present-only: write both
      // together gated on priorHlc, never a phantom key. priorHlc reuses the same
      // base64-binary HLC encoding as `hlc`; priorValue rides encodeSqlValue.
      ...(cc.priorHlc !== undefined
        ? {
            priorValue: encodeSqlValue(cc.priorValue ?? null),
            priorHlc: serializeHLCForTransport(cc.priorHlc),
          }
        : {}),
    };
  }
  const rd = c as RowDeletion;
  return {
    ...base,
    // Carry the row before-image present-only. An empty array is present:
    // [].map(...) is still [] and [] !== undefined, so the conditional spread
    // preserves the empty-present vs absent boundary.
    ...(rd.priorRow !== undefined
      ? { priorRow: rd.priorRow.map(v => encodeSqlValue(v)) }
      : {}),
  };
}

function deserializeChange(c: SerializedChange): Change {
  const base = {
    type: c.type,
    schema: c.schema,
    table: c.table,
    pk: c.pk.map(v => decodeSqlValue(v)) as SqlValue[],
    hlc: deserializeHLCFromTransport(c.hlc),
  };
  if (c.type === 'column') {
    return {
      ...base,
      type: 'column',
      column: c.column!,
      value: decodeSqlValue(c.value),
      // Mirror serialize: attach the before-image only when the serialized
      // object carries it, so absent stays absent (not a phantom undefined).
      ...(c.priorHlc !== undefined
        ? {
            priorValue: decodeSqlValue(c.priorValue),
            priorHlc: deserializeHLCFromTransport(c.priorHlc),
          }
        : {}),
    } as ColumnChange;
  }
  return {
    ...base,
    type: 'delete',
    ...(c.priorRow !== undefined
      ? { priorRow: c.priorRow.map(v => decodeSqlValue(v)) as Row }
      : {}),
  } as RowDeletion;
}

/**
 * Serialize a ChangeSet for JSON transport.
 * Encodes Uint8Array values in changes and PKs so they survive JSON round-trip.
 */
export function serializeChangeSet(cs: ChangeSet): SerializedChangeSet {
  return {
    siteId: siteIdToBase64(cs.siteId),
    transactionId: cs.transactionId,
    hlc: serializeHLCForTransport(cs.hlc),
    changes: cs.changes.map(serializeChange),
    schemaMigrations: cs.schemaMigrations.map(serializeSchemaMigration),
  };
}

/**
 * Deserialize a ChangeSet from JSON transport format.
 * Decodes tagged Uint8Array values in changes and PKs.
 */
export function deserializeChangeSet(obj: SerializedChangeSet): ChangeSet {
  return {
    siteId: siteIdFromBase64(obj.siteId),
    transactionId: obj.transactionId,
    hlc: deserializeHLCFromTransport(obj.hlc),
    changes: obj.changes.map(deserializeChange),
    // Lenient read: default to [] when absent. The serializer always emits it
    // (ChangeSet.schemaMigrations is required), so this only guards a malformed
    // peer — cheap Postel, and real drift is caught by the version handshake.
    schemaMigrations: (obj.schemaMigrations ?? []).map(deserializeSchemaMigration),
  };
}

// ============================================================================
// SnapshotChunk codec
// ============================================================================

/**
 * Serialize a SnapshotChunk for JSON transport.
 * Converts binary fields (siteId, HLCs) and SqlValue blobs to base64/tagged JSON.
 */
export function serializeSnapshotChunk(chunk: SnapshotChunk): SerializedSnapshotChunk {
  switch (chunk.type) {
    case 'header':
      return {
        type: 'header',
        siteId: siteIdToBase64(chunk.siteId),
        hlc: serializeHLCForTransport(chunk.hlc),
        tableCount: chunk.tableCount,
        migrationCount: chunk.migrationCount,
        snapshotId: chunk.snapshotId,
      };
    case 'column-versions':
      return {
        type: 'column-versions',
        schema: chunk.schema,
        table: chunk.table,
        entries: chunk.entries.map(([key, hlc, value]) => [
          key,
          serializeHLCForTransport(hlc),
          encodeSqlValue(value),
        ]),
      };
    case 'tombstone':
      // Each entry carries an HLC (bigint wallTime) and blob-capable pk/priorRow,
      // so it MUST route through serializeHLC / encodeSqlValue — a raw bigint
      // throws at JSON.stringify (e.g. the S3 snapshot upload path).
      return {
        type: 'tombstone',
        schema: chunk.schema,
        table: chunk.table,
        entries: chunk.entries.map(e => ({
          pk: e.pk.map(v => encodeSqlValue(v)),
          hlc: serializeHLCForTransport(e.hlc),
          createdAt: e.createdAt,
          ...(e.priorRow !== undefined
            ? { priorRow: e.priorRow.map(v => encodeSqlValue(v)) }
            : {}),
        })),
      };
    case 'schema-migration':
      return {
        type: 'schema-migration',
        migration: serializeSchemaMigration(chunk.migration),
      };
    // table-start, table-end, footer carry no binary fields — pass through as-is
    // (spread copies to a plain, JSON-safe object without dropping any key).
    case 'table-start':
    case 'table-end':
    case 'footer':
      return { ...chunk };
  }
}

/**
 * Deserialize a SnapshotChunk from JSON transport format.
 * Converts base64 back to binary fields (siteId, HLC) and decodes SqlValue blobs.
 */
export function deserializeSnapshotChunk(obj: SerializedSnapshotChunk): SnapshotChunk {
  switch (obj.type) {
    case 'header':
      return {
        type: 'header',
        siteId: siteIdFromBase64(obj.siteId),
        hlc: deserializeHLCFromTransport(obj.hlc),
        tableCount: obj.tableCount,
        migrationCount: obj.migrationCount,
        snapshotId: obj.snapshotId,
      };
    case 'column-versions':
      return {
        type: 'column-versions',
        schema: obj.schema,
        table: obj.table,
        entries: obj.entries.map(([key, hlc, value]) => [
          key,
          deserializeHLCFromTransport(hlc),
          decodeSqlValue(value),
        ]),
      };
    case 'tombstone':
      return {
        type: 'tombstone',
        schema: obj.schema,
        table: obj.table,
        entries: obj.entries.map(e => ({
          pk: e.pk.map(v => decodeSqlValue(v)) as SqlValue[],
          hlc: deserializeHLCFromTransport(e.hlc),
          createdAt: e.createdAt,
          ...(e.priorRow !== undefined
            ? { priorRow: e.priorRow.map(v => decodeSqlValue(v)) as Row }
            : {}),
        })),
      };
    case 'schema-migration':
      return {
        type: 'schema-migration',
        migration: deserializeSchemaMigration(obj.migration),
      };
    // table-start, table-end, footer carry no binary fields — pass through as-is.
    case 'table-start':
    case 'table-end':
    case 'footer':
      return { ...obj };
  }
}

// ============================================================================
// SnapshotCheckpoint codec
// ============================================================================

/**
 * Serialize a SnapshotCheckpoint for JSON transport.
 *
 * The in-memory checkpoint holds a raw `Uint8Array` siteId and an HLC whose
 * `wallTime` is a bigint — `JSON.stringify` THROWS on the latter, so a
 * checkpoint must route through here before it can ride the wire.
 */
export function serializeSnapshotCheckpoint(cp: SnapshotCheckpoint): SerializedSnapshotCheckpoint {
  return {
    snapshotId: cp.snapshotId,
    siteId: siteIdToBase64(cp.siteId),
    hlc: serializeHLCForTransport(cp.hlc),
    lastTableIndex: cp.lastTableIndex,
    lastEntryIndex: cp.lastEntryIndex,
    completedTables: [...cp.completedTables],
    entriesProcessed: cp.entriesProcessed,
    createdAt: cp.createdAt,
  };
}

/**
 * Deserialize a SnapshotCheckpoint from JSON transport format.
 *
 * Restores the binary siteId and the HLC; without this the receiver would read
 * a base64 string where it expects `Uint8Array`/bigint.
 */
export function deserializeSnapshotCheckpoint(obj: SerializedSnapshotCheckpoint): SnapshotCheckpoint {
  return {
    snapshotId: obj.snapshotId,
    siteId: siteIdFromBase64(obj.siteId),
    hlc: deserializeHLCFromTransport(obj.hlc),
    lastTableIndex: obj.lastTableIndex,
    lastEntryIndex: obj.lastEntryIndex,
    completedTables: [...obj.completedTables],
    entriesProcessed: obj.entriesProcessed,
    createdAt: obj.createdAt,
  };
}

// ============================================================================
// Message envelopes
// ============================================================================
//
// The canonical unions are the true SUPERSET of what both the client and the
// coordinator emit/handle today. Enumerated from:
//   - quereus-sync-client/src/types.ts       (base client/server unions)
//   - sync-coordinator/src/server/websocket.ts (resume_snapshot, snapshot_chunk,
//                                                snapshot_complete)
//   - quereus-sync-client/src/sync-client.ts   (request_changes handler)

// --- Client → Server --------------------------------------------------------

/** Client → Server: Handshake. */
export interface HandshakeMessage {
  type: 'handshake';
  /** Database ID for multi-tenant routing. */
  databaseId: string;
  /** Base64-encoded site ID. */
  siteId: string;
  /** Optional auth token. */
  token?: string;
  /** Wire protocol version the client speaks; see {@link PROTOCOL_VERSION}. */
  protocolVersion: number;
}

/** Client → Server: Request changes. */
export interface GetChangesMessage {
  type: 'get_changes';
  /** Base64-encoded HLC watermark; changes strictly after it are returned. */
  sinceHLC?: string;
}

/** Client → Server: Apply local changes. */
export interface ApplyChangesMessage {
  type: 'apply_changes';
  changes: SerializedChangeSet[];
  /**
   * Correlation id echoed back on the resulting `apply_result`, so the client
   * can tie an ack to the exact batch that produced it (and only then advance
   * its delta-sync watermark). Optional: peer-relay pushes that carry no
   * watermark to promote omit it.
   */
  requestId?: string;
}

/** Client → Server: Request a full snapshot. */
export interface GetSnapshotMessage {
  type: 'get_snapshot';
}

/** Client → Server: Resume a snapshot transfer from a checkpoint. */
export interface ResumeSnapshotMessage {
  type: 'resume_snapshot';
  /**
   * The checkpoint to resume from, in its JSON-safe form — build it with
   * {@link serializeSnapshotCheckpoint} and read it with
   * {@link deserializeSnapshotCheckpoint}.
   */
  checkpoint: SerializedSnapshotCheckpoint;
}

/** Client → Server: Heartbeat. */
export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | HandshakeMessage
  | GetChangesMessage
  | ApplyChangesMessage
  | GetSnapshotMessage
  | ResumeSnapshotMessage
  | PingMessage;

// --- Server → Client --------------------------------------------------------

/** Server → Client: Handshake acknowledgment. */
export interface HandshakeAckMessage {
  type: 'handshake_ack';
  serverSiteId: string;
  connectionId?: string;
  /** Echoed database ID (the coordinator already sends this); optional. */
  databaseId?: string;
  /** Wire protocol version the server speaks; see {@link PROTOCOL_VERSION}. */
  protocolVersion: number;
}

/** Server → Client: Changes response (reply to `get_changes`). */
export interface ChangesMessage {
  type: 'changes';
  changeSets: SerializedChangeSet[];
}

/** Server → Client: Pushed changes from another peer (fire-and-forget broadcast). */
export interface PushChangesMessage {
  type: 'push_changes';
  changeSets: SerializedChangeSet[];
}

/** Server → Client: Apply result (ack for `apply_changes`). */
export interface ApplyResultMessage {
  type: 'apply_result';
  /**
   * The `requestId` of the `apply_changes` this acknowledges, reflected back
   * verbatim. Absent when the originating push carried none (a peer-relay push)
   * or on a legacy coordinator that predates correlation.
   */
  requestId?: string;
  applied: number;
  skipped: number;
  conflicts: number;
  transactions: number;
  rejected?: Array<{
    reason: string;
    code?: string;
    table?: string;
    column?: string;
  }>;
}

/** Server → Client: One serialized snapshot chunk during a streaming transfer. */
export interface SnapshotChunkMessage {
  type: 'snapshot_chunk';
  chunk: SerializedSnapshotChunk;
}

/** Server → Client: Snapshot stream finished. */
export interface SnapshotCompleteMessage {
  type: 'snapshot_complete';
}

/**
 * Server → Client: Relayed request for a peer's changes (peer-to-peer relay).
 * The client answers by pushing an `apply_changes` for `siteId` since `sinceHLC`.
 */
export interface RequestChangesMessage {
  type: 'request_changes';
  /** Base64-encoded site ID whose changes are being requested. */
  siteId?: string;
  /** Base64-encoded HLC watermark. */
  sinceHLC?: string;
}

/** Server → Client: Error. */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  /**
   * When true, the error is fatal: the server rejected the session
   * unrecoverably (and typically closed the socket), so the client stops
   * auto-reconnecting. Absent or false means a transient per-request error —
   * the session and its auto-reconnect stay intact.
   */
  fatal?: boolean;
}

/** Server → Client: Heartbeat response. */
export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | HandshakeAckMessage
  | ChangesMessage
  | PushChangesMessage
  | ApplyResultMessage
  | SnapshotChunkMessage
  | SnapshotCompleteMessage
  | RequestChangesMessage
  | ErrorMessage
  | PongMessage;
