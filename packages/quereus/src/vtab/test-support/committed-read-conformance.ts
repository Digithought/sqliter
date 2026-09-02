import type { Database } from '../../core/database.js';
import type { SqlValue } from '../../common/types.js';
import { PlanNode } from '../../planner/nodes/plan-node.js';
import { TableReferenceNode } from '../../planner/nodes/reference.js';
import { getModuleReadCommittedSnapshot } from '../concurrency.js';
import { settleMacrotasks, type CommitStallHandle } from './commit-stall.js';

/**
 * Conformance check for the committed-snapshot obligation a virtual-table module
 * takes on by declaring `VirtualTableModule.readCommittedSnapshot`. See
 * `docs/module-authoring.md` § "Committed-Snapshot Reads (`_readCommitted`)" for
 * the obligation itself.
 *
 * Framework-agnostic on purpose: it throws a descriptive `Error` on failure and
 * returns a result object on success, so it drops into Mocha, Vitest, or a plain
 * script without pulling an assertion library in. It ships in the published
 * package because an out-of-tree module author needs it at runtime; nothing in
 * the engine imports it.
 */

export interface CommittedReadConformanceOptions {
	/** Database with the module under test registered and the table created. */
	db: Database;
	/**
	 * Table name to exercise, qualified or not. Used verbatim in SQL, so pass it
	 * exactly as you would write it in a query (already quoted if it needs to be).
	 * The table must be EMPTY on entry — the harness owns its contents for the run
	 * and deletes what it wrote on the way out.
	 */
	table: string;
	/**
	 * Primary-key column — seeded with integers and used to drive an index-driven
	 * access path. Used verbatim in SQL, like {@link table}.
	 */
	keyColumn: string;
	/**
	 * A non-key column the writer mutates; must accept text and be readable in a
	 * `select`. Used verbatim in SQL, like {@link table}. Any OTHER column on the
	 * table must be nullable or defaulted — the harness writes only these two.
	 */
	valueColumn: string;
	/**
	 * Optional: park the module mid-commit so the read provably overlaps the
	 * publish window. Called immediately BEFORE the harness issues its writer —
	 * arm your gate here. The returned handle is released once the concurrent
	 * reads have completed (including on failure). Without it the check is
	 * best-effort — a module that commits in one synchronous step may leave no
	 * window to observe — and the result reports `observedCommitOverlap: false`.
	 */
	stallCommit?: () => CommitStallHandle;
	/** Rows to seed. Default 200 — enough that a torn publish is observable. */
	rowCount?: number;
	/**
	 * How long to wait for a concurrent read to complete while the writer is
	 * parked, before declaring that the engine did not route it concurrently.
	 * Only applies when `stallCommit` is supplied. Default 5000ms.
	 */
	stallTimeoutMs?: number;
}

export interface CommittedReadConformanceResult {
	/**
	 * True only when a `stallCommit` was supplied AND the writer was still parked
	 * for the whole duration of the concurrent reads. False means "no evidence the
	 * read overlapped a commit" — NOT "conformant": with no provable overlap the
	 * harness cannot insist on the pre-write snapshot (the writer may legitimately
	 * have landed first), so it only checks that each read returned one WHOLE
	 * state rather than a mix, and it does not compare the two legs against each
	 * other.
	 */
	observedCommitOverlap: boolean;
	/** Rows returned by the full scan. */
	fullScanRows: number;
	/** Rows returned by the index-driven path; 0 when that leg was skipped. */
	indexDrivenRows: number;
	/**
	 * Present when the index-driven leg did NOT run, with the reason. The leg is
	 * skipped rather than silently degraded into a second full scan, so a module
	 * with no seek plan cannot claim index coverage it never had.
	 */
	indexDrivenSkippedReason?: string;
}

/** One row of the harness's projection, already normalized. */
interface SnapshotRow {
	key: string;
	value: SqlValue;
}

const KEY_ALIAS = '__crc_key';
const VALUE_ALIAS = '__crc_value';

/** Stable, type-independent identity for a key cell (integers may arrive as bigint). */
function keyToString(value: SqlValue): string {
	return typeof value === 'bigint' ? value.toString() : String(value);
}

