/**
 * Periodic sync-maintenance loop for the coordinator.
 *
 * `@quereus/sync` schedules nothing — the host owns cadence (`docs/sync.md`
 * § Who drives the sweep). The per-store pass shape (sweep order, per-sweep
 * error isolation) lives in the library as `runSyncMaintenancePass`; what is
 * coordinator-specific and therefore lives here is the multi-tenant fan-out:
 * one pass visits every database currently open in the `StoreManager`.
 *
 * Without this loop, tombstones and quarantined changes accumulate for the life
 * of every hosted database even though `retentionHorizonMs` says they expire.
 */

import {
  runSyncMaintenancePass,
  type SyncMaintenanceTarget,
} from '@quereus/sync';
import { serviceLog } from '../common/logger.js';

/**
 * Cadence of the coordinator's maintenance loop (1 hour).
 *
 * Nothing here is latency-sensitive. The only sweep quoomb-web needs promptly is
 * `drainHeldChanges` (a reappeared table's held edits gate a visible UI update),
 * and that one is inert on a relay — no `getTableSchema` oracle to tell it which
 * held tables are back, so it returns 0. `evictExpiredBasisTables` is likewise
 * inert without a `dropLocalTable` callback. What actually reclaims here is
 * `pruneTombstones` / `pruneQuarantine`, both at horizon granularity (default 30
 * days), so hourly expires records well inside the horizon while costing nothing
 * when there is nothing to reclaim (every sweep is zero-cost on an empty scan).
 * A documented constant rather than a `CoordinatorConfig` knob,
 * matching the other internal timings in this package (store idle timeout,
 * cleanup interval); promote it to config only if a deployment needs to tune it.
 */
export const COORDINATOR_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The slice of `StoreManager` the maintenance pass needs. Structural, so tests
 * can drive the pass without opening real LevelDB stores; a `StoreManager` is
 * assignable to it.
 */
export interface MaintenanceStoreSource {
  /** Snapshot of the database IDs currently open. */
  openDatabaseIds(): string[];
  /** Pin an already-open store. Returns undefined if it is not open — never opens one. */
  acquireIfOpen(databaseId: string): { syncManager: SyncMaintenanceTarget } | undefined;
  /** Drop a pin taken by `acquireIfOpen`. */
  releasePin(databaseId: string): void;
}

/** Reports a failed sweep for one database. `error` is the thrown value verbatim. */
export type StoreMaintenanceLogger = (databaseId: string, step: string, error: unknown) => void;

/** Default logger: per-sweep failures are non-fatal, so they are logged, not thrown. */
const defaultLog: StoreMaintenanceLogger = (databaseId, step, error) => {
  serviceLog('Sync maintenance step "%s" failed for %s (non-fatal): %O', step, databaseId, error);
};

/**
 * One maintenance pass over every currently-open store. Never rejects: a
 * failing sweep is isolated by the library pass, and a failing *store* is
 * isolated here, so one bad tenant cannot starve the rest.
 *
 * NOTE: only stores already resident in the StoreManager are swept — a database
 * that is closed on disk is skipped until it is next legitimately opened (by a
 * client connecting) and a later tick catches it. An eager scan of every
 * database directory was rejected: it would open — and, with disk eviction on,
 * re-download from S3 — databases no client is using, turning a cheap
 * housekeeping tick into an unbounded I/O storm. The cost is that a database
 * nobody ever opens again keeps its expired metadata on disk; the fix for that
 * is deleting the database, not sweeping it.
 */
export async function runCoordinatorMaintenancePass(
  source: MaintenanceStoreSource,
  log: StoreMaintenanceLogger = defaultLog,
): Promise<void> {
  const databaseIds = source.openDatabaseIds();
  if (databaseIds.length === 0) return;

  let swept = 0;
  for (const databaseId of databaseIds) {
    let pinned = false;
    try {
      // Close-during-sweep race: the snapshot above can go stale while we await
      // a previous store's sweep. We pin instead of tolerating a throw, because
      // the failure mode we are avoiding is not a clean "store closed" error —
      // it is a sweep issuing reads against a LevelDB handle that closes
      // mid-scan. The pin is refcount-only (never opens a store), so a store
      // closed since the snapshot simply yields undefined and is skipped.
      //
      // NOTE: the pin also makes the store ineligible for LRU eviction for the
      // duration of its sweep — one store at a time, and a sweep over an empty
      // scan is instant, so it is invisible today. If sweeps ever get slow (a
      // huge expired-tombstone backlog) on a coordinator sitting at
      // `maxOpenStores`, an acquire can hit "Cannot evict, all stores have
      // active references" and open past the cap; then the pass needs to yield
      // the pin between sweeps rather than hold it across all four.
      const entry = source.acquireIfOpen(databaseId);
      if (!entry) continue;
      pinned = true;

      await runSyncMaintenancePass(
        entry.syncManager,
        (step, error) => log(databaseId, step, error),
      );
      swept++;
    } catch (err) {
      // runSyncMaintenancePass does not reject; this catches anything the
      // source itself throws, so one store cannot abort the whole pass.
      log(databaseId, 'pass', err);
    } finally {
      if (pinned) source.releasePin(databaseId);
    }
  }

  serviceLog('Sync maintenance pass complete: swept %d of %d open stores', swept, databaseIds.length);
}

/**
 * Timer around {@link runCoordinatorMaintenancePass}. Passes are single-flight:
 * a tick that fires while the previous pass is still running is a clean no-op,
 * so a pass slower than the interval never overlaps itself.
 *
 * No immediate pass on `start()` — unlike the browser worker, the coordinator
 * has no stores open at startup (they open lazily as clients connect), so an
 * eager pass would sweep nothing.
 */
export class CoordinatorMaintenanceLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * The pass currently running, or null when idle. Doubles as the single-flight
   * flag and as the handle `stop()` awaits.
   *
   * NOTE: deliberately not `@quereus/sync`'s `createSyncMaintenanceTicker`, whose
   * collapsed tick resolves immediately rather than joining the running pass —
   * right for a fire-and-forget browser timer, wrong here, where `stop()` must
   * know the sweep has finished before `StoreManager.shutdown()` closes the
   * stores it is reading. The shared piece — the per-store pass itself — is still
   * the library's `runSyncMaintenancePass`.
   */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly source: MaintenanceStoreSource,
    private readonly intervalMs: number = COORDINATOR_MAINTENANCE_INTERVAL_MS,
    private readonly log: StoreMaintenanceLogger = defaultLog,
  ) {}

  /** Arm the loop. Idempotent — re-arming does not stack a second timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    serviceLog('Sync maintenance loop started (interval %dms)', this.intervalMs);
  }

  /**
   * Disarm the loop and await any pass already in flight, so the caller can
   * close stores knowing no sweep is still reading them.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      serviceLog('Sync maintenance loop stopped');
    }
    await this.inFlight;
  }

  /**
   * Run one pass now, or join the pass already running. Used by the timer and
   * available for tests / an explicit kick.
   */
  async runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    // The pass isolates per-store and per-sweep failures itself; this catch is
    // for anything left (a source that throws synchronously), so a fire-and-forget
    // timer tick can never surface as an unhandled rejection.
    const pass = runCoordinatorMaintenancePass(this.source, this.log)
      .catch(err => { serviceLog('Sync maintenance pass failed (non-fatal): %O', err); })
      .finally(() => { this.inFlight = null; });
    this.inFlight = pass;
    return pass;
  }
}
