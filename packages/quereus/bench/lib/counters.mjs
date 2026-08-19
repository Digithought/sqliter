/**
 * Helpers a benchmark's optional `counters()` pass uses.
 *
 * `counters()` runs ONCE per benchmark, after the timed loop and before `teardown`,
 * with runtime metrics on. That separation is the whole reason it is a second entry
 * point rather than a flag on `fn`: metrics wrap every streaming operator in a
 * counting generator, so collecting counts inside the timed loop would corrupt
 * exactly the number the harness exists to measure.
 *
 * What comes back is a *count* — executions, rows, `query()` calls — which is
 * identical on every machine and every run of the same plan, unlike a timing. The
 * comparison therefore reports counter deltas as exact integers with no noise floor;
 * see `lib/compare.mjs` and docs/benchmarking.md.
 */

/**
 * The database option that gates work-counter collection. `runtime_metrics` is an
 * alias of `runtime_stats`; there is no separate switch.
 */
const METRICS_OPTION = 'runtime_metrics';

/** Turn work-counter collection on for `db`. Idempotent. */
export function enableMetrics(db) {
	db.setOption(METRICS_OPTION, true);
}

/**
 * Prepare `sql`, drain it FULLY, and return that execution's work-counter snapshot.
 *
 * The drain is not optional. `Statement.getWorkCounters()` reports what the execution
 * actually did, so a pass that stops early records counts that depend on where it
 * stopped — and a partial count compared against a drained baseline reads as a change
 * in the engine when nothing changed but the loop.
 *
 * @param {import('../../dist/src/index.js').Database} db
 * @param {string} sql
 * @param {unknown} [params]
 * @returns {Promise<object>} a `WorkCounterSnapshot`
 */
export async function snapshotStatement(db, sql, params) {
	enableMetrics(db);
	const stmt = db.prepare(sql);
	try {
		for await (const _row of stmt.all(params)) { /* drain fully — counts are only complete once drained */ }
		const snapshot = stmt.getWorkCounters();
		if (!snapshot) {
			throw new Error(`no work-counter snapshot after draining: ${sql}`);
		}
		return snapshot;
	} finally {
		// Always finalized: a leaked prepared statement holds its database open and
		// trips the worker's leaked-handle exit path, which looks like a hang.
		await stmt.finalize();
	}
}

/**
 * Snapshot several statements in order, as one named bag.
 *
 * Instruction keys are structural addresses within ONE program, so `r#0` of one
 * statement and `r#0` of another are different instructions with the same key. They
 * must never be summed; naming each snapshot keeps them apart.
 *
 * @param {import('../../dist/src/index.js').Database} db
 * @param {Record<string, string>} statements name -> SQL, run in insertion order
 * @returns {Promise<Record<string, object>>}
 */
export async function snapshotStatements(db, statements) {
	/** @type {Record<string, object>} */
	const out = {};
	for (const [name, sql] of Object.entries(statements)) {
		out[name] = await snapshotStatement(db, sql);
	}
	return out;
}

/**
 * Plan-shape facts for `sql` — node count and per-`PlanNodeType` tallies — without
 * executing it. The counter available to a benchmark that only ever prepares a
 * statement, and the one that would catch a rule regression turning a hash join back
 * into a nested loop.
 *
 * @param {import('../../dist/src/index.js').Database} db
 * @param {string} sql
 * @returns {Promise<object>} a `PlanShape`
 */
export async function snapshotPlanShape(db, sql) {
	const stmt = db.prepare(sql);
	try {
		return stmt.getPlanShape();
	} finally {
		await stmt.finalize();
	}
}