function seedValue(key: number): string {
	return `crc-seed-${key}`;
}

function postValue(key: number): string {
	return `crc-post-${key}`;
}

/**
 * Every module reachable from `select * from <table>`. Uses the planner's own
 * name resolution rather than re-parsing the caller's table name.
 */
function resolveTableModules(db: Database, table: string): TableReferenceNode[] {
	let root: PlanNode;
	try {
		root = db.getPlan(`select * from ${table}`);
	} catch (e) {
		throw new Error(
			`committed-read conformance: could not plan 'select * from ${table}' — pass the table name exactly as it would appear in a query. Cause: ${String(e)}`,
		);
	}
	const found: TableReferenceNode[] = [];
	const stack: PlanNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node instanceof TableReferenceNode) found.push(node);
		for (const child of node.getChildren()) stack.push(child);
	}
	return found;
}

/**
 * Step 1: refuse up front unless the table's module declares the flag. The
 * harness exists to test modules that CLAIM the guarantee; running it against one
 * that declines would fail on the engine's own (correct) fallback to the
 * serialized path, which is a confusing way to report "you never opted in".
 */
function assertModuleDeclaresSnapshot(db: Database, table: string): void {
	const refs = resolveTableModules(db, table);
	if (refs.length === 0) {
		throw new Error(
			`committed-read conformance: '${table}' resolved to no base table (a view over a table-valued function, perhaps). The harness needs a real table.`,
		);
	}
	for (const ref of refs) {
		if (!getModuleReadCommittedSnapshot(ref.vtabModule)) {
			throw new Error(
				`committed-read conformance: module '${ref.tableSchema.vtabModuleName}' backing '${table}' does not declare readCommittedSnapshot, so the engine will always serialize reads of it. ` +
				`This harness only applies to modules that declare the flag — see docs/module-authoring.md § "Committed-Snapshot Reads (_readCommitted)".`,
			);
		}
	}
}

async function collectSnapshot(
	db: Database,
	sql: string,
	options?: { readCommitted?: boolean },
): Promise<SnapshotRow[]> {
	const rows: SnapshotRow[] = [];
	const iter = options?.readCommitted
		? db.eval(sql, undefined, { readConcurrency: 'committed' })
		: db.eval(sql);
	for await (const row of iter) {
		rows.push({ key: keyToString(row[KEY_ALIAS]), value: row[VALUE_ALIAS] });
	}
	rows.sort((a, b) => Number(a.key) - Number(b.key));
	return rows;
}

/** Plan operators for `sql`, via the public `query_plan()` table-valued function. */
async function planOperators(db: Database, sql: string): Promise<string[]> {
	const ops: string[] = [];
	for await (const row of db.eval('select op from query_plan(?)', [sql])) {
		ops.push(String(row.op));
	}
	return ops;
}

/** Render up to `limit` divergences as `key: expected -> actual`. */
function describeDivergences(
	expected: readonly SnapshotRow[],
	actual: readonly SnapshotRow[],
	limit = 5,
): string {
	const byKey = new Map(actual.map(r => [r.key, r.value]));
	const parts: string[] = [];
	for (const row of expected) {
		if (!byKey.has(row.key)) {
			parts.push(`${row.key}: expected ${JSON.stringify(row.value)}, row missing`);
		} else if (byKey.get(row.key) !== row.value) {
			parts.push(`${row.key}: expected ${JSON.stringify(row.value)}, got ${JSON.stringify(byKey.get(row.key))}`);
		}
		if (parts.length >= limit) break;
	}
	if (parts.length < limit) {
		const expectedKeys = new Set(expected.map(r => r.key));
		for (const row of actual) {
			if (!expectedKeys.has(row.key)) {
				parts.push(`${row.key}: unexpected row ${JSON.stringify(row.value)}`);
				if (parts.length >= limit) break;
			}
		}
	}
	return parts.length > 0 ? parts.join('; ') : '(no per-row divergence — the row sets match)';
}

