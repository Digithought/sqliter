/**
 * Quarantine store for held out-of-basis straggler changes.
 *
 * When a long-offline peer (a "straggler") reconnects and sends changes for a
 * table the receiver has since retired, the apply path diverts those changes
 * here instead of silently dropping them (see `docs/migration.md` § 4 Contract,
 * Unknown-table disposition, and `change-applicator.ts`). The raw wire `Change`
 * is stored verbatim so a manual / late replay has full fidelity.
 *
 * Entries are:
 *   - **idempotent** — keyed by the change's HLC (+ type/pk/column), so applying
 *     the same straggler batch twice yields exactly one entry per change.
 *   - **durable within the admission unit** — `put` stages into a caller-owned
 *     {@link WriteBatch} that lands before the apply's clock watermark advances,
 *     so a crash never strands a straggler's change with no re-delivery.
 *   - **bounded** — {@link pruneOlderThan} GCs entries past the retention horizon
 *     (mirroring tombstone TTL), so cost is zero with no stragglers and bounded
 *     by the horizon otherwise.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { hlcToJson, hlcFromJson, type SerializedHLC } from '../clock/hlc.js';
import type { Change } from '../sync/protocol.js';
import { encodeSqlValue, decodeSqlValue } from './column-version.js';
import { buildQuarantineKey, buildQuarantineScanBounds } from './keys.js';

/**
 * A held inbound change plus the wall-clock time it was received (for GC).
 */
export interface QuarantineEntry {
  readonly change: Change;
  readonly receivedAt: number;
  /**
   * Whether this held change is eligible to be re-offered to peers that still
   * have the table (the `store-and-forward` disposition). A plain `quarantine`
   * hold is `false`. The relay (sibling ticket `sync-store-and-forward-relay`)
   * consumes this flag via {@link QuarantineStore.listForwardable}; the change
   * is held identically either way — the flag only governs re-offer eligibility.
   */
  readonly forwardable: boolean;
}

/**
 * JSON shape persisted as the quarantine value. Compact keys keep the encoding
 * small; SqlValue/HLC use the same JSON-safe encoders as column versions so
 * Uint8Array / bigint survive the round-trip.
 */
interface SerializedQuarantineEntry {
  /** Change type discriminator. */
  readonly t: 'column' | 'delete';
  readonly s: string;        // schema
  readonly tb: string;       // table
  readonly pk: unknown[];    // encodeSqlValue per element
  readonly h: SerializedHLC; // change HLC
  readonly r: number;        // receivedAt (ms)
  readonly col?: string;     // column (column changes only)
  readonly v?: unknown;      // encodeSqlValue(value) (column changes only)
  readonly pv?: unknown;     // encodeSqlValue(priorValue) — column before-image, present iff prior exists
  readonly ph?: SerializedHLC; // hlcToJson(priorHlc) — column before-image, present iff prior exists
  readonly pr?: unknown[];   // encodeSqlValue per element — delete row before-image, present iff priorRow exists
  readonly f?: 1;            // forwardable mark (store-and-forward) — emitted ONLY when true, so plain
                             // quarantine entries stay byte-identical to today and decode to false
}

/**
 * Serialize a quarantine entry (the raw change + receivedAt) to bytes.
 */
