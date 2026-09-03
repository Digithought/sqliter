/**
 * Auto-analyze staleness bookkeeping and background statistics refresh.
 *
 * Tracks, per base table, how many distinct rows committed transactions have
 * changed since statistics were last collected for that table, decides when that
 * drift is large enough to call the table's statistics stale, and — off the write
 * path, from a debounced timer — refreshes them by running the ordinary `ANALYZE`
 * statement for that one table.
 *
 * The counts come from the transaction change log (`TransactionManager`), read
 * post-commit while the log is still alive. That log is maintained
 * unconditionally on every write path already, so counting costs one `Map.size`
 * read per table per savepoint layer and nothing on the write path itself.
 *
 * The refresh goes through `db.exec('analyze …')` rather than reaching into the
 * collection internals. Two things fall out of that:
 *
 * - `db.exec` acquires the database's execution mutex, which is what serializes
 *   all statement execution. A refresh driven from a timer therefore queues
 *   behind whatever is running instead of racing it. It cannot deadlock, because
 *   it is never started from inside a statement.
 * - There is exactly one implementation of "collect and record statistics for a
 *   table" (`runtime/emit/analyze.ts`), including its per-table `try` that logs
 *   and continues.
 *
 * A refresh cannot trigger itself: `ANALYZE` performs no DML, and it publishes
 * its result by swapping the `TableSchema` and firing the internal catalog
 * notifier rather than the data-change channel. Its implicit transaction commits
 * with an empty change log, so no counter advances.
 */

import { createLogger } from '../common/logger.js';
import { quoteIdentifier } from '../emit/ast-stringify.js';
import { catalogRowCount } from '../planner/stats/table-cardinality.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { splitBaseKey } from '../util/qualified-name.js';
import type { Database } from './database.js';

const log = createLogger('core:auto-analyze');
const debugLog = log.extend('debug');
const warnLog = log.extend('warn');

/**
 * How long a crossing waits before its refresh starts. Long enough that a burst
 * of small commits collapses into one refresh, short enough that a test or an
 * interactive session does not notice it.
 */
const AUTO_ANALYZE_DEBOUNCE_MS = 50;

/**
 * A table may spend at most `1 / AUTO_ANALYZE_DUTY_CYCLE` of wall-clock time in
 * automatic `ANALYZE`: after a refresh that took `t` ms, the next one for that
 * table may not start for `t × AUTO_ANALYZE_DUTY_CYCLE` ms.
 *
 * NOTE: this cooldown is load-bearing, not decoration. Without it a bulk load
 * re-analyzes on a geometric ladder — a refresh at 50k rows records
 * `analyzedRowCount = 50k`, so the next threshold is `ratio × 50k = 10k` further
 * rows, and the scan that follows visits 60k, then 72k, then 86k… Each scan is
 * O(rows) and they compound. Capping the duty cycle bounds the background cost to
 * a fixed fraction of one core regardless of write rate, without having to model
 * the workload. Do not remove it as "an unnecessary timer".
 */
const AUTO_ANALYZE_DUTY_CYCLE = 10;

/** Floor on the cooldown after a *failed* refresh, so a permanently unreadable
 *  table cannot spin (a fast failure has a near-zero duty-cycle cooldown). */
const AUTO_ANALYZE_FAILURE_BACKOFF_MS = 5000;

/**
 * First delay before retrying a refresh that was deferred because a transaction
 * was open, doubling on each further retry (250, 500, 1000, 2000 ms).
 *
 * NOT the debounce: the debounce exists to let a burst of commits collapse, and
 * 50 ms is far too soon to expect a statement that was in flight a moment ago to
 * have finished. Starting an order of magnitude higher means the common case — a
 * timer landing inside one ordinary `UPDATE` — is served by the first retry
 * instead of burning the whole budget on wakeups that all land inside the same
 * statement.
 *
 * NOTE: 250 ms is reasoning, not measurement — nothing has measured how long a
 * statement actually holds its implicit transaction, and a memory-backed one
 * frequently never yields to the timer queue at all (a 400-row `insert … values`
 * ran to completion without a single `setTimeout(0)` firing), so this mostly
 * governs store-backed workloads and explicit `BEGIN`s. If the debug log shows
 * crossings routinely spending the whole budget, measure a real workload before
 * raising the retry count — a longer first delay is likelier to be the fix.
 */