/**
 * Reject after `ms` with a message that names the likely cause.
 *
 * NOTE: the timed-out read is abandoned, not cancelled — it drains on its own once
 * the stall is released (which the run always does), and its rejection is already
 * handled here. If the harness ever gains a mode that keeps running on the same
 * database after a timeout, give it a real cancellation instead.
 */
function withStallTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(
				`committed-read conformance: ${what} did not complete within ${ms}ms while the writer was parked mid-commit. ` +
				`The read was queued behind the writer instead of running concurrently — check that the statement is eligible ` +
				`(read-only, autocommit, no open explicit transaction) and that the module really declares readCommittedSnapshot.`,
			));
		}, ms);
		work.then(
			value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); },
		);
	});
}

/**
 * Runs the committed-snapshot conformance check against `options.table`.
 *
 * Shape of the run:
 *  1. refuse unless the table's module declares `readCommittedSnapshot`;
 *  2. seed `rowCount` rows and commit;
 *  3. start an unawaited writer that rewrites EVERY seeded row's value and
 *     appends new rows, parked mid-commit via `stallCommit` if supplied;
 *  4. while it is parked, read the table twice with `readConcurrency: 'committed'`
 *     — a full scan and an index-driven path over `keyColumn`;
 *  5. assert both reads return exactly the seeded snapshot and agree row-for-row.
 *     Without a provable park the bar drops to "each read equals ONE whole state,
 *     pre- or post-write" — a mix is still a failure, but a writer that landed
 *     before the read is not;
 *  6. release, await the writer, and assert that a fresh read now sees the
 *     post-write state — checked on BOTH an ordinary read and a
 *     `readConcurrency: 'committed'` read, so neither a module that serves
 *     permanently stale data nor one that pins only its `_readCommitted`
 *     connections across statements can pass.
 *
 * @throws Error with the specific divergence on any failure.
 */
export async function runCommittedReadConformance(
	options: CommittedReadConformanceOptions,
): Promise<CommittedReadConformanceResult> {
	const { db, table, keyColumn, valueColumn, rowCount = 200 } = options;

	if (!Number.isInteger(rowCount) || rowCount < 2) {
		throw new Error(`committed-read conformance: rowCount must be an integer >= 2, got ${rowCount}`);
	}

	assertModuleDeclaresSnapshot(db, table);

	const plan = buildRunPlan(table, keyColumn, valueColumn, rowCount);
	await assertTableEmpty(db, table, plan.projection);

	// From here on the table holds the harness's rows, so every exit path — thrown
	// assertion, thrown engine error, or success — has to clear them.
	await db.exec(plan.seedSql);
	try {
		const result = await runAgainstSeededTable(options, plan);
		await cleanup(db, table, undefined);
		return result;
	} catch (e) {
		await cleanup(db, table, e);
		throw e;
	}
}

/** Everything the run needs derived from the caller's options: SQL, and the two whole states. */
interface RunPlan {
	readonly projection: string;
	readonly indexDrivenSql: string;
	readonly seedSql: string;
	readonly writerSql: string;
	readonly keyColumn: string;
	readonly highKey: number;
	readonly rowCount: number;
	readonly expectedPre: readonly SnapshotRow[];
	readonly expectedPost: readonly SnapshotRow[];
}

function buildRunPlan(table: string, keyColumn: string, valueColumn: string, rowCount: number): RunPlan {
	// Seeded band is 1..rowCount; the writer appends rowCount+1..highKey.
	const appendCount = Math.max(1, Math.floor(rowCount / 10));
	const highKey = rowCount + appendCount;
	const keys = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
	const tuples = (count: number, value: (k: number) => string) =>
		keys(count).map(k => `(${k}, '${value(k)}')`).join(', ');

	// Both legs project identically; only the predicate differs. The range covers
	// the appended keys too, so an index-driven read of a torn publish is short or
	// long in exactly the way the full scan is.
	const projection = `select ${keyColumn} as ${KEY_ALIAS}, ${valueColumn} as ${VALUE_ALIAS} from ${table}`;

	return {
		projection,
		indexDrivenSql: `${projection} where ${keyColumn} >= 1 and ${keyColumn} <= ${highKey}`,
		seedSql: `insert into ${table} (${keyColumn}, ${valueColumn}) values ${tuples(rowCount, seedValue)}`,
		// A single statement, so it commits once: `or replace` rewrites every seeded
		// row's value AND appends new keys. A torn publish therefore shows up two
		// ways — as a mix of old and new values, and as a longer result set.
		writerSql: `insert or replace into ${table} (${keyColumn}, ${valueColumn}) values ${tuples(highKey, postValue)}`,
		keyColumn,
		highKey,
		rowCount,
		expectedPre: keys(rowCount).map(k => ({ key: String(k), value: seedValue(k) })),
		expectedPost: keys(highKey).map(k => ({ key: String(k), value: postValue(k) })),
	};
}