export function serializeQuarantineEntry(entry: QuarantineEntry): Uint8Array {
  const c = entry.change;
  const base: SerializedQuarantineEntry = {
    t: c.type,
    s: c.schema,
    tb: c.table,
    pk: c.pk.map(encodeSqlValue),
    h: hlcToJson(c.hlc),
    r: entry.receivedAt,
  };
  // Preserve the before-image verbatim so a late/manual replay keeps the full wire
  // fidelity the module promises: the per-cell prior on column changes, the row
  // image on deletes (each present only when the wire change carried it).
  const prior = c.type === 'column' && c.priorHlc !== undefined
    ? { pv: encodeSqlValue(c.priorValue ?? null), ph: hlcToJson(c.priorHlc) }
    : undefined;
  const priorRow = c.type === 'delete' && c.priorRow !== undefined
    ? { pr: c.priorRow.map(encodeSqlValue) }
    : undefined;
  // Emit the forwardable mark only when set, so plain-quarantine entries stay
  // byte-identical to the pre-store-and-forward encoding (and decode to false).
  const fwd = entry.forwardable ? { f: 1 as const } : undefined;
  const obj: SerializedQuarantineEntry = c.type === 'column'
    ? { ...base, col: c.column, v: encodeSqlValue(c.value), ...prior, ...fwd }
    : { ...base, ...priorRow, ...fwd };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Deserialize a quarantine entry from bytes.
 */
export function deserializeQuarantineEntry(buffer: Uint8Array): QuarantineEntry {
  const obj = JSON.parse(new TextDecoder().decode(buffer)) as SerializedQuarantineEntry;
  const hlc = hlcFromJson(obj.h);
  const pk = obj.pk.map(decodeSqlValue);
  if (obj.t === 'column') {
    // Restore the before-image when present (spread only then — keeps prior-less
    // changes free of phantom undefined fields, matching the producer path).
    const prior = obj.ph !== undefined
      ? { priorValue: decodeSqlValue(obj.pv), priorHlc: hlcFromJson(obj.ph) }
      : undefined;
    return {
      change: { type: 'column', schema: obj.s, table: obj.tb, pk, column: obj.col!, value: decodeSqlValue(obj.v), hlc, ...prior },
      receivedAt: obj.r,
      forwardable: obj.f === 1,
    };
  }
  // Restore the row before-image when present (spread only then, matching the
  // producer path — a prior-less delete stays free of phantom undefined fields).
  const priorRow = obj.pr !== undefined ? { priorRow: obj.pr.map(decodeSqlValue) } : undefined;
  return {
    change: { type: 'delete', schema: obj.s, table: obj.tb, pk, hlc, ...priorRow },
    receivedAt: obj.r,
    forwardable: obj.f === 1,
  };
}

/**
 * Quarantine store operations.
 */
export class QuarantineStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Stage a held change into a caller-owned batch. HLC-keyed, so re-staging the
   * same change overwrites its own entry (idempotent re-apply). The HLC key does
   * NOT include `forwardable`, so re-delivering a change under a different
   * disposition overwrites its own entry with the new flag — last-writer-wins on
   * the flag, which is correct: the latest disposition governs.
   */
  put(batch: WriteBatch, change: Change, receivedAt: number, forwardable: boolean): void {
    const entryType = change.type === 'column' ? 'column' : 'delete';
    const column = change.type === 'column' ? change.column : undefined;
    const key = buildQuarantineKey(change.schema, change.table, change.hlc, entryType, change.pk, column);
    batch.put(key, serializeQuarantineEntry({ change, receivedAt, forwardable }));
  }

  /**
   * Stage deletion of a held entry by its change, rebuilding the `qt:` key from
   * the change exactly as {@link put} does (HLC + type + pk (+ column)) — so it
   * is symmetric with `put` and clears precisely the entry that change produced.
   * Used by the drain path (`change-applicator.drainHeldChanges`) to clear a held
   * entry atomically with the apply that replays it into the reappeared table.
   */
  delete(batch: WriteBatch, change: Change): void {
    const entryType = change.type === 'column' ? 'column' : 'delete';
    const column = change.type === 'column' ? change.column : undefined;
    const key = buildQuarantineKey(change.schema, change.table, change.hlc, entryType, change.pk, column);
    batch.delete(key);
  }

  /**
   * List held changes, optionally scoped to a schema (and table). For operator
   * inspection — the volume is bounded by the retention horizon.
   */
  async list(schemaName?: string, tableName?: string): Promise<QuarantineEntry[]> {
    const bounds = buildQuarantineScanBounds(schemaName, tableName);
    const entries: QuarantineEntry[] = [];
    for await (const entry of this.kv.iterate(bounds)) {
      entries.push(deserializeQuarantineEntry(entry.value));
    }
    return entries;
  }

  /**
   * Yield held entries marked forwardable (the `store-and-forward` disposition).
   * A full `qt:` scan filtered to {@link QuarantineEntry.forwardable}, so it is
   * bounded by the retention horizon exactly like {@link list} — and zero-cost
   * when no straggler was ever stored forwardable. The relay (sibling ticket
   * `sync-store-and-forward-relay`) filters these further by HLC/origin before
   * re-offering them; this method stays deliberately dumb so it is independently
   * testable here.
   */
  async listForwardable(): Promise<QuarantineEntry[]> {
    const bounds = buildQuarantineScanBounds();
    const entries: QuarantineEntry[] = [];
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = deserializeQuarantineEntry(entry.value);
      if (parsed.forwardable) entries.push(parsed);
    }
    return entries;
  }

  /**
   * Prune held changes received strictly before `cutoff` (a wall-clock ms
   * timestamp). The caller passes `Date.now() - retentionHorizonMs`, matching
   * the tombstone TTL test (`now - receivedAt > retentionHorizonMs`). Returns
   * the number pruned.
   */
  async pruneOlderThan(cutoff: number): Promise<number> {
    const bounds = buildQuarantineScanBounds();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const { receivedAt } = deserializeQuarantineEntry(entry.value);
      if (receivedAt < cutoff) {
        batch.delete(entry.key);
        count++;
      }
    }

    await batch.write();
    return count;
  }
}