export const AUTO_ANALYZE_DEFER_RETRY_MS = 250;

/**
 * How many times one crossing may reschedule itself after being deferred. The
 * geometric backoff above makes that about 3.75 s of total patience.
 *
 * Bounded on purpose: a user may park an explicit transaction open indefinitely,
 * and an unbounded retry would then cost a wakeup per stale table forever. Once
 * the budget is spent the crossing is dropped exactly as it was before retries
 * existed — the counter stays over threshold and the next commit that touches the
 * table re-arms.
 *
 * Must stay at or below `AUTO_ANALYZE_IDLE_MAX_PASSES - 2`: {@link
 * AutoAnalyzeManager.whenIdle} spends one settle pass per retry plus one for the
 * initial attempt and one to observe that nothing is left armed.
 */
export const AUTO_ANALYZE_MAX_DEFER_RETRIES = 4;

/**
 * Safety bound on {@link AutoAnalyzeManager.whenIdle}'s settle loop. Exported so the
 * inequality against {@link AUTO_ANALYZE_MAX_DEFER_RETRIES} is checked by a test
 * rather than only implied by one failing if it were ever violated.
 */
export const AUTO_ANALYZE_IDLE_MAX_PASSES = 10;

/**
 * Why a scheduled refresh ended. Only `deferred` wants a retry — it is the one
 * outcome where nothing about the table changed and the refusal was purely about
 * *when* the timer happened to land.
 *
 * The union exists so that `declined` (a deliberate refusal — feature off, table
 * oversize, table gone) and `deferred` (transient) cannot be spelled the same way.
 * Before it, every early return in {@link AutoAnalyzeManager['refresh']} was a bare
 * `return` and a transient refusal silently abandoned its crossing.
 */
export type RefreshOutcome = 'analyzed' | 'declined' | 'deferred' | 'failed';

/**
 * Delay for a debounce timer armed at `now` for a table not eligible until
 * `nextEligibleAt`: the debounce, or the remaining duty-cycle cooldown when that
 * is longer. Exported for the same reason {@link isStaleCount} is — the cooldown
 * arithmetic is otherwise only observable through timing.
 */
export function armDelayMs(nextEligibleAt: number, now: number): number {
	return Math.max(AUTO_ANALYZE_DEBOUNCE_MS, nextEligibleAt - now);
}

/**
 * Database internals the auto-analyze manager needs. Mirrors
 * `WatcherManagerContext` — keeps the manager constructible without the full
 * `Database`.
 */
export interface AutoAnalyzeManagerContext {
	readonly schemaManager: Database['schemaManager'];
	readonly options: Database['options'];

	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
	/**
	 * False while a transaction is open — an explicit `BEGIN…COMMIT` **and also** the
	 * implicit transaction a *writing* statement runs inside. Only the DML and DDL
	 * emitters call `_ensureTransaction`, so a read-only statement leaves this `true`,
	 * while every `insert` (`values` included — `runInsert` opens the transaction before
	 * it consumes its first row), `update`, `delete` and any DDL make it `false` for the
	 * rest of that statement. Since the refresh fires from a timer, it can land inside
	 * one of those and read `false` in a database the user considers to be in autocommit.
	 */
	getAutocommit(): boolean;
	/** Runs the refresh statement. Acquires the execution mutex — see the module doc. */
	exec(sql: string): Promise<void>;
}

