/**
 * Host-agnostic tick body for the periodic sync-maintenance loop.
 *
 * `@quereus/sync` is deliberately timer-free: it exposes the four host-driven
 * sweeps (`drainHeldChanges` / `pruneQuarantine` / `pruneTombstones` /
 * `evictExpiredBasisTables`) but never schedules them — the host owns cadence
 * (`docs/sync.md` § Who drives the sweep, `docs/migration.md` § 4 Contract).
 * What lives here is only the *shape* of one pass — ordering, error isolation,
 * single-flight — with no timer and no `SyncManager` import, so every host
 * (browser worker, relay coordinator, native app) runs the same semantics
 * instead of re-deriving them. Arming a timer around `createSyncMaintenanceTicker`
 * stays the host's job.
 */

/**
 * Default cadence for a host's sync-maintenance loop (5 minutes).
 *
 * The latency-sensitive sweep is `drainHeldChanges` (held edits replay within
 * one interval once a table reappears); prune/evict act only at horizon
 * granularity (default 30 days) so are latency-insensitive. Every sweep is
 * zero-cost when nothing is held/expired, so minutes is ample. A host with no
 * latency-sensitive sweep (a relay, where `drainHeldChanges` is inert) is free
 * to pick a slower cadence of its own.
 */
export const SYNC_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimal structural view of the four host-driven sweeps the loop calls. Avoids
 * depending on the full `SyncManager` surface and keeps test fakes tiny — a
 * `SyncManager` is structurally assignable to this.
 */
export interface SyncMaintenanceTarget {
  drainHeldChanges(): Promise<number>;
  pruneQuarantine(): Promise<number>;
  pruneTombstones(): Promise<number>;
  evictExpiredBasisTables(): Promise<number>;
}

/**
 * Reports a failed sweep. Called once per failing step; the remaining sweeps
 * still run. `error` is the thrown value verbatim.
 */
export type MaintenanceLogger = (step: string, error: unknown) => void;

/** Run one sweep, isolating its failure: a throw is logged, never re-thrown. */
async function runStep(
  step: string,
  run: () => Promise<number>,
  log: MaintenanceLogger,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log(step, error);
  }
}

/**
 * One maintenance pass. Runs every sweep even if an earlier one throws (each is
 * wrapped + logged); never rejects.
 *
 * Order: `drainHeldChanges` first — it replays held out-of-basis changes into
 * tables that have reappeared in the local basis — THEN `pruneQuarantine` GCs
 * the truly-expired remainder, then `pruneTombstones`, then
 * `evictExpiredBasisTables`. Draining before pruning means a held change for a
 * table that has come back is replayed rather than GC'd out from under it.
 */
export async function runSyncMaintenancePass(
  target: SyncMaintenanceTarget,
  log: MaintenanceLogger,
): Promise<void> {
  await runStep('drainHeldChanges', () => target.drainHeldChanges(), log);
  await runStep('pruneQuarantine', () => target.pruneQuarantine(), log);
  await runStep('pruneTombstones', () => target.pruneTombstones(), log);
  await runStep('evictExpiredBasisTables', () => target.evictExpiredBasisTables(), log);
}

/**
 * Build a single-flight maintenance ticker with the re-entrancy and null-target
 * guards folded in, so the host holds no separate boolean and the guard logic is
 * drivable from a test.
 *
 * - `getTarget` returns the live maintenance target, or null when there is no
 *   sync module yet / after `close()`. A null target is a clean no-op (the timer
 *   can fire once between `close()` nulling the manager and `clearInterval`).
 * - While a pass is in flight, a concurrent tick is a clean no-op until the
 *   first settles — a pass slower than the interval must not overlap itself. The
 *   in-flight flag lives in the returned closure.
 *
 * Note the collapsed tick *does not* join the in-flight pass — it resolves
 * immediately. That suits a fire-and-forget timer; a host that must await the
 * running pass (to close its stores at shutdown, say) needs to hold the pass
 * promise itself rather than rely on this return value.
 */
export function createSyncMaintenanceTicker(
  getTarget: () => SyncMaintenanceTarget | null,
  log: MaintenanceLogger,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    const target = getTarget();
    if (!target) return;
    running = true;
    try {
      await runSyncMaintenancePass(target, log);
    } finally {
      running = false;
    }
  };
}