/** The harness owns the table's contents for the run, so it refuses to share it. */
async function assertTableEmpty(db: Database, table: string, projection: string): Promise<void> {
	const existing = await collectSnapshot(db, projection);
	if (existing.length > 0) {
		throw new Error(
			`committed-read conformance: '${table}' must be empty on entry (found ${existing.length} rows). ` +
			`The harness owns the table's contents for the run and deletes what it wrote on the way out.`,
		);
	}
}

/** Steps 3–6, with the seeded rows already committed. Always throws or returns; never cleans up. */
async function runAgainstSeededTable(
	options: CommittedReadConformanceOptions,
	plan: RunPlan,
): Promise<CommittedReadConformanceResult> {
	const { db, valueColumn, stallCommit, stallTimeoutMs = 5000 } = options;

	const { seekPlanned, indexDrivenSkippedReason } = await probeIndexPath(db, plan);

	const handle = stallCommit?.();
	try {
		const writer = startWriter(db, plan.writerSql);

		let outcome: ReadOutcome | undefined;
		let readError: unknown;
		try {
			outcome = await observeConcurrentReads({
				db, plan, valueColumn, handle, writer, seekPlanned, stallTimeoutMs,
			});
		} catch (e) {
			readError = e;
		}

		handle?.release();
		try {
			await writer.promise;
		} catch (e) {
			if (readError === undefined) readError = e;
		}
		if (readError !== undefined) throw readError;
		if (!outcome) throw new Error('committed-read conformance: internal error — the reads produced no outcome');

		await assertAdvancesAfterCommit(db, plan);

		return {
			observedCommitOverlap: outcome.parked,
			fullScanRows: outcome.fullScan.length,
			indexDrivenRows: outcome.indexDriven.length,
			...(indexDrivenSkippedReason !== undefined ? { indexDrivenSkippedReason } : {}),
		};
	} finally {
		// Idempotent by contract. Covers the paths that throw before the explicit
		// release above — an armed gate left behind would park the cleanup delete
		// and hang the caller instead of reporting the real failure.
		handle?.release();
	}
}

/**
 * Does the planner really seek for the index-driven leg? Probed BEFORE anything
 * parks — `query_plan()` is an ordinary statement and would queue behind the
 * stalled writer.
 */
async function probeIndexPath(
	db: Database,
	plan: RunPlan,
): Promise<{ seekPlanned: boolean; indexDrivenSkippedReason?: string }> {
	const ops = await planOperators(db, plan.indexDrivenSql);
	if (ops.includes('INDEXSEEK')) return { seekPlanned: true };
	return {
		seekPlanned: false,
		indexDrivenSkippedReason:
			`the planner did not choose a seek for a range predicate on '${plan.keyColumn}' (plan operators: ${ops.join(', ')}); ` +
			`the index-driven leg was skipped rather than run as a second full scan`,
	};
}

/** An unawaited writer whose settlement can be sampled synchronously. */
interface TrackedWriter {
	readonly promise: Promise<void>;
	settled(): boolean;
}

function startWriter(db: Database, sql: string): TrackedWriter {
	let settled = false;
	const promise = db.exec(sql).then(
		() => { settled = true; },
		error => { settled = true; throw error; },
	);
	// Keep an unhandled rejection from escaping before the awaited join below.
	promise.catch(() => { /* re-thrown where the run joins the writer */ });
	return { promise, settled: () => settled };
}

