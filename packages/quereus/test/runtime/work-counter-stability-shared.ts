import { Database } from '../../src/index.js';
import type { WorkCounterSnapshot } from '../../src/index.js';

/**
 * Shared logic for the work-counter stability acceptance test
 * (work-counter-stability.spec.ts) and its child-process runner
 * (work-counter-stability-child.ts). Deliberately NOT a `.spec.ts` file — the
 * mocha glob only collects files ending in `.spec.ts`, so this module is never
 * collected as a suite of its own.
 */

export interface StabilityCase {
	name: string;
	sql: string;
}

/**
 * Representative statements whose work counters must be identical on every
 * machine, every run, and every process. The mutation case is a fixed point
 * (`b = b + 0`) so re-executing it — including a second execution of the same
 * prepared statement — leaves the table unchanged and counts identically.
 */
export const STABILITY_CASES: StabilityCase[] = [
	{ name: 'full-scan', sql: 'select a, b from t' },
	{ name: 'filtered-scan', sql: 'select b from t where a = 2' },
	{ name: 'group-by', sql: 'select b, count(*) as n from t group by b' },
	// `limit 1` keeps this a genuine per-row sub-program: the aggregate form
	// below is decorrelated into a HashJoin by the optimizer, which would leave
	// nothing for the N+1-visibility assertion.
	{ name: 'correlated-subquery', sql: 'select a, (select t2.b from t as t2 where t2.a = t.a limit 1) as x from t' },
	// Decorrelated by the optimizer (HashJoin + HashAggregate) — kept as a
	// stability case in its own right; the sub-program assertions use the case above.
	{ name: 'decorrelated-subquery', sql: 'select a, (select count(*) from t as t2 where t2.b = t.b) as n from t' },
	{ name: 'mutation', sql: 'update t set b = b + 0 where a <= 3' },
];

/** Rows inserted by {@link setupDatabase}; the N of the N+1-visibility assertion. */
export const TABLE_ROW_COUNT = 5;

/** Fresh database with the stability fixture table and metrics collection on. */
export async function setupDatabase(): Promise<Database> {
	const db = new Database();
	await db.exec('create table t (a integer primary key, b integer)');
	await db.exec('insert into t values (1, 10), (2, 10), (3, 20), (4, 20), (5, 30)');
	db.setOption('runtime_metrics', true);
	return db;
}

/** Prepare `sql`, drain it fully, and return the execution's snapshot. */
export async function snapshotStatement(db: Database, sql: string): Promise<WorkCounterSnapshot> {
	const stmt = db.prepare(sql);
	try {
		for await (const _ of stmt.all()) { /* drain fully — counts are only complete once drained */ }
		const snapshot = stmt.getWorkCounters();
		if (!snapshot) {
			throw new Error(`no work-counter snapshot after draining: ${sql}`);
		}
		return snapshot;
	} finally {
		await stmt.finalize();
	}
}

/**
 * Build a fresh database and snapshot every stability case, running
 * `warmupStatements` throwaway statements first. Each warmup statement compiles
 * a plan and burns process-global `PlanNode.nextId` values, so two runs with
 * different warmup counts execute the real statements at different id offsets —
 * any plan-node id leaking into a counter key diverges immediately between them.
 */
export async function collectSnapshots(warmupStatements: number): Promise<Record<string, WorkCounterSnapshot>> {
	const db = await setupDatabase();
	try {
		for (let i = 0; i < warmupStatements; i++) {
			await db.exec(`select ${i + 1}`);
		}
		const out: Record<string, WorkCounterSnapshot> = {};
		for (const stabilityCase of STABILITY_CASES) {
			out[stabilityCase.name] = await snapshotStatement(db, stabilityCase.sql);
		}
		return out;
	} finally {
		await db.close();
	}
}
