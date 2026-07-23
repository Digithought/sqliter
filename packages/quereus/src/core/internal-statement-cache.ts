import { createLogger } from '../common/logger.js';
import type { Row, SqlValue } from '../common/types.js';
import type { Database } from './database.js';
import type { Statement } from './statement.js';

const log = createLogger('core:internal-stmt-cache');

/**
 * Default LRU capacity. The working set is one or two statement shapes per FK
 * edge (one probe + one cascade DML), so 64 comfortably covers a wide FK graph
 * before any eviction. Kept modest so a pathological schema cannot pin an
 * unbounded number of compiled statements.
 */
const DEFAULT_CACHE_CAP = 64;

/**
 * Observability counters — asserted by the cache tests and useful for a future
 * `PRAGMA`/introspection surface. Purely additive; carry no correctness weight.
 */
export interface InternalStatementCacheStats {
	/** Reuse of an idle cached statement (the win this cache exists for). */
	readonly hits: number;
	/** First compile of a new SQL shape (entry created). */
	readonly misses: number;
	/** Same SQL text requested while its cached statement was mid-iteration ⇒ a
	 *  fresh one-shot statement was compiled instead of blocking or sharing. */
	readonly busyFallbacks: number;
	/** Idle entries finalized to keep the map within {@link DEFAULT_CACHE_CAP}. */
	readonly evictions: number;
	/** Live entries currently in the map. */
	readonly size: number;
}

interface CacheEntry {
	readonly stmt: Statement;
	/** True while this cached statement is mid-iteration/run — it must never be
	 *  reused (see {@link InternalStatementCache.lease}) nor finalized (see
	 *  {@link InternalStatementCache.evictIfNeeded}) until this clears. */
	inUse: boolean;
}

/** A borrowed statement plus whether it lives in the cache map. */
interface Lease {
	readonly stmt: Statement;
	/** true → a cached entry (return it to the pool on release); false → a
	 *  one-shot busy-fallback statement (finalize it on release). */
	readonly cached: boolean;
}

/**
 * @internal Per-`Database` LRU pool of compiled internal statements, keyed by
 * exact SQL text. Adopted only by the internal FK/DDL enforcement call sites
 * (see `runtime/foreign-key-actions.ts` and `schema/manager.ts`) that otherwise
 * `prepare → bind → iterate → finalize` a tiny fixed-shape query once per
 * affected row, paying a full parse + plan + optimize + emit each time (the
 * engine has no plan cache). Reusing one compiled {@link Statement} per shape
 * collapses that to a bind + execute.
 *
 * Correctness rests on properties of {@link Statement}:
 * - **Schema-change safety.** A compiled statement subscribes to schema-change
 *   notifications and lazily recompiles on `needsCompile`, so a cached statement
 *   stays correct across DDL between executions with no bespoke invalidation. The
 *   subscription is dropped on `finalize()` (evict / close) and swapped on every
 *   recompile, so a long-lived cached statement leaks no listener.
 * - **Re-entrancy.** Cascade recursion can re-enter the cache with the SAME SQL
 *   text while the outer statement is still iterating (the transitive pre-walk
 *   iterates one statement and recurses inside its loop; a self-referential
 *   cascade DELETE re-fires its own shape). A busy entry is never shared — the
 *   request falls back to a fresh one-shot `prepare`/`finalize`, so there is no
 *   deadlock and no shared-cursor corruption.
 *
 * Parameter binding for these internal probes is deliberately *type-agnostic*:
 * statements are prepared with an empty explicit parameter-type map, so the plan
 * is built affinity-neutral and a later call binding a differently-typed value
 * for the same SQL text (a loose-affinity child column can hold an integer key on
 * one row and text on another) is neither rejected by bind-time validation nor
 * served a plan whose param affinity was frozen on first use.
 *
 * NOTE: this cache adds no new concurrency surface — the {@link Database} exec
 * mutex serializes top-level statements today, and the FK enforcement all runs
 * with that mutex held. The busy-guard is the safety net if that ever changes;
 * mirrors the concurrency `NOTE:` on `withFkCascadeReentry`.
 */
export class InternalStatementCache {
	private readonly db: Database;
	private readonly cap: number;
	/** Insertion-ordered ⇒ LRU: least-recently-used entry is first, most-recent
	 *  last. Reuse re-inserts (moves to last); eviction takes from the front. */
	private readonly entries = new Map<string, CacheEntry>();

	private _hits = 0;
	private _misses = 0;
	private _busyFallbacks = 0;
	private _evictions = 0;

	constructor(db: Database, cap: number = DEFAULT_CACHE_CAP) {
		this.db = db;
		this.cap = cap;
	}

	/** @internal Snapshot of the observability counters. */
	get stats(): InternalStatementCacheStats {
		return {
			hits: this._hits,
			misses: this._misses,
			busyFallbacks: this._busyFallbacks,
			evictions: this._evictions,
			size: this.entries.size,
		};
	}

	/**
	 * Probe: execute `sql` and report whether it yields at least one row, pulling
	 * at most the first. The replacement for a `select 1 … limit 1` /
	 * `select <cols> … limit 1` RESTRICT existence check.
	 */
	async probe(sql: string, params: SqlValue[] = [], signal?: AbortSignal): Promise<boolean> {
		const lease = this.lease(sql);
		try {
			for await (const _row of lease.stmt._iterateRowsRaw(params, signal)) {
				return true;
			}
			return false;
		} finally {
			await this.release(sql, lease);
		}
	}

