import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

const log = createLogger('util:latches');
const warnLog = log.extend('warn');

/**
 * Lightweight mutex lock queue for serializing concurrent access by string key.
 *
 * Each `Latches` instance owns its own queue map, so two independent owners (e.g.
 * two `Database` instances) never share a latch even when they pass the same key.
 * The engine holds one instance per `Database` (`db.latches`); callers namespace
 * their key with `schema.table` to keep intra-database collisions to genuinely
 * same-named tables.
 *
 * A process-global default instance backs the {@link Latches.acquire} *static*
 * method, preserving the original shared-queue entry point for standalone
 * callers (e.g. external store modules) that hold no `Database`.
 */
export class Latches {
	// Stores the promise representing the completion of the last queued operation
	// for a key. Instance-scoped: one map per Latches instance.
	private readonly lockQueues = new Map<string, Promise<void>>();

	/**
	 * Acquires a lock for the given key. Waits if another operation holds the lock.
	 * Returns a release function that must be called to release the lock.
	 *
	 * @param key A unique string identifier for the resource to lock.
	 *            Should use `ClassName.methodName:${id}` format to avoid conflicts.
	 * @param timeoutMs Optional deadlock guard. When set and the predecessor does not
	 *            release within this many milliseconds, the wait is abandoned: a warning
	 *            is logged naming the contended key, this waiter's queue slot is released
	 *            so the queue behind it does not wedge, and the returned promise rejects
	 *            with a `QuereusError` (StatusCode.BUSY). Omit (the default) for the
	 *            original never-reject behavior.
	 * @returns A function that must be called to release the lock
	 */
	async acquire(key: string, timeoutMs?: number): Promise<() => void> {
		// Get the promise the current operation needs to wait for (if any)
		const currentTail = this.lockQueues.get(key) ?? Promise.resolve();

		let resolveNewTail!: () => void;
		// Create the promise that the *next* operation will wait for
		const newTail = new Promise<void>(resolve => {
			resolveNewTail = resolve;
		});

		// Immediately set the new promise as the tail for this key
		this.lockQueues.set(key, newTail);

		// Return the function to release *this* lock
		const release = () => {
			// Signal that this operation is complete
			resolveNewTail();

			// If this promise is still the current tail in the map,
			// it means no other operation queued up behind this one while it was running.
			// We can safely remove the entry from the map to prevent unbounded growth.
			if (this.lockQueues.get(key) === newTail) {
				this.lockQueues.delete(key);
			}
		};

		if (timeoutMs === undefined) {
			// Wait for the previous operation (if any) to complete
			await currentTail;
			return release;
		}

		// Opt-in deadlock guard: bound the wait for the predecessor.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				warnLog('latch acquire timed out after %dms for key %s (possible deadlock); releasing waiter slot', timeoutMs, key);
				// Release our own slot so the queue behind us is not wedged by the abandoned wait.
				release();
				reject(new QuereusError(
					`Latch acquire timed out after ${timeoutMs}ms for '${key}' (possible deadlock)`,
					StatusCode.BUSY,
				));
			}, timeoutMs);
		});

		try {
			await Promise.race([currentTail, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		return release;
	}

	/** Process-global default instance backing the static {@link Latches.acquire}. */
	private static readonly global = new Latches();

	/**
	 * Backward-compatible static entry point delegating to a single process-global
	 * instance. Same shared-queue semantics this class had before it became
	 * instance-based — kept for standalone callers (external store modules) that
	 * hold no `Database`. Engine call sites should prefer the owned per-database
	 * instance (`db.latches`) so two databases never contend on the same key.
	 */
	static acquire(key: string, timeoutMs?: number): Promise<() => void> {
		return this.global.acquire(key, timeoutMs);
	}
}