/** Per-table staleness bookkeeping. Keyed by lowercased `schema.table`. */
export interface TableStalenessEntry {
	/** Distinct rows changed by committed transactions since the last successful
	 *  statistics refresh. */
	changedSinceAnalyze: number;
	/** rowCount recorded by the last refresh this process observed; undefined = never. */
	analyzedRowCount: number | undefined;
	/** True once this crossing has been logged; cleared when the counter resets. */
	staleLogged: boolean;
	/** Armed debounce timer, if any. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Resolves when the in-flight refresh for this table settles; undefined when idle. */
	running: Promise<void> | undefined;
	/** Epoch ms before which no refresh may start (duty-cycle cooldown / failure backoff). */
	nextEligibleAt: number;
	/** True once the oversize skip has been logged; cleared on a successful refresh. */
	oversizeLogged: boolean;
	/**
	 * Retries already spent on the current crossing after being deferred by an open
	 * transaction, capped at `AUTO_ANALYZE_MAX_DEFER_RETRIES`. Zeroed by a successful
	 * refresh and by any commit that touches the table, so it bounds one crossing's
	 * patience rather than the table's lifetime.
	 */
	deferRetries: number;
}

/**
 * The staleness threshold in changed rows:
 *
 * ```
 * stale  ⟺  changedSinceAnalyze >= max(minMutations, ratio × knownRowCount)
 * ```
 *
 * `knownRowCount` is 0 for a never-analyzed table (`SchemaManager` hardcodes
 * `estimatedRows` to 0 at create), so the absolute floor governs exactly the
 * case that matters most: bulk-loading rows into a fresh table trips
 * `minMutations` long before any percentage of zero could.
 *
 * Precedent for the defaults: SQL Server's auto-update-stats uses 500 + 20% of
 * rows; PostgreSQL's autoanalyze uses 50 + 10%.
 */
export function stalenessThreshold(minMutations: number, ratio: number, knownRowCount: number): number {
	return Math.max(minMutations, ratio * knownRowCount);
}

/** Pure form of the staleness predicate — see {@link stalenessThreshold}. */
export function isStaleCount(
	changedSinceAnalyze: number,
	minMutations: number,
	ratio: number,
	knownRowCount: number,
): boolean {
	return changedSinceAnalyze >= stalenessThreshold(minMutations, ratio, knownRowCount);
}

/**
 * Tracks committed-mutation drift per base table for a single `Database`, and
 * schedules the background refresh that clears it.
 */
export class AutoAnalyzeManager {
	/**
	 * Lowercased `schema.table` → staleness bookkeeping. Same key convention the
	 * change log uses, so no re-derivation and no second key convention.
	 *
	 * NOTE: nothing here is persisted. After a restart the store backend's saved
	 * statistics still exist, but staleness accumulation restarts from zero — a
	 * table that drifted while the process was down looks fresh until it drifts
	 * again. Accepted for v1 (a restart is rare relative to the mutation
	 * threshold). If it ever matters, persist `changedSinceAnalyze` beside the
	 * table's statistics entry and reload it when the catalog loads.
	 */
	private readonly entries = new Map<string, TableStalenessEntry>();
	private unsubscribeSchemaChanges: (() => void) | null = null;
	/** Set by {@link dispose}; every scheduled path checks it before doing work. */
	private disposed = false;
	/** Refreshes that actually reached the `ANALYZE` statement. Test instrumentation. */
	private refreshes = 0;