	/**
	 * Run to completion: execute a side-effecting statement (cascade DELETE /
	 * UPDATE), draining any output. The DML mutation happens during the scheduler
	 * run inside the first pull; draining also consumes any RETURNING rows. Runs
	 * WITHOUT acquiring the exec mutex or managing transactions — identical to the
	 * `_execWithinTransaction` path it replaces, which runs while the mutex is
	 * already held inside the enclosing statement's transaction.
	 */
	async run(sql: string, params: SqlValue[] = [], signal?: AbortSignal): Promise<void> {
		const lease = this.lease(sql);
		try {
			for await (const _row of lease.stmt._iterateRowsRaw(params, signal)) {
				// Drain: side effects land during scheduler.run; loop consumes any output.
			}
		} finally {
			await this.release(sql, lease);
		}
	}

	/**
	 * Iterate: lazily stream every row, holding the leased statement for the whole
	 * stream. The caller (the transitive cascade pre-walk) recurses inside its
	 * consuming loop; any re-entry with the same SQL text while this stream is live
	 * lands on the busy-guard and gets a fresh one-shot statement. The lease is
	 * released — and, if it was a fresh fallback, finalized — when iteration ends
	 * (drained, `break`, or throw).
	 */
	async *iterate(sql: string, params: SqlValue[] = [], signal?: AbortSignal): AsyncIterable<Row> {
		const lease = this.lease(sql);
		try {
			yield* lease.stmt._iterateRowsRaw(params, signal);
		} finally {
			await this.release(sql, lease);
		}
	}

	/**
	 * Finalize and drop every cached statement. Called by {@link Database.close}.
	 * Idempotent w.r.t. the statements also tracked in `Database.statements`
	 * (double `finalize()` is a no-op), so close draining both is safe.
	 */
	async clear(): Promise<void> {
		const stmts = [...this.entries.values()].map(e => e.stmt);
		this.entries.clear();
		await Promise.allSettled(stmts.map(s => s.finalize()));
	}

	/**
	 * Borrow a statement for `sql`. Returns the idle cached entry (LRU-touched and
	 * marked busy) on a hit; on a busy hit returns a fresh one-shot statement that
	 * bypasses the map; on a miss compiles, caches, and returns a new entry.
	 */
	private lease(sql: string): Lease {
		const existing = this.entries.get(sql);
		if (existing && !existing.inUse) {
			// Hit: LRU-touch (delete + re-insert moves it to the most-recent slot).
			this.entries.delete(sql);
			this.entries.set(sql, existing);
			existing.inUse = true;
			this._hits++;
			return { stmt: existing.stmt, cached: true };
		}
		if (existing && existing.inUse) {
			// Re-entrancy on the same SQL text mid-iteration: never share a busy
			// statement (its cursor is live) — compile a throwaway one-shot instead.
			this._busyFallbacks++;
			log('busy re-entry, one-shot fallback: %s', sql);
			return { stmt: this.prepareInternal(sql), cached: false };
		}
		// Miss: compile once and cache. Insert first (most-recent), THEN evict —
		// the new entry is busy and last, so it is never the eviction victim.
		this._misses++;
		const stmt = this.prepareInternal(sql);
		this.entries.set(sql, { stmt, inUse: true });
		this.evictIfNeeded();
		return { stmt, cached: true };
	}

	/** Return a leased statement. Cached leases go back to the pool (marked idle);
	 *  one-shot fallbacks — and the defensive case of an entry replaced under a live
	 *  lease — are finalized. */
	private async release(sql: string, lease: Lease): Promise<void> {
		if (!lease.cached) {
			await lease.stmt.finalize();
			return;
		}
		const entry = this.entries.get(sql);
		if (entry && entry.stmt === lease.stmt) {
			entry.inUse = false;
		} else {
			// The entry was dropped/replaced while this lease was out (only reachable
			// if the map is mutated mid-iteration — not today, but stay leak-free).
			await lease.stmt.finalize();
		}
	}

	/**
	 * Prepare an internal statement with an empty explicit parameter-type map so
	 * bind-time type validation is disabled and the plan is affinity-neutral —
	 * see the class doc's parameter-binding note.
	 */
	private prepareInternal(sql: string): Statement {
		return this.db.prepare(sql, new Map());
	}

	/**
	 * Evict least-recently-used IDLE entries until the map is within {@link cap}.
	 * A busy entry (mid-iteration, e.g. an outer recursion frame) is skipped, never
	 * finalized under a live cursor — so a deep cascade may transiently exceed the
	 * cap; the excess is reclaimed as those statements are released and later
	 * eviction passes run.
	 */
	private evictIfNeeded(): void {
		if (this.entries.size <= this.cap) return;
		for (const [key, entry] of this.entries) {
			if (this.entries.size <= this.cap) break;
			if (entry.inUse) continue;
			this.entries.delete(key);
			// finalize() does only synchronous teardown (flags, unsubscribe, deregister)
			// and returns an already-resolved promise, so fire-and-forget is safe here.
			void entry.stmt.finalize();
			this._evictions++;
			log('evicted cached statement: %s', key);
		}
	}
}