interface ReadOutcome {
	readonly fullScan: readonly SnapshotRow[];
	readonly indexDriven: readonly SnapshotRow[];
	/** True only if the writer stayed parked for the whole of both reads. */
	readonly parked: boolean;
}

interface ObserveArgs {
	db: Database;
	plan: RunPlan;
	valueColumn: string;
	handle: CommitStallHandle | undefined;
	writer: TrackedWriter;
	seekPlanned: boolean;
	stallTimeoutMs: number;
}

/** Steps 4–5: read twice while the writer is parked, and judge what came back. */
async function observeConcurrentReads(args: ObserveArgs): Promise<ReadOutcome> {
	const { db, plan, valueColumn, handle, writer, seekPlanned, stallTimeoutMs } = args;

	if (handle) {
		if (handle.entered) {
			// Deterministic: proceed once a commit is provably inside the gate. If the
			// writer finished first there was no window at all.
			await Promise.race([handle.entered, writer.promise]);
		} else {
			await settleMacrotasks();
		}
	}
	let parked = handle !== undefined && !writer.settled();

	const guard = <T>(work: Promise<T>, what: string): Promise<T> =>
		parked ? withStallTimeout(work, stallTimeoutMs, what) : work;

	const fullScan = await guard(collectSnapshot(db, plan.projection, { readCommitted: true }), 'the full-scan read');
	const indexDriven = seekPlanned
		? await guard(collectSnapshot(db, plan.indexDrivenSql, { readCommitted: true }), 'the index-driven read')
		: [];
	if (parked && writer.settled()) {
		// The writer landed while we were reading, so neither read is evidence of
		// anything: the "committed snapshot" they saw may simply be the new state.
		parked = false;
	}

	// Parked: the commit provably had NOT landed, so the pre-write snapshot is the
	// only correct answer. Not parked: the writer may have committed before either
	// read began, and serving the post-write state is then equally correct — so
	// accept either whole state, but never a mix of the two (that is a tear no
	// interleaving excuses).
	const acceptable = parked ? [plan.expectedPre] : [plan.expectedPre, plan.expectedPost];
	assertCoherent('full scan', fullScan, acceptable, valueColumn, parked);
	if (seekPlanned) {
		assertCoherent('index-driven read', indexDriven, acceptable, valueColumn, parked);
		// Only meaningful while the writer is parked: unparked, the two legs run at
		// different times and may legitimately straddle the commit.
		if (parked) assertLegsAgree(fullScan, indexDriven);
	}
	return { fullScan, indexDriven, parked };
}

/** Row-for-row equality, in key order. */
function matches(actual: readonly SnapshotRow[], expected: readonly SnapshotRow[]): boolean {
	return actual.length === expected.length
		&& expected.every((row, i) => actual[i].key === row.key && actual[i].value === row.value);
}

/**
 * `actual` must equal ONE of the `acceptable` whole states. Anything else — a
 * short result set, or a mix of pre- and post-write values — is a torn read.
 */
function assertCoherent(
	leg: string,
	actual: readonly SnapshotRow[],
	acceptable: readonly (readonly SnapshotRow[])[],
	valueColumn: string,
	parked: boolean,
): void {
	if (acceptable.some(expected => matches(actual, expected))) return;
	const [primary] = acceptable;
	const alternative = acceptable.length > 1
		? ` (the post-write state would also have been accepted — the writer was not provably parked — but this is neither.)`
		: '';
	throw new Error(
		`committed-read conformance: the ${leg}${parked ? " taken during another connection's commit" : ''} did not return a coherent committed snapshot. ` +
		`Expected ${primary.length} rows, each with '${valueColumn}' at its pre-write value; got ${actual.length} rows.${alternative} ` +
		`Divergences — ${describeDivergences(primary, actual)}. ` +
		`A module declaring readCommittedSnapshot must pin the state it serves for the life of the scan.`,
	);
}