	constructor(private readonly ctx: AutoAnalyzeManagerContext) {
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			// Only `table_removed`, so a table re-created under a dropped name starts
			// clean. Deliberately NOT `table_modified`: a statistics refresh fires that
			// event itself (runtime/emit/analyze.ts), so reacting to it would couple this
			// manager to its own output.
			//
			// That decoupling has a cost, taken knowingly: a hand-typed `analyze t` also
			// arrives only as `table_modified`, so it does NOT reset `changedSinceAnalyze`.
			// A user who analyzes an already-over-threshold table by hand leaves the
			// counter where it was, and this manager then re-scans a table whose
			// statistics are seconds old — one wasted O(rows) scan, after which the reset
			// in `refresh` makes it self-correcting. The reset path keys off THIS
			// MANAGER'S OWN refresh only. Distinguishing "a successful ANALYZE happened"
			// from any other schema edit would need a signal the notifier does not carry;
			// adding one to save a single redundant scan is not worth re-coupling to the
			// channel the refresh itself fires.
			//
			// NOTE: `DETACH` removes a whole schema WITHOUT firing per-table events
			// (`SchemaManager.removeSchema`), so entries for a detached schema's tables
			// outlive it. Harmless today — each is a handful of numbers, and
			// `knownRowCountOrDrop` evicts one the next time it is consulted — but if a
			// host ever attaches and detaches schemas in a loop, drop entries whose
			// schema segment matches the detached name.
			if (event.type === 'table_removed') {
				const key = `${event.schemaName}.${event.objectName}`.toLowerCase();
				this.dropEntry(key);
			}
		});
	}

	/**
	 * Fold one committed transaction's per-table changed-row counts into the
	 * staleness map and re-evaluate the threshold for every table it touched.
	 * Entries are created lazily on first touch.
	 */
	recordCommit(counts: Map<string, number>): void {
		for (const [key, count] of counts) {
			if (count <= 0) continue;
			let entry = this.entries.get(key);
			if (!entry) {
				entry = {
					changedSinceAnalyze: 0,
					analyzedRowCount: undefined,
					staleLogged: false,
					timer: undefined,
					running: undefined,
					nextEligibleAt: 0,
					oversizeLogged: false,
					deferRetries: 0,
				};
				this.entries.set(key, entry);
			}
			entry.changedSinceAnalyze += count;
			// A commit is proof the transaction that kept deferring this table's refresh
			// has ended, so whatever retry budget it burned is refunded. Zeroed BEFORE
			// `evaluate`, so the crossing this commit may arm starts with a full budget.
			entry.deferRetries = 0;
			this.evaluate(key, entry);
		}
	}

	/**
	 * Whether the named table (lowercased `schema.table`) has drifted past the
	 * threshold. Not a pure predicate: a table that has since disappeared answers
	 * `false` and has its entry dropped — see {@link knownRowCountOrDrop}.
	 */
	isStale(key: string): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;
		const known = this.knownRowCountOrDrop(key, entry);
		if (known === undefined) return false;
		return isStaleCount(entry.changedSinceAnalyze, this.minMutations(), this.ratio(), known);
	}

	/** @internal Current bookkeeping for a table; `undefined` when untracked. */
	getEntry(key: string): Readonly<TableStalenessEntry> | undefined {
		return this.entries.get(key);
	}

	/** @internal Every table currently tracked (lowercased `schema.table`). */
	trackedTables(): string[] {
		return [...this.entries.keys()];
	}

	/**
	 * @internal How many refreshes have reached the `ANALYZE` statement since this
	 * manager was created. Lets a test assert coalescing by counting work rather than
	 * by timing it.
	 */
	refreshCount(): number {
		return this.refreshes;
	}

	/**
	 * @internal Resolve once no table has an armed timer or an in-flight refresh.
	 *
	 * Any armed timer is fired IMMEDIATELY — the debounce, the duty-cycle cooldown and
	 * the deferral backoff are all bypassed — rather than waited out, so tests never
	 * sleep.
	 *
	 * It deliberately does NOT bypass the open-transaction deferral: a test that wants
	 * a refresh to happen must be in autocommit, which is what real callers face.
	 *
	 * A retry timer is an armed timer like any other, so driving this while a
	 * transaction is open SPENDS the whole deferral budget in one call — fire, defer,
	 * re-arm, fire… until `AUTO_ANALYZE_MAX_DEFER_RETRIES` is reached, then settle.
	 * That is the intended behaviour, and it is what makes the budget observable
	 * without sleeping. It costs one settle pass per retry, which is why the budget
	 * must stay at or below `AUTO_ANALYZE_IDLE_MAX_PASSES - 2`.
	 */
	async whenIdle(): Promise<void> {
		for (let pass = 0; pass < AUTO_ANALYZE_IDLE_MAX_PASSES; pass++) {
			const pending: Promise<void>[] = [];
			for (const [key, entry] of [...this.entries]) {
				if (entry.timer !== undefined) {
					clearTimeout(entry.timer);
					entry.timer = undefined;
					entry.nextEligibleAt = 0;
					this.start(key, entry);
				}
				if (entry.running !== undefined) pending.push(entry.running);
			}
			if (pending.length === 0) return;
			await Promise.all(pending);
		}
		// Loud rather than hanging: a bounded self-re-arm (the deferral retry) is expected
		// and fits inside the pass budget, so reaching here means an UNBOUNDED one.
		warnLog(
			'Auto-analyze did not settle after %d passes; still tracking: %s',
			AUTO_ANALYZE_IDLE_MAX_PASSES,
			[...this.entries.keys()].join(', '),
		);
	}

	/**
	 * @internal Fire one table's armed timer NOW, bypassing its delay, and resolve once
	 * that SINGLE attempt has settled and its outcome has been applied. No-op when
	 * nothing is armed for `key`.
	 *
	 * {@link whenIdle} cannot stand in for this: it loops until nothing is armed, so
	 * driven while a transaction is open it spends the entire deferral budget in one
	 * call. A test that wants to watch one deferral reschedule itself needs one attempt.
	 */
	async fireArmedRefresh(key: string): Promise<void> {
		const entry = this.entries.get(key);
		if (!entry || entry.timer === undefined) return;
		this.clearTimer(entry);
		entry.nextEligibleAt = 0;
		this.start(key, entry);
		await entry.running;
	}

	dispose(): void {
		this.disposed = true;
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		// Armed timers must not outlive the database — both to avoid holding a Node
		// process open and to avoid a refresh firing against a closed database. An
		// already-running refresh is left alone: `db.exec` throws once the database is
		// closed, and the failure path logs and continues rather than rejecting.
		for (const entry of this.entries.values()) {
			this.clearTimer(entry);
		}
		this.entries.clear();
	}

	/** Cancel any armed timer for `entry`. Safe to call when none is armed. */
	private clearTimer(entry: TableStalenessEntry): void {
		if (entry.timer === undefined) return;
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}

	/** Forget a table, cancelling any refresh armed for it. */
	private dropEntry(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.clearTimer(entry);
		this.entries.delete(key);
	}

	/**
	 * Row count the ratio arm of the threshold applies to: what the last refresh
	 * this process observed reported, else whatever the catalog knows.
	 *
	 * Named for its side effect: a table that is gone (dropped between the commit
	 * and this lookup, or carried in from a detached schema) answers `undefined`
	 * AND has its entry evicted here, so every consumer of a row count doubles as
	 * the eviction path for stale keys. That is why {@link isStale} mutates.
	 */
	private knownRowCountOrDrop(key: string, entry: TableStalenessEntry): number | undefined {
		if (entry.analyzedRowCount !== undefined) return entry.analyzedRowCount;
		const table = this.findTable(key);
		if (!table) {
			this.dropEntry(key);
			return undefined;
		}
		// NOTE: never-analyzed (`undefined`) deliberately collapses to 0 alongside
		// analyzed-empty here: both make the ratio arm contribute nothing, so the
		// table goes stale after `auto_analyze_min_mutations` changes alone. That is
		// the right urgency for both — a table with no statistics wants its first
		// ANALYZE promptly, and an empty one that starts filling wants a fresh count.
		return catalogRowCount(table) ?? 0;
	}

	private findTable(key: string): ReturnType<Database['_findTable']> {
		const [schemaName, tableName] = splitBaseKey(key);
		return this.ctx._findTable(tableName, schemaName);
	}

	/**
	 * Re-evaluate the threshold for one table after its counter moved: log the first
	 * crossing (a busy table must not flood the log) and arm a refresh.
	 */
	private evaluate(key: string, entry: TableStalenessEntry): void {
		// Absorbed: a pending refresh already covers whatever this commit added. The
		// counter keeps climbing, and the NEXT commit after the refresh settles is what
		// re-arms — nothing re-evaluates on the refresh's own completion. That is what
		// makes N commits past the threshold cost O(1) refreshes rather than O(N), and
		// it is checked first so the common busy-table case does no catalog lookup at
		// all. Its cost: a burst that stops immediately after a refresh leaves a
		// still-over-threshold counter with nothing scheduled until the next write.
		if (entry.timer !== undefined || entry.running !== undefined) return;

		const known = this.knownRowCountOrDrop(key, entry);
		if (known === undefined) return;
		const threshold = stalenessThreshold(this.minMutations(), this.ratio(), known);
		if (entry.changedSinceAnalyze < threshold) return;

		if (!entry.staleLogged) {
			entry.staleLogged = true;
			debugLog(
				'Statistics for %s are stale: %d rows changed since last analyze (threshold %d over %d known rows)',
				key, entry.changedSinceAnalyze, threshold, known,
			);
		}
		this.arm(key, entry);
	}

	/** Schedule the debounced refresh for a table that has just crossed the threshold. */
	private arm(key: string, entry: TableStalenessEntry): void {
		if (this.disposed) return;
		if (entry.timer !== undefined || entry.running !== undefined) return;

		// A plain view stores no rows and `ANALYZE` rejects it by name, so never arm one.
		// (A materialized view is a real backing table and is refreshed like any other.)
		const table = this.findTable(key);
		if (!table) {
			this.dropEntry(key);
			return;
		}
		if (table.isView) return;

		const delay = armDelayMs(entry.nextEligibleAt, Date.now());
		const timer = setTimeout(() => {
			entry.timer = undefined;
			this.start(key, entry);
		}, delay);
		// `unref` is Node-only — browsers and React Native return a numeric handle with
		// no such method. Where it exists, a pending refresh must not hold the process open.
		const unref = (timer as { unref?: () => void }).unref;
		if (typeof unref === 'function') unref.call(timer);
		entry.timer = timer;
	}

	/**
	 * Begin a refresh, publish its settle promise on the entry, and act on how it
	 * ended. This is the single place that turns a {@link RefreshOutcome} into a
	 * scheduling decision — `refresh` itself only reports.
	 */
	private start(key: string, entry: TableStalenessEntry): void {
		if (entry.running !== undefined) return;
		// `running` must never reject: nothing awaits it in production, so a rejection
		// from a timer callback is a process-level crash for a background chore. `refresh`
		// has a total try/catch, and the trailing `catch` covers the rescheduling that
		// follows it. Logged and dropped; the next commit re-arms.
		const run = this.refresh(key, entry).then(outcome => {
			// `running` must be cleared BEFORE the outcome is applied: `arm` early-returns
			// while a refresh is in flight, so a retry armed ahead of this clear would be
			// silently dropped. Sequenced, not raced.
			if (entry.running === run) entry.running = undefined;
			this.applyOutcome(key, entry, outcome);
		}).catch(e => {
			warnLog('Auto-analyze rescheduling for %s failed: %s', key, e);
		});
		entry.running = run;
	}

	/** Decide what a finished refresh means for scheduling. */
	private applyOutcome(key: string, entry: TableStalenessEntry, outcome: RefreshOutcome): void {
		switch (outcome) {
			case 'analyzed':
				// The crossing was served, so the next one starts with a full retry budget.
				entry.deferRetries = 0;
				break;
			case 'deferred':
				this.armDeferRetry(key, entry);
				break;
			case 'declined':
			case 'failed':
				// Nothing to reschedule. `declined` is a deliberate refusal that a retry would
				// only repeat; `failed` already recorded its own backoff in `refresh`'s catch.
				// Both wait for the next commit, as they did before retries existed.
				break;
		}
	}

	/**
	 * Reschedule a refusal that was purely about timing, on a geometric backoff and
	 * within a fixed budget. Once the budget is spent the crossing is dropped and the
	 * next commit that touches the table is what revives it.
	 */
	private armDeferRetry(key: string, entry: TableStalenessEntry): void {
		// The table may have been dropped, or its entry replaced, while the deferred
		// refresh ran — do not resurrect a detached object. (`arm` re-checks the table
		// itself; this checks the entry's identity, which `arm` cannot see.)
		if (this.entries.get(key) !== entry) return;

		if (entry.deferRetries >= AUTO_ANALYZE_MAX_DEFER_RETRIES) {
			debugLog(
				'Auto-analyze of %s deferred %d times by an open transaction; dropping the crossing ' +
				'until the next commit touches the table',
				key, entry.deferRetries,
			);
			// Drop the backoff with it: the spent retries must not also delay the refresh
			// the next commit arms. `deferRetries` itself stays at the cap until a commit
			// or a successful refresh refunds it, so the spent budget stays observable.
			//
			// NOTE: zeroing is safe only because every refresh reaches here through `arm`,
			// whose timer cannot fire before `nextEligibleAt` — so the duty-cycle cooldown
			// this discards has already elapsed. If a future path ever starts a refresh
			// without going through `arm`, this silently drops a live cooldown; carry the
			// pre-deferral value instead of zeroing at that point.
			entry.nextEligibleAt = 0;
			return;
		}

		const delay = AUTO_ANALYZE_DEFER_RETRY_MS * 2 ** entry.deferRetries;
		entry.deferRetries++;
		// Expressed as a cooldown rather than a second timer concept, so `arm` and
		// `armDelayMs` remain the only places a delay is computed.
		entry.nextEligibleAt = Date.now() + delay;
		this.arm(key, entry);
	}

	/**
	 * Refresh one table's statistics, reporting how it ended. Never throws: a failed
	 * automatic refresh must not surface as an error on an unrelated user statement,
	 * and nothing awaits this.
	 *
	 * It decides nothing about scheduling — every exit names a {@link RefreshOutcome}
	 * and {@link start} decides what that means. A new early return therefore has to
	 * say whether it is a refusal or a deferral, which is what keeps "abandoned
	 * crossing" from being writable by accident.
	 */
	private async refresh(key: string, entry: TableStalenessEntry): Promise<RefreshOutcome> {
		const startedAt = Date.now();
		try {
			if (this.disposed) return 'declined';
			// Re-read the switch at fire time: `pragma auto_analyze = false` between the
			// arming and now must abandon the refresh, leaving the counter intact.
			if (!this.enabled()) return 'declined';

			// Deferred while a transaction is open. A memory table's `ANALYZE` adopts the
			// connection already registered for the table INCLUDING its pending transaction
			// layer (see `getStatistics` in `vtab/memory/table.ts`), so refreshing
			// mid-transaction would bake uncommitted rows into the statistics.
			//
			// The counter is left untouched and the crossing is RETRIED on a backoff —
			// `start` → `armDeferRetry`, up to AUTO_ANALYZE_MAX_DEFER_RETRIES times. That
			// matters because this check is not only about an explicit `BEGIN`: a writing
			// statement (`update`, `delete`, `insert … select`, any DDL) opens an implicit
			// transaction too, so a timer for table `t` can land inside a write to some
			// unrelated table. Without the retry that crossing was abandoned outright, and
			// only the next commit touching `t` itself would ever revive it.
			//
			// NOTE: the retry budget is deliberately finite — see
			// AUTO_ANALYZE_MAX_DEFER_RETRIES. A transaction held open past it drops the
			// crossing and the pre-retry behaviour resumes: wait for the next commit.
			//
			// NOTE: accepted tradeoff — a `begin` landing between this check and `exec`'s
			// mutex acquisition lets the refresh run inside that transaction after all.
			// Worst outcome is statistics that include uncommitted rows, which is exactly
			// what a user typing `begin; insert …; analyze;` gets today, and the store's
			// `saveStatistics` already carries an accepted-tradeoff NOTE for the persisted
			// half of the same situation. Closing it would mean holding the execution mutex
			// across the check, i.e. blocking user statements on a background scan. Revisit
			// only if statistics polluted by uncommitted rows show up in practice.
			if (!this.ctx.getAutocommit()) return 'deferred';

			// NOTE: a never-analyzed table has no catalog row count (`catalogRowCount`
			// reports `undefined`, collapsed to 0 here), so its FIRST automatic refresh is
			// not size gated — a table bulk-loaded to 10M rows in a single transaction gets
			// one unbounded scan before `analyzedRowCount` starts gating the rest.
			// Deliberate: the obvious tightening — treating `changedSinceAnalyze` as a size
			// proxy — deadlocks, because a table skipped as oversize never resets its
			// counter and would therefore be skipped forever. If that first scan ever
			// matters, give the gate a real size source (a module-reported row count)
			// rather than a proxy.
			const known = entry.analyzedRowCount ?? this.catalogRowCount(key) ?? 0;
			const limit = this.rowLimit();
			// 0 disables the cap (documented with the option), hence `limit > 0 &&` rather
			// than a bare comparison — otherwise 0 would mean "never auto-analyze anything".
			if (limit > 0 && known > limit) {
				if (!entry.oversizeLogged) {
					entry.oversizeLogged = true;
					log(
						'Statistics for %s are stale but the table is too large for auto-analyze ' +
						'(%d known rows > auto_analyze_row_limit %d) — run ANALYZE manually',
						key, known, limit,
					);
				}
				return 'declined';
			}

			const table = this.findTable(key);
			if (!table || table.isView) {
				this.dropEntry(key);
				return 'declined';
			}

			// Snapshot rather than zero: mutations that commit between here and the reset
			// below stay accounted for.
			const snapshot = entry.changedSinceAnalyze;
			this.refreshes++;
			const [schemaName, tableName] = splitBaseKey(key);
			await this.ctx.exec(`analyze ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`);

			// The table may have been dropped while the refresh ran, in which case
			// `dropEntry` already discarded this object — do not resurrect it.
			if (this.entries.get(key) !== entry) return 'declined';

			entry.changedSinceAnalyze = Math.max(0, entry.changedSinceAnalyze - snapshot);
			const refreshed = this.findTable(key);
			entry.analyzedRowCount = refreshed ? catalogRowCount(refreshed) : undefined;
			entry.staleLogged = false;
			entry.oversizeLogged = false;
			const elapsed = Date.now() - startedAt;
			entry.nextEligibleAt = Date.now() + elapsed * AUTO_ANALYZE_DUTY_CYCLE;
			debugLog('Auto-analyzed %s in %d ms (%s rows)', key, elapsed, entry.analyzedRowCount);
			return 'analyzed';
		} catch (e) {
			// The staleness is real, so the counter is left alone and the next commit
			// re-arms — behind a backoff, so an unreadable table cannot spin.
			warnLog('Automatic ANALYZE of %s failed: %s', key, e);
			entry.nextEligibleAt = Date.now() + Math.max(
				AUTO_ANALYZE_FAILURE_BACKOFF_MS,
				(Date.now() - startedAt) * AUTO_ANALYZE_DUTY_CYCLE,
			);
			return 'failed';
		}
	}

	/** Catalog row count for a table, ignoring the entry's own record. */
	private catalogRowCount(key: string): number | undefined {
		const table = this.findTable(key);
		return table ? catalogRowCount(table) : undefined;
	}

	private enabled(): boolean {
		return this.ctx.options.getBooleanOption('auto_analyze');
	}

	private minMutations(): number {
		return this.ctx.options.getNumberOption('auto_analyze_min_mutations');
	}

	private ratio(): number {
		return this.ctx.options.getNumberOption('auto_analyze_ratio');
	}

	/**
	 * Largest table (in known rows) an automatic refresh will scan; 0 disables the cap.
	 *
	 * NOTE: the gate is purely on row count. An earlier design also exempted modules
	 * whose `getStatistics()` answers the whole question cheaply, but no shipped module
	 * does — both the store backend (`store-table-base.ts`) and the memory backend
	 * (`vtab/memory/table.ts`) deliberately return an EMPTY `columnStats`, which
	 * `ANALYZE` reads as "size answered, scan for the rest". The exemption would be dead
	 * code. If a module that reports complete statistics ever appears, exempt it here.
	 */
	private rowLimit(): number {
		return this.ctx.options.getNumberOption('auto_analyze_row_limit');
	}
}
