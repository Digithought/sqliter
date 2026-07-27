/**
 * Tests for the host-agnostic maintenance pass (`src/sync/maintenance.ts`).
 *
 * The contract these pin: every sweep runs once per pass in drain-before-prune
 * order, one failing sweep never suppresses the others, and a pass never
 * overlaps itself. Moved here from the quoomb-web worker when the tick body was
 * lifted into the library so both hosts (browser worker, relay coordinator)
 * share one implementation.
 */

import { expect } from 'chai';
import {
  runSyncMaintenancePass,
  createSyncMaintenanceTicker,
  type SyncMaintenanceTarget,
} from '../../src/sync/maintenance.js';

/** A manually-settled promise, for modeling a long-running sweep. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SweepName = keyof SyncMaintenanceTarget;

const ALL_SWEEPS: SweepName[] = [
  'drainHeldChanges',
  'pruneQuarantine',
  'pruneTombstones',
  'evictExpiredBasisTables',
];

/** Minimal recording logger (mocha/chai has no built-in spy). */
function makeLogger(): { log: (step: string, error: unknown) => void; entries: [string, unknown][] } {
  const entries: [string, unknown][] = [];
  return { entries, log: (step, error) => { entries.push([step, error]); } };
}

/**
 * Fake maintenance target that records the order sweeps were invoked in. Each
 * sweep resolves 0 by default; an override lets a single sweep reject or hang.
 * The call is recorded *before* the override runs, so `calls` reflects
 * invocation order even for a sweep that never resolves.
 */
function makeFakeTarget(
  overrides: Partial<Record<SweepName, () => Promise<number>>> = {},
): { target: SyncMaintenanceTarget; calls: SweepName[] } {
  const calls: SweepName[] = [];
  const sweep = (name: SweepName) => () => {
    calls.push(name);
    return overrides[name]?.() ?? Promise.resolve(0);
  };
  return {
    calls,
    target: {
      drainHeldChanges: sweep('drainHeldChanges'),
      pruneQuarantine: sweep('pruneQuarantine'),
      pruneTombstones: sweep('pruneTombstones'),
      evictExpiredBasisTables: sweep('evictExpiredBasisTables'),
    },
  };
}

describe('runSyncMaintenancePass', () => {
  it('runs all four sweeps once, in order (drain → pruneQuarantine → pruneTombstones → evict)', async () => {
    const { target, calls } = makeFakeTarget();
    const { log, entries } = makeLogger();

    await runSyncMaintenancePass(target, log);

    expect(calls).to.deep.equal(ALL_SWEEPS);
    expect(entries).to.deep.equal([]);
  });

  it('isolates a failing sweep: the other three still run, the pass resolves, the failure is logged once', async () => {
    const boom = new Error('quarantine boom');
    const { target, calls } = makeFakeTarget({
      pruneQuarantine: () => Promise.reject(boom),
    });
    const { log, entries } = makeLogger();

    expect(await runSyncMaintenancePass(target, log)).to.be.undefined;

    // All four were still invoked despite the second one rejecting.
    expect(calls).to.deep.equal(ALL_SWEEPS);
    expect(entries).to.deep.equal([['pruneQuarantine', boom]]);
  });

  it('isolates each failing sweep independently: two failures both run and both log', async () => {
    const boom1 = new Error('drain boom');
    const boom2 = new Error('evict boom');
    const { target, calls } = makeFakeTarget({
      drainHeldChanges: () => Promise.reject(boom1),
      evictExpiredBasisTables: () => Promise.reject(boom2),
    });
    const { log, entries } = makeLogger();

    expect(await runSyncMaintenancePass(target, log)).to.be.undefined;

    // Both failing sweeps and the two healthy ones in between all ran.
    expect(calls).to.deep.equal(ALL_SWEEPS);
    // One log per failure, with the right (step, error) pair — no dedup / short-circuit.
    expect(entries).to.deep.equal([
      ['drainHeldChanges', boom1],
      ['evictExpiredBasisTables', boom2],
    ]);
  });
});

describe('createSyncMaintenanceTicker', () => {
  it('guards re-entrancy: a second tick is a no-op until the first settles', async () => {
    const gate = deferred<number>();
    const { target, calls } = makeFakeTarget({
      drainHeldChanges: () => gate.promise, // first pass parks here
    });
    const { log, entries } = makeLogger();
    const tick = createSyncMaintenanceTicker(() => target, log);

    const first = tick();  // starts a pass, hangs on drainHeldChanges
    const second = tick(); // re-entrant — must short-circuit immediately
    await second;

    // While the first pass is parked, only its first sweep has run; the second
    // tick added nothing.
    expect(calls).to.deep.equal(['drainHeldChanges']);

    gate.resolve(0); // release the first pass
    await first;

    // The first pass completed all four sweeps exactly once.
    expect(calls).to.deep.equal(ALL_SWEEPS);

    // Once settled, the guard re-arms: a fresh tick runs a full pass again.
    await tick();
    expect(calls).to.deep.equal([...ALL_SWEEPS, ...ALL_SWEEPS]);
    expect(entries).to.deep.equal([]);
  });

  it('is a clean no-op when the target is null (no sync module / after close)', async () => {
    const { log, entries } = makeLogger();
    const tick = createSyncMaintenanceTicker(() => null, log);

    expect(await tick()).to.be.undefined;
    expect(entries).to.deep.equal([]);
  });

  it('re-reads the target each tick: goes no-op once the target is cleared', async () => {
    const { target, calls } = makeFakeTarget();
    let current: SyncMaintenanceTarget | null = target;
    const { log } = makeLogger();
    const tick = createSyncMaintenanceTicker(() => current, log);

    await tick();
    expect(calls).to.deep.equal(ALL_SWEEPS);

    // Simulate close() nulling the manager: a later timer firing must no-op.
    current = null;
    await tick();
    expect(calls).to.deep.equal(ALL_SWEEPS); // unchanged — no new sweeps ran
  });
});