function assertLegsAgree(fullScan: readonly SnapshotRow[], indexDriven: readonly SnapshotRow[]): void {
	if (matches(indexDriven, fullScan)) return;
	throw new Error(
		`committed-read conformance: the full scan and the index-driven read disagree (${fullScan.length} vs ${indexDriven.length} rows). ` +
		`Divergences — ${describeDivergences(fullScan, indexDriven)}. ` +
		`The obligation requires an index-driven plan and a full scan of one connection to agree, so base rows and index entries ` +
		`must become visible together.`,
	);
}

/**
 * Step 6: a module that pins a snapshot but never advances it would pass every
 * check above. After the writer lands, a fresh read must see the new state — on
 * the ordinary path AND on the committed path, since a module can pin only its
 * `_readCommitted` connections and refresh on every other one.
 *
 * The ordinary checks run first on purpose: they catch the coarser "everything is
 * stale" module and say so in plainer terms than a cross-path comparison could.
 */
async function assertAdvancesAfterCommit(db: Database, plan: RunPlan): Promise<void> {
	const after = await collectSnapshot(db, plan.projection);
	if (after.length !== plan.highKey) {
		throw new Error(
			`committed-read conformance: after the writer committed, a fresh read returned ${after.length} rows, expected ${plan.highKey}. ` +
			`The module is serving a stale snapshot to ordinary reads.`,
		);
	}
	const stale = after.filter(row => row.value !== postValue(Number(row.key)));
	if (stale.length > 0) {
		throw new Error(
			`committed-read conformance: after the writer committed, ${stale.length} of ${after.length} rows still held their pre-write value ` +
			`(first: key ${stale[0].key} = ${JSON.stringify(stale[0].value)}). A pinned snapshot must advance once the commit lands ` +
			`— seeding was ${plan.rowCount} rows.`,
		);
	}

	// The checks above only ever asked the ORDINARY path. A module whose
	// `_readCommitted` connections pin one state and never re-pin — while every
	// other path refreshes normally — passes all of them, and that is exactly the
	// shape a module fetching state from elsewhere has when its committed handle
	// is a cached pre-transaction object it never re-fetches.
	//
	// NOTE: `readConcurrency: 'committed'` falls back to the serialized path
	// silently when a statement is ineligible, and the engine exposes no signal
	// for which path a read actually took. This check is meaningful only because a
	// read-only autocommit query over a declaring module is eligible today; if the
	// eligibility rules ever narrow, this comparison degrades into an ordinary read
	// against an ordinary read and passes vacuously. The mid-commit legs (steps
	// 4–5) would catch that regression via their stall timeout — they are the
	// canary — but if eligibility is ever reworked, re-verify this step against
	// `StaleCommittedSnapshotModule` in test/vtab/_conformance-stub-modules.ts.
	const afterCommitted = await collectSnapshot(db, plan.projection, { readCommitted: true });
	if (!matches(afterCommitted, after)) {
		throw new Error(
			`committed-read conformance: after the writer committed, a read with readConcurrency: 'committed' returned ${afterCommitted.length} rows ` +
			`that disagree with an ordinary read of the same committed state (${after.length} rows). ` +
			`Divergences — ${describeDivergences(after, afterCommitted)}. ` +
			`The module's _readCommitted connection appears to pin its state ACROSS statements. Pinning is required only for the life of a ` +
			`single scan: every new committed read must re-pin to the state committed as of the moment that read begins, so a committed read ` +
			`may never be staler than an ordinary read taken at the same instant.`,
		);
	}
}

/**
 * The harness entered on an empty table, so removing everything removes exactly
 * what it wrote. A cleanup failure never masks the real error.
 */
async function cleanup(db: Database, table: string, pendingError: unknown): Promise<void> {
	try {
		await db.exec(`delete from ${table}`);
	} catch (e) {
		if (pendingError === undefined) {
			throw new Error(`committed-read conformance: passed, but cleaning up '${table}' failed: ${String(e)}`);
		}
		// A cleanup failure after a real failure is a symptom, not the cause, so it
		// must not displace the thrown error. `console.error` rather than the
		// package's debug-namespaced logger: this runs under a test runner, where
		// the note has to be visible without anyone enabling a debug namespace.
		console.error(`committed-read conformance: cleanup of '${table}' also failed:`, e);
	}
}
